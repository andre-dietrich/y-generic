/**
 * WebRTC mesh transport over simple-peer; a y-webrtc-compatible signaling
 * server is used only for discovery.
 *
 * @example
 * ```typescript
 * import Peer from 'simple-peer'
 * const transport = new SimplePeerTransport({ peer: Peer, signaling: ['wss://signaling.example.com'] })
 * await new GenericProvider(doc, transport).connect({ room: 'my-room' })
 * ```
 */

import type { Transport, ConnectionConfig } from '../../transport'

export type SimplePeerConstructor = any

export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface SimplePeerTransportOptions {
  /** The simple-peer constructor, passed in so it isn't bundled. */
  peer: SimplePeerConstructor
  /** @default ['wss://signaling.yjs.dev'] */
  signaling?: string[]
  /** Merged into `peerOpts.config`. @default [{ urls: 'stun:stun.l.google.com:19302' }] */
  iceServers?: IceServer[]
  /** @default 20 + random(0-15) */
  maxConns?: number
  /** Passed to simple-peer (https://github.com/feross/simple-peer#api). */
  peerOpts?: Record<string, any>
  debug?: boolean

  /**
   * Reconnect a signaling socket silent for this long (ms); a ping goes out
   * at half of it. 0 disables. @default 30000
   */
  signalingTimeout?: number

  /**
   * How long (ms) the initiator waits for a channel to open before offering
   * again; doubles per consecutive failure up to 30s. @default 5000
   */
  connectTimeout?: number

  /**
   * After this many timed-out attempts to a peer, the initiator retries with
   * `iceTransportPolicy: 'relay'` (TURN only), for stalls a direct retry
   * never clears. Needs a `turn:`/`turns:` server; `false` disables.
   * @default 1
   */
  relayFallbackAfter?: number | false

  /**
   * Hold each peer's data frames until `trustPeer(peerId)`, e.g. after a
   * handshake over control frames. Held frames are delivered in order on
   * trust, discarded on disconnect; control frames are never held. Every new
   * connection starts untrusted.
   * @default false
   */
  requireTrust?: boolean
}

interface PeerConnection {
  peer: any // simple-peer instance
  connected: boolean
  peerId: string
  connectTimer?: ReturnType<typeof setTimeout>
  /** Random id of this attempt, sent with every signal we emit for it */
  attemptId: string
  /** The remote's attempt id from the offer/answer we applied */
  remoteAttemptId?: string
  /** SDP of the last remote offer/answer we applied, to detect duplicates */
  remoteSdp?: string
  chunkBuffers: Map<
    number,
    {
      chunks: Map<number, Uint8Array>
      totalChunks: number
      lastChunkAt: number
      bytes: number
    }
  >
  /** Outgoing frames, one FIFO per peer so messages stay in order */
  sendQueue: Uint8Array[]
  /** True while the queue waits for the channel buffer to drain */
  drainWait?: boolean
  trusted: boolean
  /** Set once the over-cap warning was logged for this connection */
  warnedChunkCap?: boolean
  heldFrames: Uint8Array[]
  heldBytes: number
}

const CHUNK_SIZE = 64 * 1024

// Pause sending while the channel buffers more than this.
const MAX_BUFFERED_AMOUNT = 16 * 1024

// Recheck a full buffer this often (ms) in case 'bufferedamountlow' doesn't fire.
const DRAIN_POLL_MS = 250

// Receiver limits for chunked messages from a misbehaving peer: 4096 chunks
// is ~256MB; a partial message idle for CHUNK_TIMEOUT is discarded.
const MAX_TOTAL_CHUNKS = 4096
const MAX_PENDING_MESSAGES = 16
const CHUNK_TIMEOUT = 30000
// Bytes of partial messages buffered per peer; an untrusted peer gets
// MAX_HELD_BYTES, since chunks are reassembled before the trust gate.
const MAX_CHUNK_BYTES = 64 * 1024 * 1024

// Held frames per untrusted peer; enough for an initial sync. Excess frames
// are dropped and recovered by the periodic sync after trust.
const MAX_HELD_FRAMES = 256
const MAX_HELD_BYTES = 16 * 1024 * 1024

// `reachesAllPeers` only below this room size: the smallest default maxConns.
const FULL_MESH_MAX_PEERS = 20

/**
 * A lost offer/answer or a one-sided ICE stall (seen behind one NAT) never
 * reaches 'failed', so the initiator tears down after `connectTimeout`
 * (doubling up to CONNECT_TIMEOUT_MAX) and offers again under a new attempt
 * id. The non-initiator waits CONNECT_TIMEOUT_MAX, to clean up if the
 * initiator is gone.
 */
const DEFAULT_CONNECT_TIMEOUT = 5000
const CONNECT_TIMEOUT_MAX = 30000

// A peer seen in signaling this recently is still in the room (two announce
// periods plus slack), so a timed-out connection to it is retried.
const PEER_SEEN_WINDOW = 12000

// First byte of every data channel message.
const MSG_TYPE_COMPLETE = 0x00
const MSG_TYPE_CHUNKED = 0x01 // [type][msgId:4][index:4][total:4][data]
const MSG_TYPE_CONTROL = 0x02 // sendControl()/onControlFrame(), not chunked

// Part of the signaling topic so 3.x peers never meet 2.x ones (CRC32 + XOR
// framing). Keep in step with WIRE_TAG in src/index.ts.
const WIRE_TAG = 'v3'

let messageIdCounter = 0

interface SignalingMessage {
  type: 'announce' | 'signal' | 'subscribe' | 'publish' | 'ping' | 'pong'
  from?: string
  to?: string
  signal?: any
  topics?: string[]
  topic?: string
  attempt?: string // sender's connection attempt id, on signal-bearing messages
}

export class SimplePeerTransport implements Transport {
  private options: {
    peer: SimplePeerConstructor
    signaling: string[]
    maxConns: number
    peerOpts: Record<string, any>
    debug: boolean
    signalingTimeout: number
    connectTimeout: number
    relayFallbackAfter: number | false
    requireTrust: boolean
  }
  private _connected: boolean = false
  private _room: string = ''
  private _topic: string = '' // `${room}/${WIRE_TAG}`
  private _callback?: (data: Uint8Array) => void
  private _peerConnectCallbacks = new Set<(peerId: string) => void>()
  private _peerDisconnectCallbacks = new Set<(peerId: string) => void>()
  private _controlCallbacks = new Set<
    (peerId: string, payload: Uint8Array) => void
  >()
  private peerId: string
  private peers: Map<string, PeerConnection> = new Map()
  private signalingConns: WebSocket[] = []
  private announcedPeers: Set<string> = new Set()
  private announceInterval?: ReturnType<typeof setInterval>
  // Per signaling URL: consecutive failures (backoff) and the pending retry.
  private _reconnectAttempts: Map<string, number> = new Map()
  private _reconnectTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map()
  private _signalingLiveness: Map<
    WebSocket,
    { url: string; lastMessage: number; pinged: boolean }
  > = new Map()
  private _livenessInterval?: ReturnType<typeof setInterval>
  // Per remote peerId, outliving its connection: last signaling message
  // seen, and consecutive timed-out attempts (connect timeout backoff).
  private _peerLastSeen: Map<string, number> = new Map()
  private _connectFailures: Map<string, number> = new Map()
  private _hasTurnServer: boolean = false

  constructor(options: SimplePeerTransportOptions) {
    if (!options.peer) {
      throw new Error(
        'SimplePeerTransport requires the "peer" option. ' +
          'Please provide the simple-peer constructor: ' +
          'import Peer from "simple-peer"; new SimplePeerTransport({ peer: Peer, ... })',
      )
    }

    const defaultIceServers: IceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
    ]

    const peerOpts = { ...options.peerOpts }
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
      maxConns: options.maxConns ?? 20 + Math.floor(Math.random() * 15),
      peerOpts,
      debug: options.debug ?? false,
      signalingTimeout: options.signalingTimeout ?? 30000,
      connectTimeout: options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
      relayFallbackAfter: options.relayFallbackAfter ?? 1,
      requireTrust: options.requireTrust ?? false,
    }
    this._hasTurnServer = (
      (peerOpts.config?.iceServers as IceServer[] | undefined) ?? []
    ).some((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) =>
        /^turns?:/.test(u),
      ),
    )

    this.peerId = this.generatePeerId()

    this.log(
      `Initialized — peerId: ${this.peerId}, maxConns: ${this.options.maxConns}`,
      `\n  signaling: [${this.options.signaling.join(', ')}]`,
      `\n  iceServers: [${((peerOpts.config?.iceServers as IceServer[]) ?? []).map((s) => (Array.isArray(s.urls) ? s.urls[0] : s.urls)).join(', ')}]`,
    )
  }

  /** Join the room on the signaling servers and start discovering peers. */
  async connect(config: ConnectionConfig): Promise<void> {
    if (this._connected) {
      throw new Error('Already connected')
    }

    this._room = config.room
    this._topic = `${config.room}/${WIRE_TAG}`
    this.log(`🔌 Connecting to room "${config.room}" as ${this.peerId}`)

    const results = await Promise.allSettled(
      this.options.signaling.map((url) => this.connectSignaling(url)),
    )

    const successCount = results.filter((r) => r.status === 'fulfilled').length

    if (successCount > 0) {
      this.log(
        `📡 Signaling: ${successCount}/${this.options.signaling.length} server(s) connected`,
      )
    } else {
      console.warn(
        '[SimplePeerTransport] ⚠️ No signaling servers reachable — WebRTC peer discovery disabled. ' +
          'Cross-tab sync via BroadcastChannel will still work.',
      )
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn(
            `[SimplePeerTransport]   ✗ ${this.options.signaling[index]}:`,
            (result as PromiseRejectedResult).reason?.message ?? result.reason,
          )
        }
      })
    }

    // Connected even without signaling: cross-tab sync still works.
    this._connected = true
    this.log(
      `✅ Connected to room "${this._room}" — ${this.signalingConns.length}/${this.options.signaling.length} signaling server(s)`,
    )

    // Reconnects requested while _connected was still false were ignored;
    // retry servers unreachable at startup now.
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.scheduleSignalingReconnect(this.options.signaling[index])
      }
    })

    // Re-subscribe and re-announce every 5s for late joiners. Not gated on
    // maxConns: a full peer must keep advertising so dropped peers can return.
    this.announceInterval = setInterval(() => {
      if (this.signalingConns.length === 0) return

      this.log('Re-announcing presence...')
      this.forgetGonePeers()
      for (const ws of this.signalingConns) {
        // A server can silently drop a subscription on a live socket.
        this.sendSignaling(ws, {
          type: 'subscribe',
          topics: [this._topic],
        })
        this.sendSignaling(ws, {
          type: 'publish',
          topic: this._topic,
          from: this.peerId,
        })
      }
    }, 5000)

    if (this.options.signalingTimeout > 0) {
      this._livenessInterval = setInterval(
        () => this.checkSignalingLiveness(),
        Math.max(100, this.options.signalingTimeout / 10),
      )
    }
  }

  disconnect(): void {
    if (!this._connected) return

    this.log(
      `🔌 Disconnecting — ${this.peers.size} peer(s), ${this.signalingConns.length} signaling server(s)`,
    )

    // Before closing sockets: onclose checks it to skip reconnecting.
    this._connected = false

    if (this.announceInterval) {
      clearInterval(this.announceInterval)
      this.announceInterval = undefined
    }
    if (this._livenessInterval) {
      clearInterval(this._livenessInterval)
      this._livenessInterval = undefined
    }
    this._signalingLiveness.clear()

    for (const timer of this._reconnectTimers.values()) {
      clearTimeout(timer)
    }
    this._reconnectTimers.clear()
    this._reconnectAttempts.clear()

    for (const peerConn of this.peers.values()) {
      clearTimeout(peerConn.connectTimer)
      peerConn.peer.destroy()
    }
    this.peers.clear()

    for (const ws of this.signalingConns) {
      ws.close()
    }
    this.signalingConns = []

    this.announcedPeers.clear()
    this._peerLastSeen.clear()
    this._connectFailures.clear()
  }

  /** Send to every connected peer, chunking large messages. */
  send(data: Uint8Array): void {
    if (!this._connected) {
      this.log('Not connected, cannot send')
      return
    }

    let sentCount = 0
    for (const peerConn of this.peers.values()) {
      if (peerConn.connected) {
        try {
          this.sendToPeer(peerConn, data)
          sentCount++
        } catch (error) {
          this.log(
            `❌ Send failed to ${peerConn.peerId}:`,
            (error as Error).message,
          )
        }
      }
    }

    if (sentCount === 0) {
      this.log(`⚠️ Send: 0 peers connected — ${data.length}B dropped`)
    } else if (sentCount < this.peers.size) {
      const skipped = this.peers.size - sentCount
      this.log(
        `📤 Sent ${data.length}B to ${sentCount}/${this.peers.size} peer(s) — ${skipped} not yet connected`,
      )
    }
  }

  sendTo(peerId: string, data: Uint8Array): void {
    if (!this._connected) {
      this.log('Not connected, cannot sendTo')
      return
    }

    const peerConn = this.peers.get(peerId)
    if (!peerConn || !peerConn.connected) {
      this.log(`⚠️ sendTo: peer ${peerId} not connected — ${data.length}B dropped`)
      return
    }

    try {
      this.sendToPeer(peerConn, data)
    } catch (error) {
      this.log(`❌ sendTo failed to ${peerId}:`, (error as Error).message)
    }
  }

  /** Queue a message for one peer (chunked if large) and pump the queue. */
  private sendToPeer(peerConn: PeerConnection, data: Uint8Array): void {
    if (data.length <= CHUNK_SIZE - 1) {
      const msg = new Uint8Array(data.length + 1)
      msg[0] = MSG_TYPE_COMPLETE
      msg.set(data, 1)
      peerConn.sendQueue.push(msg)
      this.pumpSendQueue(peerConn)
      return
    }

    const messageId = messageIdCounter++ >>> 0
    const totalChunks = Math.ceil(data.length / (CHUNK_SIZE - 13))
    this.log(
      `📦 Chunking ${data.length}B → ${totalChunks} chunks (msgId=${messageId})`,
    )

    for (let i = 0; i < totalChunks; i++) {
      const start = i * (CHUNK_SIZE - 13)
      const end = Math.min(start + (CHUNK_SIZE - 13), data.length)
      const chunkData = data.subarray(start, end)

      const chunk = new Uint8Array(13 + chunkData.length)
      const view = new DataView(chunk.buffer)
      chunk[0] = MSG_TYPE_CHUNKED
      view.setUint32(1, messageId, true)
      view.setUint32(5, i, true)
      view.setUint32(9, totalChunks, true)
      chunk.set(chunkData, 13)
      peerConn.sendQueue.push(chunk)
    }

    this.pumpSendQueue(peerConn)
  }

  /**
   * Send queued frames until the channel buffer is full, then resume when it
   * drains (one wait per peer). Uses addEventListener because simple-peer
   * owns the channel's onbufferedamountlow property.
   */
  private pumpSendQueue(peerConn: PeerConnection): void {
    const peer = peerConn.peer
    const queue = peerConn.sendQueue

    while (queue.length > 0) {
      // The connection was replaced or closed: its queue goes with it.
      if (this.peers.get(peerConn.peerId) !== peerConn) {
        queue.length = 0
        return
      }

      const channel = peer._channel
      if (channel && channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        if (!peerConn.drainWait) {
          this.log(
            `⏸️ Backpressure on ${peerConn.peerId}: buffered ${channel.bufferedAmount}B, ${queue.length} frame(s) queued`,
          )
          peerConn.drainWait = true
          // Must sit below the pause mark; simple-peer sets it to 64KB.
          channel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT / 2
          const resume = () => {
            if (!peerConn.drainWait) return
            peerConn.drainWait = false
            clearTimeout(timer)
            channel.removeEventListener?.('bufferedamountlow', resume)
            this.pumpSendQueue(peerConn)
          }
          channel.addEventListener?.('bufferedamountlow', resume)
          const timer = setTimeout(resume, DRAIN_POLL_MS)
        }
        return
      }

      try {
        peer.send(queue.shift()!)
      } catch (error) {
        // The channel is closing; the rest can't be delivered either.
        this.log(`❌ Send failed to ${peerConn.peerId}:`, (error as Error).message)
        queue.length = 0
        return
      }
    }
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this._callback = callback
    return () => {
      this._callback = undefined
    }
  }

  onPeerConnect(callback: (peerId: string) => void): () => void {
    this._peerConnectCallbacks.add(callback)
    return () => {
      this._peerConnectCallbacks.delete(callback)
    }
  }

  /** Fires only for peers whose channel had opened. */
  onPeerDisconnect(callback: (peerId: string) => void): () => void {
    this._peerDisconnectCallbacks.add(callback)
    return () => {
      this._peerDisconnectCallbacks.delete(callback)
    }
  }

  onControlFrame(
    callback: (peerId: string, payload: Uint8Array) => void,
  ): () => void {
    this._controlCallbacks.add(callback)
    return () => {
      this._controlCallbacks.delete(callback)
    }
  }

  disconnectPeer(peerId: string): void {
    this.removePeer(peerId)
  }

  /** Not chunked: the payload must fit one data channel message. */
  sendControl(peerId: string, payload: Uint8Array): void {
    const peerConn = this.peers.get(peerId)
    if (!peerConn || !peerConn.connected) {
      this.log(`⚠️ sendControl: peer ${peerId} not connected — dropped`)
      return
    }
    const msg = new Uint8Array(payload.length + 1)
    msg[0] = MSG_TYPE_CONTROL
    msg.set(payload, 1)
    try {
      peerConn.peer.send(msg)
    } catch (error) {
      this.log(`❌ sendControl failed to ${peerId}:`, (error as Error).message)
    }
  }

  /** Trust the current connection to a peer and deliver its held frames; false if none. */
  trustPeer(peerId: string): boolean {
    const peerConn = this.peers.get(peerId)
    if (!peerConn) return false
    if (peerConn.trusted) return true
    peerConn.trusted = true
    const held = peerConn.heldFrames
    peerConn.heldFrames = []
    peerConn.heldBytes = 0
    for (const frame of held) {
      if (this.peers.get(peerId) !== peerConn) break // removed meanwhile
      try {
        this._callback?.(frame)
      } catch (error) {
        this.log('Error handling peer data:', error)
      }
    }
    return true
  }

  isPeerTrusted(peerId: string): boolean {
    return this.peers.get(peerId)?.trusted ?? false
  }

  /** Our peer id, as remote peers and signaling see it. */
  get localPeerId(): string {
    return this.peerId
  }

  /**
   * DTLS fingerprints ("sha-256 AB:CD:…") from the local and remote SDP; a
   * field is undefined until that description is set.
   */
  getPeerFingerprints(
    peerId: string,
  ): { local?: string; remote?: string } | undefined {
    const peerConn = this.peers.get(peerId)
    if (!peerConn) return undefined
    const pc = peerConn.peer?._pc
    return {
      local: parseFingerprint(pc?.localDescription?.sdp),
      remote: parseFingerprint(pc?.remoteDescription?.sdp),
    }
  }

  /**
   * True while every peer recently seen in signaling is connected and the
   * room is below FULL_MESH_MAX_PEERS, i.e. a complete mesh.
   */
  get reachesAllPeers(): boolean {
    const now = Date.now()
    const room = new Set<string>()
    for (const [peerId, seenAt] of this._peerLastSeen) {
      if (now - seenAt >= PEER_SEEN_WINDOW) continue
      if (!this.peers.get(peerId)?.connected) return false
      room.add(peerId)
    }
    for (const [peerId, peerConn] of this.peers) {
      if (peerConn.connected) room.add(peerId)
    }
    return room.size < Math.min(FULL_MESH_MAX_PEERS, this.options.maxConns)
  }

  /**
   * Lifecycle flag (between connect() and disconnect()), not health: it stays
   * true with no signaling server. See `signalingHealth`.
   */
  get isConnected(): boolean {
    return this._connected
  }

  get connectedPeers(): number {
    return Array.from(this.peers.values()).filter((p) => p.connected).length
  }

  /** Signaling sockets and peers, for diagnostics. */
  get signalingHealth(): {
    open: number
    configured: number
    reconnecting: number
    peers: number
    connectedPeers: number
  } {
    return {
      open: this.signalingConns.filter((ws) => ws.readyState === 1).length,
      configured: this.options.signaling.length,
      reconnecting: this._reconnectTimers.size,
      peers: this.peers.size,
      connectedPeers: this.connectedPeers,
    }
  }

  /**
   * Retry a dropped signaling server after log10(attempts + 1) * 1200ms,
   * capped at 30s (as lib0's WebsocketClient). One timer per URL.
   */
  private scheduleSignalingReconnect(url: string): void {
    if (!this._connected) return // deliberate disconnect(), not a drop
    if (this._reconnectTimers.has(url)) return // retry already pending

    const attempts = (this._reconnectAttempts.get(url) ?? 0) + 1
    this._reconnectAttempts.set(url, attempts)

    const delay = Math.min(Math.log10(attempts + 1) * 1200, 30000)
    this.log(
      `🔄 Signaling reconnect #${attempts} for ${url} in ${Math.round(delay)}ms`,
    )

    this._reconnectTimers.set(
      url,
      setTimeout(() => {
        this._reconnectTimers.delete(url)
        if (!this._connected) return
        this.connectSignaling(url).catch(() => {
          // onclose or the timeout schedules the next attempt.
        })
      }, delay),
    )
  }

  /** Forget a signaling socket and schedule its reconnect. */
  private dropSignaling(ws: WebSocket, url: string): void {
    const index = this.signalingConns.indexOf(ws)
    if (index > -1) {
      this.signalingConns.splice(index, 1)
    }
    this._signalingLiveness.delete(ws)
    this.scheduleSignalingReconnect(url)
  }

  /**
   * Ping quiet signaling sockets and drop those silent past
   * `signalingTimeout` (half-open: OPEN but delivering nothing). Healthy
   * sockets get our own re-announce echoed every 5s.
   */
  private checkSignalingLiveness(): void {
    const now = Date.now()
    const timeout = this.options.signalingTimeout
    for (const [ws, liveness] of [...this._signalingLiveness]) {
      const silentFor = now - liveness.lastMessage
      if (silentFor > timeout) {
        this.log(
          `💀 Signaling silent for ${silentFor}ms, reconnecting: ${liveness.url}`,
        )
        // Don't wait for onclose: on a dead path the close handshake can hang.
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        try {
          ws.close()
        } catch {
          // already closing
        }
        this.dropSignaling(ws, liveness.url)
      } else if (silentFor > timeout / 2 && !liveness.pinged) {
        liveness.pinged = true
        this.sendSignaling(ws, { type: 'ping' })
      }
    }
  }

  private async connectSignaling(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      let resolved = false

      ws.onopen = () => {
        this.log(`🟢 Signaling connected: ${url}`)
        this._reconnectAttempts.delete(url)

        this.sendSignaling(ws, {
          type: 'subscribe',
          topics: [this._topic],
        })

        // 'publish' for y-webrtc servers, 'announce' for simpler ones.
        if (this.peers.size < this.options.maxConns) {
          this.sendSignaling(ws, {
            type: 'publish',
            topic: this._topic,
            from: this.peerId,
          })
          this.sendSignaling(ws, {
            type: 'announce',
            from: this.peerId,
            topic: this._topic,
          })
        }

        this.signalingConns.push(ws)
        this._signalingLiveness.set(ws, {
          url,
          lastMessage: Date.now(),
          pinged: false,
        })

        if (!resolved) {
          resolved = true
          resolve()
        }
      }

      ws.onmessage = (event) => {
        const liveness = this._signalingLiveness.get(ws)
        if (liveness) {
          liveness.lastMessage = Date.now()
          liveness.pinged = false
        }
        try {
          const msg: SignalingMessage = JSON.parse(event.data)
          if (msg.signal || msg.type === 'announce') {
            this.log(
              `📩 Signaling ‹${msg.type}›`,
              msg.from ? `from=${msg.from.slice(0, 8)}` : '',
              msg.to ? `to=${msg.to.slice(0, 8)}` : '',
              msg.signal ? `signal=${msg.signal.type ?? 'candidate'}` : '',
            )
          }
          this.handleSignalingMessage(msg)
        } catch (error) {
          this.log(
            `❌ Failed to parse signaling message: ${(error as Error).message}  raw=${event.data}`,
          )
        }
      }

      ws.onerror = (error) => {
        this.log(`❌ Signaling error: ${url}`, error)
        if (!resolved) {
          resolved = true
          reject(error)
        }
      }

      ws.onclose = () => {
        this.log(`🔴 Signaling disconnected: ${url}`)
        this.dropSignaling(ws, url)

        if (!resolved) {
          resolved = true
          reject(new Error(`Signaling closed before open: ${url}`))
        }
      }

      setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.log(`⏱️ Signaling connection timeout: ${url}`)
          // Abandon the attempt so it can't open late next to its retry.
          ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
          try {
            ws.close()
          } catch {
            // already closing
          }
          this.scheduleSignalingReconnect(url)
          reject(new Error('Signaling connection timeout'))
        }
      }, 10000)
    })
  }

  private handleSignalingMessage(msg: SignalingMessage): void {
    if (msg.from && msg.from === this.peerId) return

    if (msg.from) this._peerLastSeen.set(msg.from, Date.now())

    switch (msg.type) {
      case 'publish':
        // y-webrtc envelope: an announce, possibly carrying a signal.
        if (msg.from) {
          this.pruneStalePeer(msg.from)
          if (
            !this.peers.has(msg.from) &&
            this.peers.size < this.options.maxConns &&
            !this.announcedPeers.has(msg.from)
          ) {
            const shouldInitiate = this.peerId > msg.from
            this.log(
              `📡 Peer discovered via publish: ${msg.from} — role: ${shouldInitiate ? 'initiator' : 'non-initiator'}`,
              `(peers: ${this.peers.size + 1}/${this.options.maxConns})`,
            )
            this.announcedPeers.add(msg.from)
            this.createPeerConnection(msg.from, shouldInitiate)

            // The initiator may have missed our publish; announce again.
            if (!shouldInitiate) {
              this.log('📢 Re-announcing so initiator can find us...')
              for (const ws of this.signalingConns) {
                this.sendSignaling(ws, {
                  type: 'publish',
                  topic: this._topic,
                  from: this.peerId,
                })
              }
            }
          }
        }
        if (msg.signal && msg.from) {
          if (!msg.to || msg.to === this.peerId) {
            this.handlePeerSignal(msg.from, msg.signal, msg.attempt)
          }
        }
        break

      case 'announce':
        if (!msg.from) {
          this.log('Announce message missing from field')
          return
        }
        this.pruneStalePeer(msg.from)
        if (
          !this.peers.has(msg.from) &&
          this.peers.size < this.options.maxConns &&
          !this.announcedPeers.has(msg.from)
        ) {
          const shouldInitiate = this.peerId > msg.from
          this.log(
            `📡 Peer announced: ${msg.from} — role: ${shouldInitiate ? 'initiator' : 'non-initiator'}`,
            `(peers: ${this.peers.size + 1}/${this.options.maxConns})`,
          )
          this.announcedPeers.add(msg.from)
          this.createPeerConnection(msg.from, shouldInitiate)
        } else if (this.peers.size >= this.options.maxConns) {
          this.log(
            `⚠️ Peer limit reached (${this.options.maxConns}), ignoring announce from ${msg.from}`,
          )
        }
        break

      case 'signal':
        if (!msg.from) {
          this.log('Signal message missing from field')
          return
        }
        // Some servers strip `to`; accept those too.
        if (msg.signal && (!msg.to || msg.to === this.peerId)) {
          this.handlePeerSignal(msg.from, msg.signal, msg.attempt)
        }
        break

      case 'pong':
        // Liveness reply; receiving it already refreshed the socket's timer.
        break

      default:
        this.log(`❓ Unknown signaling message type: ${msg.type}`)
    }
  }

  private sendSignaling(ws: WebSocket, msg: SignalingMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  private broadcastSignaling(msg: SignalingMessage): void {
    for (const ws of this.signalingConns) {
      this.sendSignaling(ws, msg)
    }
  }

  private createPeerConnection(remotePeerId: string, initiator: boolean): void {
    if (this.peers.has(remotePeerId)) {
      this.log(`⏭️ Peer connection already exists: ${remotePeerId}`)
      return
    }

    const failures = this._connectFailures.get(remotePeerId) ?? 0
    // relayFallbackAfter: relay-only on the initiator alone leaves no direct pair.
    const relayAfter = this.options.relayFallbackAfter
    const relay =
      initiator &&
      relayAfter !== false &&
      failures >= relayAfter &&
      this._hasTurnServer
    const peerOpts = relay
      ? {
          ...this.options.peerOpts,
          config: { ...this.options.peerOpts.config, iceTransportPolicy: 'relay' },
        }
      : this.options.peerOpts

    this.log(
      `🤝 Creating ${initiator ? 'outbound (initiator)' : 'inbound (non-initiator)'} connection to ${remotePeerId}`,
      relay ? `— relay only (after ${failures} stalled attempt(s))` : '',
    )

    const peer = new this.options.peer({
      initiator,
      ...peerOpts,
    })

    const peerConn: PeerConnection = {
      peer,
      connected: false,
      peerId: remotePeerId,
      attemptId: Math.random().toString(36).slice(2, 10),
      chunkBuffers: new Map(),
      sendQueue: [],
      trusted: false,
      heldFrames: [],
      heldBytes: 0,
    }

    this.peers.set(remotePeerId, peerConn)

    // See DEFAULT_CONNECT_TIMEOUT.
    const timeout = initiator
      ? Math.min(this.options.connectTimeout * 2 ** failures, CONNECT_TIMEOUT_MAX)
      : CONNECT_TIMEOUT_MAX
    peerConn.connectTimer = setTimeout(() => {
      if (this.peers.get(remotePeerId) !== peerConn || peerConn.connected) return
      this._connectFailures.set(remotePeerId, failures + 1)
      this.removePeer(remotePeerId)
      const seenAt = this._peerLastSeen.get(remotePeerId) ?? 0
      const present = Date.now() - seenAt < PEER_SEEN_WINDOW
      this.log(
        `⏱️ Peer ${remotePeerId} did not connect within ${timeout}ms (attempt ${failures + 1}) — dropping`,
        initiator && present ? 'and offering again' : '',
      )
      if (initiator && present && this.peers.size < this.options.maxConns) {
        this.createPeerConnection(remotePeerId, true)
      }
    }, timeout)

    peer.on('signal', (signal: any) => {
      this.log(`📤 Signal to ${remotePeerId}: ${signal.type ?? 'candidate'}`)
      // 'publish' only: also sending 'signal' would apply the SDP twice and
      // destroy the peer.
      this.broadcastSignaling({
        type: 'publish',
        from: this.peerId,
        to: remotePeerId,
        signal,
        topic: this._topic,
        attempt: peerConn.attemptId,
      })
    })

    // On 'connect' or the first 'data', whichever comes first: some browsers
    // deliver data before 'connect'.
    const onChannelOpen = (via: string) => {
      if (peerConn.connected) return
      peerConn.connected = true
      clearTimeout(peerConn.connectTimer)
      this._connectFailures.delete(remotePeerId)
      this.log(
        `✅ Peer channel open (${via}): ${remotePeerId} — ${this.connectedPeers}/${this.peers.size} peer(s) connected`,
      )
      for (const cb of this._peerConnectCallbacks) cb(remotePeerId)
    }

    peer.on('connect', () => onChannelOpen('connect'))

    // Debug logging. addEventListener: simple-peer owns the on* handlers.
    if (peer._pc) {
      peer._pc.addEventListener('iceconnectionstatechange', () => {
        this.log(`🧊 ICE ${remotePeerId}: ${peer._pc.iceConnectionState}`)
      })
      peer._pc.addEventListener('connectionstatechange', () => {
        this.log(`🔗 Connection ${remotePeerId}: ${peer._pc.connectionState}`)
      })
    }

    peer.on('data', (data: ArrayBuffer) => {
      onChannelOpen('data')

      let uint8Data: Uint8Array
      try {
        uint8Data = new Uint8Array(data)
      } catch (error) {
        this.log('Error handling peer data:', error)
        return
      }
      if (uint8Data.length === 0) return

      // Control frames never reach the provider and are never held.
      if (uint8Data[0] === MSG_TYPE_CONTROL) {
        const payload = uint8Data.slice(1)
        for (const cb of this._controlCallbacks) cb(remotePeerId, payload)
        return
      }

      if (!this._callback) return

      try {
        const msgType = uint8Data[0]

        if (msgType === MSG_TYPE_COMPLETE) {
          this.deliver(peerConn, uint8Data.slice(1))
        } else if (msgType === MSG_TYPE_CHUNKED) {
          if (uint8Data.length < 13) {
            this.log(`🗑️ Dropping truncated chunk from ${remotePeerId}`)
            return
          }
          const view = new DataView(uint8Data.buffer, uint8Data.byteOffset)
          const messageId = view.getUint32(1, true)
          const chunkIndex = view.getUint32(5, true)
          const totalChunks = view.getUint32(9, true)
          const chunkData = uint8Data.slice(13)

          if (
            totalChunks === 0 ||
            totalChunks > MAX_TOTAL_CHUNKS ||
            chunkIndex >= totalChunks
          ) {
            this.log(
              `🗑️ Dropping invalid chunk ${chunkIndex}/${totalChunks} from ${remotePeerId}`,
            )
            return
          }

          const now = Date.now()
          // Forget partial messages whose sender stopped mid-way.
          for (const [id, b] of peerConn.chunkBuffers) {
            if (now - b.lastChunkAt > CHUNK_TIMEOUT) {
              this.log(`🗑️ Discarding stale partial message ${id} from ${remotePeerId}`)
              peerConn.chunkBuffers.delete(id)
            }
          }

          let buffer = peerConn.chunkBuffers.get(messageId)
          if (buffer && buffer.totalChunks !== totalChunks) {
            // Same id, different message: drop the old partial one.
            peerConn.chunkBuffers.delete(messageId)
            buffer = undefined
          }
          if (!buffer) {
            if (peerConn.chunkBuffers.size >= MAX_PENDING_MESSAGES) {
              // Evict the oldest partial message (Map keeps insertion order).
              const oldest = peerConn.chunkBuffers.keys().next().value!
              peerConn.chunkBuffers.delete(oldest)
            }
            buffer = { chunks: new Map(), totalChunks, lastChunkAt: now, bytes: 0 }
            peerConn.chunkBuffers.set(messageId, buffer)
          }

          const grow = chunkData.length - (buffer.chunks.get(chunkIndex)?.length ?? 0)
          let pendingBytes = grow
          for (const b of peerConn.chunkBuffers.values()) pendingBytes += b.bytes
          const untrusted = this.options.requireTrust && !peerConn.trusted
          const maxBytes = untrusted ? MAX_HELD_BYTES : MAX_CHUNK_BYTES
          if (pendingBytes > maxBytes) {
            this.log(`🗑️ Dropping message ${messageId} from ${remotePeerId}: partial messages over ${maxBytes}B`)
            // Untrusted: expected for a big doc, the periodic sync after trust delivers it.
            if (!untrusted && !peerConn.warnedChunkCap) {
              peerConn.warnedChunkCap = true
              console.warn(
                `[SimplePeerTransport] Dropping a ${totalChunks}-chunk message from ${remotePeerId}: over the ${MAX_CHUNK_BYTES / 1048576} MB limit. ` +
                  'The shared document is probably too large to sync over WebRTC (images in modules?); use the WebSocket relay.',
              )
            }
            peerConn.chunkBuffers.delete(messageId)
            return
          }

          buffer.chunks.set(chunkIndex, chunkData)
          buffer.bytes += grow
          buffer.lastChunkAt = now

          if (buffer.chunks.size === totalChunks) {
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

            peerConn.chunkBuffers.delete(messageId)

            this.deliver(peerConn, fullMessage)
            this.log(
              `📥 Reassembled ${totalLength}B from ${totalChunks} chunks (msgId=${messageId})`,
            )
          }
        } else {
          this.log(`🗑️ Dropping frame of unknown type ${msgType} from ${remotePeerId}`)
        }
      } catch (error) {
        this.log('Error handling peer data:', error)
      }
    })

    // close/error fire asynchronously after destroy(), possibly once a new
    // connection to the same peer exists; leave that one alone.
    peer.on('error', (error: Error) => {
      this.log(`❌ Peer error [${remotePeerId}]: ${error.message ?? error}`)
      if (this.peers.get(remotePeerId) === peerConn) this.removePeer(remotePeerId)
    })

    peer.on('close', () => {
      if (this.peers.get(remotePeerId) !== peerConn) return
      this.log(`🔴 Peer channel closed: ${remotePeerId}`)
      this.removePeer(remotePeerId) // logs the remaining count
    })
  }

  private handlePeerSignal(
    remotePeerId: string,
    signal: any,
    attempt?: string,
  ): void {
    let peerConn = this.peers.get(remotePeerId)

    if (peerConn && signal?.sdp && signal.sdp === peerConn.remoteSdp) {
      // Duplicate (one per signaling server); applying it twice destroys the peer.
      return
    }

    if (peerConn && signal?.type === 'offer') {
      // An offer under a new attempt id (or, from untagged peers, a second
      // offer before the channel opened) replaces the connection;
      // renegotiation keeps the same id.
      const restarted =
        attempt !== undefined
          ? peerConn.remoteAttemptId !== undefined &&
            attempt !== peerConn.remoteAttemptId
          : !peerConn.connected && peerConn.remoteSdp !== undefined
      if (restarted) {
        this.log(`🔁 New offer from ${remotePeerId} — replacing its connection`)
        this.removePeer(remotePeerId)
        peerConn = undefined
      }
    }

    if (peerConn && signal?.candidate && attempt !== undefined) {
      // A stale candidate would fail to add and destroy the peer.
      if (attempt !== peerConn.remoteAttemptId) {
        this.log(`🗑️ Ignoring candidate from an old attempt of ${remotePeerId}`)
        return
      }
    }

    if (!peerConn && signal?.candidate && attempt !== undefined) {
      // Tagged candidates follow their offer, so this one's attempt is closed.
      this.log(`🗑️ Ignoring candidate for unknown peer ${remotePeerId}`)
      return
    }

    if (!peerConn) {
      this.log(
        `📶 Signal from unknown peer ${remotePeerId} (${signal?.type ?? 'candidate'}) — creating non-initiator connection`,
      )
      this.createPeerConnection(remotePeerId, false)
      peerConn = this.peers.get(remotePeerId)
    }

    if (peerConn) {
      if (signal?.sdp) {
        if (attempt !== undefined) peerConn.remoteAttemptId = attempt
        peerConn.remoteSdp = signal.sdp
      }
      try {
        peerConn.peer.signal(signal)
      } catch (error) {
        this.log(
          `❌ Failed to apply signal from ${remotePeerId}: ${(error as Error).message}`,
        )
      }
    } else {
      this.log(
        `❌ Could not create peer connection for signal from ${remotePeerId}`,
      )
    }
  }

  // Forget an announced peer with no connection, so its next announce reconnects.
  private pruneStalePeer(peerId: string): void {
    if (this.announcedPeers.has(peerId) && !this.peers.has(peerId)) {
      this.announcedPeers.delete(peerId)
    }
  }

  // Drop bookkeeping for long-gone peers so it doesn't grow with every visitor.
  private forgetGonePeers(): void {
    const cutoff = Date.now() - 5 * PEER_SEEN_WINDOW
    for (const [peerId, seenAt] of this._peerLastSeen) {
      if (seenAt < cutoff && !this.peers.has(peerId)) {
        this._peerLastSeen.delete(peerId)
        this._connectFailures.delete(peerId)
      }
    }
  }

  /** Hand a data frame to the provider, or hold it until the peer is trusted. */
  private deliver(peerConn: PeerConnection, data: Uint8Array): void {
    if (!this.options.requireTrust || peerConn.trusted) {
      this._callback?.(data)
      return
    }
    if (
      peerConn.heldFrames.length >= MAX_HELD_FRAMES ||
      peerConn.heldBytes + data.length > MAX_HELD_BYTES
    ) {
      this.log(`🗑️ Dropping frame from untrusted peer ${peerConn.peerId} (hold full)`)
      return
    }
    peerConn.heldFrames.push(data)
    peerConn.heldBytes += data.length
  }

  private removePeer(peerId: string): void {
    const peerConn = this.peers.get(peerId)
    if (peerConn) {
      const wasConnected = peerConn.connected
      clearTimeout(peerConn.connectTimer)
      try {
        peerConn.peer.destroy()
      } catch {
        // already destroyed
      }
      this.peers.delete(peerId)
      this.announcedPeers.delete(peerId)
      if (wasConnected)
        for (const cb of this._peerDisconnectCallbacks) cb(peerId)
      this.log(
        `🗑️ Removed peer ${peerId} — ${this.connectedPeers} connected / ${this.peers.size} total`,
      )
    }
  }

  private generatePeerId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 11)
  }

  private log(...args: any[]): void {
    if (this.options.debug) {
      console.log('[SimplePeerTransport]', ...args)
    }
  }
}

/** The value of an SDP `a=fingerprint:` line, e.g. "sha-256 AB:CD:…". */
function parseFingerprint(sdp: string | undefined): string | undefined {
  const match = sdp?.match(/^a=fingerprint:(.+)$/m)
  return match ? match[1].trim() : undefined
}
