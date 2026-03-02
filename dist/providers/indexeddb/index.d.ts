/**
 * IndexedDB Transport Provider
 *
 * Persistent local storage transport using browser's IndexedDB.
 * Unlike P2P transports, this provider stores document updates locally
 * for persistence across browser sessions.
 *
 * Features:
 * - Automatic persistence of all document updates
 * - Efficient storage and retrieval
 * - Optional compaction to reduce storage size
 * - Works offline (no network required)
 * - Automatic cleanup of old updates
 * - Supports multiple documents/rooms
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { IndexedDBTransport } from 'y-generic/providers/indexeddb'
 *
 * const doc = new Y.Doc()
 * const transport = new IndexedDBTransport()
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-document' })
 *
 * // Updates are automatically persisted to IndexedDB
 * doc.getText('content').insert(0, 'Hello, World!')
 *
 * // On next page load, updates are automatically restored
 * ```
 *
 * @example
 * ```typescript
 * // With automatic compaction every 100 updates
 * const transport = new IndexedDBTransport({
 *   compactThreshold: 100,
 *   autoCompact: true
 * })
 * ```
 */
import type { Transport, ConnectionConfig } from '../../transport';
/**
 * Configuration options for IndexedDB transport.
 */
export interface IndexedDBTransportOptions {
    /**
     * Database name prefix. The actual database name will be `{prefix}-{room}`.
     * @default 'yjs'
     */
    prefix?: string;
    /**
     * Database version. Increment to trigger schema upgrade.
     * @default 1
     */
    version?: number;
    /**
     * Automatically compact storage when update count reaches this threshold.
     * Set to 0 to disable auto-compaction.
     * @default 0 (disabled)
     */
    compactThreshold?: number;
    /**
     * Enable automatic compaction.
     * @default false
     */
    autoCompact?: boolean;
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
    /**
     * Maximum number of updates to store before compaction is required.
     * Prevents unbounded growth of the update log.
     * @default 500
     */
    maxUpdates?: number;
    /**
     * Object store name for storing updates.
     * @default 'updates'
     */
    storeName?: string;
}
/**
 * IndexedDB transport implementation.
 * Provides local persistence for Yjs documents using browser IndexedDB.
 */
export declare class IndexedDBTransport implements Transport {
    private options;
    private db;
    private dbName;
    private _room;
    private messageCallback?;
    private _isConnected;
    private updateCount;
    private isLoading;
    constructor(options?: IndexedDBTransportOptions);
    /**
     * Log debug messages if debug mode is enabled.
     */
    private log;
    /**
     * Check if connected to database.
     */
    get isConnected(): boolean;
    /**
     * Get current room name.
     */
    get room(): string;
    /**
     * Connect to IndexedDB and load existing updates.
     */
    connect(config: ConnectionConfig): Promise<void>;
    /**
     * Open the IndexedDB database.
     */
    private openDatabase;
    /**
     * Disconnect from database.
     */
    disconnect(): void;
    /**
     * Send (store) an update to IndexedDB.
     */
    send(data: Uint8Array): void;
    /**
     * Register callback for incoming messages (loaded updates).
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Load all stored updates from database.
     */
    private loadUpdates;
    /**
     * Check if compaction should be triggered.
     */
    private shouldCompact;
    /**
     * Compact the database by merging updates.
     * This reduces storage size by consolidating the update history.
     */
    compact(): Promise<void>;
    /**
     * Clear all stored updates for the current room.
     */
    clear(): Promise<void>;
    /**
     * Get statistics about stored data.
     */
    getStats(): Promise<{
        updateCount: number;
        databaseName: string;
        storeName: string;
    }>;
    /**
     * Delete the entire database.
     * Warning: This is irreversible!
     */
    static deleteDatabase(room: string, prefix?: string): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map