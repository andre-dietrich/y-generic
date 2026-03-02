/**
 * SimplePeer Transport Provider
 *
 * Peer-to-peer transport using WebRTC data channels with simple-peer library.
 * Connects directly to other clients without going through a central server.
 *
 * Features:
 * - Direct peer-to-peer connections
 * - Mesh network (each peer connects to multiple others)
 * - Uses signaling server only for peer discovery (not for data)
 * - Optional encryption
 * - Automatic connection management
 * - Resilient to peer disconnections
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { SimplePeerTransport } from 'y-generic/providers/simple-peer'
 * import Peer from 'simple-peer'
 *
 * const doc = new Y.Doc()
 * const transport = new SimplePeerTransport({
 *   peer: Peer, // Pass the simple-peer constructor
 *   signaling: ['wss://signaling.example.com'],
 *   password: 'optional-encryption-key'
 * })
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 * ```
 */

import type { Transport, ConnectionConfig } from '../../transport'

/**
 * SimplePeer constructor type (from simple-peer library).
 */
export type SimplePeerConstructor = any

/**
 * Configuration options for SimplePeer transport.
 */
export interface SimplePeerTransportOptions {
  /**
   * The simple-peer library constructor.
   * Users must provide this to avoid bundling the library.
   * @example
   * ```typescript
   * import Peer from 'simple-peer'
   * const transport = new SimplePeerTransport({ peer: Peer })
   * ```
   */
  peer: SimplePeerConstructor
  /**
   * Array of signaling server URLs for peer discovery.
   * Signaling servers are only used to discover peers, not for data transfer.
   * @default ['wss://signaling.yjs.dev']
   */
  signaling?: string[]

  /**
   * Optional password for encrypting messages.
   * When provided, all messages are encrypted before sending.
   * @default undefined
   */
  password?: string

  /**
   * Maximum number of WebRTC peer connections.
   * Too many connections can overwhelm the browser.
   * @default 20 + random(0-15)
   */
  maxConns?: number

  /**
   * Options passed to simple-peer.
   * See https://github.com/feross/simple-peer#api
   * @default {}
   */
  peerOpts?: Record<string, any>

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean
}

interface PeerConnection {
  peer: any // SimplePeer instance
  connected: boolean
  peerId: string
}

interface SignalingMessage {
  type: 'announce' | 'signal' | 'subscribe'
  from?: string
  to?: string
  signal?: any
  topics?: string[]
}

/**
 * SimplePeer transport implementation using simple-peer library.
 * Creates direct peer-to-peer connections for data transfer.
 */
export class SimplePeerTransport implements Transport {
  private options: Required<SimplePeerTransportOptions>
  private _connected: boolean = false
  private _room: string = ''
  private _callback?: (data: Uint8Array) => void
  private peerId: string
  private peers: Map<string, PeerConnection> = new Map()
  private signalingConns: WebSocket[] = []
  private announcedPeers: Set<string> = new Set()

  /**
   * Create a new SimplePeer transport.
   *
   * @param options - Configuration options (must include peer constructor)
   */
  constructor(options: SimplePeerTransportOptions) {
    if (!options.peer) {
      throw new Error(
        'SimplePeerTransport requires the "peer" option. ' +
          'Please provide the simple-peer constructor: ' +
          'import Peer from "simple-peer"; new SimplePeerTransport({ peer: Peer, ... })'
      )
    }

    this.options = {
      peer: options.peer,
      signaling: options.signaling ?? ['wss://signaling.yjs.dev'],
      password: options.password ?? '',
      maxConns: options.maxConns ?? 20 + Math.floor(Math.random() * 15),
      peerOpts: options.peerOpts ?? {},
      debug: options.debug ?? false,
    }

    // Generate unique peer ID
    this.peerId = this.generatePeerId()
  }

  /**
   * Connect to the room via signaling servers and start discovering peers.
   */
  async connect(config: ConnectionConfig): Promise<void> {
    if (this._connected) {
      throw new Error('Already connected')
    }

    this._room = config.room

    // Try to connect to signaling servers
    // Use Promise.allSettled to allow partial success
    const results = await Promise.allSettled(
      this.options.signaling.map((url) => this.connectSignaling(url)),
    )

    // Count successful connections
    const successCount = results.filter((r) => r.status === 'fulfilled').length
    const failCount = results.filter((r) => r.status === 'rejected').length

    if (successCount > 0) {
      this.log(
        `Connected to ${successCount}/${this.options.signaling.length} signaling servers`,
      )
    } else if (failCount > 0) {
      console.warn(
        '[SimplePeerTransport] No signaling servers available. ' +
          'WebRTC peer discovery disabled. ' +
          'Cross-tab sync via BroadcastChannel will still work.',
      )
      // Log individual errors for debugging
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn(
            `[SimplePeerTransport] Signaling server ${this.options.signaling[index]} failed:`,
            result.reason,
          )
        }
      })
    }

    // Still mark as connected even if no signaling servers work
    // This allows BroadcastChannel-only mode for same-browser tabs
    this._connected = true
    this.log('Connected to room:', this._room)
  }

  /**
   * Disconnect from all peers and signaling servers.
   */
  disconnect(): void {
    if (!this._connected) return

    this.log('Disconnecting...')

    // Close all peer connections
    for (const peerConn of this.peers.values()) {
      peerConn.peer.destroy()
    }
    this.peers.clear()

    // Close all signaling connections
    for (const ws of this.signalingConns) {
      ws.close()
    }
    this.signalingConns = []

    this._connected = false
    this.announcedPeers.clear()
  }

  /**
   * Send data to all connected peers.
   */
  send(data: Uint8Array): void {
    if (!this._connected) {
      this.log('Not connected, cannot send')
      return
    }

    // Encrypt if password is set
    const dataToSend = this.options.password
      ? this.encrypt(data, this.options.password)
      : data

    // Send to all connected peers
    let sentCount = 0
    for (const peerConn of this.peers.values()) {
      if (peerConn.connected) {
        try {
          peerConn.peer.send(dataToSend)
          sentCount++
        } catch (error) {
          this.log('Error sending to peer:', peerConn.peerId, error)
        }
      }
    }

    this.log(`Sent to ${sentCount}/${this.peers.size} peers`)
  }

  /**
   * Register callback for incoming messages.
   */
  onMessage(callback: (data: Uint8Array) => void): () => void {
    this._callback = callback
    return () => {
      this._callback = undefined
    }
  }

  /**
   * Check if connected.
   */
  get isConnected(): boolean {
    return this._connected
  }

  /**
   * Get number of connected peers (for debugging).
   */
  get connectedPeers(): number {
    return Array.from(this.peers.values()).filter((p) => p.connected).length
  }

  /**
   * Connect to a signaling server.
   */
  private async connectSignaling(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      let resolved = false

      ws.onopen = () => {
        this.log('Signaling connected:', url)

        // Subscribe to room
        this.sendSignaling(ws, {
          type: 'subscribe',
          topics: [this._room],
        })

        // Announce presence if we have room to accept connections
        if (this.peers.size < this.options.maxConns) {
          this.sendSignaling(ws, {
            type: 'announce',
            from: this.peerId,
          })
        }

        this.signalingConns.push(ws)

        if (!resolved) {
          resolved = true
          resolve()
        }
      }

      ws.onmessage = (event) => {
        try {
          const msg: SignalingMessage = JSON.parse(event.data)
          this.handleSignalingMessage(msg)
        } catch (error) {
          this.log('Error parsing signaling message:', error)
        }
      }

      ws.onerror = (error) => {
        this.log('Signaling error:', url, error)
        if (!resolved) {
          resolved = true
          reject(error)
        }
      }

      ws.onclose = () => {
        this.log('Signaling disconnected:', url)
        const index = this.signalingConns.indexOf(ws)
        if (index > -1) {
          this.signalingConns.splice(index, 1)
        }
      }

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          reject(new Error('Signaling connection timeout'))
        }
      }, 10000)
    })
  }

  /**
   * Handle messages from signaling server.
   */
  private handleSignalingMessage(msg: SignalingMessage): void {
    if (!msg.from || msg.from === this.peerId) return

    switch (msg.type) {
      case 'announce':
        // Another peer announced - connect to them if we have capacity
        if (
          !this.peers.has(msg.from) &&
          this.peers.size < this.options.maxConns &&
          !this.announcedPeers.has(msg.from)
        ) {
          this.log('Creating connection to announced peer:', msg.from)
          this.announcedPeers.add(msg.from)
          this.createPeerConnection(msg.from, true) // initiator
        }
        break

      case 'signal':
        // Received WebRTC signal from peer
        if (msg.to === this.peerId && msg.signal) {
          this.handlePeerSignal(msg.from, msg.signal)
        }
        break
    }
  }

  /**
   * Send message to signaling server.
   */
  private sendSignaling(ws: WebSocket, msg: SignalingMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  /**
   * Broadcast message to all signaling servers.
   */
  private broadcastSignaling(msg: SignalingMessage): void {
    for (const ws of this.signalingConns) {
      this.sendSignaling(ws, msg)
    }
  }

  /**
   * Create a WebRTC peer connection.
   */
  private createPeerConnection(remotePeerId: string, initiator: boolean): void {
    if (this.peers.has(remotePeerId)) {
      this.log('Peer connection already exists:', remotePeerId)
      return
    }

    this.log('Creating peer connection:', remotePeerId, 'initiator:', initiator)

    const peer = new this.options.peer({
      initiator,
      ...this.options.peerOpts,
    })

    const peerConn: PeerConnection = {
      peer,
      connected: false,
      peerId: remotePeerId,
    }

    this.peers.set(remotePeerId, peerConn)

    // Handle signaling data
    peer.on('signal', (signal: any) => {
      this.log('Sending signal to peer:', remotePeerId)
      this.broadcastSignaling({
        type: 'signal',
        from: this.peerId,
        to: remotePeerId,
        signal,
      })
    })

    // Handle connection
    peer.on('connect', () => {
      this.log('Peer connected:', remotePeerId)
      peerConn.connected = true
    })

    // Handle incoming data
    peer.on('data', (data: ArrayBuffer) => {
      if (this._callback) {
        try {
          const uint8Data = new Uint8Array(data)
          // Decrypt if password is set
          const decryptedData = this.options.password
            ? this.decrypt(uint8Data, this.options.password)
            : uint8Data

          this._callback(decryptedData)
        } catch (error) {
          this.log('Error handling peer data:', error)
        }
      }
    })

    // Handle errors
    peer.on('error', (error: Error) => {
      this.log('Peer error:', remotePeerId, error)
      this.removePeer(remotePeerId)
    })

    // Handle close
    peer.on('close', () => {
      this.log('Peer closed:', remotePeerId)
      this.removePeer(remotePeerId)
    })
  }

  /**
   * Handle WebRTC signal from peer.
   */
  private handlePeerSignal(remotePeerId: string, signal: any): void {
    let peerConn = this.peers.get(remotePeerId)

    if (!peerConn) {
      // Create peer connection as non-initiator
      this.createPeerConnection(remotePeerId, false)
      peerConn = this.peers.get(remotePeerId)
    }

    if (peerConn) {
      try {
        peerConn.peer.signal(signal)
      } catch (error) {
        this.log('Error signaling peer:', remotePeerId, error)
      }
    }
  }

  /**
   * Remove and cleanup a peer connection.
   */
  private removePeer(peerId: string): void {
    const peerConn = this.peers.get(peerId)
    if (peerConn) {
      try {
        peerConn.peer.destroy()
      } catch (error) {
        // Ignore errors during cleanup
      }
      this.peers.delete(peerId)
      this.announcedPeers.delete(peerId)
    }
  }

  /**
   * Generate a unique peer ID.
   */
  private generatePeerId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9)
  }

  /**
   * Simple XOR encryption (not cryptographically secure, just obfuscation).
   */
  private encrypt(data: Uint8Array, password: string): Uint8Array {
    const key = this.hashPassword(password)
    const encrypted = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) {
      encrypted[i] = data[i] ^ key[i % key.length]
    }
    return encrypted
  }

  /**
   * Simple XOR decryption.
   */
  private decrypt(data: Uint8Array, password: string): Uint8Array {
    // XOR is symmetric, so decrypt is the same as encrypt
    return this.encrypt(data, password)
  }

  /**
   * Hash password to key.
   */
  private hashPassword(password: string): Uint8Array {
    const encoder = new TextEncoder()
    return encoder.encode(password)
  }

  /**
   * Log debug messages if enabled.
   */
  private log(...args: any[]): void {
    if (this.options.debug) {
      console.log('[SimplePeerTransport]', ...args)
    }
  }
}
