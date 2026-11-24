/**
 * In-memory transport for the unit tests and test/dummy benches, with
 * simulated latency, jitter and loss. Not published (excluded from the build).
 * Transports in the same room share an auto-created hub unless one is passed.
 */

import type { Transport, ConnectionConfig } from '../../transport'

/** Routes frames between the DummyTransports in a room, like a relay server. */
export class DummyHub {
  private rooms: Map<
    string,
    Set<{
      transport: DummyTransport
      callback: (data: Uint8Array) => void
    }>
  > = new Map()

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

  /** Deliver to everyone in the room but the sender. */
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
      if (client.transport === sender) continue

      if (dropRate > 0 && Math.random() < dropRate) {
        continue
      }

      // Uniform in latency * [1 - jitter, 1 + jitter].
      let actualDelay = latency
      if (latency > 0 && jitter > 0) {
        const minDelay = latency * (1 - jitter)
        const maxDelay = latency * (1 + jitter)
        actualDelay = minDelay + Math.random() * (maxDelay - minDelay)
      }

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

  getRoomSize(room: string): number {
    return this.rooms.get(room)?.size ?? 0
  }

  getRooms(): string[] {
    return Array.from(this.rooms.keys())
  }

  clear(): void {
    this.rooms.clear()
  }
}

// Auto-managed hubs, one per room, used when no hub is passed.
const globalHubs = new Map<string, DummyHub>()

function getOrCreateHub(room: string): DummyHub {
  if (!globalHubs.has(room)) {
    globalHubs.set(room, new DummyHub())
  }
  return globalHubs.get(room)!
}

export interface DummyTransportOptions {
  /** Shared hub; by default one per room is created. */
  hub?: DummyHub
  /** ms. @default 0 */
  latency?: number
  /** Fraction of frames dropped, 0-1. @default 0 */
  dropRate?: number
  /**
   * Delay spread as a fraction of latency (0-1); delivery is uniform in
   * latency * [1 - jitter, 1 + jitter], so frames can arrive out of order.
   * @default 0
   */
  jitter?: number
  /** Only warns when sending while disconnected. @default false */
  autoConnect?: boolean
}

export class DummyTransport implements Transport {
  /** The hub delivers every frame to all other transports in the room. */
  readonly reachesAllPeers = true
  private hub?: DummyHub
  private explicitHub: boolean
  private options: DummyTransportOptions
  private _connected: boolean = false
  private _room: string = ''
  private _callback?: (data: Uint8Array) => void

  constructor(options: DummyTransportOptions = {}) {
    this.hub = options.hub
    this.explicitHub = !!options.hub
    this.options = {
      latency: options.latency ?? 0,
      dropRate: options.dropRate ?? 0,
      jitter: options.jitter ?? 0,
      autoConnect: options.autoConnect ?? false,
    }
  }

  async connect(config: ConnectionConfig): Promise<void> {
    if (this._connected) {
      throw new Error('Already connected')
    }

    this._room = config.room

    if (!this.hub) {
      this.hub = getOrCreateHub(this._room)
    }

    await new Promise((resolve) => setTimeout(resolve, this.options.latency))

    // Without a callback yet, onMessage() joins.
    if (this._callback) {
      this.hub.join(this._room, this, this._callback)
    }

    this._connected = true
  }

  disconnect(): void {
    if (!this._connected) return

    if (this.hub) {
      this.hub.leave(this._room, this)
    }
    this._connected = false
  }

  send(data: Uint8Array): void {
    if (!this._connected || !this.hub) {
      if (this.options.autoConnect && this._room) {
        console.warn('DummyTransport: Not connected, dropping message')
      }
      return
    }

    this.hub.broadcast(this._room, data, this, {
      latency: this.options.latency,
      dropRate: this.options.dropRate,
      jitter: this.options.jitter,
    })
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this._callback = callback

    if (this._connected && this._room && this.hub) {
      this.hub.join(this._room, this, callback)
    }

    return () => {
      this._callback = undefined
    }
  }

  get isConnected(): boolean {
    return this._connected
  }

  get room(): string {
    return this._room
  }

  getHub(): DummyHub | undefined {
    return this.hub
  }
}

/** Rooms and clients across the auto-managed hubs, to check test cleanup. */
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

/** Clear the auto-managed hubs, e.g. between tests. */
export function clearGlobalHubs(): void {
  for (const hub of globalHubs.values()) {
    hub.clear()
  }
  globalHubs.clear()
}
