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
     * Broadcast a message to all clients in a room except the sender.
     */
    broadcast(room, data, sender, options) {
        const clients = this.rooms.get(room);
        if (!clients)
            return;
        const latency = options?.latency ?? 0;
        const dropRate = options?.dropRate ?? 0;
        for (const client of clients) {
            // Don't send back to sender
            if (client.transport === sender)
                continue;
            // Simulate packet loss
            if (dropRate > 0 && Math.random() < dropRate) {
                continue;
            }
            // Simulate network latency
            if (latency > 0) {
                setTimeout(() => {
                    try {
                        client.callback(data);
                    }
                    catch (error) {
                        console.error('Error delivering message:', error);
                    }
                }, latency);
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
     * // Advanced - explicit shared hub
     * const hub = new DummyHub()
     * const transport1 = new DummyTransport({ hub })
     * const transport2 = new DummyTransport({ hub })
     * ```
     */
    constructor(options = {}) {
        this._connected = false;
        this._room = '';
        this.hub = options.hub;
        this.explicitHub = !!options.hub;
        this.options = {
            latency: options.latency ?? 0,
            dropRate: options.dropRate ?? 0,
            autoConnect: options.autoConnect ?? false,
        };
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
        this._connected = true;
    }
    /**
     * Disconnect from the hub.
     */
    disconnect() {
        if (!this._connected)
            return;
        if (this.hub) {
            this.hub.leave(this._room, this);
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
        // Broadcast through hub
        this.hub.broadcast(this._room, data, this, {
            latency: this.options.latency,
            dropRate: this.options.dropRate,
        });
    }
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback) {
        this._callback = callback;
        // If already connected, register with hub now
        if (this._connected && this._room && this.hub) {
            this.hub.join(this._room, this, callback);
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