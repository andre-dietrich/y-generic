/**
 * Nostr Transport Provider
 *
 * Serverless, decentralised synchronisation using the Nostr protocol.
 * Binary Yjs updates are base64-encoded and published as signed Nostr events
 * to one or more relays. Every connected client subscribes to the same room tag,
 * so updates fan out through all configured relays automatically.
 *
 * Features:
 * - No server setup required (uses public relays or your own)
 * - Multi-relay fan-out for redundancy
 * - Ephemeral or persistent identity (bring-your-own key pair)
 * - Optional password to obfuscate the room tag (SHA-256)
 * - Configurable history window to catch up on missed updates
 * - Automatic deduplication (events from self are ignored)
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { NostrTransport } from 'y-generic/providers/nostr'
 * import { finalizeEvent, getPublicKey, SimplePool } from 'nostr-tools'
 *
 * const doc = new Y.Doc()
 * const transport = new NostrTransport({ finalizeEvent, getPublicKey, SimplePool })
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   room: 'my-doc',
 *   relays: ['wss://relay.damus.io', 'wss://nos.lol'],
 * })
 * ```
 *
 * @example
 * ```typescript
 * // With a persistent identity and password-protected room
 * import { generateSecretKey } from 'nostr-tools/pure'
 *
 * const secretKey = generateSecretKey()  // persist this to keep identity
 * const transport = new NostrTransport({ finalizeEvent, getPublicKey, SimplePool, secretKey })
 *
 * await provider.connect({
 *   room: 'my-doc',
 *   password: 'secret',
 *   relays: ['wss://relay.damus.io'],
 *   historyWindowSecs: 3600,  // fetch last hour of updates on connect
 * })
 * ```
 */
import { splitChunks, isChunk, ChunkAssembler } from '../chunking';
// Common relays (strfry default) cap an event at 64 KiB; content is the
// base64 payload, tags and signature add a few hundred bytes.
const MAX_CONTENT_CHARS = 60000;
// ---------------------------------------------------------------------------
// CRC32 translation helpers
//
// GenericProvider wraps every outgoing message as [CRC32 (4 bytes)][payload].
// Nostr event content is plain text (base64), so we strip the CRC32 header
// before encoding and re-add it after decoding so GenericProvider accepts the
// incoming message.
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
function uint8ArrayToBase64(data) {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
        binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
}
function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
// ---------------------------------------------------------------------------
// Password hashing (obfuscates room tag — not encryption)
// ---------------------------------------------------------------------------
async function hashPassword(password) {
    const encoded = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .substring(0, 16);
}
// ---------------------------------------------------------------------------
// Nostr event kind for Yjs collaboration events.
//
// Kind 27370 is an application-specific kind chosen to avoid collisions with
// any well-known NIPs. Relays treat it as a regular (stored) event so that
// peers joining later can catch up on missed updates.
// ---------------------------------------------------------------------------
const DEFAULT_KIND = 27370;
// Default public relays used when no `relays` list is provided in config.
const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
];
// ---------------------------------------------------------------------------
// NostrTransport
// ---------------------------------------------------------------------------
/**
 * Nostr transport for y-generic.
 *
 * Publishes Yjs binary updates as base64-encoded Nostr events and subscribes
 * to matching events from peers. Works in both browser and Node.js environments.
 */
export class NostrTransport {
    constructor(opts) {
        /**
         * Every send() signs and publishes its own event to every configured
         * relay with no internal coalescing. Recommends GenericProvider debounce
         * rapid edits by default to cut down on signing overhead and relay
         * round trips.
         */
        this.preferredBatchMs = 150;
        // 64 KiB per event on the common relays: compress first, chunk after.
        this.preferredCompressMinBytes = 2048;
        // Relay round trip incl. signature verification: a few hundred ms.
        this.expectedRttMs = 600;
        this._connected = false;
        this._buffer = [];
        this._chunks = new ChunkAssembler();
        this.pool = null;
        this.sub = null;
        this.relays = [];
        this.pubkey = '';
        this.roomTag = '';
        this.opts = opts;
        this.eventKind = opts.eventKind ?? DEFAULT_KIND;
        // Use provided key or an initial placeholder; real key resolved on connect.
        this.secretKey = opts.secretKey ?? new Uint8Array(32);
    }
    get isConnected() {
        return this._connected;
    }
    // ---------------------------------------------------------------------------
    // Transport interface
    // ---------------------------------------------------------------------------
    async connect(config) {
        if (this._connected) {
            throw new Error('NostrTransport: already connected');
        }
        const debug = config.debug ?? this.opts.debug ?? false;
        this.relays =
            config.relays && config.relays.length > 0 ? config.relays : DEFAULT_RELAYS;
        // Resolve signing key
        if (this.opts.secretKey) {
            this.secretKey = this.opts.secretKey;
        }
        else {
            // Ephemeral key — unique per transport instance lifetime
            this.secretKey = crypto.getRandomValues(new Uint8Array(32));
        }
        this.pubkey = this.opts.getPublicKey(this.secretKey);
        // Compute room tag (optionally obfuscated by password)
        this.roomTag = config.password
            ? `${config.room}-${await hashPassword(config.password)}`
            : config.room;
        const historyWindowSecs = config.historyWindowSecs ?? 86400;
        const since = historyWindowSecs > 0
            ? Math.floor(Date.now() / 1000) - historyWindowSecs
            : Math.floor(Date.now() / 1000); // real-time only
        const filter = {
            kinds: [this.eventKind],
            '#r': [this.roomTag],
            since,
        };
        this.pool = new this.opts.SimplePool();
        if (debug) {
            console.log('[NostrTransport] Connecting. relays:', this.relays, 'room:', this.roomTag, 'kind:', this.eventKind, 'filter.since:', since);
        }
        // Subscribe to events matching our room. The subscription delivers both
        // stored (historical) events first, then real-time new events.
        this.sub = this.pool.subscribeMany(this.relays, [filter], {
            onevent: (event) => {
                // Ignore events published by this client to avoid echo
                if (event.pubkey === this.pubkey)
                    return;
                if (debug) {
                    console.log('[NostrTransport] Received event', event.id.substring(0, 8), 'from', event.pubkey.substring(0, 8));
                }
                try {
                    let content = event.content;
                    if (content.startsWith('{')) {
                        const parsed = JSON.parse(content);
                        if (!isChunk(parsed))
                            return;
                        const whole = this._chunks.push(parsed);
                        if (whole === null)
                            return;
                        content = whole;
                    }
                    const raw = base64ToUint8Array(content);
                    const withHeader = addCRC32Header(raw);
                    this._deliver(withHeader);
                }
                catch (err) {
                    console.warn('[NostrTransport] Failed to decode event content:', err);
                }
            },
            oneose: () => {
                if (debug) {
                    console.log('[NostrTransport] EOSE — stored events delivered');
                }
            },
        });
        this._connected = true;
        if (debug) {
            console.log('[NostrTransport] Connected, pubkey:', this.pubkey);
        }
    }
    disconnect() {
        if (this.sub) {
            this.sub.close();
            this.sub = null;
        }
        if (this.pool) {
            this.pool.close(this.relays);
            this.pool = null;
        }
        this._connected = false;
        this._buffer = [];
    }
    async send(data) {
        if (!this._connected || !this.pool) {
            console.warn('[NostrTransport] Cannot send: not connected');
            return;
        }
        // Strip the 4-byte CRC32 header added by GenericProvider before encoding
        const raw = stripCRC32Header(data);
        const base64 = uint8ArrayToBase64(raw);
        // Above the relays' event size cap: one event per chunk.
        const contents = base64.length > MAX_CONTENT_CHARS
            ? splitChunks(base64, MAX_CONTENT_CHARS).map((c) => JSON.stringify(c))
            : [base64];
        for (const content of contents) {
            const event = this.opts.finalizeEvent({
                kind: this.eventKind,
                created_at: Math.floor(Date.now() / 1000),
                // Tag `r` is used as the room/document identifier for filtering
                tags: [['r', this.roomTag]],
                content,
            }, this.secretKey);
            // Publish to all relays; ignore individual relay errors
            await Promise.allSettled(this.pool.publish(this.relays, event));
        }
    }
    onMessage(callback) {
        this._callback = callback;
        // Flush buffered messages that arrived before this registration
        if (this._buffer.length > 0) {
            for (const msg of this._buffer) {
                callback(msg);
            }
            this._buffer = [];
        }
        return () => {
            this._callback = undefined;
        };
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    _deliver(data) {
        if (this._callback) {
            this._callback(data);
        }
        else {
            // Buffer messages that arrive before onMessage() is registered
            this._buffer.push(data);
        }
    }
}
//# sourceMappingURL=index.js.map