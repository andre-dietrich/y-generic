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
import type { Transport, ConnectionConfig } from '../../transport';
/**
 * Central hub that routes messages between DummyTransport instances.
 * Simulates a server or message broker.
 */
export declare class DummyHub {
    private rooms;
    /**
     * Register a transport in a room.
     */
    join(room: string, transport: DummyTransport, callback: (data: Uint8Array) => void): void;
    /**
     * Unregister a transport from a room.
     */
    leave(room: string, transport: DummyTransport): void;
    /**
     * Broadcast a message to all clients in a room except the sender.
     */
    broadcast(room: string, data: Uint8Array, sender: DummyTransport, options?: {
        latency?: number;
        dropRate?: number;
        jitter?: number;
    }): void;
    /**
     * Get the number of clients connected to a room.
     */
    getRoomSize(room: string): number;
    /**
     * Get all active room names.
     */
    getRooms(): string[];
    /**
     * Disconnect all clients and clear all rooms.
     */
    clear(): void;
}
/**
 * Options for DummyTransport behavior simulation.
 */
export interface DummyTransportOptions {
    /**
     * Optional explicit hub to use.
     * If not provided, an auto-managed hub will be created per room.
     * Use an explicit hub when you need multiple transports to share
     * the same hub instance (e.g., for advanced testing scenarios).
     * @default undefined (auto-managed)
     */
    hub?: DummyHub;
    /**
     * Simulated network latency in milliseconds.
     * @default 0
     */
    latency?: number;
    /**
     * Simulated packet drop rate (0-1).
     * 0 = no drops, 0.1 = 10% drops, 1 = all packets dropped
     * @default 0
     */
    dropRate?: number;
    /**
     * Latency jitter as a fraction of latency (0-1).
     * Randomizes delivery time to simulate out-of-order arrival.
     *
     * Examples:
     * - jitter = 0: All messages arrive at exactly `latency` ms (in order)
     * - jitter = 0.5: Messages arrive between latency*0.5 and latency*1.5
     * - jitter = 1.0: Messages arrive between 0 and latency*2 (maximum variance)
     *
     * This causes messages to potentially arrive out of order, which is
     * useful for testing CRDT conflict resolution.
     *
     * @default 0
     */
    jitter?: number;
    /**
     * Automatically connect on first send.
     * Useful for testing auto-reconnect behavior.
     * @default false
     */
    autoConnect?: boolean;
}
/**
 * Dummy transport implementation for testing and development.
 * Routes messages through a DummyHub instance.
 */
export declare class DummyTransport implements Transport {
    private hub?;
    private explicitHub;
    private options;
    private _connected;
    private _room;
    private _callback?;
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
    constructor(options?: DummyTransportOptions);
    /**
     * Connect to a room on the hub.
     */
    connect(config: ConnectionConfig): Promise<void>;
    /**
     * Disconnect from the hub.
     */
    disconnect(): void;
    /**
     * Send data to all other clients in the room.
     */
    send(data: Uint8Array): void;
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Check if connected.
     */
    get isConnected(): boolean;
    /**
     * Get current room name (for debugging).
     */
    get room(): string;
    /**
     * Get the hub instance being used (for debugging).
     */
    getHub(): DummyHub | undefined;
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
export declare function getGlobalHubStats(): {
    totalRooms: number;
    totalClients: number;
    rooms: Array<{
        room: string;
        clients: number;
    }>;
};
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
export declare function clearGlobalHubs(): void;
//# sourceMappingURL=index.d.ts.map