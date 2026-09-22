/**
 * SimplePeer Transport Provider
 *
 * Peer-to-peer transport using WebRTC data channels with simple-peer library.
 * Connects directly to other clients without going through a central server.
 *
 * Features:
 * - Direct peer-to-peer connections
 * - Mesh network (each peer connects to multiple others)
 * - Uses signaling server only for peer discovery (not for data)
 * - Optional encryption
 * - Automatic connection management
 * - Resilient to peer disconnections
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { SimplePeerTransport } from 'y-generic/providers/simple-peer'
 * import Peer from 'simple-peer'
 *
 * const doc = new Y.Doc()
 * const transport = new SimplePeerTransport({
 *   peer: Peer, // Pass the simple-peer constructor
 *   signaling: ['wss://signaling.example.com'],
 *   password: 'optional-encryption-key'
 * })
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 * ```
 */
import type { Transport, ConnectionConfig } from '../../transport';
/**
 * SimplePeer constructor type (from simple-peer library).
 */
export type SimplePeerConstructor = any;
/**
 * ICE server configuration for STUN/TURN servers.
 * Used to establish WebRTC connections through NAT/firewalls.
 */
export interface IceServer {
    /**
     * STUN/TURN server URLs.
     * @example ['stun:stun.l.google.com:19302']
     * @example ['turn:turn.example.com:3478']
     */
    urls: string | string[];
    /**
     * Username for TURN server authentication.
     */
    username?: string;
    /**
     * Credential for TURN server authentication.
     */
    credential?: string;
}
/**
 * Configuration options for SimplePeer transport.
 */
export interface SimplePeerTransportOptions {
    /**
     * The simple-peer library constructor.
     * Users must provide this to avoid bundling the library.
     * @example
     * ```typescript
     * import Peer from 'simple-peer'
     * const transport = new SimplePeerTransport({ peer: Peer })
     * ```
     */
    peer: SimplePeerConstructor;
    /**
     * Array of signaling server URLs for peer discovery.
     * Signaling servers are only used to discover peers, not for data transfer.
     * A lost connection is re-opened with exponential backoff; the server
     * must answer `{type:'ping'}` with `{type:'pong'}` (y-webrtc's does) or
     * publish something at least every 30 s, else the socket counts as dead.
     * @default ['wss://y-webrtc-eu.fly.dev'] (y-webrtc's public server)
     */
    signaling?: string[];
    /**
     * ICE servers for STUN/TURN configuration.
     * Used to establish WebRTC connections through NAT/firewalls.
     * @default [{ urls: 'stun:stun.l.google.com:19302' }]
     * @example
     * ```typescript
     * iceServers: [
     *   { urls: 'stun:stun.l.google.com:19302' },
     *   {
     *     urls: 'turn:turn.example.com:3478',
     *     username: 'user',
     *     credential: 'pass'
     *   }
     * ]
     * ```
     */
    iceServers?: IceServer[];
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
     * A PARTIAL mesh: ask for this many links instead of one to every peer
     * (see ../dial.ts; the average peer ends up with twice as many, `maxConns`
     * stays the hard cap). ONLY under ConferenceTransport
     * (providers/conference), which passes frames on - GenericProvider alone
     * needs the full mesh. Left undefined, ConferenceTransport's
     * `expectedPeers` decides: a full mesh up to 16 peers, ln(N) links (at
     * least 4) beyond.
     * @default undefined (full mesh)
     */
    dial?: number;
    /**
     * With `dial`: never dial a peer that announces itself - a leaf that
     * holds the links it asked for and nobody else's (a phone).
     * ConferenceTransport sets it from its `relay: false`.
     * @default false
     */
    passive?: boolean;
    /**
     * Options passed to simple-peer.
     * See https://github.com/feross/simple-peer#api
     * Note: iceServers will be merged into peerOpts.config if not already present
     * @default {}
     */
    peerOpts?: Record<string, any>;
    /**
     * How long (ms) a peer connection may take to open. An entry that is not
     * connected by then is dropped, so the peer's next announce gets a fresh
     * attempt - an unanswered offer has no failure event of its own.
     * @default 30000
     */
    connectTimeout?: number;
    /**
     * Rebuild all links under a new peer id when the page did not run for
     * this long (ms) - a phone browser in the background, a suspended
     * laptop. The other side dropped a silent link after ~30 s, this side
     * would still read it as connected for ~30 s after waking up.
     * 0 disables.
     * Not below ~30 s: a link survives that much silence, so a shorter sleep
     * has nothing to repair - and Firefox delays the timers of a HIDDEN tab
     * in a busy room by up to ~15-20 s (measured; its budget throttling caps
     * at 15 s), which the old default of 15000 took for a sleep: a full
     * re-join about once a minute for every Firefox user with the tab in the
     * background (test/providers/repro-simple-peer-sleep.ts, part 8).
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
 * SimplePeer transport implementation using simple-peer library.
 * Creates direct peer-to-peer connections for data transfer.
 */
export declare class SimplePeerTransport implements Transport {
    private options;
    /** The dial rule of a partial mesh; undefined: full mesh. */
    private _sparse?;
    private _announceRetry?;
    private _passive;
    /** RTCPeerConnections this transport has created - Chrome allows a renderer 500, closed ones included. */
    peerConnectionsCreated: number;
    private _connected;
    private _room;
    private _callback?;
    private _peerConnectCallback?;
    private _peerDisconnectCallback?;
    private peerId;
    private peers;
    private signalingConns;
    private announcedPeers;
    private announceInterval?;
    private _shouldConnect;
    private signalingAttempts;
    private signalingTimers;
    private _stopResumeWatch?;
    /** Signaling sockets handleResume() replaced: their late onclose must not dial again. */
    private _abandonedSockets;
    /** Signaling sockets that have not opened yet (see dialSignalingNow). */
    private _dialingSockets;
    private _stopNetworkWatch?;
    private _resetting;
    /**
     * Create a new SimplePeer transport.
     *
     * @param options - Configuration options (must include peer constructor)
     */
    constructor(options: SimplePeerTransportOptions);
    /**
     * Connect to the room via signaling servers and start discovering peers.
     */
    connect(config: ConnectionConfig): Promise<void>;
    /**
     * The page slept (see watchResume): every link is dead on the other side
     * or about to be, and the room holds dead entries under our peer id that
     * would swallow our announces until their ICE times out. Start over
     * under a new id - no entry anywhere matches it - and with fresh
     * signaling sockets (the old ones may be half-open); their onopen
     * subscribes and announces. GenericProvider resyncs each link as it
     * opens (onPeerConnect).
     */
    private handleResume;
    /**
     * Dial every signaling server we have no open socket to, NOW - not when
     * the backoff says so. The second thing the real phone showed: with the
     * display off for 203 s the socket died in the background, four reconnects
     * failed, and the page woke up with "retry 5 in 5841 ms" pending - the
     * sleep was noticed after 0.16 s, there was no open socket to replace, and
     * nothing happened for six seconds (repro-simple-peer-sleep, part 12). An
     * attempt still in flight is given up with the timers: on a network that
     * was down it hangs until its 10 s timeout. Also called when the browser
     * says the network is back, and when the tab becomes visible again.
     */
    private dialSignalingNow;
    /**
     * ConferenceTransport's hooks (providers/conference): a room of
     * `expectedPeers` that does not fit into a full mesh gets the dial rule,
     * unless the `dial` option has set one already.
     */
    configureSparse(options: {
        dial?: number;
        expectedPeers?: number;
        passive?: boolean;
    }): void;
    setRoomSize(peers: number): void;
    /** Publish our peer id to the room on every open signaling connection. */
    private announce;
    /**
     * Disconnect from all peers and signaling servers.
     */
    disconnect(): void;
    /**
     * Send data to all connected peers.
     * Large messages are automatically chunked to fit within WebRTC DataChannel limits.
     */
    send(data: Uint8Array): void;
    /**
     * Send data to a single peer, chunking if necessary.
     * Uses flow control to avoid overwhelming the WebRTC buffer.
     */
    private sendToPeer;
    /**
     * Send chunks with backpressure handling.
     * Waits for buffer to drain before sending more data.
     */
    private sendChunksWithFlowControl;
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback: (data: Uint8Array, from?: string) => void): () => void;
    /**
     * Transport.sendTo: deliver to one connected peer (the `from` id passed
     * to onMessage), chunked and flow-controlled like a broadcast send.
     */
    sendTo(peerId: string, data: Uint8Array): void;
    /**
     * send() threw on a link simple-peer has reported connected: rebuild it.
     * Logging it and keeping the entry lost the frame for good - and with it
     * the link, in one direction. Seen with 50 real browsers, about one join
     * in six, always on the ANSWERING side of a link (Chrome 151, a busy
     * machine): the RTCDataChannel object says readyState 'connecting' after
     * its own 'open' event - minutes later still - while getStats() calls the
     * channel open and messages arrive on it, and every send() throws
     * "readyState is not 'open'". The first frame lost that way is the one
     * that carries our presence to a new link: that peer never learned us,
     * its roster stayed one short and our edits reached it only through third
     * peers' beacons (test/e2e/room-scenarios.mjs, DIAG=1: "sent 0 rcvd 2";
     * test/providers/repro-simple-peer-sleep.ts, part 7). Dropping the entry
     * reports the link gone and announces, so the pair dials again; the
     * other side sees the close. Only ever our own entry (see removeOwnEntry).
     */
    private dropUnsendable;
    /**
     * Register callback for new peer data-channel connections.
     */
    onPeerConnect(callback: (peerId: string) => void): () => void;
    /** Transport.onPeerDisconnect: a peer's channel closed or errored (removePeer). */
    onPeerDisconnect(callback: (peerId: string) => void): () => void;
    /**
     * Check if connected.
     */
    get isConnected(): boolean;
    /**
     * Get number of connected peers (for debugging).
     */
    get connectedPeers(): number;
    /**
     * Connect to a signaling server.
     */
    private connectSignaling;
    /**
     * Re-open a signaling connection that closed while we should be
     * connected - a phone's OS closes the socket of a backgrounded page, and
     * without it the transport can neither announce nor receive offers
     * (repro-simple-peer-sleep, part 3). Same curve as WebSocketTransport
     * (round 7, item 4): doubling from 1 s, +-50 % jitter, capped at 10 s.
     * onopen subscribes and announces again.
     */
    private scheduleSignalingReconnect;
    /**
     * Handle messages from signaling server.
     */
    private handleSignalingMessage;
    /**
     * Send message to signaling server.
     */
    private sendSignaling;
    /**
     * Broadcast message to all signaling servers.
     */
    private broadcastSignaling;
    /**
     * Create a WebRTC peer connection.
     */
    private createPeerConnection;
    /**
     * Handle WebRTC signal from peer.
     */
    private handlePeerSignal;
    /**
     * Remove and cleanup a peer connection.
     */
    private removePeer;
    /**
     * Generate a unique peer ID.
     */
    private generatePeerId;
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