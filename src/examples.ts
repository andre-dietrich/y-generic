import type { Transport, ConnectionConfig } from './transport'

/**
 * Example WebSocket transport implementation.
 * Shows how to implement the Transport interface for WebSocket communication.
 */
export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(config: ConnectionConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      // Build WebSocket URL
      const baseUrl = config.url || 'ws://localhost:1234'
      const url = `${baseUrl}/${config.room}`

      this.ws = new WebSocket(url)
      this.ws.binaryType = 'arraybuffer'

      this.ws.onopen = () => {
        this._isConnected = true
        resolve()
      }

      this.ws.onerror = (error) => {
        reject(new Error('WebSocket connection failed'))
      }

      this.ws.onclose = () => {
        this._isConnected = false
      }

      this.ws.onmessage = (event) => {
        if (this.messageCallback) {
          this.messageCallback(new Uint8Array(event.data))
        }
      }
    })
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this._isConnected = false
  }

  send(data: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data)
    }
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback
    return () => {
      this.messageCallback = undefined
    }
  }
}

/**
 * Example PubNub transport implementation.
 * Shows how to implement the Transport interface for PubNub pub/sub.
 */
export class PubNubTransport implements Transport {
  private pubnub: any = null
  private channel: string = ''
  private uuid: string = ''
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(
    config: ConnectionConfig & {
      publishKey: string
      subscribeKey: string
    },
  ): Promise<void> {
    if (!config.publishKey || !config.subscribeKey) {
      throw new Error('PubNub requires publishKey and subscribeKey')
    }

    // Generate unique ID for this client
    this.uuid = crypto.randomUUID()
    this.channel = btoa(config.room)

    // @ts-ignore - PubNub global
    this.pubnub = new PubNub({
      publishKey: config.publishKey,
      subscribeKey: config.subscribeKey,
      uuid: this.uuid,
      cipherKey: config.password,
    })

    return new Promise((resolve) => {
      this.pubnub.addListener({
        status: (statusEvent: any) => {
          if (statusEvent.category === 'PNConnectedCategory') {
            this._isConnected = true
            resolve()
          }
        },
        message: (event: any) => {
          // Ignore our own messages
          if (event.publisher === this.uuid) return

          if (this.messageCallback && event.message) {
            // Convert base64 to Uint8Array if needed
            const data =
              typeof event.message === 'string'
                ? this._base64ToUint8(event.message)
                : new Uint8Array(event.message)
            this.messageCallback(data)
          }
        },
      })

      this.pubnub.subscribe({
        channels: [this.channel],
      })
    })
  }

  disconnect(): void {
    if (this.pubnub) {
      this.pubnub.unsubscribeAll()
      this.pubnub = null
    }
    this._isConnected = false
  }

  send(data: Uint8Array): void {
    if (this.pubnub && this._isConnected) {
      this.pubnub.publish({
        channel: this.channel,
        message: this._uint8ToBase64(data),
        storeInHistory: false,
      })
    }
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback
    return () => {
      this.messageCallback = undefined
    }
  }

  private _uint8ToBase64(data: Uint8Array): string {
    return btoa(String.fromCharCode(...data))
  }

  private _base64ToUint8(str: string): Uint8Array {
    return new Uint8Array(
      atob(str)
        .split('')
        .map((c) => c.charCodeAt(0)),
    )
  }
}

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
