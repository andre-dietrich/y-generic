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
    private _everOpened;
    private _peerConnectCallback?;
    private reconnectTimer?;
    private _stopPageWatch?;
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
    /**
     * Transport.onPeerConnect: fires when the socket to the server re-opens
     * after a drop (never for the first connect - connect()'s own syncNow()
     * covers that). Without it the provider never learned of a reconnect:
     * the server had removed our presence with the old socket, and the room
     * listed us again only with our next presence renewal, up to a lease
     * later (test/dummy/e2e-edrys-ws.ts, check 4).
     */
    onPeerConnect(callback: (peerId: string) => void): () => void;
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
     * The socket is gone and the page has its network again: connect now. A
     * real phone (Chrome on Android, display on, WiFi off for a minute and on
     * again - test/e2e/phone-session.mjs websocket): `navigator.connection` said
     * "wifi" at 68.3 s, the socket was connected at 81.2 s. 4.3 s of that an
     * attempt that had started over mobile data and could only time out, 8.6 s
     * the backoff after it. So a retry that is waiting is made at once, an
     * attempt that is in the air is given up (its handlers first, or its close
     * would schedule a retry of its own), and the backoff starts over
     * (test/providers/repro-websocket-wake.ts: 2.3 s and 10.1 s -> a few ms).
     * Nothing to do while the socket is open.
     */
    private reconnectNow;
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