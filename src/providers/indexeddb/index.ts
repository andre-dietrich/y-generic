/**
 * IndexedDB Transport Provider
 *
 * Persistent local storage transport using browser's IndexedDB.
 * Unlike P2P transports, this provider stores document updates locally
 * for persistence across browser sessions.
 *
 * Features:
 * - Persists the document's updates as they happen - and nothing else: the
 *   provider's presence, beacons and requests are not stored (round 7,
 *   item 6: stored and replayed, they resurrected the previous session as a
 *   phantom peer and cost ~10x the bytes)
 * - Loads the stored updates as one merged update and trims the log to
 *   that one row (every load appends a full-document push otherwise)
 * - Lossless compaction (merge), on by default
 * - Works offline (no network required)
 * - Supports multiple documents/rooms
 * - Pairs with a network provider on the same document through
 *   `connect({ waitFor })` (see ConnectionConfig.waitFor)
 * - Not for a provider with `compressionThresholdBytes` set: the frame
 *   parser expects the plain CRC-wrapped frame
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { IndexedDBTransport } from 'y-generic/providers/indexeddb'
 *
 * const doc = new Y.Doc()
 * const transport = new IndexedDBTransport()
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-document' })
 *
 * // Updates are automatically persisted to IndexedDB
 * doc.getText('content').insert(0, 'Hello, World!')
 *
 * // On next page load, updates are automatically restored
 * ```
 *
 * @example
 * ```typescript
 * // Compact (merge the rows into one) every 100 updates instead of 500
 * const transport = new IndexedDBTransport({ compactThreshold: 100 })
 * ```
 */

import * as Y from 'yjs'
import type { Transport, ConnectionConfig } from '../../transport'
import { extractDocUpdates, frameDocUpdate } from '../../index'

/**
 * One row of the `updates` store. Rows written before round 7 hold a whole
 * provider frame (CRC-wrapped, any message type) and no `raw` flag; rows
 * since hold one Yjs update. The loader reads both.
 */
interface UpdateRow {
  update: Uint8Array
  timestamp: number
  raw?: boolean
}

/**
 * Configuration options for IndexedDB transport.
 */
export interface IndexedDBTransportOptions {
  /**
   * Database name prefix. The actual database name will be `{prefix}-{room}`.
   * @default 'yjs'
   */
  prefix?: string

  /**
   * Database version. Increment to trigger schema upgrade.
   * @default 1
   */
  version?: number

  /**
   * Compact (merge every row into one) when the row count reaches this
   * threshold; 0 = use `maxUpdates`.
   * @default 0
   */
  compactThreshold?: number

  /**
   * Compact automatically at the threshold. Lossless since round 7 (it used
   * to delete the oldest 90 % of rows - the document), hence on by default.
   * @default true
   */
  autoCompact?: boolean

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean

  /**
   * Row count at which auto-compaction runs when `compactThreshold` is 0.
   * @default 500
   */
  maxUpdates?: number

  /**
   * Object store name for storing updates.
   * @default 'updates'
   */
  storeName?: string
}

/**
 * IndexedDB transport implementation.
 * Provides local persistence for Yjs documents using browser IndexedDB.
 */
export class IndexedDBTransport implements Transport {
  private options: Required<IndexedDBTransportOptions>
  private db: IDBDatabase | null = null
  private dbName: string = ''
  private _room: string = ''
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false
  private updateCount: number = 0
  private isLoading: boolean = false

  constructor(options: IndexedDBTransportOptions = {}) {
    this.options = {
      prefix: options.prefix ?? 'yjs',
      version: options.version ?? 1,
      compactThreshold: options.compactThreshold ?? 0,
      autoCompact: options.autoCompact ?? true,
      debug: options.debug ?? false,
      maxUpdates: options.maxUpdates ?? 500,
      storeName: options.storeName ?? 'updates',
    }
  }

  /**
   * Log debug messages if debug mode is enabled.
   */
  private log(...args: any[]): void {
    if (this.options.debug) {
      console.log('[IndexedDBTransport]', ...args)
    }
  }

  /**
   * Check if connected to database.
   */
  get isConnected(): boolean {
    return this._isConnected
  }

  /**
   * Get current room name.
   */
  get room(): string {
    return this._room
  }

  /**
   * Connect to IndexedDB and load existing updates.
   */
  async connect(config: ConnectionConfig): Promise<void> {
    if (this._isConnected) {
      throw new Error('Already connected to IndexedDB')
    }

    this._room = config.room
    this.dbName = `${this.options.prefix}-${config.room}`

    this.log('Connecting to database:', this.dbName)

    await this.openDatabase()

    // Load existing updates if callback is registered
    if (this.messageCallback) {
      await this.loadUpdates()
    }

    this._isConnected = true
    this.log('Connected successfully')
  }

  /**
   * Open the IndexedDB database.
   */
  private openDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.options.version)

      request.onerror = () => {
        const error = new Error(
          `Failed to open IndexedDB: ${request.error?.message}`,
        )
        this.log('Error opening database:', error)
        reject(error)
      }

      request.onsuccess = () => {
        this.db = request.result
        this.log('Database opened successfully')
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        this.log('Upgrading database schema...')

        // Create updates object store
        if (!db.objectStoreNames.contains(this.options.storeName)) {
          const store = db.createObjectStore(this.options.storeName, {
            autoIncrement: true,
          })
          // Create index for timestamps (useful for cleanup)
          store.createIndex('timestamp', 'timestamp', { unique: false })
          this.log('Created object store:', this.options.storeName)
        }

        // Create metadata store for compaction info
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata')
          this.log('Created metadata store')
        }
      }
    })
  }

  /**
   * Disconnect from database.
   */
  disconnect(): void {
    if (!this._isConnected) return

    this.log('Disconnecting...')

    if (this.db) {
      this.db.close()
      this.db = null
    }

    this._isConnected = false
    this.messageCallback = undefined
    this.updateCount = 0

    this.log('Disconnected')
  }

  /**
   * Store what the frame carries of the document - one row per frame that
   * carries anything. Presence, beacons and requests are the provider's
   * conversation with the room, and this transport is not the room: stored
   * and replayed on the next load they resurrected the previous session's
   * clientID as a phantom peer and were answered into the store again
   * (round 7, item 6; test/dummy/bench-persist-log.ts).
   */
  send(data: Uint8Array): void {
    if (!this.db) {
      this.log('Cannot send: database not connected')
      return
    }

    // Don't store updates while loading
    if (this.isLoading) {
      return
    }

    const updates = extractDocUpdates(data)
    if (updates.length === 0) return
    const update = updates.length === 1 ? updates[0].slice() : Y.mergeUpdates(updates)

    try {
      const transaction = this.db.transaction(
        [this.options.storeName],
        'readwrite',
      )
      const store = transaction.objectStore(this.options.storeName)

      const record: UpdateRow = { update, timestamp: Date.now(), raw: true }

      const request = store.add(record)

      request.onsuccess = () => {
        this.updateCount++
        this.log('Stored update, count:', this.updateCount)

        // Check if we need to compact
        if (this.shouldCompact()) {
          this.compact().catch((err) => {
            this.log('Compaction failed:', err)
          })
        }
      }

      request.onerror = () => {
        this.log('Failed to store update:', request.error)
      }
    } catch (error) {
      this.log('Error storing update:', error)
    }
  }

  /**
   * Register callback for incoming messages (loaded updates).
   */
  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback

    // If already connected, load updates immediately
    if (this._isConnected && !this.isLoading) {
      this.loadUpdates().catch((err) => {
        this.log('Failed to load updates:', err)
      })
    }

    return () => {
      this.messageCallback = undefined
    }
  }

  /**
   * Load the stored document: every row merged into one update, handed to
   * the provider as one SyncStep2 (`frameDocUpdate`: applied, `synced`
   * fires, nothing is sent back) and written back as that one row. Every
   * page load appends a full-document push (GenericProvider's connect), so
   * without the trim the log grew by one document per load - y-indexeddb
   * trims the same way at its PREFERRED_TRIM_SIZE.
   */
  private async loadUpdates(): Promise<void> {
    if (!this.db || !this.messageCallback) {
      return
    }

    this.isLoading = true
    this.log('Loading updates from database...')
    let merged: Uint8Array | null
    try {
      merged = await this.mergeStore()
    } finally {
      // Off before the delivery: an edit made from a `synced` handler must
      // be stored, and the loaded state itself never comes back through
      // send() (the provider applies it under its own origin).
      this.isLoading = false
    }
    this.log(merged === null ? 'Nothing stored' : `Loaded ${merged.length} bytes`)
    if (merged !== null) this.messageCallback?.(frameDocUpdate(merged))
  }

  /**
   * The stored document as one update: every row read, merged and - when
   * there was more than one, or one in the pre-round-7 frame format -
   * written back as one row, all in one readwrite transaction (a
   * concurrent send() queues behind it, so nothing added meanwhile can be
   * cleared away). Rows that carry no document state (old presence or
   * beacon frames) are dropped. Null for an empty store. Shared by
   * loadUpdates() and compact().
   */
  private mergeStore(): Promise<Uint8Array | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.options.storeName],
        'readwrite',
      )
      const store = transaction.objectStore(this.options.storeName)
      let merged: Uint8Array | null = null

      const request = store.getAll()
      request.onsuccess = () => {
        const rows = request.result as UpdateRow[]
        const updates = rows.flatMap((row) =>
          row.raw ? [row.update] : extractDocUpdates(row.update),
        )
        if (updates.length === 0) {
          if (rows.length > 0) store.clear()
          this.updateCount = 0
          return
        }
        merged = updates.length === 1 ? updates[0].slice() : Y.mergeUpdates(updates)
        if (rows.length > 1 || !rows[0].raw) {
          store.clear()
          const row: UpdateRow = { update: merged, timestamp: Date.now(), raw: true }
          store.add(row)
        }
        this.updateCount = 1
      }

      transaction.oncomplete = () => resolve(merged)
      transaction.onerror = () => {
        const error = new Error(
          `Failed to read updates: ${transaction.error?.message ?? 'unknown error'}`,
        )
        this.log('Error loading updates:', error)
        reject(error)
      }
      transaction.onabort = () => {
        reject(new Error('Reading updates was aborted'))
      }
    })
  }

  /**
   * Check if compaction should be triggered.
   */
  private shouldCompact(): boolean {
    if (!this.options.autoCompact) {
      return false
    }

    if (this.options.compactThreshold > 0) {
      return this.updateCount >= this.options.compactThreshold
    }

    return this.updateCount >= this.options.maxUpdates
  }

  /**
   * Merge every stored row into one. Lossless - it used to delete the
   * oldest 90 % of rows, i.e. the document (round 7, item 6).
   */
  async compact(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected')
    }

    this.log('Compacting...')
    await this.mergeStore()
    this.log('Compaction complete, rows:', this.updateCount)
  }

  /**
   * Clear all stored updates for the current room.
   */
  async clear(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected')
    }

    this.log('Clearing all updates...')

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.options.storeName],
        'readwrite',
      )
      const store = transaction.objectStore(this.options.storeName)
      const request = store.clear()

      request.onsuccess = () => {
        this.updateCount = 0
        this.log('All updates cleared')
        resolve()
      }

      request.onerror = () => {
        const error = new Error('Failed to clear updates')
        this.log('Clear error:', error)
        reject(error)
      }
    })
  }

  /**
   * Get statistics about stored data.
   */
  async getStats(): Promise<{
    updateCount: number
    databaseName: string
    storeName: string
  }> {
    if (!this.db) {
      throw new Error('Database not connected')
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.options.storeName],
        'readonly',
      )
      const store = transaction.objectStore(this.options.storeName)
      const request = store.count()

      request.onsuccess = () => {
        resolve({
          updateCount: request.result,
          databaseName: this.dbName,
          storeName: this.options.storeName,
        })
      }

      request.onerror = () => {
        reject(new Error('Failed to get stats'))
      }
    })
  }

  /**
   * Delete the entire database.
   * Warning: This is irreversible!
   */
  static async deleteDatabase(
    room: string,
    prefix: string = 'yjs',
  ): Promise<void> {
    const dbName = `${prefix}-${room}`

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName)

      request.onsuccess = () => {
        console.log('[IndexedDBTransport] Deleted database:', dbName)
        resolve()
      }

      request.onerror = () => {
        const error = new Error(`Failed to delete database: ${dbName}`)
        console.error('[IndexedDBTransport]', error)
        reject(error)
      }

      request.onblocked = () => {
        console.warn(
          '[IndexedDBTransport] Database deletion blocked. Close all connections first.',
        )
      }
    })
  }
}
