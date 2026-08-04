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
     * Publish a message to a single target instead of broadcasting.
     *
     * On transports with `sendTo`, `target` is the peer's ID and delivery is
     * direct. On transports without it, the message is broadcast with the
     * target embedded and dropped by every provider whose `localId` differs.
     *
     * @param target - Recipient id (transport peerId, or a `localId`)
     * @param topic - Topic name
     * @param message - Any JSON-serializable data
     */
    publishTo(target: string, topic: string, message: any): void;
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
    readonly appAwareness: awarenessProtocol.Awareness;
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
    private _pendingAppAwarenessClients;
    private _appAwarenessTimeoutId?;
    private _lastAppAwarenessTime;
    private _excludeOrigins;
    private _localId?;
    private _syncMode;
    private _updateHandler?;
    private _awarenessUpdateHandler?;
    private _appAwarenessUpdateHandler?;
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
        appAwareness?: awarenessProtocol.Awareness;
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
         * Transaction origins whose updates should not be sent to peers.
         * Updates from these origins stay local (never reach the transport).
         * @default [] (no origins excluded)
         */
        excludeOrigins?: any[];
        /**
         * This provider's identity for targeted pubsub (publishTo).
         * On transports without sendTo, targeted messages are broadcast and
         * dropped unless their target matches this id.
         */
        localId?: string;
        /**
         * Connect-time sync strategy.
         * - 'push-pull' (default): push full local state to peers, then request
         *   remote state. Correct for P2P transports where there is no
         *   authoritative peer to pull from (e.g. offline edits must be pushed).
         * - 'pull': only request remote state on connect (SyncStep1), never push
         *   full local state. Use with relay/server transports (e.g. y-websocket)
         *   where the server holds authoritative state and a reconnecting client
         *   should adopt it rather than push a competing local copy.
         * @default 'push-pull'
         */
        syncMode?: 'push-pull' | 'pull';
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
         * Max random delay (ms) before replying to a SyncStep1 request, used
         * to let other peers' replies pre-empt a redundant one (NACK-style
         * suppression). Only engages once at least 2 other peers are known via
         * awareness. Larger values suppress more redundant traffic in large
         * rooms at the cost of higher requester-perceived latency.
         * @default 30
         */
        syncReplySuppressionMs?: number;
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
     * Force an immediate sync with remote peers.
     * Useful after network interruptions or to manually trigger re-sync.
     */
    syncNow(): void;
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
     * Handle incoming messages from the transport.
     * Verifies message integrity with CRC32 before processing.
     * Corrupt messages are rejected immediately without attempting to decode.
     */
    private _handleIncomingMessage;
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
     * Send a pub/sub message.
     * Internal method called by PubSubChannel.
     */
    _sendPubSub(topic: string, message: any): void;
    /**
     * Send a targeted pub/sub message.
     * Uses transport.sendTo when available (direct delivery), otherwise
     * broadcasts a targeted frame that non-target providers drop.
     * Internal method called by PubSubChannel.
     */
    _sendPubSubTo(target: string, topic: string, message: any): void;
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
     * Encode and publish an awareness update for the local client to the BroadcastChannel.
     */
    private _publishAwarenessToBroadcastChannel;
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