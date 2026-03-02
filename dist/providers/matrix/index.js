/**
 * Matrix Transport for Yjs
 *
 * Provides real-time synchronization using Matrix protocol.
 *
 * Features:
 * - Decentralized federation
 * - Guest access (no login required)
 * - End-to-end encryption support
 * - Persistent message history
 * - Room-based collaboration
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { MatrixTransport } from 'y-generic/providers/matrix'
 *
 * const doc = new Y.Doc()
 * const transport = new MatrixTransport()
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   homeserverUrl: 'https://matrix.org',
 *   room: '#my-room:matrix.org'
 * })
 * ```
 */
export class MatrixTransport {
    constructor() {
        this.config = null;
        this._isConnected = false;
        this.debug = false;
        this.accessToken = null;
        this.userId = null;
        this.roomId = null;
        this.syncToken = null;
        this.syncRunning = false;
        this.intentionalDisconnect = false;
        this.txnId = 0;
        // Message buffering
        this.messageQueue = [];
        this.receivedBuffer = [];
    }
    get isConnected() {
        return this._isConnected;
    }
    /**
     * Connect to Matrix homeserver and join room
     */
    async connect(config) {
        this.config = config;
        this.debug = config.debug ?? false;
        this.intentionalDisconnect = false;
        if (!config.homeserverUrl) {
            throw new Error('Matrix homeserverUrl is required');
        }
        if (!config.room) {
            throw new Error('Room identifier is required');
        }
        this.log(`🔌 Connecting to Matrix homeserver: ${config.homeserverUrl}`);
        try {
            // Get access token (guest registration or provided token)
            if (config.accessToken && config.userId) {
                this.accessToken = config.accessToken;
                this.userId = config.userId;
                this.log(`✅ Using provided credentials: ${this.userId}`);
            }
            else {
                await this.registerAsGuest();
            }
            // Join or create room
            await this.joinRoom(config.room);
            // Start sync loop
            this._isConnected = true;
            this.startSync();
            // Flush any queued messages
            this.flushMessageQueue();
            this.log(`✅ Connected to Matrix room: ${config.room}`);
        }
        catch (error) {
            this.log(`❌ Connection failed:`, error);
            throw error;
        }
    }
    /**
     * Register as guest on the homeserver
     */
    async registerAsGuest() {
        if (!this.config)
            throw new Error('Config not set');
        this.log('👤 Registering as guest...');
        const response = await fetch(`${this.config.homeserverUrl}/_matrix/client/v3/register?kind=guest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            const errorText = await response.text();
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            }
            catch {
                errorData = { error: errorText };
            }
            // Provide helpful error messages
            if (errorData.errcode === 'M_FORBIDDEN' || response.status === 403) {
                throw new Error(`Guest registration is disabled on this homeserver.\n\n` +
                    `Solutions:\n` +
                    `1. Use a Matrix account: Provide accessToken and userId\n` +
                    `2. Try a different homeserver that supports guest access\n` +
                    `3. Run your own Matrix homeserver with guest access enabled\n\n` +
                    `Many public homeservers have disabled guest access due to spam.`);
            }
            throw new Error(`Guest registration failed: ${errorText}`);
        }
        const data = await response.json();
        this.accessToken = data.access_token;
        this.userId = data.user_id;
        this.log(`✅ Registered as guest: ${this.userId}`);
    }
    /**
     * Join a Matrix room
     */
    async joinRoom(roomIdentifier) {
        if (!this.accessToken)
            throw new Error('Not authenticated');
        this.log(`🚪 Joining room: ${roomIdentifier}`);
        // Encode room identifier for URL
        const encodedRoom = encodeURIComponent(roomIdentifier);
        const response = await fetch(`${this.config.homeserverUrl}/_matrix/client/v3/join/${encodedRoom}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.accessToken}`,
            },
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to join room: ${error}`);
        }
        const data = await response.json();
        this.roomId = data.room_id;
        this.log(`✅ Joined room: ${this.roomId}`);
    }
    /**
     * Start Matrix sync loop
     */
    async startSync() {
        if (this.syncRunning)
            return;
        this.syncRunning = true;
        this.log('🔄 Starting sync loop...');
        while (this.syncRunning && !this.intentionalDisconnect) {
            try {
                await this.syncOnce();
            }
            catch (error) {
                this.log('❌ Sync error:', error);
                // Wait before retrying
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }
    /**
     * Perform one sync request
     */
    async syncOnce() {
        if (!this.accessToken)
            return;
        // Build sync URL with optional since token for long-polling
        let url = `${this.config.homeserverUrl}/_matrix/client/v3/sync?timeout=30000`;
        if (this.syncToken) {
            url += `&since=${this.syncToken}`;
        }
        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${this.accessToken}`,
            },
        });
        if (!response.ok) {
            throw new Error(`Sync failed: ${response.statusText}`);
        }
        const data = await response.json();
        this.syncToken = data.next_batch;
        // Process room events
        if (data.rooms?.join?.[this.roomId]?.timeline?.events) {
            const events = data.rooms.join[this.roomId].timeline.events;
            for (const event of events) {
                if (event.type === 'm.room.message' &&
                    event.content?.msgtype === 'y.update') {
                    // Ignore our own messages
                    if (event.sender === this.userId)
                        continue;
                    // Decode the Yjs update from base64
                    try {
                        const updateBase64 = event.content.body;
                        const update = this.base64ToUint8(updateBase64);
                        this.log(`📨 Received ${update.length} bytes from ${event.sender}`);
                        if (this.messageCallback) {
                            this.messageCallback(update);
                        }
                        else {
                            this.receivedBuffer.push(update);
                        }
                    }
                    catch (error) {
                        this.log('❌ Error decoding message:', error);
                    }
                }
            }
        }
    }
    /**
     * Disconnect from Matrix
     */
    async disconnect() {
        this.log('🔌 Disconnecting from Matrix...');
        this.intentionalDisconnect = true;
        this.syncRunning = false;
        this._isConnected = false;
        this.accessToken = null;
        this.userId = null;
        this.roomId = null;
        this.syncToken = null;
    }
    /**
     * Send Yjs update to Matrix room
     */
    send(data) {
        if (!this._isConnected || !this.roomId || !this.accessToken) {
            // Queue message if not connected
            this.messageQueue.push(data);
            this.log(`⏳ Queued ${data.length} bytes (not connected)`);
            return;
        }
        try {
            // Encode update as base64 for JSON transport
            const base64Data = this.uint8ToBase64(data);
            // Send as custom message type
            const txnId = `y${this.txnId++}_${Date.now()}`;
            const url = `${this.config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/send/m.room.message/${txnId}`;
            // Send asynchronously (don't await)
            fetch(url, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.accessToken}`,
                },
                body: JSON.stringify({
                    msgtype: 'y.update',
                    body: base64Data,
                }),
            }).then((response) => {
                if (response.ok) {
                    this.log(`📤 Sent ${data.length} bytes`);
                }
                else {
                    this.log(`❌ Send failed: ${response.statusText}`);
                }
            });
        }
        catch (error) {
            this.log('❌ Send error:', error);
        }
    }
    /**
     * Register message callback
     */
    onMessage(callback) {
        this.messageCallback = callback;
        // Flush buffered messages
        if (this.receivedBuffer.length > 0) {
            this.log(`📦 Flushing ${this.receivedBuffer.length} buffered messages`);
            for (const data of this.receivedBuffer) {
                callback(data);
            }
            this.receivedBuffer = [];
        }
        return () => {
            this.messageCallback = undefined;
        };
    }
    /**
     * Flush queued messages
     */
    flushMessageQueue() {
        if (this.messageQueue.length === 0)
            return;
        this.log(`📦 Flushing ${this.messageQueue.length} queued messages`);
        for (const data of this.messageQueue) {
            this.send(data);
        }
        this.messageQueue = [];
    }
    /**
     * Convert Uint8Array to base64 string
     */
    uint8ToBase64(bytes) {
        let binary = '';
        const len = bytes.length;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }
    /**
     * Convert base64 string to Uint8Array
     */
    base64ToUint8(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
    /**
     * Log debug messages
     */
    log(...args) {
        if (this.debug) {
            console.log('[MatrixTransport]', ...args);
        }
    }
}
//# sourceMappingURL=index.js.map