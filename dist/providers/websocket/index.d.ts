import type { Transport, ConnectionConfig } from '../../transport';
/**
 * WebSocket transport configuration
 */
export interface WebSocketConfig extends ConnectionConfig {
    /** WebSocket server URL (required) e.g., 'ws://localhost:1234' or 'wss://example.com' */
    serverUrl: string;
    /** Enable automatic reconnection on disconnect (default: true) */
    autoReconnect?: boolean;
    /** Reconnection delay in milliseconds (default: 2000) */
    reconnectDelay?: number;
    /** Maximum reconnection attempts (0 = infinite, default: 0) */
    maxReconnectAttempts?: number;
    /** WebSocket protocols (optional) */
    protocols?: string | string[];
    /** Enable debug logging */
    debug?: boolean;
    /**
     * Drop and reconnect when nothing has been received for this long (ms).
     * Catches half-open sockets that still report OPEN but deliver nothing.
     * Same rule as y-websocket's client; relies on regular server traffic
     * (GenericProvider's periodic sync and awareness renewals). 0 disables.
     * (default: 30000)
     */
    messageTimeout?: number;
}
/**
 * WebSocket Transport for Yjs
 *
 * Provides real-time synchronization using WebSocket connections.
 *
 * Features:
 * - Direct WebSocket connection to server
 * - Room-based collaboration
 * - Automatic reconnection
 * - Binary message support
 * - Low latency real-time sync
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { WebSocketTransport } from 'y-generic/providers/websocket'
 *
 * const doc = new Y.Doc()
 * const transport = new WebSocketTransport()
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   serverUrl: 'ws://localhost:1234',
 *   room: 'my-room'
 * })
 * ```
 */
export declare class WebSocketTransport implements Transport {
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
     * Connect to WebSocket server.
     *
     * Resolves once a socket is open. With `autoReconnect` on (the default), a
     * failed or timed-out attempt does not reject: the transport keeps retrying
     * and the promise resolves when one succeeds. It rejects when
     * `autoReconnect` is off, when `maxReconnectAttempts` runs out, or when
     * disconnect() is called first.
     */
    connect(config: WebSocketConfig): Promise<void>;
    private settleConnect;
    private get autoReconnect();
    /** One connection attempt; on failure, retries or rejects connect(). */
    private openSocket;
    /** A socket that never opened: retry, or give up and reject connect(). */
    private connectFailed;
    /**
     * Disconnect from WebSocket server
     */
    disconnect(): void;
    /**
     * Send data to server
     */
    send(data: Uint8Array): void;
    /**
     * Register message callback
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Handle incoming WebSocket message
     */
    private handleMessage;
    /**
     * Flush queued messages
     */
    private flushMessageQueue;
    /**
     * Watch for a socket that stays OPEN but receives nothing (half-open: dead
     * TCP path, NAT or proxy idle timeout). The browser may not fire onclose for
     * many minutes; meanwhile sends vanish and nothing arrives.
     */
    private startLivenessCheck;
    private stopLivenessCheck;
    /**
     * Schedule the next connection attempt. Returns false when
     * `maxReconnectAttempts` is used up.
     */
    private attemptReconnect;
    /**
     * Debug logging
     */
    private log;
}
//# sourceMappingURL=index.d.ts.map