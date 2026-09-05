import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Observable } from 'lib0/observable';
import type { Transport, ConnectionConfig, ConnectionStatus } from './transport';
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
export declare function computeDeleteSetHash(doc: Y.Doc): number;
/**
 * PubSub channel for real-time messaging alongside Yjs.
 * Allows sending ephemeral messages that don't need CRDT properties.
 */
export declare class PubSubChannel extends Observable<string> {
    private provider;
    constructor(provider: GenericProvider);
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
    publish(topic: string, message: any): void;
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
    subscribe(topic: string, callback: (message: any, topic: string) => void): () => void;
    /**
     * Internal: Handle incoming pub/sub message
     */
    _handleMessage(topic: string, message: any): void;
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
export declare class GenericProvider extends Observable<string> {
    readonly doc: Y.Doc;
    readonly transport: Transport;
    readonly awareness: awarenessProtocol.Awareness;
    readonly pubsub: PubSubChannel;
    private _status;
    private _synced;
    private _destroying;
    private _syncInterval;
    private _syncIntervalId?;
    private _verifyUpdates;
    private _disableBc;
    private _idleBackoffEnabled;
    private _idleBackoffMaxMs;
    private _currentSyncIntervalMs;
    private _lastActivityTime;
    private _lastPeriodicTickTime;
    private _bcChannel;
    private _bcConnected;
    private _bcSubscriber?;
    private _resyncAttemptCount;
    private _lastResyncAttemptTime;
    private _pendingResyncTimeoutId?;
    private _syncRequestTimes;
    private _syncReplyTimes;
    private _maxSyncRequestsPerWindow;
    private _syncRequestWindowMs;
    private _pendingSyncReply;
    private _pendingSyncReplyTimeoutId?;
    private _syncReplySuppressionMs;
    private _pendingSyncReplyIsAck;
    private _pendingSyncReplyTargetSv;
    private _responseWaitTimer?;
    private _responseWaitAttempts;
    private _responseSeen;
    private _responseWaitFlags;
    private _pendingCheckTimer?;
    private _rttSamples;
    private _requestSentAt;
    private _confirmed;
    private _knownPeers;
    private _peerAddress;
    private _presencePending;
    private _presenceResponseTimer?;
    private _pendingAwarenessRemoval;
    private _pendingAwarenessRemovalTimeoutId?;
    private _peerConnectDebounceMs;
    private _pendingPeerConnectSyncTimeoutId?;
    private _compressionThresholdBytes?;
    private _dsHashCache;
    private _localSeqNum;
    private _remoteSeqInfo;
    private _gapCheckTimers;
    private _seqWindowSize;
    private _gapGraceMs;
    private _batchUpdates;
    private _pendingUpdate;
    private _batchTimeoutId?;
    private _awarenessInterval;
    private _pendingAwarenessClients;
    private _awarenessTimeoutId?;
    private _lastAwarenessTime;
    private _updateHandler?;
    private _awarenessUpdateHandler?;
    private _unsubscribeTransport?;
    private _beforeUnloadHandler?;
    /**
     * Create a new generic provider.
     *
     * @param doc - The Yjs document to sync
     * @param transport - Transport implementation for your backend
     * @param options - Optional configuration
     */
    constructor(doc: Y.Doc, transport: Transport, options?: {
        awareness?: awarenessProtocol.Awareness;
        /**
         * Interval in milliseconds for periodic sync retries.
         * Helps recover from packet loss. Set to 0 to disable.
         * @default 5000
         */
        syncInterval?: number;
        /**
         * Send document hash with each update for immediate desync detection.
         * When enabled, mismatch triggers instant re-sync instead of waiting.
         * @default true
         */
        verifyUpdates?: boolean;
        /**
         * Batch (debounce) document updates to reduce network traffic.
         * Updates are collected and sent after this delay in milliseconds.
         * Set to 0 to send updates immediately (no batching).
         * Recommended: 50-200ms for good balance between latency and efficiency.
         * @default the transport's `preferredBatchMs` hint if it declares one,
         * otherwise 0 (disabled - immediate transmission)
         */
        batchUpdates?: number;
        /**
         * Disable BroadcastChannel for cross-tab communication.
         * When enabled (default), updates are shared instantly between tabs
         * in the same browser without going through the network transport.
         * Automatically disabled in non-browser environments (e.g., Node.js).
         * @default false (BroadcastChannel enabled)
         */
        disableBc?: boolean;
        /**
         * Throttle awareness updates to reduce network traffic.
         * Awareness updates (cursors, presence) are batched and sent at this interval.
         * Set to 0 for immediate transmission (not recommended for high-frequency updates).
         * This prevents awareness from flooding document sync on limited transports.
         * @default 100 (100ms between awareness broadcasts)
         */
        awarenessInterval?: number;
        /**
         * Max number of sync requests (digest beacons and syncNow() pushes
         * combined) this provider will send within `syncRequestWindowMs` -
         * and, as a separate budget of the same size, max number of sync
         * replies (SyncStep2, acks) it will send in that window.
         * Protects against self-inflicted resync storms (e.g. many hash
         * mismatches firing in a short window under packet loss). Raise this
         * if legitimate resyncs are being throttled under heavy loss; lower
         * it to bound worst-case traffic more aggressively per peer.
         * @default 20
         */
        maxSyncRequestsPerWindow?: number;
        /**
         * Rolling time window (ms) over which `maxSyncRequestsPerWindow` is
         * enforced.
         * @default 10000
         */
        syncRequestWindowMs?: number;
        /**
         * Base max random delay (ms) before replying to a SyncStep1 request,
         * used to let other peers' replies pre-empt a redundant one
         * (NACK-style suppression). Only engages once at least 2 other peers
         * are known via awareness. The actual max delay scales up from this
         * base with room size (see `_replySuppressionMaxDelay()`) - a larger
         * room has more repliers racing within the same window, so it's given
         * more time for the "someone already answered" signal to be overheard
         * before more repliers commit. This option is the small-room baseline
         * and the growth-rate multiplier's unit, not a hard cap (see the
         * `200`ms cap in `_replySuppressionMaxDelay()`).
         * @default 30
         */
        syncReplySuppressionMs?: number;
        /**
         * Debounce window (ms) for coalescing onPeerConnect-triggered
         * syncNow() calls. Mesh transports (peerjs, simple-peer) fire
         * onPeerConnect once per newly-connected remote peer; without
         * coalescing, N peers joining within a short window each
         * independently trigger a full-state broadcast to everyone already
         * connected - an O(N^2) burst. A burst of onPeerConnect events within
         * this window collapses into a single syncNow() call.
         * @default 50
         */
        peerConnectDebounceMs?: number;
        /**
         * Grace period (ms) after detecting a suspected sequence-number gap
         * before requesting a resync. Tolerates mere network reordering
         * without treating it as loss; lower it to detect genuine packet loss
         * faster at the risk of more false-positive resyncs under jitter.
         * @default 300
         */
        gapGraceMs?: number;
        /**
         * Number of recent sequence numbers retained per remote peer for
         * duplicate/gap detection. Raise if a transport can deliver messages
         * extremely out of order across a wide window; the default is ample
         * for typical reordering/jitter.
         * @default 64
         */
        seqWindowSize?: number;
        /**
         * Minimum payload size (bytes, measured on the CRC32-wrapped bytes
         * about to be sent) above which a message is compressed
         * (`deflate-raw`, via the standard CompressionStream/
         * DecompressionStream Web API) before being handed to the network
         * transport. Below this size, messages are sent byte-for-byte as they
         * are today.
         *
         * Measured on synthetic Yjs docs (test/dummy/bench-compression-ratio.ts):
         * a single-keystroke update (~20 bytes) actually gets BIGGER under
         * gzip (fixed ~18-byte header/trailer) and is break-even at best under
         * deflate-raw - not worth the async round trip through the
         * Compression Streams API for a handful of bytes saved. A clean
         * ~3.3KB doc compresses ~17x; a ~45KB doc with heavy edit-history
         * churn (tombstones from insert/delete cycles) still compresses ~8x.
         * 2048 is chosen so ordinary typing traffic (tens to a few hundred
         * bytes per update - the majority of real-world traffic per this
         * project's prior benchmark rounds) NEVER crosses it and is completely
         * unaffected, while a full-document push/reply large enough to matter
         * (and, on chunking transports like PubNub/Ably, large enough to
         * multiply into several wire messages) reliably compresses down well
         * below its own pre-compression size.
         *
         * `deflate-raw` (not `gzip`) is used deliberately: gzip's fixed
         * header/trailer overhead makes it a net loss for anything under
         * roughly 200 bytes (measured), while deflate-raw has ~0 fixed
         * overhead and compresses at least as well for every size measured.
         *
         * IMPORTANT - wire-format compatibility: this project has no
         * versioned wire-protocol negotiation. Enabling this (any truthy
         * value) changes the wire format for EVERY message this instance
         * sends: a 1-byte compressed/uncompressed flag is prepended ahead of
         * the existing CRC32 wrapper on every message, compressed or not, so
         * the receiving side can unambiguously tell them apart. A peer NOT
         * running this option (or running an older version of this library)
         * will misinterpret that leading flag byte as the start of the CRC32
         * wrapper and reject every message as corrupted. All peers in a room
         * must set this the same way (all enabled, or all disabled) for the
         * room to function. This is a real, deliberate tradeoff - not a
         * detail - which is why this defaults to fully disabled rather than
         * auto-enabling above some size unconditionally.
         *
         * `0` or `undefined` disables compression entirely and keeps the wire
         * format byte-for-byte identical to before this option existed.
         * @default undefined (compression disabled, wire format unchanged)
         */
        compressionThresholdBytes?: number;
        /**
         * Back off the periodic-sync interval (see `syncInterval`) when the
         * room is idle, instead of ticking at a fixed cadence forever. After
         * each periodic tick that saw no activity since the previous tick -
         * no local or remote document change, no local or remote awareness
         * change, no corrupted/rejected wire message - the interval DOUBLES
         * (capped at `idleBackoffMaxMs`) for the next tick. Any activity
         * resets it immediately back to `syncInterval`. Deliberately does NOT
         * count the periodic tick's own routine SyncStep1/SyncStep2 exchange
         * as activity (see `_markActivity()`'s doc comment for why treating
         * that as activity would make this option a no-op - an earlier draft
         * of this feature made exactly that mistake, caught by this option's
         * own bench script). Still composes with the existing +/-20% jitter
         * (`_jitteredSyncInterval()`) at whatever the current backed-off value
         * is.
         *
         * TRADEOFF - read before enabling: periodic sync exists as a
         * loss-recovery backstop (catch a message that was silently dropped).
         * Backing it off during idle periods directly trades away worst-case
         * recovery latency for exactly the scenario it exists to cover: a
         * message dropped right after the room goes quiet won't be caught by
         * periodic sync until the NEXT tick, which by then may be up to
         * `idleBackoffMaxMs` away instead of `syncInterval` away. Measured in
         * test/dummy/bench-idle-backoff.ts: with default settings (5s base,
         * 60s cap), a loss injected early in an idle stretch can take on the
         * order of the current backed-off interval (up to ~60s) to recover,
         * vs. one `syncInterval` (~5s) with this off - see that bench's own
         * output/header for the exact run's numbers. This is a real
         * bandwidth-vs-recovery-latency tradeoff, not a free win, which is why
         * this defaults to OFF.
         * @default false (no backoff - identical behavior to before this
         * option existed)
         */
        idleBackoffEnabled?: boolean;
        /**
         * Ceiling (ms) for the backed-off periodic-sync interval when
         * `idleBackoffEnabled` is true. Doubling from a 5000ms base reaches
         * this in 4 idle ticks (5s/10s/20s/40s/60s). 60000 is chosen so the
         * worst-case loss-recovery latency this trades away stays the same
         * order of magnitude as `y-protocols/awareness`'s own built-in
         * peer-removal timeout (30s, halved from its 60s+ `_checkInterval`
         * sweep window) rather than growing unbounded - a room silent long
         * enough to be fully backed off is, on this timescale, already close
         * to "everyone's gone idle/timed out" territory anyway. Ignored when
         * `idleBackoffEnabled` is false.
         * @default 60000
         */
        idleBackoffMaxMs?: number;
    });
    /**
     * Connect to the backend and start syncing.
     *
     * @param config - Connection configuration passed to transport
     */
    connect(config: ConnectionConfig): Promise<void>;
    /**
     * Disconnect from the backend.
     * The provider can be reconnected later with connect().
     */
    disconnect(): void;
    /**
     * Destroy the provider permanently.
     * Removes all event listeners and cleans up resources.
     */
    destroy(): void;
    /**
     * Current connection status
     */
    get status(): ConnectionStatus;
    /**
     * Whether the provider is connected to the backend
     */
    get connected(): boolean;
    /**
     * Whether BroadcastChannel is connected for cross-tab sync
     */
    get bcConnected(): boolean;
    /**
     * Whether the document is synced with remote peers
     */
    get synced(): boolean;
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
    private _trySyncPushPull;
    /**
     * Force an immediate sync with remote peers.
     * Useful after network interruptions or to manually trigger re-sync.
     * Sends the beacon with DIGEST_FLAG_JOIN: peers answer with their
     * presence and, if our state already matches theirs, with an ack beacon
     * so `synced` flips without a data round trip.
     */
    syncNow(): void;
    /**
     * syncNow() body. `flags` = 0 for callers that must NOT request presence:
     * `_schedulePeerConnectSync()` (mesh transports already re-broadcast
     * presence to a newcomer via their own onPeerConnect -> syncNow()).
     */
    private _syncNow;
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
    private _jitteredSyncInterval;
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
     * Call sites: `_setupDocumentSync()`'s update handler (local or remote
     * document content change), `_setupAwarenessSync()`'s update handler
     * (local or remote awareness content change), and
     * `_processWrappedMessage()`'s corrupted-message branch (wire noise, not
     * silence).
     */
    private _markActivity;
    /** Cached delete-set hash - see computeDeleteSetHash(). */
    private _deleteSetHash;
    /**
     * Debounce onPeerConnect-triggered syncNow() calls. A burst of connect
     * events within `_peerConnectDebounceMs` collapses into one call instead
     * of one per event - without this, N peers joining a mesh in a short
     * window each independently broadcast full state to everyone already
     * connected (O(N^2) traffic), since onPeerConnect fires once per
     * newly-opened peer connection with no coalescing of its own.
     */
    private _schedulePeerConnectSync;
    /**
     * Setup automatic document synchronization.
     * Listens to document updates and sends them to the transport.
     * If batchUpdates is enabled, updates are debounced/batched.
     */
    private _setupDocumentSync;
    /**
     * Batch/debounce updates to reduce network traffic.
     * Merges multiple updates and sends after delay.
     */
    private _batchUpdate;
    /**
     * Setup automatic awareness synchronization.
     * Listens to awareness changes and broadcasts them.
     */
    private _setupAwarenessSync;
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
    private _handleIncomingMessage;
    /**
     * Verify message integrity with CRC32 and decode. Corrupt messages are
     * rejected immediately without attempting to decode. Operates on bytes
     * that have already had any compression flag/decompression handled by
     * _handleIncomingMessage() - this is the pre-compression-feature
     * implementation, unchanged.
     */
    private _processWrappedMessage;
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
    private _dispatchMessage;
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
    private _handleDigest;
    /**
     * Answer a JOIN beacon's presence request once for all JOIN beacons that
     * arrive within `clamp(2 * minRTT, 100, 500)` ms of the first - long
     * enough to cover a join burst spread by latency, short enough that a
     * lone joiner sees the room's presence within a few round trips.
     */
    private _schedulePresenceResponse;
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
    private _peerCount;
    private _replySuppressionMaxDelay;
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
    private _scheduleSyncReply;
    /** Cancel a pending suppressed reply, if any. */
    private _cancelPendingSyncReply;
    /**
     * Cancel a pending reply only if it is a digest ack - see
     * `_pendingSyncReplyIsAck`. Called from `_handleDigest()` on every
     * overheard beacon whose digest equals ours.
     */
    private _cancelPendingAck;
    /**
     * Route a SyncStep2 (or digest-ack) reply through the redundancy
     * suppression when there's genuine redundancy (>= 2 other known peers via
     * awareness - below that there's no "someone else" to rely on), else send
     * immediately. Both paths are rate-limited by `_sendSyncReply()`. Shared
     * by the MESSAGE_SYNC, MESSAGE_SYNC_VERIFIED and MESSAGE_SYNC_DIGEST cases.
     */
    private _replyToSyncRequest;
    /** Whether a reply to `clientID` can go over Transport.sendTo. */
    private _canUnicast;
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
    private _selectedResponder;
    /**
     * Send one already-encoded message to a single peer over
     * Transport.sendTo, with the same CRC32 wrapping and optional compression
     * as a broadcast. Not mirrored to BroadcastChannel (a same-browser tab
     * never appears as an addressable peer). Returns false if the peer's
     * address is unknown or the transport cannot unicast.
     */
    private _sendDirect;
    /**
     * Re-check Yjs's pending-struct store after the gap grace period and
     * request a resync (a beacon, see _requestResync) only if something is
     * still missing. One timer; a check scheduled while one is pending is
     * absorbed. Cleared on disconnect/destroy.
     */
    private _schedulePendingCheck;
    /**
     * Return the update payload of a SyncStep2/Update sync sub-message
     * without advancing `decoder` (null for SyncStep1 or malformed input).
     * y-protocols frames both as [subType varUint][update varUint8Array].
     */
    private _peekSyncUpdate;
    /**
     * Whether an update we just applied was already superseded here: every
     * client it touches ends at a clock we were at or beyond BEFORE this
     * update (i.e. it added nothing). Uses the update's own metadata
     * (`Y.parseUpdateMeta`), O(clients in the update).
     */
    private _isLateUpdate;
    /** Flip `synced` once and emit; idempotent. */
    private _markSynced;
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
    private _armResponseWait;
    /**
     * A SyncStep2 or an equal ack/beacon arrived - whatever we asked for is
     * answered. `sample` = it was a direct reply (SyncStep2/ack), so its
     * timing is a round-trip sample; an equal periodic beacon from a settled
     * peer also ends the wait but says nothing about latency.
     */
    private _noteResponse;
    /** Minimum of the recent round-trip samples, or null before the first reply. */
    private _rttMinMs;
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
    private _scheduleAwarenessRemoval;
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
    private _extractRemovedClientIds;
    /**
     * Drop a pending suppressed removal broadcast if it overlaps
     * `removedClientIds` - someone else already broadcast (at least part of)
     * the same departure, so ours is redundant.
     */
    private _cancelPendingAwarenessRemovalIfOverlaps;
    /** Cancel a pending suppressed awareness-removal broadcast, if any. */
    private _cancelPendingAwarenessRemoval;
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
    private _sendSyncReply;
    /**
     * Track a received sequence number for reordering-tolerant gap detection.
     * Does not gate whether the update gets applied — only decides whether a
     * gap looks suspicious enough to (eventually) request a resync.
     */
    private _trackRemoteSeq;
    /**
     * Re-check a suspected sequence gap after a short grace period instead of
     * requesting a resync immediately. Pure network reordering (a message
     * that's merely late, not lost) typically resolves itself within the
     * grace window, so this avoids the resync storms that immediate gap
     * detection caused under jitter. Real packet loss still gets caught —
     * just `_gapGraceMs` later — and the periodic sync interval / hash
     * verification remain as further safety nets regardless.
     */
    private _scheduleGapCheck;
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
    private _requestResync;
    /**
     * Reserve a slot in the sync rate limiter (max `_maxSyncRequestsPerWindow`
     * per `_syncRequestWindowMs`), recording the request if there's room.
     * Shared by `_sendSyncStep1()` and `syncNow()` so a burst of triggers from
     * different sources (periodic sync, hash-mismatch resyncs, gap-check
     * confirmations) draws from one combined budget instead of each having
     * its own uncapped or separately-capped allowance.
     */
    private _tryReserveSyncSlot;
    /** Same limiter, separate budget, for SyncStep2 replies and acks. */
    private _tryReserveReplySlot;
    private _tryReserveSlot;
    /**
     * Encode the digest beacon that replaces SyncStep1 (see
     * MESSAGE_SYNC_DIGEST). Still the one place every "request sync" path
     * goes through (connect()'s syncNow(), the periodic tick,
     * _requestResync()'s retry), so they all switched together.
     */
    private _encodeSyncStep1;
    /**
     * Encode an ack for a JOIN beacon: same framing as a beacon, DIGEST_FLAG_ACK
     * set, and the JOINER's state vector + delete-set hash echoed back instead
     * of ours (see DIGEST_FLAG_ACK for why it must never carry our own state).
     */
    private _encodeAck;
    /**
     * Send the periodic digest beacon. Rate limited to prevent spam. Returns
     * whether it actually sent (false means rate-limited).
     */
    private _sendSyncStep1;
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
    private _encodeUpdate;
    /**
     * Encode a full-state push (see MESSAGE_SYNC_PUSH): the document as one
     * update, deliberately without the hash and sequence number that
     * `_encodeUpdate()` adds to incremental updates.
     */
    private _encodePush;
    /**
     * Send a document update to the transport.
     * If verifyUpdates is enabled, includes sequence number and document hash for ordering and desync detection.
     */
    private _sendUpdate;
    /**
     * Send awareness update to the transport.
     */
    private _sendAwarenessUpdate;
    /**
     * Send a pub/sub message.
     * Internal method called by PubSubChannel.
     */
    _sendPubSub(topic: string, message: any): void;
    /**
     * Broadcast awareness state for the specified clients.
     * Throttled to prevent awareness updates from flooding document sync.
     * Multiple rapid updates are batched together.
     */
    private _broadcastAwareness;
    /**
     * Encode an awareness update, without sending it. Extracted from the old
     * `_sendAwarenessNow()` so `_tryImmediateAwarenessMessage()` can fold it
     * into a batched wire send instead of always sending it as its own
     * message.
     */
    private _encodeAwareness;
    /**
     * Send awareness update immediately without throttling.
     */
    private _sendAwarenessNow;
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
    private _tryImmediateAwarenessMessage;
    /**
     * Setup BroadcastChannel for cross-tab communication.
     * Automatically disabled in non-browser environments.
     */
    private _setupBroadcastChannel;
    /**
     * Disconnect from BroadcastChannel and mark local client as offline.
     */
    private _disconnectBroadcastChannel;
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
    private _sendBatch;
    /**
     * Send data through both BroadcastChannel (if connected) and transport.
     * All messages are wrapped with CRC32 checksum for integrity verification.
     * This ensures updates reach both local tabs and remote peers with corruption detection.
     */
    private _send;
    /**
     * Send already-CRC32-wrapped bytes to the network transport, compressing
     * first if compressionThresholdBytes is configured and this payload
     * clears it. See that option's doc comment for the size threshold
     * reasoning and the wire-format compatibility tradeoff of enabling it.
     */
    private _sendToTransport;
    /**
     * Hand fully-framed bytes to transport.send() - or transport.sendTo() when
     * a peer address is given - tolerating a sync or async result.
     */
    private _dispatchToTransport;
    /**
     * Update connection status and emit event.
     */
    private _setStatus;
    /**
     * TEST HELPER: Set local sequence number to a specific value.
     * Used for testing sequence number overflow scenarios.
     * @internal
     */
    _testSetSequenceNumber(seqNum: number): void;
    /**
     * TEST HELPER: Get current local sequence number.
     * @internal
     */
    _testGetSequenceNumber(): number;
}
//# sourceMappingURL=index.d.ts.map