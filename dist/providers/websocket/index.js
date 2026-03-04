/**
 * WebSocket Transport for Yjs
 *
 * Provides real-time synchronization using WebSocket connections.
 *
 * Features:
 * - Direct WebSocket connection to server
 * - Room-based collaboration
 * - Automatic reconnection
 * - Binary message support
 * - Low latency real-time sync
 * - Optional password encryption (AES-GCM)
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { WebSocketTransport } from 'y-generic/providers/websocket'
 *
 * const doc = new Y.Doc()
 * const transport = new WebSocketTransport()
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   serverUrl: 'ws://localhost:1234',
 *   room: 'my-room'
 * })
 * ```
 *
 * @example Password-protected room
 * ```ts
 * await provider.connect({
 *   serverUrl: 'wss://example.com',
 *   room: 'secure-room',
 *   password: 'my-secret-password'  // E2E encrypted
 * })
 * ```
 */
export class WebSocketTransport {
    constructor() {
        this.ws = null;
        this.config = null;
        this._isConnected = false;
        this.debug = false;
        this.reconnectAttempts = 0;
        this.intentionalDisconnect = false;
        this.messageQueue = []; // Queue messages until connected
        this.receivedBuffer = []; // Buffer messages received before callback registered
        this.cryptoKey = null; // Derived encryption key
        this.encryptionEnabled = false;
    }
    get isConnected() {
        return this._isConnected;
    }
    /**
     * Connect to WebSocket server
     */
    async connect(config) {
        this.config = config;
        this.debug = config.debug ?? false;
        this.intentionalDisconnect = false;
        if (!config.serverUrl) {
            throw new Error('WebSocket serverUrl is required');
        }
        if (!config.room) {
            throw new Error('Room name is required');
        }
        // Initialize encryption if password provided
        if (config.password) {
            await this.initEncryption(config.password);
        }
        // Build URL with room (y-websocket compatible)
        let wsUrl = config.serverUrl;
        // Remove trailing slash if present
        if (wsUrl.endsWith('/')) {
            wsUrl = wsUrl.slice(0, -1);
        }
        // Append room name to URL path
        wsUrl = `${wsUrl}/${encodeURIComponent(config.room)}`;
        this.log(`Connecting to WebSocket server: ${wsUrl}`);
        return new Promise((resolve, reject) => {
            try {
                // Create WebSocket connection with room in URL (y-websocket style)
                this.ws = new WebSocket(wsUrl, config.protocols);
                this.ws.binaryType = 'arraybuffer';
                const timeout = setTimeout(() => {
                    if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
                        this.ws.close();
                        reject(new Error('WebSocket connection timeout'));
                    }
                }, 10000);
                this.ws.onopen = () => {
                    clearTimeout(timeout);
                    this._isConnected = true;
                    this.reconnectAttempts = 0;
                    this.log(`✅ WebSocket connected to room: ${config.room}`);
                    // Flush queued messages
                    this.flushMessageQueue();
                    resolve();
                };
                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };
                this.ws.onerror = (error) => {
                    clearTimeout(timeout);
                    this.log('❌ WebSocket error:', error);
                    if (!this._isConnected) {
                        reject(new Error('WebSocket connection failed'));
                    }
                };
                this.ws.onclose = (event) => {
                    clearTimeout(timeout);
                    this._isConnected = false;
                    this.log(`WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}`);
                    // Attempt reconnection if not intentional
                    if (!this.intentionalDisconnect && (config.autoReconnect ?? true)) {
                        this.attemptReconnect();
                    }
                };
            }
            catch (error) {
                reject(error);
            }
        });
    }
    /**
     * Disconnect from WebSocket server
     */
    disconnect() {
        this.intentionalDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.ws) {
            this.log('Disconnecting from WebSocket...');
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
        this._isConnected = false;
    }
    /**
     * Send data to server
     */
    send(data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.log('⚠️ WebSocket not ready, queueing message');
            this.messageQueue.push(data);
            return;
        }
        // Encrypt if password is set (async but we don't await - fire and forget)
        if (this.encryptionEnabled && this.cryptoKey) {
            this.encryptAndSend(data);
        }
        else {
            this.sendRaw(data);
        }
    }
    /**
     * Encrypt and send data
     */
    async encryptAndSend(data) {
        try {
            const encrypted = await this.encrypt(data);
            this.sendRaw(encrypted);
        }
        catch (error) {
            this.log('❌ Encryption error:', error);
        }
    }
    /**
     * Send raw data without encryption
     */
    sendRaw(data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            // Send raw binary data (y-websocket compatible)
            this.ws.send(data);
            this.log(`📤 Sent ${data.length} bytes${this.encryptionEnabled ? ' (encrypted)' : ''}`);
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
        // Flush any buffered messages that arrived before callback was registered
        if (this.receivedBuffer.length > 0) {
            this.log(`📦 Flushing ${this.receivedBuffer.length} buffered received messages`);
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
     * Handle incoming WebSocket message
     */
    async handleMessage(data) {
        try {
            if (typeof data === 'string') {
                // Handle text messages (control messages)
                this.log('📨 Received text message:', data);
                return;
            }
            // Binary message
            let uint8Data = new Uint8Array(data);
            // Decrypt if encryption is enabled
            if (this.encryptionEnabled && this.cryptoKey) {
                try {
                    const decrypted = await this.decrypt(uint8Data);
                    uint8Data = new Uint8Array(decrypted);
                }
                catch (error) {
                    this.log('❌ Decryption failed (wrong password?):', error);
                    return;
                }
            }
            this.log(`📨 Received ${uint8Data.length} bytes${this.encryptionEnabled ? ' (decrypted)' : ''}`);
            if (this.messageCallback) {
                this.messageCallback(uint8Data);
            }
            else {
                // Buffer message if callback not registered yet (race condition)
                this.log('⏳ Buffering message (callback not yet registered)');
                this.receivedBuffer.push(uint8Data);
            }
        }
        catch (error) {
            this.log('❌ Error handling message:', error);
        }
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
     * Attempt to reconnect
     */
    attemptReconnect() {
        if (!this.config)
            return;
        const maxAttempts = this.config.maxReconnectAttempts ?? 0;
        if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
            this.log(`❌ Max reconnection attempts (${maxAttempts}) reached`);
            return;
        }
        this.reconnectAttempts++;
        const delay = this.config.reconnectDelay ?? 2000;
        this.log(`🔄 Attempting reconnection #${this.reconnectAttempts} in ${delay}ms...`);
        this.reconnectTimer = setTimeout(async () => {
            try {
                await this.connect(this.config);
                this.log('✅ Reconnected successfully');
            }
            catch (error) {
                this.log('❌ Reconnection failed:', error);
            }
        }, delay);
    }
    /**
     * Debug logging
     */
    log(message, ...args) {
        if (this.debug) {
            console.log(`[WebSocketTransport] ${message}`, ...args);
        }
    }
    /**
     * Initialize encryption with password using PBKDF2 key derivation.
     */
    async initEncryption(password) {
        if (typeof crypto === 'undefined' || !crypto.subtle) {
            throw new Error('WebCrypto API not available - cannot use password encryption');
        }
        // Use room name + password as key material for domain separation
        const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
        // Derive AES-GCM key using PBKDF2
        // Use room name as salt for domain separation between rooms
        const salt = new TextEncoder().encode(`yjs-websocket-${this.config?.room || 'default'}`);
        this.cryptoKey = await crypto.subtle.deriveKey({
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256',
        }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        this.encryptionEnabled = true;
        this.log('🔐 Encryption enabled (AES-256-GCM)');
    }
    /**
     * Encrypt data using AES-GCM.
     * Format: [IV (12 bytes)][ciphertext][auth tag (16 bytes)]
     */
    async encrypt(data) {
        if (!this.cryptoKey) {
            throw new Error('Encryption key not initialized');
        }
        // Generate random IV (12 bytes for AES-GCM)
        const iv = crypto.getRandomValues(new Uint8Array(12));
        // Ensure data is backed by ArrayBuffer (not SharedArrayBuffer)
        const dataBuffer = new Uint8Array(data).buffer;
        // Encrypt with AES-GCM
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.cryptoKey, dataBuffer);
        // Prepend IV to ciphertext
        const result = new Uint8Array(iv.length + ciphertext.byteLength);
        result.set(iv, 0);
        result.set(new Uint8Array(ciphertext), iv.length);
        return result;
    }
    /**
     * Decrypt data using AES-GCM.
     */
    async decrypt(data) {
        if (!this.cryptoKey) {
            throw new Error('Encryption key not initialized');
        }
        if (data.length < 12) {
            throw new Error('Invalid encrypted data (too short)');
        }
        // Extract IV (first 12 bytes)
        const iv = new Uint8Array(data.slice(0, 12));
        const ciphertext = new Uint8Array(data.slice(12));
        // Decrypt with AES-GCM
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv.buffer }, this.cryptoKey, ciphertext.buffer);
        return new Uint8Array(plaintext);
    }
}
//# sourceMappingURL=index.js.map