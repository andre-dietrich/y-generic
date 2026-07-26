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
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
// ---------------------------------------------------------------------------
// CRC32 helpers — needed to wrap snapshot payloads for GenericProvider
// ---------------------------------------------------------------------------
const _CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();
function _crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++)
        crc = (crc >>> 8) ^ _CRC32_TABLE[(crc ^ data[i]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
}
function addCRC32Header(data) {
    const crc = _crc32(data);
    const wrapped = new Uint8Array(4 + data.length);
    wrapped[0] = (crc >>> 24) & 0xff;
    wrapped[1] = (crc >>> 16) & 0xff;
    wrapped[2] = (crc >>> 8) & 0xff;
    wrapped[3] = crc & 0xff;
    wrapped.set(data, 4);
    return wrapped;
}
// Message type identifiers (must match GenericProvider)
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
/**
 * GunDB transport implementation.
 * Creates decentralized P2P connections using Gun graph database.
 *
 * Note: deliberately does NOT set `preferredBatchMs` on the Transport
 * interface. send() already debounces internally via `batchInterval`
 * (see flushBatch()) — an additional GenericProvider-level batch delay
 * would just stack a second debounce in front of this one for no benefit.
 */
export class GunTransport {
    /**
     * Create a new Gun transport.
     *
     * @param options - Configuration options (must include gun constructor)
     */
    constructor(options) {
        this._connected = false;
        this._room = '';
        this.gun = null;
        this.roomNode = null;
        this.updateListener = null;
        this.lastUpdateTime = 0;
        this.updateBatch = [];
        this.processedUpdates = new Set();
        this.connectionTime = 0;
        this.pendingUpdates = new Map();
        this.updateSlot = 0;
        this.BUFFER_SIZE = 20; // Circular buffer size
        this.awarenessListener = null;
        this.lastAwarenessId = ''; // Track last awareness ID to avoid processing our own
        this.encryptionEnabled = false;
        // Persistence
        this.persistentMode = false;
        this.persistDoc = null;
        this.persistDebounceMs = 2000;
        this.isWritingToGun = false;
        this.savePending = false;
        /** Data loaded from Gun snapshot before onMessage callback is registered */
        this.pendingLoad = null;
        if (!options.gun) {
            throw new Error('GunTransport requires the "gun" option. ' +
                'Please provide the Gun constructor: ' +
                'import Gun from "gun"; new GunTransport({ gun: Gun, ... })');
        }
        // Validate SEA is provided when using password
        if (options.password && !options.sea) {
            throw new Error('GunTransport requires the "sea" option when using password encryption. ' +
                'Please provide Gun.SEA: import "gun/sea"; new GunTransport({ gun: Gun, sea: Gun.SEA, password: "..." })');
        }
        this.options = {
            gun: options.gun,
            peers: options.peers ?? [],
            gunOptions: options.gunOptions ?? {},
            debug: options.debug ?? false,
            batchInterval: options.batchInterval ?? 100, // Debounce: wait 100ms after last update
            password: options.password,
            sea: options.sea,
        };
        this.encryptionEnabled = !!(options.password && options.sea);
        if (this.encryptionEnabled) {
            this.log('🔐 Encryption enabled');
        }
    }
    /**
     * Connect to the room and start syncing.
     */
    async connect(config) {
        if (this._connected) {
            throw new Error('Already connected');
        }
        this._room = config.room;
        this.connectionTime = Date.now();
        this.persistentMode = config.persistent ?? false;
        this.persistDoc = config.doc ?? null;
        this.persistDebounceMs = config.persistDebounceMs ?? 2000;
        if (this.persistentMode && !this.persistDoc) {
            throw new Error('GunTransport: a Y.Doc must be provided via config.doc when persistent is true');
        }
        this.log('🔗 Initializing Gun...');
        // Initialize Gun
        const gunConfig = {
            localStorage: false, // Disable localStorage to prevent quota errors
            radisk: false, // Disable radisk
            ...this.options.gunOptions,
        };
        // Add peers if specified
        if (this.options.peers.length > 0) {
            gunConfig.peers = this.options.peers;
            this.log('📡 Connecting to peers:', this.options.peers);
        }
        this.gun = new this.options.gun(gunConfig);
        // Navigate to room node
        this.roomNode = this.gun.get(`yjs-room-${this._room}`);
        this.log('✅ Gun initialized for room:', this._room);
        // Note: We use a circular buffer (10 slots) to prevent infinite accumulation
        // of update nodes in Gun's graph. This prevents the "1K+ records" warning.
        // Each update overwrites one of the slots (slot-0 through slot-9).
        // Subscribe to updates from Gun (both doc sync and awareness)
        this.setupUpdateListener();
        this.setupAwarenessListener();
        this._connected = true;
        // Persistence: load existing snapshot or clear it for a fresh session
        if (this.persistentMode) {
            this.loadSnapshot();
        }
        else {
            // Overwrite any previously saved snapshot so reconnecting peers start fresh
            this.roomNode
                .get('snapshot')
                .put({ cleared: true, timestamp: Date.now() });
        }
    }
    /**
     * Setup listener for Gun updates.
     */
    setupUpdateListener() {
        let lastProcessTime = 0;
        const THROTTLE_MS = 300; // Process updates at most every 300ms
        let hasLoadedInitial = false;
        // Best Practice: Use .once() for initial load, then .on() only for new inserts
        // This prevents Gun from continuously syncing 1K+ historical records
        // Step 1: Load initial state once
        this.roomNode.get('updates').once((allUpdates) => {
            if (!allUpdates) {
                hasLoadedInitial = true;
                this.log('📭 No existing updates found');
                return;
            }
            this.log('📥 Loading initial state...');
            // Process all existing updates once
            Object.keys(allUpdates).forEach((key) => {
                if (key === '_')
                    return; // Skip Gun metadata
                const update = allUpdates[key];
                if (!update || !update.data)
                    return;
                const sequence = update.sequence || Math.floor(update.timestamp / 100);
                const updateKey = `${key}-${sequence}`;
                if (!this.processedUpdates.has(updateKey)) {
                    this.pendingUpdates.set(updateKey, update);
                }
            });
            // Process initial batch
            this.processPendingUpdates();
            hasLoadedInitial = true;
            this.log('✅ Initial state loaded');
        });
        // Step 2: Listen only for NEW inserts (not historical data)
        this.updateListener = this.roomNode
            .get('updates')
            .map()
            .on((update, updateId) => {
            // Skip until initial load is complete
            if (!hasLoadedInitial)
                return;
            if (!update || !update.data)
                return;
            // Only process updates newer than our connection time
            if (update.timestamp && update.timestamp < this.connectionTime) {
                return;
            }
            // Use sequence number for deduplication
            const sequence = update.sequence || Math.floor(update.timestamp / 100);
            const updateKey = `${updateId}-${sequence}`;
            if (this.processedUpdates.has(updateKey)) {
                return;
            }
            // Store update for throttled processing
            this.pendingUpdates.set(updateKey, update);
            // Throttle processing (batching)
            const now = Date.now();
            if (now - lastProcessTime < THROTTLE_MS) {
                if (!this.throttleTimeout) {
                    this.throttleTimeout = setTimeout(() => {
                        this.processPendingUpdates();
                        lastProcessTime = Date.now();
                        this.throttleTimeout = undefined;
                    }, THROTTLE_MS);
                }
                return;
            }
            // Process immediately if enough time has passed
            lastProcessTime = now;
            this.processPendingUpdates();
        });
        this.log('👂 Listening for new updates...');
    }
    /**
     * Process all pending updates at once.
     */
    async processPendingUpdates() {
        if (this.pendingUpdates.size === 0)
            return;
        const updates = Array.from(this.pendingUpdates.entries());
        this.pendingUpdates.clear();
        for (const [updateKey, update] of updates) {
            // Mark as processed
            this.processedUpdates.add(updateKey);
            // Clean old entries from processed set (keep last 200)
            if (this.processedUpdates.size > 200) {
                const entries = Array.from(this.processedUpdates);
                entries.slice(0, entries.length - 200).forEach((key) => {
                    this.processedUpdates.delete(key);
                });
            }
            try {
                let payload = update.data;
                // Decrypt if encrypted
                if (update.encrypted && this.encryptionEnabled) {
                    payload = await this.decrypt(payload);
                    if (!payload) {
                        this.log('❌ Failed to decrypt update (wrong password?)');
                        continue;
                    }
                }
                // Decode base64 back to Uint8Array, then split the length-prefixed
                // framing back into the individual envelopes flushBatch() combined
                // (see frameUpdates()/unframeUpdates()) — a flush may contain
                // several independently CRC32-wrapped GenericProvider messages.
                const decoded = this.base64ToUint8Array(payload);
                const frames = this.unframeUpdates(decoded);
                if (this._callback) {
                    for (const frame of frames) {
                        this._callback(frame);
                    }
                }
                if (updates.length === 1) {
                    this.log('📥 Received update:', frames.length, frames.length === 1 ? 'message' : 'messages', update.encrypted ? '(decrypted)' : '');
                }
            }
            catch (error) {
                this.log('❌ Error processing update:', error);
            }
        }
        if (updates.length > 1) {
            this.log(`📥 Processed ${updates.length} batched updates`);
        }
    }
    /**
     * Disconnect from Gun and cleanup.
     */
    disconnect() {
        if (!this._connected)
            return;
        this.log('👋 Disconnecting...');
        // Clear batch timeout
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
            this.batchTimeout = undefined;
        }
        // Clear persist debounce and flush snapshot synchronously (Gun is async internally)
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        if (this.persistentMode && this.persistDoc) {
            this.saveSnapshot();
        }
        // Clear throttle timeout
        if (this.throttleTimeout) {
            clearTimeout(this.throttleTimeout);
            this.throttleTimeout = undefined;
        }
        // Process any pending updates before disconnect
        this.processPendingUpdates();
        // Flush any pending updates
        this.flushBatch();
        // Remove listeners
        if (this.updateListener) {
            // Gun doesn't have a clear off() method for map listeners
            // The listener will be garbage collected
            this.updateListener = null;
        }
        if (this.awarenessListener) {
            this.awarenessListener = null;
        }
        this.roomNode = null;
        this.gun = null;
        this._connected = false;
        this.processedUpdates.clear();
        this.pendingUpdates.clear();
        this.persistentMode = false;
        this.persistDoc = null;
        this.pendingLoad = null;
        this.log('✅ Disconnected');
    }
    /**
     * Send data to all peers via Gun.
     * Routes awareness to a separate volatile node, doc sync to circular buffer.
     * Uses debouncing for doc sync - each new update resets the timer.
     */
    send(data) {
        if (!this._connected || !this.roomNode) {
            this.log('⚠️ Not connected, cannot send');
            return;
        }
        // Peek message type (after CRC32 header: 4 bytes CRC + 1 byte type)
        const messageType = this.peekMessageType(data);
        // Route awareness to separate volatile node (immediate, no buffer)
        if (messageType === MESSAGE_AWARENESS) {
            this.sendAwareness(data);
            return;
        }
        // Doc sync goes through batched circular buffer
        this.updateBatch.push(data);
        // Clear existing timeout (debouncing - resets timer on each update)
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
        }
        // Set new timeout to flush batch after period of inactivity
        this.batchTimeout = setTimeout(() => {
            this.flushBatch();
        }, this.options.batchInterval);
        // Schedule a snapshot save for persistent mode
        if (this.persistentMode) {
            this.queuePersist();
        }
    }
    /**
     * Peek at the message type from CRC32-wrapped data.
     * Format: [CRC32 (4 bytes)][message type (varint)]...
     * Returns -1 if cannot determine type.
     */
    peekMessageType(data) {
        // Need at least 5 bytes: 4 for CRC32 + 1 for message type
        if (data.length < 5)
            return -1;
        // Message type is stored as varint after CRC32, but for small values (0-3)
        // it's just a single byte
        return data[4];
    }
    /**
     * Send awareness update to a separate volatile node.
     * Awareness is ephemeral - only the latest state matters.
     * Each client writes to its own awareness slot to avoid overwrites.
     */
    async sendAwareness(data) {
        let payload = this.uint8ArrayToBase64(data);
        // Encrypt if password is set
        if (this.encryptionEnabled) {
            payload = await this.encrypt(payload);
        }
        const awarenessId = `aware-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        // Track this ID so we don't process our own update
        this.lastAwarenessId = awarenessId;
        // Write to a single volatile awareness node
        // Each update overwrites the previous - awareness only needs latest state
        this.roomNode.get('awareness').put({
            data: payload,
            id: awarenessId,
            timestamp: Date.now(),
            encrypted: this.encryptionEnabled,
        });
        this.log('📤 Sent awareness update', this.encryptionEnabled ? '(encrypted)' : '');
    }
    /**
     * Setup listener for awareness updates (separate from doc sync).
     */
    setupAwarenessListener() {
        this.awarenessListener = this.roomNode
            .get('awareness')
            .on(async (awareness) => {
            if (!awareness || !awareness.data)
                return;
            // Skip our own awareness updates
            if (awareness.id === this.lastAwarenessId)
                return;
            // Only process updates newer than our connection
            if (awareness.timestamp && awareness.timestamp < this.connectionTime) {
                return;
            }
            try {
                let payload = awareness.data;
                // Decrypt if encrypted
                if (awareness.encrypted && this.encryptionEnabled) {
                    payload = await this.decrypt(payload);
                    if (!payload) {
                        this.log('❌ Failed to decrypt awareness (wrong password?)');
                        return;
                    }
                }
                const decoded = this.base64ToUint8Array(payload);
                if (this._callback) {
                    this._callback(decoded);
                }
                this.log('📥 Received awareness update', awareness.encrypted ? '(decrypted)' : '');
            }
            catch (error) {
                this.log('❌ Error processing awareness:', error);
            }
        });
        this.log('👂 Listening for awareness updates...');
    }
    /**
     * Frame a list of independently-wrapped envelopes with 4-byte big-endian
     * length prefixes so they can be split back apart after transmission as
     * one combined Gun record. See unframeUpdates() for the inverse.
     */
    frameUpdates(updates) {
        const totalLength = updates.reduce((sum, arr) => sum + 4 + arr.length, 0);
        const merged = new Uint8Array(totalLength);
        const view = new DataView(merged.buffer);
        let offset = 0;
        for (const update of updates) {
            view.setUint32(offset, update.length, false);
            merged.set(update, offset + 4);
            offset += 4 + update.length;
        }
        return merged;
    }
    /**
     * Split a buffer produced by frameUpdates() back into the individual
     * envelopes it contains. Malformed/truncated framing stops early rather
     * than throwing, since a partial batch is still recoverable via periodic
     * sync / hash verification.
     */
    unframeUpdates(data) {
        const frames = [];
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;
        while (offset + 4 <= data.length) {
            const len = view.getUint32(offset, false);
            offset += 4;
            if (len < 0 || offset + len > data.length) {
                this.log('⚠️ Malformed batch framing, stopping split early');
                break;
            }
            frames.push(data.subarray(offset, offset + len));
            offset += len;
        }
        return frames;
    }
    /**
     * Flush batched updates to Gun.
     * Called after debounce period (no new updates for batchInterval ms).
     */
    async flushBatch() {
        if (this.updateBatch.length === 0)
            return;
        // Frame each queued update with a 4-byte big-endian length prefix so
        // multiple independently CRC32-wrapped GenericProvider envelopes can be
        // split back apart on the receiving side (see processPendingUpdates()).
        // Each entry in updateBatch is already a complete, self-checksummed
        // envelope — naively concatenating them without a delimiter made the
        // combined blob fail CRC32 verification (and get silently dropped)
        // whenever 2+ updates landed in the same flush.
        const merged = this.frameUpdates(this.updateBatch);
        // Clear batch
        this.updateBatch = [];
        // Convert to base64 for Gun storage
        let payload = this.uint8ArrayToBase64(merged);
        // Encrypt if password is set
        if (this.encryptionEnabled) {
            payload = await this.encrypt(payload);
        }
        // Create update object with circular buffer slot
        const updateId = this.generateUpdateId();
        const timestamp = Date.now();
        const sequence = Math.floor(timestamp / 100); // Sequence number per 100ms
        // Mark as processed so we don't receive our own update
        this.processedUpdates.add(`${updateId}-${sequence}`);
        // Store in Gun using circular buffer slot
        const updates = this.roomNode.get('updates');
        updates.get(updateId).put({
            data: payload,
            timestamp: timestamp,
            sequence: sequence,
            size: merged.length,
            encrypted: this.encryptionEnabled,
        });
        this.log('📤 Sent update:', merged.length, 'bytes', this.encryptionEnabled ? '(encrypted)' : '');
    }
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback) {
        this._callback = callback;
        // Flush any snapshot data that arrived before this callback was registered
        if (this.pendingLoad) {
            const data = this.pendingLoad;
            this.pendingLoad = null;
            // Defer by one microtask so GenericProvider finishes its own setup first
            Promise.resolve().then(() => callback(data));
        }
        return () => {
            this._callback = undefined;
        };
    }
    /**
     * Check if connected.
     */
    get isConnected() {
        return this._connected;
    }
    /**
     * Generate a circular buffer slot ID.
     * Uses only BUFFER_SIZE slots to prevent infinite accumulation.
     */
    generateUpdateId() {
        const slotId = `slot-${this.updateSlot}`;
        this.updateSlot = (this.updateSlot + 1) % this.BUFFER_SIZE;
        return slotId;
    }
    // ---------------------------------------------------------------------------
    // Persistence helpers
    // ---------------------------------------------------------------------------
    /**
     * Schedule a debounced snapshot write. Called on every doc update.
     * Always saves the latest full state, never an individual delta.
     */
    queuePersist() {
        if (this.persistTimer)
            clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => this.saveSnapshot(), this.persistDebounceMs);
    }
    /**
     * Encode the full Y.Doc state as a proper y-protocols SYNC_STEP_2 message
     * and write it to the Gun `snapshot` node.
     * Using SYNC_STEP_2 format ensures GenericProvider interprets it correctly.
     */
    async saveSnapshot() {
        if (!this.persistDoc || !this.persistentMode || !this.roomNode)
            return;
        if (this.isWritingToGun) {
            this.savePending = true;
            return;
        }
        this.isWritingToGun = true;
        this.savePending = false;
        try {
            // Encode as a proper y-generic SYNC_STEP_2 message
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, 0); // MESSAGE_SYNC
            syncProtocol.writeSyncStep2(enc, this.persistDoc);
            const snapshotBytes = encoding.toUint8Array(enc);
            let payload = this.uint8ArrayToBase64(snapshotBytes);
            if (this.encryptionEnabled) {
                payload = await this.encrypt(payload);
            }
            this.roomNode.get('snapshot').put({
                data: payload,
                timestamp: Date.now(),
                encrypted: this.encryptionEnabled,
            });
            this.log('💾 Snapshot saved', snapshotBytes.length, 'bytes');
        }
        catch (error) {
            this.log('❌ Error saving snapshot:', error.message);
            console.warn('GunTransport: Failed to save snapshot. Will retry later.', error);
            this.savePending = true;
        }
        finally {
            this.isWritingToGun = false;
            if (this.savePending) {
                setTimeout(() => this.saveSnapshot(), 1000);
            }
        }
    }
    /**
     * Load the snapshot from Gun and deliver it to the message callback.
     * Uses a pendingLoad buffer in case the callback isn't registered yet.
     */
    loadSnapshot() {
        this.roomNode.get('snapshot').once(async (snap) => {
            if (!snap || !snap.data || snap.cleared) {
                this.log('📭 No snapshot found in Gun');
                return;
            }
            try {
                let payload = snap.data;
                if (snap.encrypted && this.encryptionEnabled) {
                    const decrypted = await this.decrypt(payload);
                    if (!decrypted) {
                        this.log('❌ Failed to decrypt snapshot (wrong password?)');
                        return;
                    }
                    payload = decrypted;
                }
                const snapshotBytes = this.base64ToUint8Array(payload);
                if (snapshotBytes.length > 0) {
                    // Wrap with CRC32 so GenericProvider accepts it
                    const wrapped = addCRC32Header(snapshotBytes);
                    if (this._callback) {
                        this._callback(wrapped);
                    }
                    else {
                        // Callback not yet registered — buffer until onMessage() is called
                        this.pendingLoad = wrapped;
                    }
                    this.log('💾 Loaded snapshot:', snapshotBytes.length, 'bytes');
                }
            }
            catch (error) {
                this.log('❌ Error loading snapshot:', error);
                console.warn('GunTransport: Failed to load snapshot:', error);
            }
        });
    }
    /**
     * Convert Uint8Array to base64 string.
     */
    uint8ArrayToBase64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }
    /**
     * Convert base64 string to Uint8Array.
     */
    base64ToUint8Array(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
    /**
     * Encrypt data using SEA with the configured password.
     */
    async encrypt(data) {
        if (!this.options.sea || !this.options.password) {
            return data;
        }
        return await this.options.sea.encrypt(data, this.options.password);
    }
    /**
     * Decrypt data using SEA with the configured password.
     * Returns null if decryption fails (wrong password).
     */
    async decrypt(data) {
        if (!this.options.sea || !this.options.password) {
            return data;
        }
        try {
            const decrypted = await this.options.sea.decrypt(data, this.options.password);
            return decrypted || null;
        }
        catch (error) {
            this.log('❌ Decryption failed:', error);
            return null;
        }
    }
    /**
     * Log debug messages if enabled.
     */
    log(...args) {
        if (this.options.debug) {
            console.log('[GunTransport]', ...args);
        }
    }
}
//# sourceMappingURL=index.js.map