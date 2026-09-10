import type { Transport, ConnectionConfig } from '../../transport';
/**
 * WebSocket transport configuration
 */
export interface WebSocketConfig extends ConnectionConfig {
    /** WebSocket server URL (required) e.g., 'ws://localhost:1234' or 'wss://example.com' */
    serverUrl: string;
    /** Enable automatic reconnection on disconnect (default: true) */
    autoReconnect?: boolean;
    /**
     * Delay before the first reconnection attempt in milliseconds (default:
     * 2000). Doubles per failed attempt, jittered by ±50 %, capped at
     * `maxReconnectDelay` - a classroom of 30 browsers used to hit a
     * restarting relay 15 times a second in lockstep and come back in the
     * same instant (round 7, item 4; test/dummy/bench-ws-reconnect-storm.ts).
     */
    reconnectDelay?: number;
    /** Cap on the reconnection delay in milliseconds (default: 10000) */
    maxReconnectDelay?: number;
    /** Maximum reconnection attempts (0 = infinite, default: 0) */
    maxReconnectAttempts?: number;
    /** WebSocket protocols (optional) */
    protocols?: string | string[];
    /** Enable debug logging */
    debug?: boolean;
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
    get isConnected(): boolean;
    /**
     * Connect to WebSocket server
     */
    connect(config: WebSocketConfig): Promise<void>;
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
     * Attempt to reconnect
     */
    private attemptReconnect;
    /**
     * Debug logging
     */
    private log;
}
//# sourceMappingURL=index.d.ts.map