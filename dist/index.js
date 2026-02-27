import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Observable } from 'lib0/observable';
// Message type identifiers
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_PUBSUB = 2;
const MESSAGE_SYNC_VERIFIED = 3; // Sync message with hash verification
/**
 * Compute a simple hash of document state for verification.
 * Uses a fast non-cryptographic hash for performance.
 */
function computeDocHash(doc) {
    const state = Y.encodeStateAsUpdate(doc);
    let hash = 0;
    for (let i = 0; i < state.length; i++) {
        hash = ((hash << 5) - hash + state[i]) | 0;
    }
    return hash;
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
        // Hash verification tracking for exponential backoff
        this._hashMismatchCount = 0;
        this._lastHashMismatchTime = 0;
        // Rate limiting for sync requests
        this._syncRequestTimes = [];
        this._maxSyncRequestsPerWindow = 20; // max requests per 10 seconds
        this._syncRequestWindowMs = 10000; // 10 second window
        // Sequence numbers for causal ordering
        this._localSeqNum = 0; // Our sequence number counter
        this._remoteSeqNums = new Map(); // clientID -> last seen seqNum
        // Update batching/debouncing
        this._batchUpdates = 0; // milliseconds delay (0 = disabled)
        this._pendingUpdate = null;
        this.doc = doc;
        this.transport = transport;
        this.pubsub = new PubSubChannel(this);
        this.awareness = options.awareness || new awarenessProtocol.Awareness(doc);
        this._syncInterval = options.syncInterval ?? 5000;
        this._verifyUpdates = options.verifyUpdates ?? true;
        this._batchUpdates = options.batchUpdates ?? 0;
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
        this._setStatus({ state: 'connecting' });
        try {
            // Connect the transport
            await this.transport.connect(config);
            // Register for incoming messages
            this._unsubscribeTransport = this.transport.onMessage((data) => {
                this._handleIncomingMessage(data);
            });
            this._setStatus({ state: 'connected' });
            // Send initial sync message (SyncStep1)
            this._sendSyncStep1();
            // Broadcast local awareness state
            this._broadcastAwareness([this.doc.clientID]);
            // Start periodic sync to handle packet loss
            // Just request sync without sending full state (avoid redundant broadcasts)
            if (this._syncInterval > 0) {
                this._syncIntervalId = setInterval(() => {
                    if (this.transport.isConnected && !this._destroying) {
                        this._sendSyncStep1();
                    }
                }, this._syncInterval);
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
            clearInterval(this._syncIntervalId);
            this._syncIntervalId = undefined;
        }
        // Clear any pending batched updates
        if (this._batchTimeoutId !== undefined) {
            clearTimeout(this._batchTimeoutId);
            this._batchTimeoutId = undefined;
            this._pendingUpdate = null;
        }
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
            clearInterval(this._syncIntervalId);
            this._syncIntervalId = undefined;
        }
        // Clear any pending batched updates
        if (this._batchTimeoutId !== undefined) {
            clearTimeout(this._batchTimeoutId);
            this._batchTimeoutId = undefined;
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
     * Whether the document is synced with remote peers
     */
    get synced() {
        return this._synced;
    }
    /**
     * Force an immediate sync with remote peers.
     * Useful after network interruptions or to manually trigger re-sync.
     */
    syncNow() {
        if (!this.transport.isConnected) {
            console.warn('Cannot sync: transport not connected');
            return;
        }
        // Send our current document state to all peers
        // This ensures any changes made while offline are transmitted
        const update = Y.encodeStateAsUpdate(this.doc);
        if (update.length > 0) {
            this._sendUpdate(update);
        }
        // Send sync request to get updates from others
        this._sendSyncStep1();
        // Broadcast current awareness state
        this._broadcastAwareness([this.doc.clientID]);
    }
    /**
     * Setup automatic document synchronization.
     * Listens to document updates and sends them to the transport.
     * If batchUpdates is enabled, updates are debounced/batched.
     */
    _setupDocumentSync() {
        this._updateHandler = (update, origin) => {
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
            // Yjs automatically merges sequential updates
            this._pendingUpdate = Y.mergeUpdates([this._pendingUpdate, update]);
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
            // Broadcast awareness changes (unless they came from remote)
            const changedClients = added.concat(updated).concat(removed);
            this._broadcastAwareness(changedClients);
        };
        this.awareness.on('update', this._awarenessUpdateHandler);
        // Cleanup: mark as offline when page unloads
        if (typeof window !== 'undefined') {
            const beforeUnload = () => {
                awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
            };
            window.addEventListener('beforeunload', beforeUnload);
        }
    }
    /**
     * Handle incoming messages from the transport.
     * Decodes and processes sync messages and awareness updates.
     */
    _handleIncomingMessage(data) {
        try {
            const decoder = decoding.createDecoder(data);
            const messageType = decoding.readVarUint(decoder);
            switch (messageType) {
                case MESSAGE_SYNC: {
                    const encoder = encoding.createEncoder();
                    encoding.writeVarUint(encoder, MESSAGE_SYNC);
                    const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
                    // If we received SyncStep2, we're synced
                    if (syncMessageType === syncProtocol.messageYjsSyncStep2 &&
                        !this._synced) {
                        this._synced = true;
                        this.emit('synced', [true]);
                    }
                    // Send reply if needed
                    if (encoding.length(encoder) > 1) {
                        this._send(encoding.toUint8Array(encoder));
                    }
                    break;
                }
                case MESSAGE_AWARENESS: {
                    awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
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
                    // Check for duplicate or out-of-order updates
                    const lastSeq = this._remoteSeqNums.get(senderClientID) ?? -1;
                    if (seqNum <= lastSeq) {
                        console.warn(`[GenericProvider] Duplicate or out-of-order update detected from client ${senderClientID}: seqNum ${seqNum} <= lastSeen ${lastSeq}`);
                        // Skip this update - it's a duplicate or we already have newer data
                        break;
                    }
                    // Check for sequence gap (potential packet loss)
                    if (lastSeq >= 0 && seqNum > lastSeq + 1) {
                        console.warn(`[GenericProvider] Sequence gap detected from client ${senderClientID}: expected ${lastSeq + 1}, got ${seqNum} (gap of ${seqNum - lastSeq - 1} messages)`);
                        // Continue processing but log the gap - Yjs will handle missing updates
                    }
                    // Update sequence tracker
                    this._remoteSeqNums.set(senderClientID, seqNum);
                    // Create encoder for reply with standard MESSAGE_SYNC header
                    // (replies don't need verification since they're generated immediately)
                    const encoder = encoding.createEncoder();
                    encoding.writeVarUint(encoder, MESSAGE_SYNC);
                    const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
                    // Read the expected hash from sender (signed integer)
                    const expectedHash = decoding.readVarInt(decoder);
                    // Compute our local hash after applying the update
                    const localHash = computeDocHash(this.doc);
                    // Verify hash match
                    if (localHash !== expectedHash) {
                        this._hashMismatchCount++;
                        const now = Date.now();
                        // Reset counter if it's been stable for 10 seconds
                        if (now - this._lastHashMismatchTime > 10000) {
                            this._hashMismatchCount = 1;
                        }
                        this._lastHashMismatchTime = now;
                        // Exponential backoff: 10ms, 50ms, 250ms, 1.25s, 6.25s, then cap at 10s
                        const delay = Math.min(10000, 10 * Math.pow(5, this._hashMismatchCount - 1));
                        console.warn(`[GenericProvider] Hash mismatch #${this._hashMismatchCount} detected! Local: ${localHash}, Expected: ${expectedHash}`);
                        console.warn(`[GenericProvider] Re-sync scheduled in ${delay}ms...`);
                        // Request sync only (don't send our full state to avoid loop)
                        setTimeout(() => this._sendSyncStep1(), delay);
                    }
                    else {
                        // Hash matched - reset failure counter
                        this._hashMismatchCount = 0;
                    }
                    // If we received SyncStep2, we're synced (unless hash mismatched)
                    if (syncMessageType === syncProtocol.messageYjsSyncStep2 &&
                        !this._synced &&
                        localHash === expectedHash) {
                        this._synced = true;
                        this.emit('synced', [true]);
                    }
                    // Send reply if needed (as standard MESSAGE_SYNC)
                    if (encoding.length(encoder) > 1) {
                        this._send(encoding.toUint8Array(encoder));
                    }
                    break;
                }
                default:
                    console.warn('Unknown message type:', messageType);
            }
        }
        catch (error) {
            console.error('Error handling incoming message:', error);
        }
    }
    /**
     * Send SyncStep1 message to request missing updates.
     * This is sent when first connecting to sync with remote peers.
     * Note: SyncStep1 is just a request and doesn't include hash verification.
     * Rate limited to prevent spam.
     */
    _sendSyncStep1() {
        const now = Date.now();
        // Clean up old entries outside the rate limit window
        this._syncRequestTimes = this._syncRequestTimes.filter((t) => now - t < this._syncRequestWindowMs);
        // Check rate limit
        if (this._syncRequestTimes.length >= this._maxSyncRequestsPerWindow) {
            console.warn(`[GenericProvider] Sync rate limit exceeded (${this._maxSyncRequestsPerWindow} requests per ${this._syncRequestWindowMs / 1000}s), throttling...`);
            return; // Drop the request
        }
        // Record this request
        this._syncRequestTimes.push(now);
        const encoder = encoding.createEncoder();
        // SyncStep1 is always sent as standard MESSAGE_SYNC (no verification)
        // It's just a request, not an assertion of state
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, this.doc);
        this._send(encoding.toUint8Array(encoder));
    }
    /**
     * Send a document update to the transport.
     * If verifyUpdates is enabled, includes sequence number and document hash for ordering and desync detection.
     */
    _sendUpdate(update) {
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
        this.transport.send(encoding.toUint8Array(encoder));
    }
    /**
     * Send awareness update to the transport.
     */
    _sendAwarenessUpdate(changedClients) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
        this.transport.send(encoding.toUint8Array(encoder));
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
     * Send ng.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      this._send(encoding.toUint8Array(encoder))
    }
  
    /**
     * Broadcast awareness state for the specified clients.
     */
    _broadcastAwareness(clients) {
        if (clients.length === 0)
            return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
        this._send(encoding.toUint8Array(encoder));
    }
    /**
     * Send data through the transport.
     */
    _send(data) {
        if (!this.transport.isConnected) {
            return;
        }
        try {
            const result = this.transport.send(data);
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
}
//# sourceMappingURL=index.js.map