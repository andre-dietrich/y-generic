import type { Transport, ConnectionConfig } from '../../transport';
/**
 * PubNub transport configuration
 */
export interface PubNubConfig extends ConnectionConfig {
    /** PubNub publish key (required) */
    publishKey: string;
    /** PubNub subscribe key (required) */
    subscribeKey: string;
    /** Optional cipher key for message encryption */
    cipherKey?: string;
    /** Store messages in history (default: false) */
    storeInHistory?: boolean;
    /** Enable debug logging */
    debug?: boolean;
}
/**
 * PubNub Transport for Yjs
 *
 * Provides real-time synchronization using PubNub's pub/sub infrastructure.
 *
 * Features:
 * - Global cloud infrastructure with low latency
 * - Built-in presence tracking
 * - Optional message encryption
 * - Optional message persistence
 * - Reliable message delivery
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { PubNubTransport } from 'y-generic/providers/pubnub'
 *
 * const doc = new Y.Doc()
 * const transport = new PubNubTransport({
 *   publishKey: 'pub-c-xxx',
 *   subscribeKey: 'sub-c-xxx',
 *   room: 'my-room',
 *   password: 'optional-encryption-key'
 * })
 *
 * const provider = new GenericProvider(doc, transport)
 * ```
 */
export declare class PubNubTransport implements Transport {
    private pubnub;
    private channel;
    private uuid;
    private messageCallback?;
    private _isConnected;
    private config;
    private debug;
    private messageBuffer;
    private chunkBuffer;
    private readonly MAX_MESSAGE_SIZE;
    get isConnected(): boolean;
    /**
     * Connect to PubNub channel
     */
    connect(config: PubNubConfig): Promise<void>;
    /**
     * Disconnect from PubNub
     */
    disconnect(): void;
    /**
     * Send data to all peers
     */
    send(data: Uint8Array): void;
    /**
     * Send large message in chunks
     */
    private sendChunked;
    /**
     * Handle incoming chunked message
     */
    private handleChunkedMessage;
    /**
     * Register message callback
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Get presence information (list of peers)
     */
    getPresence(): Promise<string[]>;
    /**
     * Convert Uint8Array to base64 string
     *
     * Handles large arrays by processing in chunks to avoid
     * "too many function arguments" error with String.fromCharCode
     */
    private uint8ToBase64;
    /**
     * Convert base64 string to Uint8Array
     */
    private base64ToUint8;
    /**
     * Generate a unique UUID
     */
    private generateUUID;
    /**
     * Debug logging
     */
    private log;
}
//# sourceMappingURL=index.d.ts.map