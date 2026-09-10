/**
 * IndexedDB Transport Provider
 *
 * Persistent local storage transport using browser's IndexedDB.
 * Unlike P2P transports, this provider stores document updates locally
 * for persistence across browser sessions.
 *
 * Features:
 * - Persists the document's updates as they happen - and nothing else: the
 *   provider's presence, beacons and requests are not stored (round 7,
 *   item 6: stored and replayed, they resurrected the previous session as a
 *   phantom peer and cost ~10x the bytes)
 * - Loads the stored updates as one merged update and trims the log to
 *   that one row (every load appends a full-document push otherwise)
 * - Lossless compaction (merge), on by default
 * - Works offline (no network required)
 * - Supports multiple documents/rooms
 * - Pairs with a network provider on the same document through
 *   `connect({ waitFor })` (see ConnectionConfig.waitFor)
 * - Not for a provider with `compressionThresholdBytes` set: the frame
 *   parser expects the plain CRC-wrapped frame
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
 * // Compact (merge the rows into one) every 100 updates instead of 500
 * const transport = new IndexedDBTransport({ compactThreshold: 100 })
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
     * Compact (merge every row into one) when the row count reaches this
     * threshold; 0 = use `maxUpdates`.
     * @default 0
     */
    compactThreshold?: number;
    /**
     * Compact automatically at the threshold. Lossless since round 7 (it used
     * to delete the oldest 90 % of rows - the document), hence on by default.
     * @default true
     */
    autoCompact?: boolean;
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
    /**
     * Row count at which auto-compaction runs when `compactThreshold` is 0.
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
     * Store what the frame carries of the document - one row per frame that
     * carries anything. Presence, beacons and requests are the provider's
     * conversation with the room, and this transport is not the room: stored
     * and replayed on the next load they resurrected the previous session's
     * clientID as a phantom peer and were answered into the store again
     * (round 7, item 6; test/dummy/bench-persist-log.ts).
     */
    send(data: Uint8Array): void;
    /**
     * Register callback for incoming messages (loaded updates).
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Load the stored document: every row merged into one update, handed to
     * the provider as one SyncStep2 (`frameDocUpdate`: applied, `synced`
     * fires, nothing is sent back) and written back as that one row. Every
     * page load appends a full-document push (GenericProvider's connect), so
     * without the trim the log grew by one document per load - y-indexeddb
     * trims the same way at its PREFERRED_TRIM_SIZE.
     */
    private loadUpdates;
    /**
     * The stored document as one update: every row read, merged and - when
     * there was more than one, or one in the pre-round-7 frame format -
     * written back as one row, all in one readwrite transaction (a
     * concurrent send() queues behind it, so nothing added meanwhile can be
     * cleared away). Rows that carry no document state (old presence or
     * beacon frames) are dropped. Null for an empty store. Shared by
     * loadUpdates() and compact().
     */
    private mergeStore;
    /**
     * Check if compaction should be triggered.
     */
    private shouldCompact;
    /**
     * Merge every stored row into one. Lossless - it used to delete the
     * oldest 90 % of rows, i.e. the document (round 7, item 6).
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