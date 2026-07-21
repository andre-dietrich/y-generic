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