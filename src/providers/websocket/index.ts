import type { Transport, ConnectionConfig } from '../../transport'

export interface WebSocketConfig extends ConnectionConfig {
  /** e.g. 'wss://example.com'; the room is appended as a path segment. */
  serverUrl: string
  /** @default true */
  autoReconnect?: boolean
  /** ms between attempts. @default 2000 */
  reconnectDelay?: number
  /** 0 = unlimited. @default 0 */
  maxReconnectAttempts?: number
  protocols?: string | string[]
  debug?: boolean
  /**
   * Reconnect after this many ms without a received message (half-open
   * socket), like y-websocket's client. 0 disables. @default 30000
   */
  messageTimeout?: number
}

/**
 * WebSocket transport, URL layout compatible with y-websocket servers.
 *
 * @example
 * ```ts
 * const provider = new GenericProvider(doc, new WebSocketTransport())
 * await provider.connect({ serverUrl: 'wss://example.com', room: 'my-room' })
 * ```
 */
export class WebSocketTransport implements Transport {
  /** The server relays every frame to all clients in the room. */
  readonly reachesAllPeers = true
  private ws: WebSocket | null = null
  private config: WebSocketConfig | null = null
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false
  private debug: boolean = false
  private reconnectAttempts: number = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private intentionalDisconnect: boolean = false
  private messageQueue: Uint8Array[] = [] // sent while not open
  private receivedBuffer: Uint8Array[] = [] // received before onMessage()
  private lastMessageAt: number = 0
  private livenessTimer?: ReturnType<typeof setInterval>
  private wsUrl: string = ''
  // connect()'s promise, settled by the first attempt that opens.
  private pendingConnect?: {
    resolve: () => void
    reject: (error: Error) => void
  }

  get isConnected(): boolean {
    return this._isConnected
  }

  /**
   * Resolves once a socket is open. With `autoReconnect`, failed attempts
   * are retried instead of rejecting; it rejects only when retrying is off
   * or exhausted, or disconnect() is called first.
   */
  async connect(config: WebSocketConfig): Promise<void> {
    if (!config.serverUrl) {
      throw new Error('WebSocket serverUrl is required')
    }

    if (!config.room) {
      throw new Error('Room name is required')
    }

    this.config = config
    this.debug = config.debug ?? false
    this.intentionalDisconnect = false
    this.reconnectAttempts = 0

    let wsUrl = config.serverUrl
    if (wsUrl.endsWith('/')) {
      wsUrl = wsUrl.slice(0, -1)
    }
    this.wsUrl = `${wsUrl}/${encodeURIComponent(config.room)}`

    return new Promise((resolve, reject) => {
      this.pendingConnect = { resolve, reject }
      this.openSocket()
    })
  }

  private settleConnect(error?: Error): void {
    const pending = this.pendingConnect
    if (!pending) return
    this.pendingConnect = undefined
    if (error) pending.reject(error)
    else pending.resolve()
  }

  private get autoReconnect(): boolean {
    return this.config?.autoReconnect ?? true
  }

  /** One connection attempt; on failure, retries or rejects connect(). */
  private openSocket(): void {
    if (!this.config) return
    const config = this.config
    this.log(`Connecting to WebSocket server: ${this.wsUrl}`)

    let ws: WebSocket
    try {
      ws = new WebSocket(this.wsUrl, config.protocols)
      ws.binaryType = 'arraybuffer'
    } catch (error) {
      this.connectFailed(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.ws = ws

    const timeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) return
      this.log('⏱️ WebSocket connection timeout')
      // Abandon the attempt so it can't open late next to its retry; the
      // close handshake of a socket that never opened can hang.
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close()
      } catch {
        // already closing
      }
      if (this.ws === ws) this.ws = null
      this.connectFailed(new Error('WebSocket connection timeout'))
    }, 10000)

    ws.onopen = () => {
      clearTimeout(timeout)
      this._isConnected = true
      this.reconnectAttempts = 0
      this.log(`✅ WebSocket connected to room: ${config.room}`)
      this.startLivenessCheck()
      this.flushMessageQueue()

      this.settleConnect()
    }

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now()
      this.handleMessage(event.data)
    }

    ws.onerror = (error) => {
      // onclose always follows and decides about retrying.
      this.log('❌ WebSocket error:', error)
    }

    ws.onclose = (event) => {
      clearTimeout(timeout)
      this.stopLivenessCheck()
      const wasOpen = this._isConnected
      this._isConnected = false
      if (this.ws === ws) this.ws = null
      this.log(
        `WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}`,
      )
      if (this.intentionalDisconnect) return

      if (wasOpen) {
        if (this.autoReconnect) this.attemptReconnect()
      } else {
        this.connectFailed(new Error('WebSocket connection failed'))
      }
    }
  }

  /** A socket that never opened: retry, or give up and reject connect(). */
  private connectFailed(error: Error): void {
    if (this.intentionalDisconnect) return
    if (!this.autoReconnect || !this.attemptReconnect()) {
      this.settleConnect(error)
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true
    this.settleConnect(new Error('WebSocket disconnected before it connected'))
    this.stopLivenessCheck()

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

  /** Send now, or queue until the socket opens. */
  send(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('⚠️ WebSocket not ready, queueing message')
      this.messageQueue.push(data)
      return
    }

    try {
      this.ws.send(data)
      this.log(`📤 Sent ${data.length} bytes`)
    } catch (error) {
      this.log('❌ Send error:', error)
    }
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback

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

  private handleMessage(data: ArrayBuffer | string): void {
    try {
      if (typeof data === 'string') {
        // Text frames aren't part of the protocol; log and ignore.
        this.log('📨 Received text message:', data)
        return
      }

      const uint8Data = new Uint8Array(data)
      this.log(`📨 Received ${uint8Data.length} bytes`)

      if (this.messageCallback) {
        this.messageCallback(uint8Data)
      } else {
        this.log('⏳ Buffering message (callback not yet registered)')
        this.receivedBuffer.push(uint8Data)
      }
    } catch (error) {
      this.log('❌ Error handling message:', error)
    }
  }

  private flushMessageQueue(): void {
    if (this.messageQueue.length === 0) return

    this.log(`📦 Flushing ${this.messageQueue.length} queued messages`)

    for (const data of this.messageQueue) {
      this.send(data)
    }

    this.messageQueue = []
  }

  /**
   * Reconnect a socket that stays OPEN but receives nothing (dead TCP path,
   * NAT or proxy timeout); the browser may not fire onclose for minutes.
   */
  private startLivenessCheck(): void {
    this.stopLivenessCheck()
    const timeout = this.config?.messageTimeout ?? 30000
    if (timeout <= 0) return
    this.lastMessageAt = Date.now()
    this.livenessTimer = setInterval(() => {
      const silentFor = Date.now() - this.lastMessageAt
      if (!this.ws || silentFor <= timeout) return
      this.log(`💀 No message for ${silentFor}ms, reconnecting`)
      // Don't wait for onclose: on a dead path the close handshake can hang.
      const ws = this.ws
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close()
      } catch {
        // already closing
      }
      this.ws = null
      this._isConnected = false
      this.stopLivenessCheck()
      if (!this.intentionalDisconnect && (this.config?.autoReconnect ?? true)) {
        this.attemptReconnect()
      }
    }, Math.max(100, timeout / 10))
  }

  private stopLivenessCheck(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = undefined
    }
  }

  /** Schedule the next attempt; false once `maxReconnectAttempts` is used up. */
  private attemptReconnect(): boolean {
    if (!this.config) return false
    if (this.reconnectTimer) return true // already scheduled

    const maxAttempts = this.config.maxReconnectAttempts ?? 0
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      this.log(`❌ Max reconnection attempts (${maxAttempts}) reached`)
      return false
    }

    this.reconnectAttempts++
    const delay = this.config.reconnectDelay ?? 2000

    this.log(
      `🔄 Attempting reconnection #${this.reconnectAttempts} in ${delay}ms...`,
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.intentionalDisconnect) return
      this.openSocket()
    }, delay)
    return true
  }

  private log(message: string, ...args: any[]): void {
    if (this.debug) {
      console.log(`[WebSocketTransport] ${message}`, ...args)
    }
  }
}
