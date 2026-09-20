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
import { watchResume } from '../resume';
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
        this._joinedSockets = new Map(); // relay sockets our subscriptions live on
        this._rejoining = false;
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
        this.joinTrysteroRoom();
        this._connected = true;
        this.log(`✅ Connected to room: ${room}`);
        if (this.options.getRelaySockets) {
            this._socketWatch = setInterval(() => this.checkRelaySockets(), 2000);
        }
        else if ((this.options.resumeAfterMs ?? 30000) > 0) {
            this._stopResumeWatch = watchResume(this.options.resumeAfterMs ?? 30000, () => {
                setTimeout(() => this.rejoin('the page slept'), 5000);
            });
        }
    }
    /** Join the Trystero room and wire it up - at connect() and again at every rejoin(). */
    joinTrysteroRoom() {
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
        const joined = this.options.joinRoom(trysteroConfig, this._room, (details) => {
            this.log(`Join error: ${details.error}`, 'error');
            if (this.onJoinErrorCallback) {
                this.onJoinErrorCallback(details);
            }
        });
        this.room = joined;
        // Create action for Yjs updates
        const [send, receive] = joined.makeAction('yjs-update');
        this.sendUpdate = send;
        // Listen for incoming updates
        receive((data, peerId) => {
            this._stopResumeWatch?.alive(); // see watchResume: a page that handles this has not slept
            this.log(`Received update from ${peerId} (${data.byteLength} bytes)`);
            if (joined !== this.room)
                return; // a room we already left (rejoin)
            if (this._callback) {
                // Convert ArrayBuffer to Uint8Array; peerId lets GenericProvider
                // answer this peer directly via sendTo()
                this._callback(new Uint8Array(data), peerId);
            }
        });
        // Track peers
        joined.onPeerJoin((peerId) => {
            if (joined !== this.room)
                return;
            this.peers.add(peerId);
            this.log(`Peer joined: ${peerId} (${this.peers.size} total)`);
            this._peerConnectCallback?.(peerId);
        });
        joined.onPeerLeave((peerId) => {
            if (joined !== this.room || !this.peers.has(peerId))
                return;
            this.peers.delete(peerId);
            this.log(`Peer left: ${peerId} (${this.peers.size} remaining)`);
            this._peerDisconnectCallback?.(peerId);
        });
        this._joinedSockets = new Map(Object.entries(this.options.getRelaySockets?.() ?? {}));
    }
    /**
     * Leave and join again: the only way to make Trystero subscribe again on
     * relay sockets it re-opened (see the getRelaySockets option). Our links
     * go with the room; GenericProvider resyncs each one as it comes back.
     */
    async rejoin(reason) {
        if (this._rejoining || !this._connected)
            return;
        this._rejoining = true;
        this.log(`♻️ Re-joining the room: ${reason}`);
        try {
            const old = this.room;
            this.room = null;
            this.sendUpdate = null;
            for (const peerId of Array.from(this.peers)) {
                this.peers.delete(peerId);
                this._peerDisconnectCallback?.(peerId);
            }
            // leave() resolves once Trystero has dropped the room from its cache;
            // joinRoom() before that hands back the room we are leaving.
            if (old)
                await Promise.resolve(old.leave());
            if (this._connected)
                this.joinTrysteroRoom();
        }
        finally {
            this._rejoining = false;
        }
    }
    /** None of the relay sockets we joined with is left open, and a re-opened one is: re-join on it. */
    checkRelaySockets() {
        const sockets = this.options.getRelaySockets?.() ?? {};
        const current = Object.entries(sockets);
        if (current.length === 0)
            return;
        const intact = current.some(([url, ws]) => this._joinedSockets.get(url) === ws && ws.readyState === 1);
        if (!intact && current.some(([, ws]) => ws.readyState === 1)) {
            this.rejoin('no relay socket with our subscriptions is left');
        }
    }
    disconnect() {
        if (!this._connected) {
            return;
        }
        this.log('Disconnecting...');
        if (this._socketWatch)
            clearInterval(this._socketWatch);
        this._socketWatch = undefined;
        this._stopResumeWatch?.();
        this._stopResumeWatch = undefined;
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
        // One send per peer, not Trystero's broadcast (target null): that one is
        // a Promise.all over the peers - it rejects as a whole and does not say
        // for whom, and we have to know (see dropUnsendable).
        this.log(`Sending update (${data.byteLength} bytes) to ${this.peers.size} peers`);
        const send = this.sendUpdate;
        await Promise.all(Array.from(this.peers).map((peerId) => send(data, peerId).catch((error) => this.dropUnsendable(peerId, error))));
    }
    /**
     * A send to this peer rejected: close its RTCPeerConnection. Trystero
     * calls channel.send() without a net, the rejection was all that happened,
     * and the link stayed - one-way, for good. Chrome can leave an
     * RTCDataChannel object at readyState 'connecting' after its own 'open'
     * event (the answering side of a link, a busy machine, about once per
     * 50-peer join): it receives, and every send() throws. With 35 real
     * browsers one peer held nothing of another - no presence, no address -
     * although both counted the link (test/e2e/room-scenarios.mjs, DIAG=1; the
     * `oneway` scenario makes the condition on purpose;
     * test/providers/repro-trystero-oneway.ts). With the connection closed
     * Trystero reports the peer gone on both sides and dials it again at its
     * next announce. A peer that is leaving anyway loses nothing by it.
     */
    dropUnsendable(peerId, error) {
        this.log(`♻️ Cannot send to ${peerId} (${error?.message ?? error}) — closing its connection so Trystero dials again`, 'warn');
        try {
            this.room?.getPeers()[peerId]?.close();
        }
        catch {
            // already gone
        }
    }
    /**
     * Transport.sendTo: deliver to one peer (Trystero's action send accepts
     * a target peer id). Used by GenericProvider for replies, acks and
     * presence responses.
     */
    async sendTo(peerId, data) {
        if (!this._connected || !this.sendUpdate)
            return;
        if (!this.peers.has(peerId))
            return;
        try {
            await this.sendUpdate(data, peerId);
        }
        catch (error) {
            this.dropUnsendable(peerId, error);
        }
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
     * Register callback for new peer data-channel connections. Lets
     * GenericProvider push our current doc/awareness state to a peer as
     * soon as their channel opens, instead of only at our own connect()
     * time (which fires before any mesh connection exists) or the next
     * periodic sync tick.
     */
    onPeerConnect(callback) {
        this._peerConnectCallback = callback;
        return () => {
            this._peerConnectCallback = undefined;
        };
    }
    /** Transport.onPeerDisconnect: Trystero's onPeerLeave, the same peer id. */
    onPeerDisconnect(callback) {
        this._peerDisconnectCallback = callback;
        return () => {
            this._peerDisconnectCallback = undefined;
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