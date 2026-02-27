import type { Transport, ConnectionConfig } from '../../src/transport'

/**
 * Example IndexedDB transport implementation.
 * Shows how to implement the Transport interface for local persistence.
 * This is a "transport" that doesn't actually transport but persists locally.
 */
export class IndexedDBTransport implements Transport {
  private db: IDBDatabase | null = null
  private dbName: string = ''
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.dbName = `yjs-${config.room}`

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1)

      request.onerror = () => reject(new Error('Failed to open IndexedDB'))

      request.onsuccess = () => {
        this.db = request.result
        this._isConnected = true

        // Load existing updates
        this._loadUpdates().then(() => resolve())
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains('updates')) {
          db.createObjectStore('updates', { autoIncrement: true })
        }
      }
    })
  }

  disconnect(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    this._isConnected = false
  }

  send(data: Uint8Array): void {
    if (!this.db) return

    const transaction = this.db.transaction(['updates'], 'readwrite')
    const store = transaction.objectStore('updates')
    store.add(data)
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback
    return () => {
      this.messageCallback = undefined
    }
  }

  private async _loadUpdates(): Promise<void> {
    if (!this.db || !this.messageCallback) return

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['updates'], 'readonly')
      const store = transaction.objectStore('updates')
      const request = store.getAll()

      request.onsuccess = () => {
        const updates = request.result as Uint8Array[]
        updates.forEach((update) => {
          this.messageCallback?.(update)
        })
        resolve()
      }

      request.onerror = () => reject(new Error('Failed to load updates'))
    })
  }
}
