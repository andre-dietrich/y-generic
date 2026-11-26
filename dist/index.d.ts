import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Observable } from 'lib0/observable';
import type { Transport, ConnectionConfig, ConnectionStatus } from './transport';
/** Ephemeral JSON messages alongside the Yjs document. */
export declare class PubSubChannel extends Observable<string> {
    private provider;
    constructor(provider: GenericProvider);
    /** Broadcast a JSON-serializable message on a topic. */
    publish(topic: string, message: any): void;
    /**
     * Send a message to one target: direct via `transport.sendTo` where
     * available, otherwise broadcast and dropped by providers whose `localId`
     * differs.
     */
    publishTo(target: string, topic: string, message: any): void;
    /** Subscribe to a topic ('*' for all); returns an unsubscribe function. */
    subscribe(topic: string, callback: (message: any, topic: string) => void): () => void;
    /** @internal */
    _handleMessage(topic: string, message: any): void;
}
/**
 * Yjs provider over any `Transport`: document sync, two awareness channels
 * (`awareness`, `appAwareness`), pub/sub and cross-tab BroadcastChannel.
 *
 * @example
 * ```typescript
 * const provider = new GenericProvider(new Y.Doc(), new MyTransport())
 * await provider.connect({ room: 'my-room' })
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
    private _disableBc;
    private _bcChannel;
    private _bcConnected;
    private _bcSubscriber?;
    private _syncRequestTimes;
    private _maxSyncRequestsPerWindow;
    private _syncRequestWindowMs;
    private _pendingSyncReply;
    private _pendingSyncReplyTimeoutId?;
    private _syncReplySuppressionMs;
    private _batchUpdates;
    private _pendingUpdate;
    private _batchTimeoutId?;
    private _awarenessInterval;
    private _channels;
    private _excludeOrigins;
    private _localId?;
    private _syncMode;
    private _updateHandler?;
    private _unsubscribeTransport?;
    private _beforeUnloadHandler?;
    constructor(doc: Y.Doc, transport: Transport, options?: {
        awareness?: awarenessProtocol.Awareness;
        appAwareness?: awarenessProtocol.Awareness;
        /** Periodic SyncStep1 interval (ms) that recovers lost updates; 0 disables. @default 5000 */
        syncInterval?: number;
        /**
         * Debounce document updates by this many ms (0 = send immediately).
         * @default the transport's `preferredBatchMs`, else 0
         */
        batchUpdates?: number;
        /** Disable cross-tab BroadcastChannel sync (always off outside browsers). @default false */
        disableBc?: boolean;
        /** Minimum ms between awareness broadcasts per channel; 0 = immediate. @default 100 */
        awarenessInterval?: number;
        /** Transaction origins whose updates stay local. @default [] */
        excludeOrigins?: any[];
        /** Identity matched against the target of broadcast `publishTo` messages. */
        localId?: string;
        /**
         * On connect, 'push-pull' pushes the full local state then requests the
         * remote one (P2P, no authoritative peer); 'pull' only requests it, so a
         * client adopts a relay server's document instead of pushing a stale copy.
         * @default 'push-pull'
         */
        syncMode?: 'push-pull' | 'pull';
        /** Max sync requests (pulls, pushes, replies) per `syncRequestWindowMs`. @default 20 */
        maxSyncRequestsPerWindow?: number;
        /** @default 10000 */
        syncRequestWindowMs?: number;
        /**
         * Max random delay (ms) before answering a SyncStep1, so another peer's
         * reply can make ours redundant. Used with ≥2 other known peers.
         * @default 30
         */
        syncReplySuppressionMs?: number;
    });
    /** Connect the transport and start syncing. */
    connect(config: ConnectionConfig): Promise<void>;
    /** Disconnect; connect() may be called again later. */
    disconnect(): void;
    /** Disconnect and remove all listeners; the provider can't be reused. */
    destroy(): void;
    get status(): ConnectionStatus;
    get connected(): boolean;
    get bcConnected(): boolean;
    /** True once a SyncStep2 has been received. */
    get synced(): boolean;
    /** Push the full document state, request missing updates and re-send awareness. */
    syncNow(): void;
    private _setupDocumentSync;
    /** Merge updates and send them once no new one arrived for `batchUpdates` ms. */
    private _batchUpdate;
    private _setupAwarenessSync;
    private _removeLocalAwareness;
    /**
     * Changed awareness clients to broadcast. If the transport reaches every
     * peer, only changes made here (relaying received ones is N² duplication);
     * these include states the app applied for other clientIDs, such as module
     * cursors. Otherwise all of them, which is how presence crosses a partial mesh.
     */
    private _awarenessClientsToSend;
    /**
     * Handle a frame [opcode][payload] from the transport or another tab.
     * An undecodable frame is dropped; the periodic SyncStep1 recovers it.
     */
    private _handleIncomingMessage;
    /**
     * Apply a y-protocols sync message (SyncStep1, SyncStep2 or update) and
     * send the reply it calls for, if any.
     */
    private _handleSyncMessage;
    /**
     * Send a SyncStep2 reply after a random delay unless another peer's reply
     * arrives first. A reply already pending answers a different request, so
     * it is flushed, not overwritten.
     */
    private _scheduleSyncReply;
    private _cancelPendingSyncReply;
    /**
     * Send a SyncStep2 reply within the shared sync budget, a backstop for
     * when suppression fails. Dropped silently: logging would spam exactly
     * when the room is already noisy.
     */
    private _sendSyncReply;
    /** Take a slot from the shared sync budget; false if it's used up. */
    private _tryReserveSyncSlot;
    /** Send a SyncStep1; the caller must have reserved a sync slot. */
    private _writeSyncStep1;
    /** Send a SyncStep1 if the sync budget allows. */
    private _sendSyncStep1;
    private _sendUpdate;
    /** @internal Frame: [MESSAGE_PUBSUB][topic][JSON bytes]. */
    _sendPubSub(topic: string, message: any): void;
    /** @internal Frame: [MESSAGE_PUBSUB_TARGETED][target][topic][JSON bytes]. */
    _sendPubSubTo(target: string, topic: string, message: any): void;
    /** Broadcast these clients' awareness, batched to one frame per `awarenessInterval`. */
    private _broadcastAwareness;
    /** [MESSAGE_AWARENESS][channel][update]; `states` overrides the current ones. */
    private _awarenessFrame;
    /** Join the room's BroadcastChannel and send our state to other tabs. */
    private _setupBroadcastChannel;
    /** Tell other tabs we're offline (null awareness) and leave the channel. */
    private _disconnectBroadcastChannel;
    /** Send a frame to other tabs and through the transport. */
    private _send;
    /**
     * A method rather than an inline check so TypeScript doesn't narrow
     * `_status` across the await in connect(), where disconnect() may change it.
     */
    private _isConnecting;
    private _setStatus;
}
//# sourceMappingURL=index.d.ts.map