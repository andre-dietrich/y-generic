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
     * Maximum number of peer connections. GenericProvider needs a FULL mesh
     * (a peer's broadcast reaches everyone directly, nobody relays): every
     * peer of the room must fit. A room larger than this loses pairs - they
     * see neither each other's presence nor each other's edits as they
     * happen. The former default (20-34, y-webrtc's, which relays) cut rooms
     * of 21+ peers: with 25 real browsers one peer ended up with 20 links
     * and missing from four rosters (test/e2e/room-scenarios.mjs).
     * @default 64
     */
    maxConns?: number;
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
    private _reconnectAttempts;
    private _reconnectTimer?;
    private _stopResumeWatch?;
    private _stopPageWatch?;
    private _replacingPeer?;
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