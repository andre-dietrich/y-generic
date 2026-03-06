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
 * ICE server configuration for STUN/TURN servers.
 * Used to establish WebRTC connections through NAT/firewalls.
 */
export interface IceServer {
  /**
   * STUN/TURN server URLs.
   * @example ['stun:stun.l.google.com:19302']
   * @example ['turn:turn.example.com:3478']
   */
  urls: string | string[]
  /**
   * Username for TURN server authentication.
   */
  username?: string
  /**
   * Credential for TURN server authentication.
   */
  credential?: string
}

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
   * ICE servers for STUN/TURN configuration.
   * Used to establish WebRTC connections through NAT/firewalls.
   * @default [{ urls: 'stun:stun.l.google.com:19302' }]
   * @example
   * ```typescript
   * iceServers: [
   *   { urls: 'stun:stun.l.google.com:19302' },
   *   {
   *     urls: 'turn:turn.example.com:3478',
   *     username: 'user',
   *     credential: 'pass'
   *   }
   * ]
   * ```
   */
  iceServers?: IceServer[]

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
   * Note: iceServers will be merged into peerOpts.config if not already present
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
  /** Buffer for reassembling chunked messages */
  chunkBuffers: Map<
    number,
    { chunks: Map<number, Uint8Array>; totalChunks: number }
  >
}

/**
 * Maximum chunk size for WebRTC DataChannel messages.
 * Most browsers support up to 256KB, but we use 64KB for safety.
 */
const CHUNK_SIZE = 64 * 1024

/**
 * Maximum buffer size before we pause sending (16KB).
 * WebRTC DataChannel buffers data before sending over the network.
 * If we send too much too fast, the buffer overflows.
 */
const MAX_BUFFERED_AMOUNT = 16 * 1024

/**
 * Message type markers for chunking protocol.
 * - 0x00: Complete message (no chunking, raw data)
 * - 0x01: Chunked message with header
 */
const MSG_TYPE_COMPLETE = 0x00
const MSG_TYPE_CHUNKED = 0x01

/** Counter for generating unique message IDs */
let messageIdCounter = 0

interface SignalingMessage {
  type: 'announce' | 'signal' | 'subscribe' | 'publish'
  from?: string
  to?: string
  signal?: any
  topics?: string[]
  topic?: string // Room name for publish messages
}

/**
 * SimplePeer transport implementation using simple-peer library.
 * Creates direct peer-to-peer connections for data transfer.
 */
export class SimplePeerTransport implements Transport {
  private options: {
    peer: SimplePeerConstructor
    signaling: string[]
    password: string
    maxConns: number
    peerOpts: Record<string, any>
    debug: boolean
  }
  private _connected: boolean = false
  private _room: string = ''
  private _callback?: (data: Uint8Array) => void
  private _peerConnectCallback?: (peerId: string) => void
  private peerId: string
  private peers: Map<string, PeerConnection> = new Map()
  private signalingConns: WebSocket[] = []
  private announcedPeers: Set<string> = new Set()
  private announceInterval?: ReturnType<typeof setInterval>

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
          'import Peer from "simple-peer"; new SimplePeerTransport({ peer: Peer, ... })',
      )
    }

    // Default ICE servers (Google's public STUN server)
    const defaultIceServers: IceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
    ]

    // Prepare peerOpts with ICE servers
    const peerOpts = { ...options.peerOpts }

    // Merge ICE servers into peerOpts.config
    if (options.iceServers || !peerOpts.config?.iceServers) {
      const iceServers = options.iceServers ?? defaultIceServers
      peerOpts.config = {
        ...peerOpts.config,
        iceServers: iceServers,
      }
    }

    this.options = {
      peer: options.peer,
      signaling: options.signaling ?? ['wss://signaling.yjs.dev'],
      password: options.password ?? '',
      maxConns: options.maxConns ?? 20 + Math.floor(Math.random() * 15),
      peerOpts,
      debug: options.debug ?? false,
    }

    // Generate unique peer ID
    this.peerId = this.generatePeerId()

    // Log configuration in debug mode
    if (this.options.debug) {
      console.log('[SimplePeerTransport] Configuration:', {
        signaling: this.options.signaling,
        iceServers: peerOpts.config?.iceServers,
        maxConns: this.options.maxConns,
        peerId: this.peerId,
      })
    }
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

    // Start periodic re-announce to help late joiners discover us
    this.announceInterval = setInterval(() => {
      if (
        this.peers.size < this.options.maxConns &&
        this.signalingConns.length > 0
      ) {
        this.log('Re-announcing presence...')
        for (const ws of this.signalingConns) {
          this.sendSignaling(ws, {
            type: 'publish',
            topic: this._room,
            from: this.peerId,
          })
        }
      }
    }, 5000) // Re-announce every 5 seconds for better peer discovery
  }

  /**
   * Disconnect from all peers and signaling servers.
   */
  disconnect(): void {
    if (!this._connected) return

    this.log('Disconnecting...')

    // Stop re-announce interval
    if (this.announceInterval) {
      clearInterval(this.announceInterval)
      this.announceInterval = undefined
    }

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
   * Large messages are automatically chunked to fit within WebRTC DataChannel limits.
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
          this.sendToPeer(peerConn, dataToSend)
          sentCount++
        } catch (error) {
          this.log('Error sending to peer:', peerConn.peerId, error)
        }
      }
    }

    this.log(`Sent to ${sentCount}/${this.peers.size} peers`)
  }

  /**
   * Send data to a single peer, chunking if necessary.
   * Uses flow control to avoid overwhelming the WebRTC buffer.
   */
  private sendToPeer(peerConn: PeerConnection, data: Uint8Array): void {
    // Small messages can be sent directly with type marker
    if (data.length <= CHUNK_SIZE - 1) {
      const msg = new Uint8Array(data.length + 1)
      msg[0] = MSG_TYPE_COMPLETE
      msg.set(data, 1)
      peerConn.peer.send(msg)
      return
    }

    // Large messages need chunking with flow control
    const messageId = messageIdCounter++
    const totalChunks = Math.ceil(data.length / (CHUNK_SIZE - 13))
    this.log(
      `Chunking message: ${data.length} bytes into ${totalChunks} chunks`,
    )

    // Queue all chunks and send with backpressure handling
    const chunks: Uint8Array[] = []
    for (let i = 0; i < totalChunks; i++) {
      const start = i * (CHUNK_SIZE - 13)
      const end = Math.min(start + (CHUNK_SIZE - 13), data.length)
      const chunkData = data.slice(start, end)

      // Chunk header: [type:1][messageId:4][chunkIndex:4][totalChunks:4][data]
      const chunk = new Uint8Array(13 + chunkData.length)
      chunk[0] = MSG_TYPE_CHUNKED
      new DataView(chunk.buffer).setUint32(1, messageId, true)
      new DataView(chunk.buffer).setUint32(5, i, true)
      new DataView(chunk.buffer).setUint32(9, totalChunks, true)
      chunk.set(chunkData, 13)
      chunks.push(chunk)
    }

    // Send chunks with flow control
    this.sendChunksWithFlowControl(peerConn, chunks)
  }

  /**
   * Send chunks with backpressure handling.
   * Waits for buffer to drain before sending more data.
   */
  private sendChunksWithFlowControl(
    peerConn: PeerConnection,
    chunks: Uint8Array[],
  ): void {
    let index = 0
    const peer = peerConn.peer

    const sendNext = () => {
      while (index < chunks.length) {
        // Check if buffer is too full
        const channel = peer._channel
        if (channel && channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          // Wait for buffer to drain
          channel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT / 2
          channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null
            sendNext()
          }
          return
        }

        // Send next chunk
        try {
          peer.send(chunks[index])
          index++
        } catch (error) {
          this.log('Error sending chunk:', index, error)
          return
        }
      }
    }

    sendNext()
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
   * Register callback for new peer data-channel connections.
   */
  onPeerConnect(callback: (peerId: string) => void): () => void {
    this._peerConnectCallback = callback
    return () => {
      this._peerConnectCallback = undefined
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

        // Announce presence with topic (room) for y-webrtc protocol
        if (this.peers.size < this.options.maxConns) {
          // y-webrtc uses 'publish' with from field
          this.sendSignaling(ws, {
            type: 'publish',
            topic: this._room,
            from: this.peerId,
          })
          // Also send announce for basic protocol compatibility
          this.sendSignaling(ws, {
            type: 'announce',
            from: this.peerId,
            topic: this._room,
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
          // Log all received messages with full details
          this.log(
            '📩 Received:',
            msg.type,
            msg.from ? `from: ${msg.from}` : '',
            msg.to ? `to: ${msg.to}` : '',
            msg.signal ? `signal: ${msg.signal.type || 'candidate'}` : '',
          )
          this.handleSignalingMessage(msg)
        } catch (error) {
          this.log(
            'Error parsing signaling message:',
            error,
            'Raw:',
            event.data,
          )
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
    // Skip messages from ourselves
    if (msg.from && msg.from === this.peerId) {
      this.log('Ignoring own message')
      return
    }

    switch (msg.type) {
      case 'publish':
        // y-webrtc protocol: messages are published to topics
        // This is an envelope, the actual message could be an announce or signal
        if (msg.from) {
          // Treat as announce if it's a publish from another peer
          if (
            !this.peers.has(msg.from) &&
            this.peers.size < this.options.maxConns &&
            !this.announcedPeers.has(msg.from)
          ) {
            this.log('Discovered peer via publish:', msg.from)
            this.announcedPeers.add(msg.from)
            // Use alphabetical comparison for initiator tiebreaker
            // Higher peerId becomes initiator to avoid both sides initiating
            const shouldInitiate = this.peerId > msg.from
            this.log(
              'Initiator tiebreaker:',
              this.peerId,
              '>',
              msg.from,
              '=',
              shouldInitiate,
            )
            this.createPeerConnection(msg.from, shouldInitiate)

            // If we're NOT the initiator, immediately re-announce so the initiator
            // can discover us (they may have missed our initial publish)
            if (!shouldInitiate) {
              this.log('Re-announcing for initiator discovery...')
              for (const ws of this.signalingConns) {
                this.sendSignaling(ws, {
                  type: 'publish',
                  topic: this._room,
                  from: this.peerId,
                })
              }
            }
          }
        }
        // Handle embedded signal if present
        if (msg.signal && msg.from) {
          if (!msg.to || msg.to === this.peerId) {
            this.log('Received embedded signal from:', msg.from)
            this.handlePeerSignal(msg.from, msg.signal)
          }
        }
        break

      case 'announce':
        if (!msg.from) {
          this.log('Announce message missing from field')
          return
        }
        // Another peer announced - connect to them if we have capacity
        if (
          !this.peers.has(msg.from) &&
          this.peers.size < this.options.maxConns &&
          !this.announcedPeers.has(msg.from)
        ) {
          this.log('Creating connection to announced peer:', msg.from)
          this.announcedPeers.add(msg.from)
          // Use alphabetical comparison for initiator tiebreaker
          const shouldInitiate = this.peerId > msg.from
          this.log(
            'Initiator tiebreaker:',
            this.peerId,
            '>',
            msg.from,
            '=',
            shouldInitiate,
          )
          this.createPeerConnection(msg.from, shouldInitiate)
        } else {
          this.log('Skipping peer (already connected or at max):', msg.from)
        }
        break

      case 'signal':
        if (!msg.from) {
          this.log('Signal message missing from field')
          return
        }
        // Received WebRTC signal from peer
        if (msg.to === this.peerId && msg.signal) {
          this.log('Received signal from peer:', msg.from)
          this.handlePeerSignal(msg.from, msg.signal)
        } else if (msg.to && msg.to !== this.peerId) {
          // Signal for another peer, ignore
        } else {
          this.log('Signal without target - handling anyway')
          this.handlePeerSignal(msg.from, msg.signal)
        }
        break

      default:
        this.log('Unknown signaling message type:', msg.type)
    }
  }

  /**
   * Send message to signaling server.
   */
  private sendSignaling(ws: WebSocket, msg: SignalingMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      this.log('Signaling send:', msg.type, msg.to ? `to: ${msg.to}` : '')
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
      chunkBuffers: new Map(),
    }

    this.peers.set(remotePeerId, peerConn)

    // Handle signaling data (ICE candidates and SDP)
    peer.on('signal', (signal: any) => {
      this.log(
        '📤 Sending signal to peer:',
        remotePeerId,
        'type:',
        signal.type || 'candidate',
      )
      // Send as 'publish' type for y-webrtc compatibility (many signaling servers only route publish)
      this.broadcastSignaling({
        type: 'publish',
        from: this.peerId,
        to: remotePeerId,
        signal,
        topic: this._room,
      })
      // Also send as 'signal' type for servers that support it directly
      this.broadcastSignaling({
        type: 'signal',
        from: this.peerId,
        to: remotePeerId,
        signal,
        topic: this._room,
      })
    })

    // Handle connection
    peer.on('connect', () => {
      this.log('✅ Peer connected:', remotePeerId)
      peerConn.connected = true
      // Notify provider so it can push its local state to this new peer
      this._peerConnectCallback?.(remotePeerId)
    })

    // Handle ICE connection state for debugging
    if (peer._pc) {
      peer._pc.oniceconnectionstatechange = () => {
        this.log('ICE state:', remotePeerId, peer._pc.iceConnectionState)
      }
      peer._pc.onconnectionstatechange = () => {
        this.log('Connection state:', remotePeerId, peer._pc.connectionState)
      }
    }

    // Handle incoming data
    peer.on('data', (data: ArrayBuffer) => {
      if (!this._callback) return

      try {
        const uint8Data = new Uint8Array(data)
        if (uint8Data.length === 0) return

        const msgType = uint8Data[0]

        if (msgType === MSG_TYPE_COMPLETE) {
          // Complete message, extract payload (skip type byte)
          const payload = uint8Data.slice(1)
          const decryptedData = this.options.password
            ? this.decrypt(payload, this.options.password)
            : payload
          this._callback(decryptedData)
        } else if (msgType === MSG_TYPE_CHUNKED) {
          // Chunked message - reassemble
          const view = new DataView(uint8Data.buffer, uint8Data.byteOffset)
          const messageId = view.getUint32(1, true)
          const chunkIndex = view.getUint32(5, true)
          const totalChunks = view.getUint32(9, true)
          const chunkData = uint8Data.slice(13)

          // Get or create buffer for this message
          let buffer = peerConn.chunkBuffers.get(messageId)
          if (!buffer) {
            buffer = { chunks: new Map(), totalChunks }
            peerConn.chunkBuffers.set(messageId, buffer)
          }

          // Store chunk
          buffer.chunks.set(chunkIndex, chunkData)

          // Check if complete
          if (buffer.chunks.size === totalChunks) {
            // Reassemble message
            let totalLength = 0
            for (let i = 0; i < totalChunks; i++) {
              totalLength += buffer.chunks.get(i)!.length
            }

            const fullMessage = new Uint8Array(totalLength)
            let offset = 0
            for (let i = 0; i < totalChunks; i++) {
              const chunk = buffer.chunks.get(i)!
              fullMessage.set(chunk, offset)
              offset += chunk.length
            }

            // Clean up buffer
            peerConn.chunkBuffers.delete(messageId)

            // Decrypt and deliver
            const decryptedData = this.options.password
              ? this.decrypt(fullMessage, this.options.password)
              : fullMessage
            this._callback(decryptedData)
            this.log(
              `Reassembled chunked message: ${totalLength} bytes from ${totalChunks} chunks`,
            )
          }
        } else {
          // Unknown type or legacy message without type marker - try as raw data
          const decryptedData = this.options.password
            ? this.decrypt(uint8Data, this.options.password)
            : uint8Data
          this._callback(decryptedData)
        }
      } catch (error) {
        this.log('Error handling peer data:', error)
      }
    })

    // Handle errors
    peer.on('error', (error: Error) => {
      this.log('❌ Peer error:', remotePeerId, error.message || error)
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
    this.log(
      '⬇️ handlePeerSignal from:',
      remotePeerId,
      'type:',
      signal?.type || 'candidate',
    )
    let peerConn = this.peers.get(remotePeerId)

    if (!peerConn) {
      // Create peer connection as non-initiator
      this.log('Creating peer as non-initiator for signal from:', remotePeerId)
      this.createPeerConnection(remotePeerId, false)
      peerConn = this.peers.get(remotePeerId)
    }

    if (peerConn) {
      try {
        this.log('Passing signal to peer:', remotePeerId)
        peerConn.peer.signal(signal)
      } catch (error) {
        this.log('Error signaling peer:', remotePeerId, error)
      }
    } else {
      this.log('Failed to get peer connection for:', remotePeerId)
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
