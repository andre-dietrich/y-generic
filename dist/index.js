import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Observable } from 'lib0/observable';
import * as bc from 'lib0/broadcastchannel';
// Message type identifiers
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_PUBSUB = 2;
const MESSAGE_SYNC_VERIFIED = 3; // Sync message with hash verification
const MESSAGE_BATCH = 4; // Envelope for N independently-typed sub-messages sent as one wire message
// Digest beacon: replaces SyncStep1 on the wire. [version][flags][sender
// clientID][state vector][delete-set hash]. Receivers reply only when the
// sender is behind them or the delete-set hashes differ (SyncStep2, as
// before), or - on a JOIN-flagged beacon with equal state - with their own
// beacon as an ack; otherwise not at all. See
// docs/superpowers/specs/2026-09-05-digest-beacon-design.md and
// _handleDigest(). Versions are append-only: receivers read the fields
// they know and ignore trailing bytes.
const MESSAGE_SYNC_DIGEST = 5;
const DIGEST_VERSION = 1;
const DIGEST_FLAG_JOIN = 1; // bit 0: "I just joined - send me your presence and confirm my state"
// bit 1: this message is an ACK, not a request. It echoes the state vector
// and delete-set hash of the JOIN beacon it answers ("I hold exactly this
// state too"), never the sender's own state - so it is never read as a
// request and never collects a SyncStep2 from anyone. Receivers whose state
// equals the echoed digest mark themselves synced (the joiner it was for,
// and everyone else in that state); receivers holding a pending ack for the
// same digest drop it. See _handleDigest(). Before this flag existed the ack
// was the acker's own beacon; an acker that was itself behind the room (a
// joiner acking another joiner) made every peer ahead of it reply with a
// SyncStep2, and acks landing after an edit burst had started did the same
// (Task 3c in the design doc).
const DIGEST_FLAG_ACK = 2;
// bit 2: "ack me if our states are equal" WITHOUT the presence request of
// DIGEST_FLAG_JOIN. Sent only by the response-wait retry
// (_armResponseWait): a joiner that gets neither a SyncStep2 nor an ack
// within the wait has lost one message or the other and asks again - reply
// suppression deliberately leaves ~1 reply per request, so a single lost
// reply would otherwise strand the joiner's `synced` until the next
// periodic beacon (never, with syncInterval 0). Measured: the last joiner
// of a simultaneous 5-peer burst at 10% loss failed to reach `synced` in 1
// of 600 runs before this existed. Resync beacons do NOT request acks: in
// an equal room every peer would answer, and at high latency the
// suppression window cannot thin those replies (measured 4-5x more acks).
const DIGEST_FLAG_CONFIRM = 4;
// bit 3: the sender is CONFIRMED - it has received a SyncStep2, or an equal
// digest from a confirmed peer, or its own join asked three times and got
// nothing better (so it is the room). A joiner's response wait is satisfied
// only by data (SyncStep2) or by an equal digest carrying this bit: an
// equal ack from a fellow joiner says nothing about whether the room holds
// more than both of us, and treating it as an answer left a joiner whose
// SyncStep2 was lost with an empty document (measured: 1 of 150 lossy
// 15-peer joins; research doc item 13 follow-up in the phase-1b design).
const DIGEST_FLAG_SETTLED = 8;
// Full-state push (connect()/syncNow()): the whole document as one update,
// no hash, no sequence number, applied and nothing else. Before this type a
// push was a MESSAGE_SYNC_VERIFIED update whose hash was the PUSHER's state
// - every peer holding more data read that as divergence and scheduled a
// resync of its own (research doc item 12), the seed of the cascade in item
// 13. Not a SyncStep2 either: receiving one must not flip `synced` (an
// empty joiner's push says nothing about the room's content). See
// docs/superpowers/specs/2026-09-05-resync-cascade-design.md.
const MESSAGE_SYNC_PUSH = 6;
/**
 * CRC32 lookup table for fast computation.
 * Generated once and reused for all CRC calculations.
 */
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
        table[i] = crc;
    }
    return table;
})();
/**
 * Compute CRC32 checksum of data for message integrity verification.
 * Fast, non-cryptographic checksum optimized for corruption detection.
 */
function computeCRC32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
}
/**
 * Wrap message with CRC32 checksum for integrity verification.
 * Format: [CRC32 (4 bytes)][message data]
 */
function wrapMessageWithChecksum(message) {
    const crc = computeCRC32(message);
    const wrapped = new Uint8Array(4 + message.length);
    // Write CRC32 as 4 bytes (big-endian)
    wrapped[0] = (crc >>> 24) & 0xff;
    wrapped[1] = (crc >>> 16) & 0xff;
    wrapped[2] = (crc >>> 8) & 0xff;
    wrapped[3] = crc & 0xff;
    // Copy message data
    wrapped.set(message, 4);
    return wrapped;
}
/**
 * Unwrap and verify message integrity using CRC32 checksum.
 * Returns the message data if valid, null if corrupted.
 */
function unwrapAndVerifyMessage(wrapped) {
    if (wrapped.length < 4) {
        return null; // Too short to contain CRC32
    }
    // Read CRC32 (big-endian)
    const expectedCrc = ((wrapped[0] << 24) |
        (wrapped[1] << 16) |
        (wrapped[2] << 8) |
        wrapped[3]) >>>
        0;
    // Extract message data
    const message = wrapped.subarray(4);
    // Compute actual CRC32
    const actualCrc = computeCRC32(message);
    // Verify integrity
    if (actualCrc !== expectedCrc) {
        return null; // Checksum mismatch - message corrupted
    }
    return message;
}
/** Byte-wise equality of two Uint8Arrays. */
function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
/**
 * Componentwise minimum of two encoded state vectors: the state a
 * SyncStep2 must start from to serve both requesters. Clients missing from
 * one side count as clock 0 and are omitted (omitted = 0 on the wire).
 */
function minStateVector(a, b) {
    const ma = Y.decodeStateVector(a);
    const mb = Y.decodeStateVector(b);
    const out = new Map();
    for (const [client, clock] of ma) {
        const m = Math.min(clock, mb.get(client) ?? 0);
        if (m > 0)
            out.set(client, m);
    }
    return Y.encodeStateVector(out);
}
/**
 * Whether this runtime has the Compression Streams API (Node 18+, all
 * evergreen browsers). Checked once at module load; compressionThresholdBytes
 * falls back to sending uncompressed (still flag-byte-prefixed, flag=0) if
 * this is false, rather than throwing.
 */
const COMPRESSION_AVAILABLE = typeof CompressionStream !== 'undefined' &&
    typeof DecompressionStream !== 'undefined';
/** Drain a ReadableStream<Uint8Array> into a single concatenated Uint8Array. */
async function _readAllChunks(readable) {
    const chunks = [];
    const reader = readable.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        chunks.push(value);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
/**
 * Compress with deflate-raw (no gzip header/trailer - see
 * compressionThresholdBytes's doc comment for why deflate-raw over gzip).
 */
async function compressDeflateRaw(data) {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    return _readAllChunks(cs.readable);
}
/** Inverse of compressDeflateRaw(). */
async function decompressDeflateRaw(data) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    return _readAllChunks(ds.readable);
}
/**
 * Prepend a 1-byte compressed(1)/uncompressed(0) flag. Only used when
 * compressionThresholdBytes is configured - see that option's doc comment
 * for why this is a deliberate, opt-in wire-format change.
 */
function prefixCompressionFlag(flag, data) {
    const out = new Uint8Array(1 + data.length);
    out[0] = flag;
    out.set(data, 1);
    return out;
}
/**
 * Compute a cheap hash of document state for verification.
 *
 * Hashes the state VECTOR (each client's clock), not the full document
 * content — O(number of distinct clients) instead of O(document content
 * size). `Y.encodeStateVector()` writes entries sorted by clientID, so the
 * result is deterministic regardless of the internal Map's iteration order.
 * Two peers can only reach the same state vector by having applied the same
 * set of operations, so this still catches real content divergence; it just
 * no longer re-serializes the entire document on every single update.
 * (CRC32 already guards against wire corruption, and sequence tracking
 * guards against reordering/loss — this hash is the last line of defense
 * against logical divergence between peers.)
 */
function computeDocHash(doc) {
    const state = Y.encodeStateVector(doc);
    let hash = 0;
    for (let i = 0; i < state.length; i++) {
        hash = ((hash << 5) - hash + state[i]) | 0;
    }
    return hash;
}
/**
 * Cheap, peer-deterministic hash of the document's delete set - the half of
 * a Yjs document's identity that the state vector does NOT cover (yjs
 * INTERNALS.md: "deletions are tracked in the DeleteSet, and do not update
 * the state vector"). Two docs that differ only by a lost delete-only
 * update have identical state vectors, so `computeDocHash` can never
 * detect that divergence; this hash can, at heartbeat granularity (see
 * `_encodeSyncStep1()` / `_handleDigest()`).
 *
 * Cost: `Y.createDeleteSetFromStructStore` walks every struct (Yjs keeps no
 * incremental delete set), so this is O(items) - fine once per heartbeat
 * (every empty SyncStep2 already did this exact walk inside
 * `encodeStateAsUpdate`), NOT fine per update; hence the cache in
 * `_deleteSetHash()`. Per-client runs come out already sorted and merged;
 * the only per-peer non-determinism is `Map` insertion order, fixed by
 * sorting client IDs before hashing.
 *
 * Exported for the property check in test/dummy/bench-idle-room.ts.
 * @internal
 */
export function computeDeleteSetHash(doc) {
    const ds = Y.createDeleteSetFromStructStore(doc.store);
    const encoder = encoding.createEncoder();
    const clients = Array.from(ds.clients.keys()).sort((x, y) => x - y);
    for (const client of clients) {
        encoding.writeVarUint(encoder, client);
        for (const item of ds.clients.get(client)) {
            encoding.writeVarUint(encoder, item.clock);
            encoding.writeVarUint(encoder, item.len);
        }
    }
    return computeCRC32(encoding.toUint8Array(encoder));
}
/**
 * PubSub channel for real-time messaging alongside Yjs.
 * Allows sending ephemeral messages that don't need CRDT properties.
 */
export class PubSubChannel extends Observable {
    constructor(provider) {
        super();
        this.provider = provider;
    }
    /**
     * Publish a message to a topic.
     *
     * @param topic - Topic name (e.g., 'notifications', 'rpc', 'events')
     * @param message - Any JSON-serializable data
     *
     * @example
     * ```typescript
     * provider.pubsub.publish('chat', { user: 'Alice', text: 'Hello!' })
     * provider.pubsub.publish('cursor', { x: 100, y: 200 })
     * ```
     */
    publish(topic, message) {
        this.provider._sendPubSub(topic, message);
    }
    /**
     * Subscribe to messages on a topic.
     *
     * @param topic - Topic name to listen to (use '*' for all topics)
     * @param callback - Function called when message received
     * @returns Unsubscribe function
     *
     * @example
     * ```typescript
     * const unsub = provider.pubsub.subscribe('chat', (msg) => {
     *   console.log('Chat:', msg)
     * })
     *
     * // Later: unsub()
     * ```
     */
    subscribe(topic, callback) {
        const handler = (message, receivedTopic) => {
            if (topic === '*' || topic === receivedTopic) {
                callback(message, receivedTopic);
            }
        };
        this.on('message', handler);
        return () => this.off('message', handler);
    }
    /**
     * Internal: Handle incoming pub/sub message
     */
    _handleMessage(topic, message) {
        this.emit('message', [message, topic]);
    }
}
/**
 * Generic Yjs provider that works with any transport implementation.
 *
 * This provider handles all Yjs synchronization logic including:
 * - Document updates (automatic sync)
 * - Awareness protocol (presence, cursors, etc.)
 * - State vector synchronization
 * - Optional pub/sub channel for real-time messaging
 *
 * You only need to implement the Transport interface for your backend.
 *
 * @example
 * ```typescript
 * // Create your transport
 * const transport = new MyCustomTransport()
 *
 * // Create provider with Yjs document
 * const doc = new Y.Doc()
 * const provider = new GenericProvider(doc, transport)
 *
 * // Connect
 * await provider.connect({ room: 'my-room' })
 *
 * // Provider automatically syncs all changes
 * const ytext = doc.getText('content')
 * ytext.insert(0, 'Hello') // Automatically synced!
 * ```
 */
export class GenericProvider extends Observable {
    /**
     * Create a new generic provider.
     *
     * @param doc - The Yjs document to sync
     * @param transport - Transport implementation for your backend
     * @param options - Optional configuration
     */
    constructor(doc, transport, options = {}) {
        super();
        this._status = { state: 'disconnected' };
        this._synced = false;
        this._destroying = false;
        this._lastActivityTime = Date.now();
        this._lastPeriodicTickTime = Date.now();
        // BroadcastChannel state for cross-tab sync
        this._bcChannel = '';
        this._bcConnected = false;
        // Unified resync-request coordinator. Previously hash-mismatch,
        // corrupted-message, and gap-confirmed triggers each coalesced only
        // against themselves (three separate pending-timer fields, three
        // separate escalation counters), so under sustained wire corruption they
        // could each independently burn through the shared _tryReserveSyncSlot()
        // budget in the same window - a resync storm that grew combinatorially
        // with peer count (see test/dummy/bench-corruption-storm.ts: at 10
        // simulated peers, 5% per-link corruption drove message volume to ~11x
        // the corruption-free baseline). Now there is exactly ONE pending timer
        // and ONE shared escalation counter for all three triggers - only one
        // resync is ever in flight at a time, and any trigger that fires while
        // one is already pending is absorbed into it instead of scheduling its
        // own. See _requestResync().
        this._resyncAttemptCount = 0;
        this._lastResyncAttemptTime = 0;
        // Rate limiting for sync traffic - two budgets since phase 1b: one for
        // what we ask for (beacons, pushes, syncNow), one for what we owe
        // (SyncStep2 replies, acks). With a single shared budget a join burst's
        // replies spent the slots a peer needed for its own recovery (measured:
        // joiners arriving within 10 s of a burst converged in 13 s once, and a
        // 50-peer room's periodic beacons ran at a third of their rate for 10 s
        // after every join burst). Same size, same window, independent.
        this._syncRequestTimes = [];
        this._syncReplyTimes = [];
        // SyncStep2 reply suppression (NACK-suppression style): delay a reply to
        // a SyncStep1 request briefly, and drop it if another peer's reply is
        // overheard first - since every reply is broadcast to the whole room
        // anyway, this avoids every peer answering the same request redundantly.
        // Only engages when there's genuine redundancy (see _handleIncomingMessage's
        // MESSAGE_SYNC and MESSAGE_SYNC_VERIFIED cases) - with 0-1 other known
        // peers there's no "someone else" to rely on, so replies go out
        // immediately as before.
        this._pendingSyncReply = null;
        // Whether _pendingSyncReply is a digest-beacon ack (see _handleDigest())
        // rather than a SyncStep2. An overheard beacon with a digest equal to ours
        // makes a pending ACK redundant (the joiner it was for has received that
        // same beacon and is synced by it) but says nothing about a pending
        // SyncStep2, which carries data - so only acks are cancelled on that
        // signal. Measured in test/dummy/bench-user-scaling.ts: without this, acks
        // were ~94% of a 50-peer join burst's messages (Task 3b in the design doc).
        this._pendingSyncReplyIsAck = false;
        // The requester's state vector the pending SyncStep2 answers (null for
        // acks and for replies to plain SyncStep1s). A later request with the
        // same state vector is the same question: the pending reply's bytes are
        // refreshed to the current document and the timer kept, instead of the
        // old reply being flushed as "a different request" - measured: with one
        // peer typing while K empty peers join, keystroke and JOIN-beacon
        // arrivals interleave at random, every keystroke in between changed the
        // reply bytes, and each settled peer flushed up to K replies (Task 7 in
        // the phase-1b design doc).
        this._pendingSyncReplyTargetSv = null;
        this._responseWaitAttempts = 0;
        this._responseSeen = false;
        // Phase 1e: an equal ack or equal beacon from an UNSETTLED peer arrived
        // during the current response wait. Not a response (a settled peer with
        // content may still answer), but evidence that the room is a fresh one
        // whose peers are all in our state - see _armResponseWait().
        this._equalUnsettledSeen = false;
        this._responseWaitFlags = 0; // flags for the retry beacon: CONFIRM after a JOIN, 0 after a resync
        this._behindSv = null;
        // Round-trip estimate from our own requests (JOIN/resync beacon -> first
        // SyncStep2 or ack): the minimum of the last 8 samples, because a sample
        // includes the responder's random suppression delay and the fastest
        // reply had the least of it. Drives _replySuppressionMaxDelay() (a
        // suppression window shorter than the one-way latency suppresses
        // nothing: at 250-350 ms latency every peer ahead of a requester replied
        // before any reply could be overheard, ~20 replies per request at N=100)
        // and _armResponseWait()'s first delay (a fixed 1 s fired premature
        // retries on the Matrix profile). See the phase-1b design doc, 1c.
        this._rttSamples = [];
        this._requestSentAt = 0;
        // See DIGEST_FLAG_SETTLED. Reset on connect (a re-joining peer is a joiner).
        this._confirmed = false;
        // ClientIDs we have heard from directly (beacon and verified-update
        // senders). The reply-suppression gate ("is there someone else who could
        // answer?") used awareness alone, and in a join burst the awareness
        // messages trail the beacons - so the gate was still closed exactly when
        // 49 requests arrived at once, and every one got an immediate reply
        // (phase-1b design, item 3). Cleared on disconnect.
        this._knownPeers = new Set();
        // Transport address (the `from` of Transport.onMessage) per remote
        // clientID, learned from beacons and verified updates; lets replies, acks
        // and presence responses go to the requester alone when the transport
        // has sendTo (phase-1c design, item B). Cleared on disconnect.
        this._peerAddress = new Map();
        // Requesters whose JOIN presence request the pending presence-response
        // timer covers (see _schedulePresenceResponse).
        this._presencePending = new Set();
        // Phase 1e: an awareness message carrying OUR state at our current clock
        // arrived since the presence-response timer was armed - the room's
        // relayer (see _schedulePresenceResponse) already told the joiner about
        // us, our own response would repeat it.
        this._presenceCovered = false;
        // Same NACK-style suppression as _pendingSyncReply above, applied to
        // awareness updates that are a pure timeout-triggered removal (see
        // _scheduleAwarenessRemoval()) - every OTHER connected peer runs its own
        // independent 30s outdatedTimeout sweep (y-protocols/awareness.js), so
        // one peer going silent (crash/dirty drop, not a clean disconnect())
        // causes an O(N) simultaneous "peer X is gone" broadcast burst without
        // this. See docs/superpowers/specs/2026-09-04-sync-optimization-round-3-ideas.md
        // item 7 and test/dummy/bench-awareness-removal-burst.ts.
        this._pendingAwarenessRemoval = null;
        // Cached computeDeleteSetHash(doc); null = stale. Invalidated on every
        // doc 'update' (deletes are content changes, so this is exact; inserts
        // invalidate needlessly but cheaply). See computeDeleteSetHash's doc for
        // why this must not be recomputed per update.
        this._dsHashCache = null;
        // Sequence numbers for causal ordering
        this._localSeqNum = 0; // Our sequence number counter
        // Per-sender sequence tracking for reordering-tolerant gap detection.
        // Applying a Yjs update is always safe even for duplicates or out-of-order
        // arrivals (Yjs updates are idempotent/commutative) — this state exists
        // only to detect genuine gaps (likely packet loss) without false
        // positives from mere network reordering. See _trackRemoteSeq().
        this._remoteSeqInfo = new Map();
        this._gapCheckTimers = new Map();
        // Update batching/debouncing
        this._batchUpdates = 0; // milliseconds delay (0 = disabled)
        this._pendingUpdate = null;
        // Awareness throttling - prevents awareness from flooding document sync
        this._awarenessInterval = 100; // ms between awareness broadcasts
        this._pendingAwarenessClients = new Set();
        this._lastAwarenessTime = 0;
        this.doc = doc;
        this.transport = transport;
        this.pubsub = new PubSubChannel(this);
        this.awareness = options.awareness || new awarenessProtocol.Awareness(doc);
        this._syncInterval = options.syncInterval ?? 5000;
        this._verifyUpdates = options.verifyUpdates ?? true;
        this._batchUpdates =
            options.batchUpdates ?? transport.preferredBatchMs ?? 0;
        this._disableBc = options.disableBc ?? false;
        this._awarenessInterval = options.awarenessInterval ?? 100;
        this._maxSyncRequestsPerWindow = options.maxSyncRequestsPerWindow ?? 20;
        this._syncRequestWindowMs = options.syncRequestWindowMs ?? 10000;
        this._syncReplySuppressionMs = options.syncReplySuppressionMs ?? 30;
        this._peerConnectDebounceMs = options.peerConnectDebounceMs ?? 50;
        this._gapGraceMs = options.gapGraceMs ?? 300;
        this._seqWindowSize = options.seqWindowSize ?? 64;
        this._compressionThresholdBytes = options.compressionThresholdBytes || undefined;
        this._idleBackoffEnabled = options.idleBackoffEnabled ?? true;
        this._idleBackoffMaxMs = options.idleBackoffMaxMs ?? 60000;
        this._currentSyncIntervalMs = this._syncInterval;
        this._setupDocumentSync();
        this._setupAwarenessSync();
    }
    /**
     * Connect to the backend and start syncing.
     *
     * @param config - Connection configuration passed to transport
     */
    async connect(config) {
        if (this._destroying) {
            throw new Error('Provider is being destroyed');
        }
        // Prevent double connect race condition
        if (this._status.state === 'connected') {
            console.warn('[GenericProvider] Already connected, ignoring connect() call');
            return;
        }
        if (this._status.state === 'connecting') {
            console.warn('[GenericProvider] Connection already in progress, ignoring connect() call');
            return;
        }
        this._setStatus({ state: 'connecting' });
        try {
            // Setup BroadcastChannel for cross-tab sync (if enabled and available)
            this._setupBroadcastChannel(config);
            // Register for incoming messages and new-peer notifications BEFORE
            // connecting the transport. Some transports (e.g. PeerJS for a
            // joining, non-coordinator peer) establish and fully open their first
            // connection *inside* transport.connect() itself — so a peer-connect
            // notification or an immediate reply from the other side can arrive
            // before that promise resolves. Registering after the await left
            // exactly that window uncovered: whatever arrived during it was
            // silently dropped since neither callback was wired up yet.
            this._unsubscribeTransport = this.transport.onMessage((data, from) => {
                this._handleIncomingMessage(data, from);
            });
            if (this.transport.onPeerConnect) {
                const unsubPeer = this.transport.onPeerConnect((_peerId) => {
                    if (!this._destroying)
                        this._schedulePeerConnectSync();
                });
                const originalUnsub = this._unsubscribeTransport;
                this._unsubscribeTransport = () => {
                    originalUnsub?.();
                    unsubPeer();
                };
            }
            // Connect the transport
            await this.transport.connect(config);
            this._setStatus({ state: 'connected' });
            // Seed the round-trip estimate from the transport's hint (see
            // Transport.expectedRttMs); the minimum-of-8 rule lets real samples
            // take over as soon as they arrive.
            if (this.transport.expectedRttMs) {
                this._rttSamples = [this.transport.expectedRttMs];
            }
            // Send initial sync pushing our local state plus requesting remote state.
            // syncNow() is used instead of _sendSyncStep1() so that any offline edits
            // made before this connect() call are pushed to currently-connected peers
            // (e.g. same-browser tabs via BroadcastChannel).
            this.syncNow();
            // (Local awareness goes out inside syncNow()'s batch, or via its
            // throttled fallback - a second broadcast here was a duplicate 100ms
            // later.)
            // Start periodic sync to handle packet loss
            // Just request sync without sending full state (avoid redundant broadcasts)
            // _sendSyncStep1() already checks the shared rate limiter internally
            // and silently drops the request if it's exceeded.
            //
            // Uses a recursive setTimeout (re-jittered by ~20% each tick) rather
            // than a plain setInterval so peers that connect() within a short
            // window of each other - the common case: everyone joining a room
            // near session start, or reconnecting together after a shared network
            // blip - don't end up with near-synchronized periodic timers that all
            // fire in the same few milliseconds every syncInterval. This doesn't
            // reduce total periodic-sync traffic, only spreads it out so a room's
            // background traffic is smooth instead of bursty.
            if (this._syncInterval > 0) {
                // Reset idle-backoff state on every (re)connect so a reconnect
                // always starts its first tick at the base interval, never
                // inheriting a backed-off value left over from a previous session.
                this._currentSyncIntervalMs = this._syncInterval;
                this._lastActivityTime = Date.now();
                this._lastPeriodicTickTime = Date.now();
                const scheduleNextPeriodicSync = (delayMs) => {
                    this._syncIntervalId = setTimeout(() => {
                        const tickTime = Date.now();
                        if (this._idleBackoffEnabled) {
                            // "Activity" = anything _markActivity() call sites observed
                            // (incoming message via transport or BroadcastChannel, local
                            // or remote doc change, local or remote awareness change)
                            // since the LAST tick fired - not since backoff started, so a
                            // single quiet tick after a burst of activity still resets to
                            // base rather than needing a full quiet cycle to catch up.
                            const hadActivitySinceLastTick = this._lastActivityTime > this._lastPeriodicTickTime;
                            this._currentSyncIntervalMs = hadActivitySinceLastTick
                                ? this._syncInterval
                                : Math.min(this._idleBackoffMaxMs, this._currentSyncIntervalMs * 2);
                        }
                        this._lastPeriodicTickTime = tickTime;
                        if (this.transport.isConnected && !this._destroying) {
                            // Beacon only. Presence is no longer re-announced per tick on
                            // any transport: a joiner requests it via DIGEST_FLAG_JOIN
                            // (see _handleDigest()), and y-protocols/awareness renews the
                            // local state itself every outdatedTimeout/2 = 15s
                            // (awareness.js _checkInterval), which the awareness update
                            // handler broadcasts. Measured in
                            // test/dummy/bench-idle-room.ts: the per-tick re-announce was
                            // ~40% of an idle room's deliveries.
                            this._sendSyncStep1();
                        }
                        if (!this._destroying)
                            scheduleNextPeriodicSync();
                    }, delayMs ?? this._jitteredSyncInterval());
                };
                this._periodicScheduler = scheduleNextPeriodicSync;
                scheduleNextPeriodicSync();
            }
        }
        catch (error) {
            this._setStatus({
                state: 'error',
                error: error instanceof Error ? error : new Error(String(error)),
            });
            throw error;
        }
    }
    /**
     * Disconnect from the backend.
     * The provider can be reconnected later with connect().
     */
    disconnect() {
        // Stop periodic sync
        if (this._syncIntervalId !== undefined) {
            clearTimeout(this._syncIntervalId);
            this._syncIntervalId = undefined;
        }
        this._periodicScheduler = undefined;
        // Reset resync escalation tracking
        this._resyncAttemptCount = 0;
        this._lastResyncAttemptTime = 0;
        // Cancel any pending unified resync - it would otherwise still fire
        // syncNow() after disconnect/reconnect against a transport that may be
        // in a completely different state by then.
        if (this._pendingResyncTimeoutId !== undefined) {
            clearTimeout(this._pendingResyncTimeoutId);
            this._pendingResyncTimeoutId = undefined;
        }
        // Stop any pending gap-check timers and forget per-sender sequence
        // tracking. Without this, a gap-check timer armed before this
        // disconnect() keeps running in the background and can fire
        // _requestResync() after reconnect using sequence-number bookkeeping
        // from the PREVIOUS connection - a spurious resync race disconnected
        // from anything actually missing in the new session. Mirrors the
        // equivalent cleanup in destroy().
        for (const timer of this._gapCheckTimers.values()) {
            clearTimeout(timer);
        }
        this._gapCheckTimers.clear();
        this._remoteSeqInfo.clear();
        // Cancel any pending debounced onPeerConnect sync - a reconnect gets a
        // fresh burst of onPeerConnect events (if the transport supports it) and
        // shouldn't fire a stale one left over from before this disconnect.
        if (this._pendingPeerConnectSyncTimeoutId !== undefined) {
            clearTimeout(this._pendingPeerConnectSyncTimeoutId);
            this._pendingPeerConnectSyncTimeoutId = undefined;
        }
        // Reset the sync rate-limit budget. Without this, a reconnect inherits
        // whatever budget was left over from before the disconnect - and since
        // syncNow()'s full-state push now shares this same limiter (see
        // _tryReserveSyncSlot()), a rate-limited reconnect could silently skip
        // the very push that delivers edits made while offline.
        this._syncRequestTimes = [];
        this._syncReplyTimes = [];
        this._knownPeers.clear();
        this._peerAddress.clear();
        this._presencePending.clear();
        // A pending response-wait belongs to a request on the old connection.
        if (this._responseWaitTimer !== undefined) {
            clearTimeout(this._responseWaitTimer);
            this._responseWaitTimer = undefined;
        }
        if (this._pendingCheckTimer !== undefined) {
            clearTimeout(this._pendingCheckTimer);
            this._pendingCheckTimer = undefined;
        }
        if (this._behindCheckTimer !== undefined) {
            clearTimeout(this._behindCheckTimer);
            this._behindCheckTimer = undefined;
        }
        this._behindSv = null;
        if (this._presenceResponseTimer !== undefined) {
            clearTimeout(this._presenceResponseTimer);
            this._presenceResponseTimer = undefined;
        }
        this._responseWaitAttempts = 0;
        this._responseSeen = false;
        this._equalUnsettledSeen = false;
        this._rttSamples = [];
        this._requestSentAt = 0;
        this._confirmed = false;
        // Drop any pending suppressed sync reply - safe to simply discard (not
        // flush/send like batched updates/awareness below), since a suppressed
        // reply is by design redundant with whatever the room already has.
        this._cancelPendingSyncReply();
        // Same reasoning for a pending suppressed awareness-removal broadcast -
        // every other surviving peer is independently running the same
        // suppression for the same departure, so dropping ours on disconnect
        // (rather than flushing it through a transport that's about to go
        // down) is safe.
        this._cancelPendingAwarenessRemoval();
        // Flush any pending batched updates before disconnecting
        if (this._batchTimeoutId !== undefined) {
            clearTimeout(this._batchTimeoutId);
            this._batchTimeoutId = undefined;
            // Send pending update if transport is still connected
            if (this._pendingUpdate && this.transport.isConnected) {
                this._sendUpdate(this._pendingUpdate);
            }
            this._pendingUpdate = null;
        }
        // Flush pending awareness updates before disconnecting
        if (this._awarenessTimeoutId !== undefined) {
            clearTimeout(this._awarenessTimeoutId);
            this._awarenessTimeoutId = undefined;
            // Send pending awareness if transport is still connected
            if (this._pendingAwarenessClients.size > 0 &&
                this.transport.isConnected) {
                const clientsToSend = Array.from(this._pendingAwarenessClients);
                this._sendAwarenessNow(clientsToSend);
            }
        }
        this._pendingAwarenessClients.clear();
        // Disconnect BroadcastChannel
        this._disconnectBroadcastChannel();
        if (this._unsubscribeTransport) {
            this._unsubscribeTransport();
            this._unsubscribeTransport = undefined;
        }
        // Mark local client as offline in awareness
        awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'disconnect');
        this.transport.disconnect();
        this._synced = false;
        this._setStatus({ state: 'disconnected' });
    }
    /**
     * Destroy the provider permanently.
     * Removes all event listeners and cleans up resources.
     */
    destroy() {
        this._destroying = true;
        // Stop periodic sync (disconnect() will also do this, but be explicit)
        if (this._syncIntervalId !== undefined) {
            clearTimeout(this._syncIntervalId);
            this._syncIntervalId = undefined;
        }
        // Stop any pending gap-check timers
        for (const timer of this._gapCheckTimers.values()) {
            clearTimeout(timer);
        }
        this._gapCheckTimers.clear();
        // Drop any pending suppressed sync reply (disconnect() will also do
        // this, but be explicit)
        this._cancelPendingSyncReply();
        // Same, for a pending suppressed awareness-removal broadcast
        // (disconnect() will also do this, but be explicit)
        this._cancelPendingAwarenessRemoval();
        // Flush any pending batched updates before destroying
        if (this._batchTimeoutId !== undefined) {
            clearTimeout(this._batchTimeoutId);
            this._batchTimeoutId = undefined;
            // Send pending update if transport is still connected
            if (this._pendingUpdate && this.transport.isConnected) {
                this._sendUpdate(this._pendingUpdate);
            }
            this._pendingUpdate = null;
        }
        this.disconnect();
        // Remove document update listener
        if (this._updateHandler) {
            this.doc.off('update', this._updateHandler);
            this._updateHandler = undefined;
        }
        // Remove awareness update listener
        if (this._awarenessUpdateHandler) {
            this.awareness.off('update', this._awarenessUpdateHandler);
            this._awarenessUpdateHandler = undefined;
        }
        // Remove beforeunload handler
        if (this._beforeUnloadHandler && typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', this._beforeUnloadHandler);
            this._beforeUnloadHandler = undefined;
        }
        this.awareness.destroy();
        super.destroy();
    }
    /**
     * Current connection status
     */
    get status() {
        return this._status;
    }
    /**
     * Whether the provider is connected to the backend
     */
    get connected() {
        return this.transport.isConnected;
    }
    /**
     * Whether BroadcastChannel is connected for cross-tab sync
     */
    get bcConnected() {
        return this._bcConnected;
    }
    /**
     * Whether the document is synced with remote peers
     */
    get synced() {
        return this._synced;
    }
    /**
     * Push local state + request remote state, gated by the shared rate
     * limiter. Returns whether it actually reserved a slot and sent anything
     * - `false` means the caller was rate-limited right now. Extracted out of
     * `syncNow()` so `_requestResync()`'s scheduled retry (see below) can tell
     * the difference between "sent" and "silently skipped" and react to it,
     * instead of assuming a resync always succeeds once it fires.
     *
     * @param push - whether to also broadcast full local document state.
     * `_requestResync()`'s retry passes `false` (pull-only is enough for a
     * resync trigger - see its call site).
     * @param buildExtra - optional callback, invoked ONLY once a rate-limit
     * slot is actually reserved (so it never runs, and never mutates
     * whatever state it touches, on a call that ends up rate-limited),
     * returning additional already-encoded sub-messages to fold into the SAME
     * batched wire send as the push/pull messages below - e.g. an awareness
     * update that's ready to go out "now" anyway (see
     * `_tryImmediateAwarenessMessage()`). Pure wire-framing: whether a caller
     * passes this never changes whether/when the push+pull half itself sends,
     * only how many separate `transport.send()`/`bc.publish()` calls it costs.
     * @param flags - digest beacon flags: DIGEST_FLAG_JOIN from syncNow(), 0
     * from the peer-connect debounce and the resync retry (see _syncNow()).
     */
    _trySyncPushPull(push = true, buildExtra, flags = 0) {
        // Push (full document state) and pull (SyncStep1 request) share a
        // single rate-limit reservation. syncNow() is called from several
        // triggers that can all fire in a short window when many peers are
        // converging at once (hash-mismatch resyncs, gap-check confirmations,
        // per-peer connect events on mesh transports) - without this gate the
        // push above had NO limit at all, so each trigger broadcast the full
        // document state to the whole room, and those broadcasts caused more
        // reordering/mismatches elsewhere, causing more triggers. Measured in
        // test/dummy/bench-user-scaling.ts: at 100 simulated users this drove
        // message counts to 20-200x the theoretical linear cost. See
        // docs/superpowers/specs/2026-07-26-dummy-benchmark-scaling-design.md.
        if (!this._tryReserveSyncSlot())
            return false;
        const messages = [];
        // Send our current document state to all peers
        // This ensures any changes made while offline are transmitted
        if (push) {
            const update = Y.encodeStateAsUpdate(this.doc);
            if (update.length > 0) {
                messages.push(this._encodePush(update));
            }
        }
        // Send sync request to get updates from others
        messages.push(this._encodeSyncStep1(flags));
        if (buildExtra) {
            messages.push(...buildExtra());
        }
        // Batched into one wire message (MESSAGE_BATCH) instead of one
        // transport.send()/bc.publish() call per sub-message - see _sendBatch().
        this._sendBatch(messages);
        if (flags & DIGEST_FLAG_JOIN)
            this._armResponseWait(DIGEST_FLAG_CONFIRM);
        return true;
    }
    /**
     * Force an immediate sync with remote peers.
     * Useful after network interruptions or to manually trigger re-sync.
     * Sends the beacon with DIGEST_FLAG_JOIN: peers answer with their
     * presence and, if our state already matches theirs, with an ack beacon
     * so `synced` flips without a data round trip.
     */
    syncNow() {
        this._syncNow(DIGEST_FLAG_JOIN);
    }
    /**
     * syncNow() body. `flags` = 0 for callers that must NOT request presence:
     * `_schedulePeerConnectSync()` (mesh transports already re-broadcast
     * presence to a newcomer via their own onPeerConnect -> syncNow()).
     */
    _syncNow(flags) {
        if (!this.transport.isConnected) {
            console.warn('Cannot sync: transport not connected');
            return;
        }
        if (flags & DIGEST_FLAG_JOIN)
            this._confirmed = false; // a (re-)joiner until answered
        // Try to fold the awareness broadcast into the same wire send as the
        // sync push+pull below. _tryImmediateAwarenessMessage() only returns
        // non-null (and only mutates awareness-throttle state) when the
        // throttle would have let an immediate send through anyway - so this
        // never changes awareness throttle semantics, only whether it travels
        // as its own message or bundled with the sync message going out "now"
        // too. Built inside buildExtra so it's only even attempted once a sync
        // rate-limit slot is confirmed reserved (see _trySyncPushPull's doc).
        let awarenessBatched = false;
        const sent = this._trySyncPushPull(true, () => {
            const msg = this._tryImmediateAwarenessMessage([this.doc.clientID]);
            if (msg) {
                awarenessBatched = true;
                return [msg];
            }
            return [];
        }, flags);
        // Awareness broadcasting is independently throttled and explicitly NOT
        // gated by the sync rate limiter above - preserve that exactly: it
        // always ends up broadcast one way or another (batched above, or via
        // its own throttled path here), regardless of whether the sync half
        // above was rate-limited.
        if (!sent || !awarenessBatched) {
            this._broadcastAwareness([this.doc.clientID]);
        }
    }
    /**
     * Compute the next periodic-sync delay, jittered by ~+/-20% around
     * `_currentSyncIntervalMs` (== `_syncInterval` unless `idleBackoffEnabled`
     * has backed it off - see that option's doc comment). Re-jittered fresh
     * each tick (not computed once per connect()) so a room's peers - which
     * commonly all connect() within a short window of each other - drift
     * apart over time instead of staying loosely synchronized. Extracted to
     * its own method purely so benchmarks can shadow it to compare against
     * the unjittered baseline.
     */
    _jitteredSyncInterval() {
        const jitter = 1 + (Math.random() * 2 - 1) * 0.2; // +/-20%
        return this._currentSyncIntervalMs * jitter;
    }
    /**
     * Record that "activity" happened right now, for `idleBackoffEnabled`'s
     * benefit. Cheap (one timestamp write) and called unconditionally
     * regardless of whether idle backoff is enabled, so there's no behavioral
     * branch to keep in sync - the backoff decision in connect()'s periodic
     * tick is the only place that actually reads this.
     *
     * Call sites are deliberately NOT "any inbound wire message" - an earlier
     * version of this hooked `_handleIncomingMessage()` unconditionally, which
     * made the periodic tick's OWN SyncStep1 request and the SyncStep2 reply
     * answering it (empty payload - nothing to sync) each count as "activity",
     * permanently resetting the backoff on every single tick and making the
     * whole feature a no-op (caught by this bench script's own first run: ON
     * and OFF produced statistically indistinguishable message counts). Both
     * Yjs's `doc.emit('update', ...)` and y-protocols' `awareness.emit('update', ...)`
     * already only fire when something with actual content changed
     * (`hasContent`/non-empty added+updated+removed - confirmed by reading
     * yjs's `Transaction.js` and y-protocols' `awareness.js` directly), so
     * hooking THOSE instead is exactly "local or remote document/awareness
     * change" with no extra filtering needed - a no-op SyncStep2 reply, a
     * digest beacon, or a duplicate/no-change awareness re-announce (e.g. a
     * JOIN-triggered presence response that changed nothing) never reaches
     * these handlers. A corrupted (CRC32
     * mismatch) message is real evidence of wire activity that neither
     * handler would ever see (it's rejected before decoding) - see the
     * explicit call in `_processWrappedMessage()`'s corruption branch.
     *
     * Call sites: `_setupDocumentSync()`'s update handler (LOCAL document
     * edits only, since phase 1e) and `_processWrappedMessage()`'s
     * corrupted-message branch (wire noise, not silence).
     */
    _markActivity() {
        this._lastActivityTime = Date.now();
        // A backed-off periodic timer is re-armed at the base interval NOW, not
        // at its next tick (which may be idleBackoffMaxMs away). Design D of
        // the phase-1d doc rests on it: the peer that just had activity beacons
        // within one base interval, and a peer that lost that activity's
        // message learns from that beacon that it is behind (design A) - its
        // own backed-off interval no longer bounds the recovery. Measured in
        // test/dummy/bench-idle-backoff.ts. At most once per idle stretch.
        if (this._idleBackoffEnabled &&
            this._currentSyncIntervalMs !== this._syncInterval &&
            this._syncIntervalId !== undefined &&
            this._periodicScheduler !== undefined) {
            clearTimeout(this._syncIntervalId);
            this._currentSyncIntervalMs = this._syncInterval;
            // Phase 1e: at a random point inside the base interval, not a full
            // one (the phase-1d note): the loser's recovery chain starts with
            // this beacon.
            this._periodicScheduler(Math.random() * this._syncInterval);
        }
    }
    /** Cached delete-set hash - see computeDeleteSetHash(). */
    _deleteSetHash() {
        if (this._dsHashCache === null) {
            this._dsHashCache = computeDeleteSetHash(this.doc);
        }
        return this._dsHashCache;
    }
    /**
     * Debounce onPeerConnect-triggered syncNow() calls. A burst of connect
     * events within `_peerConnectDebounceMs` collapses into one call instead
     * of one per event - without this, N peers joining a mesh in a short
     * window each independently broadcast full state to everyone already
     * connected (O(N^2) traffic), since onPeerConnect fires once per
     * newly-opened peer connection with no coalescing of its own.
     */
    _schedulePeerConnectSync() {
        if (this._pendingPeerConnectSyncTimeoutId !== undefined)
            return;
        this._pendingPeerConnectSyncTimeoutId = setTimeout(() => {
            this._pendingPeerConnectSyncTimeoutId = undefined;
            if (!this.transport.isConnected || this._destroying)
                return;
            this._syncNow(0);
        }, this._peerConnectDebounceMs);
    }
    /**
     * Setup automatic document synchronization.
     * Listens to document updates and sends them to the transport.
     * If batchUpdates is enabled, updates are debounced/batched.
     */
    _setupDocumentSync() {
        this._updateHandler = (update, origin) => {
            this._dsHashCache = null;
            // Fires for BOTH local edits and remotely-applied updates (the latter
            // go through doc.transact with origin=this) - see _markActivity()'s
            // doc comment. Phase 1e: only a LOCAL edit counts as activity for
            // idle backoff - a listener has nothing a beacon would announce, and
            // the typist's base-interval beacon heals any listener that lost the
            // keystroke (phase 1d design A). Before this, one typist kept all N
            // peers at the base cadence: N*(N-1) deliveries per interval against
            // N-1 per keystroke.
            if (origin !== this)
                this._markActivity();
            // Don't send updates that originated from this provider
            // This prevents infinite loops when receiving updates
            if (origin !== this) {
                if (this._batchUpdates > 0) {
                    // Batch mode: merge updates and debounce
                    this._batchUpdate(update);
                }
                else {
                    // Immediate mode: send right away
                    this._sendUpdate(update);
                }
            }
        };
        this.doc.on('update', this._updateHandler);
    }
    /**
     * Batch/debounce updates to reduce network traffic.
     * Merges multiple updates and sends after delay.
     */
    _batchUpdate(update) {
        // Merge with pending update if exists
        if (this._pendingUpdate) {
            try {
                // Yjs automatically merges sequential updates
                this._pendingUpdate = Y.mergeUpdates([this._pendingUpdate, update]);
            }
            catch (error) {
                console.error('[GenericProvider] Failed to merge updates:', error);
                // Send the pending update immediately to avoid data loss
                this._sendUpdate(this._pendingUpdate);
                // Start a new batch with the current update
                this._pendingUpdate = update;
            }
        }
        else {
            this._pendingUpdate = update;
        }
        // Clear existing timeout
        if (this._batchTimeoutId !== undefined) {
            clearTimeout(this._batchTimeoutId);
        }
        // Set new timeout to send after delay
        this._batchTimeoutId = setTimeout(() => {
            if (this._pendingUpdate) {
                this._sendUpdate(this._pendingUpdate);
                this._pendingUpdate = null;
            }
            this._batchTimeoutId = undefined;
        }, this._batchUpdates);
    }
    /**
     * Setup automatic awareness synchronization.
     * Listens to awareness changes and broadcasts them.
     */
    _setupAwarenessSync() {
        this._awarenessUpdateHandler = ({ added, updated, removed, }, origin) => {
            // Not _markActivity(): awareness changes are not something a beacon
            // announces (phase 1e; see the idleBackoffEnabled option).
            // Broadcast awareness changes, UNLESS they came from remote (this
            // comment described the intent since the very first commit, but the
            // actual origin check was never implemented until now - confirmed by
            // `git log -p` on this handler). `origin === this` is exactly the
            // signature the MESSAGE_AWARENESS handler stamps on an update applied
            // from an incoming wire message (`applyAwarenessUpdate(this.awareness,
            // ..., this)`, below). Every transport this project targets is a
            // full-room relay (websocket/pubnub/gun/matrix/ably/supabase) or a
            // full mesh (peerjs/simple-peer/trystero - see CLAUDE.md), so the
            // sender's own broadcast already reached every other peer directly;
            // re-broadcasting it here on receipt is pure redundant traffic that
            // compounds across every OTHER receiver doing the same thing.
            // Verified with a throwaway probe: a single awareness field change in
            // an N-peer room cost N*(N-1) wire deliveries before this check (one
            // echo per receiver, each reaching N-1 peers) vs. N-1 after - e.g.
            // N=20: 380 -> 19.
            //
            // Carve-out: `applyAwarenessUpdate` has its own defense against a
            // remote peer incorrectly removing OUR OWN state (a stale/racy
            // timeout-removal from someone else's clock) - it bumps our clock
            // instead of deleting our state, but (a quirk of that function) still
            // reports it via `removed` including our own clientID. That specific
            // case must still be broadcast so the room's stale belief that we're
            // gone gets corrected promptly, instead of only self-healing on our
            // next unrelated state change/renewal (up to ~15s later).
            if (origin === this) {
                // An incoming removal might be the SAME departure we have a
                // suppressed broadcast queued for (see _scheduleAwarenessRemoval())
                // - someone else already told the room, drop ours.
                if (removed.length > 0) {
                    this._cancelPendingAwarenessRemovalIfOverlaps(removed);
                }
                if (!removed.includes(this.awareness.clientID)) {
                    return;
                }
            }
            const changedClients = added.concat(updated).concat(removed);
            // A pure timeout-triggered removal ('timeout' is the exact origin
            // string y-protocols/awareness.js's own _checkInterval passes to
            // removeAwarenessStates()) is redundant across the whole room: every
            // OTHER connected peer runs the identical 30s-timeout sweep
            // independently, so all of them detect and would broadcast the SAME
            // departure within the same ~3s tick - measured as O(N-1) broadcasts
            // / O((N-1)(N-2)) deliveries for ONE departure in
            // test/dummy/bench-awareness-removal-burst.ts (e.g. N=50: 2352
            // deliveries). Delay + drop-if-overheard, exactly mirroring
            // _scheduleSyncReply()/_cancelPendingSyncReply()'s suppression of
            // redundant SyncStep2 replies. Deliberately NOT applied to
            // 'disconnect'/'window unload' removals (a single broadcaster, not
            // redundant) or to added/updated clients (every sender's
            // cursor/presence data is meaningfully different and must never be
            // suppressed).
            if (origin === 'timeout') {
                this._scheduleAwarenessRemoval(changedClients);
                return;
            }
            this._broadcastAwareness(changedClients);
        };
        this.awareness.on('update', this._awarenessUpdateHandler);
        // Cleanup: mark as offline and disconnect BC when page unloads
        if (typeof window !== 'undefined') {
            this._beforeUnloadHandler = () => {
                awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
                // Disconnect BroadcastChannel to notify other tabs
                this._disconnectBroadcastChannel();
            };
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
        }
    }
    /**
     * Handle incoming messages from the transport (or BroadcastChannel).
     *
     * When compressionThresholdBytes is disabled (the default), this is a
     * fully synchronous fast path, byte-for-byte the same behavior as before
     * that option existed: straight into _processWrappedMessage().
     *
     * When enabled, every message - from the network transport AND from
     * BroadcastChannel (see _send()) - carries a leading compressed(1)/
     * uncompressed(0) flag byte ahead of the usual CRC32 wrapper. Reading
     * that flag and, if set, decompressing is inherently async (the
     * Compression Streams API has no synchronous form), so this method
     * dispatches to a promise chain instead of processing inline in that
     * case. This means a large (compressed) message and a small (uncompressed
     * or below-threshold) message that arrive back-to-back can finish
     * processing out of arrival order - acceptable here because Yjs updates
     * are idempotent/commutative (see MESSAGE_SYNC_VERIFIED's handling below)
     * and because the compression threshold keeps this path almost entirely
     * to large, full-state syncs, not the per-keystroke incremental updates
     * that per-sender gap detection actually relies on ordering-sensitive
     * heuristics for.
     */
    _handleIncomingMessage(data, from) {
        if (!this._compressionThresholdBytes) {
            this._processWrappedMessage(data, from);
            return;
        }
        if (data.length < 1) {
            console.warn('[GenericProvider] Dropping empty message (missing compression flag byte)');
            return;
        }
        const flag = data[0];
        const rest = data.subarray(1);
        if (flag === 0) {
            this._processWrappedMessage(rest, from);
            return;
        }
        if (!COMPRESSION_AVAILABLE) {
            console.warn('[GenericProvider] Received a compressed message but this runtime has no DecompressionStream - dropping it.');
            return;
        }
        decompressDeflateRaw(rest)
            .then((wrapped) => this._processWrappedMessage(wrapped, from))
            .catch((error) => {
            // Treat decompression failure the same as a CRC32 mismatch on the
            // uncompressed path: request a resync rather than silently dropping.
            console.warn('[GenericProvider] Failed to decompress incoming message, treating as corrupted:', error);
            this._requestResync();
        });
    }
    /**
     * Verify message integrity with CRC32 and decode. Corrupt messages are
     * rejected immediately without attempting to decode. Operates on bytes
     * that have already had any compression flag/decompression handled by
     * _handleIncomingMessage() - this is the pre-compression-feature
     * implementation, unchanged.
     */
    _processWrappedMessage(data, from) {
        // Verify message integrity with CRC32 checksum
        const message = unwrapAndVerifyMessage(data);
        if (message === null) {
            // Message is corrupted - reject it immediately. Note: if this was a
            // MESSAGE_BATCH envelope, the CRC32 wrap covers the WHOLE batch, so a
            // single corrupted bit here loses every sub-message it contained, not
            // just one - a deliberate tradeoff of batching multiple logical
            // messages behind one wire message/one checksum. See _sendBatch()'s
            // doc comment for why this was chosen over per-sub-message checksums,
            // and this project's benchmark suite (bench-corruption-storm.ts,
            // bench-packet-loss.ts) for how that tradeoff was measured.
            console.warn(`[GenericProvider] 💥 Corrupted message rejected: CRC32 checksum mismatch. ` +
                `This is expected if data corruption simulation is enabled.`);
            // Wire noise, not silence - counts as activity for idleBackoffEnabled
            // even though nothing here reaches the doc/awareness update handlers
            // (the message is rejected before decoding). See _markActivity()'s
            // doc comment.
            this._markActivity();
            // Request re-sync to recover any lost data - routed through the
            // shared coordinator so this doesn't stack an independent timer on
            // top of any hash-mismatch/gap-confirmed resync already pending.
            this._requestResync();
            return; // Don't process corrupted message
        }
        // Message integrity verified - safe to decode
        try {
            this._dispatchMessage(message, from);
        }
        catch (error) {
            // This should only happen for logic errors, not corruption
            // (corruption is caught by CRC32 check above)
            console.error('[GenericProvider] Error handling message:', error);
        }
    }
    /**
     * Decode and act on one already-integrity-verified, already-decompressed
     * message. Split out of `_processWrappedMessage()` so `MESSAGE_BATCH`
     * (see `_sendBatch()`) can recurse into this for each sub-message it
     * unwraps, running the EXACT SAME per-message-type logic used for a
     * top-level message rather than a parallel reimplementation. A thrown
     * error partway through a batch's sub-messages aborts the REST of that
     * batch (propagates up to `_processWrappedMessage()`'s catch) - same as
     * a logic error aborting a single top-level message today, just now
     * scoped to "the rest of this batch" instead of "this one message".
     */
    _dispatchMessage(message, from) {
        const decoder = decoding.createDecoder(message);
        const messageType = decoding.readVarUint(decoder);
        switch (messageType) {
            case MESSAGE_BATCH: {
                // Payload is N length-prefixed sub-messages (writeVarUint8Array
                // per sub-message, mirroring MESSAGE_AWARENESS's own framing).
                // Each was NOT individually CRC32-wrapped - see _sendBatch()'s doc
                // comment - so just decode and dispatch each one directly.
                while (decoding.hasContent(decoder)) {
                    const subMessage = decoding.readVarUint8Array(decoder);
                    this._dispatchMessage(subMessage, from);
                }
                break;
            }
            case MESSAGE_SYNC_DIGEST: {
                this._handleDigest(decoder, from);
                break;
            }
            case MESSAGE_SYNC_PUSH: {
                // Somebody's whole document: apply it, nothing else (see the
                // constant's comment for why no hash check and no synced flip).
                Y.applyUpdate(this.doc, decoding.readVarUint8Array(decoder), this);
                this._checkPendingAfterReply();
                break;
            }
            case MESSAGE_SYNC: {
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, MESSAGE_SYNC);
                const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
                if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
                    // If we received SyncStep2, we're synced (and confirmed: we have
                    // heard from a peer that had data for us)
                    this._confirmed = true;
                    this._noteResponse(true);
                    this._markSynced();
                    // Design E (phase 1d): a SyncStep2 carries its encoder's own pending
                    // structs, so a responder missing a struct hands us the same hole.
                    // Our response wait just ended - make sure something still asks.
                    this._checkPendingAfterReply();
                    // Someone else's SyncStep2 reply just arrived - our own pending
                    // reply (if any) is now most likely redundant.
                    this._cancelPendingSyncReply();
                }
                // Send reply if needed. Suppression only engages with genuine
                // redundancy (>=2 other known peers via awareness) - below that,
                // there's no "someone else" to rely on, so reply immediately
                // (still rate-limited via _sendSyncReply() as a hard backstop).
                if (encoding.length(encoder) > 1) {
                    this._replyToSyncRequest(encoding.toUint8Array(encoder));
                }
                break;
            }
            case MESSAGE_AWARENESS: {
                const payload = decoding.readVarUint8Array(decoder);
                // Someone else's removal broadcast just arrived - cancel our own
                // suppressed removal for the same clientID(s), if pending (see
                // _scheduleAwarenessRemoval()). This MUST be checked here, at the
                // wire-message level, before calling applyAwarenessUpdate() below -
                // by the time this arrives we've very likely already independently
                // detected and applied the SAME removal ourselves (every peer's
                // 30s outdatedTimeout sweep fires near-simultaneously, well before
                // this message's network delay elapses - see
                // test/dummy/bench-awareness-removal-burst.ts), so
                // applyAwarenessUpdate() below will see a clock it already knows
                // and emit no 'update' event at all - mirrors exactly how the
                // MESSAGE_SYNC/MESSAGE_SYNC_VERIFIED case above cancels
                // _pendingSyncReply on seeing a SyncStep2 message TYPE arrive, not
                // on whether it changed anything locally.
                const scan = this._scanAwarenessPayload(payload);
                if (scan.removed.length > 0) {
                    this._cancelPendingAwarenessRemovalIfOverlaps(scan.removed);
                }
                if (scan.coversUs)
                    this._presenceCovered = true;
                awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, this);
                break;
            }
            case MESSAGE_PUBSUB: {
                // Read topic
                const topic = decoding.readVarString(decoder);
                // Read message payload
                const payloadBytes = decoding.readVarUint8Array(decoder);
                try {
                    // Decode JSON payload
                    const decoder = new TextDecoder();
                    const payloadStr = decoder.decode(payloadBytes);
                    const message = JSON.parse(payloadStr);
                    // Emit to pubsub channel
                    this.pubsub._handleMessage(topic, message);
                }
                catch (error) {
                    console.error('Error decoding pub/sub message:', error);
                }
                break;
            }
            case MESSAGE_SYNC_VERIFIED: {
                // Sync message with sequence number and hash verification
                // Read sequence number and clientID first
                const seqNum = decoding.readVarUint(decoder);
                const senderClientID = decoding.readVarUint(decoder);
                // Track for gap detection only — does NOT gate whether we apply
                // the update below (see _trackRemoteSeq() for why).
                this._trackRemoteSeq(senderClientID, seqNum);
                this._knownPeers.add(senderClientID);
                if (from !== undefined)
                    this._peerAddress.set(senderClientID, from);
                // Always apply the update. Yjs updates are idempotent/commutative,
                // so re-applying an already-seen update is a harmless no-op.
                // Under reordering, a merely-late (not actually duplicate) update
                // must still be applied here — the old "skip if seqNum <= last
                // seen" logic silently dropped such updates forever whenever a
                // later-numbered message happened to arrive first.
                // Peek at the sync sub-message's payload (SyncStep2/Update carry
                // an update as a varUint8Array right after the sub-type) without
                // consuming the decoder - _isLateUpdate() needs the bytes after
                // readSyncMessage() has applied them.
                const updateBytes = this._peekSyncUpdate(decoder);
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, MESSAGE_SYNC);
                const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
                // Someone else's SyncStep2 reply just arrived - our own pending
                // reply (if any) is now most likely redundant. Mirrors the
                // MESSAGE_SYNC case: the reply encoded above is always a plain
                // MESSAGE_SYNC-typed message regardless of which message type
                // triggered it, so the same suppression scheme applies here too.
                if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
                    this._cancelPendingSyncReply();
                    this._confirmed = true;
                    this._checkPendingAfterReply();
                    this._noteResponse(true);
                }
                // Read the expected hash from sender (signed integer)
                const expectedHash = decoding.readVarInt(decoder);
                // Compute our local hash after applying the update
                const localHash = computeDocHash(this.doc);
                // Verify hash match
                if (localHash !== expectedHash) {
                    // If we already know this sender has a suspected reordering gap
                    // (see _trackRemoteSeq()/_scheduleGapCheck()), a hash mismatch
                    // right now is the *expected* transient state — we're missing a
                    // piece that's very likely still in flight, not actually
                    // diverged. Let the pending gap-check grace period resolve it
                    // instead of also escalating the hash-mismatch backoff: under
                    // heavy reordering this previously caused a burst of mismatches
                    // to rack up the exponential backoff to its 10s cap within a
                    // single edit burst, purely from timing, not real divergence.
                    // A hash mismatch with NO pending gap (in-order, but still
                    // wrong) is not explained by reordering and still escalates
                    // normally below.
                    const reorderingSuspected = this._gapCheckTimers.has(senderClientID);
                    // A late update - one whose content we had already been past
                    // when it arrived (its sender's clock in the update is below
                    // ours, because a SyncStep2 or a reordered later update got here
                    // first) - carries a hash of a state we have legitimately moved
                    // beyond. Its mismatch says nothing about anything we lack; it
                    // was the other half of the item-13 cascade (a resync's reply
                    // fast-forwards a peer, then every in-flight keystroke behind it
                    // mismatches). Cheap to detect from the update's own metadata.
                    const lateUpdate = this._isLateUpdate(updateBytes);
                    // Yjs's own verdict: if the update could not be fully integrated
                    // because a causal dependency is missing, the struct store holds
                    // it as pending. That is the ONE mismatch that is evidence of a
                    // gap - and under jitter it is usually a reordering that the
                    // next few ms resolve, so it gets the same grace a sequence gap
                    // gets before a beacon goes out (_schedulePendingCheck). It also
                    // covers the case the sequence anchor no longer does: since the
                    // connect push carries no sequence number (MESSAGE_SYNC_PUSH), a
                    // peer's first keystroke can be the first numbered message we see
                    // from it, and a reordered first burst has no earlier number to
                    // open a gap against.
                    const pending = this.doc.store.pendingStructs !== null ||
                        this.doc.store.pendingDs !== null;
                    if (pending) {
                        this._schedulePendingCheck();
                    }
                    else if (!reorderingSuspected && !lateUpdate) {
                        // Push our full state AND request theirs (syncNow() does
                        // both). A hash mismatch means the two peers have diverged -
                        // one side may have edits the other lacks. Routed through the
                        // shared coordinator so this doesn't stack an independent
                        // timer on top of any corrupted-message/gap-confirmed resync
                        // already pending.
                        this._requestResync();
                        // Logged with the shared attempt counter (kept as "#N" for
                        // compatibility with existing tooling/benchmarks that grep
                        // for this exact "Hash mismatch #" pattern) - it now reflects
                        // the unified resync-attempt count rather than a
                        // hash-mismatch-specific one, since the two escalation
                        // counters were merged.
                        console.warn(`[GenericProvider] Hash mismatch #${this._resyncAttemptCount} detected! Local: ${localHash}, Expected: ${expectedHash}`);
                    }
                }
                // If we received SyncStep2, we're synced (unless hash mismatched)
                if (syncMessageType === syncProtocol.messageYjsSyncStep2 &&
                    localHash === expectedHash) {
                    this._markSynced();
                }
                // Send reply if needed (as standard MESSAGE_SYNC). Suppression
                // only engages with genuine redundancy (>=2 other known peers via
                // awareness) - below that, reply immediately (still rate-limited
                // via _sendSyncReply() as a hard backstop). Matches the
                // MESSAGE_SYNC case's gate exactly; without this, a hash-mismatch
                // resync burst under packet loss bypassed suppression entirely,
                // since every peer answering a post-mismatch SyncStep1 replied
                // immediately via this path.
                if (encoding.length(encoder) > 1) {
                    this._replyToSyncRequest(encoding.toUint8Array(encoder));
                }
                break;
            }
            default:
                console.warn('Unknown message type:', messageType);
        }
    }
    /**
     * Handle a digest beacon (MESSAGE_SYNC_DIGEST). Reply rule (design doc
     * §3): SyncStep2 if the sender is behind us or its delete-set hash
     * differs from ours (the SyncStep2 always carries our full delete set, so
     * it also heals a lost delete on their side - and their beacon does the
     * same for us, symmetrically, within one interval); our own beacon as an
     * ack if the beacon is JOIN-flagged and states are equal; nothing
     * otherwise - which is what removes the ~5-12 empty replies per heartbeat
     * measured at N=50 in test/dummy/bench-idle-room.ts. "Sender is ahead of
     * us" triggers no reply: our own next beacon fetches it. Nothing here
     * removes a recovery path (the round-2 lesson in
     * 2026-09-04-resync-message-reduction-design.md's addendum), only
     * replies that carry no information.
     *
     * `synced`: a beacon we are not behind, with equal delete-set hash, is a
     * stronger statement than the empty SyncStep2 it replaces ("you lack
     * nothing I have"), so it marks us synced too - this is what keeps two
     * fresh peers, or a whole concurrent join burst, converging to `synced`
     * with no acks needing to survive the rate limiter.
     */
    _handleDigest(decoder, from) {
        decoding.readVarUint(decoder); // DIGEST_VERSION - append-only, nothing to branch on yet
        const flags = decoding.readVarUint(decoder);
        const senderClientID = decoding.readVarUint(decoder);
        this._knownPeers.add(senderClientID);
        if (from !== undefined)
            this._peerAddress.set(senderClientID, from);
        const remoteSv = decoding.readVarUint8Array(decoder);
        const remoteDsHash = decoding.readVarUint(decoder);
        // Any trailing bytes belong to a newer version; ignored by design.
        const remote = Y.decodeStateVector(remoteSv);
        const local = Y.decodeStateVector(Y.encodeStateVector(this.doc));
        let senderBehind = false;
        for (const [client, clock] of local) {
            if ((remote.get(client) ?? 0) < clock) {
                senderBehind = true;
                break;
            }
        }
        let weBehind = false;
        for (const [client, clock] of remote) {
            if ((local.get(client) ?? 0) < clock) {
                weBehind = true;
                break;
            }
        }
        const dsEqual = remoteDsHash === this._deleteSetHash();
        const equal = !senderBehind && !weBehind && dsEqual;
        if (flags & DIGEST_FLAG_ACK) {
            // Somebody confirmed the echoed state (see DIGEST_FLAG_ACK). If it is
            // ours, we're synced; if we were about to confirm the same state, we
            // no longer need to. Never a request: no reply, no presence.
            if (equal) {
                if (flags & DIGEST_FLAG_SETTLED) {
                    this._confirmed = true;
                    this._noteResponse(true);
                }
                else {
                    this._equalUnsettledSeen = true;
                }
                this._markSynced();
                this._cancelPendingAck();
            }
            return;
        }
        // An equal-digest beacon from a settled peer's periodic tick has just
        // told the room (including whoever our pending ack was for) that this
        // state is confirmed. Our ack would say the same thing again. Task 3b
        // in the design doc: without this, acks were ~94% of a 50-peer join
        // burst's messages, throttled only by the rate limiter. An equal JOIN
        // beacon (another joiner in the same burst) asks for an ack too; our
        // pending ack - identical bytes, since it echoes that same state -
        // answers it as well, and _scheduleSyncReply() dedupes it below.
        if (equal && !(flags & (DIGEST_FLAG_JOIN | DIGEST_FLAG_CONFIRM))) {
            // A peer's periodic/resync beacon in our state: it makes our pending
            // ack redundant, and - if that peer is confirmed - it answers our
            // own outstanding join as well as any ack would.
            if (flags & DIGEST_FLAG_SETTLED) {
                this._confirmed = true;
                this._noteResponse(false);
            }
            else {
                this._equalUnsettledSeen = true;
            }
            this._cancelPendingAck();
        }
        if (senderBehind || !dsEqual) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.writeSyncStep2(encoder, this.doc, remoteSv);
            this._replyToSyncRequest(encoding.toUint8Array(encoder), false, remoteSv, senderClientID);
        }
        else if (flags & (DIGEST_FLAG_JOIN | DIGEST_FLAG_CONFIRM)) {
            this._replyToSyncRequest(this._encodeAck(remoteSv, remoteDsHash), true, null, senderClientID);
        }
        if (!weBehind && dsEqual) {
            this._markSynced();
        }
        if (weBehind) {
            // The sender has something we lack. Not a request yet - the update
            // may still be in flight (see _scheduleBehindCheck).
            this._scheduleBehindCheck(remoteSv);
        }
        if (flags & DIGEST_FLAG_JOIN && this.awareness.getLocalState() !== null) {
            // Presence on demand: the joiner asked. One broadcast per burst of
            // joiners (see _schedulePresenceResponse), never suppressed (each
            // responder's state is distinct). Skipped when we have no state to
            // announce.
            this._schedulePresenceResponse(senderClientID);
        }
    }
    /**
     * Answer a JOIN beacon's presence request once for all JOIN beacons that
     * arrive within `clamp(2 * minRTT, 100, 500)` ms of the first - long
     * enough to cover a join burst spread by latency, short enough that a
     * lone joiner sees the room's presence within a few round trips.
     */
    _schedulePresenceResponse(requester) {
        this._presencePending.add(requester);
        if (this._presenceResponseTimer !== undefined)
            return;
        this._presenceCovered = false;
        const rtt = this._rttMinMs();
        // Phase 1e, relay path: one peer per 2 s bucket - the first-ranked
        // for a constant requester - relays the whole awareness table at once
        // (the way y-websocket's server does; clocks travel with the states,
        // a peer's own echoed state at an equal clock is ignored by
        // applyAwarenessUpdate). Everyone else waits the usual window, and
        // stays silent if that table carried their state (_presenceCovered).
        // Presence per late join: ~N deliveries instead of (N-1)^2 - it was
        // 82% of a late join into a 100-peer room (bench-join-census). Bytes
        // are unchanged (the table goes to everyone). Peers that cannot yet
        // tell (no RTT estimate on a slow link, so the table may arrive after
        // their window) fall back to the broadcast of their own state, as
        // before. The unicast path below is untouched.
        // Needs a view of the room: in a fresh burst the first JOIN arrives
        // before any peer is known, everyone would rank first and relay a
        // table each - the broadcast fallback is right for that case.
        const relayer = !this._canUnicast(requester) &&
            this._knownPeers.size >= 3 &&
            this._responderRank(0, 1) === 0;
        const delay = relayer ? 0 : Math.min(500, Math.max(100, rtt === null ? 0 : 2 * rtt));
        this._presenceResponseTimer = setTimeout(() => {
            this._presenceResponseTimer = undefined;
            const requesters = Array.from(this._presencePending);
            this._presencePending.clear();
            if (this._destroying || !this.transport.isConnected)
                return;
            if (this.awareness.getLocalState() === null)
                return;
            // Every joiner covered by this timer is addressable: one unicast
            // each ((N-1) deliveries per joiner room-wide) instead of one
            // broadcast ((N-1)^2). Otherwise the broadcast, as before.
            if (requesters.every((id) => this._canUnicast(id))) {
                const msg = this._encodeAwareness([this.doc.clientID]);
                for (const id of requesters)
                    this._sendDirect(id, msg);
            }
            else if (relayer) {
                this._sendAwarenessNow(Array.from(this.awareness.getStates().keys()));
            }
            else if (!this._presenceCovered) {
                this._broadcastAwareness([this.doc.clientID]);
            }
        }, delay);
    }
    /**
     * Max random delay (ms) before replying to a SyncStep1 request, scaled by
     * a room-size signal already available (`this.awareness.getStates().size`
     * - the same signal read at the `>= 3` suppression gate). A fixed window
     * (the pre-fix behavior: always `_syncReplySuppressionMs`) doesn't scale
     * with room size, so a larger room has more independent repliers racing
     * to answer the same request within the same window - more of them lose
     * the race and get silently dropped by the `_sendSyncReply()` rate-limit
     * backstop instead of never sending in the first place. Measured in
     * test/dummy/bench-corruption-storm.ts: the SyncStep2/SyncStep1 ratio (
     * ideally ~1 if suppression alone were sufficient) grew from ~1.1-1.3 at
     * N=2 to ~4.5-5.9 at N=10 with the fixed 30ms window.
     *
     * `min(cap, base * log2(peerCount))` - log2 growth spreads replies over a
     * wider window as the room grows without the delay exploding at very high
     * N. Capped at 200ms: the slowest-profile round trip this project
     * benchmarks against (Matrix, ~350ms one-way) already tolerates hundreds
     * of ms of latency, so 200ms of extra requester-perceived delay stays
     * well inside that budget while still giving a 100-peer room roughly
     * 6-7x the base window instead of an unbounded one.
     */
    /**
     * How many peers we believe are in the room: awareness states (includes
     * ourselves) or, if larger, the distinct beacon/update senders we have
     * heard plus ourselves. See `_knownPeers`.
     */
    _peerCount() {
        return Math.max(this.awareness.getStates().size, this._knownPeers.size + 1);
    }
    _replySuppressionMaxDelay() {
        const peerCount = this._peerCount();
        const byRoomSize = Math.min(200, this._syncReplySuppressionMs * Math.log2(Math.max(2, peerCount)));
        // Phase 1b: the window must exceed the one-way latency or nobody
        // overhears anybody in time (see _rttSamples). 1.5x the smallest
        // observed round trip, capped at 2 s - on a 350 ms profile that is
        // ~1 s of extra requester-perceived delay in exchange for ~1 reply
        // instead of ~20.
        const rtt = this._rttMinMs();
        return rtt === null ? byRoomSize : Math.min(2000, Math.max(byRoomSize, 1.5 * rtt));
    }
    /**
     * Schedule a SyncStep2 reply after a short random delay instead of
     * sending immediately. If another peer's reply is overheard in the
     * meantime (`_cancelPendingSyncReply`), this reply is dropped as
     * redundant - the requester likely already got what it needed.
     *
     * A reply that is already pending when this is called answers a
     * *different* request (e.g. peer A's request, followed 5ms later by
     * peer B's) - it must not be silently overwritten by the new one. Flush
     * it immediately, then schedule the new reply fresh. The only sanctioned
     * ways a reply gets dropped are `_cancelPendingSyncReply()` (we overheard
     * someone else's SyncStep2 for the SAME request), `_cancelPendingAck()`,
     * and the identical-bytes case below.
     *
     * Identical-bytes case (Task 3c in the design doc): K peers with the same
     * state asking at once (K empty joiners in a burst) get K byte-identical
     * SyncStep2s from us - the same full document K times, one flushed
     * immediately per arriving request, each burning a rate-limit slot. If
     * the new reply's bytes equal the pending reply's bytes, the pending one
     * already answers this request too: keep it (same delay, same
     * suppression) and drop the new one. Measured in
     * test/dummy/bench-join-after-burst.ts.
     */
    _scheduleSyncReply(reply, isAck = false, targetSv = null, requester = null) {
        if (this._pendingSyncReplyTimeoutId !== undefined && this._pendingSyncReply !== null) {
            if (bytesEqual(this._pendingSyncReply, reply)) {
                return; // identical answer already scheduled
            }
            if (targetSv !== null &&
                this._pendingSyncReplyTargetSv !== null &&
                bytesEqual(this._pendingSyncReplyTargetSv, targetSv)) {
                // Same question (same requester state), newer document: refresh
                // the answer, keep the timer. See _pendingSyncReplyTargetSv.
                this._pendingSyncReply = reply;
                return;
            }
            if (!isAck &&
                !this._pendingSyncReplyIsAck &&
                targetSv !== null &&
                this._pendingSyncReplyTargetSv !== null) {
                // Two requesters, both behind, different states: one SyncStep2
                // from the componentwise minimum of both state vectors contains
                // everything either of them lacks. Keep the pending reply's timer
                // and widen its content instead of flushing it. The flush (the
                // rule below, kept for acks and legacy SyncStep1s) sent an
                // unsuppressed broadcast for every second request that arrived
                // inside the suppression window; with the window at 1.5x RTT on a
                // 350 ms link and several peers behind after a lossy edit burst
                // that was ~4-5 broadcast replies per beacon (phase-1c results).
                const merged = minStateVector(this._pendingSyncReplyTargetSv, targetSv);
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, MESSAGE_SYNC);
                syncProtocol.writeSyncStep2(encoder, this.doc, merged);
                this._pendingSyncReply = encoding.toUint8Array(encoder);
                this._pendingSyncReplyTargetSv = merged;
                return;
            }
        }
        if (this._pendingSyncReplyTimeoutId !== undefined) {
            if (this._pendingSyncReply) {
                this._sendSyncReply(this._pendingSyncReply);
            }
            clearTimeout(this._pendingSyncReplyTimeoutId);
            this._pendingSyncReplyTimeoutId = undefined;
        }
        this._pendingSyncReply = reply;
        this._pendingSyncReplyIsAck = isAck;
        this._pendingSyncReplyTargetSv = targetSv;
        // Acks keep the uniform window: they carry no data, so their delay
        // costs nothing but a few ms on a joiner's `synced` flip, and in a
        // join burst one pending ack answers every equal JOIN that arrives
        // inside that window (identical bytes, deduped above). Ranked, rank 0
        // fired at once for every requester - measured: fresh-burst acks
        // 6,039 -> 15,147 at Gun N=100, join-after-burst Matrix 147 -> 686.
        const delay = isAck
            ? Math.random() * this._replySuppressionMaxDelay()
            : this._replyDelay(requester);
        this._pendingSyncReplyTimeoutId = setTimeout(() => {
            this._pendingSyncReplyTimeoutId = undefined;
            if (this._pendingSyncReply) {
                this._sendSyncReply(this._pendingSyncReply);
                this._pendingSyncReply = null;
                this._pendingSyncReplyTargetSv = null;
            }
        }, delay);
    }
    /** Cancel a pending suppressed reply, if any. */
    _cancelPendingSyncReply() {
        if (this._pendingSyncReplyTimeoutId !== undefined) {
            clearTimeout(this._pendingSyncReplyTimeoutId);
            this._pendingSyncReplyTimeoutId = undefined;
        }
        this._pendingSyncReply = null;
        this._pendingSyncReplyIsAck = false;
        this._pendingSyncReplyTargetSv = null;
    }
    /**
     * Cancel a pending reply only if it is a digest ack - see
     * `_pendingSyncReplyIsAck`. Called from `_handleDigest()` on every
     * overheard beacon whose digest equals ours.
     */
    _cancelPendingAck() {
        if (this._pendingSyncReplyIsAck) {
            this._cancelPendingSyncReply();
        }
    }
    /**
     * Route a SyncStep2 (or digest-ack) reply through the redundancy
     * suppression when there's genuine redundancy (>= 2 other known peers via
     * awareness - below that there's no "someone else" to rely on), else send
     * immediately. Both paths are rate-limited by `_sendSyncReply()`. Shared
     * by the MESSAGE_SYNC, MESSAGE_SYNC_VERIFIED and MESSAGE_SYNC_DIGEST cases.
     */
    _replyToSyncRequest(reply, isAck = false, targetSv = null, toClientID) {
        // A peer that knows it is incomplete does not answer. A SyncStep2 is
        // encoded from integrated structs only, so with structs (or a delete
        // set) still pending ours would be provably partial - and the
        // requester's response wait ends on the first SyncStep2 it gets, so a
        // partial answer strands it until its next trigger (phase-1c gates:
        // 5 s resync backoff, or a stall with syncInterval 0). In relay mode a
        // partial broadcast also cancels the complete replies other peers had
        // pending. Let them answer; the requester retries if nobody does, and
        // in unicast mode the rank bucket rotates the responders every 2 s.
        // An ack from us would likewise confirm a state we do not trust.
        if (this.doc.store.pendingStructs !== null ||
            this.doc.store.pendingDs !== null) {
            return;
        }
        // Unicast path (transport has sendTo and we know the requester's
        // address): nobody overhears a unicast, so the delay-and-cancel
        // suppression below cannot thin the replies. Instead each candidate
        // responder decides for itself whether it is one of ~3 that answer
        // (_selectedResponder), and answers at once - no suppression delay,
        // one delivery. The requester's response wait retries if all ~3 are
        // lost. Phase-1c design, item B.
        if (toClientID !== undefined && this._canUnicast(toClientID)) {
            if (!this._selectedResponder(toClientID))
                return;
            if (!this._tryReserveReplySlot())
                return;
            this._sendDirect(toClientID, reply);
            return;
        }
        // Acks ALWAYS take the delayed/suppressible path: they carry no data,
        // so the only cost of delaying one is a few ms on the joiner's `synced`
        // flip (measured before this rule: 37,240 of a 50-peer join burst's
        // 40,915 deliveries were immediate acks). Everything else goes through
        // suppression once there is someone else who could answer - counted
        // from beacon/update senders as well as awareness, see _peerCount().
        if (isAck || this._peerCount() >= 3) {
            this._scheduleSyncReply(reply, isAck, targetSv, toClientID ?? null);
        }
        else {
            this._sendSyncReply(reply);
        }
    }
    /** Whether a reply to `clientID` can go over Transport.sendTo. */
    _canUnicast(clientID) {
        return (typeof this.transport.sendTo === 'function' &&
            this._peerAddress.has(clientID));
    }
    /**
     * Responder self-selection for unicast replies: the three peers whose
     * hash for this requester ranks lowest among the peers we know answer
     * it. Every candidate ranks itself against the same known set, so the
     * sets agree wherever the views agree, and the peer that ranks first in
     * the true order always ranks first in its own view - the selection is
     * never empty. A 2 s time bucket in the hash rotates the ranking, so
     * three departed peers at the top only delay a reply until the
     * requester's next attempt. Everyone answers in rooms of four or fewer.
     * (A first cut chose each responder independently with probability 3/N;
     * ~5 % of requests then selected nobody and waited for the 1 s retry.)
     */
    _selectedResponder(requester) {
        if (this._peerCount() < 4)
            return true;
        return this._responderRank(requester, 3) < 3;
    }
    /**
     * How many known peers rank below us for `requester` in the current 2 s
     * bucket (counting stops at `cap`). Shared by unicast self-selection
     * (rank < 3 answers) and, since phase 1e, the relay-mode reply delay
     * (rank r waits r slots, see _replyDelay()).
     */
    _responderRank(requester, cap) {
        const bucket = Math.floor(Date.now() / 2000);
        const rank = (id) => (Math.imul(requester ^ bucket, 0x9e3779b1) ^ Math.imul(id, 0x85ebca6b)) >>> 0;
        const mine = rank(this.doc.clientID);
        let better = 0;
        for (const id of this._knownPeers) {
            if (id === requester || id === this.doc.clientID)
                continue;
            if (rank(id) < mine && ++better >= cap)
                break;
        }
        return better;
    }
    /**
     * Delay before a suppressible reply goes out (relay path). Phase 1e:
     * ranked, not uniform. A uniform draw from [0, W] lets ~N * L / W
     * repliers fire before the first reply is overheard (L = one-way
     * latency): 10-27 SyncStep2 sends per request at N=100 in
     * test/dummy/bench-join-census.ts, and the WebRTC join-burst cell's
     * 16-34k spread. With the responder rank (the same hash the unicast
     * self-selection uses) rank 0 answers at once and rank r waits r
     * windows (W = _replySuppressionMaxDelay(), 1.5x the minimum round
     * trip: with request arrival spread 2jL and reply flight L(1+j), rank 1
     * has overheard rank 0 iff the slot is >= L(1+3j), which 3L(1-j) covers
     * up to j~0.33). Ranks >= 8 add a random window on top so a room whose
     * first eight ranked peers are all gone does not answer in one
     * avalanche. Without an RTT sample or a requester id (legacy SyncStep1)
     * the uniform window stays.
     */
    _replyDelay(requester) {
        const window = this._replySuppressionMaxDelay();
        if (requester === null || this._rttMinMs() === null)
            return Math.random() * window;
        const rank = this._responderRank(requester, 8);
        return rank * window + (rank >= 8 ? Math.random() * window : 0);
    }
    /**
     * Send one already-encoded message to a single peer over
     * Transport.sendTo, with the same CRC32 wrapping and optional compression
     * as a broadcast. Not mirrored to BroadcastChannel (a same-browser tab
     * never appears as an addressable peer). Returns false if the peer's
     * address is unknown or the transport cannot unicast.
     */
    _sendDirect(clientID, data) {
        const address = this._peerAddress.get(clientID);
        if (address === undefined || typeof this.transport.sendTo !== 'function') {
            return false;
        }
        if (!this.transport.isConnected)
            return false;
        this._sendToTransport(wrapMessageWithChecksum(data), address);
        return true;
    }
    /**
     * Re-check Yjs's pending-struct store after the gap grace period and
     * request a resync (a beacon, see _requestResync) only if something is
     * still missing. One timer; a check scheduled while one is pending is
     * absorbed. Cleared on disconnect/destroy.
     */
    /**
     * A beacon (a peer's periodic tick, or its request) just showed its
     * sender ahead of us. Until phase 1d nothing happened with that: a peer
     * whose last update was lost (no later message to open a sequence gap
     * against), or whose request was answered by a responder that was
     * itself behind, waited for its OWN next periodic beacon - up to
     * syncInterval, up to idleBackoffMaxMs with idle backoff on. Now we
     * check again after a grace and, if still behind that state, ask through
     * the resync coordinator (coalesced, backed off, rate-limited).
     *
     * The grace is what keeps this quiet during typing: at Matrix latency
     * almost every receiver of a periodic beacon is "behind" by a keystroke
     * that is still in flight (jitter +-140 ms); max(gapGraceMs, 2 x minRTT)
     * later it has arrived and the check finds nothing to do. A lost
     * keystroke that opened a sequence gap is already being requested by the
     * gap check - the outstanding response wait tells us so, and we stay
     * quiet. One timer, the newest state vector: a later beacon that shows us
     * behind by more replaces the reference, the timer keeps running.
     */
    _scheduleBehindCheck(remoteSv) {
        this._behindSv = remoteSv;
        if (this._behindCheckTimer !== undefined)
            return;
        const rtt = this._rttMinMs();
        const delay = Math.max(this._gapGraceMs, rtt === null ? 0 : 2 * rtt);
        this._behindCheckTimer = setTimeout(() => {
            this._behindCheckTimer = undefined;
            const sv = this._behindSv;
            this._behindSv = null;
            if (sv === null || this._destroying || !this.transport.isConnected)
                return;
            // A request of ours sent within the grace is still being answered.
            // An OLDER outstanding wait is not a reason to stay behind: a new
            // room's first peers keep their JOIN wait parked for seconds (three
            // retries, nobody SETTLED yet), and measured against it the check
            // never fired - bench-idle-backoff's recovery stayed at one
            // backed-off interval (1,846 ms) with this line reading
            // `_responseWaitTimer !== undefined`.
            if (this._requestSentAt > 0 && Date.now() - this._requestSentAt < delay)
                return;
            const remote = Y.decodeStateVector(sv);
            const local = Y.decodeStateVector(Y.encodeStateVector(this.doc));
            for (const [client, clock] of remote) {
                if ((local.get(client) ?? 0) < clock) {
                    this._requestResync();
                    return;
                }
            }
        }, delay);
    }
    /** Design E: after a reply or push, pending structs mean the sender had the same hole - arm the grace check. */
    _checkPendingAfterReply() {
        if (this.doc.store.pendingStructs !== null ||
            this.doc.store.pendingDs !== null) {
            this._schedulePendingCheck();
        }
    }
    _schedulePendingCheck() {
        if (this._pendingCheckTimer !== undefined)
            return;
        this._pendingCheckTimer = setTimeout(() => {
            this._pendingCheckTimer = undefined;
            if (this._destroying || !this.transport.isConnected)
                return;
            // A request of ours may already be outstanding (JOIN or resync beacon
            // with its response wait running): whatever is pending is what that
            // request is fetching, and the response wait retries if it is lost.
            // Asking again here just raced the responders' suppression window
            // (measured: a joiner's keystrokes-before-content check fired at
            // 300 ms while the settled peers' replies were still delayed by a
            // window of up to ~300 ms, and every such re-beacon collected
            // another round of replies).
            // ... but only a request that went out within the last grace, whose
            // answer may still be on its way. Deferring to ANY outstanding
            // response wait (the rule until phase 1d) parked every pending check
            // behind a new room's JOIN wait - three retries with nobody SETTLED
            // yet, 19.6 s on a 700 ms link - so a peer that lost a keystroke in
            // such a room asked only once an overheard reply happened to clear
            // that wait (phase-1d design doc, "After Task 4", the fresh-budget
            // Matrix fan-out). Look again once the recent request is answered or
            // given up - dropping the check here left a joiner whose SyncStep2
            // predated the keystrokes it had received with nine pending updates
            // and no trigger (measured: 2 of 150 lossy 15-peer joins).
            const rtt = this._rttMinMs();
            const recent = Math.max(this._gapGraceMs, rtt === null ? 0 : 2 * rtt);
            if (this._requestSentAt > 0 && Date.now() - this._requestSentAt < recent) {
                this._schedulePendingCheck();
                return;
            }
            if (this.doc.store.pendingStructs !== null ||
                this.doc.store.pendingDs !== null) {
                this._requestResync();
            }
        }, this._gapGraceMs);
    }
    /**
     * Return the update payload of a SyncStep2/Update sync sub-message
     * without advancing `decoder` (null for SyncStep1 or malformed input).
     * y-protocols frames both as [subType varUint][update varUint8Array].
     */
    _peekSyncUpdate(decoder) {
        const peek = decoding.clone(decoder);
        try {
            const subType = decoding.readVarUint(peek);
            if (subType === syncProtocol.messageYjsSyncStep1)
                return null;
            return decoding.readVarUint8Array(peek);
        }
        catch {
            return null;
        }
    }
    /**
     * Whether an update we just applied was already superseded here: every
     * client it touches ends at a clock we were at or beyond BEFORE this
     * update (i.e. it added nothing). Uses the update's own metadata
     * (`Y.parseUpdateMeta`), O(clients in the update).
     */
    _isLateUpdate(updateBytes) {
        if (!updateBytes)
            return false;
        try {
            const { to } = Y.parseUpdateMeta(updateBytes);
            if (to.size === 0)
                return false;
            const local = Y.decodeStateVector(Y.encodeStateVector(this.doc));
            for (const [client, clock] of to) {
                // `to` is the exclusive end clock of the update's range for that
                // client; our state vector is exclusive too. Equal means the update
                // brought us exactly here (not late); greater means we were past it.
                if ((local.get(client) ?? 0) <= clock)
                    return false;
            }
            return true;
        }
        catch {
            return false;
        }
    }
    /** Flip `synced` once and emit; idempotent. */
    _markSynced() {
        if (!this._synced) {
            this._synced = true;
            this.emit('synced', [true]);
        }
    }
    /**
     * Wait for a response to the JOIN or resync beacon we just sent. If
     * neither a SyncStep2 nor an equal ack/beacon arrives within 1s (then
     * 2s, 4s), ask again - with a CONFIRM beacon after a JOIN (so an equal
     * room acks), with a plain beacon after a resync (only peers ahead of us
     * need to answer; an equal room's silence is the correct answer and its
     * periodic beacons end the wait) - three times at most; after that the
     * periodic beacon is the fallback, as before. Requester-side retry is how the protocol
     * stays loss-tolerant now that reply suppression leaves ~1 reply per
     * request; N-fold redundant replies were the old (accidental) way.
     */
    _armResponseWait(retryFlags) {
        if (this._responseWaitTimer !== undefined)
            return;
        this._responseSeen = false;
        if (this._responseWaitAttempts === 0)
            this._equalUnsettledSeen = false;
        this._responseWaitFlags = retryFlags;
        this._requestSentAt = Date.now();
        const rtt = this._rttMinMs();
        const delay = Math.max(1000, rtt === null ? 0 : 4 * rtt) *
            Math.pow(2, this._responseWaitAttempts);
        this._responseWaitTimer = setTimeout(() => {
            this._responseWaitTimer = undefined;
            // Phase 1e: a fresh room - equal but unsettled peers answered both
            // the JOIN and one CONFIRM retry, nobody settled did. Two rounds
            // instead of three; the first confirmed peers' acks then carry
            // SETTLED for everyone after them. Measured in
            // test/dummy/bench-join-census.ts (b): the third round was ~a third
            // of a fresh N=100 room's 92k-delivery join burst.
            const freshRoomDone = this._equalUnsettledSeen && this._responseWaitAttempts >= 1;
            if (this._responseSeen ||
                this._responseWaitAttempts >= 3 ||
                freshRoomDone ||
                !this.transport.isConnected ||
                this._destroying) {
                // Asked three times, nobody had more for us: we are the room's
                // state (or its first peer). Bootstraps DIGEST_FLAG_SETTLED in a
                // brand-new room so later joiners are confirmed by our acks.
                if (this._responseWaitAttempts >= 3 || freshRoomDone)
                    this._confirmed = true;
                this._responseWaitAttempts = 0;
                return;
            }
            this._responseWaitAttempts++;
            this._sendSyncStep1(this._responseWaitFlags); // rate-limited; a dropped attempt is simply retried next round
            this._armResponseWait(this._responseWaitFlags);
        }, delay);
    }
    /**
     * A SyncStep2 or an equal ack/beacon arrived - whatever we asked for is
     * answered. `sample` = it was a direct reply (SyncStep2/ack), so its
     * timing is a round-trip sample; an equal periodic beacon from a settled
     * peer also ends the wait but says nothing about latency.
     */
    _noteResponse(sample) {
        if (sample && this._requestSentAt > 0) {
            this._rttSamples.push(Date.now() - this._requestSentAt);
            if (this._rttSamples.length > 8)
                this._rttSamples.shift();
        }
        this._requestSentAt = 0;
        this._responseSeen = true;
        this._responseWaitAttempts = 0;
        if (this._responseWaitTimer !== undefined) {
            clearTimeout(this._responseWaitTimer);
            this._responseWaitTimer = undefined;
        }
    }
    /** Minimum of the recent round-trip samples, or null before the first reply. */
    _rttMinMs() {
        return this._rttSamples.length === 0 ? null : Math.min(...this._rttSamples);
    }
    /**
     * Delay a pure timeout-removal awareness broadcast and drop it if
     * another peer's broadcast of the SAME removal is overheard first (see
     * the `origin === this` branch in `_setupAwarenessSync()`'s handler,
     * which calls `_cancelPendingAwarenessRemovalIfOverlaps()`) - the exact
     * same NACK-style suppression `_scheduleSyncReply()` already applies to
     * SyncStep2 replies, reusing the same room-size-scaled delay
     * (`_replySuppressionMaxDelay()`).
     *
     * A pending removal already queued when this is called is for a
     * DIFFERENT departure (two peers timing out within the same suppression
     * window) - flush it immediately rather than silently overwrite it, then
     * queue the new one fresh. If it turns out to cover more than one
     * clientID and only some overlap with a later-overheard broadcast,
     * `_cancelPendingAwarenessRemovalIfOverlaps()` drops the whole pending
     * set on ANY overlap rather than partially trimming it - simpler, and
     * the dropped-but-not-actually-covered client(s) are still safe: every
     * OTHER surviving peer is independently running this same suppression
     * for them too.
     */
    _scheduleAwarenessRemoval(clients) {
        if (this._pendingAwarenessRemovalTimeoutId !== undefined) {
            if (this._pendingAwarenessRemoval) {
                this._broadcastAwareness(this._pendingAwarenessRemoval);
            }
            clearTimeout(this._pendingAwarenessRemovalTimeoutId);
            this._pendingAwarenessRemovalTimeoutId = undefined;
        }
        this._pendingAwarenessRemoval = clients;
        const delay = Math.random() * this._replySuppressionMaxDelay();
        this._pendingAwarenessRemovalTimeoutId = setTimeout(() => {
            this._pendingAwarenessRemovalTimeoutId = undefined;
            if (this._pendingAwarenessRemoval) {
                this._broadcastAwareness(this._pendingAwarenessRemoval);
                this._pendingAwarenessRemoval = null;
            }
        }, delay);
    }
    /**
     * Peek at an awareness-update payload (still in
     * `awarenessProtocol.encodeAwarenessUpdate()`'s wire encoding) for
     * clientIDs whose state is `null` (a removal), without applying it.
     * y-protocols/awareness.js doesn't export a standalone decoder for this,
     * only `applyAwarenessUpdate()` (which also mutates state) and
     * `modifyAwarenessUpdate()` (which re-encodes) - so this mirrors the
     * format by hand: varUint length, then per entry
     * [varUint clientID][varUint clock][varString JSON state]. Used to cancel
     * a pending suppressed removal (see `_scheduleAwarenessRemoval()`) at the
     * wire-message level, before `applyAwarenessUpdate()` runs - see the
     * `MESSAGE_AWARENESS` case's comment for why timing matters here.
     */
    _scanAwarenessPayload(payload) {
        const removed = [];
        let coversUs = false;
        try {
            const d = decoding.createDecoder(payload);
            const len = decoding.readVarUint(d);
            const ourClock = this.awareness.meta.get(this.awareness.clientID)?.clock ?? 0;
            for (let i = 0; i < len; i++) {
                const clientID = decoding.readVarUint(d);
                const clock = decoding.readVarUint(d);
                const state = JSON.parse(decoding.readVarString(d));
                if (state === null)
                    removed.push(clientID);
                else if (clientID === this.awareness.clientID && clock >= ourClock)
                    coversUs = true;
            }
        }
        catch {
            // Malformed payload - let applyAwarenessUpdate() below be the one
            // that deals with it (or throws); suppression is a pure optimization,
            // never worth failing the actual message handling over.
        }
        return { removed, coversUs };
    }
    /**
     * Drop a pending suppressed removal broadcast if it overlaps
     * `removedClientIds` - someone else already broadcast (at least part of)
     * the same departure, so ours is redundant.
     */
    _cancelPendingAwarenessRemovalIfOverlaps(removedClientIds) {
        if (!this._pendingAwarenessRemoval)
            return;
        if (!this._pendingAwarenessRemoval.some((id) => removedClientIds.includes(id))) {
            return;
        }
        if (this._pendingAwarenessRemovalTimeoutId !== undefined) {
            clearTimeout(this._pendingAwarenessRemovalTimeoutId);
            this._pendingAwarenessRemovalTimeoutId = undefined;
        }
        this._pendingAwarenessRemoval = null;
    }
    /** Cancel a pending suppressed awareness-removal broadcast, if any. */
    _cancelPendingAwarenessRemoval() {
        if (this._pendingAwarenessRemovalTimeoutId !== undefined) {
            clearTimeout(this._pendingAwarenessRemovalTimeoutId);
            this._pendingAwarenessRemovalTimeoutId = undefined;
        }
        this._pendingAwarenessRemoval = null;
    }
    /**
     * Send a SyncStep2 reply, gated by the same shared per-peer budget as
     * SyncStep1 requests/syncNow() pushes (`_tryReserveSyncSlot()`).
     *
     * Previously SyncStep2 replies were completely unrated - the only
     * defense against redundant replies was the best-effort NACK-style
     * suppression in `_scheduleSyncReply()`/`_cancelPendingSyncReply()`,
     * which itself is just an ordinary broadcast message subject to the same
     * wire corruption as everything else. Under sustained corruption, more
     * competing repliers independently miss the "someone already answered"
     * signal as peer count grows, and none of that traffic was bounded.
     * Measured in test/dummy/bench-corruption-storm.ts: SyncStep2/SyncStep1
     * ratio grew from ~1.1-1.3 at N=2 to ~4.5-5.9 at N=10 (should stay near
     * 1 if suppression alone were sufficient). This is a hard backstop on
     * top of that suppression, not a replacement for it - a rate-limited
     * reply is dropped silently (no warn) since under normal, uncorrupted
     * operation this path is rarely exercised and logging every drop here
     * would itself become log spam exactly when things are already noisy.
     */
    _sendSyncReply(reply) {
        if (!this._tryReserveReplySlot()) {
            return; // Rate limited - drop the reply silently
        }
        this._send(reply);
    }
    /**
     * Track a received sequence number for reordering-tolerant gap detection.
     * Does not gate whether the update gets applied — only decides whether a
     * gap looks suspicious enough to (eventually) request a resync.
     */
    _trackRemoteSeq(senderClientID, seqNum) {
        let info = this._remoteSeqInfo.get(senderClientID);
        if (!info) {
            info = { highest: -1, seen: new Set() };
            this._remoteSeqInfo.set(senderClientID, info);
        }
        if (info.seen.has(seqNum)) {
            return; // genuine duplicate - nothing new to track
        }
        info.seen.add(seqNum);
        if (seqNum > info.highest) {
            if (info.highest >= 0 && seqNum > info.highest + 1) {
                this._scheduleGapCheck(senderClientID, info.highest + 1, seqNum - 1);
            }
            info.highest = seqNum;
        }
        // Bound memory: forget seqNums far behind the current high-water mark.
        const floor = info.highest - this._seqWindowSize;
        if (floor > 0) {
            for (const s of info.seen) {
                if (s < floor)
                    info.seen.delete(s);
            }
        }
    }
    /**
     * Re-check a suspected sequence gap after a short grace period instead of
     * requesting a resync immediately. Pure network reordering (a message
     * that's merely late, not lost) typically resolves itself within the
     * grace window, so this avoids the resync storms that immediate gap
     * detection caused under jitter. Real packet loss still gets caught —
     * just `_gapGraceMs` later — and the periodic sync interval / hash
     * verification remain as further safety nets regardless.
     */
    _scheduleGapCheck(clientID, gapStart, gapEnd) {
        // Only one pending check per sender; a newly-opened gap while a check
        // is already scheduled will still be caught by periodic sync / hash
        // verification even if not by this specific check.
        if (this._gapCheckTimers.has(clientID))
            return;
        const timer = setTimeout(() => {
            this._gapCheckTimers.delete(clientID);
            const info = this._remoteSeqInfo.get(clientID);
            if (!info || this._destroying)
                return;
            let stillMissing = 0;
            for (let s = gapStart; s <= gapEnd; s++) {
                if (!info.seen.has(s))
                    stillMissing++;
            }
            if (stillMissing > 0 && this.transport.isConnected) {
                console.warn(`[GenericProvider] Sequence gap confirmed from client ${clientID}: ` +
                    `${stillMissing} message(s) still missing after ${this._gapGraceMs}ms grace period`);
                // Routed through the shared coordinator (previously called
                // _sendSyncStep1() directly with NO coalescing at all - the one
                // remaining gap that let this trigger steal rate-limit slots
                // independently of the hash-mismatch/corrupted-message triggers).
                this._requestResync();
            }
        }, this._gapGraceMs);
        this._gapCheckTimers.set(clientID, timer);
    }
    /**
     * Unified entry point for ALL resync triggers (hash mismatch, corrupted
     * message, confirmed sequence gap). Coalesces them behind a single
     * pending timer and a single shared escalation counter, so a burst of
     * triggers from different causes in a short window schedules exactly one
     * resync instead of three independent ones each able to draw on the
     * shared `_tryReserveSyncSlot()` budget on their own.
     *
     * Always resolves to `syncNow()` (push + pull) rather than distinguishing
     * a push-only/pull-only variant per trigger. `syncNow()`'s push half is
     * already a no-op when there's nothing to send (it only calls
     * `_sendUpdate()` when `update.length > 0`), so unifying on push+pull is
     * strictly simpler than threading a `push` flag through a *shared*
     * coordinator (where the "right" answer for an absorbed trigger is
     * ambiguous anyway - was it push-worthy or not?). It also closes a latent
     * gap where the corrupted-message and gap-confirmed triggers previously
     * called pull-only `_sendSyncStep1()` and could never deliver this peer's
     * own surplus edits made during a divergence window.
     */
    _requestResync() {
        // Coalesced: if a resync is already pending (regardless of which
        // trigger scheduled it), this trigger is absorbed into it instead of
        // stacking another independent timer/broadcast. Escalation only
        // advances when we actually schedule a NEW timer below - incrementing
        // unconditionally here (once per absorbed trigger too) would let a
        // burst of many corrupted/mismatched messages while one resync is
        // already pending ratchet the counter straight to its cap, so the
        // *next* resync (after this one fires) always schedules at the max
        // backoff instead of escalating gradually.
        if (this._pendingResyncTimeoutId !== undefined) {
            return;
        }
        this._resyncAttemptCount++;
        const now = Date.now();
        // Reset the escalation counter if it's been stable for 10 seconds -
        // same quiet-period reset the old per-trigger counters used.
        if (now - this._lastResyncAttemptTime > 10000) {
            this._resyncAttemptCount = 1;
        }
        this._lastResyncAttemptTime = now;
        // Exponential backoff: 100ms, 500ms, 2.5s, then cap at 5s.
        const delay = Math.min(5000, 100 * Math.pow(5, Math.min(this._resyncAttemptCount - 1, 3)));
        console.warn(`[GenericProvider] Resync scheduled in ${delay}ms (attempt #${this._resyncAttemptCount})...`);
        this._pendingResyncTimeoutId = setTimeout(() => {
            this._pendingResyncTimeoutId = undefined;
            if (!this.transport.isConnected || this._destroying)
                return;
            // A resync trigger means "I may be missing something" - never "the
            // room is missing my data" (my updates travel on their own, and the
            // connect-time push covers offline edits). So: ask with a 12-byte
            // beacon; the peers ahead of me reply with exactly the diff (a
            // SyncStep2 against my state vector, suppressed as any reply), the
            // rest stay silent. Until phase 1b this pushed the WHOLE document to
            // the room on every trigger, and that push - a hashed update of my
            // state - failed the hash check at every peer ahead of me, which
            // scheduled a resync of its own: the cascade of research doc item 13
            // (198,990 deliveries for 10 keystrokes at N=100 on the Gun profile,
            // the rate limiter's ceiling). If the beacon or its reply is lost,
            // _armResponseWait() re-beacons (1s/2s/4s); the periodic beacon is
            // the fallback after that. A rate-limited attempt re-arms through
            // this same coordinator so a stranded peer keeps retrying.
            if (this._sendSyncStep1(0)) {
                this._armResponseWait(0);
            }
            else {
                this._requestResync();
            }
        }, delay);
    }
    /**
     * Reserve a slot in the sync rate limiter (max `_maxSyncRequestsPerWindow`
     * per `_syncRequestWindowMs`), recording the request if there's room.
     * Shared by `_sendSyncStep1()` and `syncNow()` so a burst of triggers from
     * different sources (periodic sync, hash-mismatch resyncs, gap-check
     * confirmations) draws from one combined budget instead of each having
     * its own uncapped or separately-capped allowance.
     */
    _tryReserveSyncSlot() {
        return this._tryReserveSlot(this._syncRequestTimes);
    }
    /** Same limiter, separate budget, for SyncStep2 replies and acks. */
    _tryReserveReplySlot() {
        return this._tryReserveSlot(this._syncReplyTimes);
    }
    _tryReserveSlot(times) {
        const now = Date.now();
        // Drop entries outside the rolling window (in place: the arrays are
        // referenced from two fields)
        let keep = 0;
        for (const t of times) {
            if (now - t < this._syncRequestWindowMs)
                times[keep++] = t;
        }
        times.length = keep;
        if (times.length >= this._maxSyncRequestsPerWindow) {
            return false;
        }
        times.push(now);
        return true;
    }
    /**
     * Encode the digest beacon that replaces SyncStep1 (see
     * MESSAGE_SYNC_DIGEST). Still the one place every "request sync" path
     * goes through (connect()'s syncNow(), the periodic tick,
     * _requestResync()'s retry), so they all switched together.
     */
    _encodeSyncStep1(flags = 0) {
        if (this._confirmed)
            flags |= DIGEST_FLAG_SETTLED;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC_DIGEST);
        encoding.writeVarUint(encoder, DIGEST_VERSION);
        encoding.writeVarUint(encoder, flags);
        encoding.writeVarUint(encoder, this.doc.clientID);
        encoding.writeVarUint8Array(encoder, Y.encodeStateVector(this.doc));
        encoding.writeVarUint(encoder, this._deleteSetHash());
        return encoding.toUint8Array(encoder);
    }
    /**
     * Encode an ack for a JOIN beacon: same framing as a beacon, DIGEST_FLAG_ACK
     * set, and the JOINER's state vector + delete-set hash echoed back instead
     * of ours (see DIGEST_FLAG_ACK for why it must never carry our own state).
     */
    _encodeAck(ackedSv, ackedDsHash) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC_DIGEST);
        encoding.writeVarUint(encoder, DIGEST_VERSION);
        encoding.writeVarUint(encoder, DIGEST_FLAG_ACK | (this._confirmed ? DIGEST_FLAG_SETTLED : 0));
        encoding.writeVarUint(encoder, this.doc.clientID);
        encoding.writeVarUint8Array(encoder, ackedSv);
        encoding.writeVarUint(encoder, ackedDsHash);
        return encoding.toUint8Array(encoder);
    }
    /**
     * Send the periodic digest beacon. Rate limited to prevent spam. Returns
     * whether it actually sent (false means rate-limited).
     */
    _sendSyncStep1(flags = 0) {
        if (!this._tryReserveSyncSlot()) {
            console.warn(`[GenericProvider] Sync rate limit exceeded (${this._maxSyncRequestsPerWindow} requests per ${this._syncRequestWindowMs / 1000}s), throttling...`);
            return false; // Drop the request
        }
        this._send(this._encodeSyncStep1(flags));
        return true;
    }
    /**
     * Encode a document update, without sending it. Extracted from the old
     * `_sendUpdate()` so `_trySyncPushPull()` can fold the push half into a
     * batched wire send (see `_sendBatch()`); `_sendUpdate()` below is the
     * send-immediately form still used by every other update-emitting path
     * (the doc-update handler, batch-flush, disconnect/destroy flush) since
     * those aren't part of this batching effort's scope.
     *
     * NOTE: has a side effect (`_localSeqNum++`) - call exactly once per
     * logical update, same as before.
     */
    _encodeUpdate(update) {
        const encoder = encoding.createEncoder();
        if (this._verifyUpdates) {
            // Use verified sync protocol with sequence number and hash
            encoding.writeVarUint(encoder, MESSAGE_SYNC_VERIFIED);
            // Include sequence number and clientID for causal ordering
            encoding.writeVarUint(encoder, this._localSeqNum++);
            encoding.writeVarUint(encoder, this.doc.clientID);
            syncProtocol.writeUpdate(encoder, update);
            // Include document hash after applying this update (signed integer)
            const hash = computeDocHash(this.doc);
            encoding.writeVarInt(encoder, hash);
        }
        else {
            // Standard sync protocol without verification
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.writeUpdate(encoder, update);
        }
        return encoding.toUint8Array(encoder);
    }
    /**
     * Encode a full-state push (see MESSAGE_SYNC_PUSH): the document as one
     * update, deliberately without the hash and sequence number that
     * `_encodeUpdate()` adds to incremental updates.
     */
    _encodePush(update) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC_PUSH);
        encoding.writeVarUint8Array(encoder, update);
        return encoding.toUint8Array(encoder);
    }
    /**
     * Send a document update to the transport.
     * If verifyUpdates is enabled, includes sequence number and document hash for ordering and desync detection.
     */
    _sendUpdate(update) {
        this._send(this._encodeUpdate(update));
    }
    /**
     * Send awareness update to the transport.
     */
    _sendAwarenessUpdate(changedClients) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
        this._send(encoding.toUint8Array(encoder));
    }
    /**
     * Send a pub/sub message.
     * Internal method called by PubSubChannel.
     */
    _sendPubSub(topic, message) {
        if (!this.transport.isConnected) {
            console.warn('Cannot send pub/sub message: not connected');
            return;
        }
        try {
            const encoder = encoding.createEncoder();
            // Write message type
            encoding.writeVarUint(encoder, MESSAGE_PUBSUB);
            // Write topic
            encoding.writeVarString(encoder, topic);
            // Encode message as JSON
            const messageStr = JSON.stringify(message);
            const textEncoder = new TextEncoder();
            const messageBytes = textEncoder.encode(messageStr);
            // Write message payload
            encoding.writeVarUint8Array(encoder, messageBytes);
            this._send(encoding.toUint8Array(encoder));
        }
        catch (error) {
            console.error('Error sending pub/sub message:', error);
        }
    }
    /**
     * Broadcast awareness state for the specified clients.
     * Throttled to prevent awareness updates from flooding document sync.
     * Multiple rapid updates are batched together.
     */
    _broadcastAwareness(clients) {
        if (clients.length === 0)
            return;
        // If throttling is disabled, send immediately
        if (this._awarenessInterval <= 0) {
            this._sendAwarenessNow(clients);
            return;
        }
        // Add clients to pending set
        for (const client of clients) {
            this._pendingAwarenessClients.add(client);
        }
        // If we already have a scheduled broadcast, let it handle the batched clients
        if (this._awarenessTimeoutId !== undefined) {
            return;
        }
        // Calculate delay - respect minimum interval since last broadcast
        const now = Date.now();
        const timeSinceLastBroadcast = now - this._lastAwarenessTime;
        const delay = Math.max(0, this._awarenessInterval - timeSinceLastBroadcast);
        // Schedule the batched broadcast
        this._awarenessTimeoutId = setTimeout(() => {
            this._awarenessTimeoutId = undefined;
            this._lastAwarenessTime = Date.now();
            // Send all pending clients in one message
            const clientsToSend = Array.from(this._pendingAwarenessClients);
            this._pendingAwarenessClients.clear();
            if (clientsToSend.length > 0) {
                this._sendAwarenessNow(clientsToSend);
            }
        }, delay);
    }
    /**
     * Encode an awareness update, without sending it. Extracted from the old
     * `_sendAwarenessNow()` so `_tryImmediateAwarenessMessage()` can fold it
     * into a batched wire send instead of always sending it as its own
     * message.
     */
    _encodeAwareness(clients) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
        return encoding.toUint8Array(encoder);
    }
    /**
     * Send awareness update immediately without throttling.
     */
    _sendAwarenessNow(clients) {
        this._send(this._encodeAwareness(clients));
    }
    /**
     * Attempt to build an awareness broadcast message for immediate
     * inclusion in the same wire send as a sync message a caller is about to
     * send anyway (see `_trySyncPushPull`'s `buildExtra` parameter), instead
     * of going through
     * `_broadcastAwareness()`'s independent debounce.
     *
     * Only returns non-null when the throttle would have let an immediate
     * send through anyway - i.e. no debounced broadcast is already pending
     * AND (throttling is disabled, or at least `_awarenessInterval` ms have
     * passed since the last broadcast) - so this never changes awareness
     * throttle semantics, only whether the resulting message travels as its
     * own wire send or bundled with a sync message that happens to be going
     * out "now" too.
     *
     * Mutates the same state `_broadcastAwareness()`'s own immediate-send
     * branches mutate (`_pendingAwarenessClients`, `_lastAwarenessTime`) -
     * once this returns non-null, the state is already committed as "sent
     * now", so the caller MUST actually send the returned message (bundled
     * or standalone) rather than discarding it.
     */
    _tryImmediateAwarenessMessage(clients) {
        if (clients.length === 0)
            return null;
        // A debounced broadcast is already scheduled - let it handle these
        // clients via the normal pending-set path below, don't race it with an
        // immediate send here.
        if (this._awarenessTimeoutId !== undefined)
            return null;
        if (this._awarenessInterval > 0) {
            const timeSinceLastBroadcast = Date.now() - this._lastAwarenessTime;
            if (timeSinceLastBroadcast < this._awarenessInterval)
                return null;
        }
        // Merge with anything already pending (normally empty here since no
        // timer is scheduled, but merge for safety) and commit to sending now -
        // mirrors exactly what _broadcastAwareness()'s own immediate
        // (_awarenessInterval <= 0) and debounced-timer-fired branches do.
        for (const c of clients)
            this._pendingAwarenessClients.add(c);
        const clientsToSend = Array.from(this._pendingAwarenessClients);
        this._pendingAwarenessClients.clear();
        if (clientsToSend.length === 0)
            return null;
        this._lastAwarenessTime = Date.now();
        return this._encodeAwareness(clientsToSend);
    }
    /**
     * Setup BroadcastChannel for cross-tab communication.
     * Automatically disabled in non-browser environments.
     */
    _setupBroadcastChannel(config) {
        // Check if BroadcastChannel is available and not disabled
        if (this._disableBc ||
            typeof BroadcastChannel === 'undefined' ||
            typeof window === 'undefined') {
            return;
        }
        // Create channel name based on room
        this._bcChannel = `yjs-${config.room}`;
        // Setup subscriber for incoming messages from other tabs
        this._bcSubscriber = (data, origin) => {
            // Ignore messages from this provider instance
            if (origin === this) {
                return;
            }
            // Messages from BroadcastChannel are already CRC32-wrapped
            // Pass through to _handleIncomingMessage which will unwrap and verify
            const uint8Data = new Uint8Array(data);
            this._handleIncomingMessage(uint8Data);
        };
        // Subscribe to the channel
        bc.subscribe(this._bcChannel, this._bcSubscriber);
        this._bcConnected = true;
        // Send initial sync via BroadcastChannel (wrapped with CRC32)
        // This allows syncing with other tabs immediately
        const encoderSync = encoding.createEncoder();
        encoding.writeVarUint(encoderSync, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoderSync, this.doc);
        bc.publish(this._bcChannel, wrapMessageWithChecksum(encoding.toUint8Array(encoderSync)), this);
        // Broadcast local state via BroadcastChannel (wrapped with CRC32)
        const encoderState = encoding.createEncoder();
        encoding.writeVarUint(encoderState, MESSAGE_SYNC);
        syncProtocol.writeSyncStep2(encoderState, this.doc);
        bc.publish(this._bcChannel, wrapMessageWithChecksum(encoding.toUint8Array(encoderState)), this);
        // Broadcast local awareness state via BroadcastChannel (wrapped with CRC32)
        if (this.awareness.getLocalState() !== null) {
            const encoderAwareness = encoding.createEncoder();
            encoding.writeVarUint(encoderAwareness, MESSAGE_AWARENESS);
            encoding.writeVarUint8Array(encoderAwareness, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
                this.doc.clientID,
            ]));
            bc.publish(this._bcChannel, wrapMessageWithChecksum(encoding.toUint8Array(encoderAwareness)), this);
        }
    }
    /**
     * Disconnect from BroadcastChannel and mark local client as offline.
     */
    _disconnectBroadcastChannel() {
        if (!this._bcConnected || !this._bcSubscriber) {
            return;
        }
        // Broadcast awareness state with null (indicating disconnect) - wrapped with CRC32
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID], new Map()));
        bc.publish(this._bcChannel, wrapMessageWithChecksum(encoding.toUint8Array(encoder)), this);
        // Unsubscribe from channel
        bc.unsubscribe(this._bcChannel, this._bcSubscriber);
        this._bcConnected = false;
        this._bcSubscriber = undefined;
    }
    /**
     * Send N already-encoded, already-typed sub-messages as ONE wire message
     * instead of N separate `transport.send()`/`bc.publish()` calls, when
     * there's more than one to send. Used at trigger points that
     * conceptually produce a single event but historically sent multiple
     * independent messages for it (sync push, sync pull, awareness) - see
     * `_trySyncPushPull()` (connect-time push + digest beacon + awareness in
     * one wire message).
     *
     * Design (see the task's framing requirements):
     * - Each sub-message is length-prefixed with `writeVarUint8Array`,
     *   consistent with how this codebase already frames variable-length
     *   payloads elsewhere (e.g. MESSAGE_AWARENESS). On receipt,
     *   `_dispatchMessage()`'s `MESSAGE_BATCH` case unwraps and re-dispatches
     *   each one through the EXACT SAME per-message-type logic used for a
     *   top-level message - no parallel reimplementation.
     * - Sub-messages are NOT individually CRC32-wrapped here - the whole
     *   batch envelope goes through the normal, single `_send()` pipeline
     *   below, which wraps the WHOLE envelope in exactly one CRC32 checksum
     *   (and, if `compressionThresholdBytes` is configured, one compression
     *   pass) - built and computed exactly like any other outgoing message,
     *   so this composes with the existing compression pipeline for free
     *   rather than fighting it with a second, nested wrap/compress step.
     *   The tradeoff: a single corrupted bit anywhere in a batched wire
     *   message now invalidates every sub-message it carried, not just one -
     *   per-sub-message CRC32s would avoid that, at the cost of ~4 extra
     *   bytes per sub-message for a benefit that only matters under active
     *   corruption. This tradeoff is exactly what
     *   test/dummy/bench-corruption-storm.ts and bench-packet-loss.ts exist
     *   to measure empirically, per this task's validation requirements,
     *   rather than deciding it by design argument alone.
     * - BroadcastChannel (cross-tab) traffic is NOT specially batched beyond
     *   whatever `_send()` already does per call - same-tab-group cross-tab
     *   traffic is local/cheap, and `_send()` already only issues one
     *   `bc.publish()` per call regardless, so a batch of N sub-messages
     *   already becomes exactly one `bc.publish()` call for free once routed
     *   through here - no separate BC-specific batching logic needed.
     */
    _sendBatch(messages) {
        if (messages.length === 0)
            return;
        if (messages.length === 1) {
            this._send(messages[0]);
            return;
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_BATCH);
        for (const message of messages) {
            encoding.writeVarUint8Array(encoder, message);
        }
        this._send(encoding.toUint8Array(encoder));
    }
    /**
     * Send data through both BroadcastChannel (if connected) and transport.
     * All messages are wrapped with CRC32 checksum for integrity verification.
     * This ensures updates reach both local tabs and remote peers with corruption detection.
     */
    _send(data) {
        // Wrap message with CRC32 checksum
        const wrappedData = wrapMessageWithChecksum(data);
        // Send via BroadcastChannel to other tabs first. BroadcastChannel is
        // same-process (other tabs in this browser) - never worth compressing.
        // When compressionThresholdBytes is enabled, every message still needs
        // the same leading flag byte _handleIncomingMessage() expects
        // regardless of source, so this always sends flag=0 (uncompressed) in
        // that case rather than skipping the flag - see that option's doc
        // comment.
        if (this._bcConnected) {
            bc.publish(this._bcChannel, this._compressionThresholdBytes
                ? prefixCompressionFlag(0, wrappedData)
                : wrappedData, this);
        }
        // Send via network transport
        if (!this.transport.isConnected) {
            return;
        }
        this._sendToTransport(wrappedData);
    }
    /**
     * Send already-CRC32-wrapped bytes to the network transport, compressing
     * first if compressionThresholdBytes is configured and this payload
     * clears it. See that option's doc comment for the size threshold
     * reasoning and the wire-format compatibility tradeoff of enabling it.
     */
    _sendToTransport(wrappedData, to) {
        const threshold = this._compressionThresholdBytes;
        if (!threshold) {
            this._dispatchToTransport(wrappedData, to);
            return;
        }
        if (!COMPRESSION_AVAILABLE || wrappedData.length < threshold) {
            this._dispatchToTransport(prefixCompressionFlag(0, wrappedData), to);
            return;
        }
        compressDeflateRaw(wrappedData)
            .then((compressed) => {
            this._dispatchToTransport(prefixCompressionFlag(1, compressed), to);
        })
            .catch((error) => {
            console.error('[GenericProvider] Compression failed, sending uncompressed:', error);
            this._dispatchToTransport(prefixCompressionFlag(0, wrappedData), to);
        });
    }
    /**
     * Hand fully-framed bytes to transport.send() - or transport.sendTo() when
     * a peer address is given - tolerating a sync or async result.
     */
    _dispatchToTransport(data, to) {
        try {
            const result = to !== undefined && typeof this.transport.sendTo === 'function'
                ? this.transport.sendTo(to, data)
                : this.transport.send(data);
            // Handle async send
            if (result instanceof Promise) {
                result.catch((error) => {
                    console.error('Error sending data:', error);
                });
            }
        }
        catch (error) {
            console.error('Error sending data:', error);
        }
    }
    /**
     * Update connection status and emit event.
     */
    _setStatus(status) {
        this._status = status;
        this.emit('status', [status]);
    }
    /**
     * TEST HELPER: Set local sequence number to a specific value.
     * Used for testing sequence number overflow scenarios.
     * @internal
     */
    _testSetSequenceNumber(seqNum) {
        this._localSeqNum = seqNum;
        console.warn(`[GenericProvider TEST] Sequence number set to ${seqNum} (MAX_SAFE_INTEGER: ${Number.MAX_SAFE_INTEGER})`);
    }
    /**
     * TEST HELPER: Get current local sequence number.
     * @internal
     */
    _testGetSequenceNumber() {
        return this._localSeqNum;
    }
}
//# sourceMappingURL=index.js.map