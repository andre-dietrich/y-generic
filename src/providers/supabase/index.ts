import * as Y from 'yjs'
import type { Transport, ConnectionConfig } from '../../transport'
import {
  createClient,
  SupabaseClient,
  RealtimeChannel,
} from '@supabase/supabase-js'

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
  /** Enable persistent mode (stores state in database) (default: false) */
  persistent?: boolean
  /** Database table name for persistent storage (default: 'yjs_documents') */
  tableName?: string
  /** Database column name for document data (default: 'content') */
  columnName?: string
  /** Database column name for document ID (default: 'id') */
  idColumnName?: string
  /** Debounce delay for database updates in ms (default: 2000) */
  persistDebounceMs?: number
  /**
   * The Yjs document to persist. Required when persistent is true.
   * The transport encodes the full document state on each debounced save.
   */
  doc?: Y.Doc
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
 * Features:
 * - Ephemeral mode: Peer-to-peer sync via Supabase Realtime (no database)
 * - Persistent mode: Database-backed sync with automatic persistence
 * - Optional password protection
 * - Room-based collaboration
 * - Debounced database updates
 * - Automatic retry on database errors
 *
 * @example
 * ```ts
 * // Ephemeral mode (states lost when all peers disconnect)
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { SupabaseTransport } from 'y-generic/providers/supabase'
 *
 * const doc = new Y.Doc()
 * const transport = new SupabaseTransport()
 *
 * await provider.connect({
 *   supabaseUrl: 'https://xxxxx.supabase.co',
 *   supabaseKey: 'your-anon-key',
 *   room: 'my-room',
 *   persistent: false
 * })
 *
 * // Persistent mode (states stored in database)
 * await provider.connect({
 *   supabaseUrl: 'https://xxxxx.supabase.co',
 *   supabaseKey: 'your-anon-key',
 *   room: 'my-room',
 *   persistent: true,
 *   password: 'optional-password'
 * })
 * ```
 */
export class SupabaseTransport implements Transport {
  private supabase: SupabaseClient | null = null
  private channel: RealtimeChannel | null = null
  private config: SupabaseConfig | null = null
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false
  private debug: boolean = false

  // Persistent mode
  private persistentMode: boolean = false
  private tableName: string = 'yjs_documents'
  private columnName: string = 'content'
  private idColumnName: string = 'id'
  private roomId: string = ''
  private persistDebounceMs: number = 2000
  private persistTimer?: ReturnType<typeof setTimeout>
  private doc: Y.Doc | null = null
  private isWritingToDb: boolean = false
  private savePending: boolean = false
  // Buffer for data loaded from DB before onMessage callback is registered
  private pendingLoad: Uint8Array | null = null

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(config: SupabaseConfig): Promise<void> {
    this.config = config
    this.debug = config.debug || false
    this.persistentMode = config.persistent || false
    this.tableName = config.tableName || 'yjs_documents'
    this.columnName = config.columnName || 'content'
    this.idColumnName = config.idColumnName || 'id'
    this.persistDebounceMs = config.persistDebounceMs || 2000

    if (!config.supabaseUrl || !config.supabaseKey) {
      throw new Error(
        'SupabaseTransport: supabaseUrl and supabaseKey are required',
      )
    }

    if (!config.room) {
      throw new Error('SupabaseTransport: room name is required')
    }

    if (config.persistent && !config.doc) {
      throw new Error(
        'SupabaseTransport: a Y.Doc must be provided via config.doc when persistent is true',
      )
    }

    this.doc = config.doc || null

    // Create Supabase client
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey)

    // Generate room ID (with optional password hashing)
    this.roomId = config.password
      ? `${config.room}-${await hashPassword(config.password)}`
      : config.room

    this.log(
      'Connecting to room:',
      this.roomId,
      this.persistentMode ? '(persistent)' : '(ephemeral)',
    )

    // Create and subscribe to channel
    this.channel = this.supabase.channel(this.roomId)

    // Listen for messages
    this.channel.on('broadcast', { event: 'message' }, (payload) => {
      this.handleMessage(payload.payload)
    })

    // Subscribe to channel
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Supabase channel subscription timeout'))
      }, 10000)

      this.channel!.subscribe((status) => {
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

    // Load from database AFTER connect() resolves so the onMessage callback
    // is already registered by GenericProvider before we deliver the data.
    // We store it in pendingLoad and flush it in onMessage().
    if (this.persistentMode) {
      await this.loadFromDatabase()
    }
  }

  async disconnect(): Promise<void> {
    this.log('Disconnecting...')

    // Flush pending updates
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    if (this.persistentMode && this.doc) {
      await this.saveToDatabase()
    }

    // Unsubscribe from channel
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

    // Queue for database persistence if enabled
    if (this.persistentMode) {
      this.queuePersist()
    }
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback

    // Flush any data that was loaded from the database before this callback
    // was registered (loadFromDatabase runs after connect() resolves, but
    // GenericProvider calls onMessage() immediately after connect() returns).
    if (this.pendingLoad) {
      const data = this.pendingLoad
      this.pendingLoad = null
      // Defer by one microtask so GenericProvider finishes its setup first
      Promise.resolve().then(() => callback(data))
    }

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

  private async loadFromDatabase(): Promise<void> {
    if (!this.supabase || !this.persistentMode) return

    try {
      this.log('Loading from database...')

      const { data, error } = await this.supabase
        .from(this.tableName)
        .select(this.columnName)
        .eq(this.idColumnName, this.roomId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          // No document found, will be created on first save
          this.log('No existing document found in database')
          return
        }
        throw error
      }

      if (data && (data as any)[this.columnName]) {
        const content = (data as any)[this.columnName] as string
        const uint8Array = this.base64ToUint8Array(content)

        if (uint8Array.length > 0) {
          const wrapped = addCRC32Header(uint8Array)
          if (this.messageCallback) {
            // Callback already registered — deliver immediately
            this.messageCallback(wrapped)
          } else {
            // Callback not yet registered — buffer until onMessage() is called
            this.pendingLoad = wrapped
          }
          this.log('Loaded', uint8Array.length, 'bytes from database')
        }
      }
    } catch (error: any) {
      this.log('Error loading from database:', error.message)
      console.warn('SupabaseTransport: Failed to load from database:', error)
    }
  }

  private queuePersist(): void {
    // Clear existing timer — always save the latest full state, not a specific delta
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
    }

    this.persistTimer = setTimeout(() => {
      this.saveToDatabase()
    }, this.persistDebounceMs)
  }

  private async saveToDatabase(): Promise<void> {
    if (!this.supabase || !this.persistentMode || !this.doc) return

    // If a write is in progress, mark a save as pending and return.
    // The finally block will re-trigger with the latest doc state when done.
    if (this.isWritingToDb) {
      this.savePending = true
      return
    }

    this.isWritingToDb = true
    this.savePending = false

    try {
      // Always encode the full current document state — never individual deltas
      const state = Y.encodeStateAsUpdate(this.doc)
      const base64 = this.uint8ArrayToBase64(state)

      this.log('Saving to database...', state.length, 'bytes')

      const { error } = await this.supabase
        .from(this.tableName)
        .upsert({ [this.idColumnName]: this.roomId, [this.columnName]: base64 })

      if (error) throw error

      this.log('Saved to database successfully')
    } catch (error: any) {
      this.log('Error saving to database:', error.message)
      console.warn(
        'SupabaseTransport: Failed to save to database. Will retry later.',
        error,
      )
      this.savePending = true
    } finally {
      this.isWritingToDb = false

      // If the doc changed while we were writing, save the latest state now
      if (this.savePending) {
        setTimeout(() => this.saveToDatabase(), 1000)
      }
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
