/**
 * Ably Transport Provider
 *
 * Real-time synchronization using Ably's managed pub/sub messaging platform.
 *
 * Features:
 * - Global edge network with low latency
 * - Built-in presence tracking
 * - API-key or token-based authentication
 * - Optional password-protected rooms (channel name obfuscation)
 * - Automatic chunking for messages above Ably's size limit
 *
 * The Ably SDK class is injected via the constructor (not imported directly)
 * so this file compiles without the `ably` package installed, and consumers
 * only pull in Ably if they actually use this provider.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { AblyTransport } from 'y-generic/providers/ably'
 * import * as Ably from 'ably'
 *
 * const doc = new Y.Doc()
 * const transport = new AblyTransport({ Realtime: Ably.Realtime })
 * const provider = new GenericProvider(doc, transport)
 *
 * await provider.connect({
 *   apiKey: 'your-ably-api-key',
 *   room: 'my-collab-room',
 * })
 * ```
 *
 * @example Token auth (recommended for browser clients)
 * ```typescript
 * await provider.connect({
 *   authUrl: '/api/ably-token',
 *   room: 'my-collab-room',
 * })
 * ```
 */

import type { Transport, ConnectionConfig } from '../../transport'

// ---------------------------------------------------------------------------
// CRC32 translation helpers
//
// GenericProvider wraps every outgoing message as [CRC32 (4 bytes)][payload].
// Ably message data is JSON-friendly, so we strip the CRC32 header before
// base64-encoding and re-add it after decoding so GenericProvider accepts
// the incoming message.
// ---------------------------------------------------------------------------

const _CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function _crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++)
    crc = (crc >>> 8) ^ _CRC32_TABLE[(crc ^ data[i]) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

/** Strip the 4-byte CRC32 header that GenericProvider prepends. */
function stripCRC32Header(data: Uint8Array): Uint8Array {
  return data.length >= 4 ? data.subarray(4) : data
}

/** Add a valid CRC32 header so GenericProvider accepts the message. */
function addCRC32Header(data: Uint8Array): Uint8Array {
  const crc = _crc32(data)
  const wrapped = new Uint8Array(4 + data.length)
  wrapped[0] = (crc >>> 24) & 0xff
  wrapped[1] = (crc >>> 16) & 0xff
  wrapped[2] = (crc >>> 8) & 0xff
  wrapped[3] = crc & 0xff
  wrapped.set(data, 4)
  return wrapped
}

// ---------------------------------------------------------------------------
// Base64 helpers (no Buffer/Node dependency)
// ---------------------------------------------------------------------------

function uint8ToBase64(data: Uint8Array): string {
  const chunkSize = 8192 // Process 8KB at a time to avoid arg-count overflow
  let binary = ''
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, Math.min(i + chunkSize, data.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function base64ToUint8(str: string): Uint8Array {
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Password hashing (obfuscates channel name — not encryption)
// ---------------------------------------------------------------------------

async function hashPassword(password: string): Promise<string> {
  const encoded = new TextEncoder().encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16)
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// ---------------------------------------------------------------------------
// Structural types for the injected Ably SDK surface (not the real `ably`
// types, so this file compiles without the package installed)
// ---------------------------------------------------------------------------

interface AblyConnectionLike {
  state: string
  once(event: string, cb: (stateChange?: any) => void): void
  on(event: string, cb: (stateChange?: any) => void): void
  off(event?: string, cb?: (...args: any[]) => void): void
}

interface AblyPresenceLike {
  enter(data?: any): Promise<void>
  leave(data?: any): Promise<void>
  get(): Promise<Array<{ clientId: string }>>
}

interface AblyChannelLike {
  subscribe(callback: (message: { data: any }) => void): Promise<void> | void
  unsubscribe(callback?: (message: { data: any }) => void): void
  publish(eventName: string, data: any): Promise<void>
  presence: AblyPresenceLike
  detach(): Promise<void>
}

interface AblyClientLike {
  connection: AblyConnectionLike
  channels: { get(name: string): AblyChannelLike }
  close(): void
}

/** Constructor options for AblyTransport. */
export interface AblyTransportOptions {
  /**
   * The `Realtime` class from the Ably JS SDK.
   * @example import * as Ably from 'ably'; new AblyTransport({ Realtime: Ably.Realtime })
   */
  Realtime: new (options: Record<string, any>) => AblyClientLike
  /** Enable debug logging. @default false */
  debug?: boolean
}

/** Connection configuration for AblyTransport. */
export interface AblyConfig extends ConnectionConfig {
  /** Ably API key (quick setup/testing). Avoid exposing this in production browser code. */
  apiKey?: string
  /** Token-auth endpoint — recommended for browser clients instead of `apiKey`. */
  authUrl?: string
  /** HTTP method used for `authUrl`. @default 'GET' */
  authMethod?: 'GET' | 'POST'
  /** Room/channel name for collaboration (required) */
  room: string
  /** Optional password to obfuscate the channel name */
  password?: string
  /** Enable debug logging (overrides constructor option) */
  debug?: boolean
}

const EVENT_NAME = 'yjs-update'
// Ably's default max message size is ~64 KiB; stay well under it (after base64).
const MAX_MESSAGE_SIZE = 55000

/**
 * Ably transport for y-generic.
 *
 * Publishes Yjs binary updates as base64-encoded messages on an Ably channel
 * and subscribes to matching messages from peers.
 */
export class AblyTransport implements Transport {
  private readonly opts: AblyTransportOptions
  private client: AblyClientLike | null = null
  private channel: AblyChannelLike | null = null
  private clientId: string = ''
  private channelName: string = ''
  private _isConnected: boolean = false
  private debug: boolean = false
  private messageCallback?: (data: Uint8Array) => void
  private messageBuffer: Uint8Array[] = []
  private chunkBuffer: Map<string, Map<number, string>> = new Map()

  constructor(options: AblyTransportOptions) {
    this.opts = options
  }

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(config: AblyConfig): Promise<void> {
    this.debug = config.debug ?? this.opts.debug ?? false

    if (!config.apiKey && !config.authUrl) {
      throw new Error('AblyTransport: apiKey or authUrl is required')
    }
    if (!config.room) {
      throw new Error('AblyTransport: room name is required')
    }

    this.clientId = generateUUID()
    this.channelName = config.password
      ? `${config.room}-${await hashPassword(config.password)}`
      : config.room

    // Don't deliver our own published messages back to ourselves.
    const clientOptions: Record<string, any> = {
      clientId: this.clientId,
      echoMessages: false,
    }
    if (config.apiKey) clientOptions.key = config.apiKey
    if (config.authUrl) clientOptions.authUrl = config.authUrl
    if (config.authMethod) clientOptions.authMethod = config.authMethod

    this.log('Connecting as', this.clientId, 'to channel', this.channelName)

    this.client = new this.opts.Realtime(clientOptions)
    this.channel = this.client.channels.get(this.channelName)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Ably connection timeout'))
      }, 10000)

      this.client!.connection.once('connected', () => {
        clearTimeout(timeout)
        this._isConnected = true
        this.log('Connected to Ably')
        resolve()
      })

      this.client!.connection.on('failed', (stateChange: any) => {
        clearTimeout(timeout)
        reject(new Error(`Ably connection failed: ${stateChange?.reason?.message ?? 'unknown error'}`))
      })

      this.client!.connection.on('suspended', () => {
        this.log('Connection suspended')
        this._isConnected = false
      })

      this.client!.connection.on('disconnected', () => {
        this.log('Connection disconnected')
        this._isConnected = false
      })
    })

    await this.channel.subscribe((message) => this.handleMessage(message.data))
    await this.channel.presence.enter()
  }

  async disconnect(): Promise<void> {
    this.log('Disconnecting...')

    if (this.channel) {
      try {
        await this.channel.presence.leave()
      } catch (error) {
        this.log('Error leaving presence:', error)
      }
      this.channel.unsubscribe()
      this.channel = null
    }

    if (this.client) {
      this.client.close()
      this.client = null
    }

    this._isConnected = false
    this.messageCallback = undefined
    this.messageBuffer = []
    this.chunkBuffer.clear()
  }

  send(data: Uint8Array): void {
    if (!this.channel || !this._isConnected) {
      this.log('Cannot send: not connected')
      return
    }

    const payload = stripCRC32Header(data)
    const base64Data = uint8ToBase64(payload)

    if (base64Data.length > MAX_MESSAGE_SIZE) {
      this.sendChunked(base64Data, payload.length)
      return
    }

    this.channel.publish(EVENT_NAME, base64Data).catch((error) => {
      this.log('Publish error:', error)
    })
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback

    if (this.messageBuffer.length > 0) {
      for (const data of this.messageBuffer) {
        callback(data)
      }
      this.messageBuffer = []
    }

    return () => {
      this.messageCallback = undefined
    }
  }

  /** Get the clientIds of other peers currently present on the channel. */
  async getPresence(): Promise<string[]> {
    if (!this.channel || !this._isConnected) {
      return []
    }
    try {
      const members = await this.channel.presence.get()
      return members
        .map((m) => m.clientId)
        .filter((id) => id !== this.clientId)
    } catch (error) {
      this.log('Error getting presence:', error)
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private sendChunked(base64Data: string, originalSize: number): void {
    const chunkId = generateUUID()
    const chunks: string[] = []
    for (let i = 0; i < base64Data.length; i += MAX_MESSAGE_SIZE) {
      chunks.push(base64Data.slice(i, i + MAX_MESSAGE_SIZE))
    }

    this.log(
      `Splitting ${originalSize} bytes into ${chunks.length} chunks (id: ${chunkId.slice(0, 8)}...)`,
    )

    chunks.forEach((chunk, index) => {
      const message = { chunked: true, id: chunkId, index, total: chunks.length, data: chunk }
      this.channel!.publish(EVENT_NAME, message).catch((error) => {
        this.log(`Failed to send chunk ${index + 1}:`, error)
      })
    })
  }

  private handleChunkedMessage(message: {
    id: string
    index: number
    total: number
    data: string
  }): void {
    const { id, index, total, data } = message

    if (!this.chunkBuffer.has(id)) {
      this.chunkBuffer.set(id, new Map())
    }
    const chunks = this.chunkBuffer.get(id)!
    chunks.set(index, data)

    if (chunks.size !== total) return

    let base64Data = ''
    for (let i = 0; i < total; i++) {
      const chunk = chunks.get(i)
      if (!chunk) {
        this.log(`Missing chunk ${i}, cannot reassemble message ${id}`)
        this.chunkBuffer.delete(id)
        return
      }
      base64Data += chunk
    }
    this.chunkBuffer.delete(id)

    try {
      const raw = base64ToUint8(base64Data)
      this.deliver(addCRC32Header(raw))
    } catch (error) {
      this.log('Error reassembling chunked message:', error)
    }
  }

  private handleMessage(data: any): void {
    try {
      if (data && typeof data === 'object' && data.chunked) {
        this.handleChunkedMessage(data)
        return
      }
      if (typeof data !== 'string') return

      const raw = base64ToUint8(data)
      this.deliver(addCRC32Header(raw))
    } catch (error) {
      this.log('Error handling message:', error)
    }
  }

  private deliver(data: Uint8Array): void {
    if (this.messageCallback) {
      this.messageCallback(data)
    } else {
      this.messageBuffer.push(data)
    }
  }

  private log(...args: any[]): void {
    if (this.debug) {
      console.log('[AblyTransport]', ...args)
    }
  }
}
