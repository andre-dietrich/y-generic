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
 * Discovery: the first peer of a room claims the well-known id
 * `yjs-coordinator-<room>` and introduces everybody else (join ->
 * peer-list / peer-joined / peer-left); data flows over the full mesh. When
 * the coordinator goes away the remaining peers elect the lowest id, which
 * claims the coordinator id with a second Peer and switches identity only
 * once the claim succeeded. Known limit: the PeerJS server keeps the
 * registration of a coordinator that went silent (a phone asleep) for up
 * to its alive_timeout (60 s) - the existing mesh keeps working meanwhile,
 * new joiners wait until the id is free. What phones do to this transport,
 * and the repro behind each guard below:
 * docs/superpowers/specs/2026-09-19-webrtc-mobile-resilience-research.md,
 * test/providers/repro-peerjs-coordinator.ts.
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
import { watchResume, watchPageBack } from '../resume';
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
        this._reconnectAttempts = 0; // signaling reconnect backoff
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
        };
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
        // Strategy: Try to claim the coordinator ID first
        // If taken, we'll get an error and become a regular peer
        return new Promise((resolve, reject) => {
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
                if (gone && gone !== this.coordinatorPeerId) {
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
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = undefined;
        }
        this._reconnectAttempts = 0;
        this._stopResumeWatch?.();
        this._stopResumeWatch = undefined;
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
    /** The server accepted us (again): re-open what the outage cost. */
    onSignalingReopened() {
        this._reconnectAttempts = 0;
        this.log(`✅ Registered with the PeerJS server — re-connecting to ${this.knownPeers.size} known peer(s)`);
        // Drop stale (never opened) DataConnection entries from before the outage
        for (const [peerId, peerConn] of Array.from(this.peers.entries())) {
            if (!peerConn.connected)
                this.removePeer(peerId, false);
        }
        // Re-establish connections to all known peers
        for (const peerId of this.knownPeers) {
            if (!this.peers.has(peerId) && peerId !== this.peerId) {
                this.log(`🔌 Re-connecting to known peer: ${peerId}`);
                this.connectToPeer(peerId);
            }
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
        const room = this._room;
        this.disconnect();
        this.connect({ room }).catch((err) => this.log('❌ Re-join after resume failed:', err));
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
        // Send to all connected peers
        let sentCount = 0;
        for (const peerConn of this.peers.values()) {
            if (peerConn.connected) {
                try {
                    peerConn.conn.send(dataToSend);
                    sentCount++;
                }
                catch (error) {
                    this.log('Error sending to peer:', peerConn.peerId, error);
                }
            }
        }
        // Sent to peers
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
                this.connectToPeer(msg.peerId);
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
            if (this._connected && this.peers.size < this.options.maxConns) {
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
                    this.sendCoordinationMessage(conn, {
                        type: 'join',
                        peerId: this.peerId,
                    });
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
    /**
     * Handle messages from coordinator (when we're a regular peer).
     */
    handleCoordinatorMessage(data) {
        switch (data.type) {
            case 'peer-list':
                // Received list of all peers in room from coordinator
                // Received peer list
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
                    this.knownPeers.add(data.peerId);
                    this.connectToPeer(data.peerId);
                }
                break;
            case 'peer-left':
                // A peer left the room
                // Peer left
                this.knownPeers.delete(data.peerId);
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
        if (this.peers.size >= this.options.maxConns) {
            // Max connections reached
            return;
        }
        // Only initiate if our peer ID is lower (to prevent dual-initiation race condition)
        if (this.peerId && this.peerId > remotePeerId) {
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
        if (this.peers.size >= this.options.maxConns) {
            this.log('Max connections reached, rejecting peer:', remotePeerId);
            conn.close();
            return;
        }
        // If we're the coordinator, handle coordination duties
        if (this.isCoordinator) {
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
            // Notify provider so it can push its local state to this new peer
            this._peerConnectCallback?.(remotePeerId);
        });
        conn.on('data', (data) => {
            this._stopResumeWatch?.alive(); // see watchResume: a page that handles this has not slept
            // Convert to Uint8Array if needed
            const uint8Data = data instanceof Uint8Array ? data : new Uint8Array(data);
            // Try to decode as JSON coordination message
            const coordMessage = this.tryDecodeCoordinationMessage(uint8Data);
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
        if (redial && !this._destroying && this.knownPeers.has(peerId)) {
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