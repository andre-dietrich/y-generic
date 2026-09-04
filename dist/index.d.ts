import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Observable } from 'lib0/observable';
import type { Transport, ConnectionConfig, ConnectionStatus } from './transport';
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
    private _bcChannel;
    private _bcConnected;
    private _bcSubscriber?;
    private _resyncAttemptCount;
    private _lastResyncAttemptTime;
    private _pendingResyncTimeoutId?;
    private _syncRequestTimes;
    private _maxSyncRequestsPerWindow;
    private _syncRequestWindowMs;
    private _pendingSyncReply;
    private _pendingSyncReplyTimeoutId?;
    private _syncReplySuppressionMs;
    private _peerConnectDebounceMs;
    private _pendingPeerConnectSyncTimeoutId?;
    private _compressionThresholdBytes?;
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
         * Max number of sync requests (SyncStep1 pulls and syncNow() pushes
         * combined) this provider will send within `syncRequestWindowMs`.
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
     */
    private _trySyncPushPull;
    /**
     * Force an immediate sync with remote peers.
     * Useful after network interruptions or to manually trigger re-sync.
     */
    syncNow(): void;
    /**
     * Compute the next periodic-sync delay, jittered by ~+/-20% around
     * `_syncInterval`. Re-jittered fresh each tick (not computed once per
     * connect()) so a room's peers - which commonly all connect() within a
     * short window of each other - drift apart over time instead of staying
     * loosely synchronized. Extracted to its own method purely so benchmarks
     * can shadow it to compare against the unjittered baseline.
     */
    private _jitteredSyncInterval;
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
    private _replySuppressionMaxDelay;
    /**
     * Schedule a SyncStep2 reply after a short random delay instead of
     * sending immediately. If another peer's reply is overheard in the
     * meantime (`_cancelPendingSyncReply`), this reply is dropped as
     * redundant - the requester likely already got what it needed.
     *
     * A reply that is already pending when this is called answers a
     * *different* SyncStep1 request (e.g. peer A's request, followed 5ms
     * later by peer B's) - it must not be silently overwritten by the new
     * one. Flush it immediately, then schedule the new reply fresh. The only
     * sanctioned way a reply gets dropped is `_cancelPendingSyncReply()`,
     * because we overheard someone else's SyncStep2 for the SAME request.
     */
    private _scheduleSyncReply;
    /** Cancel a pending suppressed reply, if any. */
    private _cancelPendingSyncReply;
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
    /**
     * Encode and send a SyncStep1 message requesting missing updates.
     * Does not check the rate limiter itself - callers must reserve a slot
     * via `_tryReserveSyncSlot()` first.
     */
    private _writeSyncStep1;
    /**
     * Send SyncStep1 message to request missing updates.
     * This is sent when first connecting to sync with remote peers.
     * Note: SyncStep1 is just a request and doesn't include hash verification.
     * Rate limited to prevent spam.
     */
    private _sendSyncStep1;
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
     * Send awareness update immediately without throttling.
     */
    private _sendAwarenessNow;
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
    /** Hand fully-framed bytes to transport.send(), tolerating a sync or async send(). */
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