/**
 * Nostr Transport Provider
 *
 * Serverless, decentralised synchronisation using the Nostr protocol.
 * Binary Yjs updates (the provider's frame, untouched) are base64-encoded and published as signed Nostr events
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
 * - Optional persistent mode: durable full-document snapshots via NIP-01
 *   addressable events, so a late joiner can catch up with no live peer
 *   and no relay-side history needed (see README.md)
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
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { splitChunks, isChunk, ChunkAssembler } from '../chunking';
// Common relays (strfry default) cap an event at 64 KiB; content is the
// base64 payload, tags and signature add a few hundred bytes.
const MAX_CONTENT_CHARS = 60000;
// GenericProvider's frame type for a full-state push (see src/index.ts) -
// not exported from core, mirrored here the same way supabase/index.ts does.
const MESSAGE_SYNC_PUSH = 6;
// ---------------------------------------------------------------------------
// CRC32 helper (GenericProvider wraps every frame with a CRC32 header;
// see supabase/index.ts's identical helper)
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
/**
 * Wrap a message the way GenericProvider expects to receive one from this
 * transport: a leading uncompressed(0) flag byte, then the usual CRC32
 * header. The flag byte is only part of the wire format when
 * compressionThresholdBytes is active on the receiving GenericProvider -
 * which, for this transport, is the case by default, since
 * `preferredCompressMinBytes` (declared below) becomes that default unless
 * a caller explicitly passes `compressionThresholdBytes: 0`. Persistent
 * mode's synthetic snapshot frame doesn't go through GenericProvider's own
 * send-side encoding (unlike the live channel's frames, which arrive with
 * this flag already baked in), so it has to add it by hand - this bit the
 * exact bug supabase/index.ts's persistence flags too (see that file's
 * comment on not setting `preferredCompressMinBytes`), just guaranteed to
 * be hit here since this transport always hints compression.
 */
function wrapFrame(data) {
    const crc = _crc32(data);
    const wrapped = new Uint8Array(5 + data.length);
    wrapped[1] = (crc >>> 24) & 0xff;
    wrapped[2] = (crc >>> 16) & 0xff;
    wrapped[3] = (crc >>> 8) & 0xff;
    wrapped[4] = crc & 0xff;
    wrapped.set(data, 5);
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
    'wss://nostr.mom',
];
// ---------------------------------------------------------------------------
// Persistent mode: durable Yjs snapshots via NIP-01 addressable events
// (kind 30000-39999 - a relay keeps only the latest event per (kind,
// pubkey, `d` tag), unlike the ephemeral live-update kind above, which
// relays are free to drop entirely). See README.md's "Persistent mode".
// ---------------------------------------------------------------------------
// An addressable-range kind, arbitrary but documented - not reserved by any
// well-known NIP as of this writing.
const DEFAULT_PERSISTENT_KIND = 30078;
// A snapshot bigger than this many chunks is skipped (a warning is logged)
// rather than published incomplete - see README.md for the size this bounds
// (MAX_SNAPSHOT_CHUNKS * MAX_CONTENT_CHARS base64 chars) and the upgrade
// path (a two-phase fetch that learns the real total instead of guessing
// a fixed candidate range).
const MAX_SNAPSHOT_CHUNKS = 20;
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
        // Persistent mode (see NostrConfig.persistent)
        this.persistentMode = false;
        this.doc = null;
        this.persistentKind = DEFAULT_PERSISTENT_KIND;
        this.persistDebounceMs = 2000;
        this.isPublishingSnapshot = false;
        this.publishPending = false;
        this.snapshotSub = null;
        this.snapshotChunks = new ChunkAssembler();
        this._onDocUpdate = () => this._queueSnapshotPublish();
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
        this.sub = this.pool.subscribeMany(this.relays, filter, {
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
                    // The frame goes through untouched (CRC32 wrapper, and the
                    // compression flag when compressionThresholdBytes is on): a
                    // transport that strips and re-adds the header cannot carry a
                    // compressed frame.
                    this._deliver(base64ToUint8Array(content));
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
        // Persistent mode: fetch the durable snapshot (if any) and start
        // publishing new ones on doc changes. Additive to the live subscription
        // above, never a replacement for it.
        this.persistentMode = config.persistent ?? false;
        if (this.persistentMode) {
            if (!config.doc) {
                throw new Error('NostrTransport: config.doc is required when persistent is true');
            }
            this.doc = config.doc;
            this.persistentKind = config.persistentKind ?? DEFAULT_PERSISTENT_KIND;
            this.persistDebounceMs = config.persistDebounceMs ?? 2000;
            const snapshotDTags = Array.from({ length: MAX_SNAPSHOT_CHUNKS }, (_, i) => `${this.roomTag}#${i}`);
            this.snapshotSub = this.pool.subscribeMany(this.relays, { kinds: [this.persistentKind], '#d': snapshotDTags }, {
                onevent: (event) => {
                    try {
                        const parsed = JSON.parse(event.content);
                        if (!isChunk(parsed))
                            return;
                        const whole = this.snapshotChunks.push(parsed);
                        if (whole === null)
                            return;
                        const update = base64ToUint8Array(whole);
                        const enc = encoding.createEncoder();
                        encoding.writeVarUint(enc, MESSAGE_SYNC_PUSH);
                        encoding.writeVarUint8Array(enc, update);
                        this._deliver(wrapFrame(encoding.toUint8Array(enc)));
                        if (debug)
                            console.log('[NostrTransport] Applied persisted snapshot,', update.length, 'bytes');
                    }
                    catch (err) {
                        console.warn('[NostrTransport] Failed to decode snapshot event:', err);
                    }
                },
            });
            this.doc.on('update', this._onDocUpdate);
        }
        if (debug) {
            console.log('[NostrTransport] Connected, pubkey:', this.pubkey);
        }
    }
    disconnect() {
        if (this.sub) {
            this.sub.close();
            this.sub = null;
        }
        if (this.snapshotSub) {
            this.snapshotSub.close();
            this.snapshotSub = null;
        }
        if (this.doc) {
            this.doc.off('update', this._onDocUpdate);
            this.doc = null;
        }
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        this.persistentMode = false;
        this.publishPending = false;
        this.snapshotChunks.clear();
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
        const base64 = uint8ArrayToBase64(data);
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
    // ---------------------------------------------------------------------------
    // Persistent mode: publish the doc as one or more addressable events
    // ---------------------------------------------------------------------------
    _queueSnapshotPublish() {
        if (this.persistTimer)
            clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => this._publishSnapshot(), this.persistDebounceMs);
    }
    /**
     * Publish the whole doc as one snapshot, always through the chunk
     * envelope (even a single part) - see README.md's "Persistent mode" for
     * why: it keeps exactly one addressing scheme (`${roomTag}#${index}`)
     * regardless of how many parts a given snapshot needs, so an older
     * differently-sized snapshot's slots are always overwritten rather than
     * left stale alongside a newer one under a different address.
     */
    async _publishSnapshot() {
        if (!this.pool || !this.doc)
            return;
        if (this.isPublishingSnapshot) {
            this.publishPending = true;
            return;
        }
        this.isPublishingSnapshot = true;
        this.publishPending = false;
        try {
            const base64 = uint8ArrayToBase64(Y.encodeStateAsUpdate(this.doc));
            const parts = splitChunks(base64, MAX_CONTENT_CHARS);
            if (parts.length > MAX_SNAPSHOT_CHUNKS) {
                console.warn(`[NostrTransport] Snapshot needs ${parts.length} chunks, more than MAX_SNAPSHOT_CHUNKS ` +
                    `(${MAX_SNAPSHOT_CHUNKS}); skipping this publish. The live update channel still keeps ` +
                    'connected peers in sync; the next smaller snapshot will catch late joiners up again.');
                return;
            }
            for (const part of parts) {
                const event = this.opts.finalizeEvent({
                    kind: this.persistentKind,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['d', `${this.roomTag}#${part.index}`]],
                    content: JSON.stringify(part),
                }, this.secretKey);
                await Promise.allSettled(this.pool.publish(this.relays, event));
            }
        }
        catch (err) {
            console.warn('[NostrTransport] Failed to publish snapshot:', err);
        }
        finally {
            this.isPublishingSnapshot = false;
            if (this.publishPending)
                this._queueSnapshotPublish();
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