/**
 * GunDB Transport Provider
 *
 * Decentralized peer-to-peer transport using GunDB graph database.
 * GunDB provides automatic conflict resolution and offline-first sync.
 *
 * Features:
 * - Decentralized P2P architecture
 * - Automatic conflict resolution (CRDT)
 * - Offline-first with auto-sync
 * - Real-time updates via .on()
 * - Optional relay servers
 * - Graph-based data structure
 * - Password-protected rooms with AES encryption (via SEA)
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { GunTransport } from 'y-generic/providers/gun'
 * import Gun from 'gun'
 *
 * const doc = new Y.Doc()
 * const transport = new GunTransport({
 *   gun: Gun, // Pass the Gun constructor
 *   peers: ['https://gun-relay.herokuapp.com/gun']
 * })
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 * ```
 *
 * @example Password-protected room
 * ```typescript
 * import Gun from 'gun'
 * import 'gun/sea'  // Required for encryption
 *
 * const transport = new GunTransport({
 *   gun: Gun,
 *   sea: Gun.SEA,  // Provide SEA module
 *   password: 'my-secret-room-password',
 *   peers: ['https://gun-relay.herokuapp.com/gun']
 * })
 * ```
 */
import * as Y from 'yjs';
import type { Transport, ConnectionConfig } from '../../transport';
/**
 * Gun constructor type (from gun library).
 */
export type GunConstructor = any;
/**
 * Configuration options for Gun transport.
 */
export interface GunTransportOptions {
    /**
     * The Gun library constructor.
     * Users must provide this to avoid bundling the library.
     * @example
     * ```typescript
     * import Gun from 'gun'
     * const transport = new GunTransport({ gun: Gun })
     * ```
     */
    gun: GunConstructor;
    /**
     * Array of peer relay servers to connect to.
     * Gun will attempt to sync with these peers and any peers they know about.
     * @default [] (local only)
     * @example ['https://gun-relay.herokuapp.com/gun']
     */
    peers?: string[];
    /**
     * Gun configuration options.
     * @see https://gun.eco/docs/API
     */
    gunOptions?: {
        localStorage?: boolean;
        radisk?: boolean;
        axe?: boolean;
        [key: string]: any;
    };
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
    /**
     * Update batch interval in milliseconds.
     * Uses debouncing - timer resets on each update.
     * Only sends after this period of inactivity.
     * @default 100
     */
    batchInterval?: number;
    /**
     * Password for room encryption.
     * When set, all data is encrypted with AES using Gun's SEA module.
     * All peers in the room must use the same password.
     * Requires the SEA module to be provided.
     * @default undefined (no encryption)
     * @example 'my-secret-password'
     */
    password?: string;
    /**
     * Gun SEA (Security, Encryption, Authorization) module.
     * Required when using password encryption.
     * @example
     * ```typescript
     * import Gun from 'gun'
     * import 'gun/sea'
     * const SEA = Gun.SEA
     * const transport = new GunTransport({ gun: Gun, sea: SEA, password: 'secret' })
     * ```
     */
    sea?: any;
}
/**
 * Extended connection config with optional persistence settings.
 */
export interface GunConnectionConfig extends ConnectionConfig {
    /**
     * When true, a full Y.Doc snapshot is saved to Gun on every debounced
     * update and loaded back when peers reconnect after all going offline.
     * When false (default), any previously stored snapshot is cleared on
     * connect so new sessions start from a blank state.
     * @default false
     */
    persistent?: boolean;
    /**
     * The Y.Doc to snapshot. Required when persistent is true.
     */
    doc?: Y.Doc;
    /**
     * Debounce delay in ms before writing the snapshot to Gun.
     * @default 2000
     */
    persistDebounceMs?: number;
}
/**
 * GunDB transport implementation.
 * Creates decentralized P2P connections using Gun graph database.
 *
 * Note: deliberately does NOT set `preferredBatchMs` on the Transport
 * interface. send() already debounces internally via `batchInterval`
 * (see flushBatch()) — an additional GenericProvider-level batch delay
 * would just stack a second debounce in front of this one for no benefit.
 */
export declare class GunTransport implements Transport {
    readonly expectedRttMs = 500;
    private options;
    private _connected;
    private _room;
    private _callback?;
    private gun;
    private roomNode;
    private updateListener;
    private lastUpdateTime;
    private updateBatch;
    private batchTimeout?;
    private processedUpdates;
    private throttleTimeout?;
    private pendingUpdates;
    private updateSlot;
    private readonly BUFFER_SIZE;
    private awarenessListener;
    private lastAwarenessId;
    private ownAwarenessId;
    private encryptionEnabled;
    private persistentMode;
    private persistDoc;
    private persistDebounceMs;
    private persistTimer?;
    private isWritingToGun;
    private savePending;
    /** Data loaded from Gun snapshot before onMessage callback is registered */
    private pendingLoad;
    /** True once loadSnapshot()'s initial Gun read has completed */
    private snapshotLoaded;
    /**
     * Create a new Gun transport.
     *
     * @param options - Configuration options (must include gun constructor)
     */
    constructor(options: GunTransportOptions);
    /**
     * Connect to the room and start syncing.
     */
    connect(config: GunConnectionConfig): Promise<void>;
    /**
     * Setup listener for Gun updates.
     */
    private setupUpdateListener;
    /**
     * Process all pending updates at once.
     */
    private processPendingUpdates;
    /**
     * Disconnect from Gun and cleanup.
     */
    disconnect(): void;
    /**
     * Send data to all peers via Gun.
     * Routes awareness to a separate volatile node, doc sync to circular buffer.
     * Uses debouncing for doc sync - each new update resets the timer.
     */
    send(data: Uint8Array): void;
    /**
     * Peek at the message type from CRC32-wrapped data.
     * Format: [CRC32 (4 bytes)][message type (varint)]...
     * Returns -1 if cannot determine type.
     */
    private peekMessageType;
    /**
     * Send awareness update to a per-client slot under the awareness node.
     * Awareness is ephemeral - only the latest state per client matters.
     * Each client writes to its own slot (keyed by a stable per-connection id)
     * so peers never overwrite each other's presence data.
     */
    private sendAwareness;
    /**
     * Setup listener for awareness updates (separate from doc sync).
     * Uses .map() so every existing per-client slot is replayed on subscribe
     * (late joiners learn about already-present peers), not just the most
     * recently written one.
     */
    private setupAwarenessListener;
    /**
     * Frame a list of independently-wrapped envelopes with 4-byte big-endian
     * length prefixes so they can be split back apart after transmission as
     * one combined Gun record. See unframeUpdates() for the inverse.
     */
    private frameUpdates;
    /**
     * Split a buffer produced by frameUpdates() back into the individual
     * envelopes it contains. Malformed/truncated framing stops early rather
     * than throwing, since a partial batch is still recoverable via periodic
     * sync / hash verification.
     */
    private unframeUpdates;
    /**
     * Flush batched updates to Gun.
     * Called after debounce period (no new updates for batchInterval ms).
     */
    private flushBatch;
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Check if connected.
     */
    get isConnected(): boolean;
    /**
     * Generate a circular buffer slot ID.
     * Uses only BUFFER_SIZE slots to prevent infinite accumulation.
     */
    private generateUpdateId;
    /**
     * Schedule a debounced snapshot write. Called on every doc update.
     * Always saves the latest full state, never an individual delta.
     */
    private queuePersist;
    /**
     * Encode the full Y.Doc state as a proper y-protocols SYNC_STEP_2 message
     * and write it to the Gun `snapshot` node.
     * Using SYNC_STEP_2 format ensures GenericProvider interprets it correctly.
     */
    private saveSnapshot;
    /**
     * Load the snapshot from Gun and deliver it to the message callback.
     * Uses a pendingLoad buffer in case the callback isn't registered yet.
     */
    private loadSnapshot;
    /**
     * Convert Uint8Array to base64 string.
     */
    private uint8ArrayToBase64;
    /**
     * Convert base64 string to Uint8Array.
     */
    private base64ToUint8Array;
    /**
     * Encrypt data using SEA with the configured password.
     */
    private encrypt;
    /**
     * Decrypt data using SEA with the configured password.
     * Returns null if decryption fails (wrong password).
     */
    private decrypt;
    /**
     * Log debug messages if enabled.
     */
    private log;
}
//# sourceMappingURL=index.d.ts.map