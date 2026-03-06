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
     * Maximum number of peer connections.
     * @default 20 + random(0-15)
     */
    maxConns?: number;
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
    /**
     * Create a new PeerJS transport.
     *
     * @param options - Configuration options (must include peer constructor)
     */
    constructor(options: PeerJSTransportOptions);
    /**
     * Connect to the room and start discovering peers.
     */
    connect(config: ConnectionConfig): Promise<void>;
    /**
     * Create a regular (non-coordinator) peer and connect to coordinator.
     */
    private createRegularPeer;
    /**
     * Disconnect from all peers and cleanup.
     */
    disconnect(): void;
    /**
     * Register callback for new peer data-channel connections.
     */
    onPeerConnect(callback: (peerId: string) => void): () => void;
    /**
     * Send data to all connected peers.
     */
    send(data: Uint8Array): void;
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
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
     * Become the coordinator for this room.
     */
    private becomeCoordinator;
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
     * Transition from regular peer to coordinator by reconnecting with coordinator ID.
     */
    private transitionToCoordinator;
    /**
     * Recreate the local peer with a fresh random ID and reconnect to the
     * coordinator (whoever won the election while we were transitioning).
     * Called when transitionToCoordinator() fails.
     */
    private reestablishAsRegularPeer;
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