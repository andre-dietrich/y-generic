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
    private _redialTimers;
    private _redialNow;
    private _stopPageWatch?;
    private _peerConnectCallback?;
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
     * Bring a lost relay back. gun 0.2020.1241's browser websocket adapter
     * tries ONCE: wire.onclose calls reconnect(peer) - one attempt, 2 s later -
     * and then mesh.bye(peer), whose handler deletes the peer from opt.peers;
     * when that one attempt fails, reconnect() returns at
     * `if(!opt.peers[peer.url])` and nothing ever dials again. A relay down
     * for more than ~2 s, a page frozen for 20 s (Chrome closes its sockets, and
     * the one attempt runs into the freeze): the peer neither hears nor reaches
     * anybody again, with no error anywhere - 25 browsers after a 5 s relay
     * restart: every roster at 1, editors different
     * (test/e2e/room-scenarios.mjs gun, test/gun/repro-relay-restart.mjs).
     *
     * So on every 'bye' of one of OUR relays: put it back into opt.peers and
     * dial, 3 s later, doubling up to 30 s while it keeps failing (a failed
     * dial ends in another 'bye'). Gun re-sends its subscriptions by itself on
     * 'hi'; the provider is told as well (onPeerConnect), for what it wrote and
     * missed meanwhile.
     *
     * And the page's own signs that its network is back - visible again,
     * `online`, a change of `navigator.connection` - dial at once instead of
     * sitting out the backoff (watchPageBack, as simple-peer, PeerJS, Nostr
     * and WebSocket do since round 10). A phone with its display off loses the
     * relay socket again and again (a real phone on Gun, 2026-09-21: "relay
     * gone" at 33 s and 72 s of a 84 s absence, the wait at 12 s by then);
     * that it was back 0.2 s after the display came on was a pending timer
     * that fired on wake - a backoff set right before the WiFi went, with the
     * display on, would have been waited out. Gate: test/gun/repro-page-back.mjs.
     */
    private _watchRelays;
    /**
     * Transport.onPeerConnect: fires when a relay that was lost says hi again
     * (never at the first connect) - see _watchRelays().
     */
    onPeerConnect(callback: (peerId: string) => void): () => void;
    /**
     * Transport.flush: run gun's own pending work in THIS task.
     *
     * gun 0.2020.1241 hands every write to its turn queue
     * (`setTimeout.turn`, gun.js's shim), which is drained by a MessageChannel
     * task in the browser and by setImmediate under Node - synchronously only
     * while the last drain is less than 9 ms old (`setTimeout.hold`). A page
     * that unloads runs no further task, so the presence removal the provider
     * sends from `beforeunload` never reached the wire: a reloaded page stayed
     * a ghost in every roster until the presence lease ran out - 124 s in round
     * 8, 128.5 s of 25 browsers in round 10 (test/e2e/room-scenarios.mjs gun).
     *
     * So we run what gun queued, now: its own functions, one task earlier.
     * Each one may queue the next layer (chain -> root.on('out') -> mesh.say ->
     * wire.send), hence the rounds; the cap is there so a queue that refills
     * itself cannot hold the page. Gate: test/gun/repro-unload-removal.mjs.
     *
     * Our own debounce (`batchInterval`) is a timer of exactly the same kind,
     * so the queued document updates go first - the words a page typed just
     * before it was closed - and into UNLOAD_SLOT, the one update node warmed
     * at connect: gun asks the relay about a node it has not written before
     * and puts only when the answer is in, which is a round trip this page
     * does not have (measured in the wire trace: a put to a fresh slot sends a
     * `get` and nothing else). With a password they do not make it either way:
     * the encryption of flushBatch() is asynchronous, and nothing after an
     * `await` runs in a page that is already gone.
     */
    flush(): void;
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
     * `.map().on()` fires for every per-client slot: the ones the relay
     * holds when we subscribe (replayed, each as the answer to our own get -
     * gun sets `@`, the id of that get, on an answer and nothing on a live
     * write), and every write from then on.
     *
     * Presence from the replay is history and dropped: a slot's last value is
     * the last thing that connection wrote, and a page killed without a word
     * (a closed laptop, a crashed tab) left its presence there. To a joiner
     * it looked like a live peer - written when, the joiner cannot tell
     * without trusting the writer's clock - so the joiner listed it for a
     * whole lease of its own, long after the room had expired it: with 25
     * browsers the page that reloaded after a killed tab was alone at 25 for
     * 122 s (test/e2e/room-scenarios.mjs gun, rejoin after vanish). Round 7's
     * five-minute bound (AWARENESS_MAX_AGE_MS) cut the phantoms of hours-old
     * slots, not this one. Who is here now, a joiner learns from the room:
     * its JOIN is answered with a live presence table (round 5, presence on
     * demand; the reloaded page's roster was whole in 0.4 s from that). A
     * re-subscribe after a relay restart gets answers the same way, and the
     * provider asks the room for its presence then too (onPeerConnect).
     * Gate: test/gun/repro-unload-removal.mjs, the late joiner C.
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