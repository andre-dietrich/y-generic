import type { Transport, ConnectionConfig } from '../../src/transport'

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
