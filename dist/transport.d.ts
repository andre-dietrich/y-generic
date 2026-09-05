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
     * Register a callback for incoming binary data.
     * The transport calls this callback whenever data is received.
     *
     * @param callback - Function to call with received data. Transports that
     * know which peer a message came from pass that peer's address as the
     * second argument (the same id `sendTo` accepts); relays that only see a
     * room call it with the data alone. GenericProvider remembers the address
     * per remote clientID and, when `sendTo` exists, answers that peer's
     * requests directly instead of broadcasting the reply to the room.
     * @returns Cleanup function to unregister the callback
     */
    onMessage(callback: (data: Uint8Array, from?: string) => void): () => void;
    /**
     * Optional: send binary data to ONE peer, identified by the address the
     * transport passed as `from` to the onMessage callback. Mesh transports
     * (peerjs, simple-peer, trystero) implement this with the peer's data
     * channel; relays leave it undefined and every reply stays a broadcast,
     * exactly as before this method existed. When present, SyncStep2 replies,
     * acks and presence responses to a join go to the requester only: N-1
     * deliveries per request become 1.
     */
    sendTo?(peerId: string, data: Uint8Array): void | Promise<void>;
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
     * Check if the transport is currently connected.
     */
    readonly isConnected: boolean;
    /**
     * Optional hint: recommended `batchUpdates` delay (ms) for this transport,
     * used as GenericProvider's default when the caller doesn't explicitly
     * pass `batchUpdates`. Transports with a high per-message round-trip cost
     * (HTTP polling, internally-debounced relays) should set this so rapid
     * edits collapse into fewer round trips by default. Low-latency push
     * transports (WebSocket, PubNub, Supabase, connected WebRTC) should leave
     * this undefined — for those, batching only adds a fixed delay floor
     * without reducing round trips that were already cheap.
     */
    readonly preferredBatchMs?: number;
    /**
     * Optional hint: the round-trip time class (ms) this transport expects -
     * e.g. ~700 for a Matrix homeserver long-poll, ~500 for a Gun relay
     * mesh, undefined for low-latency push transports. GenericProvider uses
     * it to seed its round-trip estimate before the first measured sample
     * arrives, so the first response wait after a join and the first reply
     * suppression window already fit the transport instead of the
     * low-latency defaults (measured before this hint: on a 350 ms profile a
     * 100-peer join burst spent most of its traffic on retries fired before
     * the first replies could have arrived). Replaced by measured samples as
     * soon as they exist.
     */
    readonly expectedRttMs?: number;
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