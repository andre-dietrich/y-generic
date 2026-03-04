import type { Transport, ConnectionConfig } from '../../transport'

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
  /**
   * Password for end-to-end encryption.
   * When set, all messages are encrypted with AES-GCM before sending.
   * All peers in the room must use the same password.
   * @default undefined (no encryption)
   */
  password?: string
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
 * - Optional password encryption (AES-GCM)
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
 *
 * @example Password-protected room
 * ```ts
 * await provider.connect({
 *   serverUrl: 'wss://example.com',
 *   room: 'secure-room',
 *   password: 'my-secret-password'  // E2E encrypted
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
  private cryptoKey: CryptoKey | null = null // Derived encryption key
  private encryptionEnabled: boolean = false

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

    // Initialize encryption if password provided
    if (config.password) {
      await this.initEncryption(config.password)
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

    // Encrypt if password is set (async but we don't await - fire and forget)
    if (this.encryptionEnabled && this.cryptoKey) {
      this.encryptAndSend(data)
    } else {
      this.sendRaw(data)
    }
  }

  /**
   * Encrypt and send data
   */
  private async encryptAndSend(data: Uint8Array): Promise<void> {
    try {
      const encrypted = await this.encrypt(data)
      this.sendRaw(encrypted)
    } catch (error) {
      this.log('❌ Encryption error:', error)
    }
  }

  /**
   * Send raw data without encryption
   */
  private sendRaw(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    try {
      // Send raw binary data (y-websocket compatible)
      this.ws.send(data)
      this.log(
        `📤 Sent ${data.length} bytes${this.encryptionEnabled ? ' (encrypted)' : ''}`,
      )
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
  private async handleMessage(data: ArrayBuffer | string): Promise<void> {
    try {
      if (typeof data === 'string') {
        // Handle text messages (control messages)
        this.log('📨 Received text message:', data)
        return
      }

      // Binary message
      let uint8Data: Uint8Array = new Uint8Array(data)

      // Decrypt if encryption is enabled
      if (this.encryptionEnabled && this.cryptoKey) {
        try {
          const decrypted = await this.decrypt(uint8Data)
          uint8Data = new Uint8Array(decrypted)
        } catch (error) {
          this.log('❌ Decryption failed (wrong password?):', error)
          return
        }
      }

      this.log(
        `📨 Received ${uint8Data.length} bytes${this.encryptionEnabled ? ' (decrypted)' : ''}`,
      )

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

  /**
   * Initialize encryption with password using PBKDF2 key derivation.
   */
  private async initEncryption(password: string): Promise<void> {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error(
        'WebCrypto API not available - cannot use password encryption',
      )
    }

    // Use room name + password as key material for domain separation
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey'],
    )

    // Derive AES-GCM key using PBKDF2
    // Use room name as salt for domain separation between rooms
    const salt = new TextEncoder().encode(
      `yjs-websocket-${this.config?.room || 'default'}`,
    )

    this.cryptoKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )

    this.encryptionEnabled = true
    this.log('🔐 Encryption enabled (AES-256-GCM)')
  }

  /**
   * Encrypt data using AES-GCM.
   * Format: [IV (12 bytes)][ciphertext][auth tag (16 bytes)]
   */
  private async encrypt(data: Uint8Array): Promise<Uint8Array> {
    if (!this.cryptoKey) {
      throw new Error('Encryption key not initialized')
    }

    // Generate random IV (12 bytes for AES-GCM)
    const iv = crypto.getRandomValues(new Uint8Array(12))

    // Ensure data is backed by ArrayBuffer (not SharedArrayBuffer)
    const dataBuffer = new Uint8Array(data).buffer

    // Encrypt with AES-GCM
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.cryptoKey,
      dataBuffer,
    )

    // Prepend IV to ciphertext
    const result = new Uint8Array(iv.length + ciphertext.byteLength)
    result.set(iv, 0)
    result.set(new Uint8Array(ciphertext), iv.length)

    return result
  }

  /**
   * Decrypt data using AES-GCM.
   */
  private async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (!this.cryptoKey) {
      throw new Error('Encryption key not initialized')
    }

    if (data.length < 12) {
      throw new Error('Invalid encrypted data (too short)')
    }

    // Extract IV (first 12 bytes)
    const iv = new Uint8Array(data.slice(0, 12))
    const ciphertext = new Uint8Array(data.slice(12))

    // Decrypt with AES-GCM
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer },
      this.cryptoKey,
      ciphertext.buffer,
    )

    return new Uint8Array(plaintext)
  }
}
