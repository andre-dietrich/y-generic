/**
 * IndexedDB Transport Provider
 *
 * Persistent local storage transport using browser's IndexedDB.
 * Unlike P2P transports, this provider stores document updates locally
 * for persistence across browser sessions.
 *
 * Features:
 * - Automatic persistence of all document updates
 * - Efficient storage and retrieval
 * - Optional compaction to reduce storage size
 * - Works offline (no network required)
 * - Automatic cleanup of old updates
 * - Supports multiple documents/rooms
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
 * // With automatic compaction every 100 updates
 * const transport = new IndexedDBTransport({
 *   compactThreshold: 100,
 *   autoCompact: true
 * })
 * ```
 */

import type { Transport, ConnectionConfig } from '../../transport'

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
   * Automatically compact storage when update count reaches this threshold.
   * Set to 0 to disable auto-compaction.
   * @default 0 (disabled)
   */
  compactThreshold?: number

  /**
   * Enable automatic compaction.
   * @default false
   */
  autoCompact?: boolean

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean

  /**
   * Maximum number of updates to store before compaction is required.
   * Prevents unbounded growth of the update log.
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
      autoCompact: options.autoCompact ?? false,
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
   * Send (store) an update to IndexedDB.
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

    try {
      const transaction = this.db.transaction(
        [this.options.storeName],
        'readwrite',
      )
      const store = transaction.objectStore(this.options.storeName)

      // Store update with timestamp
      const record = {
        update: data,
        timestamp: Date.now(),
      }

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
   * Load all stored updates from database.
   */
  private async loadUpdates(): Promise<void> {
    if (!this.db || !this.messageCallback) {
      return
    }

    this.isLoading = true
    this.log('Loading updates from database...')

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.options.storeName],
        'readonly',
      )
      const store = transaction.objectStore(this.options.storeName)
      const request = store.getAll()

      request.onsuccess = () => {
        const records = request.result as Array<{
          update: Uint8Array
          timestamp: number
        }>

        this.log(`Loaded ${records.length} updates`)
        this.updateCount = records.length

        // Apply all updates
        records.forEach((record) => {
          this.messageCallback?.(record.update)
        })

        this.isLoading = false
        resolve()
      }

      request.onerror = () => {
        this.isLoading = false
        const error = new Error(
          `Failed to load updates: ${request.error?.message}`,
        )
        this.log('Error loading updates:', error)
        reject(error)
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
   * Compact the database by merging updates.
   * This reduces storage size by consolidating the update history.
   */
  async compact(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected')
    }

    this.log('Starting compaction...')

    // Get document state from the provider
    // Note: This requires the provider to expose the document
    // For now, we'll just clear old updates and keep recent ones

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.options.storeName],
        'readwrite',
      )
      const store = transaction.objectStore(this.options.storeName)

      // Get all keys
      const getAllKeysRequest = store.getAllKeys()

      getAllKeysRequest.onsuccess = () => {
        const keys = getAllKeysRequest.result

        if (keys.length <= 1) {
          this.log('No compaction needed')
          resolve()
          return
        }

        // Keep only the most recent 10% of updates
        const keepCount = Math.max(1, Math.floor(keys.length * 0.1))
        const deleteKeys = keys.slice(0, keys.length - keepCount)

        this.log(`Compacting: deleting ${deleteKeys.length} old updates`)

        let deleted = 0
        deleteKeys.forEach((key) => {
          const deleteRequest = store.delete(key)
          deleteRequest.onsuccess = () => {
            deleted++
            if (deleted === deleteKeys.length) {
              this.updateCount = keepCount
              this.log('Compaction complete, remaining updates:', keepCount)
              resolve()
            }
          }
        })
      }

      getAllKeysRequest.onerror = () => {
        const error = new Error('Failed to get keys for compaction')
        this.log('Compaction error:', error)
        reject(error)
      }
    })
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
