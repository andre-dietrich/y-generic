/**
 * Dummy Transport for Testing
 *
 * A simple in-memory transport that simulates network behavior without
 * any external dependencies. Perfect for:
 * - Unit testing
 * - Learning how transports work
 * - Local development without a server
 * - Reference implementation for custom transports
 *
 * Features:
 * - Simulated network latency
 * - Simulated packet loss
 * - Connect multiple clients in-memory
 * - No external dependencies
 * - Auto-managed hubs (just works!)
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { DummyTransport } from 'y-generic/providers/dummy'
 *
 * // Simple usage - hub is auto-managed
 * const doc1 = new Y.Doc()
 * const provider1 = new GenericProvider(doc1, new DummyTransport())
 * await provider1.connect({ room: 'test-room' })
 *
 * const doc2 = new Y.Doc()
 * const provider2 = new GenericProvider(doc2, new DummyTransport())
 * await provider2.connect({ room: 'test-room' })
 *
 * // Changes sync automatically!
 * doc1.getText('test').insert(0, 'Hello')
 * // doc2 receives the update
 * ```
 *
 * @example
 * ```typescript
 * // Advanced: Explicit hub for fine control
 * import { DummyHub } from 'y-generic/providers/dummy'
 *
 * const hub = new DummyHub()
 * const transport1 = new DummyTransport({ hub })
 * const transport2 = new DummyTransport({ hub })
 * ```
 */
/**
 * Central hub that routes messages between DummyTransport instances.
 * Simulates a server or message broker.
 */
export class DummyHub {
    constructor() {
        this.rooms = new Map();
        this.peerConnectSubs = new Map();
    }
    /**
     * Register a transport in a room.
     */
    join(room, transport, callback) {
        if (!this.rooms.has(room)) {
            this.rooms.set(room, new Set());
        }
        this.rooms.get(room).add({ transport, callback });
    }
    /**
     * Unregister a transport from a room.
     */
    leave(room, transport) {
        const clients = this.rooms.get(room);
        if (clients) {
            for (const client of clients) {
                if (client.transport === transport) {
                    clients.delete(client);
                    break;
                }
            }
            if (clients.size === 0) {
                this.rooms.delete(room);
            }
        }
    }
    /**
     * Register a transport's onPeerConnect callback and simulate the
     * peer-discovery notifications a real mesh transport (peerjs,
     * simple-peer) would fire: every OTHER already-registered transport in
     * the room is notified about this new one, and this new transport is
     * notified about every other one already registered - mirrors each side
     * of a newly-opened data channel firing its own onPeerConnect. Test-only
     * simulation: DummyTransport has no real peer-to-peer channels, this
     * exists purely so GenericProvider's onPeerConnect handling (mesh-join
     * burst coalescing) is exercisable via DummyTransport in benchmarks.
     */
    registerPeerConnect(room, transport, callback) {
        if (!this.peerConnectSubs.has(room)) {
            this.peerConnectSubs.set(room, new Set());
        }
        const subs = this.peerConnectSubs.get(room);
        const entry = { transport, callback };
        subs.add(entry);
        for (const other of subs) {
            if (other.transport === transport)
                continue;
            other.callback(transport.id);
            callback(other.transport.id);
        }
    }
    /**
     * Unregister a transport's onPeerConnect subscription from a room.
     */
    unregisterPeerConnect(room, transport) {
        const subs = this.peerConnectSubs.get(room);
        if (!subs)
            return;
        for (const entry of subs) {
            if (entry.transport === transport) {
                subs.delete(entry);
                break;
            }
        }
    }
    /**
     * Broadcast a message to all clients in a room except the sender.
     */
    broadcast(room, data, sender, options) {
        const clients = this.rooms.get(room);
        if (!clients)
            return;
        const latency = options?.latency ?? 0;
        const dropRate = options?.dropRate ?? 0;
        const jitter = options?.jitter ?? 0;
        for (const client of clients) {
            // Don't send back to sender
            if (client.transport === sender)
                continue;
            // Simulate packet loss
            if (dropRate > 0 && Math.random() < dropRate) {
                continue;
            }
            // Calculate actual delay with jitter
            let actualDelay = latency;
            if (latency > 0 && jitter > 0) {
                // Random delay between latency*(1-jitter) and latency*(1+jitter)
                const minDelay = latency * (1 - jitter);
                const maxDelay = latency * (1 + jitter);
                actualDelay = minDelay + Math.random() * (maxDelay - minDelay);
            }
            // Simulate network latency
            if (actualDelay > 0) {
                setTimeout(() => {
                    try {
                        client.callback(data);
                    }
                    catch (error) {
                        console.error('Error delivering message:', error);
                    }
                }, actualDelay);
            }
            else {
                try {
                    client.callback(data);
                }
                catch (error) {
                    console.error('Error delivering message:', error);
                }
            }
        }
    }
    /**
     * Get the number of clients connected to a room.
     */
    getRoomSize(room) {
        return this.rooms.get(room)?.size ?? 0;
    }
    /**
     * Get all active room names.
     */
    getRooms() {
        return Array.from(this.rooms.keys());
    }
    /**
     * Disconnect all clients and clear all rooms.
     */
    clear() {
        this.rooms.clear();
    }
}
/**
 * Global hub registry for auto-managed hubs (one per room).
 * Used when no explicit hub is provided.
 */
const globalHubs = new Map();
/**
 * Get or create a hub for a room.
 */
function getOrCreateHub(room) {
    if (!globalHubs.has(room)) {
        globalHubs.set(room, new DummyHub());
    }
    return globalHubs.get(room);
}
/** Chunk header: [chunkId: uint32][index: uint16][total: uint16]. */
const CHUNK_HEADER_SIZE = 8;
/**
 * Dummy transport implementation for testing and development.
 * Routes messages through a DummyHub instance.
 */
export class DummyTransport {
    /**
     * Create a new DummyTransport.
     *
     * @param options - Optional behavior simulation settings
     *
     * @example
     * ```typescript
     * // Simple case - hub is auto-managed
     * const transport = new DummyTransport()
     *
     * // With network simulation
     * const transport = new DummyTransport({ latency: 100, dropRate: 0.1 })
     *
     * // With out-of-order delivery (useful for testing CRDT)
     * const transport = new DummyTransport({ latency: 100, jitter: 0.5 })
     * // Messages arrive between 50ms and 150ms (may arrive out of order)
     *
     * // Advanced - explicit shared hub
     * const hub = new DummyHub()
     * const transport1 = new DummyTransport({ hub })
     * const transport2 = new DummyTransport({ hub })
     * ```
     */
    constructor(options = {}) {
        /** Unique id for this transport instance, used by the onPeerConnect simulation. */
        this.id = `dummy-${DummyTransport._idCounter++}`;
        this._connected = false;
        this._room = '';
        /** Reassembly buffers for chunkSizeLimit mode, keyed by chunk id. */
        this._chunkBuffers = new Map();
        this.hub = options.hub;
        this.explicitHub = !!options.hub;
        this.options = {
            latency: options.latency ?? 0,
            dropRate: options.dropRate ?? 0,
            jitter: options.jitter ?? 0,
            autoConnect: options.autoConnect ?? false,
            simulatePeerConnect: options.simulatePeerConnect ?? false,
            chunkSizeLimit: options.chunkSizeLimit,
        };
        if (this.options.simulatePeerConnect) {
            this.onPeerConnect = (callback) => {
                this._peerConnectCallback = callback;
                if (this._connected && this._room && this.hub) {
                    this.hub.registerPeerConnect(this._room, this, callback);
                }
                return () => {
                    this._peerConnectCallback = undefined;
                    if (this.hub) {
                        this.hub.unregisterPeerConnect(this._room, this);
                    }
                };
            };
        }
    }
    /**
     * Connect to a room on the hub.
     */
    async connect(config) {
        if (this._connected) {
            throw new Error('Already connected');
        }
        this._room = config.room;
        // Get or create hub for this room if not explicitly provided
        if (!this.hub) {
            this.hub = getOrCreateHub(this._room);
        }
        // Simulate async connection
        await new Promise((resolve) => setTimeout(resolve, this.options.latency));
        // If callback is registered, join immediately
        if (this._callback) {
            this.hub.join(this._room, this, this._callback);
        }
        // Otherwise, will join when onMessage() is called
        // Mark connected before registering onPeerConnect: registerPeerConnect()
        // synchronously fires callbacks (including this transport's own, about
        // peers already in the room), and a real mesh transport only fires
        // onPeerConnect once it considers its own channel open - so any
        // consumer reacting to that notification (e.g. GenericProvider calling
        // syncNow()) should see isConnected as true, matching real transports.
        this._connected = true;
        // Same deal for onPeerConnect - register with the hub now that the room
        // is known, if a caller already subscribed before connect() resolved.
        if (this._peerConnectCallback) {
            this.hub.registerPeerConnect(this._room, this, this._peerConnectCallback);
        }
    }
    /**
     * Disconnect from the hub.
     */
    disconnect() {
        if (!this._connected)
            return;
        if (this.hub) {
            this.hub.leave(this._room, this);
            this.hub.unregisterPeerConnect(this._room, this);
        }
        this._connected = false;
    }
    /**
     * Send data to all other clients in the room.
     */
    send(data) {
        if (!this._connected || !this.hub) {
            if (this.options.autoConnect && this._room) {
                // Auto-reconnect was requested
                console.warn('DummyTransport: Not connected, dropping message');
            }
            return;
        }
        const limit = this.options.chunkSizeLimit;
        if (limit) {
            this._sendChunked(data, limit);
            return;
        }
        // Broadcast through hub
        this.hub.broadcast(this._room, data, this, {
            latency: this.options.latency,
            dropRate: this.options.dropRate,
            jitter: this.options.jitter,
        });
    }
    /**
     * Split `data` into one or more hub-delivered chunks, each carrying a
     * small [chunkId][index][total] header - mirrors (in spirit, not byte
     * format) how PubNub/Ably split an oversized payload into multiple wire
     * messages. Always chunks (even a payload that fits in one chunk, as a
     * single total=1 "chunk") so the receiving side's framing is unambiguous
     * regardless of payload size - see chunkSizeLimit's doc comment.
     */
    _sendChunked(data, limit) {
        const payloadSize = Math.max(1, limit - CHUNK_HEADER_SIZE);
        const total = Math.max(1, Math.ceil(data.length / payloadSize));
        const chunkId = Math.floor(Math.random() * 0xffffffff);
        for (let i = 0; i < total; i++) {
            const slice = data.subarray(i * payloadSize, (i + 1) * payloadSize);
            const packed = new Uint8Array(CHUNK_HEADER_SIZE + slice.length);
            const view = new DataView(packed.buffer);
            view.setUint32(0, chunkId);
            view.setUint16(4, i);
            view.setUint16(6, total);
            packed.set(slice, CHUNK_HEADER_SIZE);
            this.hub.broadcast(this._room, packed, this, {
                latency: this.options.latency,
                dropRate: this.options.dropRate,
                jitter: this.options.jitter,
            });
        }
    }
    /**
     * Reassemble a chunked message. Returns the complete payload once every
     * chunk for its chunkId has arrived, or `undefined` while still waiting
     * on more chunks (including the single-chunk total=1 case reassembling
     * immediately).
     */
    _reassembleChunk(packed) {
        const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
        const chunkId = view.getUint32(0);
        const index = view.getUint16(4);
        const total = view.getUint16(6);
        const payload = packed.subarray(CHUNK_HEADER_SIZE);
        if (total === 1) {
            return payload;
        }
        let buf = this._chunkBuffers.get(chunkId);
        if (!buf) {
            buf = new Map();
            this._chunkBuffers.set(chunkId, buf);
        }
        buf.set(index, payload);
        if (buf.size < total) {
            return undefined;
        }
        this._chunkBuffers.delete(chunkId);
        const totalLength = Array.from(buf.values()).reduce((sum, c) => sum + c.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (let i = 0; i < total; i++) {
            const part = buf.get(i);
            combined.set(part, offset);
            offset += part.length;
        }
        return combined;
    }
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback) {
        const limit = this.options.chunkSizeLimit;
        const wrappedCallback = limit
            ? (packed) => {
                const reassembled = this._reassembleChunk(packed);
                if (reassembled)
                    callback(reassembled);
            }
            : callback;
        this._callback = wrappedCallback;
        // If already connected, register with hub now
        if (this._connected && this._room && this.hub) {
            this.hub.join(this._room, this, wrappedCallback);
        }
        // Return unsubscribe function
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
     * Get current room name (for debugging).
     */
    get room() {
        return this._room;
    }
    /**
     * Get the hub instance being used (for debugging).
     */
    getHub() {
        return this.hub;
    }
}
DummyTransport._idCounter = 0;
/**
 * Utility functions for debugging and testing.
 */
/**
 * Get statistics about all auto-managed hubs.
 * Useful for debugging and verifying test cleanup.
 *
 * @example
 * ```typescript
 * const stats = getGlobalHubStats()
 * console.log(`Active rooms: ${stats.totalRooms}`)
 * console.log(`Total clients: ${stats.totalClients}`)
 * ```
 */
export function getGlobalHubStats() {
    const rooms = Array.from(globalHubs.entries()).map(([room, hub]) => ({
        room,
        clients: hub.getRoomSize(room),
    }));
    return {
        totalRooms: globalHubs.size,
        totalClients: rooms.reduce((sum, r) => sum + r.clients, 0),
        rooms,
    };
}
/**
 * Clear all auto-managed hubs.
 * Useful for cleaning up between tests.
 *
 * @example
 * ```typescript
 * afterEach(() => {
 *   clearGlobalHubs()
 * })
 * ```
 */
export function clearGlobalHubs() {
    for (const hub of globalHubs.values()) {
        hub.clear();
    }
    globalHubs.clear();
}
//# sourceMappingURL=index.js.map