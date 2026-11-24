import type { Transport, ConnectionConfig } from '../../transport';
export interface WebSocketConfig extends ConnectionConfig {
    /** e.g. 'wss://example.com'; the room is appended as a path segment. */
    serverUrl: string;
    /** @default true */
    autoReconnect?: boolean;
    /** ms between attempts. @default 2000 */
    reconnectDelay?: number;
    /** 0 = unlimited. @default 0 */
    maxReconnectAttempts?: number;
    protocols?: string | string[];
    debug?: boolean;
    /**
     * Reconnect after this many ms without a received message (half-open
     * socket), like y-websocket's client. 0 disables. @default 30000
     */
    messageTimeout?: number;
}
/**
 * WebSocket transport, URL layout compatible with y-websocket servers.
 *
 * @example
 * ```ts
 * const provider = new GenericProvider(doc, new WebSocketTransport())
 * await provider.connect({ serverUrl: 'wss://example.com', room: 'my-room' })
 * ```
 */
export declare class WebSocketTransport implements Transport {
    /** The server relays every frame to all clients in the room. */
    readonly reachesAllPeers = true;
    private ws;
    private config;
    private messageCallback?;
    private _isConnected;
    private debug;
    private reconnectAttempts;
    private reconnectTimer?;
    private intentionalDisconnect;
    private messageQueue;
    private receivedBuffer;
    private lastMessageAt;
    private livenessTimer?;
    private wsUrl;
    private pendingConnect?;
    get isConnected(): boolean;
    /**
     * Resolves once a socket is open. With `autoReconnect`, failed attempts
     * are retried instead of rejecting; it rejects only when retrying is off
     * or exhausted, or disconnect() is called first.
     */
    connect(config: WebSocketConfig): Promise<void>;
    private settleConnect;
    private get autoReconnect();
    /** One connection attempt; on failure, retries or rejects connect(). */
    private openSocket;
    /** A socket that never opened: retry, or give up and reject connect(). */
    private connectFailed;
    disconnect(): void;
    /** Send now, or queue until the socket opens. */
    send(data: Uint8Array): void;
    onMessage(callback: (data: Uint8Array) => void): () => void;
    private handleMessage;
    private flushMessageQueue;
    /**
     * Reconnect a socket that stays OPEN but receives nothing (dead TCP path,
     * NAT or proxy timeout); the browser may not fire onclose for minutes.
     */
    private startLivenessCheck;
    private stopLivenessCheck;
    /** Schedule the next attempt; false once `maxReconnectAttempts` is used up. */
    private attemptReconnect;
    private log;
}
//# sourceMappingURL=index.d.ts.map