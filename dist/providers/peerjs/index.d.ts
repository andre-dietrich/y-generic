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
import type { Transport, ConnectionConfig } from '../../transport';
/**
 * PeerJS constructor type (from peerjs library).
 */
export type PeerJSConstructor = any;
/**
 * Configuration options for PeerJS transport.
 */
export interface PeerJSTransportOptions {
    /**
     * The PeerJS library constructor.
     * Users must provide this to avoid bundling the library.
     * @example
     * ```typescript
     * import Peer from 'peerjs'
     * const transport = new PeerJSTransport({ peer: Peer })
     * ```
     */
    peer: PeerJSConstructor;
    /**
     * PeerJS server configuration.
     * @default Uses PeerJS Cloud (cloud.peerjs.com)
     */
    peerOptions?: {
        host?: string;
        port?: number;
        path?: string;
        key?: string;
        secure?: boolean;
        config?: any;
        debug?: number;
    };
    /**
     * Optional password for encrypting messages.
     * When provided, all messages are encrypted before sending.
     * @default undefined
     */
    password?: string;
    /**
     * Maximum number of peer connections. GenericProvider alone needs a FULL
     * mesh (a peer's broadcast reaches everyone directly, nobody relays):
     * every peer of the room must fit. A room larger than this loses pairs -
     * they see neither each other's presence nor each other's edits as they
     * happen. The former default (20-34, y-webrtc's, which relays) cut rooms
     * of 21+ peers: with 25 real browsers one peer ended up with 20 links
     * and missing from four rosters (test/e2e/room-scenarios.mjs).
     * Under ConferenceTransport (providers/conference), which passes frames
     * on, this stops being "everybody fits" and becomes what it says - the
     * hard cap of a PARTIAL mesh (see `dial`).
     * @default 64
     */
    maxConns?: number;
    /**
     * A PARTIAL mesh: ask for this many links instead of one to every peer
     * (see ../dial.ts; the average peer ends up with twice as many, and
     * `maxConns` stays the hard cap). ONLY under ConferenceTransport
     * (providers/conference), which passes frames on - GenericProvider alone
     * needs the full mesh, and a partial one under it does not merely lose
     * peers, it ERASES presence: a link that drops is reported as a departure.
     *
     * It also changes what the coordinator is. It answers a join with a
     * SAMPLE of the room instead of the roster, it holds its name in a second
     * Peer object rather than as its identity, and nobody keeps a link to it -
     * a peer opens a signaling session, takes its sample and closes it again.
     *
     * Left undefined, ConferenceTransport's `expectedPeers` decides: a full
     * mesh up to 16 peers, ln(N) links (at least 4) beyond.
     * @default undefined (full mesh)
     */
    dial?: number;
    /**
     * With `dial`: never dial a peer that announces itself, and never be
     * handed out in somebody else's sample - a leaf that holds the links it
     * asked for and nobody else's (a phone). It is also never a successor: a
     * page that sleeps must not be the room's coordinator.
     * ConferenceTransport sets it from its `relay: false`.
     * @default false
     */
    passive?: boolean;
    /**
     * With `dial`: how often (ms) a peer re-opens its session to the
     * coordinator to renew its roster entry. The coordinator may ask for a
     * LONGER interval (it divides its roster by `coordinatorSessionsPerSec`),
     * never a shorter one, and each peer jitters what it was told by +-25 %.
     * The lease is 2.5x the interval the coordinator asked for, so an entry
     * survives one missed renewal. Shorter: fewer ghosts in a sample, more
     * handshakes on the coordinator.
     * @default 60000
     */
    coordinatorRenewMs?: number;
    /**
     * With `dial`: how many signaling sessions per second the coordinator is
     * willing to handle; it paces its clients' renewals to stay under it (a
     * roster of 300 at 2/s is told to renew every 150 s). Every session is a
     * full ICE handshake, and the coordinator is a browser tab that is also
     * an ordinary peer of the room.
     * @default 2
     */
    coordinatorSessionsPerSec?: number;
    /**
     * With `dial`: a sample holds this many times the links that were asked
     * for. Not dial.ts's 1.3, which covers a dice roll - this covers GHOSTS:
     * the roster is leases, and an entry outlives a killed tab by up to one.
     * What is not dialed right away is kept in reserve, so replacing a link
     * that died usually costs no round trip to the coordinator at all.
     * @default 2
     */
    sampleOversample?: number;
    /**
     * With `dial`: how long (ms) a signaling session stays open after its
     * sample has arrived. Joiners that overlap in this window hear each
     * other's `peer-joined` - the only announcement a coordinator that holds
     * no links can make.
     * @default 2000
     */
    sessionLingerMs?: number;
    /**
     * How long (ms) a data connection may take to open. An entry that is not
     * open by then is dropped (and re-dialed while the peer is still known) -
     * a dial to a peer that is gone fails on the Peer ('peer-unavailable'),
     * never on the connection.
     * @default 30000
     */
    connectTimeout?: number;
    /**
     * How long (ms) a link may stay in ICE state 'disconnected' before it is
     * closed. PeerJS closes a connection on ICE 'failed' only, and Chrome
     * keeps a link whose peer vanished (a killed tab, a phone asleep) in
     * 'disconnected' - measured in a real Chrome: no 'failed', no close, in
     * 150 s; a vanished coordinator was never noticed and never replaced. A
     * transient 'disconnected' (WiFi roaming) recovers within seconds.
     * @default 15000
     */
    iceDisconnectTimeout?: number;
    /**
     * Leave and re-join the room under a new peer id when the page did not
     * run for this long (ms) - a phone browser in the background, a
     * suspended laptop. The other side dropped a silent link after ~30 s,
     * this side would still read it as open for ~30 s after waking up.
     * 0 disables.
     * Not below ~30 s: a link survives that much silence, so a shorter sleep
     * has nothing to repair - and Firefox delays the timers of a HIDDEN tab
     * in a busy room by up to ~15-20 s, which the old default of 15000 took
     * for a sleep (see SimplePeerTransport's option of the same name).
     * @default 30000
     */
    resumeAfterMs?: number;
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
}
/**
 * PeerJS transport implementation.
 * Creates direct peer-to-peer connections using PeerJS library.
 */
export declare class PeerJSTransport implements Transport {
    private options;
    private _connected;
    private _room;
    private _callback?;
    private _peerConnectCallback?;
    private _peerDisconnectCallback?;
    private peer;
    private peerId;
    private peers;
    private knownPeers;
    private broadcastChannel?;
    private discoveryInterval?;
    private isCoordinator;
    private coordinatorPeerId;
    private coordinatorConn?;
    private roomPeers;
    private reElectionInProgress;
    private _destroying;
    private _epoch;
    private _rejoinGen;
    private _reconnectAttempts;
    private _reconnectTimer?;
    private _stopResumeWatch?;
    private _stopNetworkChangeWatch?;
    private _stopPageWatch?;
    private _replacingPeer?;
    private _sparse?;
    private _passive;
    private _roomSize;
    private _sawRoomSize;
    private _reserve;
    private _redials;
    private _successors;
    private _renewMs;
    private _roster;
    private _rosterSweep?;
    private _sessions;
    private _session?;
    private _sessionState;
    private _sessionTimer?;
    private _sessionFails;
    private _sidecar?;
    /**
     * Create a new PeerJS transport.
     *
     * @param options - Configuration options (must include peer constructor)
     */
    constructor(options: PeerJSTransportOptions);
    /**
     * Close a connection that stays in ICE 'disconnected' - see the
     * iceDisconnectTimeout option. Its 'close' handlers do the rest (drop
     * the entry, re-dial, or start the election for a coordinator link).
     */
    private closeWhenIceStaysDisconnected;
    /** setTimeout that dies with disconnect() - see _epoch. */
    private later;
    /**
     * Connect to the room and start discovering peers.
     */
    connect(config: ConnectionConfig): Promise<void>;
    /**
     * Permanent handlers of the Peer we run on, attached once it is open and
     * adopted as `this.peer` - the one place, for all four ways a Peer comes
     * to be (claimed at connect, regular at connect, won election, rebuilt).
     */
    private wirePeer;
    /**
     * Create a regular (non-coordinator) peer and connect to coordinator.
     */
    private createRegularPeer;
    /**
     * Disconnect from all peers and cleanup.
     */
    disconnect(): void;
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
    private _handlePeerServerDisconnect;
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
    private reconnectNow;
    /**
     * ConferenceTransport, once, before connect(): how big the room is expected to be,
     * and whether we are a leaf. Above 16 expected peers this stops being a full mesh.
     *
     * A partial mesh without that wrapper above is not merely incomplete, it ERASES
     * presence - a dropped link is reported to GenericProvider as a departure, which
     * drops that peer's awareness and broadcasts a removal. Hence the warning below:
     * setRoomSize() is called by ConferenceTransport and by nothing else.
     */
    configureSparse(options: {
        dial?: number;
        expectedPeers?: number;
        passive?: boolean;
    }): void;
    /** The room size ConferenceTransport has counted - origins heard, not the expected size. */
    setRoomSize(peers: number): void;
    /** A partial mesh that nobody relays for: say so, loudly, once. */
    private warnIfUnwrapped;
    /** The server accepted us (again): re-open what the outage cost. */
    private onSignalingReopened;
    /**
     * The page slept (see watchResume): our links are dead on the other side
     * or about to be, and peers hold dead entries under our id. Leave and
     * join again - a fresh Peer under a new id (or the coordinator id, if it
     * is free). GenericProvider resyncs each link as it opens
     * (onPeerConnect).
     */
    private handleResume;
    /**
     * Leave and join again, and again after a failed try: nobody else will. The
     * page that woke up may find the PeerJS server gone for a moment (its own
     * network coming back, a server restart): one refused try used to end it -
     * three pages unfrozen while the server restarted stayed out of the room for
     * good (room-scenarios.mjs STORM=faults; repro-peerjs-coordinator part 14).
     * 1 s, doubling, at most 10 s, jittered.
     */
    private rejoin;
    /**
     * Register callback for new peer data-channel connections.
     */
    onPeerConnect(callback: (peerId: string) => void): () => void;
    /** Transport.onPeerDisconnect: a connection closed/errored, or the coordinator said peer-left (removePeer). */
    onPeerDisconnect(callback: (peerId: string) => void): () => void;
    /**
     * Send data to all connected peers.
     */
    send(data: Uint8Array): void;
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback: (data: Uint8Array, from?: string) => void): () => void;
    /**
     * Transport.sendTo: deliver to one connected peer (the `from` id passed
     * to onMessage). GenericProvider uses it for replies, acks and presence
     * responses so a join costs one delivery per responder instead of one
     * per peer per responder.
     */
    sendTo(peerId: string, data: Uint8Array): void;
    /**
     * Check if connected.
     */
    get isConnected(): boolean;
    /**
     * Get number of connected peers (for debugging).
     */
    get connectedPeers(): number;
    /**
     * Setup peer discovery using BroadcastChannel for same-browser tabs.
     */
    private setupPeerDiscovery;
    /**
     * Announce presence to other peers.
     */
    private announcePeer;
    /**
     * Setup cross-browser peer discovery by connecting to the coordinator.
     *
     * Note: This method is only called for regular (non-coordinator) peers.
     * The coordinator already exists because we failed to claim its ID.
     */
    private setupCrossBrowserDiscovery;
    /** Open a session to the coordinator, unless one is already in flight. */
    private openSession;
    /** The sample is in (or the linger is over): close it and come back later. */
    private endSession;
    private clearSessionTimer;
    /**
     * When to go back. Not a fixed period: a peer that has its links needs the coordinator
     * only to renew its lease, but one with NO links needs an id right now.
     */
    private armHeartbeat;
    /**
     * Nobody answers at the room's name. Claim it - the claim is its own probe, the server
     * hands the name to exactly one and answers everybody else 'unavailable-id'. The delay
     * comes from the successor chain of our last sample, so in the common case exactly one
     * peer claims within a few hundred ms and the rest never try at all.
     */
    private coordinatorUnreachable;
    /**
     * Claim the room's name in a SECOND Peer object. Our own identity, our links and our
     * place in the mesh are untouched by this - which is what makes "claim first, ask
     * questions later" affordable. A failed claim costs one destroyed Peer and nothing else.
     */
    private claimSidecar;
    /** Coordinator side: somebody opened a signaling session with us. */
    private onSession;
    /** What we ask the coordinator for. Under a sample it says how short we are. */
    private joinMessage;
    /** Links that count towards the dial rule - never the coordinator's, which is signaling. */
    private linkCount;
    /** Roster entries whose lease still runs. */
    private liveRoster;
    /**
     * A peer asked to join a sampled room. It gets a SAMPLE, not the roster - that is the
     * whole point: a peer list of 300 is a full mesh with extra steps.
     */
    private answerSparseJoin;
    /**
     * Tell a few of the room about a joiner. Capped and random: the full mesh tells
     * everybody, which is one message per peer per join, and every one of them a dial.
     */
    private announceJoiner;
    /** We hold the room's name: seed the roster from what we have seen, and age it. */
    private startSparseRoster;
    /**
     * Ids the coordinator handed us: dial what we are short of, keep the rest in reserve.
     *
     * Shuffled even when the list arrives whole (an older coordinator, or a room below the
     * sparse threshold): taking the first few of a Set means taking whoever joined first,
     * and a partial mesh whose links all point at the room's oldest peers has no better
     * diameter than y-webrtc's chain (../dial.ts).
     */
    private absorbSample;
    /** Dial out of the reserve until we have the links we asked for. */
    private drainReserve;
    /** Short of links: the reserve first, and only then the coordinator. */
    private maybeRefill;
    /**
     * Handle messages from coordinator (when we're a regular peer).
     */
    private handleCoordinatorMessage;
    /**
     * Handle coordinator disconnect - start re-election.
     */
    private handleCoordinatorDisconnect;
    /**
     * Attempt to connect to the coordinator.
     * If coordinator doesn't exist yet, retry a few times.
     */
    private attemptCoordinatorConnection;
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
    private transitionToCoordinator;
    /**
     * Our Peer is unusable - PeerJS destroyed it, or the server gave our id
     * to somebody else while we were away. Start over as a regular peer
     * with a fresh id and look for the coordinator.
     */
    private rebuildAsRegularPeer;
    /**
     * Connect to a peer by ID.
     * To avoid race conditions, only the peer with the lower ID initiates the connection.
     */
    private connectToPeer;
    /**
     * Handle incoming connection from another peer.
     */
    private handleIncomingConnection;
    /**
     * Setup a peer connection with event handlers.
     */
    private setupConnection;
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
    private removePeer;
    /**
     * Send a coordination message (JSON encoded as binary).
     */
    private sendCoordinationMessage;
    /**
     * Try to decode data as a coordination message.
     * Returns the parsed message if successful, null otherwise.
     */
    private tryDecodeCoordinationMessage;
    /**
     * Simple XOR encryption (not cryptographically secure, just obfuscation).
     */
    private encrypt;
    /**
     * Simple XOR decryption.
     */
    private decrypt;
    /**
     * Hash password to key.
     */
    private hashPassword;
    /**
     * Log debug messages if enabled.
     */
    private log;
}
//# sourceMappingURL=index.d.ts.map