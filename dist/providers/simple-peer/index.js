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
 * - 0x02: Consumer control frame — per-peer side-channel via sendControl()/
 *   onControlFrame(), never reaches the provider pipe. Not chunked/encrypted.
 */
const MSG_TYPE_COMPLETE = 0x00;
const MSG_TYPE_CHUNKED = 0x01;
const MSG_TYPE_CONTROL = 0x02;
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
        this._peerConnectCallbacks = new Set();
        this._peerDisconnectCallbacks = new Set();
        this._controlCallbacks = new Set();
        this.peers = new Map();
        this.signalingConns = [];
        this.announcedPeers = new Set();
        // Signaling reconnect state, per URL: consecutive failures (for backoff) and
        // the pending retry timer (so disconnect() can cancel it).
        this._reconnectAttempts = new Map();
        this._reconnectTimers = new Map();
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
            signaling: options.signaling ?? ['wss://signaling.yjs.dev'],
            password: options.password ?? '',
            maxConns: options.maxConns ?? 20 + Math.floor(Math.random() * 15),
            peerOpts,
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
        // Start periodic re-subscribe + re-announce to help late joiners discover us.
        // Deliberately NOT gated on `peers.size < maxConns`: a full mesh must keep
        // advertising, or peers that later drop out can never rediscover us.
        this.announceInterval = setInterval(() => {
            if (this.signalingConns.length === 0)
                return;
            this.log('Re-announcing presence...');
            for (const ws of this.signalingConns) {
                // Re-subscribe every tick: a signaling server can silently drop a
                // subscription while the socket stays open (ping/pong alive), which
                // makes us invisible to newcomers with no other symptom. `subscribe`
                // is otherwise only sent once, in onopen.
                this.sendSignaling(ws, {
                    type: 'subscribe',
                    topics: [this._room],
                });
                this.sendSignaling(ws, {
                    type: 'publish',
                    topic: this._room,
                    from: this.peerId,
                });
            }
        }, 5000); // Re-announce every 5 seconds for better peer discovery
    }
    /**
     * Disconnect from all peers and signaling servers.
     */
    disconnect() {
        if (!this._connected)
            return;
        this.log(`🔌 Disconnecting — ${this.peers.size} peer(s), ${this.signalingConns.length} signaling server(s)`);
        // Clear BEFORE closing sockets: ws.close() fires onclose asynchronously,
        // and scheduleSignalingReconnect() keys off this flag to tell a deliberate
        // disconnect from a dropped connection.
        this._connected = false;
        // Stop re-announce interval
        if (this.announceInterval) {
            clearInterval(this.announceInterval);
            this.announceInterval = undefined;
        }
        // Cancel any pending signaling reconnects
        for (const timer of this._reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this._reconnectTimers.clear();
        this._reconnectAttempts.clear();
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
     * Send data to a single connected peer by ID (targeted delivery).
     */
    sendTo(peerId, data) {
        if (!this._connected) {
            this.log('Not connected, cannot sendTo');
            return;
        }
        const peerConn = this.peers.get(peerId);
        if (!peerConn || !peerConn.connected) {
            this.log(`⚠️ sendTo: peer ${peerId} not connected — ${data.length}B dropped`);
            return;
        }
        const dataToSend = this.options.password
            ? this.encrypt(data, this.options.password)
            : data;
        try {
            this.sendToPeer(peerConn, dataToSend);
        }
        catch (error) {
            this.log(`❌ sendTo failed to ${peerId}:`, error.message);
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
     * Register callback for new peer data-channel connections.
     */
    onPeerConnect(callback) {
        this._peerConnectCallbacks.add(callback);
        return () => {
            this._peerConnectCallbacks.delete(callback);
        };
    }
    /**
     * Register callback for peer disconnects (channel close or error). Only fires
     * for peers that had reached the connected state.
     */
    onPeerDisconnect(callback) {
        this._peerDisconnectCallbacks.add(callback);
        return () => {
            this._peerDisconnectCallbacks.delete(callback);
        };
    }
    /**
     * Register callback for consumer control frames (MSG_TYPE_CONTROL).
     * These bypass the provider pipe — use for per-peer handshakes/auth.
     */
    onControlFrame(callback) {
        this._controlCallbacks.add(callback);
        return () => {
            this._controlCallbacks.delete(callback);
        };
    }
    /**
     * Tear down a single peer connection (e.g. to reject a peer that failed an
     * out-of-band handshake). Fires onPeerDisconnect if the peer was connected.
     */
    disconnectPeer(peerId) {
        this.removePeer(peerId);
    }
    /**
     * Send a control frame to a single peer. Not chunked or encrypted — keep
     * payloads small (they must fit one DataChannel message).
     */
    sendControl(peerId, payload) {
        const peerConn = this.peers.get(peerId);
        if (!peerConn || !peerConn.connected) {
            this.log(`⚠️ sendControl: peer ${peerId} not connected — dropped`);
            return;
        }
        const msg = new Uint8Array(payload.length + 1);
        msg[0] = MSG_TYPE_CONTROL;
        msg.set(payload, 1);
        try {
            peerConn.peer.send(msg);
        }
        catch (error) {
            this.log(`❌ sendControl failed to ${peerId}:`, error.message);
        }
    }
    /**
     * Check if connected.
     *
     * NOTE: this is a lifecycle flag (connect() called, disconnect() not yet), not
     * a health check — it stays true with zero signaling servers, which is what
     * makes BroadcastChannel-only mode work. For "can we still discover peers?"
     * use `signalingHealth`.
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
     * Signaling/discovery health, for diagnostics and monitoring.
     *
     * `isConnected` deliberately cannot express this: a transport whose signaling
     * sockets have all dropped still reports connected, and peer discovery is
     * silently dead until they come back.
     */
    get signalingHealth() {
        return {
            open: this.signalingConns.filter((ws) => ws.readyState === 1).length,
            configured: this.options.signaling.length,
            reconnecting: this._reconnectTimers.size,
            peers: this.peers.size,
            connectedPeers: this.connectedPeers,
        };
    }
    /**
     * Reconnect to a signaling server after it drops, with exponential backoff.
     *
     * Mirrors lib0's WebsocketClient (what y-webrtc gets for free): delay grows
     * as log10(attempts + 1) * 1200ms, capped at 30s. No-ops after an explicit
     * disconnect(), and never stacks duplicate timers for the same URL.
     */
    scheduleSignalingReconnect(url) {
        if (!this._connected)
            return; // deliberate disconnect(), not a drop
        if (this._reconnectTimers.has(url))
            return; // retry already pending
        const attempts = (this._reconnectAttempts.get(url) ?? 0) + 1;
        this._reconnectAttempts.set(url, attempts);
        const delay = Math.min(Math.log10(attempts + 1) * 1200, 30000);
        this.log(`🔄 Signaling reconnect #${attempts} for ${url} in ${Math.round(delay)}ms`);
        this._reconnectTimers.set(url, setTimeout(() => {
            this._reconnectTimers.delete(url);
            if (!this._connected)
                return;
            this.connectSignaling(url).catch(() => {
                // connectSignaling rejects on error/timeout; onclose schedules the
                // next attempt, so swallow here to avoid an unhandled rejection.
            });
        }, delay));
    }
    /**
     * Connect to a signaling server.
     */
    async connectSignaling(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            let resolved = false;
            ws.onopen = () => {
                this.log(`🟢 Signaling connected: ${url}`);
                // Reached a good state — restart backoff from zero for the next drop.
                this._reconnectAttempts.delete(url);
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
                const index = this.signalingConns.indexOf(ws);
                if (index > -1) {
                    this.signalingConns.splice(index, 1);
                }
                // Without this, a single socket drop is terminal: the re-announce loop
                // is gated on `signalingConns.length > 0`, so peer discovery stops
                // forever while `isConnected` still reports true.
                this.scheduleSignalingReconnect(url);
                if (!resolved) {
                    // Closed before ever opening — settle connect()'s promise so
                    // Promise.allSettled() in connect() isn't left hanging.
                    resolved = true;
                    reject(new Error(`Signaling closed before open: ${url}`));
                }
            };
            // Timeout after 10 seconds
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.log(`⏱️ Signaling connection timeout: ${url}`);
                    reject(new Error('Signaling connection timeout'));
                }
            }, 10000);
        });
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
                    this.pruneStalePeer(msg.from);
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
                            for (const ws of this.signalingConns) {
                                this.sendSignaling(ws, {
                                    type: 'publish',
                                    topic: this._room,
                                    from: this.peerId,
                                });
                            }
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
                this.pruneStalePeer(msg.from);
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
            const connectedCount = Array.from(this.peers.values()).filter((p) => p.connected).length;
            this.log(`✅ Peer channel open (${via}): ${remotePeerId} — ${connectedCount}/${this.peers.size} peer(s) connected`);
            for (const cb of this._peerConnectCallbacks)
                cb(remotePeerId);
        };
        // Handle connection
        peer.on('connect', () => onChannelOpen('connect'));
        // Handle ICE connection state for debugging
        if (peer._pc) {
            peer._pc.oniceconnectionstatechange = () => {
                this.log(`🧊 ICE ${remotePeerId}: ${peer._pc.iceConnectionState}`);
            };
            peer._pc.onconnectionstatechange = () => {
                this.log(`🔗 Connection ${remotePeerId}: ${peer._pc.connectionState}`);
            };
        }
        // Handle incoming data
        peer.on('data', (data) => {
            // Data flowing proves the channel is open — handle the race where 'data' fires
            // before 'connect' (seen on Chrome when the remote initiator sends immediately).
            onChannelOpen('data');
            let uint8Data;
            try {
                uint8Data = new Uint8Array(data);
            }
            catch (error) {
                this.log('Error handling peer data:', error);
                return;
            }
            if (uint8Data.length === 0)
                return;
            // Control frames bypass the provider pipe (identity/auth handshakes etc.)
            if (uint8Data[0] === MSG_TYPE_CONTROL) {
                const payload = uint8Data.slice(1);
                for (const cb of this._controlCallbacks)
                    cb(remotePeerId, payload);
                return;
            }
            if (!this._callback)
                return;
            try {
                const msgType = uint8Data[0];
                if (msgType === MSG_TYPE_COMPLETE) {
                    // Complete message, extract payload (skip type byte)
                    const payload = uint8Data.slice(1);
                    const decryptedData = this.options.password
                        ? this.decrypt(payload, this.options.password)
                        : payload;
                    this._callback(decryptedData);
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
                        this._callback(decryptedData);
                        this.log(`📥 Reassembled ${totalLength}B from ${totalChunks} chunks (msgId=${messageId})`);
                    }
                }
                else {
                    // Unknown type or legacy message without type marker - try as raw data
                    const decryptedData = this.options.password
                        ? this.decrypt(uint8Data, this.options.password)
                        : uint8Data;
                    this._callback(decryptedData);
                }
            }
            catch (error) {
                this.log('Error handling peer data:', error);
            }
        });
        // Handle errors
        peer.on('error', (error) => {
            this.log(`❌ Peer error [${remotePeerId}]: ${error.message ?? error}`);
            this.removePeer(remotePeerId);
        });
        // Handle close
        peer.on('close', () => {
            const connectedCount = Array.from(this.peers.values()).filter((p) => p.connected && p.peerId !== remotePeerId).length;
            this.log(`🔴 Peer channel closed: ${remotePeerId} — ${connectedCount}/${this.peers.size - 1} remaining`);
            this.removePeer(remotePeerId);
        });
    }
    /**
     * Handle WebRTC signal from peer.
     */
    handlePeerSignal(remotePeerId, signal) {
        let peerConn = this.peers.get(remotePeerId);
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
    // Forget a peer we announced but hold no live connection to, so its next
    // re-announce can reconnect instead of being deduped forever (ghost peer).
    pruneStalePeer(peerId) {
        if (this.announcedPeers.has(peerId) && !this.peers.has(peerId)) {
            this.announcedPeers.delete(peerId);
        }
    }
    /**
     * Remove and cleanup a peer connection.
     */
    removePeer(peerId) {
        const peerConn = this.peers.get(peerId);
        if (peerConn) {
            const wasConnected = peerConn.connected;
            try {
                peerConn.peer.destroy();
            }
            catch (error) {
                // Ignore errors during cleanup
            }
            this.peers.delete(peerId);
            this.announcedPeers.delete(peerId);
            if (wasConnected)
                for (const cb of this._peerDisconnectCallbacks)
                    cb(peerId);
            const connectedCount = Array.from(this.peers.values()).filter((p) => p.connected).length;
            this.log(`🗑️ Removed peer ${peerId} — ${connectedCount} connected / ${this.peers.size} total`);
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