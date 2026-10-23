/**
 * PeerJS Transport Provider
 *
 * Peer-to-peer transport using WebRTC data channels with PeerJS library.
 * PeerJS provides a simpler API and built-in signaling infrastructure.
 *
 * Features:
 * - Direct peer-to-peer connections
 * - Built-in signaling servers (PeerJS Cloud)
 * - Automatic peer ID management
 * - Simple connection API
 * - Optional encryption
 * - Automatic reconnection
 *
 * Discovery, FULL MESH (the default): the first peer of a room claims the
 * well-known id `yjs-coordinator-<room>` and introduces everybody else
 * (join -> peer-list / peer-joined / peer-left); data flows over the full
 * mesh. When the coordinator goes away the remaining peers elect the
 * lowest id, which claims the coordinator id with a second Peer and
 * switches identity only once the claim succeeded. Known limit: the PeerJS
 * server keeps the registration of a coordinator that went silent (a phone
 * asleep) for up to its alive_timeout (60 s) - the existing mesh keeps
 * working meanwhile, new joiners wait until the id is free. What phones do
 * to this transport, and the repro behind each guard below:
 * docs/superpowers/specs/2026-09-19-webrtc-mobile-resilience-research.md,
 * test/providers/repro-peerjs-coordinator.ts.
 *
 * Discovery, SAMPLED (the `dial` option, or configureSparse from
 * ConferenceTransport - which is the only thing this mode is for, since
 * GenericProvider alone needs a full mesh): the coordinator answers a join
 * with a random SAMPLE of its roster rather than the roster, and the
 * roster is leases renewed by each peer's next join. Nobody keeps a link
 * to it: a peer opens a signaling session, takes its sample and closes it
 * again, coming back to renew - at once when it has no links, in a couple
 * of seconds while it is short of them, once a minute when it is settled.
 * The name is held in a SECOND Peer object, so claiming it costs a Peer
 * instead of every link the claimant has, which is what makes "claim first
 * and let the server decide" affordable in place of an election over a
 * complete peer list nobody has any more. The policy that both this and
 * test/dummy/bench-partial-mesh.ts run is ../rendezvous.ts; the gate is
 * test/providers/repro-peerjs-sparse.ts.
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { PeerJSTransport } from 'y-generic/providers/peerjs'
 * import Peer from 'peerjs'
 *
 * const doc = new Y.Doc()
 * const transport = new PeerJSTransport({
 *   peer: Peer, // Pass the PeerJS constructor
 *   password: 'optional-encryption-key'
 * })
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 * ```
 */
import { watchResume, watchPageBack, watchNetworkChange } from '../resume';
import { SparseDial } from '../dial';
import { sampleRoster, successorsOf, nextHeartbeatMs, claimDelayMs } from '../rendezvous';
/**
 * PeerJS transport implementation.
 * Creates direct peer-to-peer connections using PeerJS library.
 */
export class PeerJSTransport {
    /**
     * Create a new PeerJS transport.
     *
     * @param options - Configuration options (must include peer constructor)
     */
    constructor(options) {
        this._connected = false;
        this._room = '';
        this.peer = null; // PeerJS Peer instance
        this.peerId = '';
        this.peers = new Map();
        this.knownPeers = new Set();
        // Cross-browser coordination
        this.isCoordinator = false;
        this.coordinatorPeerId = '';
        this.roomPeers = new Set(); // All peers in room (coordinator tracks this)
        this.reElectionInProgress = false; // Prevent duplicate re-elections
        this._destroying = false; // Set during disconnect() to suppress reconnects
        // Bumped by disconnect(): every timer and promise continuation of a
        // session checks it (see later()), so an election retry or a re-dial
        // cannot outlive the session it belongs to.
        this._epoch = 0;
        // A re-join after a resume (handleResume) that goes on trying until it
        // holds; disconnect() - the app's - ends it. Not _epoch: the re-join
        // disconnects itself before every try.
        this._rejoinGen = 0;
        this._reconnectAttempts = 0; // signaling reconnect backoff
        this._passive = false;
        this._roomSize = 0; // what ConferenceTransport has counted, via setRoomSize
        this._sawRoomSize = false; // ... ever: a partial mesh without the wrapper is a bug
        // Ids we were handed and have not dialed: replacing a link that died usually costs no
        // round trip to the coordinator at all.
        this._reserve = [];
        this._redials = new Map(); // a link that dropped is retried ONCE, then replaced
        this._successors = []; // from the last sample: who claims the name if the coordinator goes
        this._renewMs = 0; // what the coordinator asked for
        // Coordinator side of a sampled room: a roster of LEASES, renewed by a peer's next join
        // and by nothing else. A closed session expires nothing - that is the whole difference
        // from the full mesh, where the roster is the set of open links.
        this._roster = new Map();
        this._sessions = new Set(); // signaling sessions open right now
        this._sessionState = 'idle';
        this._sessionFails = 0;
        if (!options.peer) {
            throw new Error('PeerJSTransport requires the "peer" option. ' +
                'Please provide the PeerJS constructor: ' +
                'import Peer from "peerjs"; new PeerJSTransport({ peer: Peer, ... })');
        }
        this.options = {
            peer: options.peer,
            peerOptions: options.peerOptions ?? {},
            password: options.password ?? '',
            maxConns: options.maxConns ?? 64,
            connectTimeout: options.connectTimeout ?? 30000,
            iceDisconnectTimeout: options.iceDisconnectTimeout ?? 15000,
            resumeAfterMs: options.resumeAfterMs ?? 30000,
            debug: options.debug ?? false,
            dial: options.dial, // only read through _sparse, which is undefined without it
            passive: options.passive ?? false,
            coordinatorRenewMs: options.coordinatorRenewMs ?? 60000,
            coordinatorSessionsPerSec: options.coordinatorSessionsPerSec ?? 2,
            sampleOversample: options.sampleOversample ?? 2,
            sessionLingerMs: options.sessionLingerMs ?? 2000,
        };
        this._passive = options.passive ?? false;
        if (options.dial !== undefined)
            this.configureSparse({ dial: options.dial });
    }
    /**
     * Close a connection that stays in ICE 'disconnected' - see the
     * iceDisconnectTimeout option. Its 'close' handlers do the rest (drop
     * the entry, re-dial, or start the election for a coordinator link).
     */
    closeWhenIceStaysDisconnected(conn, remotePeerId) {
        let timer;
        conn.on('iceStateChanged', (state) => {
            if (state === 'disconnected' && timer === undefined) {
                timer = setTimeout(() => {
                    this.log('🧊 ICE stayed disconnected, closing the link:', remotePeerId);
                    conn.close();
                }, this.options.iceDisconnectTimeout);
            }
            else if (state !== 'disconnected' && timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        });
        conn.on('close', () => clearTimeout(timer));
    }
    /** setTimeout that dies with disconnect() - see _epoch. */
    later(fn, ms) {
        const epoch = this._epoch;
        setTimeout(() => {
            if (epoch === this._epoch)
                fn();
        }, ms);
    }
    /**
     * Connect to the room and start discovering peers.
     */
    async connect(config) {
        if (this._connected) {
            throw new Error('Already connected');
        }
        this._room = config.room;
        const epoch = this._epoch;
        // Deterministic coordinator ID for this room
        this.coordinatorPeerId = `yjs-coordinator-${this._room}`;
        if (this.options.resumeAfterMs > 0 && !this._stopResumeWatch) {
            this._stopResumeWatch = watchResume(this.options.resumeAfterMs, (sleptMs) => this.handleResume(sleptMs));
        }
        // Somebody looks at the page again, or the network is back: not the
        // moment to sit out a backoff (see reconnectNow). Browser only.
        if (!this._stopPageWatch)
            this._stopPageWatch = watchPageBack(() => this.reconnectNow());
        // The page's network CHANGED: every link of ours runs over an address that
        // is gone, and ICE says so only after 15 s (Chrome) to 30 s (Firefox) - the
        // same repair as after a sleep (repro-peerjs-coordinator part 15,
        // docs/.../2026-09-20-partial-mesh-relay-research.md "A phone that changes
        // its network").
        if (!this._stopNetworkChangeWatch) {
            this._stopNetworkChangeWatch = watchNetworkChange((why) => {
                if (!this._connected || this._destroying)
                    return;
                this.log(`⏰ ${why} — leaving and re-joining the room`);
                this.rejoin(this._room, 0);
            });
        }
        // Strategy: Try to claim the coordinator ID first
        // If taken, we'll get an error and become a regular peer
        return new Promise((resolve, reject) => {
            // ... except under a sample, where the room's name is NOT our identity: we always
            // run our own Peer, and whoever ends up holding the name holds it in a second one
            // (claimSidecar). A claim then costs a Peer object instead of every link we have.
            if (this._sparse) {
                this.createRegularPeer(resolve, reject);
                return;
            }
            try {
                const coordinatorAttempt = new this.options.peer(this.coordinatorPeerId, {
                    debug: this.options.debug ? 3 : 0,
                    ...this.options.peerOptions,
                });
                // The three handlers below decide the CLAIM, once. PeerJS keeps
                // emitting non-fatal 'error's on a Peer for its whole life
                // ('peer-unavailable', 'network'); a claim handler that was still
                // listening answered them by destroying the coordinator
                // (test/providers/repro-peerjs-coordinator.ts, parts 1-3). After
                // the claim, wirePeer()'s handlers take over.
                let settled = false;
                const giveUp = () => {
                    settled = true;
                    clearTimeout(coordinatorTimeout);
                    coordinatorAttempt.destroy();
                    if (epoch !== this._epoch)
                        return; // disconnect() meanwhile
                    this.createRegularPeer(resolve, reject);
                };
                // Timeout in case PeerJS doesn't respond
                const coordinatorTimeout = setTimeout(() => {
                    if (!settled)
                        giveUp();
                }, 3000);
                coordinatorAttempt.on('open', (id) => {
                    if (settled)
                        return;
                    if (id !== this.coordinatorPeerId || epoch !== this._epoch) {
                        giveUp();
                        return;
                    }
                    settled = true;
                    clearTimeout(coordinatorTimeout);
                    this.log('Coordinator: claimed ID');
                    this.peer = coordinatorAttempt;
                    this.peerId = id;
                    this.isCoordinator = true;
                    this.roomPeers.add(this.peerId);
                    this._connected = true;
                    this.startSparseRoster();
                    this.setupPeerDiscovery();
                    this.wirePeer(coordinatorAttempt);
                    resolve();
                });
                coordinatorAttempt.on('error', (error) => {
                    if (settled)
                        return;
                    // ID taken: a coordinator exists. Anything else: no coordinator
                    // role for us either - join as a regular peer.
                    if (error?.type !== 'unavailable-id') {
                        this.log('❌ Unexpected error claiming coordinator:', error);
                    }
                    giveUp();
                });
            }
            catch (error) {
                reject(error);
            }
        });
    }
    /**
     * Permanent handlers of the Peer we run on, attached once it is open and
     * adopted as `this.peer` - the one place, for all four ways a Peer comes
     * to be (claimed at connect, regular at connect, won election, rebuilt).
     */
    wirePeer(peer) {
        peer.on('connection', (conn) => {
            if (peer === this.peer)
                this.handleIncomingConnection(conn);
        });
        peer.on('disconnected', () => {
            if (peer !== this.peer)
                return;
            this.log('Peer disconnected from PeerJS server, attempting reconnect...');
            this._handlePeerServerDisconnect();
        });
        // Every successful (re-)registration with the server.
        peer.on('open', () => {
            if (peer === this.peer)
                this.onSignalingReopened();
        });
        peer.on('error', (error) => {
            if (peer !== this.peer)
                return;
            this.log('Peer error:', error?.type, error?.message ?? error);
            if (error?.type === 'peer-unavailable') {
                // A dial to a peer the server no longer knows. Reported here, not
                // on the connection: forget the peer (stops the re-dial) and drop
                // the entry that would otherwise block its id.
                const gone = /peer (\S+)$/.exec(String(error.message ?? ''))?.[1];
                if (gone === this.coordinatorPeerId && this._sparse) {
                    // Under a sample the coordinator is not a link of ours: nobody at the room's
                    // name is a session that failed, and two of those mean it is time to claim it.
                    this._session = undefined;
                    this._sessionState = 'idle';
                    this._sessionFails++;
                    if (this._sessionFails >= 2)
                        this.coordinatorUnreachable();
                    else
                        this.armHeartbeat();
                }
                else if (gone && gone !== this.coordinatorPeerId) {
                    this.knownPeers.delete(gone);
                    this.removePeer(gone);
                }
            }
            else if (error?.type === 'unavailable-id') {
                // Our id went to somebody else while we were away from the server
                // (a coordinator phone that slept through an election).
                this.rebuildAsRegularPeer();
            }
            // Everything else is PeerJS's to handle: a lost server connection
            // arrives as 'disconnected' right after.
        });
    }
    /**
     * Create a regular (non-coordinator) peer and connect to coordinator.
     */
    createRegularPeer(resolve, reject) {
        const epoch = this._epoch;
        const peerIdSuffix = Math.random().toString(36).substring(7);
        this.peerId = `yjs-${this._room}-${peerIdSuffix}`;
        const peer = new this.options.peer(this.peerId, {
            debug: this.options.debug ? 3 : 0,
            ...this.options.peerOptions,
        });
        this.peer = peer;
        let opened = false;
        peer.on('open', (id) => {
            if (opened)
                return; // later re-registrations belong to wirePeer()
            opened = true;
            if (epoch !== this._epoch) {
                peer.destroy();
                return;
            }
            this.peerId = id;
            this._connected = true;
            // Setup peer discovery via BroadcastChannel (same-browser tabs)
            this.setupPeerDiscovery();
            this.wirePeer(peer);
            if (this._sparse) {
                // No permanent link to the coordinator: a session, a sample, and gone again.
                this.openSession();
                resolve();
                return;
            }
            // Setup cross-browser discovery via coordinator pattern
            this.setupCrossBrowserDiscovery()
                .then(() => resolve())
                .catch((err) => {
                this.log('⚠️ No coordinator link yet, continuing with BroadcastChannel and retrying:', err);
                // Still resolve - BroadcastChannel works for same-browser tabs.
                resolve();
                // ... and keep looking: the coordinator may be a dead
                // registration the server has not dropped yet, or mid-election.
                // Without this the peer stayed alone for good (repro part 10).
                if (epoch === this._epoch)
                    this.attemptCoordinatorConnection();
            });
        });
        peer.on('error', (error) => {
            if (opened)
                return;
            this.log('Peer error:', error);
            reject(error);
        });
    }
    /**
     * Disconnect from all peers and cleanup.
     */
    disconnect() {
        // Ends the session for every pending timer and continuation (later(),
        // connect(), the election) - also when connect() is still in flight.
        this._epoch++;
        this._rejoinGen++;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = undefined;
        }
        this._reconnectAttempts = 0;
        this._stopResumeWatch?.();
        this._stopResumeWatch = undefined;
        this._stopNetworkChangeWatch?.();
        this._stopNetworkChangeWatch = undefined;
        this._stopPageWatch?.();
        this._stopPageWatch = undefined;
        if (!this._connected) {
            if (this.peer) {
                try {
                    this.peer.destroy();
                }
                catch (_) { }
                this.peer = null;
            }
            return;
        }
        this._destroying = true;
        // Clear discovery interval
        if (this.discoveryInterval) {
            clearInterval(this.discoveryInterval);
            this.discoveryInterval = undefined;
        }
        // Close BroadcastChannel
        if (this.broadcastChannel) {
            // Announce disconnection
            this.broadcastChannel.postMessage({
                type: 'leave',
                peerId: this.peerId,
            });
            this.broadcastChannel.close();
            this.broadcastChannel = undefined;
        }
        // Disconnect from coordinator if connected
        if (this.coordinatorConn) {
            try {
                this.sendCoordinationMessage(this.coordinatorConn, {
                    type: 'leave',
                    peerId: this.peerId,
                });
                this.coordinatorConn.close();
            }
            catch (err) {
                // Ignore errors during cleanup
            }
            this.coordinatorConn = undefined;
        }
        // If we're coordinator, notify all peers we're leaving
        if (this.isCoordinator) {
            for (const peerId of this.roomPeers) {
                if (peerId !== this.peerId) {
                    const peerConn = this.peers.get(peerId);
                    if (peerConn && peerConn.connected) {
                        try {
                            this.sendCoordinationMessage(peerConn.conn, {
                                type: 'coordinator-leaving',
                                peerId: this.peerId,
                            });
                        }
                        catch (err) {
                            // Ignore
                        }
                    }
                }
            }
            this.isCoordinator = false;
            this.roomPeers.clear();
        }
        this.clearSessionTimer();
        if (this._session) {
            try {
                // A goodbye if a session happens to be open; otherwise the lease expires, which
                // is what the roster is for. Presence itself is the provider's, not ours.
                this.sendCoordinationMessage(this._session, { type: 'leave', peerId: this.peerId });
                this._session.close();
            }
            catch (err) {
                // Ignore
            }
            this._session = undefined;
        }
        this._sessionState = 'idle';
        this._sessionFails = 0;
        this._claimAt = undefined;
        if (this._sidecar) {
            try {
                this._sidecar.destroy();
            }
            catch (err) {
                // Ignore
            }
            this._sidecar = undefined;
        }
        if (this._rosterSweep) {
            clearInterval(this._rosterSweep);
            this._rosterSweep = undefined;
        }
        this._roster.clear();
        this._sessions.clear();
        this._reserve = [];
        this._redials.clear();
        this._successors = [];
        // Close all peer connections
        for (const peerConn of this.peers.values()) {
            try {
                peerConn.conn.close();
            }
            catch (error) {
                // Ignore errors during cleanup
            }
        }
        this.peers.clear();
        this.knownPeers.clear();
        this.reElectionInProgress = false;
        // Destroy peer
        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }
        this._connected = false;
        this._destroying = false;
    }
    /**
     * Handle unexpected disconnect from the PeerJS signaling server.
     * Happens on network changes (WiFi ↔ mobile), server restarts, a phone's
     * OS closing the socket of a backgrounded page. PeerJS keeps the same
     * Peer ID — we call reconnect(); onSignalingReopened() then re-opens
     * DataConnections to the peers we already knew about.
     *
     * The first attempt is immediate, the following ones back off (doubling
     * from 1 s, +-50 % jitter, capped at 10 s, like WebSocketTransport):
     * while the server was unreachable every failed reconnect() reported
     * 'disconnected' again and was answered at once - 1,896 attempts in 10 s
     * in repro-peerjs-coordinator part 8.
     */
    _handlePeerServerDisconnect() {
        if (this._destroying || this._reconnectTimer)
            return;
        // PeerJS destroys a Peer it has given up on; reconnect() would throw.
        if (!this.peer || this.peer.destroyed) {
            this.rebuildAsRegularPeer();
            return;
        }
        // Defer until network is back if we are offline
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            this.log('📴 Offline – deferring PeerJS reconnect until network returns');
            const epoch = this._epoch;
            window.addEventListener('online', () => {
                this.log('🌐 Network restored – reconnecting to PeerJS server');
                if (epoch === this._epoch)
                    this._handlePeerServerDisconnect();
            }, { once: true });
            return;
        }
        const attempt = ++this._reconnectAttempts;
        const delay = attempt === 1
            ? 0
            : Math.round(Math.min(10000, 1000 * 2 ** (attempt - 2)) * (0.5 + Math.random()));
        const epoch = this._epoch;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = undefined;
            if (epoch !== this._epoch || !this.peer || !this.peer.disconnected)
                return;
            // peer.reconnect() re-registers the same ID with the PeerJS server;
            // a failure comes back as 'disconnected' and lands here again.
            try {
                this.peer.reconnect();
                this.log(`🔄 PeerJS reconnect #${attempt} initiated (peer ID: ${this.peerId})`);
            }
            catch (err) {
                this.log('❌ peer.reconnect() failed:', err);
                this.rebuildAsRegularPeer();
            }
        }, delay);
    }
    /**
     * A reconnect to the PeerJS server is waiting in its backoff - do it now.
     * A real phone (Chrome on Android, 67 s in the background, the page kept
     * running so no sleep was reported) came back between two attempts:
     * "server link lost 16 | reconnect 3 at 1948 | connected to coordinator
     * 3974" - all links back after 4.5 s, against 1.5 s when the resume path
     * ran (test/e2e/phone-session.mjs; repro-peerjs-coordinator, part 13).
     * Nothing to do while no backoff is pending: the first attempt after a
     * disconnect is immediate anyway.
     */
    reconnectNow() {
        if (this._destroying || !this._reconnectTimer)
            return;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = undefined;
        this._reconnectAttempts = 0;
        this._handlePeerServerDisconnect();
    }
    /**
     * ConferenceTransport, once, before connect(): how big the room is expected to be,
     * and whether we are a leaf. Above 16 expected peers this stops being a full mesh.
     *
     * A partial mesh without that wrapper above is not merely incomplete, it ERASES
     * presence - a dropped link is reported to GenericProvider as a departure, which
     * drops that peer's awareness and broadcasts a removal. Hence the warning below:
     * setRoomSize() is called by ConferenceTransport and by nothing else.
     */
    configureSparse(options) {
        if (options.passive !== undefined)
            this._passive = options.passive;
        const dial = options.dial ??
            (this._sparse === undefined && (options.expectedPeers ?? 0) > 16
                ? Math.max(4, Math.ceil(Math.log(options.expectedPeers)))
                : undefined);
        if (dial !== undefined)
            this._sparse = new SparseDial({ dial, maxConns: this.options.maxConns, passive: this._passive });
        else if (this._sparse)
            this._sparse.passive = this._passive;
        if (this._sparse && !this._sawRoomSize)
            this.warnIfUnwrapped();
    }
    /** The room size ConferenceTransport has counted - origins heard, not the expected size. */
    setRoomSize(peers) {
        this._roomSize = peers;
        this._sawRoomSize = true;
        this._sparse?.setRoomSize(peers);
    }
    /** A partial mesh that nobody relays for: say so, loudly, once. */
    warnIfUnwrapped() {
        this.later(() => {
            if (this._sawRoomSize || !this._sparse || !this._connected)
                return;
            console.warn('[PeerJSTransport] a partial mesh (dial) without ConferenceTransport: GenericProvider ' +
                'needs every broadcast to reach every peer. Wrap this transport in ' +
                "providers/conference, or drop the `dial` option. See the option's documentation.");
        }, 5000);
    }
    /** The server accepted us (again): re-open what the outage cost. */
    onSignalingReopened() {
        this._reconnectAttempts = 0;
        this.log(`✅ Registered with the PeerJS server — re-connecting to ${this.knownPeers.size} known peer(s)`);
        // Drop stale (never opened) DataConnection entries from before the outage
        for (const [peerId, peerConn] of Array.from(this.peers.entries())) {
            if (!peerConn.connected)
                this.removePeer(peerId, false);
        }
        // Re-establish connections to all known peers - under a sample only as many as we
        // asked for. knownPeers holds every id ever handed to us, so dialing all of it after
        // a server blip is a full-mesh rebuild, at every peer of the room at once.
        for (const peerId of this.knownPeers) {
            if (this._sparse && !this._sparse.wantsLinks(this.linkCount()))
                break;
            if (!this.peers.has(peerId) && peerId !== this.peerId) {
                this.log(`🔌 Re-connecting to known peer: ${peerId}`);
                this.connectToPeer(peerId);
            }
        }
        if (this._sparse)
            this.maybeRefill();
        if (this._sparse) {
            // A session is cheap and we may have missed a whole room while we were away.
            this._sessionFails = 0;
            this._claimAt = undefined;
            if (!this.isCoordinator)
                this.openSession();
            return;
        }
        // Regular peer: if coordinator connection was lost, reconnect to coordinator
        if (!this.isCoordinator &&
            this.coordinatorConn == null &&
            !this.reElectionInProgress) {
            this.reElectionInProgress = true;
            this.later(() => this.attemptCoordinatorConnection(), 1000);
        }
    }
    /**
     * The page slept (see watchResume): our links are dead on the other side
     * or about to be, and peers hold dead entries under our id. Leave and
     * join again - a fresh Peer under a new id (or the coordinator id, if it
     * is free). GenericProvider resyncs each link as it opens
     * (onPeerConnect).
     */
    handleResume(sleptMs) {
        if (!this._connected || this._destroying)
            return;
        this.log(`⏰ Page slept ${sleptMs}ms — leaving and re-joining the room`);
        this.rejoin(this._room, 0);
    }
    /**
     * Leave and join again, and again after a failed try: nobody else will. The
     * page that woke up may find the PeerJS server gone for a moment (its own
     * network coming back, a server restart): one refused try used to end it -
     * three pages unfrozen while the server restarted stayed out of the room for
     * good (room-scenarios.mjs STORM=faults; repro-peerjs-coordinator part 14).
     * 1 s, doubling, at most 10 s, jittered.
     */
    rejoin(room, attempt) {
        this.disconnect();
        const gen = ++this._rejoinGen;
        this.connect({ room }).catch((err) => {
            if (gen !== this._rejoinGen)
                return; // the app disconnected, or another re-join runs
            const delay = Math.min(10000, 1000 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
            this.log(`❌ Re-join after resume failed, again in ${Math.round(delay)} ms:`, err);
            setTimeout(() => {
                if (gen === this._rejoinGen)
                    this.rejoin(room, attempt + 1);
            }, delay);
        });
    }
    /**
     * Register callback for new peer data-channel connections.
     */
    onPeerConnect(callback) {
        this._peerConnectCallback = callback;
        return () => {
            this._peerConnectCallback = undefined;
        };
    }
    /** Transport.onPeerDisconnect: a connection closed/errored, or the coordinator said peer-left (removePeer). */
    onPeerDisconnect(callback) {
        this._peerDisconnectCallback = callback;
        return () => {
            this._peerDisconnectCallback = undefined;
        };
    }
    /**
     * Send data to all connected peers.
     */
    send(data) {
        if (!this._connected) {
            this.log('Not connected, cannot send');
            return;
        }
        // Encrypt if password is set
        const dataToSend = this.options.password
            ? this.encrypt(data, this.options.password)
            : data;
        for (const peerConn of this.peers.values()) {
            if (!peerConn.connected)
                continue;
            try {
                peerConn.conn.send(dataToSend);
            }
            catch (error) {
                this.log('Error sending to peer:', peerConn.peerId, error);
            }
        }
    }
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback) {
        this._callback = callback;
        return () => {
            this._callback = undefined;
        };
    }
    /**
     * Transport.sendTo: deliver to one connected peer (the `from` id passed
     * to onMessage). GenericProvider uses it for replies, acks and presence
     * responses so a join costs one delivery per responder instead of one
     * per peer per responder.
     */
    sendTo(peerId, data) {
        if (!this._connected)
            return;
        const peerConn = this.peers.get(peerId);
        if (!peerConn || !peerConn.connected)
            return;
        const dataToSend = this.options.password
            ? this.encrypt(data, this.options.password)
            : data;
        try {
            peerConn.conn.send(dataToSend);
        }
        catch (error) {
            this.log('Error sending to peer:', peerId, error);
        }
    }
    /**
     * Check if connected.
     */
    get isConnected() {
        return this._connected;
    }
    /**
     * Get number of connected peers (for debugging).
     */
    get connectedPeers() {
        return Array.from(this.peers.values()).filter((p) => p.connected).length;
    }
    /**
     * Setup peer discovery using BroadcastChannel for same-browser tabs.
     */
    setupPeerDiscovery() {
        if (typeof BroadcastChannel === 'undefined') {
            this.log('❌ BroadcastChannel not available in this browser');
            return;
        }
        // Called again after an election or a rebuild: one channel, one timer.
        if (this.discoveryInterval)
            clearInterval(this.discoveryInterval);
        this.broadcastChannel?.close();
        const channelName = `yjs-peerjs-${this._room}`;
        // Creating BroadcastChannel
        this.broadcastChannel = new BroadcastChannel(channelName);
        this.broadcastChannel.onmessage = (event) => {
            const msg = event.data;
            if (msg.peerId === this.peerId) {
                return; // Ignore own messages
            }
            if (msg.type === 'announce') {
                // Another peer announced
                // Discovered peer via BroadcastChannel
                this.knownPeers.add(msg.peerId);
                // Under a sample the tabs of one browser are room members like any other: left
                // unconditional they build a full clique underneath the sampled mesh, and no
                // harness would see it - they all run one isolated browser context per peer.
                if (!this._sparse || this._sparse.answers(msg.peerId, this.linkCount(), msg.leaf === true)) {
                    this.connectToPeer(msg.peerId);
                }
            }
            else if (msg.type === 'leave') {
                // Peer left
                // Peer left
                this.knownPeers.delete(msg.peerId);
                this.removePeer(msg.peerId);
            }
        };
        // Announce presence
        this.announcePeer();
        // Periodic announcements for new peers that join later
        this.discoveryInterval = setInterval(() => {
            if (!this._connected)
                return;
            if (this._sparse) {
                // The twin of simple-peer's announce retry (:492): announcing is over once we
                // have the links we asked for, and this is also where a short peer tops up.
                if (this._sparse.wantsLinks(this.linkCount()))
                    this.announcePeer();
                this.maybeRefill();
            }
            else if (this.peers.size < this.options.maxConns) {
                this.announcePeer();
            }
        }, 5000);
    }
    /**
     * Announce presence to other peers.
     */
    announcePeer() {
        if (this.broadcastChannel) {
            const message = {
                type: 'announce',
                peerId: this.peerId,
            };
            if (this._sparse)
                message.leaf = this._passive;
            this.broadcastChannel.postMessage(message);
        }
    }
    /**
     * Setup cross-browser peer discovery by connecting to the coordinator.
     *
     * Note: This method is only called for regular (non-coordinator) peers.
     * The coordinator already exists because we failed to claim its ID.
     */
    async setupCrossBrowserDiscovery() {
        // Connecting to coordinator
        // Wait a bit for PeerJS server registration to complete
        const epoch = this._epoch;
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (epoch !== this._epoch)
            throw new Error('Disconnected');
        return new Promise((resolve, reject) => {
            let connectionAttemptDone = false;
            let conn;
            // Set timeout for network issues
            const timeout = setTimeout(() => {
                if (!connectionAttemptDone) {
                    connectionAttemptDone = true;
                    const error = new Error('Timeout connecting to coordinator');
                    this.log('⏱️ Timeout connecting to coordinator');
                    try {
                        conn?.close(); // a dial that opens after all must not linger unused
                    }
                    catch (_) { }
                    reject(error);
                }
            }, 5000);
            try {
                // Connect to the coordinator (we know it exists)
                conn = this.peer.connect(this.coordinatorPeerId, {
                    reliable: true,
                    serialization: 'binary',
                    metadata: { role: 'peer', peerId: this.peerId },
                });
                conn.on('open', () => {
                    if (connectionAttemptDone)
                        return;
                    connectionAttemptDone = true;
                    clearTimeout(timeout);
                    if (epoch !== this._epoch) {
                        conn.close();
                        reject(new Error('Disconnected'));
                        return;
                    }
                    this.log('Connected to coordinator');
                    this.coordinatorConn = conn;
                    this.closeWhenIceStaysDisconnected(conn, this.coordinatorPeerId);
                    // IMPORTANT: Add coordinator to peers map for Yjs sync
                    const peerConn = {
                        conn,
                        connected: true,
                        peerId: this.coordinatorPeerId,
                        outgoing: true,
                    };
                    // An older link to the coordinator (it dialed us after winning
                    // an election) is replaced by this one.
                    this.removePeer(this.coordinatorPeerId, false);
                    this.peers.set(this.coordinatorPeerId, peerConn);
                    this.knownPeers.add(this.coordinatorPeerId);
                    // Notify provider of the coordinator channel opening
                    this._peerConnectCallback?.(this.coordinatorPeerId);
                    // Request peer list from coordinator (send as JSON-encoded binary)
                    this.sendCoordinationMessage(conn, this.joinMessage());
                    // Handle messages from coordinator
                    conn.on('data', (data) => {
                        this._stopResumeWatch?.alive(); // see watchResume: a page that handles this has not slept
                        // Try to decode as coordination message first
                        const uint8Data = data instanceof Uint8Array ? data : new Uint8Array(data);
                        const coordMessage = this.tryDecodeCoordinationMessage(uint8Data);
                        if (coordMessage) {
                            // Handle coordination messages
                            this.handleCoordinatorMessage(coordMessage);
                        }
                        else {
                            // It's Yjs sync data - process it
                            if (this._callback) {
                                try {
                                    // Decrypt if password is set
                                    const decryptedData = this.options.password
                                        ? this.decrypt(uint8Data, this.options.password)
                                        : uint8Data;
                                    this._callback(decryptedData, this.coordinatorPeerId);
                                }
                                catch (error) {
                                    this.log('Error handling coordinator data:', error);
                                }
                            }
                        }
                    });
                    conn.on('close', () => {
                        if (this.coordinatorConn !== conn)
                            return; // replaced, or we left
                        this.log('Coordinator disconnected');
                        this.knownPeers.delete(this.coordinatorPeerId);
                        this.removePeer(this.coordinatorPeerId, false);
                        this.handleCoordinatorDisconnect();
                    });
                    resolve();
                });
                conn.on('error', (err) => {
                    if (connectionAttemptDone)
                        return;
                    connectionAttemptDone = true;
                    clearTimeout(timeout);
                    this.log('❌ Failed to connect to coordinator:', err.message);
                    reject(err);
                });
            }
            catch (err) {
                if (!connectionAttemptDone) {
                    connectionAttemptDone = true;
                    clearTimeout(timeout);
                    this.log('⚠️ Error connecting to coordinator:', err);
                    reject(err);
                }
            }
        });
    }
    // =====================================================================
    // The signaling session (sparse only).
    //
    // In the full mesh the coordinator link IS a data link: it is in `peers`, it is
    // reported through onPeerConnect, and it carries Yjs. Under a sample it must not be,
    // because it is about to become transient - and a link that comes and goes every
    // minute would, under ConferenceTransport, tear down its routes, re-GRAFT every
    // neighbour and broadcast a suspicion about the coordinator, from every peer of the
    // room, once a minute. So: never in `peers`, never a callback, coordination only.
    // =====================================================================
    /** Open a session to the coordinator, unless one is already in flight. */
    openSession() {
        if (!this._sparse || this._destroying || !this.peer)
            return;
        if (this._sessionState !== 'idle' || this.isCoordinator)
            return;
        this.clearSessionTimer();
        this._sessionState = 'dialing';
        let settled = false;
        const fail = (why) => {
            if (settled)
                return;
            settled = true;
            this.log(`📇 session to the coordinator failed: ${why}`);
            this._session = undefined;
            this._sessionState = 'idle';
            this._sessionFails++;
            // Twice is enough to believe it: the first may be a handover in progress.
            if (this._sessionFails >= 2)
                this.coordinatorUnreachable();
            else
                this.armHeartbeat();
        };
        try {
            const conn = this.peer.connect(this.coordinatorPeerId, {
                reliable: true,
                serialization: 'binary',
                metadata: { role: 'signal', peerId: this.peerId },
            });
            this._session = conn;
            this.later(() => {
                if (this._session === conn && this._sessionState === 'dialing') {
                    try {
                        conn.close();
                    }
                    catch (err) {
                        // Ignore
                    }
                    fail('no answer in 5 s');
                }
            }, 5000);
            conn.on('open', () => {
                if (this._session !== conn || this._destroying)
                    return;
                settled = true;
                this._sessionState = 'open';
                this._sessionFails = 0;
                this._claimAt = undefined;
                this.sendCoordinationMessage(conn, this.joinMessage());
            });
            conn.on('data', (data) => {
                if (this._session !== conn)
                    return;
                this._stopResumeWatch?.alive();
                const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                const msg = this.tryDecodeCoordinationMessage(bytes);
                // A session carries coordination and nothing else - a frame that is not
                // coordination is not ours to hand to the document.
                if (msg)
                    this.handleCoordinatorMessage(msg);
                if (msg?.type === 'peer-list') {
                    // Linger a moment: joiners that overlap here hear each other's peer-joined,
                    // the only announcement a coordinator that holds no links can make.
                    this.clearSessionTimer();
                    this._sessionTimer = setTimeout(() => this.endSession(), this.options.sessionLingerMs);
                }
            });
            const done = () => {
                if (this._session !== conn)
                    return;
                if (this._sessionState === 'open') {
                    this._session = undefined;
                    this._sessionState = 'idle';
                    this.armHeartbeat();
                }
                else
                    fail('closed before it opened');
            };
            conn.on('close', done);
            conn.on('error', done);
        }
        catch (err) {
            fail(String(err));
        }
    }
    /** The sample is in (or the linger is over): close it and come back later. */
    endSession() {
        this.clearSessionTimer();
        const conn = this._session;
        this._session = undefined;
        this._sessionState = 'idle';
        if (conn) {
            try {
                conn.close();
            }
            catch (err) {
                // Ignore
            }
        }
        this.armHeartbeat();
    }
    clearSessionTimer() {
        this._sessionDue = undefined;
        if (this._sessionTimer) {
            clearTimeout(this._sessionTimer);
            this._sessionTimer = undefined;
        }
    }
    /**
     * When to go back. Not a fixed period: a peer that has its links needs the coordinator
     * only to renew its lease, but one with NO links needs an id right now.
     */
    armHeartbeat(onlyEarlier = false) {
        if (!this._sparse || this._destroying || this.isCoordinator)
            return;
        const ms = nextHeartbeatMs(this.linkCount(), this._sparse.dial, {
            renewMs: Math.max(this.options.coordinatorRenewMs, this._renewMs),
            attempt: this._sessionFails,
        });
        // maybeRefill runs every 5 s: it may bring a pending visit forward, never push one back
        // (a 4-6 s backoff re-armed every 5 s went out 9 s apart - repro-peerjs-sparse part 12).
        if (onlyEarlier && this._sessionTimer && (this._sessionDue ?? 0) <= Date.now() + ms)
            return;
        this.clearSessionTimer();
        this._sessionDue = Date.now() + ms;
        this._sessionTimer = setTimeout(() => {
            this._sessionTimer = undefined;
            this.openSession();
        }, ms);
    }
    /**
     * Nobody answers at the room's name. Claim it - the claim is its own probe, the server
     * hands the name to exactly one and answers everybody else 'unavailable-id'. The delay
     * comes from the successor chain of our last sample, so in the common case exactly one
     * peer claims within a few hundred ms and the rest never try at all.
     */
    coordinatorUnreachable() {
        if (!this._sparse || this._destroying || this.isCoordinator)
            return;
        if (this._sessionState === 'claiming')
            return;
        let ms = claimDelayMs(this.peerId, this._successors, { passive: this._passive, roomSize: this._roomSize });
        if (this._passive) {
            // A leaf waits 12-22 s before it claims, and somebody else usually takes the name
            // in that time: it keeps asking at the name meanwhile instead of sitting alone for
            // all of it (repro-peerjs-sparse part 11). Past the deadline it claims at once.
            this._claimAt ?? (this._claimAt = Date.now() + ms);
            if (Date.now() < this._claimAt) {
                this.armHeartbeat();
                return;
            }
            ms = 0;
        }
        this._claimAt = undefined;
        this._sessionState = 'claiming';
        this.clearSessionTimer();
        this.log(`🗳️ the coordinator does not answer - claiming its name in ${Math.round(ms)} ms`);
        this._sessionTimer = setTimeout(() => {
            this._sessionTimer = undefined;
            this.claimSidecar();
        }, ms);
    }
    /**
     * Claim the room's name in a SECOND Peer object. Our own identity, our links and our
     * place in the mesh are untouched by this - which is what makes "claim first, ask
     * questions later" affordable. A failed claim costs one destroyed Peer and nothing else.
     */
    claimSidecar() {
        if (!this._sparse || this._destroying || this.isCoordinator)
            return;
        let settled = false;
        const sidecar = new this.options.peer(this.coordinatorPeerId, {
            debug: this.options.debug ? 3 : 0,
            ...this.options.peerOptions,
        });
        this._sidecar = sidecar;
        const lost = (why) => {
            if (settled)
                return;
            settled = true;
            this.log(`🗳️ the name went to somebody else (${why})`);
            try {
                sidecar.destroy();
            }
            catch (err) {
                // Ignore
            }
            if (this._sidecar === sidecar)
                this._sidecar = undefined;
            this._sessionState = 'idle';
            this._sessionFails = 0;
            // Somebody holds it now: go and take a sample from them.
            this.clearSessionTimer();
            this._sessionTimer = setTimeout(() => {
                this._sessionTimer = undefined;
                this.openSession();
            }, 250 + Math.random() * 500);
        };
        this.later(() => {
            if (!settled && this._sidecar === sidecar)
                lost('no answer in 5 s');
        }, 5000);
        sidecar.on('open', (id) => {
            if (settled || this._destroying)
                return;
            settled = true;
            if (id !== this.coordinatorPeerId) {
                lost('the server gave us another id');
                return;
            }
            this.log('👑 holding the room name in a sidecar Peer - our own links are untouched');
            this._sessionState = 'idle';
            this._sessionFails = 0;
            this.isCoordinator = true;
            this.startSparseRoster();
            sidecar.on('connection', (conn) => {
                if (this._sidecar === sidecar)
                    this.onSession(conn);
            });
            this.maybeRefill();
        });
        sidecar.on('error', (error) => {
            if (error?.type === 'unavailable-id') {
                lost('unavailable-id');
                return;
            }
            if (settled)
                return; // the sidecar is ours; non-fatal errors are PeerJS's to handle
            lost(String(error?.type ?? error));
        });
        sidecar.on('disconnected', () => {
            // The server dropped our registration: somebody else may take the name.
            if (this._sidecar === sidecar && this.isCoordinator) {
                try {
                    sidecar.reconnect();
                }
                catch (err) {
                    // Ignore
                }
            }
        });
    }
    /** Coordinator side: somebody opened a signaling session with us. */
    onSession(conn) {
        if (this._destroying)
            return;
        this._sessions.add(conn);
        const remotePeerId = conn.metadata?.peerId ?? conn.peer;
        conn.on('data', (data) => {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            const msg = this.tryDecodeCoordinationMessage(bytes);
            if (msg?.type === 'join')
                this.answerSparseJoin(conn, msg.peerId ?? remotePeerId, msg);
            else if (msg?.type === 'leave')
                this._roster.delete(msg.peerId ?? remotePeerId);
        });
        const gone = () => this._sessions.delete(conn);
        conn.on('close', gone);
        conn.on('error', gone);
    }
    /** What we ask the coordinator for. Under a sample it says how short we are. */
    joinMessage() {
        const msg = { type: 'join', peerId: this.peerId };
        if (!this._sparse)
            return msg;
        msg.sparse = true;
        msg.leaf = this._passive;
        msg.want = Math.max(0, this._sparse.dial - this.linkCount());
        // What we already hold: handing it back would waste the sample. Capped, because the
        // message goes over a data channel and a room of 300 is not a peer list.
        msg.have = Array.from(this.peers.keys())
            .filter((id) => id !== this.coordinatorPeerId)
            .slice(0, 32);
        return msg;
    }
    /** Links that count towards the dial rule - never the coordinator's, which is signaling. */
    linkCount() {
        return this.peers.has(this.coordinatorPeerId) ? this.peers.size - 1 : this.peers.size;
    }
    /** Roster entries whose lease still runs. */
    liveRoster(now = Date.now()) {
        let n = 0;
        for (const entry of this._roster.values())
            if (entry.expires > now)
                n++;
        return n;
    }
    /**
     * A peer asked to join a sampled room. It gets a SAMPLE, not the roster - that is the
     * whole point: a peer list of 300 is a full mesh with extra steps.
     */
    answerSparseJoin(conn, remotePeerId, msg) {
        const now = Date.now();
        // Pace the room's renewals so the coordinator - a browser tab that is also an ordinary
        // peer - stays under the handshakes per second it is willing to do.
        const renewInMs = Math.max(this.options.coordinatorRenewMs, Math.ceil(this._roster.size / Math.max(1, this.options.coordinatorSessionsPerSec)) * 1000);
        // The lease is derived from the interval we are about to hand out, so the two can
        // never drift apart. 2.5x: an entry survives one missed renewal.
        this._roster.set(remotePeerId, { expires: now + 2.5 * renewInMs, leaf: msg.leaf === true });
        const want = Math.max(0, Number(msg.want) || 0);
        const peers = sampleRoster(this._roster, want, {
            self: remotePeerId,
            have: Array.isArray(msg.have) ? msg.have.slice(0, 32) : undefined,
            oversample: this.options.sampleOversample,
            now,
        });
        this.sendCoordinationMessage(conn, {
            type: 'peer-list',
            sparse: true,
            peers,
            size: this.liveRoster(now),
            successors: successorsOf(this._roster, now),
            renewInMs,
        });
        // Nobody dials a leaf that did not ask for the link.
        if (msg.leaf !== true)
            this.announceJoiner(remotePeerId);
    }
    /**
     * Tell a few of the room about a joiner. Capped and random: the full mesh tells
     * everybody, which is one message per peer per join, and every one of them a dial.
     */
    announceJoiner(joinerId) {
        const dial = this._sparse?.dial ?? 4;
        const targets = this._sessions.size > 0 ? Array.from(this._sessions) : [];
        if (targets.length === 0) {
            for (const [peerId, peerConn] of this.peers) {
                if (peerId !== joinerId && peerConn.connected)
                    targets.push(peerConn.conn);
            }
        }
        for (let i = targets.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = targets[i];
            targets[i] = targets[j];
            targets[j] = tmp;
        }
        const leaf = this._roster.get(joinerId)?.leaf === true;
        for (const conn of targets.slice(0, dial)) {
            try {
                this.sendCoordinationMessage(conn, { type: 'peer-joined', peerId: joinerId, leaf });
            }
            catch (err) {
                this.log('⚠️ Failed to notify peer of new joiner');
            }
        }
    }
    /** We hold the room's name: seed the roster from what we have seen, and age it. */
    startSparseRoster() {
        if (!this._sparse || this._rosterSweep)
            return;
        // A coordinator that starts with an empty roster hands out empty samples until the
        // first renewals arrive, and a joiner in that window sits alone. Seed it from what we
        // have actually seen, on a short probationary lease.
        const probation = Date.now() + this.options.coordinatorRenewMs / 3;
        for (const id of this.peers.keys()) {
            if (id !== this.coordinatorPeerId)
                this._roster.set(id, { expires: probation, leaf: false });
        }
        for (const id of this.knownPeers) {
            if (id !== this.coordinatorPeerId && id !== this.peerId && !this._roster.has(id)) {
                this._roster.set(id, { expires: probation, leaf: false });
            }
        }
        this._rosterSweep = setInterval(() => {
            const now = Date.now();
            for (const [id, entry] of this._roster)
                if (entry.expires <= now)
                    this._roster.delete(id);
        }, Math.max(1000, this.options.coordinatorRenewMs / 4));
    }
    /**
     * Ids the coordinator handed us: dial what we are short of, keep the rest in reserve.
     *
     * Shuffled even when the list arrives whole (an older coordinator, or a room below the
     * sparse threshold): taking the first few of a Set means taking whoever joined first,
     * and a partial mesh whose links all point at the room's oldest peers has no better
     * diameter than y-webrtc's chain (../dial.ts).
     */
    absorbSample(ids, msg) {
        if (!this._sparse)
            return;
        const fresh = [];
        for (const id of ids) {
            if (id === this.peerId || id === this.coordinatorPeerId)
                continue;
            this._sparse.heard(id);
            if (!this.peers.has(id))
                fresh.push(id);
        }
        for (let i = fresh.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = fresh[i];
            fresh[i] = fresh[j];
            fresh[j] = tmp;
        }
        this._reserve = fresh;
        if (Array.isArray(msg?.successors))
            this._successors = msg.successors;
        if (typeof msg?.renewInMs === 'number')
            this._renewMs = msg.renewInMs;
        this.drainReserve();
    }
    /** Dial out of the reserve until we have the links we asked for. */
    drainReserve() {
        if (!this._sparse)
            return;
        while (this._reserve.length > 0 && this._sparse.wantsLinks(this.linkCount())) {
            const id = this._reserve.shift();
            if (this.peers.has(id))
                continue;
            this.knownPeers.add(id);
            this.connectToPeer(id);
        }
    }
    /** Short of links: the reserve first, and only then the coordinator. */
    maybeRefill() {
        if (!this._sparse || !this._connected || this._destroying)
            return;
        this.drainReserve();
        if (!this._sparse.wantsLinks(this.linkCount()))
            return;
        if (this.isCoordinator) {
            // Holding the room's name does not excuse us from being in the room: the coordinator
            // is an ordinary peer of the mesh and needs its `dial` links like everybody. It just
            // has the census already, so it samples its own roster instead of opening a session.
            this.absorbSample(sampleRoster(this._roster, this._sparse.dial - this.linkCount(), {
                self: this.peerId,
                have: Array.from(this.peers.keys()),
                oversample: this.options.sampleOversample,
            }));
            return;
        }
        if (this._sessionState !== 'idle')
            return;
        // Whatever heartbeat is pending was armed while we still had our links - a minute
        // away. Re-arm it for what we have now: a couple of seconds, or nothing at all if
        // we are down to zero (test/peerjs/e2e-handover.mjs part 2 lives on that case).
        this.armHeartbeat(true);
    }
    /**
     * Handle messages from coordinator (when we're a regular peer).
     */
    handleCoordinatorMessage(data) {
        switch (data.type) {
            case 'peer-list':
                // Received list of all peers in room from coordinator
                // Received peer list
                if (this._sparse) {
                    this.absorbSample(data.peers ?? [], data);
                    break;
                }
                for (const peerId of data.peers) {
                    if (peerId !== this.peerId && !this.peers.has(peerId)) {
                        this.knownPeers.add(peerId);
                        this.connectToPeer(peerId);
                    }
                }
                break;
            case 'peer-joined':
                // A new peer joined the room
                // New peer joined
                if (data.peerId !== this.peerId && !this.peers.has(data.peerId)) {
                    // The one place the dice of the broadcast transports survive: an announcement
                    // we overheard, answered with probability ~ dial / room size (../dial.ts).
                    if (this._sparse && !this._sparse.answers(data.peerId, this.linkCount(), data.leaf === true))
                        break;
                    this.knownPeers.add(data.peerId);
                    this.connectToPeer(data.peerId);
                }
                break;
            case 'peer-left':
                // A peer left the room
                // Peer left
                this.knownPeers.delete(data.peerId);
                // Under a sample the coordinator's roster is leases, and a lease that ran out is a
                // poor liveness signal: closing a HEALTHY link over one is how a partial mesh loses
                // peers. Departures belong to ConferenceTransport (SUSPECT / ALIVE / LEAVE).
                if (this._sparse)
                    this._sparse.forget(data.peerId);
                else
                    this.removePeer(data.peerId);
                break;
            case 'coordinator-change':
                // Coordinator changed
                // Coordinator changed
                this.coordinatorPeerId = data.coordinatorId;
                // We might need to reconnect to the new coordinator
                break;
            case 'coordinator-leaving':
                // Coordinator is leaving
                this.log('Coordinator leaving, re-election starting');
                this.handleCoordinatorDisconnect();
                break;
        }
    }
    /**
     * Handle coordinator disconnect - start re-election.
     */
    handleCoordinatorDisconnect() {
        // Our own disconnect() closes the coordinator link too - no election.
        if (this._destroying)
            return;
        // Prevent duplicate re-elections
        if (this.reElectionInProgress) {
            this.log('⏭️ Re-election already in progress, skipping');
            return;
        }
        // If we are currently offline the coordinator disconnected because WE lost
        // the network, not because the coordinator disappeared.  Any attempt to
        // create a new PeerJS peer will fail immediately with "Lost connection to
        // server".  Defer the whole re-election until we are back online.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            this.log('📴 Offline – deferring re-election until network returns');
            const epoch = this._epoch;
            const handler = () => {
                this.log('🌐 Network restored – resuming re-election');
                if (epoch === this._epoch)
                    this.handleCoordinatorDisconnect();
            };
            window.addEventListener('online', handler, { once: true });
            return;
        }
        this.log('🗳️ Coordinator disconnected, starting re-election');
        this.reElectionInProgress = true;
        this.coordinatorConn = undefined;
        // Gather all known peer IDs
        const knownPeerIds = [
            this.peerId,
            ...Array.from(this.knownPeers),
            ...Array.from(this.peers.keys()),
        ].filter((id) => id !== this.coordinatorPeerId); // Exclude the old coordinator
        // Sort and pick lowest ID
        knownPeerIds.sort();
        const lowestId = knownPeerIds[0];
        this.log('🗳️ Coordinator election: Lowest peer ID is', lowestId);
        if (lowestId === this.peerId) {
            this.log('👑 I have the lowest ID, attempting to claim coordinator role');
            this.transitionToCoordinator();
        }
        else {
            // Waiting for new coordinator
            this.log('⏳ Waiting for new coordinator:', lowestId);
            // Wait a bit for the new coordinator to claim the ID, then try to connect
            this.later(() => this.attemptCoordinatorConnection(), 2000);
        }
    }
    /**
     * Attempt to connect to the coordinator.
     * If coordinator doesn't exist yet, retry a few times.
     */
    attemptCoordinatorConnection(retryCount = 0) {
        const maxRetries = 5;
        const epoch = this._epoch;
        if (retryCount >= maxRetries) {
            this.log('❌ Failed to connect to coordinator after', maxRetries, 'attempts');
            // Try to become coordinator ourselves as fallback
            this.log('🔄 Attempting to become coordinator as fallback');
            this.transitionToCoordinator();
            return;
        }
        this.log(`🔌 Attempting to connect to coordinator (attempt ${retryCount + 1}/${maxRetries})`);
        this.setupCrossBrowserDiscovery()
            .then(() => {
            if (epoch !== this._epoch)
                return;
            this.log('✅ Successfully connected to new coordinator');
            this.reElectionInProgress = false; // Re-election complete
        })
            .catch((err) => {
            if (epoch !== this._epoch)
                return;
            this.log(`⚠️ Failed to connect to coordinator (attempt ${retryCount + 1}):`, err);
            // Retry with exponential backoff
            const delay = 1000 * Math.pow(1.5, retryCount);
            this.later(() => this.attemptCoordinatorConnection(retryCount + 1), delay);
        });
    }
    /**
     * Transition from regular peer to coordinator: claim the coordinator ID
     * with a second Peer FIRST, and give up our own Peer only once the claim
     * has succeeded (PeerJS cannot change a Peer's id, so the winner's mesh
     * links do go - they are re-dialed below).
     *
     * The claim fails whenever somebody else wins - and, after a coordinator
     * that went silent (a phone asleep), for as long as the PeerJS server
     * still holds its registration. It used to begin with
     * `this.peer.destroy()`: every failed claim cost the claimant all its
     * healthy mesh links and its id, and after five coordinator retries
     * every peer of the room claimed (repro-peerjs-coordinator, part 5).
     */
    async transitionToCoordinator() {
        this.log('🔄 Transitioning to coordinator role...');
        const epoch = this._epoch;
        let coordinatorPeer;
        try {
            coordinatorPeer = await new Promise((resolve, reject) => {
                const candidate = new this.options.peer(this.coordinatorPeerId, {
                    debug: this.options.debug ? 3 : 0,
                    ...this.options.peerOptions,
                });
                // Claim handlers decide once - see connect().
                let settled = false;
                const fail = (error) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timeout);
                    candidate.destroy();
                    reject(error);
                };
                const timeout = setTimeout(() => fail(new Error('Timeout claiming coordinator ID')), 5000);
                candidate.on('open', (id) => {
                    if (settled)
                        return;
                    if (id !== this.coordinatorPeerId) {
                        fail(new Error(`Claimed ${id} instead of the coordinator ID`));
                        return;
                    }
                    settled = true;
                    clearTimeout(timeout);
                    resolve(candidate);
                });
                candidate.on('error', fail);
            });
        }
        catch (error) {
            if (epoch !== this._epoch)
                return;
            // Nothing lost: our Peer and its links are untouched. Look for the
            // coordinator again - whoever won, or, after its retries, the next
            // claim (the server drops a dead registration within its timeout).
            this.log('❌ Coordinator claim failed, looking for the coordinator again:', error);
            this.attemptCoordinatorConnection();
            return;
        }
        if (epoch !== this._epoch) {
            coordinatorPeer.destroy(); // disconnect() while we were claiming
            return;
        }
        this.log('✅ Successfully claimed coordinator ID');
        const known = Array.from(this.peers.keys());
        const oldPeer = this.peer;
        this.peer = coordinatorPeer;
        this.peerId = this.coordinatorPeerId;
        this.isCoordinator = true;
        this.coordinatorConn = undefined;
        this.roomPeers.clear();
        this.roomPeers.add(this.peerId);
        this.startSparseRoster();
        this.reElectionInProgress = false; // Re-election complete
        // Our old identity goes, and its links with it (each reports
        // onPeerDisconnect through its close handler).
        try {
            oldPeer?.destroy();
        }
        catch (_) { }
        for (const peerId of Array.from(this.peers.keys()))
            this.removePeer(peerId, false);
        this.setupPeerDiscovery();
        this.wirePeer(coordinatorPeer);
        // Re-establish connections with known peers
        this.log('🔗 Re-establishing connections with', known.length, 'known peers');
        for (const peerId of known) {
            if (peerId !== this.coordinatorPeerId) {
                this.knownPeers.add(peerId);
                this.roomPeers.add(peerId);
                this.connectToPeer(peerId);
            }
        }
    }
    /**
     * Our Peer is unusable - PeerJS destroyed it, or the server gave our id
     * to somebody else while we were away. Start over as a regular peer
     * with a fresh id and look for the coordinator.
     */
    rebuildAsRegularPeer() {
        if (this._destroying)
            return;
        const epoch = this._epoch;
        const oldPeer = this.peer;
        this.peer = null;
        try {
            oldPeer?.destroy();
        }
        catch (_) { }
        for (const peerId of Array.from(this.peers.keys()))
            this.removePeer(peerId, false);
        this.isCoordinator = false;
        this.roomPeers.clear();
        this.coordinatorConn = undefined;
        this.reElectionInProgress = true; // until the coordinator link is up
        const peerIdSuffix = Math.random().toString(36).substring(7);
        this.peerId = `yjs-${this._room}-${peerIdSuffix}`;
        const peer = new this.options.peer(this.peerId, {
            debug: this.options.debug ? 3 : 0,
            ...this.options.peerOptions,
        });
        this.peer = peer;
        let opened = false;
        peer.on('open', (id) => {
            if (opened)
                return; // later re-registrations belong to wirePeer()
            opened = true;
            if (epoch !== this._epoch) {
                peer.destroy();
                return;
            }
            this.peerId = id;
            this._connected = true;
            this.log('✅ Rebuilt as regular peer:', id);
            this.setupPeerDiscovery();
            this.wirePeer(peer);
            // Connect to whoever is now coordinator
            this.attemptCoordinatorConnection();
        });
        peer.on('error', (error) => {
            if (opened || epoch !== this._epoch || peer !== this.peer)
                return;
            this.log('❌ Error rebuilding as regular peer:', error);
            // Offline: wait for the network. Otherwise back off briefly.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                window.addEventListener('online', () => {
                    if (epoch === this._epoch)
                        this.rebuildAsRegularPeer();
                }, { once: true });
            }
            else {
                this.later(() => this.rebuildAsRegularPeer(), 3000);
            }
        });
    }
    /**
     * Connect to a peer by ID.
     * To avoid race conditions, only the peer with the lower ID initiates the connection.
     */
    connectToPeer(remotePeerId) {
        if (remotePeerId === this.peerId) {
            // Skip self-connection
            return;
        }
        if (this.peers.has(remotePeerId)) {
            return;
        }
        if (this._sparse ? !this._sparse.accepts(this.linkCount()) : this.peers.size >= this.options.maxConns) {
            // Max connections reached
            return;
        }
        // Only initiate if our peer ID is lower (to prevent dual-initiation race condition).
        // Not under a sample: there only ONE side is told about the pair, so whoever decides
        // to dial has to dial, whatever the ids say - waiting for the other end means half of
        // every sample yields no link at all (simple-peer/index.ts does the same, :944). Glare
        // is resolved in handleIncomingConnection, where the lower id's dial is the one both keep.
        if (this._sparse === undefined && this.peerId && this.peerId > remotePeerId) {
            // Waiting for peer to initiate
            return;
        }
        // Initiating connection
        try {
            const conn = this.peer.connect(remotePeerId, {
                reliable: true,
                serialization: 'binary',
            });
            if (!conn) {
                this.log('Failed to create connection object for:', remotePeerId);
                return;
            }
            // Connection object created
            this.setupConnection(conn, remotePeerId, true);
        }
        catch (error) {
            this.log('Error connecting to peer:', remotePeerId, error);
        }
    }
    /**
     * Handle incoming connection from another peer.
     */
    handleIncomingConnection(conn) {
        const remotePeerId = conn.peer;
        // Incoming connection
        const existing = this.peers.get(remotePeerId);
        if (existing) {
            // Both sides dialed at once (the id order normally prevents it): the
            // lower id's dial is the one both sides keep.
            if (!existing.connected && existing.outgoing && this.peerId < remotePeerId) {
                conn.close();
                return;
            }
            // Otherwise the peer dialed again because its side of the old link
            // is gone - it resumed, or noticed the failure before we did. The
            // entry we hold is dead; refusing the new connection kept the peer
            // out until our ICE timed out (repro-peerjs-coordinator, part 6).
            this.log('♻️ Peer connected again, replacing the old link:', remotePeerId);
            this._replacingPeer = remotePeerId;
            this.removePeer(remotePeerId, false);
            this._replacingPeer = undefined;
        }
        if (this._sparse ? !this._sparse.accepts(this.linkCount()) : this.peers.size >= this.options.maxConns) {
            this.log('Max connections reached, rejecting peer:', remotePeerId);
            conn.close();
            return;
        }
        // If we're the coordinator, handle coordination duties. Not under a sample: there the
        // roster is leases (_roster), a link of ours closing says nothing about the room, and
        // there are no links to announce it over anyway. Departures are the wrapper's.
        if (this.isCoordinator && !this._sparse) {
            // Add to room peers immediately
            this.roomPeers.add(remotePeerId);
            // Setup close handler to remove from room peers
            conn.on('close', () => {
                // The peer is not leaving, its old link is being replaced (above).
                if (this._replacingPeer === remotePeerId)
                    return;
                // Coordinator: peer left
                this.roomPeers.delete(remotePeerId);
                // Notify all other peers
                for (const peerId of this.roomPeers) {
                    if (peerId !== this.peerId) {
                        const peerConn = this.peers.get(peerId);
                        if (peerConn && peerConn.connected) {
                            try {
                                this.sendCoordinationMessage(peerConn.conn, {
                                    type: 'peer-left',
                                    peerId: remotePeerId,
                                });
                            }
                            catch (err) {
                                this.log('⚠️ Failed to notify peer of departure:', peerId);
                            }
                        }
                    }
                }
            });
        }
        // Setup the connection for Yjs sync (this handles all data including join messages)
        this.setupConnection(conn, remotePeerId, false);
    }
    /**
     * Setup a peer connection with event handlers.
     */
    setupConnection(conn, remotePeerId, outgoing) {
        // Setting up connection
        const peerConn = {
            conn,
            connected: false,
            peerId: remotePeerId,
            outgoing,
        };
        this.peers.set(remotePeerId, peerConn);
        this.closeWhenIceStaysDisconnected(conn, remotePeerId);
        // close/error may arrive after the entry under this id has been
        // replaced by a newer link - only ever remove our own.
        const removeOwnEntry = () => {
            if (this.peers.get(remotePeerId) === peerConn)
                this.removePeer(remotePeerId);
        };
        // A dial nobody answers fails on the Peer, if at all - never here.
        // Without this the entry blocked the id for good: no re-dial, and
        // (before handleIncomingConnection replaced entries) the peer's own
        // dials refused (repro-peerjs-coordinator, part 7).
        this.later(() => {
            if (!peerConn.connected) {
                this.log('⏱️ Connection never opened, dropping the entry:', remotePeerId);
                removeOwnEntry();
            }
        }, this.options.connectTimeout);
        conn.on('open', () => {
            peerConn.connected = true;
            this.knownPeers.add(remotePeerId);
            this._redials.delete(remotePeerId); // it held: the next drop gets its own retry
            // Notify provider so it can push its local state to this new peer
            this._peerConnectCallback?.(remotePeerId);
        });
        conn.on('data', (data) => {
            this._stopResumeWatch?.alive(); // see watchResume: a page that handles this has not slept
            // Convert to Uint8Array if needed
            const uint8Data = data instanceof Uint8Array ? data : new Uint8Array(data);
            // Under a sample, coordination lives on the signaling session and a data link
            // carries the document and nothing else - so the JSON attempt below is not an
            // optimisation to skip, it is simply not part of the protocol here. It also costs
            // a TextDecoder and a full decode of every frame on every link, and a frame that
            // happened to decode as JSON with a `type` would be DROPPED rather than synced.
            const coordMessage = this._sparse ? undefined : this.tryDecodeCoordinationMessage(uint8Data);
            if (coordMessage) {
                // Handle coordination messages
                if (remotePeerId !== this.coordinatorPeerId &&
                    coordMessage.type !== 'join') {
                    // Only the coordinator speaks for the room. A peer that still
                    // believed it was coordinator reported 'peer-left' for every
                    // link IT lost, and everybody closed their own healthy link to
                    // that peer (repro-peerjs-coordinator, part 9).
                    return;
                }
                if (coordMessage.type === 'coordinator-change' ||
                    coordMessage.type === 'coordinator-leaving' ||
                    coordMessage.type === 'peer-joined' ||
                    coordMessage.type === 'peer-left' ||
                    coordMessage.type === 'peer-list') {
                    this.handleCoordinatorMessage(coordMessage);
                    return;
                }
                else if (coordMessage.type === 'join' && this.isCoordinator) {
                    if (this._sparse && coordMessage.sparse === true) {
                        this.answerSparseJoin(conn, remotePeerId, coordMessage);
                        return;
                    }
                    // Handle join message if we're the coordinator
                    // Coordinator: peer joined
                    // Send current peer list (excluding coordinator and the new peer)
                    const peerList = Array.from(this.roomPeers).filter((id) => id !== this.peerId && id !== remotePeerId);
                    this.sendCoordinationMessage(conn, {
                        type: 'peer-list',
                        peers: peerList,
                    });
                    // Notify all other peers about the new peer
                    for (const peerId of this.roomPeers) {
                        if (peerId !== this.peerId && peerId !== remotePeerId) {
                            const peerConn = this.peers.get(peerId);
                            if (peerConn && peerConn.connected) {
                                try {
                                    this.sendCoordinationMessage(peerConn.conn, {
                                        type: 'peer-joined',
                                        peerId: remotePeerId,
                                    });
                                }
                                catch (err) {
                                    this.log('⚠️ Failed to notify peer of new joiner:', peerId);
                                }
                            }
                        }
                    }
                    return;
                }
            }
            // Otherwise, it's Yjs sync data
            if (this._callback) {
                try {
                    // Decrypt if password is set
                    const decryptedData = this.options.password
                        ? this.decrypt(uint8Data, this.options.password)
                        : uint8Data;
                    this._callback(decryptedData, remotePeerId);
                }
                catch (error) {
                    this.log('Error handling peer data:', error);
                }
            }
        });
        conn.on('close', removeOwnEntry);
        conn.on('error', (error) => {
            this.log('⚠️ Connection error:', remotePeerId, error);
            removeOwnEntry();
        });
    }
    /**
     * Remove and cleanup a peer connection.
     *
     * @param redial - dial the peer again in a moment if it is still known
     * to be in the room (nobody reported it gone). connectToPeer() lets only
     * the lower id dial, and used to run only on a coordinator message: a
     * pair whose link failed while both kept their coordinator link stayed
     * apart for good (repro-peerjs-coordinator, part 4). Callers that know
     * better (the peer left, we are replacing or tearing down) pass false.
     */
    removePeer(peerId, redial = true) {
        const peerConn = this.peers.get(peerId);
        if (!peerConn)
            return;
        // Entry first: close() reports 'close' synchronously, and the handler
        // must find the entry gone instead of removing it a second time.
        this.peers.delete(peerId);
        try {
            peerConn.conn.close();
        }
        catch (error) {
            // Ignore errors during cleanup
        }
        this._peerDisconnectCallback?.(peerId);
        if (!redial || this._destroying)
            return;
        if (this._sparse) {
            // A partial mesh replaces what it lost with somebody, not with the same id forever:
            // knownPeers holds every id ever sampled and only ever grows, so re-dialing out of it
            // converges straight back to the full mesh, and a peer that is gone eats one failed
            // dial every 2-3 s. One retry for a link that merely blipped, then let it go.
            const tried = (this._redials.get(peerId) ?? 0) + 1;
            // Either way we are short NOW: the reserve goes in at once, and the heartbeat is
            // re-armed for the link count we have rather than the one we had a minute ago.
            // Waiting out the retry first cost 7 s where it costs 2 (part 10).
            this.maybeRefill();
            if (tried <= 1 && this.knownPeers.has(peerId)) {
                this._redials.set(peerId, tried);
                this.later(() => this.connectToPeer(peerId), 2000 + Math.random() * 1000);
            }
            else {
                this._redials.delete(peerId);
                this.knownPeers.delete(peerId);
                this._sparse.forget(peerId);
                this.later(() => this.maybeRefill(), 2000 + Math.random() * 1000);
            }
            return;
        }
        if (this.knownPeers.has(peerId)) {
            this.later(() => this.connectToPeer(peerId), 2000 + Math.random() * 1000);
        }
    }
    /**
     * Send a coordination message (JSON encoded as binary).
     */
    sendCoordinationMessage(conn, message) {
        try {
            const jsonStr = JSON.stringify(message);
            const encoder = new TextEncoder();
            const encoded = encoder.encode(jsonStr);
            conn.send(encoded);
        }
        catch (error) {
            this.log('Error encoding coordination message:', error);
        }
    }
    /**
     * Try to decode data as a coordination message.
     * Returns the parsed message if successful, null otherwise.
     */
    tryDecodeCoordinationMessage(data) {
        // sendCoordinationMessage() sends JSON.stringify of an object: it starts
        // with '{'. Anything else is a Yjs frame - no TextDecoder over all of it.
        if (data[0] !== 0x7b)
            return null;
        try {
            const decoder = new TextDecoder();
            const jsonStr = decoder.decode(data);
            const parsed = JSON.parse(jsonStr);
            // Check if it looks like a coordination message (has a type field)
            if (parsed &&
                typeof parsed === 'object' &&
                parsed.type &&
                typeof parsed.type === 'string') {
                return parsed;
            }
            return null;
        }
        catch (error) {
            // Not JSON, must be Yjs data
            return null;
        }
    }
    /**
     * Simple XOR encryption (not cryptographically secure, just obfuscation).
     */
    encrypt(data, password) {
        const key = this.hashPassword(password);
        const encrypted = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            encrypted[i] = data[i] ^ key[i % key.length];
        }
        return encrypted;
    }
    /**
     * Simple XOR decryption.
     */
    decrypt(data, password) {
        // XOR is symmetric, so decrypt is the same as encrypt
        return this.encrypt(data, password);
    }
    /**
     * Hash password to key.
     */
    hashPassword(password) {
        const encoder = new TextEncoder();
        return encoder.encode(password);
    }
    /**
     * Log debug messages if enabled.
     */
    log(...args) {
        if (this.options.debug) {
            console.log('[PeerJSTransport]', ...args);
        }
    }
}
//# sourceMappingURL=index.js.map