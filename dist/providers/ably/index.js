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
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { watchPageBack } from '../resume';
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
// ---------------------------------------------------------------------------
// Structural types for the injected Ably SDK surface (not the real `ably`
// types, so this file compiles without the package installed)
// ---------------------------------------------------------------------------
/** How long after the page's return a lost connection counts as one that died while the page was away. */
const PAGE_BACK_WINDOW_MS = 5000;
const EVENT_NAME = 'yjs-update';
// Ably's default max message size is ~64 KiB; stay well under it. Used both
// as a base64-string cap for send()'s pub/sub chunking, and as a raw-byte
// cap for the persistence snapshot's LiveMap chunking (LiveMap values are
// raw ArrayBuffer/Buffer, no base64 inflation, so the same conservative
// number is a safe threshold for both).
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
        this._pageBackAt = 0;
        this.messageBuffer = [];
        this.chunkBuffer = new Map();
        // No preferredCompressMinBytes: this transport strips the CRC32 header
        // and synthesizes frames from persisted snapshots, both of which assume
        // the uncompressed frame layout (see compressionThresholdBytes).
        // Persistence
        this.persistentMode = false;
        this.persistDoc = null;
        this.persistDebounceMs = 2000;
        this.persistMaxWaitMs = 10000;
        /** When the oldest change the pending snapshot is for was made; 0 = none pending */
        this.persistPendingSince = 0;
        /**
         * A snapshot is written for a change made HERE, not for one applied from
         * the room (Y.applyUpdate makes a transaction that is not local) - its
         * author writes that one. Told from the wire frame before, by its type
         * byte: behind an encrypting wrapper that byte is ciphertext, and every
         * presence change wrote a snapshot (test/ably/repro-liveobjects-persist.ts, 5).
         */
        this._onDocUpdate = (_u, _o, _d, tr) => {
            if (tr.local)
                this.queuePersist();
        };
        this.isWritingSnapshot = false;
        this.savePending = false;
        /** True once loadSnapshot()'s initial read has completed */
        this.snapshotLoaded = false;
        /** Cached LiveObjects root, resolved once per connect() */
        this.liveRoot = null;
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
        this.persistentMode = config.persistent ?? false;
        this.persistDoc = config.doc ?? null;
        this.persistDebounceMs = config.persistDebounceMs ?? 2000;
        this.persistMaxWaitMs = config.persistMaxWaitMs ?? 10000;
        this.sealFrame = config.sealFrame;
        if (this.persistentMode && !this.persistDoc) {
            throw new Error('AblyTransport: a Y.Doc must be provided via config.doc when persistent is true');
        }
        if (this.persistentMode && !this.opts.LiveObjects) {
            throw new Error('AblyTransport: the "LiveObjects" plugin class must be provided via constructor options when persistent is true. ' +
                'import { LiveObjects } from "ably/liveobjects"; new AblyTransport({ Realtime, LiveObjects })');
        }
        this.clientId = generateUUID();
        this.channelName = config.password
            ? `${config.room}-${await hashPassword(config.password)}`
            : config.room;
        // Don't deliver our own published messages back to ourselves — except
        // in persistent mode, where Ably's LiveObjects requires echoMessages to
        // be enabled for write operations (root.set() throws otherwise). Any
        // resulting self-echo of our own pub/sub messages is harmless:
        // GenericProvider applies updates idempotently under its own origin
        // sentinel, which also prevents re-broadcasting them.
        const clientOptions = {
            clientId: this.clientId,
            echoMessages: this.persistentMode,
            // A network that comes back silently is found only by ably-js's retry
            // (see AblyConfig.disconnectedRetryTimeout; repro-ably-lifecycle part 9).
            disconnectedRetryTimeout: config.disconnectedRetryTimeout ?? 5000,
            suspendedRetryTimeout: config.suspendedRetryTimeout ?? 10000,
        };
        if (config.apiKey)
            clientOptions.key = config.apiKey;
        if (config.authUrl)
            clientOptions.authUrl = config.authUrl;
        if (config.authMethod)
            clientOptions.authMethod = config.authMethod;
        if (this.persistentMode) {
            clientOptions.plugins = { LiveObjects: this.opts.LiveObjects };
        }
        this.log('Connecting as', this.clientId, 'to channel', this.channelName);
        this.client = new this.opts.Realtime(clientOptions);
        // Passing `modes` replaces the channel's default (unrestricted) mode set,
        // so the persistent path must explicitly list everything this transport
        // needs, not just the OBJECT_* modes LiveObjects requires. The
        // non-persistent path is left untouched (no modes option, as before).
        this.channel = this.persistentMode
            ? this.client.channels.get(this.channelName, {
                modes: [
                    'PUBLISH',
                    'SUBSCRIBE',
                    'PRESENCE',
                    'PRESENCE_SUBSCRIBE',
                    'OBJECT_PUBLISH',
                    'OBJECT_SUBSCRIBE',
                ],
            })
            : this.client.channels.get(this.channelName);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Ably connection timeout'));
            }, 10000);
            // on, not once: ably-js reconnects by itself (a network blip, a frozen
            // page, a phone out of the background) and 'disconnected' below clears
            // the flag - with once() the transport kept receiving and never sent
            // again (test/providers/repro-ably-lifecycle.ts).
            let everConnected = false;
            this.client.connection.on('connected', () => {
                clearTimeout(timeout);
                this._isConnected = true;
                this.log('Connected to Ably, connection', this.client?.connection?.id);
                // Back after an outage: what we produced meanwhile was not sent, and
                // after 15 s Ably reported our leave to the room. The provider
                // announces itself again and pushes what the room has not confirmed.
                if (everConnected)
                    this._peerConnectCallback?.('ably');
                everConnected = true;
                resolve();
            });
            // The page has its network again: not the moment to sit out ably-js's
            // retry (every 15 s, with a growing backoff; it dials at once on the
            // browser's `online` only). After a 45 s outage 25 browsers had the text
            // typed during it 28.6 s after the network was back, and a phone whose
            // WiFi returns while it is on mobile data gets no `online` at all
            // (repro-ably-lifecycle part 7, src/providers/resume.ts).
            //
            // At that moment the connection may still say 'connected': ably-js finds
            // the socket that died in the background a moment later (a real phone,
            // back from another app after 45 s: 135 ms later) and then waits out its
            // retry - 19.6 s out of the room. A 'disconnected' that soon after the
            // page's return is dialed at once as well (repro-ably-lifecycle part 8).
            this._stopPageWatch?.();
            this._stopPageWatch = watchPageBack(() => {
                this._pageBackAt = Date.now();
                this._dialIfDown('Page is back');
            });
            this.client.connection.on('failed', (stateChange) => {
                clearTimeout(timeout);
                reject(new Error(`Ably connection failed: ${stateChange?.reason?.message ?? 'unknown error'}`));
            });
            this.client.connection.on('suspended', () => {
                this.log('Connection suspended');
                this._isConnected = false;
                this._dialSoonAfterPageBack();
            });
            this.client.connection.on('disconnected', () => {
                this.log('Connection disconnected');
                this._isConnected = false;
                this._dialSoonAfterPageBack();
            });
        });
        await this.channel.subscribe((message) => {
            // In persistent mode, echoMessages is enabled (LiveObjects requires it
            // for writes) — filter out our own echoed pub/sub messages here so
            // they never reach GenericProvider, same as Gun's transport dedupes
            // its own writes before delivery. Otherwise a stale self-echo (hash
            // computed a moment before our own newer local edits) trips the
            // hash-mismatch resync check for no reason.
            if (message.clientId === this.clientId)
                return;
            // The publisher's clientId is the peer id GenericProvider learns as
            // `from` - the same id a presence leave reports (onPeerDisconnect).
            this.handleMessage(message.data, message.clientId);
        });
        await this._enterPresence();
        // Presence leave: a clean leave, or Ably's own removal after a dropped
        // connection's TTL. Delivered to every subscriber, so GenericProvider
        // drops the member's awareness without a broadcast burst and lets the
        // awareness lease default to 5 min (round 5, item 2). The client was
        // already a presence member (enter/leave above); this subscribes to the
        // events it ignored before.
        await this.channel.presence.subscribe('leave', (member) => {
            const id = member?.clientId;
            if (typeof id === 'string' && id !== this.clientId) {
                this.log('Peer left:', id, 'connection', member?.connectionId);
                this._peerDisconnectCallback?.(id);
            }
        });
        // Persistence: load any existing snapshot. Unlike Gun, there's no
        // "clear stale snapshot on non-persistent connect" step here — a plain
        // channel (no OBJECT_* modes) never attaches LiveObjects at all, so a
        // non-persistent connect has nothing to clear.
        this.snapshotLoaded = false;
        if (this.persistentMode) {
            this.liveRoot = await this.channel.object.get();
            this.loadSnapshot();
            this.persistDoc.on('update', this._onDocUpdate);
            // What this peer brings along (edits made offline, a local copy)
            // reaches the snapshot once the stored one is merged - saveSnapshot
            // waits for that.
            this.queuePersist();
        }
    }
    /**
     * Presence is what lets the room drop us the moment we leave - not a
     * reason to refuse the room. Ably rejects an enter like any message while
     * the channel is over its rate (42913, "nonfatal"; free tier: 50
     * messages/s): of 25 peers joining within 5 s, one failed to connect for
     * good (test/e2e/room-scenarios.mjs ably, twice in two runs). Never
     * throws; tries again until it holds, 1 s doubling up to 30 s, jittered.
     */
    async _enterPresence(attempt = 0) {
        const channel = this.channel;
        if (!channel)
            return;
        try {
            await channel.presence.enter();
        }
        catch (error) {
            if (this.channel !== channel)
                return; // disconnect() meanwhile
            const delay = Math.min(30000, 1000 * 2 ** attempt) * (0.5 + Math.random());
            this.log('presence.enter refused, again in', Math.round(delay), 'ms:', error);
            this._enterTimer = setTimeout(() => this._enterPresence(attempt + 1), delay);
        }
    }
    /** connect() now if ably-js is waiting out a retry. */
    _dialIfDown(why) {
        const connection = this.client?.connection;
        if (connection && (connection.state === 'disconnected' || connection.state === 'suspended')) {
            this.log(`${why}, dialing Ably now`);
            connection.connect?.();
        }
    }
    /** A connection lost within PAGE_BACK_WINDOW_MS of the page's return: the socket died while it was away. */
    _dialSoonAfterPageBack() {
        if (Date.now() - this._pageBackAt > PAGE_BACK_WINDOW_MS)
            return;
        // not from inside ably-js's own state-change event
        setTimeout(() => this._dialIfDown('Lost right after the page came back'), 0);
    }
    async disconnect() {
        this.log('Disconnecting...');
        clearTimeout(this._enterTimer);
        this._stopPageWatch?.();
        this._stopPageWatch = undefined;
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        this.persistDoc?.off('update', this._onDocUpdate);
        if (this.persistentMode && this.persistDoc) {
            try {
                await this.saveSnapshot();
            }
            catch (error) {
                this.log('Error flushing snapshot on disconnect:', error);
            }
        }
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
        this.persistentMode = false;
        this.persistDoc = null;
        this.persistPendingSince = 0;
        this.sealFrame = undefined;
        this.snapshotLoaded = false;
        this.liveRoot = null;
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
        }
        else {
            this._publish(base64Data);
        }
    }
    onMessage(callback) {
        this.messageCallback = callback;
        if (this.messageBuffer.length > 0) {
            for (const { data, from } of this.messageBuffer) {
                callback(data, from);
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
    // Persistence helpers (LiveObjects)
    // ---------------------------------------------------------------------------
    /** Schedule a debounced snapshot write - never beyond persistMaxWaitMs after the oldest change. */
    queuePersist() {
        const now = Date.now();
        if (!this.persistPendingSince)
            this.persistPendingSince = now;
        if (this.persistTimer)
            clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            this.saveSnapshot();
        }, Math.max(0, Math.min(this.persistDebounceMs, this.persistPendingSince + this.persistMaxWaitMs - now)));
    }
    /**
     * Transport.flush: the page is unloading. A snapshot still in its
     * debounce is written now - a page that goes runs no further timer, and
     * the last edit before a reload or a closed tab was missing from the room
     * (test/ably/repro-liveobjects-persist.ts, 6).
     */
    flush() {
        if (!this.persistTimer)
            return;
        clearTimeout(this.persistTimer);
        this.persistTimer = undefined;
        void this.saveSnapshot();
    }
    /**
     * Encode the full Y.Doc state as a SYNC_STEP_2 message and write it across
     * one or more LiveMap keys (each `set()` is capped at Ably's 64 KiB message
     * size, so a real snapshot needs chunking — see `snapshot-count`/`snapshot-N`
     * below). Chunk keys are written first, `snapshot-count` last, so a reader
     * can treat its presence as "this snapshot is complete."
     */
    async saveSnapshot() {
        if (!this.persistDoc || !this.persistentMode || !this.liveRoot)
            return;
        if (!this.snapshotLoaded) {
            // The initial LiveObjects read hasn't resolved yet — saving now could
            // clobber the real persisted state with our still-unmerged local doc.
            this.persistTimer = setTimeout(() => this.saveSnapshot(), 100);
            return;
        }
        if (this.isWritingSnapshot) {
            this.savePending = true;
            return;
        }
        this.isWritingSnapshot = true;
        this.savePending = false;
        this.persistPendingSince = 0;
        try {
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, 0); // MESSAGE_SYNC
            syncProtocol.writeSyncStep2(enc, this.persistDoc);
            let snapshotBytes = encoding.toUint8Array(enc);
            // Behind an encrypting wrapper (ConnectionConfig.sealFrame) the
            // snapshot is stored the way a sent frame travels - sealed, then
            // without the CRC32 header, as send() strips it - so loadSnapshot's
            // addCRC32Header hands the wrapper what it opens. Built under the
            // wrapper it was stored in the clear and dropped by the wrapper on
            // delivery (test/ably/repro-liveobjects-persist.ts, 4). Without one the
            // stored bytes are what they always were.
            if (this.sealFrame) {
                snapshotBytes = new Uint8Array(stripCRC32Header(this.sealFrame(addCRC32Header(snapshotBytes))));
            }
            const chunks = [];
            for (let i = 0; i < snapshotBytes.length; i += MAX_MESSAGE_SIZE) {
                const end = Math.min(i + MAX_MESSAGE_SIZE, snapshotBytes.length);
                chunks.push(snapshotBytes.buffer.slice(snapshotBytes.byteOffset + i, snapshotBytes.byteOffset + end));
            }
            await Promise.all(chunks.map((chunk, i) => this.liveRoot.set(`snapshot-${i}`, chunk)));
            await this.liveRoot.set('snapshot-count', chunks.length);
            this.log('Snapshot saved', snapshotBytes.length, 'bytes in', chunks.length, 'chunk(s)');
        }
        catch (error) {
            this.log('Error saving snapshot:', error.message);
            console.warn('AblyTransport: Failed to save snapshot. Will retry later.', error);
            this.savePending = true;
        }
        finally {
            this.isWritingSnapshot = false;
            if (this.savePending) {
                setTimeout(() => this.saveSnapshot(), 1000);
            }
        }
    }
    /**
     * Load the snapshot from LiveObjects and deliver it to the message
     * callback. Aborts without delivering anything if a chunk is missing —
     * partial data is worse than none.
     */
    async loadSnapshot() {
        if (!this.liveRoot)
            return;
        try {
            const count = this.liveRoot.get('snapshot-count').value();
            if (!count) {
                this.log('No snapshot found in LiveObjects');
                return;
            }
            const chunks = [];
            for (let i = 0; i < count; i++) {
                const chunk = this.liveRoot.get(`snapshot-${i}`).value();
                if (!chunk) {
                    this.log(`Missing chunk ${i}, cannot reassemble snapshot`);
                    return;
                }
                chunks.push(new Uint8Array(chunk));
            }
            const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
            const snapshotBytes = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                snapshotBytes.set(chunk, offset);
                offset += chunk.length;
            }
            if (snapshotBytes.length > 0) {
                this.deliver(addCRC32Header(snapshotBytes));
                this.log('Loaded snapshot:', snapshotBytes.length, 'bytes');
            }
        }
        catch (error) {
            this.log('Error loading snapshot:', error);
            console.warn('AblyTransport: Failed to load snapshot:', error);
        }
        finally {
            this.snapshotLoaded = true;
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
            this._publish({ chunked: true, id: chunkId, index, total: chunks.length, data: chunk });
        });
    }
    /**
     * Publish, and publish again what Ably REFUSED: over the channel's message
     * rate (free tier: 50/s) it rejects the publish - 42913 "Rate limit
     * exceeded; request rejected (nonfatal)", statusCode 429 - and tells us.
     * That is not a failed send to log: the message is lost for every receiver
     * at once, and only we can send it again. 25 browsers on one channel peak
     * at 56-84 messages/s while joining and 82-103 with five typing at once
     * (30-95 refusals per run): a refused keystroke took the room 2.5-10.6 s
     * to repair, a refused presence up to half a lease (172 s until all
     * rosters of a join were complete). The rate is per second, so the next
     * try is 1-2 s away, further each time, five times at most. Order does not
     * matter to Yjs updates or awareness states. Anything else is logged, as
     * before (a dropped connection: the provider's reconnect sync covers it).
     */
    _publish(message, attempt = 0) {
        const channel = this.channel;
        if (!channel)
            return;
        channel.publish(EVENT_NAME, message).catch((error) => {
            const refused = error?.code === 42913 || error?.statusCode === 429;
            if (!refused || attempt >= 5 || this.channel !== channel) {
                this.log('Publish error:', error);
                return;
            }
            const delay = (1000 + Math.random() * 1000) * (attempt + 1);
            this.log('Publish refused (rate limit), again in', Math.round(delay), 'ms');
            setTimeout(() => {
                if (this.channel === channel)
                    this._publish(message, attempt + 1); // not into another room
            }, delay);
        });
    }
    handleChunkedMessage(message, from) {
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
            this.deliver(addCRC32Header(raw), from);
        }
        catch (error) {
            this.log('Error reassembling chunked message:', error);
        }
    }
    handleMessage(data, from) {
        try {
            if (data && typeof data === 'object' && data.chunked) {
                this.handleChunkedMessage(data, from);
                return;
            }
            if (typeof data !== 'string')
                return;
            const raw = base64ToUint8(data);
            this.deliver(addCRC32Header(raw), from);
        }
        catch (error) {
            this.log('Error handling message:', error);
        }
    }
    deliver(data, from) {
        if (this.messageCallback) {
            this.messageCallback(data, from);
        }
        else {
            this.messageBuffer.push({ data, from });
        }
    }
    /**
     * Transport.onPeerConnect: fires when Ably's connection comes BACK
     * (never at the first connect) - see connect().
     */
    onPeerConnect(callback) {
        this._peerConnectCallback = callback;
        return () => {
            this._peerConnectCallback = undefined;
        };
    }
    /**
     * Transport.onPeerDisconnect: Ably presence 'leave' on the channel. Peer
     * ids are Ably clientIds, the same `from` onMessage passes.
     */
    onPeerDisconnect(callback) {
        this._peerDisconnectCallback = callback;
        return () => {
            this._peerDisconnectCallback = undefined;
        };
    }
    log(...args) {
        if (this.debug) {
            console.log('[AblyTransport]', ...args);
        }
    }
}
//# sourceMappingURL=index.js.map