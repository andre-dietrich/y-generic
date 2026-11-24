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
     * @default ['wss://signaling.yjs.dev']
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
     * Maximum number of WebRTC peer connections.
     * Too many connections can overwhelm the browser.
     * @default 20 + random(0-15)
     */
    maxConns?: number;
    /**
     * Options passed to simple-peer.
     * See https://github.com/feross/simple-peer#api
     * Note: iceServers will be merged into peerOpts.config if not already present
     * @default {}
     */
    peerOpts?: Record<string, any>;
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
    /**
     * Drop and reconnect a signaling socket that has received nothing for this
     * long (ms). A ping is sent at half this interval. Catches half-open sockets
     * that still report OPEN but deliver nothing. 0 disables.
     * @default 30000
     */
    signalingTimeout?: number;
    /**
     * How long (ms) the initiator gives a peer connection to open its channel
     * before tearing it down and offering again. Doubles after each consecutive
     * failure with the same peer, up to 30s, so a slow (e.g. TURN-only) network
     * is not torn down forever. See CONNECT_TIMEOUT_MAX.
     * @default 5000
     */
    connectTimeout?: number;
    /**
     * After this many consecutive timed-out attempts to a peer, the initiator
     * retries with `iceTransportPolicy: 'relay'`, so the connection runs via
     * TURN. A stall that repeats for a pair (e.g. peers behind one NAT whose
     * mDNS host candidates don't resolve) never clears on a direct retry; a
     * relay-only connection has no direct pair to get stuck on. Only used when
     * a `turn:`/`turns:` server is configured. `false` disables it.
     * @default 1
     */
    relayFallbackAfter?: number | false;
    /**
     * Hold data frames from each peer until `trustPeer(peerId)` is called, e.g.
     * after an out-of-band identity handshake over control frames. Held frames
     * are delivered in order on trust and discarded if the peer disconnects
     * first. Control frames are never held. Each new connection to a peer
     * starts untrusted.
     * @default false
     */
    requireTrust?: boolean;
}
/**
 * SimplePeer transport implementation using simple-peer library.
 * Creates direct peer-to-peer connections for data transfer.
 */
export declare class SimplePeerTransport implements Transport {
    private options;
    private _connected;
    private _room;
    private _callback?;
    private _peerConnectCallbacks;
    private _peerDisconnectCallbacks;
    private _controlCallbacks;
    private peerId;
    private peers;
    private signalingConns;
    private announcedPeers;
    private announceInterval?;
    private _reconnectAttempts;
    private _reconnectTimers;
    private _signalingLiveness;
    private _livenessInterval?;
    private _peerLastSeen;
    private _connectFailures;
    private _hasTurnServer;
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
     * Disconnect from all peers and signaling servers.
     */
    disconnect(): void;
    /**
     * Send data to all connected peers.
     * Large messages are automatically chunked to fit within WebRTC DataChannel limits.
     */
    send(data: Uint8Array): void;
    /**
     * Send data to a single connected peer by ID (targeted delivery).
     */
    sendTo(peerId: string, data: Uint8Array): void;
    /**
     * Queue data for a single peer, chunking if necessary, and send as much as
     * the channel buffer allows.
     */
    private sendToPeer;
    /**
     * Send queued frames until the queue is empty or the channel buffer is
     * full; in the latter case resume when the buffer drains. One wait per
     * peer at a time (`drainWait`), so concurrent large messages can't strand
     * each other. It listens with addEventListener: simple-peer sets the
     * channel's onbufferedamountlow property itself, so a check for that
     * property being free never passed and the queue stalled until the next
     * send. DRAIN_POLL_MS covers a drain event that doesn't fire.
     */
    private pumpSendQueue;
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Register callback for new peer data-channel connections.
     */
    onPeerConnect(callback: (peerId: string) => void): () => void;
    /**
     * Register callback for peer disconnects (channel close or error). Only fires
     * for peers that had reached the connected state.
     */
    onPeerDisconnect(callback: (peerId: string) => void): () => void;
    /**
     * Register callback for consumer control frames (MSG_TYPE_CONTROL).
     * These bypass the provider pipe — use for per-peer handshakes/auth.
     */
    onControlFrame(callback: (peerId: string, payload: Uint8Array) => void): () => void;
    /**
     * Tear down a single peer connection (e.g. to reject a peer that failed an
     * out-of-band handshake). Fires onPeerDisconnect if the peer was connected.
     */
    disconnectPeer(peerId: string): void;
    /**
     * Send a control frame to a single peer. Not chunked or encrypted — keep
     * payloads small (they must fit one DataChannel message).
     */
    sendControl(peerId: string, payload: Uint8Array): void;
    /**
     * Mark the current connection to a peer as trusted and deliver the data
     * frames held for it (see `requireTrust`). Returns false if there is no
     * connection to that peer.
     */
    trustPeer(peerId: string): boolean;
    /** Whether trustPeer() was called for the current connection to a peer. */
    isPeerTrusted(peerId: string): boolean;
    /** This transport's peer id, as remote peers and signaling see it. */
    get localPeerId(): string;
    /**
     * DTLS certificate fingerprints of a peer connection, from the local and
     * remote session descriptions (`a=fingerprint:` lines, e.g.
     * "sha-256 AB:CD:…"). A field is undefined until that description is set.
     * Returns undefined if there is no connection to the peer.
     */
    getPeerFingerprints(peerId: string): {
        local?: string;
        remote?: string;
    } | undefined;
    /**
     * True while this looks like a complete mesh: every peer seen via signaling
     * recently is connected to us, and the room is small enough that every peer
     * can connect to every other (see FULL_MESH_MAX_PEERS). Otherwise the
     * provider relays remote awareness so presence crosses the gaps.
     */
    get reachesAllPeers(): boolean;
    /**
     * Check if connected.
     *
     * NOTE: this is a lifecycle flag (connect() called, disconnect() not yet), not
     * a health check — it stays true with zero signaling servers, which is what
     * makes BroadcastChannel-only mode work. For "can we still discover peers?"
     * use `signalingHealth`.
     */
    get isConnected(): boolean;
    /**
     * Get number of connected peers (for debugging).
     */
    get connectedPeers(): number;
    /**
     * Signaling/discovery health, for diagnostics and monitoring.
     *
     * `isConnected` deliberately cannot express this: a transport whose signaling
     * sockets have all dropped still reports connected, and peer discovery is
     * silently dead until they come back.
     */
    get signalingHealth(): {
        open: number;
        configured: number;
        reconnecting: number;
        peers: number;
        connectedPeers: number;
    };
    /**
     * Reconnect to a signaling server after it drops, with exponential backoff.
     *
     * Mirrors lib0's WebsocketClient (what y-webrtc gets for free): delay grows
     * as log10(attempts + 1) * 1200ms, capped at 30s. No-ops after an explicit
     * disconnect(), and never stacks duplicate timers for the same URL.
     */
    private scheduleSignalingReconnect;
    /**
     * Forget a signaling socket and schedule its reconnect. Without the
     * reconnect, a single socket drop is terminal: the re-announce loop is gated
     * on `signalingConns.length > 0`, so peer discovery stops forever while
     * `isConnected` still reports true.
     */
    private dropSignaling;
    /**
     * Ping signaling sockets that went quiet, and drop the ones that stayed
     * silent past `signalingTimeout`. A half-open socket (dead TCP path, NAT or
     * proxy idle timeout) keeps reporting OPEN and may not fire onclose for many
     * minutes, during which we are invisible to new peers. Healthy sockets see
     * traffic every 5s anyway (our own re-announce is echoed by the server).
     */
    private checkSignalingLiveness;
    /**
     * Connect to a signaling server.
     */
    private connectSignaling;
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
    private pruneStalePeer;
    private forgetGonePeers;
    /** Hand a data frame to the provider, or hold it until the peer is trusted. */
    private deliver;
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