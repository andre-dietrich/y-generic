/**
 * SimplePeer Transport Provider
 *
 * Peer-to-peer transport using WebRTC data channels with simple-peer library.
 * Connects directly to other clients without going through a central server.
 *
 * Features:
 * - Direct peer-to-peer connections
 * - Mesh network (each peer connects to multiple others)
 * - Uses signaling server only for peer discovery (not for data)
 * - Optional encryption
 * - Automatic connection management
 * - Resilient to peer disconnections
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { SimplePeerTransport } from 'y-generic/providers/simple-peer'
 * import Peer from 'simple-peer'
 *
 * const doc = new Y.Doc()
 * const transport = new SimplePeerTransport({
 *   peer: Peer, // Pass the simple-peer constructor
 *   signaling: ['wss://signaling.example.com'],
 *   password: 'optional-encryption-key'
 * })
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 * ```
 */
import { watchResume } from '../resume';
/**
 * Maximum chunk size for WebRTC DataChannel messages.
 * Most browsers support up to 256KB, but we use 64KB for safety.
 */
const CHUNK_SIZE = 64 * 1024;
/**
 * Maximum buffer size before we pause sending (16KB).
 * WebRTC DataChannel buffers data before sending over the network.
 * If we send too much too fast, the buffer overflows.
 */
const MAX_BUFFERED_AMOUNT = 16 * 1024;
/**
 * Message type markers for chunking protocol.
 * - 0x00: Complete message (no chunking, raw data)
 * - 0x01: Chunked message with header
 */
const MSG_TYPE_COMPLETE = 0x00;
const MSG_TYPE_CHUNKED = 0x01;
/** Counter for generating unique message IDs */
let messageIdCounter = 0;
/**
 * SimplePeer transport implementation using simple-peer library.
 * Creates direct peer-to-peer connections for data transfer.
 */
export class SimplePeerTransport {
    /**
     * Create a new SimplePeer transport.
     *
     * @param options - Configuration options (must include peer constructor)
     */
    constructor(options) {
        this._connected = false;
        this._room = '';
        this.peers = new Map();
        this.signalingConns = [];
        this.announcedPeers = new Set();
        // Signaling reconnect: true between connect() and disconnect(); failed
        // attempts and the pending retry timer per server URL.
        this._shouldConnect = false;
        this.signalingAttempts = new Map();
        this.signalingTimers = new Map();
        this._resetting = false; // handleResume(): removePeer() must not announce the old id
        if (!options.peer) {
            throw new Error('SimplePeerTransport requires the "peer" option. ' +
                'Please provide the simple-peer constructor: ' +
                'import Peer from "simple-peer"; new SimplePeerTransport({ peer: Peer, ... })');
        }
        // Default ICE servers (Google's public STUN server)
        const defaultIceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
        ];
        // Prepare peerOpts with ICE servers
        const peerOpts = { ...options.peerOpts };
        // Merge ICE servers into peerOpts.config
        if (options.iceServers || !peerOpts.config?.iceServers) {
            const iceServers = options.iceServers ?? defaultIceServers;
            peerOpts.config = {
                ...peerOpts.config,
                iceServers: iceServers,
            };
        }
        this.options = {
            peer: options.peer,
            signaling: options.signaling ?? ['wss://y-webrtc-eu.fly.dev'],
            password: options.password ?? '',
            maxConns: options.maxConns ?? 64,
            peerOpts,
            connectTimeout: options.connectTimeout ?? 30000,
            resumeAfterMs: options.resumeAfterMs ?? 15000,
            debug: options.debug ?? false,
        };
        // Generate unique peer ID
        this.peerId = this.generatePeerId();
        this.log(`Initialized — peerId: ${this.peerId}, maxConns: ${this.options.maxConns}`, `\n  signaling: [${this.options.signaling.join(', ')}]`, `\n  iceServers: [${(peerOpts.config?.iceServers ?? []).map((s) => (Array.isArray(s.urls) ? s.urls[0] : s.urls)).join(', ')}]`);
    }
    /**
     * Connect to the room via signaling servers and start discovering peers.
     */
    async connect(config) {
        if (this._connected) {
            throw new Error('Already connected');
        }
        this._room = config.room;
        this._shouldConnect = true;
        this.log(`🔌 Connecting to room "${config.room}" as ${this.peerId}`);
        // Try to connect to signaling servers
        // Use Promise.allSettled to allow partial success
        const results = await Promise.allSettled(this.options.signaling.map((url) => this.connectSignaling(url)));
        // Count successful connections
        const successCount = results.filter((r) => r.status === 'fulfilled').length;
        const failCount = results.filter((r) => r.status === 'rejected').length;
        if (successCount > 0) {
            this.log(`📡 Signaling: ${successCount}/${this.options.signaling.length} server(s) connected`);
        }
        else {
            console.warn('[SimplePeerTransport] ⚠️ No signaling servers reachable — WebRTC peer discovery disabled. ' +
                'Cross-tab sync via BroadcastChannel will still work.');
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.warn(`[SimplePeerTransport]   ✗ ${this.options.signaling[index]}:`, result.reason?.message ?? result.reason);
                }
            });
        }
        // Still mark as connected even if no signaling servers work
        // This allows BroadcastChannel-only mode for same-browser tabs
        this._connected = true;
        this.log(`✅ Connected to room "${this._room}" — ${this.signalingConns.length}/${this.options.signaling.length} signaling server(s)`);
        // Start periodic re-announce to help late joiners discover us
        this.announceInterval = setInterval(() => this.announce(), 5000);
        if (this.options.resumeAfterMs > 0) {
            this._stopResumeWatch = watchResume(this.options.resumeAfterMs, (sleptMs) => this.handleResume(sleptMs));
        }
    }
    /**
     * The page slept (see watchResume): every link is dead on the other side
     * or about to be, and the room holds dead entries under our peer id that
     * would swallow our announces until their ICE times out. Start over
     * under a new id - no entry anywhere matches it - and with fresh
     * signaling sockets (the old ones may be half-open); their onopen
     * subscribes and announces. GenericProvider resyncs each link as it
     * opens (onPeerConnect).
     */
    handleResume(sleptMs) {
        if (!this._connected)
            return;
        this.log(`⏰ Page slept ${sleptMs}ms — rebuilding all links under a new peer id`);
        this.peerId = this.generatePeerId();
        this._resetting = true;
        for (const id of Array.from(this.peers.keys()))
            this.removePeer(id);
        this._resetting = false;
        for (const ws of this.signalingConns.slice())
            ws.close();
    }
    /** Publish our peer id to the room on every open signaling connection. */
    announce() {
        if (this.peers.size >= this.options.maxConns)
            return;
        for (const ws of this.signalingConns) {
            this.sendSignaling(ws, {
                type: 'publish',
                topic: this._room,
                from: this.peerId,
            });
        }
    }
    /**
     * Disconnect from all peers and signaling servers.
     */
    disconnect() {
        this._shouldConnect = false;
        for (const timer of this.signalingTimers.values())
            clearTimeout(timer);
        this.signalingTimers.clear();
        this.signalingAttempts.clear();
        if (!this._connected)
            return;
        this.log(`🔌 Disconnecting — ${this.peers.size} peer(s), ${this.signalingConns.length} signaling server(s)`);
        this._stopResumeWatch?.();
        this._stopResumeWatch = undefined;
        // Stop re-announce interval
        if (this.announceInterval) {
            clearInterval(this.announceInterval);
            this.announceInterval = undefined;
        }
        // Close all peer connections
        for (const peerConn of this.peers.values()) {
            peerConn.peer.destroy();
        }
        this.peers.clear();
        // Close all signaling connections
        for (const ws of this.signalingConns) {
            ws.close();
        }
        this.signalingConns = [];
        this._connected = false;
        this.announcedPeers.clear();
    }
    /**
     * Send data to all connected peers.
     * Large messages are automatically chunked to fit within WebRTC DataChannel limits.
     */
    send(data) {
        if (!this._connected) {
            this.log('Not connected, cannot send');
            return;
        }
        // Encrypt if password is set
        const dataToSend = this.options.password
            ? this.encrypt(data, this.options.password)
            : data;
        // Send to all connected peers
        let sentCount = 0;
        for (const peerConn of this.peers.values()) {
            if (peerConn.connected) {
                try {
                    this.sendToPeer(peerConn, dataToSend);
                    sentCount++;
                }
                catch (error) {
                    this.log(`❌ Send failed to ${peerConn.peerId}:`, error.message);
                }
            }
        }
        // Only log when the picture is non-trivial (missing peers or no peers at all)
        if (sentCount === 0) {
            this.log(`⚠️ Send: 0 peers connected — ${data.length}B dropped`);
        }
        else if (sentCount < this.peers.size) {
            const skipped = this.peers.size - sentCount;
            this.log(`📤 Sent ${data.length}B to ${sentCount}/${this.peers.size} peer(s) — ${skipped} not yet connected`);
        }
    }
    /**
     * Send data to a single peer, chunking if necessary.
     * Uses flow control to avoid overwhelming the WebRTC buffer.
     */
    sendToPeer(peerConn, data) {
        // Small messages can be sent directly with type marker
        if (data.length <= CHUNK_SIZE - 1) {
            const msg = new Uint8Array(data.length + 1);
            msg[0] = MSG_TYPE_COMPLETE;
            msg.set(data, 1);
            peerConn.peer.send(msg);
            return;
        }
        // Large messages need chunking with flow control
        const messageId = messageIdCounter++;
        const totalChunks = Math.ceil(data.length / (CHUNK_SIZE - 13));
        this.log(`📦 Chunking ${data.length}B → ${totalChunks} chunks (msgId=${messageId})`);
        // Queue all chunks and send with backpressure handling
        const chunks = [];
        for (let i = 0; i < totalChunks; i++) {
            const start = i * (CHUNK_SIZE - 13);
            const end = Math.min(start + (CHUNK_SIZE - 13), data.length);
            const chunkData = data.slice(start, end);
            // Chunk header: [type:1][messageId:4][chunkIndex:4][totalChunks:4][data]
            const chunk = new Uint8Array(13 + chunkData.length);
            chunk[0] = MSG_TYPE_CHUNKED;
            new DataView(chunk.buffer).setUint32(1, messageId, true);
            new DataView(chunk.buffer).setUint32(5, i, true);
            new DataView(chunk.buffer).setUint32(9, totalChunks, true);
            chunk.set(chunkData, 13);
            chunks.push(chunk);
        }
        // Send chunks with flow control
        this.sendChunksWithFlowControl(peerConn, chunks);
    }
    /**
     * Send chunks with backpressure handling.
     * Waits for buffer to drain before sending more data.
     */
    sendChunksWithFlowControl(peerConn, chunks) {
        let index = 0;
        const peer = peerConn.peer;
        const sendNext = () => {
            while (index < chunks.length) {
                // Check if buffer is too full
                const channel = peer._channel;
                if (channel && channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                    // Wait for buffer to drain
                    this.log(`⏸️ Backpressure on ${peerConn.peerId}: buffered ${channel.bufferedAmount}B, waiting...`);
                    channel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT / 2;
                    channel.onbufferedamountlow = () => {
                        channel.onbufferedamountlow = null;
                        this.log(`▶️ Buffer drained on ${peerConn.peerId}, resuming chunks`);
                        sendNext();
                    };
                    return;
                }
                // Send next chunk
                try {
                    peer.send(chunks[index]);
                    index++;
                }
                catch (error) {
                    this.log('Error sending chunk:', index, error);
                    return;
                }
            }
        };
        sendNext();
    }
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback) {
        this._callback = callback;
        return () => {
            this._callback = undefined;
        };
    }
    /**
     * Transport.sendTo: deliver to one connected peer (the `from` id passed
     * to onMessage), chunked and flow-controlled like a broadcast send.
     */
    sendTo(peerId, data) {
        if (!this._connected)
            return;
        const peerConn = this.peers.get(peerId);
        if (!peerConn || !peerConn.connected)
            return;
        const dataToSend = this.options.password
            ? this.encrypt(data, this.options.password)
            : data;
        try {
            this.sendToPeer(peerConn, dataToSend);
        }
        catch (error) {
            this.log(`❌ sendTo failed for ${peerId}:`, error.message);
        }
    }
    /**
     * Register callback for new peer data-channel connections.
     */
    onPeerConnect(callback) {
        this._peerConnectCallback = callback;
        return () => {
            this._peerConnectCallback = undefined;
        };
    }
    /** Transport.onPeerDisconnect: a peer's channel closed or errored (removePeer). */
    onPeerDisconnect(callback) {
        this._peerDisconnectCallback = callback;
        return () => {
            this._peerDisconnectCallback = undefined;
        };
    }
    /**
     * Check if connected.
     */
    get isConnected() {
        return this._connected;
    }
    /**
     * Get number of connected peers (for debugging).
     */
    get connectedPeers() {
        return Array.from(this.peers.values()).filter((p) => p.connected).length;
    }
    /**
     * Connect to a signaling server.
     */
    async connectSignaling(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            let resolved = false;
            // Liveness, as lib0's WebsocketClient does it for y-webrtc: a ping
            // every 15 s, and a socket that has been silent for 30 s is closed -
            // a half-open socket (WiFi -> LTE, a suspended page) reports nothing
            // by itself. onclose then reconnects.
            let lastMessageAt = Date.now();
            let pingTimer;
            ws.onopen = () => {
                this.log(`🟢 Signaling connected: ${url}`);
                this.signalingAttempts.delete(url);
                lastMessageAt = Date.now();
                pingTimer = setInterval(() => {
                    if (Date.now() - lastMessageAt > 30000)
                        ws.close();
                    else
                        this.sendSignaling(ws, { type: 'ping' });
                }, 15000);
                // Subscribe to room
                this.sendSignaling(ws, {
                    type: 'subscribe',
                    topics: [this._room],
                });
                // Announce presence with topic (room) for y-webrtc protocol
                if (this.peers.size < this.options.maxConns) {
                    // y-webrtc uses 'publish' with from field
                    this.sendSignaling(ws, {
                        type: 'publish',
                        topic: this._room,
                        from: this.peerId,
                    });
                    // Also send announce for basic protocol compatibility
                    this.sendSignaling(ws, {
                        type: 'announce',
                        from: this.peerId,
                        topic: this._room,
                    });
                }
                this.signalingConns.push(ws);
                if (!resolved) {
                    resolved = true;
                    resolve();
                }
            };
            ws.onmessage = (event) => {
                lastMessageAt = Date.now();
                try {
                    const msg = JSON.parse(event.data);
                    // Only log signal-bearing messages to avoid flooding with pure topology pings
                    if (msg.signal || msg.type === 'announce') {
                        this.log(`📩 Signaling ‹${msg.type}›`, msg.from ? `from=${msg.from.slice(0, 8)}` : '', msg.to ? `to=${msg.to.slice(0, 8)}` : '', msg.signal ? `signal=${msg.signal.type ?? 'candidate'}` : '');
                    }
                    this.handleSignalingMessage(msg);
                }
                catch (error) {
                    this.log(`❌ Failed to parse signaling message: ${error.message}  raw=${event.data}`);
                }
            };
            ws.onerror = (error) => {
                this.log(`❌ Signaling error: ${url}`, error);
                if (!resolved) {
                    resolved = true;
                    reject(error);
                }
            };
            ws.onclose = () => {
                this.log(`🔴 Signaling disconnected: ${url}`);
                if (pingTimer)
                    clearInterval(pingTimer);
                const index = this.signalingConns.indexOf(ws);
                if (index > -1) {
                    this.signalingConns.splice(index, 1);
                }
                this.scheduleSignalingReconnect(url);
            };
            // Timeout after 10 seconds
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.log(`⏱️ Signaling connection timeout: ${url}`);
                    reject(new Error('Signaling connection timeout'));
                    ws.close(); // onclose schedules the next attempt
                }
            }, 10000);
        });
    }
    /**
     * Re-open a signaling connection that closed while we should be
     * connected - a phone's OS closes the socket of a backgrounded page, and
     * without it the transport can neither announce nor receive offers
     * (repro-simple-peer-sleep, part 3). Same curve as WebSocketTransport
     * (round 7, item 4): doubling from 1 s, +-50 % jitter, capped at 10 s.
     * onopen subscribes and announces again.
     */
    scheduleSignalingReconnect(url) {
        if (!this._shouldConnect || this.signalingTimers.has(url))
            return;
        const attempt = (this.signalingAttempts.get(url) ?? 0) + 1;
        this.signalingAttempts.set(url, attempt);
        const delay = Math.round(Math.min(10000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random()));
        this.log(`🔄 Signaling reconnect #${attempt} to ${url} in ${delay}ms`);
        this.signalingTimers.set(url, setTimeout(() => {
            this.signalingTimers.delete(url);
            if (this._shouldConnect)
                this.connectSignaling(url).catch(() => { });
        }, delay));
    }
    /**
     * Handle messages from signaling server.
     */
    handleSignalingMessage(msg) {
        // Skip messages from ourselves
        if (msg.from && msg.from === this.peerId)
            return;
        switch (msg.type) {
            case 'publish':
                // y-webrtc protocol: messages are published to topics
                // This is an envelope, the actual message could be an announce or signal
                if (msg.from) {
                    // Treat as announce if it's a publish from another peer
                    if (!this.peers.has(msg.from) &&
                        this.peers.size < this.options.maxConns &&
                        !this.announcedPeers.has(msg.from)) {
                        const shouldInitiate = this.peerId > msg.from;
                        this.log(`📡 Peer discovered via publish: ${msg.from} — role: ${shouldInitiate ? 'initiator' : 'non-initiator'}`, `(peers: ${this.peers.size + 1}/${this.options.maxConns})`);
                        this.announcedPeers.add(msg.from);
                        this.createPeerConnection(msg.from, shouldInitiate);
                        // If we're NOT the initiator, immediately re-announce so the initiator
                        // can discover us (they may have missed our initial publish)
                        if (!shouldInitiate) {
                            this.log('📢 Re-announcing so initiator can find us...');
                            this.announce();
                        }
                    }
                }
                // Handle embedded signal if present
                if (msg.signal && msg.from) {
                    if (!msg.to || msg.to === this.peerId) {
                        this.handlePeerSignal(msg.from, msg.signal);
                    }
                }
                break;
            case 'announce':
                if (!msg.from) {
                    this.log('Announce message missing from field');
                    return;
                }
                // Another peer announced - connect to them if we have capacity
                if (!this.peers.has(msg.from) &&
                    this.peers.size < this.options.maxConns &&
                    !this.announcedPeers.has(msg.from)) {
                    const shouldInitiate = this.peerId > msg.from;
                    this.log(`📡 Peer announced: ${msg.from} — role: ${shouldInitiate ? 'initiator' : 'non-initiator'}`, `(peers: ${this.peers.size + 1}/${this.options.maxConns})`);
                    this.announcedPeers.add(msg.from);
                    this.createPeerConnection(msg.from, shouldInitiate);
                }
                else if (this.peers.size >= this.options.maxConns) {
                    this.log(`⚠️ Peer limit reached (${this.options.maxConns}), ignoring announce from ${msg.from}`);
                }
                break;
            case 'signal':
                if (!msg.from) {
                    this.log('Signal message missing from field');
                    return;
                }
                // Received WebRTC signal from peer
                if (msg.to === this.peerId && msg.signal) {
                    this.handlePeerSignal(msg.from, msg.signal);
                }
                else if (!msg.to && msg.signal) {
                    // Signal without explicit target — handle anyway (some servers strip `to`)
                    this.handlePeerSignal(msg.from, msg.signal);
                }
                break;
            case 'pong':
                break; // liveness only, see connectSignaling()
            default:
                this.log(`❓ Unknown signaling message type: ${msg.type}`);
        }
    }
    /**
     * Send message to signaling server.
     */
    sendSignaling(ws, msg) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
    /**
     * Broadcast message to all signaling servers.
     */
    broadcastSignaling(msg) {
        for (const ws of this.signalingConns) {
            this.sendSignaling(ws, msg);
        }
    }
    /**
     * Create a WebRTC peer connection.
     */
    createPeerConnection(remotePeerId, initiator) {
        if (this.peers.has(remotePeerId)) {
            this.log(`⏭️ Peer connection already exists: ${remotePeerId}`);
            return;
        }
        this.log(`🤝 Creating ${initiator ? 'outbound (initiator)' : 'inbound (non-initiator)'} connection to ${remotePeerId}`);
        const peer = new this.options.peer({
            initiator,
            ...this.options.peerOpts,
        });
        const peerConn = {
            peer,
            connected: false,
            peerId: remotePeerId,
            chunkBuffers: new Map(),
        };
        this.peers.set(remotePeerId, peerConn);
        // An offer nobody answers produces no event at all - without this the
        // entry stayed for good and swallowed every later announce of that
        // peer (repro-simple-peer-sleep, part 5).
        const connectTimer = setTimeout(() => {
            if (!peerConn.connected && this.peers.get(remotePeerId) === peerConn) {
                this.log(`⏱️ No connection to ${remotePeerId} after ${this.options.connectTimeout}ms — dropping the entry`);
                this.removePeer(remotePeerId);
            }
        }, this.options.connectTimeout);
        peer.on('close', () => clearTimeout(connectTimer));
        // Handle signaling data (ICE candidates and SDP)
        peer.on('signal', (signal) => {
            this.log(`📤 Signal to ${remotePeerId}: ${signal.type ?? 'candidate'}`);
            // Send as 'publish' only — broadcasting as BOTH 'publish' and 'signal' causes the
            // receiving peer to apply the same SDP offer twice, which triggers a WebRTC error
            // and destroys the peer before it can fully connect.
            this.broadcastSignaling({
                type: 'publish',
                from: this.peerId,
                to: remotePeerId,
                signal,
                topic: this._room,
            });
        });
        // Mark channel open and notify provider — called by either 'connect' or the first
        // 'data' event, whichever fires first (WebRTC can deliver data before 'connect' on
        // some browsers, causing replies to be dropped if we wait for 'connect' only).
        const onChannelOpen = (via) => {
            if (peerConn.connected)
                return; // already fired
            peerConn.connected = true;
            clearTimeout(connectTimer);
            const connectedCount = Array.from(this.peers.values()).filter((p) => p.connected).length;
            this.log(`✅ Peer channel open (${via}): ${remotePeerId} — ${connectedCount}/${this.peers.size} peer(s) connected`);
            this._peerConnectCallback?.(remotePeerId);
        };
        // Handle connection
        peer.on('connect', () => onChannelOpen('connect'));
        // ICE state for debugging - through simple-peer's own event. Never assign
        // peer._pc.on*statechange: simple-peer wires the peer connection with
        // exactly those properties, and replacing them switched off its
        // failure detection (ICE 'failed' no longer closed the peer) and made
        // 'connect' depend on the order of the ICE and gathering events
        // (test/providers/repro-simple-peer-sleep.ts, parts 1-2).
        peer.on('iceStateChange', (ice, gathering) => {
            this.log(`🧊 ICE ${remotePeerId}: ${ice} (gathering: ${gathering})`);
        });
        // Handle incoming data
        peer.on('data', (data) => {
            // Data flowing proves the channel is open — handle the race where 'data' fires
            // before 'connect' (seen on Chrome when the remote initiator sends immediately).
            onChannelOpen('data');
            if (!this._callback)
                return;
            try {
                const uint8Data = new Uint8Array(data);
                if (uint8Data.length === 0)
                    return;
                const msgType = uint8Data[0];
                if (msgType === MSG_TYPE_COMPLETE) {
                    // Complete message, extract payload (skip type byte)
                    const payload = uint8Data.slice(1);
                    const decryptedData = this.options.password
                        ? this.decrypt(payload, this.options.password)
                        : payload;
                    this._callback(decryptedData, remotePeerId);
                }
                else if (msgType === MSG_TYPE_CHUNKED) {
                    // Chunked message - reassemble
                    const view = new DataView(uint8Data.buffer, uint8Data.byteOffset);
                    const messageId = view.getUint32(1, true);
                    const chunkIndex = view.getUint32(5, true);
                    const totalChunks = view.getUint32(9, true);
                    const chunkData = uint8Data.slice(13);
                    // Get or create buffer for this message
                    let buffer = peerConn.chunkBuffers.get(messageId);
                    if (!buffer) {
                        buffer = { chunks: new Map(), totalChunks };
                        peerConn.chunkBuffers.set(messageId, buffer);
                    }
                    // Store chunk
                    buffer.chunks.set(chunkIndex, chunkData);
                    // Check if complete
                    if (buffer.chunks.size === totalChunks) {
                        // Reassemble message
                        let totalLength = 0;
                        for (let i = 0; i < totalChunks; i++) {
                            totalLength += buffer.chunks.get(i).length;
                        }
                        const fullMessage = new Uint8Array(totalLength);
                        let offset = 0;
                        for (let i = 0; i < totalChunks; i++) {
                            const chunk = buffer.chunks.get(i);
                            fullMessage.set(chunk, offset);
                            offset += chunk.length;
                        }
                        // Clean up buffer
                        peerConn.chunkBuffers.delete(messageId);
                        // Decrypt and deliver
                        const decryptedData = this.options.password
                            ? this.decrypt(fullMessage, this.options.password)
                            : fullMessage;
                        this._callback(decryptedData, remotePeerId);
                        this.log(`📥 Reassembled ${totalLength}B from ${totalChunks} chunks (msgId=${messageId})`);
                    }
                }
                else {
                    // Unknown type or legacy message without type marker - try as raw data
                    const decryptedData = this.options.password
                        ? this.decrypt(uint8Data, this.options.password)
                        : uint8Data;
                    this._callback(decryptedData, remotePeerId);
                }
            }
            catch (error) {
                this.log('Error handling peer data:', error);
            }
        });
        // close/error arrive asynchronously: by then the entry under this id
        // may already be a newer link (handlePeerSignal() replaced it, or the
        // peer re-dialed after our announce) - only ever remove our own.
        const removeOwnEntry = () => {
            if (this.peers.get(remotePeerId) === peerConn)
                this.removePeer(remotePeerId);
        };
        // Handle errors
        peer.on('error', (error) => {
            this.log(`❌ Peer error [${remotePeerId}]: ${error.message ?? error}`);
            removeOwnEntry();
        });
        // Handle close
        peer.on('close', () => {
            const connectedCount = Array.from(this.peers.values()).filter((p) => p.connected && p.peerId !== remotePeerId).length;
            this.log(`🔴 Peer channel closed: ${remotePeerId} — ${connectedCount}/${this.peers.size - 1} remaining`);
            removeOwnEntry();
        });
    }
    /**
     * Handle WebRTC signal from peer.
     */
    handlePeerSignal(remotePeerId, signal) {
        let peerConn = this.peers.get(remotePeerId);
        // An offer for an entry that is already connected: the remote rebuilt
        // its side of the link (it lost us first) - this transport never
        // renegotiates. The old peer object would reject the offer (new DTLS
        // fingerprint) and lose it, leaving the remote's initiator half-open.
        if (peerConn?.connected && signal?.type === 'offer') {
            this.log(`♻️ Fresh offer from connected peer ${remotePeerId} — replacing the old link`);
            this.removePeer(remotePeerId);
            peerConn = undefined;
        }
        if (!peerConn) {
            this.log(`📶 Signal from unknown peer ${remotePeerId} (${signal?.type ?? 'candidate'}) — creating non-initiator connection`);
            this.createPeerConnection(remotePeerId, false);
            peerConn = this.peers.get(remotePeerId);
        }
        if (peerConn) {
            try {
                peerConn.peer.signal(signal);
            }
            catch (error) {
                this.log(`❌ Failed to apply signal from ${remotePeerId}: ${error.message}`);
            }
        }
        else {
            this.log(`❌ Could not create peer connection for signal from ${remotePeerId}`);
        }
    }
    /**
     * Remove and cleanup a peer connection.
     */
    removePeer(peerId) {
        const peerConn = this.peers.get(peerId);
        if (peerConn) {
            try {
                peerConn.peer.destroy();
            }
            catch (error) {
                // Ignore errors during cleanup
            }
            this.peers.delete(peerId);
            this.announcedPeers.delete(peerId);
            const connectedCount = Array.from(this.peers.values()).filter((p) => p.connected).length;
            this.log(`🗑️ Removed peer ${peerId} — ${connectedCount} connected / ${this.peers.size} total`);
            this._peerDisconnectCallback?.(peerId);
            // As y-webrtc does on a peer's close/error: announce at once, so a
            // peer that is still there re-dials within a signaling round trip
            // instead of the next 5 s tick.
            if (this._connected && !this._resetting)
                this.announce();
        }
    }
    /**
     * Generate a unique peer ID.
     */
    generatePeerId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }
    /**
     * Simple XOR encryption (not cryptographically secure, just obfuscation).
     */
    encrypt(data, password) {
        const key = this.hashPassword(password);
        const encrypted = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            encrypted[i] = data[i] ^ key[i % key.length];
        }
        return encrypted;
    }
    /**
     * Simple XOR decryption.
     */
    decrypt(data, password) {
        // XOR is symmetric, so decrypt is the same as encrypt
        return this.encrypt(data, password);
    }
    /**
     * Hash password to key.
     */
    hashPassword(password) {
        const encoder = new TextEncoder();
        return encoder.encode(password);
    }
    /**
     * Log debug messages if enabled.
     */
    log(...args) {
        if (this.options.debug) {
            console.log('[SimplePeerTransport]', ...args);
        }
    }
}
//# sourceMappingURL=index.js.map