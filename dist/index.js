import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Observable } from 'lib0/observable';
import * as bc from 'lib0/broadcastchannel';
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_PUBSUB = 2;
// Sent only by 2.0.x peers; decoded, never sent.
const MESSAGE_SYNC_VERIFIED = 3;
const MESSAGE_PUBSUB_TARGETED = 4;
// Channel byte in a MESSAGE_AWARENESS frame: [opcode 1][channel][update].
const AWARENESS_CHANNEL_MAIN = 0;
const AWARENESS_CHANNEL_APP = 1;
// Part of the BroadcastChannel name so tabs still running 2.x (CRC32-framed)
// never meet 3.x tabs. Keep in step with WIRE_TAG in providers/simple-peer.
const WIRE_TAG = 'v3';
/** Ephemeral JSON messages alongside the Yjs document. */
export class PubSubChannel extends Observable {
    constructor(provider) {
        super();
        this.provider = provider;
    }
    /** Broadcast a JSON-serializable message on a topic. */
    publish(topic, message) {
        this.provider._sendPubSub(topic, message);
    }
    /**
     * Send a message to one target: direct via `transport.sendTo` where
     * available, otherwise broadcast and dropped by providers whose `localId`
     * differs.
     */
    publishTo(target, topic, message) {
        this.provider._sendPubSubTo(target, topic, message);
    }
    /** Subscribe to a topic ('*' for all); returns an unsubscribe function. */
    subscribe(topic, callback) {
        const handler = (message, receivedTopic) => {
            if (topic === '*' || topic === receivedTopic) {
                callback(message, receivedTopic);
            }
        };
        this.on('message', handler);
        return () => this.off('message', handler);
    }
    /** @internal */
    _handleMessage(topic, message) {
        this.emit('message', [message, topic]);
    }
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
export class GenericProvider extends Observable {
    constructor(doc, transport, options = {}) {
        super();
        this._status = { state: 'disconnected' };
        this._synced = false;
        this._destroying = false;
        this._bcChannel = '';
        this._bcConnected = false;
        // Shared budget for SyncStep1 pulls, syncNow() pushes and SyncStep2 replies.
        this._syncRequestTimes = [];
        // A SyncStep2 reply waits a random delay and is dropped if another peer's
        // reply arrives first (see _scheduleSyncReply).
        this._pendingSyncReply = null;
        this._batchUpdates = 0; // ms, 0 = send immediately
        this._pendingUpdate = null;
        // Awareness throttling, one set of state per channel.
        this._awarenessInterval = 100;
        this._pendingAwarenessClients = new Set();
        this._lastAwarenessTime = 0;
        this._pendingAppAwarenessClients = new Set();
        this._lastAppAwarenessTime = 0;
        this._excludeOrigins = new Set();
        this._syncMode = 'push-pull';
        this.doc = doc;
        this.transport = transport;
        this.pubsub = new PubSubChannel(this);
        this.awareness = options.awareness || new awarenessProtocol.Awareness(doc);
        this.appAwareness =
            options.appAwareness || new awarenessProtocol.Awareness(doc);
        this._syncInterval = options.syncInterval ?? 5000;
        this._batchUpdates =
            options.batchUpdates ?? transport.preferredBatchMs ?? 0;
        this._disableBc = options.disableBc ?? false;
        this._awarenessInterval = options.awarenessInterval ?? 100;
        this._excludeOrigins = new Set(options.excludeOrigins ?? []);
        this._localId = options.localId;
        this._syncMode = options.syncMode ?? 'push-pull';
        this._maxSyncRequestsPerWindow = options.maxSyncRequestsPerWindow ?? 20;
        this._syncRequestWindowMs = options.syncRequestWindowMs ?? 10000;
        this._syncReplySuppressionMs = options.syncReplySuppressionMs ?? 30;
        this._setupDocumentSync();
        this._setupAwarenessSync();
    }
    /** Connect the transport and start syncing. */
    async connect(config) {
        if (this._destroying) {
            throw new Error('Provider is being destroyed');
        }
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
            this._setupBroadcastChannel(config);
            // Register before connecting: a transport that retries on its own
            // (WebSocket autoReconnect) may deliver messages from a later attempt.
            this._unsubscribeTransport = this.transport.onMessage((data) => {
                this._handleIncomingMessage(data);
            });
            // Push full state to each new peer so offline edits reach it.
            if (this.transport.onPeerConnect) {
                const unsubPeer = this.transport.onPeerConnect((_peerId) => {
                    if (!this._destroying)
                        this.syncNow();
                });
                const originalUnsub = this._unsubscribeTransport;
                this._unsubscribeTransport = () => {
                    originalUnsub?.();
                    unsubPeer();
                };
            }
            await this.transport.connect(config);
            // disconnect()/destroy() was called while the transport was connecting.
            if (!this._isConnecting()) {
                this.transport.disconnect();
                return;
            }
            this._setStatus({ state: 'connected' });
            if (this._syncMode === 'pull') {
                this._sendSyncStep1();
            }
            else {
                this.syncNow();
            }
            this._broadcastAwareness([this.doc.clientID]);
            this._broadcastAwareness([this.doc.clientID], AWARENESS_CHANNEL_APP);
            // Periodic pull only (no full-state push) to recover lost updates.
            if (this._syncInterval > 0) {
                this._syncIntervalId = setInterval(() => {
                    if (this.transport.isConnected && !this._destroying) {
                        this._sendSyncStep1();
                    }
                }, this._syncInterval);
            }
        }
        catch (error) {
            // Undo the setup so a retry doesn't subscribe twice.
            this._unsubscribeTransport?.();
            this._unsubscribeTransport = undefined;
            this._disconnectBroadcastChannel();
            // disconnect() during connecting already set the final status.
            if (!this._isConnecting())
                return;
            this._setStatus({
                state: 'error',
                error: error instanceof Error ? error : new Error(String(error)),
            });
            throw error;
        }
    }
    /** Disconnect; connect() may be called again later. */
    disconnect() {
        if (this._syncIntervalId !== undefined) {
            clearInterval(this._syncIntervalId);
            this._syncIntervalId = undefined;
        }
        // A fresh budget, so the reconnect push carrying offline edits isn't
        // rate-limited by requests made before the disconnect.
        this._syncRequestTimes = [];
        // A suppressed reply is redundant by design; discard rather than flush.
        this._cancelPendingSyncReply();
        // Flush pending batched updates and awareness.
        if (this._batchTimeoutId !== undefined) {
            clearTimeout(this._batchTimeoutId);
            this._batchTimeoutId = undefined;
            if (this._pendingUpdate && this.transport.isConnected) {
                this._sendUpdate(this._pendingUpdate);
            }
            this._pendingUpdate = null;
        }
        if (this._awarenessTimeoutId !== undefined) {
            clearTimeout(this._awarenessTimeoutId);
            this._awarenessTimeoutId = undefined;
            if (this._pendingAwarenessClients.size > 0 &&
                this.transport.isConnected) {
                const clientsToSend = Array.from(this._pendingAwarenessClients);
                this._sendAwarenessNow(clientsToSend);
            }
        }
        this._pendingAwarenessClients.clear();
        if (this._appAwarenessTimeoutId !== undefined) {
            clearTimeout(this._appAwarenessTimeoutId);
            this._appAwarenessTimeoutId = undefined;
            if (this._pendingAppAwarenessClients.size > 0 &&
                this.transport.isConnected) {
                this._sendAwarenessNow(Array.from(this._pendingAppAwarenessClients), AWARENESS_CHANNEL_APP);
            }
        }
        this._pendingAppAwarenessClients.clear();
        this._disconnectBroadcastChannel();
        if (this._unsubscribeTransport) {
            this._unsubscribeTransport();
            this._unsubscribeTransport = undefined;
        }
        awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'disconnect');
        awarenessProtocol.removeAwarenessStates(this.appAwareness, [this.doc.clientID], 'disconnect');
        this.transport.disconnect();
        this._synced = false;
        this._setStatus({ state: 'disconnected' });
    }
    /** Disconnect and remove all listeners; the provider can't be reused. */
    destroy() {
        this._destroying = true;
        this.disconnect();
        if (this._updateHandler) {
            this.doc.off('update', this._updateHandler);
            this._updateHandler = undefined;
        }
        if (this._awarenessUpdateHandler) {
            this.awareness.off('update', this._awarenessUpdateHandler);
            this._awarenessUpdateHandler = undefined;
        }
        if (this._appAwarenessUpdateHandler) {
            this.appAwareness.off('update', this._appAwarenessUpdateHandler);
            this._appAwarenessUpdateHandler = undefined;
        }
        if (this._beforeUnloadHandler && typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', this._beforeUnloadHandler);
            this._beforeUnloadHandler = undefined;
        }
        this.awareness.destroy();
        this.appAwareness.destroy();
        super.destroy();
    }
    get status() {
        return this._status;
    }
    get connected() {
        return this.transport.isConnected;
    }
    get bcConnected() {
        return this._bcConnected;
    }
    /** True once a SyncStep2 has been received. */
    get synced() {
        return this._synced;
    }
    /** Push the full document state, request missing updates and re-send awareness. */
    syncNow() {
        if (!this.transport.isConnected) {
            console.warn('Cannot sync: transport not connected');
            return;
        }
        // Rate-limited: many peers joining at once each trigger a full-state
        // broadcast (see test/dummy/bench-user-scaling.ts).
        if (this._tryReserveSyncSlot()) {
            const update = Y.encodeStateAsUpdate(this.doc);
            if (update.length > 0) {
                this._sendUpdate(update);
            }
            this._writeSyncStep1();
        }
        // Awareness has its own throttle and isn't rate-limited.
        this._broadcastAwareness([this.doc.clientID]);
        this._broadcastAwareness([this.doc.clientID], AWARENESS_CHANNEL_APP);
    }
    _setupDocumentSync() {
        this._updateHandler = (update, origin) => {
            // Skip updates we applied from the network, and local-only origins.
            if (origin === this)
                return;
            if (this._excludeOrigins.has(origin))
                return;
            if (this._batchUpdates > 0) {
                this._batchUpdate(update);
            }
            else {
                this._sendUpdate(update);
            }
        };
        this.doc.on('update', this._updateHandler);
    }
    /** Merge updates and send them once no new one arrived for `batchUpdates` ms. */
    _batchUpdate(update) {
        if (this._pendingUpdate) {
            try {
                this._pendingUpdate = Y.mergeUpdates([this._pendingUpdate, update]);
            }
            catch (error) {
                console.error('[GenericProvider] Failed to merge updates:', error);
                this._sendUpdate(this._pendingUpdate);
                this._pendingUpdate = update;
            }
        }
        else {
            this._pendingUpdate = update;
        }
        if (this._batchTimeoutId !== undefined) {
            clearTimeout(this._batchTimeoutId);
        }
        this._batchTimeoutId = setTimeout(() => {
            if (this._pendingUpdate) {
                this._sendUpdate(this._pendingUpdate);
                this._pendingUpdate = null;
            }
            this._batchTimeoutId = undefined;
        }, this._batchUpdates);
    }
    _setupAwarenessSync() {
        this._awarenessUpdateHandler = ({ added, updated, removed, }, _origin) => {
            this._broadcastAwareness(this._awarenessClientsToSend(added.concat(updated, removed)));
        };
        this.awareness.on('update', this._awarenessUpdateHandler);
        this._appAwarenessUpdateHandler = ({ added, updated, removed, }, _origin) => {
            this._broadcastAwareness(this._awarenessClientsToSend(added.concat(updated, removed)), AWARENESS_CHANNEL_APP);
        };
        this.appAwareness.on('update', this._appAwarenessUpdateHandler);
        // On page unload, go offline and tell other tabs.
        if (typeof window !== 'undefined') {
            this._beforeUnloadHandler = () => {
                awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
                awarenessProtocol.removeAwarenessStates(this.appAwareness, [this.doc.clientID], 'window unload');
                this._disconnectBroadcastChannel();
            };
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
        }
    }
    /**
     * Changed awareness clients to broadcast. If the transport reaches every
     * peer, only our own state (relaying others' is N² duplication). Otherwise
     * all of them, which is how presence crosses a partial mesh.
     */
    _awarenessClientsToSend(changed) {
        if (this.transport.reachesAllPeers !== true)
            return changed;
        return changed.filter((client) => client === this.doc.clientID);
    }
    /**
     * Handle a frame [opcode][payload] from the transport or another tab.
     * An undecodable frame is dropped; the periodic SyncStep1 recovers it.
     */
    _handleIncomingMessage(message) {
        try {
            const decoder = decoding.createDecoder(message);
            const messageType = decoding.readVarUint(decoder);
            switch (messageType) {
                case MESSAGE_SYNC:
                    this._handleSyncMessage(decoder);
                    break;
                case MESSAGE_SYNC_VERIFIED:
                    // 2.0.x: [seqNum][senderClientID][sync message][hash]. The hash
                    // mismatched on ordinary concurrent edits, so it's ignored.
                    decoding.readVarUint(decoder); // seqNum
                    decoding.readVarUint(decoder); // senderClientID
                    this._handleSyncMessage(decoder);
                    break;
                case MESSAGE_AWARENESS: {
                    const channel = decoding.readVarUint(decoder);
                    awarenessProtocol.applyAwarenessUpdate(channel === AWARENESS_CHANNEL_APP
                        ? this.appAwareness
                        : this.awareness, decoding.readVarUint8Array(decoder), this);
                    break;
                }
                case MESSAGE_PUBSUB: {
                    const topic = decoding.readVarString(decoder);
                    const payloadBytes = decoding.readVarUint8Array(decoder);
                    try {
                        const decoder = new TextDecoder();
                        const payloadStr = decoder.decode(payloadBytes);
                        const message = JSON.parse(payloadStr);
                        this.pubsub._handleMessage(topic, message);
                    }
                    catch (error) {
                        console.error('Error decoding pub/sub message:', error);
                    }
                    break;
                }
                case MESSAGE_PUBSUB_TARGETED: {
                    const target = decoding.readVarString(decoder);
                    const topic = decoding.readVarString(decoder);
                    const payloadBytes = decoding.readVarUint8Array(decoder);
                    // Drop messages aimed at someone else (broadcast-and-filter path).
                    if (this._localId !== undefined && target !== this._localId) {
                        break;
                    }
                    try {
                        const message = JSON.parse(new TextDecoder().decode(payloadBytes));
                        this.pubsub._handleMessage(topic, message);
                    }
                    catch (error) {
                        console.error('Error decoding targeted pub/sub message:', error);
                    }
                    break;
                }
                default:
                    console.warn('Unknown message type:', messageType);
            }
        }
        catch (error) {
            console.error('[GenericProvider] Dropping undecodable message:', error);
        }
    }
    /**
     * Apply a y-protocols sync message (SyncStep1, SyncStep2 or update) and
     * send the reply it calls for, if any.
     */
    _handleSyncMessage(decoder) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
            if (!this._synced) {
                this._synced = true;
                this.emit('synced', [true]);
            }
            // Another peer answered; our pending reply is likely redundant.
            this._cancelPendingSyncReply();
        }
        // Delay the reply only if ≥2 other peers could answer too.
        if (encoding.length(encoder) > 1) {
            if (this.awareness.getStates().size >= 3) {
                this._scheduleSyncReply(encoding.toUint8Array(encoder));
            }
            else {
                this._sendSyncReply(encoding.toUint8Array(encoder));
            }
        }
    }
    /**
     * Send a SyncStep2 reply after a random delay unless another peer's reply
     * arrives first. A reply already pending answers a different request, so
     * it is flushed, not overwritten.
     */
    _scheduleSyncReply(reply) {
        if (this._pendingSyncReplyTimeoutId !== undefined) {
            if (this._pendingSyncReply) {
                this._sendSyncReply(this._pendingSyncReply);
            }
            clearTimeout(this._pendingSyncReplyTimeoutId);
            this._pendingSyncReplyTimeoutId = undefined;
        }
        this._pendingSyncReply = reply;
        const delay = Math.random() * this._syncReplySuppressionMs;
        this._pendingSyncReplyTimeoutId = setTimeout(() => {
            this._pendingSyncReplyTimeoutId = undefined;
            if (this._pendingSyncReply) {
                this._sendSyncReply(this._pendingSyncReply);
                this._pendingSyncReply = null;
            }
        }, delay);
    }
    _cancelPendingSyncReply() {
        if (this._pendingSyncReplyTimeoutId !== undefined) {
            clearTimeout(this._pendingSyncReplyTimeoutId);
            this._pendingSyncReplyTimeoutId = undefined;
        }
        this._pendingSyncReply = null;
    }
    /**
     * Send a SyncStep2 reply within the shared sync budget, a backstop for
     * when suppression fails. Dropped silently: logging would spam exactly
     * when the room is already noisy.
     */
    _sendSyncReply(reply) {
        if (!this._tryReserveSyncSlot())
            return;
        this._send(reply);
    }
    /** Take a slot from the shared sync budget; false if it's used up. */
    _tryReserveSyncSlot() {
        const now = Date.now();
        this._syncRequestTimes = this._syncRequestTimes.filter((t) => now - t < this._syncRequestWindowMs);
        if (this._syncRequestTimes.length >= this._maxSyncRequestsPerWindow) {
            return false;
        }
        this._syncRequestTimes.push(now);
        return true;
    }
    /** Send a SyncStep1; the caller must have reserved a sync slot. */
    _writeSyncStep1() {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, this.doc);
        this._send(encoding.toUint8Array(encoder));
    }
    /** Send a SyncStep1 if the sync budget allows. */
    _sendSyncStep1() {
        if (!this._tryReserveSyncSlot()) {
            console.warn(`[GenericProvider] Sync rate limit exceeded (${this._maxSyncRequestsPerWindow} requests per ${this._syncRequestWindowMs / 1000}s), throttling...`);
            return;
        }
        this._writeSyncStep1();
    }
    _sendUpdate(update) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        this._send(encoding.toUint8Array(encoder));
    }
    /** @internal Frame: [MESSAGE_PUBSUB][topic][JSON bytes]. */
    _sendPubSub(topic, message) {
        if (!this.transport.isConnected) {
            console.warn('Cannot send pub/sub message: not connected');
            return;
        }
        try {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_PUBSUB);
            encoding.writeVarString(encoder, topic);
            const messageBytes = new TextEncoder().encode(JSON.stringify(message));
            encoding.writeVarUint8Array(encoder, messageBytes);
            this._send(encoding.toUint8Array(encoder));
        }
        catch (error) {
            console.error('Error sending pub/sub message:', error);
        }
    }
    /** @internal Frame: [MESSAGE_PUBSUB_TARGETED][target][topic][JSON bytes]. */
    _sendPubSubTo(target, topic, message) {
        if (!this.transport.isConnected) {
            console.warn('Cannot send targeted pub/sub message: not connected');
            return;
        }
        try {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_PUBSUB_TARGETED);
            encoding.writeVarString(encoder, target);
            encoding.writeVarString(encoder, topic);
            const messageBytes = new TextEncoder().encode(JSON.stringify(message));
            encoding.writeVarUint8Array(encoder, messageBytes);
            const frame = encoding.toUint8Array(encoder);
            if (this.transport.sendTo) {
                // The target may be another tab, reachable only via BroadcastChannel;
                // other tabs drop it by localId.
                if (this._bcConnected) {
                    bc.publish(this._bcChannel, frame, this);
                }
                const result = this.transport.sendTo(target, frame);
                if (result instanceof Promise) {
                    result.catch((error) => {
                        console.error('Error sending targeted pub/sub message:', error);
                    });
                }
            }
            else {
                this._send(frame);
            }
        }
        catch (error) {
            console.error('Error sending targeted pub/sub message:', error);
        }
    }
    /** Broadcast these clients' awareness, batched to one frame per `awarenessInterval`. */
    _broadcastAwareness(clients, channel = AWARENESS_CHANNEL_MAIN) {
        if (clients.length === 0)
            return;
        const isApp = channel === AWARENESS_CHANNEL_APP;
        const pending = isApp
            ? this._pendingAppAwarenessClients
            : this._pendingAwarenessClients;
        if (this._awarenessInterval <= 0) {
            this._sendAwarenessNow(clients, channel);
            return;
        }
        for (const client of clients) {
            pending.add(client);
        }
        // A broadcast is already scheduled and will include them.
        if ((isApp ? this._appAwarenessTimeoutId : this._awarenessTimeoutId) !==
            undefined) {
            return;
        }
        const now = Date.now();
        const lastTime = isApp ? this._lastAppAwarenessTime : this._lastAwarenessTime;
        const delay = Math.max(0, this._awarenessInterval - (now - lastTime));
        const timeoutId = setTimeout(() => {
            if (isApp) {
                this._appAwarenessTimeoutId = undefined;
                this._lastAppAwarenessTime = Date.now();
            }
            else {
                this._awarenessTimeoutId = undefined;
                this._lastAwarenessTime = Date.now();
            }
            const clientsToSend = Array.from(pending);
            pending.clear();
            if (clientsToSend.length > 0) {
                this._sendAwarenessNow(clientsToSend, channel);
            }
        }, delay);
        if (isApp)
            this._appAwarenessTimeoutId = timeoutId;
        else
            this._awarenessTimeoutId = timeoutId;
    }
    _sendAwarenessNow(clients, channel = AWARENESS_CHANNEL_MAIN) {
        const aw = channel === AWARENESS_CHANNEL_APP ? this.appAwareness : this.awareness;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint(encoder, channel);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(aw, clients));
        this._send(encoding.toUint8Array(encoder));
    }
    /** Join the room's BroadcastChannel and send our state to other tabs. */
    _setupBroadcastChannel(config) {
        if (this._disableBc ||
            typeof BroadcastChannel === 'undefined' ||
            typeof window === 'undefined') {
            return;
        }
        this._bcChannel = `yjs-${WIRE_TAG}-${config.room}`;
        this._bcSubscriber = (data, origin) => {
            if (origin === this)
                return;
            this._handleIncomingMessage(new Uint8Array(data));
        };
        bc.subscribe(this._bcChannel, this._bcSubscriber);
        this._bcConnected = true;
        // SyncStep1 + SyncStep2 + awareness, so other tabs sync immediately.
        const encoderSync = encoding.createEncoder();
        encoding.writeVarUint(encoderSync, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoderSync, this.doc);
        bc.publish(this._bcChannel, encoding.toUint8Array(encoderSync), this);
        const encoderState = encoding.createEncoder();
        encoding.writeVarUint(encoderState, MESSAGE_SYNC);
        syncProtocol.writeSyncStep2(encoderState, this.doc);
        bc.publish(this._bcChannel, encoding.toUint8Array(encoderState), this);
        if (this.awareness.getLocalState() !== null) {
            this._publishAwarenessToBroadcastChannel(this.awareness, AWARENESS_CHANNEL_MAIN);
        }
        if (this.appAwareness.getLocalState() !== null) {
            this._publishAwarenessToBroadcastChannel(this.appAwareness, AWARENESS_CHANNEL_APP);
        }
    }
    _publishAwarenessToBroadcastChannel(awareness, channel) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint(encoder, channel);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [this.doc.clientID]));
        bc.publish(this._bcChannel, encoding.toUint8Array(encoder), this);
    }
    /** Tell other tabs we're offline (null awareness) and leave the channel. */
    _disconnectBroadcastChannel() {
        if (!this._bcConnected || !this._bcSubscriber) {
            return;
        }
        for (const [awareness, channel] of [
            [this.awareness, AWARENESS_CHANNEL_MAIN],
            [this.appAwareness, AWARENESS_CHANNEL_APP],
        ]) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
            encoding.writeVarUint(encoder, channel);
            encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [this.doc.clientID], new Map()));
            bc.publish(this._bcChannel, encoding.toUint8Array(encoder), this);
        }
        bc.unsubscribe(this._bcChannel, this._bcSubscriber);
        this._bcConnected = false;
        this._bcSubscriber = undefined;
    }
    /** Send a frame to other tabs and through the transport. */
    _send(data) {
        if (this._bcConnected) {
            bc.publish(this._bcChannel, data, this);
        }
        if (!this.transport.isConnected) {
            return;
        }
        try {
            const result = this.transport.send(data);
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
     * A method rather than an inline check so TypeScript doesn't narrow
     * `_status` across the await in connect(), where disconnect() may change it.
     */
    _isConnecting() {
        return this._status.state === 'connecting';
    }
    _setStatus(status) {
        this._status = status;
        this.emit('status', [status]);
    }
}
//# sourceMappingURL=index.js.map