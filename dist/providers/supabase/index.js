import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { splitChunks, isChunk, ChunkAssembler } from '../chunking';
// GenericProvider's frame types this transport looks at (see src/index.ts).
const MESSAGE_AWARENESS = 1;
const MESSAGE_SYNC_PUSH = 6;
// Realtime caps a broadcast at 256 KB on the free tier (3 MB above). Below
// this the raw bytes go out as a binary payload (supabase-js >= 2.91.0 on
// EVERY peer - an older client drops binary broadcasts silently); above
// it, base64 chunks in the JSON path.
const MAX_BINARY_BYTES = 200000;
const MAX_CHUNK_CHARS = 200000;
// ---------------------------------------------------------------------------
// CRC32 helpers (GenericProvider wraps messages with CRC32 header)
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
/** Add a valid CRC32 header so GenericProvider accepts the message. */
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
/** Strip the 4-byte CRC32 header that GenericProvider prepends. */
function stripCRC32Header(data) {
    return data.length >= 4 ? data.subarray(4) : data;
}
// ---------------------------------------------------------------------------
// Password hashing helper (simple hash for channel name obfuscation)
// ---------------------------------------------------------------------------
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .substring(0, 16);
}
// ---------------------------------------------------------------------------
// Supabase Transport Implementation
// ---------------------------------------------------------------------------
/**
 * Supabase Transport for Yjs
 *
 * Provides real-time synchronization using Supabase Realtime channels.
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { SupabaseTransport } from 'y-generic/providers/supabase'
 *
 * const doc = new Y.Doc()
 * const transport = new SupabaseTransport({
 *   createClient: (globalThis as any).supabase.createClient,
 * })
 * const provider = new GenericProvider(doc, transport)
 *
 * await provider.connect({
 *   supabaseUrl: 'https://xxxxx.supabase.co',
 *   supabaseKey: 'your-anon-key',
 *   room: 'my-room',
 * })
 * ```
 */
export class SupabaseTransport {
    constructor(options) {
        this.options = options;
        this.supabase = null;
        this.channel = null;
        // No preferredCompressMinBytes: send() strips the CRC32 header, which
        // assumes the uncompressed frame layout (see compressionThresholdBytes).
        this.config = null;
        this.chunks = new ChunkAssembler();
        this._isConnected = false;
        this.debug = false;
        this.roomId = '';
        // Persistence (see SupabaseConfig.persistent)
        this.persistentMode = false;
        this.doc = null;
        this.tableName = 'yjs_documents';
        this.persistDebounceMs = 2000;
        this.isWritingToDb = false;
        this.savePending = false;
        // State loaded from the table before GenericProvider registered onMessage
        this.pendingLoad = null;
    }
    get isConnected() {
        return this._isConnected;
    }
    async connect(config) {
        this.config = config;
        this.debug = config.debug || false;
        if (!config.supabaseUrl || !config.supabaseKey) {
            throw new Error('SupabaseTransport: supabaseUrl and supabaseKey are required');
        }
        if (!config.room) {
            throw new Error('SupabaseTransport: room name is required');
        }
        this.persistentMode = config.persistent ?? false;
        this.doc = config.doc ?? null;
        this.tableName = config.tableName ?? 'yjs_documents';
        this.persistDebounceMs = config.persistDebounceMs ?? 2000;
        if (this.persistentMode && !this.doc) {
            throw new Error('SupabaseTransport: a Y.Doc must be provided via config.doc when persistent is true');
        }
        // Create Supabase client using the injected createClient function
        this.supabase = this.options.createClient(config.supabaseUrl, config.supabaseKey);
        // Generate room ID (with optional password hashing)
        this.roomId = config.password
            ? `${config.room}-${await hashPassword(config.password)}`
            : config.room;
        this.log('Connecting to room:', this.roomId);
        // Create and subscribe to channel
        this.channel = this.supabase.channel(this.roomId);
        // Listen for messages
        this.channel.on('broadcast', { event: 'message' }, (payload) => {
            this.handleMessage(payload.payload);
        });
        // Subscribe to channel
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Supabase channel subscription timeout'));
            }, 10000);
            this.channel.subscribe((status) => {
                clearTimeout(timeout);
                if (status === 'SUBSCRIBED') {
                    this._isConnected = true;
                    this.log('Connected to Supabase channel');
                    resolve();
                }
                else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    reject(new Error(`Supabase subscription failed: ${status}`));
                }
            });
        });
        if (this.persistentMode)
            await this.loadFromDatabase();
    }
    async disconnect() {
        this.log('Disconnecting...');
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        if (this.persistentMode && this.doc) {
            try {
                await this.saveToDatabase();
            }
            catch (error) {
                this.log('Error flushing to database on disconnect:', error);
            }
        }
        if (this.channel) {
            await this.channel.unsubscribe();
            this.channel = null;
        }
        this._isConnected = false;
        this.supabase = null;
        this.config = null;
        this.messageCallback = undefined;
        this.pendingLoad = null;
    }
    send(data) {
        if (!this._isConnected || !this.channel) {
            this.log('Cannot send: not connected');
            return;
        }
        // Strip CRC32 header before sending
        const payload = stripCRC32Header(data);
        // Only document updates schedule a database write, not presence
        if (this.persistentMode && payload[0] !== MESSAGE_AWARENESS) {
            this.queuePersist();
        }
        if (payload.length <= MAX_BINARY_BYTES) {
            // Binary broadcast: no base64 (33 % smaller on the wire)
            this.channel.send({
                type: 'broadcast',
                event: 'message',
                payload: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
            });
            return;
        }
        // Too large for one broadcast: base64 chunks through the JSON path
        const base64 = this.uint8ArrayToBase64(payload);
        for (const chunk of splitChunks(base64, MAX_CHUNK_CHARS)) {
            this.channel.send({ type: 'broadcast', event: 'message', payload: chunk });
        }
    }
    onMessage(callback) {
        this.messageCallback = callback;
        // State loaded from the table before GenericProvider registered this
        // callback (connect() resolves first): deliver it now, one microtask
        // later so the provider has finished its own setup.
        if (this.pendingLoad) {
            const data = this.pendingLoad;
            this.pendingLoad = null;
            Promise.resolve().then(() => callback(data));
        }
        return () => {
            this.messageCallback = undefined;
        };
    }
    // ---------------------------------------------------------------------------
    // Persistence: one row per room, `content` = base64 of the full state
    // ---------------------------------------------------------------------------
    /**
     * Deliver the stored state as a MESSAGE_SYNC_PUSH frame - the provider
     * applies it like a peer's full-state push: no hash check, no `synced`
     * flip (a stored copy says nothing about who is online).
     */
    async loadFromDatabase() {
        try {
            const { data, error } = await this.supabase
                .from(this.tableName)
                .select('content')
                .eq('id', this.roomId)
                .maybeSingle();
            if (error)
                throw error;
            if (!data?.content) {
                this.log('No stored document for this room yet');
                return;
            }
            const update = this.base64ToUint8Array(data.content);
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, MESSAGE_SYNC_PUSH);
            encoding.writeVarUint8Array(enc, update);
            const frame = addCRC32Header(encoding.toUint8Array(enc));
            if (this.messageCallback)
                this.messageCallback(frame);
            else
                this.pendingLoad = frame;
            this.log('Loaded', update.length, 'bytes from the database');
        }
        catch (error) {
            this.log('Error loading from database:', error?.message ?? error);
            console.warn('SupabaseTransport: failed to load from database:', error);
        }
    }
    queuePersist() {
        if (this.persistTimer)
            clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => this.saveToDatabase(), this.persistDebounceMs);
    }
    /** Upsert the full current state; a write that overlaps a change re-runs once. */
    async saveToDatabase() {
        if (!this.supabase || !this.persistentMode || !this.doc)
            return;
        if (this.isWritingToDb) {
            this.savePending = true;
            return;
        }
        this.isWritingToDb = true;
        this.savePending = false;
        try {
            const state = Y.encodeStateAsUpdate(this.doc);
            const { error } = await this.supabase.from(this.tableName).upsert({
                id: this.roomId,
                content: this.uint8ArrayToBase64(state),
                updated_at: new Date().toISOString(),
            });
            if (error)
                throw error;
            this.log('Saved', state.length, 'bytes to the database');
        }
        catch (error) {
            this.log('Error saving to database:', error?.message ?? error);
            console.warn('SupabaseTransport: failed to save to database, will retry:', error);
            this.savePending = true;
        }
        finally {
            this.isWritingToDb = false;
            if (this.savePending)
                setTimeout(() => this.saveToDatabase(), 1000);
        }
    }
    // ---------------------------------------------------------------------------
    // Private methods
    // ---------------------------------------------------------------------------
    handleMessage(payload) {
        if (!this.messageCallback)
            return;
        try {
            let data;
            if (payload instanceof ArrayBuffer) {
                data = new Uint8Array(payload);
            }
            else if (ArrayBuffer.isView(payload)) {
                data = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
            }
            else if (typeof payload === 'string') {
                data = this.base64ToUint8Array(payload); // an older sender
            }
            else if (isChunk(payload)) {
                const whole = this.chunks.push(payload);
                if (whole === null)
                    return;
                data = this.base64ToUint8Array(whole);
            }
            else {
                return;
            }
            // Add CRC32 header for GenericProvider
            const wrapped = addCRC32Header(data);
            this.messageCallback(wrapped);
        }
        catch (error) {
            this.log('Error handling message:', error);
        }
    }
    // Utility methods for base64 conversion
    uint8ArrayToBase64(data) {
        let binary = '';
        for (let i = 0; i < data.length; i++) {
            binary += String.fromCharCode(data[i]);
        }
        return btoa(binary);
    }
    base64ToUint8Array(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
    log(...args) {
        if (this.debug) {
            console.log('[SupabaseTransport]', ...args);
        }
    }
}
//# sourceMappingURL=index.js.map