import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import type { Transport, ConnectionConfig } from '../../transport'
import { addCRC32Header, stripCRC32Header, toBase64, fromBase64, hashPassword } from '../codec'
import { splitChunks, isChunk, ChunkAssembler } from '../chunking'

// GenericProvider's full-state push frame (see src/index.ts).
const MESSAGE_SYNC_PUSH = 6

// Realtime caps a broadcast at 256 KB on the free tier (3 MB above). Below
// this the raw bytes go out as a binary payload (supabase-js >= 2.91.0 on
// EVERY peer - an older client drops binary broadcasts silently); above
// it, base64 chunks in the JSON path.
const MAX_BINARY_BYTES = 200000
const MAX_CHUNK_CHARS = 200000

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
  /**
   * Persist the document in a table so a room survives its last peer
   * leaving: the full state is loaded on connect and written (debounced)
   * after every document update. Needs a table with columns `id TEXT
   * PRIMARY KEY`, `content TEXT` (see the README for the SQL and the RLS
   * policy the anon key needs). Not usable together with
   * `compressionThresholdBytes` (send() strips the CRC32 header at a fixed
   * offset). @default false
   */
  persistent?: boolean
  /** The Y.Doc to persist. Required when persistent is true. */
  doc?: Y.Doc
  /** Table name. @default 'yjs_documents' */
  tableName?: string
  /** Debounce delay in ms before a database write. @default 2000 */
  persistDebounceMs?: number
  /**
   * The longest a change waits for its write while the debounce keeps being
   * restarted - by somebody who types: nothing was written for as long as
   * that went on (test/supabase/repro-persistent.ts, part 4). @default 10000
   */
  persistMaxWaitMs?: number
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
  // No preferredCompressMinBytes: send() strips the CRC32 header, which
  // assumes the uncompressed frame layout (see compressionThresholdBytes).
  private config: SupabaseConfig | null = null
  private messageCallback?: (data: Uint8Array, from?: string) => void
  private _peerDisconnectCallback?: (peerId: string) => void
  // Our id on the channel: the presence key we track under, and the suffix
  // of the broadcast event name (`m:<id>`) every message goes out with, so
  // receivers get it as `from`. Round 5, item 2: with a leave signal
  // GenericProvider drops a departed peer's presence at once and stretches
  // the awareness lease to 5 minutes - the 15 s renewal broadcasts, 80 % of
  // an idle room's messages, stop. Same-version rule: an older peer listens
  // for event 'message' only and never sees these frames.
  private peerId: string = Math.random().toString(36).slice(2, 10)
  private chunks = new ChunkAssembler()
  private _isConnected: boolean = false
  private debug: boolean = false
  private roomId: string = ''
  // Persistence (see SupabaseConfig.persistent)
  private persistentMode: boolean = false
  private doc: Y.Doc | null = null
  private tableName: string = 'yjs_documents'
  private persistDebounceMs: number = 2000
  private persistMaxWaitMs: number = 10000
  // When the oldest change the pending write is for was made; 0 = none pending
  private persistPendingSince = 0
  private persistTimer?: ReturnType<typeof setTimeout>
  private isWritingToDb: boolean = false
  private savePending: boolean = false
  // State loaded from the table before GenericProvider registered onMessage
  private pendingLoad: Uint8Array | null = null
  /**
   * A write is for a change made HERE (a local transaction); a change applied
   * from the room is its author's to write. Told from send()'s frame before:
   * every digest beacon wrote the whole document, in a room nobody edits, from
   * every peer (test/supabase/repro-persistent.ts, parts 1 and 2).
   */
  private _onDocUpdate = (_u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction): void => {
    if (tr.local) this.queuePersist()
  }

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

    this.persistentMode = config.persistent ?? false
    this.doc = config.doc ?? null
    this.tableName = config.tableName ?? 'yjs_documents'
    this.persistDebounceMs = config.persistDebounceMs ?? 2000
    this.persistMaxWaitMs = config.persistMaxWaitMs ?? 10000
    if (this.persistentMode && !this.doc) {
      throw new Error(
        'SupabaseTransport: a Y.Doc must be provided via config.doc when persistent is true',
      )
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

    // Create and subscribe to channel; our presence key is our peer id.
    this.channel = this.supabase.channel(this.roomId, {
      config: { presence: { key: this.peerId } },
    })

    // Listen for messages: `m:<peerId>` from a current peer (the id becomes
    // `from`), 'message' from an older one.
    this.channel.on('broadcast', { event: '*' }, (msg: any) => {
      const event = typeof msg?.event === 'string' ? msg.event : ''
      const from = event.startsWith('m:') ? event.slice(2) : undefined
      if (from === this.peerId) return
      if (from === undefined && event !== 'message') return
      this.handleMessage(msg.payload, from)
    })

    // Presence: a peer's channel went away (clean unsubscribe, closed tab,
    // or the server's timeout after a dead connection). Delivered to every
    // subscriber, so GenericProvider handles it without a broadcast burst.
    this.channel.on('presence', { event: 'leave' }, (event: any) => {
      const key = event?.key
      if (typeof key === 'string' && key !== this.peerId) {
        this.log('Peer left:', key)
        this._peerDisconnectCallback?.(key)
      }
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
          // Join the presence set under our key; the promise resolves with
          // 'ok' or an error status, neither blocks the connect.
          Promise.resolve(this.channel?.track({ joined_at: Date.now() })).catch(
            (error: unknown) => this.log('presence track failed:', error),
          )
          resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`Supabase subscription failed: ${status}`))
        }
      })
    })

    if (this.persistentMode) {
      await this.loadFromDatabase()
      this.doc!.on('update', this._onDocUpdate)
    }
  }

  async disconnect(): Promise<void> {
    this.log('Disconnecting...')

    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    this.doc?.off('update', this._onDocUpdate)
    if (this.persistentMode && this.doc) {
      try {
        await this.saveToDatabase()
      } catch (error) {
        this.log('Error flushing to database on disconnect:', error)
      }
    }

    if (this.channel) {
      await this.channel.unsubscribe()
      this.channel = null
    }

    this._isConnected = false
    this.supabase = null
    this.config = null
    this.messageCallback = undefined
    this.pendingLoad = null
    this.persistPendingSince = 0
  }

  send(data: Uint8Array): void {
    if (!this._isConnected || !this.channel) {
      this.log('Cannot send: not connected')
      return
    }

    // Strip CRC32 header before sending
    const payload = stripCRC32Header(data)

    if (payload.length <= MAX_BINARY_BYTES) {
      // Binary broadcast: no base64 (33 % smaller on the wire)
      this.channel.send({
        type: 'broadcast',
        event: 'm:' + this.peerId,
        payload: payload.buffer.slice(
          payload.byteOffset,
          payload.byteOffset + payload.byteLength,
        ),
      })
      return
    }

    // Too large for one broadcast: base64 chunks through the JSON path
    const base64 = toBase64(payload)
    for (const chunk of splitChunks(base64, MAX_CHUNK_CHARS)) {
      this.channel.send({ type: 'broadcast', event: 'm:' + this.peerId, payload: chunk })
    }
  }

  onMessage(callback: (data: Uint8Array, from?: string) => void): () => void {
    this.messageCallback = callback
    // State loaded from the table before GenericProvider registered this
    // callback (connect() resolves first): deliver it now, one microtask
    // later so the provider has finished its own setup.
    if (this.pendingLoad) {
      const data = this.pendingLoad
      this.pendingLoad = null
      Promise.resolve().then(() => callback(data))
    }
    return () => {
      this.messageCallback = undefined
    }
  }

  /**
   * Transport.onPeerDisconnect: Supabase presence 'leave' for the channel.
   * Peer ids are presence keys, the same id `onMessage` passes as `from`.
   */
  onPeerDisconnect(callback: (peerId: string) => void): () => void {
    this._peerDisconnectCallback = callback
    return () => {
      this._peerDisconnectCallback = undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence: one row per room, `content` = base64 of the full state
  // ---------------------------------------------------------------------------

  /**
   * Deliver the stored state as a MESSAGE_SYNC_PUSH frame - the provider
   * applies it like a peer's full-state push: no hash check, no `synced`
   * flip (a stored copy says nothing about who is online).
   */
  private async loadFromDatabase(): Promise<void> {
    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select('content')
        .eq('id', this.roomId)
        .maybeSingle()
      if (error) throw error
      if (!data?.content) {
        this.log('No stored document for this room yet')
        return
      }
      const update = fromBase64(data.content)
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC_PUSH)
      encoding.writeVarUint8Array(enc, update)
      const frame = addCRC32Header(encoding.toUint8Array(enc))
      if (this.messageCallback) this.messageCallback(frame)
      else this.pendingLoad = frame
      this.log('Loaded', update.length, 'bytes from the database')
    } catch (error: any) {
      this.log('Error loading from database:', error?.message ?? error)
      console.warn('SupabaseTransport: failed to load from database:', error)
    }
  }

  /** Debounced, but never beyond persistMaxWaitMs after the oldest change. */
  private queuePersist(): void {
    const now = Date.now()
    if (!this.persistPendingSince) this.persistPendingSince = now
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(
      () => {
        this.persistTimer = undefined
        this.saveToDatabase()
      },
      Math.max(0, Math.min(this.persistDebounceMs, this.persistPendingSince + this.persistMaxWaitMs - now)),
    )
  }

  /**
   * Transport.flush: the page is unloading. A write still in its debounce
   * goes now - its request leaves in this task; a page that goes runs no
   * further timer (test/supabase/repro-persistent.ts, part 3).
   */
  flush(): void {
    if (!this.persistTimer) return
    clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    void this.saveToDatabase()
  }

  /** Upsert the full current state; a write that overlaps a change re-runs once. */
  private async saveToDatabase(): Promise<void> {
    if (!this.supabase || !this.persistentMode || !this.doc) return
    if (this.isWritingToDb) {
      this.savePending = true
      return
    }
    this.isWritingToDb = true
    this.savePending = false
    this.persistPendingSince = 0
    try {
      const state = Y.encodeStateAsUpdate(this.doc)
      const { error } = await this.supabase.from(this.tableName).upsert({
        id: this.roomId,
        content: toBase64(state),
        updated_at: new Date().toISOString(),
      })
      if (error) throw error
      this.log('Saved', state.length, 'bytes to the database')
    } catch (error: any) {
      this.log('Error saving to database:', error?.message ?? error)
      console.warn('SupabaseTransport: failed to save to database, will retry:', error)
      this.savePending = true
    } finally {
      this.isWritingToDb = false
      if (this.savePending) setTimeout(() => this.saveToDatabase(), 1000)
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private handleMessage(payload: any, from?: string): void {
    if (!this.messageCallback) return

    try {
      let data: Uint8Array
      if (payload instanceof ArrayBuffer) {
        data = new Uint8Array(payload)
      } else if (ArrayBuffer.isView(payload)) {
        data = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
      } else if (typeof payload === 'string') {
        data = fromBase64(payload) // an older sender
      } else if (isChunk(payload)) {
        const whole = this.chunks.push(payload)
        if (whole === null) return
        data = fromBase64(whole)
      } else {
        return
      }

      // Add CRC32 header for GenericProvider
      const wrapped = addCRC32Header(data)

      this.messageCallback(wrapped, from)
    } catch (error) {
      this.log('Error handling message:', error)
    }
  }

  // Utility methods for base64 conversion

  private log(...args: any[]): void {
    if (this.debug) {
      console.log('[SupabaseTransport]', ...args)
    }
  }
}
