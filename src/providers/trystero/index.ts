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

/**
 * Trystero room instance type.
 */
export interface TrysteroRoom {
  leave: () => void
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
  private _callback?: (data: Uint8Array) => void
  private room: TrysteroRoom | null = null
  private sendUpdate:
    | ((data: Uint8Array, targetPeers?: any) => Promise<void>)
    | null = null
  private peers: Set<string> = new Set()
  private onJoinErrorCallback?: (details: any) => void

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
    this.room = this.options.joinRoom(trysteroConfig, room, (details) => {
      this.log(`Join error: ${details.error}`, 'error')
      if (this.onJoinErrorCallback) {
        this.onJoinErrorCallback(details)
      }
    })

    // Create action for Yjs updates
    const [send, receive] = this.room.makeAction('yjs-update')
    this.sendUpdate = send

    // Listen for incoming updates
    receive((data: ArrayBuffer, peerId: string) => {
      this.log(`Received update from ${peerId} (${data.byteLength} bytes)`)
      if (this._callback) {
        // Convert ArrayBuffer to Uint8Array
        this._callback(new Uint8Array(data))
      }
    })

    // Track peers
    this.room.onPeerJoin((peerId) => {
      this.peers.add(peerId)
      this.log(`Peer joined: ${peerId} (${this.peers.size} total)`)
    })

    this.room.onPeerLeave((peerId) => {
      this.peers.delete(peerId)
      this.log(`Peer left: ${peerId} (${this.peers.size} remaining)`)
    })

    this._connected = true
    this.log(`✅ Connected to room: ${room}`)
  }

  disconnect(): void {
    if (!this._connected) {
      return
    }

    this.log('Disconnecting...')

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

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this._callback = callback
    this.log('Message callback registered')

    return () => {
      this._callback = undefined
      this.log('Message callback unregistered')
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
