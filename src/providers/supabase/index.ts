import type { Transport, ConnectionConfig } from '../../transport'

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options passed to the SupabaseTransport constructor.
 *
 * The `createClient` function must be supplied by the caller so that the
 * transport works with the Supabase JS library loaded from any source
 * (CDN, ESM import, or otherwise) without bundling it as a hard dependency.
 *
 * @example
 * ```ts
 * // CDN usage — supabase global is exposed by the <script> tag
 * const transport = new SupabaseTransport({
 *   createClient: (globalThis as any).supabase.createClient,
 * })
 * ```
 */
export interface SupabaseTransportOptions {
  /** The `createClient` function from the Supabase JS library. */
  createClient: (url: string, key: string) => any
}

// ---------------------------------------------------------------------------
// CRC32 helpers (GenericProvider wraps messages with CRC32 header)
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

/** Strip the 4-byte CRC32 header that GenericProvider prepends. */
function stripCRC32Header(data: Uint8Array): Uint8Array {
  return data.length >= 4 ? data.subarray(4) : data
}

// ---------------------------------------------------------------------------
// Password hashing helper (simple hash for channel name obfuscation)
// ---------------------------------------------------------------------------

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Supabase transport configuration
 */
export interface SupabaseConfig extends ConnectionConfig {
  /** Supabase project URL (required) e.g., 'https://xxxxx.supabase.co' */
  supabaseUrl: string
  /** Supabase anon/public key (required) */
  supabaseKey: string
  /** Room/channel name for collaboration (required) */
  room: string
  /** Optional password to secure the room */
  password?: string
  /** Enable debug logging */
  debug?: boolean
}

// ---------------------------------------------------------------------------
// Supabase Transport Implementation
// ---------------------------------------------------------------------------

/**
 * Supabase Transport for Yjs
 *
 * Provides real-time synchronization using Supabase Realtime channels.
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { SupabaseTransport } from 'y-generic/providers/supabase'
 *
 * const doc = new Y.Doc()
 * const transport = new SupabaseTransport({
 *   createClient: (globalThis as any).supabase.createClient,
 * })
 * const provider = new GenericProvider(doc, transport)
 *
 * await provider.connect({
 *   supabaseUrl: 'https://xxxxx.supabase.co',
 *   supabaseKey: 'your-anon-key',
 *   room: 'my-room',
 * })
 * ```
 */
export class SupabaseTransport implements Transport {
  private supabase: any = null
  private channel: any = null
  private config: SupabaseConfig | null = null
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false
  private debug: boolean = false
  private roomId: string = ''

  constructor(private readonly options: SupabaseTransportOptions) {}

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(config: SupabaseConfig): Promise<void> {
    this.config = config
    this.debug = config.debug || false

    if (!config.supabaseUrl || !config.supabaseKey) {
      throw new Error(
        'SupabaseTransport: supabaseUrl and supabaseKey are required',
      )
    }

    if (!config.room) {
      throw new Error('SupabaseTransport: room name is required')
    }

    // Create Supabase client using the injected createClient function
    this.supabase = this.options.createClient(
      config.supabaseUrl,
      config.supabaseKey,
    )

    // Generate room ID (with optional password hashing)
    this.roomId = config.password
      ? `${config.room}-${await hashPassword(config.password)}`
      : config.room

    this.log('Connecting to room:', this.roomId)

    // Create and subscribe to channel
    this.channel = this.supabase.channel(this.roomId)

    // Listen for messages
    this.channel.on('broadcast', { event: 'message' }, (payload: any) => {
      this.handleMessage(payload.payload)
    })

    // Subscribe to channel
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Supabase channel subscription timeout'))
      }, 10000)

      this.channel!.subscribe((status: any) => {
        clearTimeout(timeout)
        if (status === 'SUBSCRIBED') {
          this._isConnected = true
          this.log('Connected to Supabase channel')
          resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`Supabase subscription failed: ${status}`))
        }
      })
    })
  }

  async disconnect(): Promise<void> {
    this.log('Disconnecting...')

    if (this.channel) {
      await this.channel.unsubscribe()
      this.channel = null
    }

    this._isConnected = false
    this.supabase = null
    this.config = null
    this.messageCallback = undefined
  }

  send(data: Uint8Array): void {
    if (!this._isConnected || !this.channel) {
      this.log('Cannot send: not connected')
      return
    }

    // Strip CRC32 header before sending
    const payload = stripCRC32Header(data)

    // Convert Uint8Array to base64 for JSON transport
    const base64 = this.uint8ArrayToBase64(payload)

    // Broadcast to channel
    this.channel.send({
      type: 'broadcast',
      event: 'message',
      payload: base64,
    })
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback
    return () => {
      this.messageCallback = undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private handleMessage(payload: any): void {
    if (!this.messageCallback) return

    try {
      // Convert base64 back to Uint8Array
      const data =
        typeof payload === 'string'
          ? this.base64ToUint8Array(payload)
          : new Uint8Array(0)

      // Add CRC32 header for GenericProvider
      const wrapped = addCRC32Header(data)

      this.messageCallback(wrapped)
    } catch (error) {
      this.log('Error handling message:', error)
    }
  }

  // Utility methods for base64 conversion
  private uint8ArrayToBase64(data: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i])
    }
    return btoa(binary)
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  private log(...args: any[]): void {
    if (this.debug) {
      console.log('[SupabaseTransport]', ...args)
    }
  }
}
