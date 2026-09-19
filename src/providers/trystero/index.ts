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

import type { Transport, ConnectionConfig } from '../../transport'
import { watchResume } from '../resume'

/**
 * Trystero room instance type.
 */
export interface TrysteroRoom {
  leave: () => void | Promise<void>
  getPeers: () => Record<string, any>
  onPeerJoin: (callback: (peerId: string) => void) => void
  onPeerLeave: (callback: (peerId: string) => void) => void
  makeAction: (
    actionId: string,
  ) => [
    (
      data: any,
      targetPeers?: string | string[] | null,
      metadata?: any,
      onProgress?: (percent: number, peerId: string) => void,
    ) => Promise<void>,
    (callback: (data: any, peerId: string, metadata?: any) => void) => void,
    (
      callback: (percent: number, peerId: string, metadata?: any) => void,
    ) => void,
  ]
  ping: (peerId: string) => Promise<number>
}

/**
 * Trystero joinRoom function type.
 */
export type JoinRoomFunction = (
  config: TrysteroConfig,
  roomId: string,
  onJoinError?: (details: any) => void,
) => TrysteroRoom

/**
 * Trystero configuration object.
 */
export interface TrysteroConfig {
  appId: string
  password?: string
  relayUrls?: string[]
  relayRedundancy?: number
  rtcConfig?: RTCConfiguration
  turnConfig?: RTCIceServer[]
  rtcPolyfill?: any
  supabaseKey?: string
  firebaseApp?: any
  rootPath?: string
  manualRelayReconnection?: boolean
}

/**
 * Configuration options for Trystero transport.
 */
export interface TrysteroTransportOptions {
  /**
   * The Trystero joinRoom function.
   * Import from specific strategy: trystero/nostr, trystero/torrent, etc.
   * @example
   * ```typescript
   * import { joinRoom } from 'trystero/nostr'
   * const transport = new TrysteroTransport({ joinRoom, appId: 'my-app' })
   * ```
   */
  joinRoom: JoinRoomFunction

  /**
   * Unique app identifier (required).
   * For Supabase: use project URL
   * For Firebase: use databaseURL
   * @example 'my-app-unique-id-123'
   */
  appId: string

  /**
   * Optional password for encrypting session descriptions.
   * Must match between all peers to connect.
   * @default undefined
   */
  password?: string

  /**
   * Custom relay URLs for the strategy.
   * For BitTorrent: tracker URLs
   * For Nostr: relay URLs
   * For MQTT: broker URLs
   * @default undefined (uses strategy defaults)
   */
  relayUrls?: string[]

  /**
   * Number of relays to connect to simultaneously.
   * Ignored if relayUrls is provided.
   * @default undefined
   */
  relayRedundancy?: number

  /**
   * Custom RTCConfiguration for peer connections.
   * @see https://developer.mozilla.org/en-US/docs/Web/API/RTCConfiguration
   */
  rtcConfig?: RTCConfiguration

  /**
   * TURN server configuration for NAT traversal.
   * Each item should be an RTCIceServer config.
   * @example [{urls: 'turn:my-turn.server:3478', username: 'user', credential: 'pass'}]
   */
  turnConfig?: RTCIceServer[]

  /**
   * Custom RTCPeerConnection polyfill for server-side usage.
   * @example import { RTCPeerConnection } from 'node-datachannel/polyfill'
   */
  rtcPolyfill?: any

  /**
   * (Supabase only) Supabase project's anon public API key.
   */
  supabaseKey?: string

  /**
   * (Firebase only) Firebase app instance.
   */
  firebaseApp?: any

  /**
   * (Firebase only) Custom root path for matchmaking data.
   * @default '__trystero__'
   */
  rootPath?: string

  /**
   * (Nostr/BitTorrent only) Disable automatic relay reconnection.
   * @default false
   */
  manualRelayReconnection?: boolean

  /**
   * The strategy module's `getRelaySockets` (nostr, torrent, mqtt export
   * it next to `joinRoom`). Trystero re-opens a relay socket that closed
   * but does not subscribe again on it: the peer keeps its links and goes
   * deaf to every offer from then on. A phone in the background loses all
   * its relay sockets at once - measured with 25 real browsers
   * (test/e2e/room-scenarios.mjs): a page frozen for 20 s ("WebSocket
   * connection failed: Page entered Back-Forward Cache") never connected
   * to a peer that joined afterwards, and after a relay restart nobody
   * could join the room any more. With this option the transport watches
   * the sockets and, once NONE of those it joined with is left (a single
   * flapping relay out of several does not count), leaves and re-joins the
   * room on the re-opened sockets.
   * @example
   * ```typescript
   * import { joinRoom, getRelaySockets } from 'trystero/nostr'
   * new TrysteroTransport({ joinRoom, getRelaySockets, appId: 'my-app' })
   * ```
   */
  getRelaySockets?: () => Record<string, WebSocket>

  /**
   * Without `getRelaySockets`: leave and re-join the room when the page did
   * not run for this long (ms), a few seconds after it woke up (Trystero's
   * first socket retry takes 3.3 s). 0 disables.
   * @default 15000
   */
  resumeAfterMs?: number

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean
}

/**
 * Trystero transport implementation.
 * Creates serverless P2P connections using Trystero library.
 */
export class TrysteroTransport implements Transport {
  private options: TrysteroTransportOptions
  private _connected: boolean = false
  private _room: string = ''
  private _callback?: (data: Uint8Array, from?: string) => void
  private room: TrysteroRoom | null = null
  private sendUpdate:
    | ((data: Uint8Array, targetPeers?: any) => Promise<void>)
    | null = null
  private peers: Set<string> = new Set()
  private onJoinErrorCallback?: (details: any) => void
  private _peerConnectCallback?: (peerId: string) => void
  private _peerDisconnectCallback?: (peerId: string) => void
  private _joinedSockets: Map<string, WebSocket> = new Map() // relay sockets our subscriptions live on
  private _socketWatch?: ReturnType<typeof setInterval>
  private _stopResumeWatch?: () => void
  private _rejoining: boolean = false

  constructor(options: TrysteroTransportOptions) {
    this.options = {
      debug: false,
      ...options,
    }
  }

  private log(
    message: string,
    level: 'info' | 'warn' | 'error' = 'info',
  ): void {
    if (this.options.debug) {
      const prefix = '[TrysteroTransport]'
      switch (level) {
        case 'error':
          console.error(prefix, message)
          break
        case 'warn':
          console.warn(prefix, message)
          break
        default:
          console.log(prefix, message)
      }
    }
  }

  get isConnected(): boolean {
    return this._connected
  }

  async connect(config: ConnectionConfig): Promise<void> {
    if (this._connected) {
      this.log('Already connected, disconnecting first...')
      this.disconnect()
    }

    const room = config.room
    if (!room) {
      throw new Error('Room ID is required')
    }

    this._room = room
    this.log(`Connecting to room: ${room}`)

    this.joinTrysteroRoom()

    this._connected = true
    this.log(`✅ Connected to room: ${room}`)

    if (this.options.getRelaySockets) {
      this._socketWatch = setInterval(() => this.checkRelaySockets(), 2000)
    } else if ((this.options.resumeAfterMs ?? 15000) > 0) {
      this._stopResumeWatch = watchResume(this.options.resumeAfterMs ?? 15000, () => {
        setTimeout(() => this.rejoin('the page slept'), 5000)
      })
    }
  }

  /** Join the Trystero room and wire it up - at connect() and again at every rejoin(). */
  private joinTrysteroRoom(): void {
    // Build Trystero config
    const trysteroConfig: TrysteroConfig = {
      appId: this.options.appId,
    }

    // Add optional config
    if (this.options.password) trysteroConfig.password = this.options.password
    if (this.options.relayUrls)
      trysteroConfig.relayUrls = this.options.relayUrls
    if (this.options.relayRedundancy)
      trysteroConfig.relayRedundancy = this.options.relayRedundancy
    if (this.options.rtcConfig)
      trysteroConfig.rtcConfig = this.options.rtcConfig
    if (this.options.turnConfig)
      trysteroConfig.turnConfig = this.options.turnConfig
    if (this.options.rtcPolyfill)
      trysteroConfig.rtcPolyfill = this.options.rtcPolyfill
    if (this.options.supabaseKey)
      trysteroConfig.supabaseKey = this.options.supabaseKey
    if (this.options.firebaseApp)
      trysteroConfig.firebaseApp = this.options.firebaseApp
    if (this.options.rootPath) trysteroConfig.rootPath = this.options.rootPath
    if (this.options.manualRelayReconnection !== undefined) {
      trysteroConfig.manualRelayReconnection =
        this.options.manualRelayReconnection
    }

    // Join room with error handler
    const joined = this.options.joinRoom(trysteroConfig, this._room, (details) => {
      this.log(`Join error: ${details.error}`, 'error')
      if (this.onJoinErrorCallback) {
        this.onJoinErrorCallback(details)
      }
    })

    this.room = joined

    // Create action for Yjs updates
    const [send, receive] = joined.makeAction('yjs-update')
    this.sendUpdate = send

    // Listen for incoming updates
    receive((data: ArrayBuffer, peerId: string) => {
      this.log(`Received update from ${peerId} (${data.byteLength} bytes)`)
      if (joined !== this.room) return // a room we already left (rejoin)
      if (this._callback) {
        // Convert ArrayBuffer to Uint8Array; peerId lets GenericProvider
        // answer this peer directly via sendTo()
        this._callback(new Uint8Array(data), peerId)
      }
    })

    // Track peers
    joined.onPeerJoin((peerId) => {
      if (joined !== this.room) return
      this.peers.add(peerId)
      this.log(`Peer joined: ${peerId} (${this.peers.size} total)`)
      this._peerConnectCallback?.(peerId)
    })

    joined.onPeerLeave((peerId) => {
      if (joined !== this.room || !this.peers.has(peerId)) return
      this.peers.delete(peerId)
      this.log(`Peer left: ${peerId} (${this.peers.size} remaining)`)
      this._peerDisconnectCallback?.(peerId)
    })

    this._joinedSockets = new Map(Object.entries(this.options.getRelaySockets?.() ?? {}))
  }

  /**
   * Leave and join again: the only way to make Trystero subscribe again on
   * relay sockets it re-opened (see the getRelaySockets option). Our links
   * go with the room; GenericProvider resyncs each one as it comes back.
   */
  private async rejoin(reason: string): Promise<void> {
    if (this._rejoining || !this._connected) return
    this._rejoining = true
    this.log(`♻️ Re-joining the room: ${reason}`)
    try {
      const old = this.room
      this.room = null
      this.sendUpdate = null
      for (const peerId of Array.from(this.peers)) {
        this.peers.delete(peerId)
        this._peerDisconnectCallback?.(peerId)
      }
      // leave() resolves once Trystero has dropped the room from its cache;
      // joinRoom() before that hands back the room we are leaving.
      if (old) await Promise.resolve(old.leave())
      if (this._connected) this.joinTrysteroRoom()
    } finally {
      this._rejoining = false
    }
  }

  /** None of the relay sockets we joined with is left open, and a re-opened one is: re-join on it. */
  private checkRelaySockets(): void {
    const sockets = this.options.getRelaySockets?.() ?? {}
    const current = Object.entries(sockets)
    if (current.length === 0) return
    const intact = current.some(
      ([url, ws]) => this._joinedSockets.get(url) === ws && ws.readyState === 1,
    )
    if (!intact && current.some(([, ws]) => ws.readyState === 1)) {
      this.rejoin('no relay socket with our subscriptions is left')
    }
  }

  disconnect(): void {
    if (!this._connected) {
      return
    }

    this.log('Disconnecting...')

    if (this._socketWatch) clearInterval(this._socketWatch)
    this._socketWatch = undefined
    this._stopResumeWatch?.()
    this._stopResumeWatch = undefined

    if (this.room) {
      this.room.leave()
      this.room = null
    }

    this.sendUpdate = null
    this._callback = undefined
    this._connected = false
    this.peers.clear()

    this.log('✅ Disconnected')
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this._connected || !this.sendUpdate) {
      this.log('⚠️ Not connected, cannot send', 'warn')
      return
    }

    // Send to all peers (null = broadcast)
    this.log(
      `Sending update (${data.byteLength} bytes) to ${this.peers.size} peers`,
    )
    await this.sendUpdate(data, null)
  }

  /**
   * Transport.sendTo: deliver to one peer (Trystero's action send accepts
   * a target peer id). Used by GenericProvider for replies, acks and
   * presence responses.
   */
  async sendTo(peerId: string, data: Uint8Array): Promise<void> {
    if (!this._connected || !this.sendUpdate) return
    if (!this.peers.has(peerId)) return
    await this.sendUpdate(data, peerId)
  }

  onMessage(callback: (data: Uint8Array, from?: string) => void): () => void {
    this._callback = callback
    this.log('Message callback registered')

    return () => {
      this._callback = undefined
      this.log('Message callback unregistered')
    }
  }

  /**
   * Register callback for new peer data-channel connections. Lets
   * GenericProvider push our current doc/awareness state to a peer as
   * soon as their channel opens, instead of only at our own connect()
   * time (which fires before any mesh connection exists) or the next
   * periodic sync tick.
   */
  onPeerConnect(callback: (peerId: string) => void): () => void {
    this._peerConnectCallback = callback

    return () => {
      this._peerConnectCallback = undefined
    }
  }

  /** Transport.onPeerDisconnect: Trystero's onPeerLeave, the same peer id. */
  onPeerDisconnect(callback: (peerId: string) => void): () => void {
    this._peerDisconnectCallback = callback
    return () => {
      this._peerDisconnectCallback = undefined
    }
  }

  /**
   * Set a callback for join errors (optional).
   */
  onJoinError(callback: (details: any) => void): void {
    this.onJoinErrorCallback = callback
  }

  /**
   * Get the set of connected peer IDs.
   */
  getPeers(): Set<string> {
    return new Set(this.peers)
  }

  /**
   * Ping a peer and get round-trip time in ms.
   */
  async ping(peerId: string): Promise<number> {
    if (!this.room) {
      throw new Error('Not connected to a room')
    }
    return await this.room.ping(peerId)
  }
}
