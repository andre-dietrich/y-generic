import type { Transport, ConnectionConfig } from '../../transport'

// ---------------------------------------------------------------------------
// CRC32 translation helpers
//
// GenericProvider wraps every message as [CRC32 (4 bytes)][payload] before
// calling transport.send(), and expects the same format from onMessage().
// The y-websocket server however speaks plain Yjs wire format (no header).
// These helpers translate between the two worlds at the transport boundary.
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

/**
 * WebSocket transport configuration
 */
export interface WebSocketConfig extends ConnectionConfig {
  /** WebSocket server URL (required) e.g., 'ws://localhost:1234' or 'wss://example.com' */
  serverUrl: string
  /** Enable automatic reconnection on disconnect (default: true) */
  autoReconnect?: boolean
  /** Reconnection delay in milliseconds (default: 2000) */
  reconnectDelay?: number
  /** Maximum reconnection attempts (0 = infinite, default: 0) */
  maxReconnectAttempts?: number
  /** WebSocket protocols (optional) */
  protocols?: string | string[]
  /** Enable debug logging */
  debug?: boolean
}

/**
 * WebSocket Transport for Yjs
 *
 * Provides real-time synchronization using WebSocket connections.
 *
 * Features:
 * - Direct WebSocket connection to server
 * - Room-based collaboration
 * - Automatic reconnection
 * - Binary message support
 * - Low latency real-time sync
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { WebSocketTransport } from 'y-generic/providers/websocket'
 *
 * const doc = new Y.Doc()
 * const transport = new WebSocketTransport()
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   serverUrl: 'ws://localhost:1234',
 *   room: 'my-room'
 * })
 * ```
 */
export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null
  private config: WebSocketConfig | null = null
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false
  private debug: boolean = false
  private reconnectAttempts: number = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private intentionalDisconnect: boolean = false
  private messageQueue: Uint8Array[] = [] // Queue messages until connected
  private receivedBuffer: Uint8Array[] = [] // Buffer messages received before callback registered

  get isConnected(): boolean {
    return this._isConnected
  }

  /**
   * Connect to WebSocket server
   */
  async connect(config: WebSocketConfig): Promise<void> {
    this.config = config
    this.debug = config.debug ?? false
    this.intentionalDisconnect = false

    if (!config.serverUrl) {
      throw new Error('WebSocket serverUrl is required')
    }

    if (!config.room) {
      throw new Error('Room name is required')
    }

    // Build URL with room (y-websocket compatible)
    let wsUrl = config.serverUrl
    // Remove trailing slash if present
    if (wsUrl.endsWith('/')) {
      wsUrl = wsUrl.slice(0, -1)
    }
    // Append room name to URL path
    wsUrl = `${wsUrl}/${encodeURIComponent(config.room)}`

    this.log(`Connecting to WebSocket server: ${wsUrl}`)

    return new Promise((resolve, reject) => {
      try {
        // Create WebSocket connection with room in URL (y-websocket style)
        this.ws = new WebSocket(wsUrl, config.protocols)
        this.ws.binaryType = 'arraybuffer'

        const timeout = setTimeout(() => {
          if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            this.ws.close()
            reject(new Error('WebSocket connection timeout'))
          }
        }, 10000)

        this.ws.onopen = () => {
          clearTimeout(timeout)
          this._isConnected = true
          this.reconnectAttempts = 0
          this.log(`✅ WebSocket connected to room: ${config.room}`)

          // Flush queued messages
          this.flushMessageQueue()

          resolve()
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onerror = (error) => {
          clearTimeout(timeout)
          this.log('❌ WebSocket error:', error)

          if (!this._isConnected) {
            reject(new Error('WebSocket connection failed'))
          }
        }

        this.ws.onclose = (event) => {
          clearTimeout(timeout)
          this._isConnected = false
          this.log(
            `WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}`,
          )

          // Attempt reconnection if not intentional
          if (!this.intentionalDisconnect && (config.autoReconnect ?? true)) {
            this.attemptReconnect()
          }
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.intentionalDisconnect = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    if (this.ws) {
      this.log('Disconnecting from WebSocket...')
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }

    this._isConnected = false
  }

  /**
   * Send data to server
   */
  send(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('⚠️ WebSocket not ready, queueing message')
      this.messageQueue.push(data)
      return
    }

    try {
      // Strip CRC32 header added by GenericProvider before sending to server
      const raw = stripCRC32Header(data)
      this.ws.send(raw)
      this.log(`📤 Sent ${raw.length} bytes (${data.length} with header)`)
    } catch (error) {
      this.log('❌ Send error:', error)
    }
  }

  /**
   * Register message callback
   */
  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback

    // Flush any buffered messages that arrived before callback was registered
    if (this.receivedBuffer.length > 0) {
      this.log(
        `📦 Flushing ${this.receivedBuffer.length} buffered received messages`,
      )
      for (const data of this.receivedBuffer) {
        callback(data)
      }
      this.receivedBuffer = []
    }

    return () => {
      this.messageCallback = undefined
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: ArrayBuffer | string): void {
    try {
      if (typeof data === 'string') {
        // Handle text messages (control messages)
        this.log('📨 Received text message:', data)
        return
      }

      // Wrap plain y-websocket message with CRC32 header expected by GenericProvider
      const uint8Data = addCRC32Header(new Uint8Array(data))
      this.log(`📨 Received ${uint8Data.length - 4} bytes`)

      if (this.messageCallback) {
        this.messageCallback(uint8Data)
      } else {
        // Buffer message if callback not registered yet (race condition)
        this.log('⏳ Buffering message (callback not yet registered)')
        this.receivedBuffer.push(uint8Data)
      }
    } catch (error) {
      this.log('❌ Error handling message:', error)
    }
  }

  /**
   * Flush queued messages
   */
  private flushMessageQueue(): void {
    if (this.messageQueue.length === 0) return

    this.log(`📦 Flushing ${this.messageQueue.length} queued messages`)

    for (const data of this.messageQueue) {
      this.send(data)
    }

    this.messageQueue = []
  }

  /**
   * Attempt to reconnect
   */
  private attemptReconnect(): void {
    if (!this.config) return

    const maxAttempts = this.config.maxReconnectAttempts ?? 0
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      this.log(`❌ Max reconnection attempts (${maxAttempts}) reached`)
      return
    }

    this.reconnectAttempts++
    const delay = this.config.reconnectDelay ?? 2000

    this.log(
      `🔄 Attempting reconnection #${this.reconnectAttempts} in ${delay}ms...`,
    )

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect(this.config!)
        this.log('✅ Reconnected successfully')
      } catch (error) {
        this.log('❌ Reconnection failed:', error)
      }
    }, delay)
  }

  /**
   * Debug logging
   */
  private log(message: string, ...args: any[]): void {
    if (this.debug) {
      console.log(`[WebSocketTransport] ${message}`, ...args)
    }
  }
}
