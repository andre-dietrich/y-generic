// ---------------------------------------------------------------------------
// CRC32 translation helpers
//
// GenericProvider wraps every message as [CRC32 (4 bytes)][payload] before
// calling transport.send(), and expects the same format from onMessage().
// The y-websocket server however speaks plain Yjs wire format (no header).
// These helpers translate between the two worlds at the transport boundary.
// ---------------------------------------------------------------------------
const _CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();
function _crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++)
        crc = (crc >>> 8) ^ _CRC32_TABLE[(crc ^ data[i]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
}
/** Strip the 4-byte CRC32 header that GenericProvider prepends. */
function stripCRC32Header(data) {
    return data.length >= 4 ? data.subarray(4) : data;
}
/** Add a valid CRC32 header so GenericProvider accepts the message. */
function addCRC32Header(data) {
    const crc = _crc32(data);
    const wrapped = new Uint8Array(4 + data.length);
    wrapped[0] = (crc >>> 24) & 0xff;
    wrapped[1] = (crc >>> 16) & 0xff;
    wrapped[2] = (crc >>> 8) & 0xff;
    wrapped[3] = crc & 0xff;
    wrapped.set(data, 4);
    return wrapped;
}
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
        this.lastMessageAt = 0;
        this.wsUrl = '';
    }
    get isConnected() {
        return this._isConnected;
    }
    /**
     * Connect to WebSocket server.
     *
     * Resolves once a socket is open. With `autoReconnect` on (the default), a
     * failed or timed-out attempt does not reject: the transport keeps retrying
     * and the promise resolves when one succeeds. It rejects when
     * `autoReconnect` is off, when `maxReconnectAttempts` runs out, or when
     * disconnect() is called first.
     */
    async connect(config) {
        if (!config.serverUrl) {
            throw new Error('WebSocket serverUrl is required');
        }
        if (!config.room) {
            throw new Error('Room name is required');
        }
        this.config = config;
        this.debug = config.debug ?? false;
        this.intentionalDisconnect = false;
        this.reconnectAttempts = 0;
        // Build URL with room (y-websocket compatible)
        let wsUrl = config.serverUrl;
        // Remove trailing slash if present
        if (wsUrl.endsWith('/')) {
            wsUrl = wsUrl.slice(0, -1);
        }
        // Append room name to URL path
        this.wsUrl = `${wsUrl}/${encodeURIComponent(config.room)}`;
        return new Promise((resolve, reject) => {
            this.pendingConnect = { resolve, reject };
            this.openSocket();
        });
    }
    settleConnect(error) {
        const pending = this.pendingConnect;
        if (!pending)
            return;
        this.pendingConnect = undefined;
        if (error)
            pending.reject(error);
        else
            pending.resolve();
    }
    get autoReconnect() {
        return this.config?.autoReconnect ?? true;
    }
    /** One connection attempt; on failure, retries or rejects connect(). */
    openSocket() {
        if (!this.config)
            return;
        const config = this.config;
        this.log(`Connecting to WebSocket server: ${this.wsUrl}`);
        let ws;
        try {
            // Create WebSocket connection with room in URL (y-websocket style)
            ws = new WebSocket(this.wsUrl, config.protocols);
            ws.binaryType = 'arraybuffer';
        }
        catch (error) {
            this.connectFailed(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        this.ws = ws;
        const timeout = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN)
                return;
            this.log('⏱️ WebSocket connection timeout');
            // Abandon the attempt so it can't open late next to its retry; the
            // close handshake of a socket that never opened can hang.
            ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
            try {
                ws.close();
            }
            catch {
                // already closing
            }
            if (this.ws === ws)
                this.ws = null;
            this.connectFailed(new Error('WebSocket connection timeout'));
        }, 10000);
        ws.onopen = () => {
            clearTimeout(timeout);
            this._isConnected = true;
            this.reconnectAttempts = 0;
            this.log(`✅ WebSocket connected to room: ${config.room}`);
            this.startLivenessCheck();
            // Flush queued messages
            this.flushMessageQueue();
            this.settleConnect();
        };
        ws.onmessage = (event) => {
            this.lastMessageAt = Date.now();
            this.handleMessage(event.data);
        };
        ws.onerror = (error) => {
            // onclose always follows and decides about retrying.
            this.log('❌ WebSocket error:', error);
        };
        ws.onclose = (event) => {
            clearTimeout(timeout);
            this.stopLivenessCheck();
            const wasOpen = this._isConnected;
            this._isConnected = false;
            if (this.ws === ws)
                this.ws = null;
            this.log(`WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}`);
            if (this.intentionalDisconnect)
                return;
            if (wasOpen) {
                if (this.autoReconnect)
                    this.attemptReconnect();
            }
            else {
                this.connectFailed(new Error('WebSocket connection failed'));
            }
        };
    }
    /** A socket that never opened: retry, or give up and reject connect(). */
    connectFailed(error) {
        if (this.intentionalDisconnect)
            return;
        if (!this.autoReconnect || !this.attemptReconnect()) {
            this.settleConnect(error);
        }
    }
    /**
     * Disconnect from WebSocket server
     */
    disconnect() {
        this.intentionalDisconnect = true;
        this.settleConnect(new Error('WebSocket disconnected before it connected'));
        this.stopLivenessCheck();
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
        try {
            // Strip CRC32 header added by GenericProvider before sending to server
            const raw = stripCRC32Header(data);
            this.ws.send(raw);
            this.log(`📤 Sent ${raw.length} bytes (${data.length} with header)`);
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
    handleMessage(data) {
        try {
            if (typeof data === 'string') {
                // Handle text messages (control messages)
                this.log('📨 Received text message:', data);
                return;
            }
            // Wrap plain y-websocket message with CRC32 header expected by GenericProvider
            const uint8Data = addCRC32Header(new Uint8Array(data));
            this.log(`📨 Received ${uint8Data.length - 4} bytes`);
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
     * Watch for a socket that stays OPEN but receives nothing (half-open: dead
     * TCP path, NAT or proxy idle timeout). The browser may not fire onclose for
     * many minutes; meanwhile sends vanish and nothing arrives.
     */
    startLivenessCheck() {
        this.stopLivenessCheck();
        const timeout = this.config?.messageTimeout ?? 30000;
        if (timeout <= 0)
            return;
        this.lastMessageAt = Date.now();
        this.livenessTimer = setInterval(() => {
            const silentFor = Date.now() - this.lastMessageAt;
            if (!this.ws || silentFor <= timeout)
                return;
            this.log(`💀 No message for ${silentFor}ms, reconnecting`);
            // Don't wait for onclose: on a dead path the close handshake can hang.
            const ws = this.ws;
            ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
            try {
                ws.close();
            }
            catch {
                // already closing
            }
            this.ws = null;
            this._isConnected = false;
            this.stopLivenessCheck();
            if (!this.intentionalDisconnect && (this.config?.autoReconnect ?? true)) {
                this.attemptReconnect();
            }
        }, Math.max(100, timeout / 10));
    }
    stopLivenessCheck() {
        if (this.livenessTimer) {
            clearInterval(this.livenessTimer);
            this.livenessTimer = undefined;
        }
    }
    /**
     * Schedule the next connection attempt. Returns false when
     * `maxReconnectAttempts` is used up.
     */
    attemptReconnect() {
        if (!this.config)
            return false;
        if (this.reconnectTimer)
            return true; // already scheduled
        const maxAttempts = this.config.maxReconnectAttempts ?? 0;
        if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
            this.log(`❌ Max reconnection attempts (${maxAttempts}) reached`);
            return false;
        }
        this.reconnectAttempts++;
        const delay = this.config.reconnectDelay ?? 2000;
        this.log(`🔄 Attempting reconnection #${this.reconnectAttempts} in ${delay}ms...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.intentionalDisconnect)
                return;
            this.openSocket();
        }, delay);
        return true;
    }
    /**
     * Debug logging
     */
    log(message, ...args) {
        if (this.debug) {
            console.log(`[WebSocketTransport] ${message}`, ...args);
        }
    }
}
//# sourceMappingURL=index.js.map