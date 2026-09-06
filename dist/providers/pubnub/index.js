/**
 * PubNub Transport for Yjs
 *
 * Provides real-time synchronization using PubNub's pub/sub infrastructure.
 *
 * Features:
 * - Global cloud infrastructure with low latency
 * - Built-in presence tracking
 * - Optional message encryption
 * - Optional message persistence
 * - Reliable message delivery
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { PubNubTransport } from 'y-generic/providers/pubnub'
 *
 * const doc = new Y.Doc()
 * const transport = new PubNubTransport({
 *   publishKey: 'pub-c-xxx',
 *   subscribeKey: 'sub-c-xxx',
 *   room: 'my-room',
 *   password: 'optional-encryption-key'
 * })
 *
 * const provider = new GenericProvider(doc, transport)
 * ```
 */
export class PubNubTransport {
    constructor() {
        this.pubnub = null;
        this.channel = '';
        this.uuid = '';
        this._isConnected = false;
        this.config = null;
        this.debug = false;
        this.messageBuffer = []; // Buffer messages until callback is set
        this.chunkBuffer = new Map(); // Buffer for reassembling chunks
        // Compress a full-document push before it is base64-encoded and chunked
        // (see Transport.preferredCompressMinBytes).
        this.preferredCompressMinBytes = 2048;
        // PubNub has a 32 KiB message limit. We use 30 KB for safety (after base64 encoding)
        this.MAX_MESSAGE_SIZE = 30000;
    }
    get isConnected() {
        return this._isConnected;
    }
    /**
     * Connect to PubNub channel
     */
    async connect(config) {
        this.config = config;
        this.debug = config.debug ?? false;
        // Validate required keys
        if (!config.publishKey || !config.subscribeKey) {
            throw new Error('PubNub requires publishKey and subscribeKey');
        }
        if (!config.room) {
            throw new Error('Room name is required');
        }
        this.log('Initializing PubNub transport...');
        // Check if PubNub is loaded
        if (typeof globalThis.PubNub === 'undefined') {
            throw new Error('PubNub SDK not loaded. Include the PubNub script from CDN: https://cdn.pubnub.com/sdk/javascript/pubnub.10.2.7.min.js');
        }
        // Generate unique ID for this client
        this.uuid = this.generateUUID();
        // Use base64 encoded room name as channel
        this.channel = btoa(config.room);
        this.log(`Connecting as ${this.uuid} to channel ${this.channel}`);
        // Create PubNub instance
        const pubnubConfig = {
            publishKey: config.publishKey,
            subscribeKey: config.subscribeKey,
            userId: this.uuid,
        };
        // Add cipher key if provided
        if (config.cipherKey) {
            pubnubConfig.cipherKey = config.cipherKey;
            this.log('Message encryption enabled');
        }
        // @ts-ignore - PubNub global
        this.pubnub = new PubNub(pubnubConfig);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('PubNub connection timeout'));
            }, 10000);
            this.pubnub.addListener({
                status: (statusEvent) => {
                    this.log(`Status: ${statusEvent.category}`, statusEvent);
                    if (statusEvent.category === 'PNConnectedCategory') {
                        this._isConnected = true;
                        clearTimeout(timeout);
                        this.log('✅ Connected to PubNub');
                        resolve();
                    }
                    else if (statusEvent.category === 'PNNetworkDownCategory') {
                        this.log('⚠️ Network is down');
                        this._isConnected = false;
                    }
                    else if (statusEvent.category === 'PNNetworkUpCategory') {
                        this.log('✅ Network is back up');
                        this._isConnected = true;
                    }
                },
                message: (event) => {
                    // Ignore our own messages
                    if (event.publisher === this.uuid)
                        return;
                    if (event.message) {
                        try {
                            // Check if message is chunked
                            if (typeof event.message === 'object' && event.message.chunked) {
                                // Handle chunked message
                                this.handleChunkedMessage(event.message, event.publisher);
                                return;
                            }
                            // Convert base64 to Uint8Array
                            const data = typeof event.message === 'string'
                                ? this.base64ToUint8(event.message)
                                : new Uint8Array(event.message);
                            this.log(`📨 Received ${data.length} bytes from ${event.publisher}`);
                            // If callback is set, process immediately
                            if (this.messageCallback) {
                                this.messageCallback(data);
                            }
                            else {
                                // Buffer message until callback is registered
                                this.log('⚠️ Message received before callback registered, buffering...');
                                this.messageBuffer.push(data);
                            }
                        }
                        catch (error) {
                            this.log('❌ Error processing message:', error);
                        }
                    }
                },
                presence: (event) => {
                    this.log(`Presence: ${event.action}`, event);
                },
            });
            // Subscribe to channel
            this.pubnub.subscribe({
                channels: [this.channel],
                withPresence: true,
            });
        });
    }
    /**
     * Disconnect from PubNub
     */
    disconnect() {
        if (this.pubnub) {
            this.log('Disconnecting from PubNub...');
            this.pubnub.unsubscribeAll();
            this.pubnub = null;
        }
        this._isConnected = false;
    }
    /**
     * Send data to all peers
     */
    send(data) {
        if (!this.pubnub || !this._isConnected) {
            this.log('⚠️ Cannot send: not connected');
            return;
        }
        try {
            const base64Data = this.uint8ToBase64(data);
            const estimatedSize = base64Data.length;
            // Check if message needs to be chunked
            if (estimatedSize > this.MAX_MESSAGE_SIZE) {
                this.log(`📦 Message too large (${estimatedSize} bytes), chunking into smaller pieces...`);
                this.sendChunked(base64Data, data.length);
                return;
            }
            // Send as single message
            this.log(`📤 Sending ${data.length} bytes`);
            this.pubnub
                .publish({
                channel: this.channel,
                message: base64Data,
                storeInHistory: this.config?.storeInHistory ?? false,
            })
                .then((response) => {
                this.log('✅ Message published', response);
            })
                .catch((error) => {
                this.log('❌ Publish error:', error);
            });
        }
        catch (error) {
            this.log('❌ Send error:', error);
        }
    }
    /**
     * Send large message in chunks
     */
    sendChunked(base64Data, originalSize) {
        const chunkId = this.generateUUID();
        const chunks = [];
        // Split into chunks
        for (let i = 0; i < base64Data.length; i += this.MAX_MESSAGE_SIZE) {
            chunks.push(base64Data.slice(i, i + this.MAX_MESSAGE_SIZE));
        }
        this.log(`📦 Splitting ${originalSize} bytes into ${chunks.length} chunks (id: ${chunkId.slice(0, 8)}...)`);
        // Send each chunk
        chunks.forEach((chunk, index) => {
            const message = {
                chunked: true,
                id: chunkId,
                index,
                total: chunks.length,
                data: chunk,
            };
            this.pubnub
                .publish({
                channel: this.channel,
                message,
                storeInHistory: false, // Don't store chunks in history
            })
                .then(() => {
                this.log(`✅ Chunk ${index + 1}/${chunks.length} sent`);
            })
                .catch((error) => {
                this.log(`❌ Failed to send chunk ${index + 1}:`, error);
            });
        });
    }
    /**
     * Handle incoming chunked message
     */
    handleChunkedMessage(message, publisher) {
        const { id, index, total, data } = message;
        this.log(`📨 Received chunk ${index + 1}/${total} from ${publisher}`);
        // Get or create chunk buffer for this message
        if (!this.chunkBuffer.has(id)) {
            this.chunkBuffer.set(id, new Map());
        }
        const chunks = this.chunkBuffer.get(id);
        chunks.set(index, data);
        // Check if we have all chunks
        if (chunks.size === total) {
            this.log(`📦 All chunks received, reassembling message ${id.slice(0, 8)}...`);
            // Reassemble in order
            let base64Data = '';
            for (let i = 0; i < total; i++) {
                const chunk = chunks.get(i);
                if (!chunk) {
                    this.log(`❌ Missing chunk ${i}, cannot reassemble`);
                    this.chunkBuffer.delete(id);
                    return;
                }
                base64Data += chunk;
            }
            // Clean up
            this.chunkBuffer.delete(id);
            // Convert to Uint8Array and process
            try {
                const reassembledData = this.base64ToUint8(base64Data);
                this.log(`✅ Message reassembled: ${reassembledData.length} bytes from ${publisher}`);
                if (this.messageCallback) {
                    this.messageCallback(reassembledData);
                }
                else {
                    this.messageBuffer.push(reassembledData);
                }
            }
            catch (error) {
                this.log('❌ Error reassembling chunked message:', error);
            }
        }
    }
    /**
     * Register message callback
     */
    onMessage(callback) {
        this.messageCallback = callback;
        // Flush any buffered messages
        if (this.messageBuffer.length > 0) {
            this.log(`📦 Flushing ${this.messageBuffer.length} buffered messages...`);
            for (const data of this.messageBuffer) {
                callback(data);
            }
            this.messageBuffer = [];
        }
        return () => {
            this.messageCallback = undefined;
        };
    }
    /**
     * Get presence information (list of peers)
     */
    async getPresence() {
        if (!this.pubnub || !this._isConnected) {
            return [];
        }
        try {
            const response = await this.pubnub.hereNow({
                channels: [this.channel],
                includeUUIDs: true,
            });
            const occupants = response.channels[this.channel]?.occupants || [];
            return occupants
                .map((occ) => occ.uuid)
                .filter((uuid) => uuid !== this.uuid);
        }
        catch (error) {
            this.log('Error getting presence:', error);
            return [];
        }
    }
    /**
     * Convert Uint8Array to base64 string
     *
     * Handles large arrays by processing in chunks to avoid
     * "too many function arguments" error with String.fromCharCode
     */
    uint8ToBase64(data) {
        const chunkSize = 8192; // Process 8KB at a time
        let binary = '';
        for (let i = 0; i < data.length; i += chunkSize) {
            const chunk = data.subarray(i, Math.min(i + chunkSize, data.length));
            binary += String.fromCharCode(...chunk);
        }
        return btoa(binary);
    }
    /**
     * Convert base64 string to Uint8Array
     */
    base64ToUint8(str) {
        return new Uint8Array(atob(str)
            .split('')
            .map((c) => c.charCodeAt(0)));
    }
    /**
     * Generate a unique UUID
     */
    generateUUID() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback for older browsers
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }
    /**
     * Debug logging
     */
    log(message, ...args) {
        if (this.debug) {
            console.log(`[PubNubTransport] ${message}`, ...args);
        }
    }
}
//# sourceMappingURL=index.js.map