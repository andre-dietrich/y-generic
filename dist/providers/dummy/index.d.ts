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
    private peerConnectSubs;
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
    registerPeerConnect(room: string, transport: DummyTransport, callback: (peerId: string) => void): void;
    /**
     * Unregister a transport's onPeerConnect subscription from a room.
     */
    unregisterPeerConnect(room: string, transport: DummyTransport): void;
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
    /**
     * Simulate onPeerConnect notifications (mesh-style peer-discovery, as a
     * real peerjs/simple-peer/trystero transport would fire). DummyTransport
     * otherwise models a broadcast relay (like websocket/pubnub/gun/matrix,
     * none of which implement onPeerConnect) - off by default so plain
     * multi-peer benchmarks/usage aren't silently shifted onto the mesh code
     * path in GenericProvider.connect(). Enable only when a test specifically
     * wants to exercise onPeerConnect-triggered behavior (e.g.
     * test/dummy/bench-mesh-join-burst.ts).
     * @default false
     */
    simulatePeerConnect?: boolean;
    /**
     * Simulate a chunking transport's hard per-message size limit (bytes),
     * mirroring how PubNub (`src/providers/pubnub/index.ts`, ~30KB) and Ably
     * (`src/providers/ably/index.ts`) split any `send()` payload larger than
     * their wire limit into multiple messages, reassembled on the receiving
     * side. DummyTransport otherwise has no size limit at all, so this
     * scenario (a large sync payload silently becoming N wire messages) is
     * completely unbenchmarkable without it - see
     * docs/superpowers/specs/2026-09-04-sync-optimization-round-3-ideas.md
     * item 1. Off by default (`undefined`) so every existing bench script's
     * message counts are unaffected.
     *
     * When set, EVERY `send()` call is wrapped in a small chunk header
     * (chunk id + index + total), even payloads that fit in a single chunk -
     * this keeps the wire format unambiguous instead of guessing whether an
     * incoming message is chunked. Both sides of a room must set this
     * consistently (this is a same-process test simulation, not a real
     * negotiated protocol).
     * @default undefined (no chunking)
     */
    chunkSizeLimit?: number;
}
/**
 * Dummy transport implementation for testing and development.
 * Routes messages through a DummyHub instance.
 */
export declare class DummyTransport implements Transport {
    private static _idCounter;
    /** Unique id for this transport instance, used by the onPeerConnect simulation. */
    readonly id: string;
    private hub?;
    private explicitHub;
    private options;
    private _connected;
    private _room;
    private _callback?;
    private _peerConnectCallback?;
    /** Reassembly buffers for chunkSizeLimit mode, keyed by chunk id. */
    private _chunkBuffers;
    /**
     * Register callback for peer-connect notifications. Test-only simulation
     * of what a real mesh transport (peerjs, simple-peer) does when a new
     * data channel opens - see DummyHub.registerPeerConnect(). Assigned
     * conditionally in the constructor (NOT a class method - see there for
     * why): present only when `simulatePeerConnect` is on, so this property
     * is genuinely absent (`undefined`), not merely a no-op function, on a
     * plain DummyTransport. GenericProvider feature-detects onPeerConnect via
     * `if (this.transport.onPeerConnect)` (matching the optional method on
     * the `Transport` interface) - a class method satisfying that interface
     * is ALWAYS present on every instance regardless of any constructor
     * option, which previously defeated this feature-detection for every
     * DummyTransport consumer (even non-mesh ones), silently registering an
     * inert onPeerConnect subscription and, since GenericProvider gained
     * onPeerConnect-conditional behavior elsewhere in its periodic-sync path,
     * silently suppressing periodic awareness re-announce for plain
     * DummyTransport usage too - a real bug, not just untidiness.
     */
    readonly onPeerConnect?: (callback: (peerId: string) => void) => () => void;
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
     * Split `data` into one or more hub-delivered chunks, each carrying a
     * small [chunkId][index][total] header - mirrors (in spirit, not byte
     * format) how PubNub/Ably split an oversized payload into multiple wire
     * messages. Always chunks (even a payload that fits in one chunk, as a
     * single total=1 "chunk") so the receiving side's framing is unambiguous
     * regardless of payload size - see chunkSizeLimit's doc comment.
     */
    private _sendChunked;
    /**
     * Reassemble a chunked message. Returns the complete payload once every
     * chunk for its chunkId has arrived, or `undefined` while still waiting
     * on more chunks (including the single-chunk total=1 case reassembling
     * immediately).
     */
    private _reassembleChunk;
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