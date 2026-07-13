/**
 * Minimal transport interface that any backend must implement.
 * The transport is responsible ONLY for sending/receiving binary data.
 * How it does this (WebSocket, WebRTC, PubNub, IndexedDB, etc.) is up to the implementation.
 */
export interface Transport {
    /**
     * Connect to the backend with the given configuration.
     * The config object can contain any backend-specific parameters.
     *
     * @param config - Backend-specific connection configuration
     * @returns Promise that resolves when connected
     */
    connect(config: ConnectionConfig): Promise<void>;
    /**
     * Disconnect from the backend.
     * Should clean up connections but allow reconnection.
     */
    disconnect(): void;
    /**
     * Send binary data to the backend.
     * Can be sync or async depending on the transport.
     *
     * @param data - Binary data to send (Yjs updates or awareness)
     */
    send(data: Uint8Array): void | Promise<void>;
    /**
     * Optional: send binary data to a single peer instead of broadcasting.
     * Only transports with a peer concept (e.g. WebRTC) can implement this.
     * When absent, the provider falls back to broadcast-and-filter.
     *
     * @param peerId - Target peer's ID
     * @param data - Binary data to send
     */
    sendTo?(peerId: string, data: Uint8Array): void | Promise<void>;
    /**
     * Register a callback for incoming binary data.
     * The transport calls this callback whenever data is received.
     *
     * @param callback - Function to call with received data
     * @returns Cleanup function to unregister the callback
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Optional: register a callback that fires whenever a new peer data channel
     * opens. The provider uses this to push its local state to the new peer
     * immediately (syncNow), which is required for correct P2P reconnect sync.
     *
     * @param callback - Function to call with the new peer's ID
     * @returns Cleanup function to unregister the callback
     */
    onPeerConnect?(callback: (peerId: string) => void): () => void;
    /**
     * Optional: register a callback that fires when a connected peer disconnects
     * (channel close or error). Consumers use this for presence/leave tracking.
     *
     * @param callback - Function to call with the departed peer's ID
     * @returns Cleanup function to unregister the callback
     */
    onPeerDisconnect?(callback: (peerId: string) => void): () => void;
    /**
     * Optional: per-peer control side-channel that bypasses the provider pipe.
     * For consumer-defined out-of-band exchanges (identity/auth handshakes) that
     * must not be CRC-verified or decoded as Yjs/pubsub data. Only transports
     * with a peer concept implement these.
     *
     * @param peerId - Target peer's ID
     * @param payload - Small binary payload (not chunked/encrypted by the transport)
     */
    sendControl?(peerId: string, payload: Uint8Array): void;
    /**
     * Optional: tear down a single peer connection (e.g. reject a peer that
     * failed an out-of-band handshake). Only transports with a peer concept
     * implement this.
     *
     * @param peerId - Peer to disconnect
     */
    disconnectPeer?(peerId: string): void;
    /**
     * Optional: register a callback for incoming control frames.
     *
     * @param callback - Function called with (senderPeerId, payload)
     * @returns Cleanup function to unregister the callback
     */
    onControlFrame?(callback: (peerId: string, payload: Uint8Array) => void): () => void;
    /**
     * Check if the transport is currently connected.
     */
    readonly isConnected: boolean;
}
/**
 * Connection configuration passed to transport.connect()
 * Can be extended with any backend-specific properties.
 */
export interface ConnectionConfig {
    /** Room/channel identifier for grouping clients */
    room: string;
    /** Optional password for encrypted communication */
    password?: string;
    /** Any other backend-specific configuration */
    [key: string]: any;
}
/**
 * Connection status emitted by the provider
 */
export type ConnectionStatus = {
    state: 'disconnected';
} | {
    state: 'connecting';
} | {
    state: 'connected';
} | {
    state: 'error';
    error: Error;
};
//# sourceMappingURL=transport.d.ts.map