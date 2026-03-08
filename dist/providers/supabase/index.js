import { createClient, } from '@supabase/supabase-js';
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
 * Features:
 * - Ephemeral mode: Peer-to-peer sync via Supabase Realtime (no database)
 * - Persistent mode: Database-backed sync with automatic persistence
 * - Optional password protection
 * - Room-based collaboration
 * - Debounced database updates
 * - Automatic retry on database errors
 *
 * @example
 * ```ts
 * // Ephemeral mode (states lost when all peers disconnect)
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { SupabaseTransport } from 'y-generic/providers/supabase'
 *
 * const doc = new Y.Doc()
 * const transport = new SupabaseTransport()
 *
 * await provider.connect({
 *   supabaseUrl: 'https://xxxxx.supabase.co',
 *   supabaseKey: 'your-anon-key',
 *   room: 'my-room',
 *   persistent: false
 * })
 *
 * // Persistent mode (states stored in database)
 * await provider.connect({
 *   supabaseUrl: 'https://xxxxx.supabase.co',
 *   supabaseKey: 'your-anon-key',
 *   room: 'my-room',
 *   persistent: true,
 *   password: 'optional-password'
 * })
 * ```
 */
export class SupabaseTransport {
    constructor() {
        this.supabase = null;
        this.channel = null;
        this.config = null;
        this._isConnected = false;
        this.debug = false;
        // Persistent mode
        this.persistentMode = false;
        this.tableName = 'yjs_documents';
        this.columnName = 'content';
        this.idColumnName = 'id';
        this.roomId = '';
        this.persistDebounceMs = 2000;
        this.updateQueue = [];
        this.isWritingToDb = false;
    }
    get isConnected() {
        return this._isConnected;
    }
    async connect(config) {
        this.config = config;
        this.debug = config.debug || false;
        this.persistentMode = config.persistent || false;
        this.tableName = config.tableName || 'yjs_documents';
        this.columnName = config.columnName || 'content';
        this.idColumnName = config.idColumnName || 'id';
        this.persistDebounceMs = config.persistDebounceMs || 2000;
        if (!config.supabaseUrl || !config.supabaseKey) {
            throw new Error('SupabaseTransport: supabaseUrl and supabaseKey are required');
        }
        if (!config.room) {
            throw new Error('SupabaseTransport: room name is required');
        }
        // Create Supabase client
        this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
        // Generate room ID (with optional password hashing)
        this.roomId = config.password
            ? `${config.room}-${await hashPassword(config.password)}`
            : config.room;
        this.log('Connecting to room:', this.roomId, this.persistentMode ? '(persistent)' : '(ephemeral)');
        // Load from database if persistent mode
        if (this.persistentMode) {
            await this.loadFromDatabase();
        }
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
    }
    async disconnect() {
        this.log('Disconnecting...');
        // Flush pending updates
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        if (this.pendingUpdate && this.persistentMode) {
            await this.saveToDatabase(this.pendingUpdate);
            this.pendingUpdate = undefined;
        }
        // Unsubscribe from channel
        if (this.channel) {
            await this.channel.unsubscribe();
            this.channel = null;
        }
        this._isConnected = false;
        this.supabase = null;
        this.config = null;
        this.messageCallback = undefined;
    }
    send(data) {
        if (!this._isConnected || !this.channel) {
            this.log('Cannot send: not connected');
            return;
        }
        // Strip CRC32 header before sending
        const payload = stripCRC32Header(data);
        // Convert Uint8Array to base64 for JSON transport
        const base64 = this.uint8ArrayToBase64(payload);
        // Broadcast to channel
        this.channel.send({
            type: 'broadcast',
            event: 'message',
            payload: base64,
        });
        // Queue for database persistence if enabled
        if (this.persistentMode) {
            this.queuePersist(payload);
        }
    }
    onMessage(callback) {
        this.messageCallback = callback;
        return () => {
            this.messageCallback = undefined;
        };
    }
    // ---------------------------------------------------------------------------
    // Private methods
    // ---------------------------------------------------------------------------
    handleMessage(payload) {
        if (!this.messageCallback)
            return;
        try {
            // Convert base64 back to Uint8Array
            const data = typeof payload === 'string'
                ? this.base64ToUint8Array(payload)
                : new Uint8Array(0);
            // Add CRC32 header for GenericProvider
            const wrapped = addCRC32Header(data);
            this.messageCallback(wrapped);
        }
        catch (error) {
            this.log('Error handling message:', error);
        }
    }
    async loadFromDatabase() {
        if (!this.supabase || !this.persistentMode)
            return;
        try {
            this.log('Loading from database...');
            const { data, error } = await this.supabase
                .from(this.tableName)
                .select(this.columnName)
                .eq(this.idColumnName, this.roomId)
                .single();
            if (error) {
                if (error.code === 'PGRST116') {
                    // No document found, will be created on first save
                    this.log('No existing document found in database');
                    return;
                }
                throw error;
            }
            if (data && data[this.columnName]) {
                const content = data[this.columnName];
                const uint8Array = this.base64ToUint8Array(content);
                // Add CRC32 header and pass to callback
                if (this.messageCallback && uint8Array.length > 0) {
                    const wrapped = addCRC32Header(uint8Array);
                    this.messageCallback(wrapped);
                    this.log('Loaded', uint8Array.length, 'bytes from database');
                }
            }
        }
        catch (error) {
            this.log('Error loading from database:', error.message);
            console.warn('SupabaseTransport: Failed to load from database:', error);
        }
    }
    queuePersist(data) {
        this.pendingUpdate = data;
        // Clear existing timer
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
        }
        // Debounce: wait before saving
        this.persistTimer = setTimeout(() => {
            if (this.pendingUpdate) {
                this.saveToDatabase(this.pendingUpdate);
                this.pendingUpdate = undefined;
            }
        }, this.persistDebounceMs);
    }
    async saveToDatabase(data) {
        if (!this.supabase || !this.persistentMode)
            return;
        // Queue if already writing
        if (this.isWritingToDb) {
            this.updateQueue.push(data);
            return;
        }
        this.isWritingToDb = true;
        try {
            const base64 = this.uint8ArrayToBase64(data);
            this.log('Saving to database...', data.length, 'bytes');
            // Try to update first
            const { error: updateError } = await this.supabase
                .from(this.tableName)
                .update({ [this.columnName]: base64 })
                .eq(this.idColumnName, this.roomId);
            // If no rows updated, insert new row
            if (updateError?.code === 'PGRST116' ||
                updateError?.message?.includes('0 rows')) {
                const { error: insertError } = await this.supabase
                    .from(this.tableName)
                    .insert({
                    [this.idColumnName]: this.roomId,
                    [this.columnName]: base64,
                });
                if (insertError) {
                    throw insertError;
                }
            }
            else if (updateError) {
                throw updateError;
            }
            this.log('Saved to database successfully');
        }
        catch (error) {
            this.log('Error saving to database:', error.message);
            console.warn('SupabaseTransport: Failed to save to database. Will retry later.', error);
            // Re-queue for retry
            this.updateQueue.push(data);
        }
        finally {
            this.isWritingToDb = false;
            // Process queue
            if (this.updateQueue.length > 0) {
                const nextUpdate = this.updateQueue.shift();
                if (nextUpdate) {
                    setTimeout(() => this.saveToDatabase(nextUpdate), 1000);
                }
            }
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