/**
 * Trystero Transport Provider
 *
 * Serverless peer-to-peer transport using Trystero with multiple strategies.
 * Trystero uses decentralized infrastructure for peer discovery while keeping
 * all data transmission direct and end-to-end encrypted.
 *
 * Features:
 * - Zero server setup required
 * - Multiple strategies: Nostr, BitTorrent, MQTT, Supabase, Firebase, IPFS
 * - End-to-end encrypted P2P connections
 * - Automatic chunking and serialization
 * - Session encryption via AES-GCM
 * - Optional TURN server support
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { TrysteroTransport } from 'y-generic/providers/trystero'
 * import { joinRoom } from 'trystero/nostr' // or other strategy
 *
 * const doc = new Y.Doc()
 * const transport = new TrysteroTransport({
 *   joinRoom,
 *   appId: 'my-unique-app-id'
 * })
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 * ```
 */
/**
 * Trystero transport implementation.
 * Creates serverless P2P connections using Trystero library.
 */
export class TrysteroTransport {
    constructor(options) {
        this._connected = false;
        this._room = '';
        this.room = null;
        this.sendUpdate = null;
        this.peers = new Set();
        this.options = {
            debug: false,
            ...options,
        };
    }
    log(message, level = 'info') {
        if (this.options.debug) {
            const prefix = '[TrysteroTransport]';
            switch (level) {
                case 'error':
                    console.error(prefix, message);
                    break;
                case 'warn':
                    console.warn(prefix, message);
                    break;
                default:
                    console.log(prefix, message);
            }
        }
    }
    get isConnected() {
        return this._connected;
    }
    async connect(config) {
        if (this._connected) {
            this.log('Already connected, disconnecting first...');
            this.disconnect();
        }
        const room = config.room;
        if (!room) {
            throw new Error('Room ID is required');
        }
        this._room = room;
        this.log(`Connecting to room: ${room}`);
        // Build Trystero config
        const trysteroConfig = {
            appId: this.options.appId,
        };
        // Add optional config
        if (this.options.password)
            trysteroConfig.password = this.options.password;
        if (this.options.relayUrls)
            trysteroConfig.relayUrls = this.options.relayUrls;
        if (this.options.relayRedundancy)
            trysteroConfig.relayRedundancy = this.options.relayRedundancy;
        if (this.options.rtcConfig)
            trysteroConfig.rtcConfig = this.options.rtcConfig;
        if (this.options.turnConfig)
            trysteroConfig.turnConfig = this.options.turnConfig;
        if (this.options.rtcPolyfill)
            trysteroConfig.rtcPolyfill = this.options.rtcPolyfill;
        if (this.options.supabaseKey)
            trysteroConfig.supabaseKey = this.options.supabaseKey;
        if (this.options.firebaseApp)
            trysteroConfig.firebaseApp = this.options.firebaseApp;
        if (this.options.rootPath)
            trysteroConfig.rootPath = this.options.rootPath;
        if (this.options.manualRelayReconnection !== undefined) {
            trysteroConfig.manualRelayReconnection =
                this.options.manualRelayReconnection;
        }
        // Join room with error handler
        this.room = this.options.joinRoom(trysteroConfig, room, (details) => {
            this.log(`Join error: ${details.error}`, 'error');
            if (this.onJoinErrorCallback) {
                this.onJoinErrorCallback(details);
            }
        });
        // Create action for Yjs updates
        const [send, receive] = this.room.makeAction('yjs-update');
        this.sendUpdate = send;
        // Listen for incoming updates
        receive((data, peerId) => {
            this.log(`Received update from ${peerId} (${data.byteLength} bytes)`);
            if (this._callback) {
                // Convert ArrayBuffer to Uint8Array
                this._callback(new Uint8Array(data));
            }
        });
        // Track peers
        this.room.onPeerJoin((peerId) => {
            this.peers.add(peerId);
            this.log(`Peer joined: ${peerId} (${this.peers.size} total)`);
        });
        this.room.onPeerLeave((peerId) => {
            this.peers.delete(peerId);
            this.log(`Peer left: ${peerId} (${this.peers.size} remaining)`);
        });
        this._connected = true;
        this.log(`✅ Connected to room: ${room}`);
    }
    disconnect() {
        if (!this._connected) {
            return;
        }
        this.log('Disconnecting...');
        if (this.room) {
            this.room.leave();
            this.room = null;
        }
        this.sendUpdate = null;
        this._callback = undefined;
        this._connected = false;
        this.peers.clear();
        this.log('✅ Disconnected');
    }
    async send(data) {
        if (!this._connected || !this.sendUpdate) {
            this.log('⚠️ Not connected, cannot send', 'warn');
            return;
        }
        // Send to all peers (null = broadcast)
        this.log(`Sending update (${data.byteLength} bytes) to ${this.peers.size} peers`);
        await this.sendUpdate(data, null);
    }
    onMessage(callback) {
        this._callback = callback;
        this.log('Message callback registered');
        return () => {
            this._callback = undefined;
            this.log('Message callback unregistered');
        };
    }
    /**
     * Set a callback for join errors (optional).
     */
    onJoinError(callback) {
        this.onJoinErrorCallback = callback;
    }
    /**
     * Get the set of connected peer IDs.
     */
    getPeers() {
        return new Set(this.peers);
    }
    /**
     * Ping a peer and get round-trip time in ms.
     */
    async ping(peerId) {
        if (!this.room) {
            throw new Error('Not connected to a room');
        }
        return await this.room.ping(peerId);
    }
}
//# sourceMappingURL=index.js.map