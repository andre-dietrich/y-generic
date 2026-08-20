/**
 * Ably Transport Provider
 *
 * Real-time synchronization using Ably's managed pub/sub messaging platform.
 *
 * Features:
 * - Global edge network with low latency
 * - Built-in presence tracking
 * - API-key or token-based authentication
 * - Optional password-protected rooms (channel name obfuscation)
 * - Automatic chunking for messages above Ably's size limit
 *
 * The Ably SDK class is injected via the constructor (not imported directly)
 * so this file compiles without the `ably` package installed, and consumers
 * only pull in Ably if they actually use this provider.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { AblyTransport } from 'y-generic/providers/ably'
 * import * as Ably from 'ably'
 *
 * const doc = new Y.Doc()
 * const transport = new AblyTransport({ Realtime: Ably.Realtime })
 * const provider = new GenericProvider(doc, transport)
 *
 * await provider.connect({
 *   apiKey: 'your-ably-api-key',
 *   room: 'my-collab-room',
 * })
 * ```
 *
 * @example Token auth (recommended for browser clients)
 * ```typescript
 * await provider.connect({
 *   authUrl: '/api/ably-token',
 *   room: 'my-collab-room',
 * })
 * ```
 */
// ---------------------------------------------------------------------------
// CRC32 translation helpers
//
// GenericProvider wraps every outgoing message as [CRC32 (4 bytes)][payload].
// Ably message data is JSON-friendly, so we strip the CRC32 header before
// base64-encoding and re-add it after decoding so GenericProvider accepts
// the incoming message.
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
/** Strip the 4-byte CRC32 header that GenericProvider prepends. */
function stripCRC32Header(data) {
    return data.length >= 4 ? data.subarray(4) : data;
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
// ---------------------------------------------------------------------------
// Base64 helpers (no Buffer/Node dependency)
// ---------------------------------------------------------------------------
function uint8ToBase64(data) {
    const chunkSize = 8192; // Process 8KB at a time to avoid arg-count overflow
    let binary = '';
    for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.subarray(i, Math.min(i + chunkSize, data.length));
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}
function base64ToUint8(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
// ---------------------------------------------------------------------------
// Password hashing (obfuscates channel name — not encryption)
// ---------------------------------------------------------------------------
async function hashPassword(password) {
    const encoded = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .substring(0, 16);
}
function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
const EVENT_NAME = 'yjs-update';
// Ably's default max message size is ~64 KiB; stay well under it (after base64).
const MAX_MESSAGE_SIZE = 55000;
/**
 * Ably transport for y-generic.
 *
 * Publishes Yjs binary updates as base64-encoded messages on an Ably channel
 * and subscribes to matching messages from peers.
 */
export class AblyTransport {
    constructor(options) {
        this.client = null;
        this.channel = null;
        this.clientId = '';
        this.channelName = '';
        this._isConnected = false;
        this.debug = false;
        this.messageBuffer = [];
        this.chunkBuffer = new Map();
        this.opts = options;
    }
    get isConnected() {
        return this._isConnected;
    }
    async connect(config) {
        this.debug = config.debug ?? this.opts.debug ?? false;
        if (!config.apiKey && !config.authUrl) {
            throw new Error('AblyTransport: apiKey or authUrl is required');
        }
        if (!config.room) {
            throw new Error('AblyTransport: room name is required');
        }
        this.clientId = generateUUID();
        this.channelName = config.password
            ? `${config.room}-${await hashPassword(config.password)}`
            : config.room;
        // Don't deliver our own published messages back to ourselves.
        const clientOptions = {
            clientId: this.clientId,
            echoMessages: false,
        };
        if (config.apiKey)
            clientOptions.key = config.apiKey;
        if (config.authUrl)
            clientOptions.authUrl = config.authUrl;
        if (config.authMethod)
            clientOptions.authMethod = config.authMethod;
        this.log('Connecting as', this.clientId, 'to channel', this.channelName);
        this.client = new this.opts.Realtime(clientOptions);
        this.channel = this.client.channels.get(this.channelName);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Ably connection timeout'));
            }, 10000);
            this.client.connection.once('connected', () => {
                clearTimeout(timeout);
                this._isConnected = true;
                this.log('Connected to Ably');
                resolve();
            });
            this.client.connection.on('failed', (stateChange) => {
                clearTimeout(timeout);
                reject(new Error(`Ably connection failed: ${stateChange?.reason?.message ?? 'unknown error'}`));
            });
            this.client.connection.on('suspended', () => {
                this.log('Connection suspended');
                this._isConnected = false;
            });
            this.client.connection.on('disconnected', () => {
                this.log('Connection disconnected');
                this._isConnected = false;
            });
        });
        await this.channel.subscribe((message) => this.handleMessage(message.data));
        await this.channel.presence.enter();
    }
    async disconnect() {
        this.log('Disconnecting...');
        if (this.channel) {
            try {
                await this.channel.presence.leave();
            }
            catch (error) {
                this.log('Error leaving presence:', error);
            }
            this.channel.unsubscribe();
            this.channel = null;
        }
        if (this.client) {
            this.client.close();
            this.client = null;
        }
        this._isConnected = false;
        this.messageCallback = undefined;
        this.messageBuffer = [];
        this.chunkBuffer.clear();
    }
    send(data) {
        if (!this.channel || !this._isConnected) {
            this.log('Cannot send: not connected');
            return;
        }
        const payload = stripCRC32Header(data);
        const base64Data = uint8ToBase64(payload);
        if (base64Data.length > MAX_MESSAGE_SIZE) {
            this.sendChunked(base64Data, payload.length);
            return;
        }
        this.channel.publish(EVENT_NAME, base64Data).catch((error) => {
            this.log('Publish error:', error);
        });
    }
    onMessage(callback) {
        this.messageCallback = callback;
        if (this.messageBuffer.length > 0) {
            for (const data of this.messageBuffer) {
                callback(data);
            }
            this.messageBuffer = [];
        }
        return () => {
            this.messageCallback = undefined;
        };
    }
    /** Get the clientIds of other peers currently present on the channel. */
    async getPresence() {
        if (!this.channel || !this._isConnected) {
            return [];
        }
        try {
            const members = await this.channel.presence.get();
            return members
                .map((m) => m.clientId)
                .filter((id) => id !== this.clientId);
        }
        catch (error) {
            this.log('Error getting presence:', error);
            return [];
        }
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    sendChunked(base64Data, originalSize) {
        const chunkId = generateUUID();
        const chunks = [];
        for (let i = 0; i < base64Data.length; i += MAX_MESSAGE_SIZE) {
            chunks.push(base64Data.slice(i, i + MAX_MESSAGE_SIZE));
        }
        this.log(`Splitting ${originalSize} bytes into ${chunks.length} chunks (id: ${chunkId.slice(0, 8)}...)`);
        chunks.forEach((chunk, index) => {
            const message = { chunked: true, id: chunkId, index, total: chunks.length, data: chunk };
            this.channel.publish(EVENT_NAME, message).catch((error) => {
                this.log(`Failed to send chunk ${index + 1}:`, error);
            });
        });
    }
    handleChunkedMessage(message) {
        const { id, index, total, data } = message;
        if (!this.chunkBuffer.has(id)) {
            this.chunkBuffer.set(id, new Map());
        }
        const chunks = this.chunkBuffer.get(id);
        chunks.set(index, data);
        if (chunks.size !== total)
            return;
        let base64Data = '';
        for (let i = 0; i < total; i++) {
            const chunk = chunks.get(i);
            if (!chunk) {
                this.log(`Missing chunk ${i}, cannot reassemble message ${id}`);
                this.chunkBuffer.delete(id);
                return;
            }
            base64Data += chunk;
        }
        this.chunkBuffer.delete(id);
        try {
            const raw = base64ToUint8(base64Data);
            this.deliver(addCRC32Header(raw));
        }
        catch (error) {
            this.log('Error reassembling chunked message:', error);
        }
    }
    handleMessage(data) {
        try {
            if (data && typeof data === 'object' && data.chunked) {
                this.handleChunkedMessage(data);
                return;
            }
            if (typeof data !== 'string')
                return;
            const raw = base64ToUint8(data);
            this.deliver(addCRC32Header(raw));
        }
        catch (error) {
            this.log('Error handling message:', error);
        }
    }
    deliver(data) {
        if (this.messageCallback) {
            this.messageCallback(data);
        }
        else {
            this.messageBuffer.push(data);
        }
    }
    log(...args) {
        if (this.debug) {
            console.log('[AblyTransport]', ...args);
        }
    }
}
//# sourceMappingURL=index.js.map