import type { Transport, ConnectionConfig } from '../../transport';
/**
 * Matrix transport configuration
 */
export interface MatrixConfig extends ConnectionConfig {
    /** Matrix homeserver URL (required) e.g., 'https://matrix.org' */
    homeserverUrl: string;
    /** Access token (optional - if not provided, will register as guest) */
    accessToken?: string;
    /** User ID (optional - required if accessToken is provided) */
    userId?: string;
    /** Device ID (optional) */
    deviceId?: string;
    /** Enable debug logging */
    debug?: boolean;
}
/**
 * Matrix Transport for Yjs
 *
 * Provides real-time synchronization using Matrix protocol.
 *
 * Features:
 * - Decentralized federation
 * - Guest access (no login required)
 * - End-to-end encryption support
 * - Persistent message history
 * - Room-based collaboration
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { MatrixTransport } from 'y-generic/providers/matrix'
 *
 * const doc = new Y.Doc()
 * const transport = new MatrixTransport()
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   homeserverUrl: 'https://matrix.org',
 *   room: '#my-room:matrix.org'
 * })
 * ```
 */
export declare class MatrixTransport implements Transport {
    /**
     * Every send() is its own HTTP PUT request with no internal coalescing —
     * unlike push-style transports, there's no cheaper round trip to lose by
     * batching. Recommends GenericProvider debounce rapid edits by default.
     */
    readonly preferredBatchMs = 150;
    readonly expectedRttMs = 700;
    private config;
    private messageCallback?;
    private _isConnected;
    private debug;
    private accessToken;
    private userId;
    private roomId;
    private syncToken;
    private syncRunning;
    private intentionalDisconnect;
    private txnId;
    private messageQueue;
    private receivedBuffer;
    get isConnected(): boolean;
    /**
     * Connect to Matrix homeserver and join room
     */
    connect(config: MatrixConfig): Promise<void>;
    /**
     * Register as guest on the homeserver
     */
    private registerAsGuest;
    /**
     * Join a Matrix room
     */
    private joinRoom;
    /**
     * Start Matrix sync loop
     */
    private startSync;
    /**
     * Perform one sync request
     */
    private syncOnce;
    /**
     * Disconnect from Matrix
     */
    disconnect(): Promise<void>;
    /**
     * Send Yjs update to Matrix room
     */
    send(data: Uint8Array): void;
    /**
     * Register message callback
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Flush queued messages
     */
    private flushMessageQueue;
    /**
     * Convert Uint8Array to base64 string
     */
    private uint8ToBase64;
    /**
     * Convert base64 string to Uint8Array
     */
    private base64ToUint8;
    /**
     * Log debug messages
     */
    private log;
}
//# sourceMappingURL=index.d.ts.map