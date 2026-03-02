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
 */
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
     * Gun will batch multiple updates within this window.
     * @default 50
     */
    batchInterval?: number;
}
/**
 * GunDB transport implementation.
 * Creates decentralized P2P connections using Gun graph database.
 */
export declare class GunTransport implements Transport {
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
    private connectionTime;
    private throttleTimeout?;
    private pendingUpdates;
    private updateSlot;
    private readonly BUFFER_SIZE;
    /**
     * Create a new Gun transport.
     *
     * @param options - Configuration options (must include gun constructor)
     */
    constructor(options: GunTransportOptions);
    /**
     * Connect to the room and start syncing.
     */
    connect(config: ConnectionConfig): Promise<void>;
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
     */
    send(data: Uint8Array): void;
    /**
     * Flush batched updates to Gun.
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
     * Convert Uint8Array to base64 string.
     */
    private uint8ArrayToBase64;
    /**
     * Convert base64 string to Uint8Array.
     */
    private base64ToUint8Array;
    /**
     * Log debug messages if enabled.
     */
    private log;
}
//# sourceMappingURL=index.d.ts.map