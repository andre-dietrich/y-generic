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
import { watchPageBack } from '../resume';
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
// A relay closed our subscription: subscribe again after 1 s, doubling up to
// 30 s while it keeps failing (see _subscribe()).
const RESUBSCRIBE_MIN_MS = 1000;
const RESUBSCRIBE_MAX_MS = 30000;
// Event ids remembered to drop the copies the other relays deliver.
const MAX_SEEN_EVENT_IDS = 2000;
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
// disconnect() closes the pool once a pending snapshot is answered, or after this.
const SNAPSHOT_CLOSE_WAIT_MS = 3000;
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
        // One subscription per relay, see _subscribe()
        this.subs = new Map();
        this._resubscribeTimers = new Map();
        this._resubscribeAttempts = new Map();
        this._seenEventIds = new Set();
        this._filter = {};
        this._debug = false;
        // Relays that hold our subscription right now; none left = deaf
        this._hearing = new Set();
        this._deaf = false;
        this.relays = [];
        this.pubkey = '';
        this.roomTag = '';
        // Persistent mode (see NostrConfig.persistent)
        this.persistentMode = false;
        this.doc = null;
        this.persistentKind = DEFAULT_PERSISTENT_KIND;
        this.persistDebounceMs = 2000;
        this.persistMaxWaitMs = 10000;
        // When the oldest change the pending snapshot is for was made; 0 = none pending
        this.persistPendingSince = 0;
        // created_at of the last snapshot published, see _publishSnapshotNow
        this.lastSnapshotAt = 0;
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
        this._filter = filter;
        this._debug = debug;
        this._connected = true;
        for (const url of this.relays)
            this._subscribe(url);
        // Somebody looks at the page again, or the network is back: not the
        // moment to sit out a backoff (see _resubscribeNow). Browser only.
        this._stopPageWatch = watchPageBack(() => this._resubscribeNow());
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
            this.persistMaxWaitMs = config.persistMaxWaitMs ?? 10000;
            this.sealFrame = config.sealFrame;
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
                        const bytes = base64ToUint8Array(whole);
                        if (parsed.sealed) {
                            // A frame sealed by the wrapper above us (see sealFrame): it opens it.
                            this._deliver(bytes);
                        }
                        else {
                            const enc = encoding.createEncoder();
                            encoding.writeVarUint(enc, MESSAGE_SYNC_PUSH);
                            encoding.writeVarUint8Array(enc, bytes);
                            this._deliver(wrapFrame(encoding.toUint8Array(enc)));
                        }
                        if (debug)
                            console.log('[NostrTransport] Applied persisted snapshot,', bytes.length, 'bytes');
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
        this._connected = false; // first: closing a subscription fires its onclose
        this._stopPageWatch?.();
        this._stopPageWatch = undefined;
        for (const timer of this._resubscribeTimers.values())
            clearTimeout(timer);
        this._resubscribeTimers.clear();
        this._resubscribeAttempts.clear();
        for (const sub of this.subs.values())
            sub.close();
        this.subs.clear();
        this._seenEventIds.clear();
        this._hearing.clear();
        this._deaf = false;
        if (this.snapshotSub) {
            this.snapshotSub.close();
            this.snapshotSub = null;
        }
        // A snapshot still in its debounce is published before the sockets
        // close, not dropped: provider.destroy() 300 ms after an edit left the
        // room without it (test/nostr/repro-persistent.mjs, part 3).
        const pool = this.pool;
        const published = this._snapshotPending() ? this._publishSnapshotNow() : null;
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
        this.persistPendingSince = 0;
        this.sealFrame = undefined;
        this.snapshotChunks.clear();
        if (pool) {
            const relays = this.relays;
            if (published) {
                // Until the relays have answered, or gave no answer in time.
                const timeout = new Promise((resolve) => setTimeout(resolve, SNAPSHOT_CLOSE_WAIT_MS));
                Promise.race([published, timeout]).then(() => pool.close(relays));
            }
            else {
                pool.close(relays);
            }
            this.pool = null;
        }
        this._connected = false;
        this._buffer = [];
    }
    /**
     * Subscribe to the room on ONE relay, and again whenever that relay closes
     * the subscription. nostr-tools closes a relay's subscriptions for good
     * when its socket closes - a relay restart, a frozen page (Chrome closes
     * its WebSockets), a network switch - and reports a relay that was not
     * reachable at connect the same way, while publish() re-opens the socket
     * each time: the peer kept sending and never heard anybody again
     * (test/nostr/repro-relay-restart.mjs; the pool's own enableReconnect
     * gives up on a socket that reports `error` before `close`, which is what
     * a killed relay produces). Per relay, because one subscription over all
     * relays reports a close only once EVERY relay has closed it - until then
     * the room's redundancy shrinks silently. The price: each event arrives
     * once per relay, so the ids are deduplicated here instead of in the pool.
     * The filter's `since` stays that of connect(): a relay that stores the
     * kind replays what was missed (and what was not - Yjs does not mind).
     */
    _subscribe(url) {
        if (!this._connected || !this.pool)
            return;
        let closed = false;
        const sub = this.pool.subscribeMany([url], this._filter, {
            onevent: (event) => {
                // Ignore events published by this client to avoid echo
                if (event.pubkey === this.pubkey)
                    return;
                if (this._seenEventIds.has(event.id))
                    return;
                this._seenEventIds.add(event.id);
                if (this._seenEventIds.size > MAX_SEEN_EVENT_IDS) {
                    this._seenEventIds.delete(this._seenEventIds.values().next().value);
                }
                if (this._debug) {
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
            // nostr-tools reports a close - a relay it could not even reach - as
            // an EOSE first, then as the close, in the same tick: only an EOSE
            // that is still open a microtask later is the relay answering.
            oneose: () => queueMicrotask(() => {
                if (closed || !this._connected)
                    return;
                this._resubscribeAttempts.delete(url); // back to the short delay
                this._hearing.add(url);
                if (this._debug) {
                    console.log('[NostrTransport] EOSE — stored events delivered', url);
                }
                // We hear the room again, which is not knowing what it said
                // meanwhile (an ephemeral kind is not stored): the provider asks.
                if (this._deaf) {
                    this._deaf = false;
                    this._peerConnectCallback?.(url);
                }
            }),
            onclose: (reasons) => {
                closed = true;
                if (!this._connected || this.subs.get(url) !== sub)
                    return; // disconnect(), or replaced
                this._hearing.delete(url);
                if (this._hearing.size === 0)
                    this._deaf = true;
                const attempt = this._resubscribeAttempts.get(url) ?? 0;
                this._resubscribeAttempts.set(url, attempt + 1);
                const delay = Math.min(RESUBSCRIBE_MAX_MS, RESUBSCRIBE_MIN_MS * 2 ** attempt);
                if (this._debug) {
                    console.log('[NostrTransport] Subscription closed by', url, reasons, '- again in', delay, 'ms');
                }
                clearTimeout(this._resubscribeTimers.get(url));
                this._resubscribeTimers.set(url, setTimeout(() => {
                    this._resubscribeTimers.delete(url); // what is in the map is waiting
                    this._subscribe(url);
                }, delay));
            },
        });
        this.subs.set(url, sub);
    }
    /**
     * A subscription is waiting in its backoff - subscribe now. A real phone
     * (Chrome on Android, test/e2e/phone-session.mjs nostr): with the display
     * off every attempt fails and the backoff climbs to 30 s; the page came
     * back 0.2 s before an attempt failed once more - "again in 30000 ms" -
     * and had the first missed text after 30.3 s, against 0.4 s when a timer
     * happened to be due (test/nostr/repro-relay-restart.mjs, part 4: 13.2 s).
     * The counters start over as well: an attempt that is in the air at that
     * moment and fails is repeated after 1 s, not after what the dark had
     * run up.
     */
    _resubscribeNow() {
        if (!this._connected)
            return;
        this._resubscribeAttempts.clear();
        const waiting = Array.from(this._resubscribeTimers.keys());
        for (const url of waiting) {
            clearTimeout(this._resubscribeTimers.get(url));
            this._resubscribeTimers.delete(url);
            if (this._debug)
                console.log('[NostrTransport] Page is back - subscribing now', url);
            this._subscribe(url);
        }
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
        const now = Date.now();
        if (!this.persistPendingSince)
            this.persistPendingSince = now;
        if (this.persistTimer)
            clearTimeout(this.persistTimer);
        // Debounced, but never beyond persistMaxWaitMs after the oldest change.
        const delay = Math.max(0, Math.min(this.persistDebounceMs, this.persistPendingSince + this.persistMaxWaitMs - now));
        this.persistTimer = setTimeout(() => this._publishSnapshot(), delay);
    }
    /** A change the relays have no snapshot of yet: in the debounce, or behind a publish in flight. */
    _snapshotPending() {
        return this.persistentMode && !!this.doc && (this.persistTimer !== undefined || this.publishPending);
    }
    async _publishSnapshot() {
        this.persistTimer = undefined;
        if (!this.pool || !this.doc)
            return;
        if (this.isPublishingSnapshot) {
            this.publishPending = true;
            return;
        }
        this.isPublishingSnapshot = true;
        this.publishPending = false;
        try {
            await this._publishSnapshotNow();
        }
        finally {
            this.isPublishingSnapshot = false;
            if (this.publishPending)
                this._queueSnapshotPublish();
        }
    }
    /**
     * Publish the whole doc as one snapshot, always through the chunk
     * envelope (even a single part) - see README.md's "Persistent mode" for
     * why: it keeps exactly one addressing scheme (`${roomTag}#${index}`)
     * regardless of how many parts a given snapshot needs, so an older
     * differently-sized snapshot's slots are always overwritten rather than
     * left stale alongside a newer one under a different address.
     *
     * Every event is signed and handed to the pool in the calling task (the
     * sockets' sends follow in its microtasks) - what flush() and disconnect()
     * need - and resolves once the relays answered. `created_at` only ever
     * grows: a relay keeps, of two events of one address in the same second,
     * the one with the LOWER id (NIP-01), which is a coin toss between an
     * older and a newer snapshot, and per chunk a torn mix of two.
     */
    _publishSnapshotNow() {
        this.persistPendingSince = 0;
        if (!this.pool || !this.doc)
            return Promise.resolve();
        try {
            let bytes = Y.encodeStateAsUpdate(this.doc);
            const sealed = !!this.sealFrame;
            if (this.sealFrame) {
                // The frame as it is delivered (see connect()), sealed as the wrapper seals a sent one.
                const enc = encoding.createEncoder();
                encoding.writeVarUint(enc, MESSAGE_SYNC_PUSH);
                encoding.writeVarUint8Array(enc, bytes);
                bytes = this.sealFrame(wrapFrame(encoding.toUint8Array(enc)));
            }
            const parts = splitChunks(uint8ArrayToBase64(bytes), MAX_CONTENT_CHARS);
            if (parts.length > MAX_SNAPSHOT_CHUNKS) {
                console.warn(`[NostrTransport] Snapshot needs ${parts.length} chunks, more than MAX_SNAPSHOT_CHUNKS ` +
                    `(${MAX_SNAPSHOT_CHUNKS}); skipping this publish. The live update channel still keeps ` +
                    'connected peers in sync; the next smaller snapshot will catch late joiners up again.');
                return Promise.resolve();
            }
            this.lastSnapshotAt = Math.max(Math.floor(Date.now() / 1000), this.lastSnapshotAt + 1);
            const published = [];
            for (const part of parts) {
                const event = this.opts.finalizeEvent({
                    kind: this.persistentKind,
                    created_at: this.lastSnapshotAt,
                    tags: [['d', `${this.roomTag}#${part.index}`]],
                    content: JSON.stringify(sealed ? { ...part, sealed } : part),
                }, this.secretKey);
                published.push(...this.pool.publish(this.relays, event));
            }
            return Promise.allSettled(published);
        }
        catch (err) {
            console.warn('[NostrTransport] Failed to publish snapshot:', err);
            return Promise.resolve();
        }
    }
    /**
     * Transport.flush: the page is unloading. A snapshot still in its
     * debounce goes now - a page that goes runs no further timer, and the
     * last edit before a reload or a closed tab was missing from the room
     * (test/nostr/repro-persistent.mjs, part 2).
     */
    flush() {
        if (!this._snapshotPending())
            return;
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        this.publishPending = false;
        void this._publishSnapshotNow();
    }
    /**
     * Transport.onPeerConnect: fires when a relay holds our subscription again
     * after NONE did (relay restart, frozen page, no relay reachable at
     * connect) - not at the first subscription, not while another relay kept
     * delivering. The provider then announces itself and syncs: 5 of 25 pages
     * frozen for 20 s had the missed text 21.9 s after the unfreeze without
     * it, with whatever beacon came next.
     */
    onPeerConnect(callback) {
        this._peerConnectCallback = callback;
        return () => {
            this._peerConnectCallback = undefined;
        };
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