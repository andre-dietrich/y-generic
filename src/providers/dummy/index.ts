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

import type { Transport, ConnectionConfig } from '../../transport'

/**
 * Central hub that routes messages between DummyTransport instances.
 * Simulates a server or message broker.
 */
export class DummyHub {
  private rooms: Map<
    string,
    Set<{
      transport: DummyTransport
      callback: (data: Uint8Array) => void
    }>
  > = new Map()

  /**
   * Register a transport in a room.
   */
  join(
    room: string,
    transport: DummyTransport,
    callback: (data: Uint8Array) => void,
  ): void {
    if (!this.rooms.has(room)) {
      this.rooms.set(room, new Set())
    }
    this.rooms.get(room)!.add({ transport, callback })
  }

  /**
   * Unregister a transport from a room.
   */
  leave(room: string, transport: DummyTransport): void {
    const clients = this.rooms.get(room)
    if (clients) {
      for (const client of clients) {
        if (client.transport === transport) {
          clients.delete(client)
          break
        }
      }
      if (clients.size === 0) {
        this.rooms.delete(room)
      }
    }
  }

  private peerConnectSubs: Map<
    string,
    Set<{ transport: DummyTransport; callback: (peerId: string) => void }>
  > = new Map()

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
  registerPeerConnect(
    room: string,
    transport: DummyTransport,
    callback: (peerId: string) => void,
  ): void {
    if (!this.peerConnectSubs.has(room)) {
      this.peerConnectSubs.set(room, new Set())
    }
    const subs = this.peerConnectSubs.get(room)!
    const entry = { transport, callback }
    subs.add(entry)

    for (const other of subs) {
      if (other.transport === transport) continue
      other.callback(transport.id)
      callback(other.transport.id)
    }
  }

  /**
   * Unregister a transport's onPeerConnect subscription from a room.
   */
  unregisterPeerConnect(room: string, transport: DummyTransport): void {
    const subs = this.peerConnectSubs.get(room)
    if (!subs) return
    for (const entry of subs) {
      if (entry.transport === transport) {
        subs.delete(entry)
        break
      }
    }
  }

  /**
   * Broadcast a message to all clients in a room except the sender.
   */
  broadcast(
    room: string,
    data: Uint8Array,
    sender: DummyTransport,
    options?: { latency?: number; dropRate?: number; jitter?: number },
  ): void {
    const clients = this.rooms.get(room)
    if (!clients) return

    const latency = options?.latency ?? 0
    const dropRate = options?.dropRate ?? 0
    const jitter = options?.jitter ?? 0

    for (const client of clients) {
      // Don't send back to sender
      if (client.transport === sender) continue

      // Simulate packet loss
      if (dropRate > 0 && Math.random() < dropRate) {
        continue
      }

      // Calculate actual delay with jitter
      let actualDelay = latency
      if (latency > 0 && jitter > 0) {
        // Random delay between latency*(1-jitter) and latency*(1+jitter)
        const minDelay = latency * (1 - jitter)
        const maxDelay = latency * (1 + jitter)
        actualDelay = minDelay + Math.random() * (maxDelay - minDelay)
      }

      // Simulate network latency
      if (actualDelay > 0) {
        setTimeout(() => {
          try {
            client.callback(data)
          } catch (error) {
            console.error('Error delivering message:', error)
          }
        }, actualDelay)
      } else {
        try {
          client.callback(data)
        } catch (error) {
          console.error('Error delivering message:', error)
        }
      }
    }
  }

  /**
   * Get the number of clients connected to a room.
   */
  getRoomSize(room: string): number {
    return this.rooms.get(room)?.size ?? 0
  }

  /**
   * Get all active room names.
   */
  getRooms(): string[] {
    return Array.from(this.rooms.keys())
  }

  /**
   * Disconnect all clients and clear all rooms.
   */
  clear(): void {
    this.rooms.clear()
  }
}

/**
 * Global hub registry for auto-managed hubs (one per room).
 * Used when no explicit hub is provided.
 */
const globalHubs = new Map<string, DummyHub>()

/**
 * Get or create a hub for a room.
 */
function getOrCreateHub(room: string): DummyHub {
  if (!globalHubs.has(room)) {
    globalHubs.set(room, new DummyHub())
  }
  return globalHubs.get(room)!
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
  hub?: DummyHub

  /**
   * Simulated network latency in milliseconds.
   * @default 0
   */
  latency?: number

  /**
   * Simulated packet drop rate (0-1).
   * 0 = no drops, 0.1 = 10% drops, 1 = all packets dropped
   * @default 0
   */
  dropRate?: number

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
  jitter?: number

  /**
   * Automatically connect on first send.
   * Useful for testing auto-reconnect behavior.
   * @default false
   */
  autoConnect?: boolean

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
  simulatePeerConnect?: boolean
}

/**
 * Dummy transport implementation for testing and development.
 * Routes messages through a DummyHub instance.
 */
export class DummyTransport implements Transport {
  private static _idCounter = 0
  /** Unique id for this transport instance, used by the onPeerConnect simulation. */
  public readonly id: string = `dummy-${DummyTransport._idCounter++}`

  private hub?: DummyHub
  private explicitHub: boolean
  private options: DummyTransportOptions
  private _connected: boolean = false
  private _room: string = ''
  private _callback?: (data: Uint8Array) => void
  private _peerConnectCallback?: (peerId: string) => void

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
  readonly onPeerConnect?: (
    callback: (peerId: string) => void,
  ) => () => void

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
  constructor(options: DummyTransportOptions = {}) {
    this.hub = options.hub
    this.explicitHub = !!options.hub
    this.options = {
      latency: options.latency ?? 0,
      dropRate: options.dropRate ?? 0,
      jitter: options.jitter ?? 0,
      autoConnect: options.autoConnect ?? false,
      simulatePeerConnect: options.simulatePeerConnect ?? false,
    }

    if (this.options.simulatePeerConnect) {
      this.onPeerConnect = (callback: (peerId: string) => void) => {
        this._peerConnectCallback = callback

        if (this._connected && this._room && this.hub) {
          this.hub.registerPeerConnect(this._room, this, callback)
        }

        return () => {
          this._peerConnectCallback = undefined
          if (this.hub) {
            this.hub.unregisterPeerConnect(this._room, this)
          }
        }
      }
    }
  }

  /**
   * Connect to a room on the hub.
   */
  async connect(config: ConnectionConfig): Promise<void> {
    if (this._connected) {
      throw new Error('Already connected')
    }

    this._room = config.room

    // Get or create hub for this room if not explicitly provided
    if (!this.hub) {
      this.hub = getOrCreateHub(this._room)
    }

    // Simulate async connection
    await new Promise((resolve) => setTimeout(resolve, this.options.latency))

    // If callback is registered, join immediately
    if (this._callback) {
      this.hub.join(this._room, this, this._callback)
    }
    // Otherwise, will join when onMessage() is called

    // Mark connected before registering onPeerConnect: registerPeerConnect()
    // synchronously fires callbacks (including this transport's own, about
    // peers already in the room), and a real mesh transport only fires
    // onPeerConnect once it considers its own channel open - so any
    // consumer reacting to that notification (e.g. GenericProvider calling
    // syncNow()) should see isConnected as true, matching real transports.
    this._connected = true

    // Same deal for onPeerConnect - register with the hub now that the room
    // is known, if a caller already subscribed before connect() resolved.
    if (this._peerConnectCallback) {
      this.hub.registerPeerConnect(this._room, this, this._peerConnectCallback)
    }
  }

  /**
   * Disconnect from the hub.
   */
  disconnect(): void {
    if (!this._connected) return

    if (this.hub) {
      this.hub.leave(this._room, this)
      this.hub.unregisterPeerConnect(this._room, this)
    }
    this._connected = false
  }

  /**
   * Send data to all other clients in the room.
   */
  send(data: Uint8Array): void {
    if (!this._connected || !this.hub) {
      if (this.options.autoConnect && this._room) {
        // Auto-reconnect was requested
        console.warn('DummyTransport: Not connected, dropping message')
      }
      return
    }

    // Broadcast through hub
    this.hub.broadcast(this._room, data, this, {
      latency: this.options.latency,
      dropRate: this.options.dropRate,
      jitter: this.options.jitter,
    })
  }

  /**
   * Register callback for incoming messages.
   */
  onMessage(callback: (data: Uint8Array) => void): () => void {
    this._callback = callback

    // If already connected, register with hub now
    if (this._connected && this._room && this.hub) {
      this.hub.join(this._room, this, callback)
    }

    // Return unsubscribe function
    return () => {
      this._callback = undefined
    }
  }

  /**
   * Check if connected.
   */
  get isConnected(): boolean {
    return this._connected
  }

  /**
   * Get current room name (for debugging).
   */
  get room(): string {
    return this._room
  }

  /**
   * Get the hub instance being used (for debugging).
   */
  getHub(): DummyHub | undefined {
    return this.hub
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
export function getGlobalHubStats(): {
  totalRooms: number
  totalClients: number
  rooms: Array<{ room: string; clients: number }>
} {
  const rooms = Array.from(globalHubs.entries()).map(([room, hub]) => ({
    room,
    clients: hub.getRoomSize(room),
  }))

  return {
    totalRooms: globalHubs.size,
    totalClients: rooms.reduce((sum, r) => sum + r.clients, 0),
    rooms,
  }
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
export function clearGlobalHubs(): void {
  for (const hub of globalHubs.values()) {
    hub.clear()
  }
  globalHubs.clear()
}
