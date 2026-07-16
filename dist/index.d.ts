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
    private _hashMismatchCount;
    private _lastHashMismatchTime;
    private _syncRequestTimes;
    private _maxSyncRequestsPerWindow;
    private _syncRequestWindowMs;
    private _localSeqNum;
    private _remoteSeqNums;
    private _corruptedMessageCount;
    private _lastCorruptedMessageTime;
    private _batchUpdates;
    private _pendingUpdate;
    private _batchTimeoutId?;
    private _awarenessInterval;
    private _pendingAwarenessClients;
    private _awarenessTimeoutId?;
    private _lastAwarenessTime;
    private _excludeOrigins;
    private _localId?;
    private _syncMode;
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
         * @default 0 (disabled - immediate transmission)
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