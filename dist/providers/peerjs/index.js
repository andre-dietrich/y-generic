/**
 * PeerJS Transport Provider
 *
 * Peer-to-peer transport using WebRTC data channels with PeerJS library.
 * PeerJS provides a simpler API and built-in signaling infrastructure.
 *
 * Features:
 * - Direct peer-to-peer connections
 * - Built-in signaling servers (PeerJS Cloud)
 * - Automatic peer ID management
 * - Simple connection API
 * - Optional encryption
 * - Automatic reconnection
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { PeerJSTransport } from 'y-generic/providers/peerjs'
 * import Peer from 'peerjs'
 *
 * const doc = new Y.Doc()
 * const transport = new PeerJSTransport({
 *   peer: Peer, // Pass the PeerJS constructor
 *   password: 'optional-encryption-key'
 * })
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 * ```
 */
/**
 * PeerJS transport implementation.
 * Creates direct peer-to-peer connections using PeerJS library.
 */
export class PeerJSTransport {
    /**
     * Create a new PeerJS transport.
     *
     * @param options - Configuration options (must include peer constructor)
     */
    constructor(options) {
        this._connected = false;
        this._room = '';
        this.peer = null; // PeerJS Peer instance
        this.peerId = '';
        this.peers = new Map();
        this.knownPeers = new Set();
        // Cross-browser coordination
        this.isCoordinator = false;
        this.coordinatorPeerId = '';
        this.roomPeers = new Set(); // All peers in room (coordinator tracks this)
        this.reElectionInProgress = false; // Prevent duplicate re-elections
        if (!options.peer) {
            throw new Error('PeerJSTransport requires the "peer" option. ' +
                'Please provide the PeerJS constructor: ' +
                'import Peer from "peerjs"; new PeerJSTransport({ peer: Peer, ... })');
        }
        this.options = {
            peer: options.peer,
            peerOptions: options.peerOptions ?? {},
            password: options.password ?? '',
            maxConns: options.maxConns ?? 20 + Math.floor(Math.random() * 15),
            debug: options.debug ?? false,
        };
    }
    /**
     * Connect to the room and start discovering peers.
     */
    async connect(config) {
        if (this._connected) {
            throw new Error('Already connected');
        }
        this._room = config.room;
        // Deterministic coordinator ID for this room
        this.coordinatorPeerId = `yjs-coordinator-${this._room}`;
        // Attempting to join room
        // Strategy: Try to claim the coordinator ID first
        // If taken, we'll get an error and become a regular peer
        return new Promise((resolve, reject) => {
            try {
                // First, try to create ourselves as the coordinator
                // Attempting to claim coordinator ID
                let coordinatorAttempt = new this.options.peer(this.coordinatorPeerId, {
                    debug: this.options.debug ? 3 : 0,
                    ...this.options.peerOptions,
                });
                // Timeout in case PeerJS doesn't respond
                const coordinatorTimeout = setTimeout(() => {
                    // Coordinator claim timeout
                    coordinatorAttempt.destroy();
                    this.createRegularPeer(resolve, reject);
                    // Cross-browser discovery setup complete
                }, 3000);
                coordinatorAttempt.on('open', (id) => {
                    clearTimeout(coordinatorTimeout);
                    if (id === this.coordinatorPeerId) {
                        // Successfully claimed coordinator ID!
                        this.log('Coordinator: claimed ID');
                        this.peer = coordinatorAttempt;
                        this.peerId = id;
                        this.isCoordinator = true;
                        this.roomPeers.add(this.peerId);
                        this._connected = true;
                        // Setup peer discovery
                        this.setupPeerDiscovery();
                        // Listen for incoming connections
                        this.peer.on('connection', (conn) => {
                            this.handleIncomingConnection(conn);
                        });
                        resolve();
                    }
                });
                coordinatorAttempt.on('error', (error) => {
                    clearTimeout(coordinatorTimeout);
                    // Check if error is because ID is taken
                    if (error.message.includes('ID is taken') ||
                        error.message.includes('taken') ||
                        error.message.includes('already') ||
                        error.type === 'unavailable-id') {
                        // Coordinator already exists
                        coordinatorAttempt.destroy();
                        this.createRegularPeer(resolve, reject);
                    }
                    else {
                        this.log('❌ Unexpected error claiming coordinator:', error);
                        coordinatorAttempt.destroy();
                        this.createRegularPeer(resolve, reject);
                    }
                });
            }
            catch (error) {
                reject(error);
            }
        });
    }
    /**
     * Create a regular (non-coordinator) peer and connect to coordinator.
     */
    createRegularPeer(resolve, reject) {
        const peerIdSuffix = Math.random().toString(36).substring(7);
        this.peerId = `yjs-${this._room}-${peerIdSuffix}`;
        // Creating regular peer
        this.peer = new this.options.peer(this.peerId, {
            debug: this.options.debug ? 3 : 0,
            ...this.options.peerOptions,
        });
        this.peer.on('open', (id) => {
            this.peerId = id;
            this._connected = true;
            // Setup peer discovery via BroadcastChannel (same-browser tabs)
            this.setupPeerDiscovery();
            // Listen for incoming connections
            this.peer.on('connection', (conn) => {
                this.handleIncomingConnection(conn);
            });
            // Setup cross-browser discovery via coordinator pattern
            this.setupCrossBrowserDiscovery()
                .then(() => {
                // Cross-browser discovery setup complete
                resolve();
            })
                .catch((err) => {
                this.log('⚠️ Cross-browser discovery failed, continuing with BroadcastChannel only:', err);
                // Still resolve - BroadcastChannel will work for same-browser tabs
                resolve();
            });
        });
        this.peer.on('error', (error) => {
            this.log('Peer error:', error);
            if (!this._connected) {
                reject(error);
            }
        });
        this.peer.on('disconnected', () => {
            this.log('Peer disconnected, attempting reconnect...');
            // PeerJS will auto-reconnect
        });
    }
    /**
     * Disconnect from all peers and cleanup.
     */
    disconnect() {
        if (!this._connected)
            return;
        // Disconnecting
        // Clear discovery interval
        if (this.discoveryInterval) {
            clearInterval(this.discoveryInterval);
            this.discoveryInterval = undefined;
        }
        // Close BroadcastChannel
        if (this.broadcastChannel) {
            // Announce disconnection
            this.broadcastChannel.postMessage({
                type: 'leave',
                peerId: this.peerId,
            });
            this.broadcastChannel.close();
            this.broadcastChannel = undefined;
        }
        // Disconnect from coordinator if connected
        if (this.coordinatorConn) {
            try {
                this.sendCoordinationMessage(this.coordinatorConn, {
                    type: 'leave',
                    peerId: this.peerId,
                });
                this.coordinatorConn.close();
            }
            catch (err) {
                // Ignore errors during cleanup
            }
            this.coordinatorConn = undefined;
        }
        // If we're coordinator, notify all peers we're leaving
        if (this.isCoordinator) {
            for (const peerId of this.roomPeers) {
                if (peerId !== this.peerId) {
                    const peerConn = this.peers.get(peerId);
                    if (peerConn && peerConn.connected) {
                        try {
                            this.sendCoordinationMessage(peerConn.conn, {
                                type: 'coordinator-leaving',
                                peerId: this.peerId,
                            });
                        }
                        catch (err) {
                            // Ignore
                        }
                    }
                }
            }
            this.isCoordinator = false;
            this.roomPeers.clear();
        }
        // Close all peer connections
        for (const peerConn of this.peers.values()) {
            try {
                peerConn.conn.close();
            }
            catch (error) {
                // Ignore errors during cleanup
            }
        }
        this.peers.clear();
        this.knownPeers.clear();
        this.reElectionInProgress = false;
        // Destroy peer
        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }
        this._connected = false;
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
    /**
     * Send data to all connected peers.
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
                    peerConn.conn.send(dataToSend);
                    sentCount++;
                }
                catch (error) {
                    this.log('Error sending to peer:', peerConn.peerId, error);
                }
            }
        }
        // Sent to peers
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
     * Setup peer discovery using BroadcastChannel for same-browser tabs.
     */
    setupPeerDiscovery() {
        if (typeof BroadcastChannel === 'undefined') {
            this.log('❌ BroadcastChannel not available in this browser');
            return;
        }
        const channelName = `yjs-peerjs-${this._room}`;
        // Creating BroadcastChannel
        this.broadcastChannel = new BroadcastChannel(channelName);
        this.broadcastChannel.onmessage = (event) => {
            const msg = event.data;
            if (msg.peerId === this.peerId) {
                return; // Ignore own messages
            }
            if (msg.type === 'announce') {
                // Another peer announced
                // Discovered peer via BroadcastChannel
                this.knownPeers.add(msg.peerId);
                this.connectToPeer(msg.peerId);
            }
            else if (msg.type === 'leave') {
                // Peer left
                // Peer left
                this.knownPeers.delete(msg.peerId);
                this.removePeer(msg.peerId);
            }
        };
        // Announce presence
        this.announcePeer();
        // Periodic announcements for new peers that join later
        this.discoveryInterval = setInterval(() => {
            if (this._connected && this.peers.size < this.options.maxConns) {
                this.announcePeer();
            }
        }, 5000);
    }
    /**
     * Announce presence to other peers.
     */
    announcePeer() {
        if (this.broadcastChannel) {
            const message = {
                type: 'announce',
                peerId: this.peerId,
            };
            this.broadcastChannel.postMessage(message);
        }
    }
    /**
     * Setup cross-browser peer discovery by connecting to the coordinator.
     *
     * Note: This method is only called for regular (non-coordinator) peers.
     * The coordinator already exists because we failed to claim its ID.
     */
    async setupCrossBrowserDiscovery() {
        // Connecting to coordinator
        // Wait a bit for PeerJS server registration to complete
        await new Promise((resolve) => setTimeout(resolve, 500));
        return new Promise((resolve, reject) => {
            let connectionAttemptDone = false;
            // Set timeout for network issues
            const timeout = setTimeout(() => {
                if (!connectionAttemptDone) {
                    connectionAttemptDone = true;
                    const error = new Error('Timeout connecting to coordinator');
                    this.log('⏱️ Timeout connecting to coordinator');
                    reject(error);
                }
            }, 5000);
            try {
                // Connect to the coordinator (we know it exists)
                const conn = this.peer.connect(this.coordinatorPeerId, {
                    reliable: true,
                    serialization: 'binary',
                    metadata: { role: 'peer', peerId: this.peerId },
                });
                conn.on('open', () => {
                    if (connectionAttemptDone)
                        return;
                    connectionAttemptDone = true;
                    clearTimeout(timeout);
                    this.log('Connected to coordinator');
                    this.coordinatorConn = conn;
                    // IMPORTANT: Add coordinator to peers map for Yjs sync
                    const peerConn = {
                        conn,
                        connected: true,
                        peerId: this.coordinatorPeerId,
                    };
                    this.peers.set(this.coordinatorPeerId, peerConn);
                    this.knownPeers.add(this.coordinatorPeerId);
                    // Notify provider of the coordinator channel opening
                    this._peerConnectCallback?.(this.coordinatorPeerId);
                    // Request peer list from coordinator (send as JSON-encoded binary)
                    this.sendCoordinationMessage(conn, {
                        type: 'join',
                        peerId: this.peerId,
                    });
                    // Handle messages from coordinator
                    conn.on('data', (data) => {
                        // Try to decode as coordination message first
                        const uint8Data = data instanceof Uint8Array ? data : new Uint8Array(data);
                        const coordMessage = this.tryDecodeCoordinationMessage(uint8Data);
                        if (coordMessage) {
                            // Handle coordination messages
                            this.handleCoordinatorMessage(coordMessage);
                        }
                        else {
                            // It's Yjs sync data - process it
                            if (this._callback) {
                                try {
                                    // Decrypt if password is set
                                    const decryptedData = this.options.password
                                        ? this.decrypt(uint8Data, this.options.password)
                                        : uint8Data;
                                    this._callback(decryptedData);
                                }
                                catch (error) {
                                    this.log('Error handling coordinator data:', error);
                                }
                            }
                        }
                    });
                    conn.on('close', () => {
                        this.log('Coordinator disconnected');
                        this.peers.delete(this.coordinatorPeerId);
                        this.knownPeers.delete(this.coordinatorPeerId);
                        this.handleCoordinatorDisconnect();
                    });
                    resolve();
                });
                conn.on('error', (err) => {
                    if (connectionAttemptDone)
                        return;
                    connectionAttemptDone = true;
                    clearTimeout(timeout);
                    this.log('❌ Failed to connect to coordinator:', err.message);
                    reject(err);
                });
            }
            catch (err) {
                if (!connectionAttemptDone) {
                    connectionAttemptDone = true;
                    clearTimeout(timeout);
                    this.log('⚠️ Error connecting to coordinator:', err);
                    reject(err);
                }
            }
        });
    }
    /**
     * Become the coordinator for this room.
     */
    becomeCoordinator() {
        this.isCoordinator = true;
        this.roomPeers.add(this.peerId);
        this.log('👑 I am now the coordinator. Room peers:', Array.from(this.roomPeers));
        // Periodically check if we should still be coordinator (have lowest ID)
        setInterval(() => {
            if (this.isCoordinator) {
                const allPeerIds = Array.from(this.roomPeers).sort();
                if (allPeerIds.length > 0 && allPeerIds[0] !== this.peerId) {
                    this.log('⚠️ I am no longer the lowest ID peer, stepping down as coordinator');
                    this.isCoordinator = false;
                }
            }
        }, 10000);
    }
    /**
     * Handle messages from coordinator (when we're a regular peer).
     */
    handleCoordinatorMessage(data) {
        switch (data.type) {
            case 'peer-list':
                // Received list of all peers in room from coordinator
                // Received peer list
                for (const peerId of data.peers) {
                    if (peerId !== this.peerId && !this.peers.has(peerId)) {
                        this.knownPeers.add(peerId);
                        this.connectToPeer(peerId);
                    }
                }
                break;
            case 'peer-joined':
                // A new peer joined the room
                // New peer joined
                if (data.peerId !== this.peerId && !this.peers.has(data.peerId)) {
                    this.knownPeers.add(data.peerId);
                    this.connectToPeer(data.peerId);
                }
                break;
            case 'peer-left':
                // A peer left the room
                // Peer left
                this.knownPeers.delete(data.peerId);
                this.removePeer(data.peerId);
                break;
            case 'coordinator-change':
                // Coordinator changed
                // Coordinator changed
                this.coordinatorPeerId = data.coordinatorId;
                // We might need to reconnect to the new coordinator
                break;
            case 'coordinator-leaving':
                // Coordinator is leaving
                this.log('Coordinator leaving, re-election starting');
                this.handleCoordinatorDisconnect();
                break;
        }
    }
    /**
     * Handle coordinator disconnect - start re-election.
     */
    handleCoordinatorDisconnect() {
        // Prevent duplicate re-elections
        if (this.reElectionInProgress) {
            this.log('⏭️ Re-election already in progress, skipping');
            return;
        }
        // If we are currently offline the coordinator disconnected because WE lost
        // the network, not because the coordinator disappeared.  Any attempt to
        // create a new PeerJS peer will fail immediately with "Lost connection to
        // server".  Defer the whole re-election until we are back online.
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            this.log('📴 Offline – deferring re-election until network returns');
            const handler = () => {
                this.log('🌐 Network restored – resuming re-election');
                this.handleCoordinatorDisconnect();
            };
            window.addEventListener('online', handler, { once: true });
            return;
        }
        this.log('🗳️ Coordinator disconnected, starting re-election');
        this.reElectionInProgress = true;
        this.coordinatorConn = undefined;
        // Gather all known peer IDs
        const knownPeerIds = [
            this.peerId,
            ...Array.from(this.knownPeers),
            ...Array.from(this.peers.keys()),
        ].filter((id) => id !== this.coordinatorPeerId); // Exclude the old coordinator
        // Sort and pick lowest ID
        knownPeerIds.sort();
        const lowestId = knownPeerIds[0];
        this.log('🗳️ Coordinator election: Lowest peer ID is', lowestId);
        if (lowestId === this.peerId) {
            this.log('👑 I have the lowest ID, attempting to claim coordinator role');
            this.transitionToCoordinator();
        }
        else {
            // Waiting for new coordinator
            this.log('⏳ Waiting for new coordinator:', lowestId);
            // Wait a bit for the new coordinator to claim the ID, then try to connect
            setTimeout(() => {
                this.attemptCoordinatorConnection();
            }, 2000);
        }
    }
    /**
     * Attempt to connect to the coordinator.
     * If coordinator doesn't exist yet, retry a few times.
     */
    attemptCoordinatorConnection(retryCount = 0) {
        const maxRetries = 5;
        if (retryCount >= maxRetries) {
            this.log('❌ Failed to connect to coordinator after', maxRetries, 'attempts');
            // Try to become coordinator ourselves as fallback
            this.log('🔄 Attempting to become coordinator as fallback');
            this.transitionToCoordinator();
            return;
        }
        this.log(`🔌 Attempting to connect to coordinator (attempt ${retryCount + 1}/${maxRetries})`);
        this.setupCrossBrowserDiscovery()
            .then(() => {
            this.log('✅ Successfully connected to new coordinator');
            this.reElectionInProgress = false; // Re-election complete
        })
            .catch((err) => {
            this.log(`⚠️ Failed to connect to coordinator (attempt ${retryCount + 1}):`, err);
            // Retry with exponential backoff
            const delay = 1000 * Math.pow(1.5, retryCount);
            setTimeout(() => {
                this.attemptCoordinatorConnection(retryCount + 1);
            }, delay);
        });
    }
    /**
     * Transition from regular peer to coordinator by reconnecting with coordinator ID.
     */
    async transitionToCoordinator() {
        this.log('🔄 Transitioning to coordinator role...');
        // Save current state
        const currentConnections = Array.from(this.peers.entries());
        const callback = this._callback;
        const room = this._room;
        // Close current peer connection
        if (this.peer) {
            this.peer.destroy();
        }
        // Clear state but keep connections info
        this.peers.clear();
        this._connected = false;
        try {
            // Attempt to claim coordinator ID
            await new Promise((resolve, reject) => {
                const coordinatorPeer = new this.options.peer(this.coordinatorPeerId, {
                    debug: this.options.debug ? 3 : 0,
                    ...this.options.peerOptions,
                });
                const timeout = setTimeout(() => {
                    this.log('❌ Timeout claiming coordinator ID');
                    coordinatorPeer.destroy();
                    reject(new Error('Timeout claiming coordinator ID'));
                }, 5000);
                coordinatorPeer.on('open', (id) => {
                    clearTimeout(timeout);
                    if (id === this.coordinatorPeerId) {
                        this.log('✅ Successfully claimed coordinator ID:', id);
                        this.peer = coordinatorPeer;
                        this.peerId = id;
                        this.isCoordinator = true;
                        this.roomPeers.clear();
                        this.roomPeers.add(this.peerId);
                        this._connected = true;
                        this._callback = callback;
                        this.reElectionInProgress = false; // Re-election complete
                        // Setup peer discovery as coordinator
                        this.setupPeerDiscovery();
                        // Listen for incoming connections
                        this.peer.on('connection', (conn) => {
                            this.handleIncomingConnection(conn);
                        });
                        // Re-establish connections with known peers
                        this.log('🔗 Re-establishing connections with', currentConnections.length, 'known peers');
                        for (const [peerId, _] of currentConnections) {
                            if (peerId !== this.coordinatorPeerId) {
                                this.knownPeers.add(peerId);
                                this.roomPeers.add(peerId);
                            }
                        }
                        resolve();
                    }
                });
                coordinatorPeer.on('error', (error) => {
                    clearTimeout(timeout);
                    this.log('❌ Error claiming coordinator ID:', error);
                    coordinatorPeer.destroy();
                    reject(error);
                });
            });
        }
        catch (error) {
            this.log('❌ Failed to transition to coordinator:', error);
            this.reElectionInProgress = false; // Re-election failed
            // Fallback: recreate as regular peer and connect to whoever won the election
            this.log('🔄 Falling back to regular peer');
            this.reestablishAsRegularPeer();
        }
    }
    /**
     * Recreate the local peer with a fresh random ID and reconnect to the
     * coordinator (whoever won the election while we were transitioning).
     * Called when transitionToCoordinator() fails.
     */
    reestablishAsRegularPeer() {
        const peerIdSuffix = Math.random().toString(36).substring(7);
        this.peerId = `yjs-${this._room}-${peerIdSuffix}`;
        this.isCoordinator = false;
        this.peer = new this.options.peer(this.peerId, {
            debug: this.options.debug ? 3 : 0,
            ...this.options.peerOptions,
        });
        this.peer.on('open', (id) => {
            this.peerId = id;
            this._connected = true;
            this.log('✅ Reestablished as regular peer:', id);
            this.setupPeerDiscovery();
            this.peer.on('connection', (conn) => {
                this.handleIncomingConnection(conn);
            });
            this.peer.on('disconnected', () => {
                this.log('Peer disconnected, attempting reconnect...');
            });
            // Connect to whoever is now coordinator
            this.attemptCoordinatorConnection();
        });
        this.peer.on('error', (error) => {
            this.log('❌ Error reestablishing as regular peer:', error);
            // Destroy the dead peer object so we don't hold a stale reference
            try {
                this.peer?.destroy();
            }
            catch (_) { }
            this.peer = null;
            this._connected = false;
            // If the failure is due to being offline, wait for the network to return
            // and then try again from scratch.
            const retryOnline = () => {
                this.log('🌐 Network restored – retrying reestablish as regular peer');
                this.reestablishAsRegularPeer();
            };
            if (typeof navigator !== 'undefined' && !navigator.onLine) {
                window.addEventListener('online', retryOnline, { once: true });
            }
            else {
                // We appear online but still failed – back off briefly and retry
                setTimeout(retryOnline, 3000);
            }
        });
    }
    /**
     * Connect to a peer by ID.
     * To avoid race conditions, only the peer with the lower ID initiates the connection.
     */
    connectToPeer(remotePeerId) {
        if (remotePeerId === this.peerId) {
            // Skip self-connection
            return;
        }
        if (this.peers.has(remotePeerId)) {
            return;
        }
        if (this.peers.size >= this.options.maxConns) {
            // Max connections reached
            return;
        }
        // Only initiate if our peer ID is lower (to prevent dual-initiation race condition)
        if (this.peerId && this.peerId > remotePeerId) {
            // Waiting for peer to initiate
            return;
        }
        // Initiating connection
        try {
            const conn = this.peer.connect(remotePeerId, {
                reliable: true,
                serialization: 'binary',
            });
            if (!conn) {
                this.log('Failed to create connection object for:', remotePeerId);
                return;
            }
            // Connection object created
            this.setupConnection(conn, remotePeerId);
        }
        catch (error) {
            this.log('Error connecting to peer:', remotePeerId, error);
        }
    }
    /**
     * Handle incoming connection from another peer.
     */
    handleIncomingConnection(conn) {
        const remotePeerId = conn.peer;
        // Incoming connection
        if (this.peers.has(remotePeerId)) {
            // Already connected
            conn.close();
            return;
        }
        if (this.peers.size >= this.options.maxConns) {
            this.log('Max connections reached, rejecting peer:', remotePeerId);
            conn.close();
            return;
        }
        // If we're the coordinator, handle coordination duties
        if (this.isCoordinator) {
            // Add to room peers immediately
            this.roomPeers.add(remotePeerId);
            // Setup close handler to remove from room peers
            conn.on('close', () => {
                // Coordinator: peer left
                this.roomPeers.delete(remotePeerId);
                // Notify all other peers
                for (const peerId of this.roomPeers) {
                    if (peerId !== this.peerId) {
                        const peerConn = this.peers.get(peerId);
                        if (peerConn && peerConn.connected) {
                            try {
                                this.sendCoordinationMessage(peerConn.conn, {
                                    type: 'peer-left',
                                    peerId: remotePeerId,
                                });
                            }
                            catch (err) {
                                this.log('⚠️ Failed to notify peer of departure:', peerId);
                            }
                        }
                    }
                }
            });
        }
        // Setup the connection for Yjs sync (this handles all data including join messages)
        this.setupConnection(conn, remotePeerId);
    }
    /**
     * Setup a peer connection with event handlers.
     */
    setupConnection(conn, remotePeerId) {
        // Setting up connection
        const peerConn = {
            conn,
            connected: false,
            peerId: remotePeerId,
        };
        this.peers.set(remotePeerId, peerConn);
        conn.on('open', () => {
            peerConn.connected = true;
            this.knownPeers.add(remotePeerId);
            // Notify provider so it can push its local state to this new peer
            this._peerConnectCallback?.(remotePeerId);
        });
        conn.on('data', (data) => {
            // Convert to Uint8Array if needed
            const uint8Data = data instanceof Uint8Array ? data : new Uint8Array(data);
            // Try to decode as JSON coordination message
            const coordMessage = this.tryDecodeCoordinationMessage(uint8Data);
            if (coordMessage) {
                // Handle coordination messages
                if (coordMessage.type === 'coordinator-change' ||
                    coordMessage.type === 'coordinator-leaving' ||
                    coordMessage.type === 'peer-joined' ||
                    coordMessage.type === 'peer-left' ||
                    coordMessage.type === 'peer-list') {
                    this.handleCoordinatorMessage(coordMessage);
                    return;
                }
                else if (coordMessage.type === 'join' && this.isCoordinator) {
                    // Handle join message if we're the coordinator
                    // Coordinator: peer joined
                    // Send current peer list (excluding coordinator and the new peer)
                    const peerList = Array.from(this.roomPeers).filter((id) => id !== this.peerId && id !== remotePeerId);
                    this.sendCoordinationMessage(conn, {
                        type: 'peer-list',
                        peers: peerList,
                    });
                    // Notify all other peers about the new peer
                    for (const peerId of this.roomPeers) {
                        if (peerId !== this.peerId && peerId !== remotePeerId) {
                            const peerConn = this.peers.get(peerId);
                            if (peerConn && peerConn.connected) {
                                try {
                                    this.sendCoordinationMessage(peerConn.conn, {
                                        type: 'peer-joined',
                                        peerId: remotePeerId,
                                    });
                                }
                                catch (err) {
                                    this.log('⚠️ Failed to notify peer of new joiner:', peerId);
                                }
                            }
                        }
                    }
                    return;
                }
            }
            // Otherwise, it's Yjs sync data
            if (this._callback) {
                try {
                    // Decrypt if password is set
                    const decryptedData = this.options.password
                        ? this.decrypt(uint8Data, this.options.password)
                        : uint8Data;
                    this._callback(decryptedData);
                }
                catch (error) {
                    this.log('Error handling peer data:', error);
                }
            }
        });
        conn.on('close', () => {
            this.removePeer(remotePeerId);
        });
        conn.on('error', (error) => {
            this.log('⚠️ Connection error:', remotePeerId, error);
            this.removePeer(remotePeerId);
        });
        // Log connection state after a delay to debug
        setTimeout(() => { }, 1000);
    }
    /**
     * Remove and cleanup a peer connection.
     */
    removePeer(peerId) {
        const peerConn = this.peers.get(peerId);
        if (peerConn) {
            try {
                peerConn.conn.close();
            }
            catch (error) {
                // Ignore errors during cleanup
            }
            this.peers.delete(peerId);
        }
    }
    /**
     * Send a coordination message (JSON encoded as binary).
     */
    sendCoordinationMessage(conn, message) {
        try {
            const jsonStr = JSON.stringify(message);
            const encoder = new TextEncoder();
            const encoded = encoder.encode(jsonStr);
            conn.send(encoded);
        }
        catch (error) {
            this.log('Error encoding coordination message:', error);
        }
    }
    /**
     * Try to decode data as a coordination message.
     * Returns the parsed message if successful, null otherwise.
     */
    tryDecodeCoordinationMessage(data) {
        try {
            const decoder = new TextDecoder();
            const jsonStr = decoder.decode(data);
            const parsed = JSON.parse(jsonStr);
            // Check if it looks like a coordination message (has a type field)
            if (parsed &&
                typeof parsed === 'object' &&
                parsed.type &&
                typeof parsed.type === 'string') {
                return parsed;
            }
            return null;
        }
        catch (error) {
            // Not JSON, must be Yjs data
            return null;
        }
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
            console.log('[PeerJSTransport]', ...args);
        }
    }
}
//# sourceMappingURL=index.js.map