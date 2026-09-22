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
import { watchResume, watchPageBack, watchNetworkChange, type ResumeWatch } from '../resume'
import { SparseDial } from '../dial'

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
   * A lost connection is re-opened with exponential backoff; the server
   * must answer `{type:'ping'}` with `{type:'pong'}` (y-webrtc's does) or
   * publish something at least every 30 s, else the socket counts as dead.
   * @default ['wss://y-webrtc-eu.fly.dev'] (y-webrtc's public server)
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
   * Maximum number of peer connections. GenericProvider needs a FULL mesh
   * (a peer's broadcast reaches everyone directly, nobody relays): every
   * peer of the room must fit. A room larger than this loses pairs - they
   * see neither each other's presence nor each other's edits as they
   * happen. The former default (20-34, y-webrtc's, which relays) cut rooms
   * of 21+ peers: with 25 real browsers one peer ended up with 20 links
   * and missing from four rosters (test/e2e/room-scenarios.mjs).
   * @default 64
   */
  maxConns?: number

  /**
   * A PARTIAL mesh: ask for this many links instead of one to every peer
   * (see ../dial.ts; the average peer ends up with twice as many, `maxConns`
   * stays the hard cap). ONLY under ConferenceTransport
   * (providers/conference), which passes frames on - GenericProvider alone
   * needs the full mesh. Left undefined, ConferenceTransport's
   * `expectedPeers` decides: a full mesh up to 16 peers, ln(N) links (at
   * least 4) beyond.
   * @default undefined (full mesh)
   */
  dial?: number

  /**
   * With `dial`: never dial a peer that announces itself - a leaf that
   * holds the links it asked for and nobody else's (a phone).
   * ConferenceTransport sets it from its `relay: false`.
   * @default false
   */
  passive?: boolean

  /**
   * Options passed to simple-peer.
   * See https://github.com/feross/simple-peer#api
   * Note: iceServers will be merged into peerOpts.config if not already present
   * @default {}
   */
  peerOpts?: Record<string, any>

  /**
   * How long (ms) a peer connection may take to open. An entry that is not
   * connected by then is dropped, so the peer's next announce gets a fresh
   * attempt - an unanswered offer has no failure event of its own.
   * @default 30000
   */
  connectTimeout?: number

  /**
   * Rebuild all links under a new peer id when the page did not run for
   * this long (ms) - a phone browser in the background, a suspended
   * laptop. The other side dropped a silent link after ~30 s, this side
   * would still read it as connected for ~30 s after waking up.
   * 0 disables.
   * Not below ~30 s: a link survives that much silence, so a shorter sleep
   * has nothing to repair - and Firefox delays the timers of a HIDDEN tab
   * in a busy room by up to ~15-20 s (measured; its budget throttling caps
   * at 15 s), which the old default of 15000 took for a sleep: a full
   * re-join about once a minute for every Firefox user with the tab in the
   * background (test/providers/repro-simple-peer-sleep.ts, part 8).
   * @default 30000
   */
  resumeAfterMs?: number

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean
}

interface PeerConnection {
  peer: any // SimplePeer instance
  connected: boolean
  initiator: boolean
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
  type: 'announce' | 'signal' | 'subscribe' | 'publish' | 'ping' | 'pong'
  from?: string
  to?: string
  signal?: any
  /** On an announce of a sparse mesh: the peer is a leaf (see SimplePeerTransportOptions.passive). */
  passive?: boolean
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
    connectTimeout: number
    resumeAfterMs: number
    debug: boolean
  }
  /** The dial rule of a partial mesh; undefined: full mesh. */
  private _sparse?: SparseDial
  private _announceRetry?: ReturnType<typeof setTimeout>
  private _passive: boolean
  /** RTCPeerConnections this transport has created - Chrome allows a renderer 500, closed ones included. */
  peerConnectionsCreated = 0
  private _connected: boolean = false
  private _room: string = ''
  private _callback?: (data: Uint8Array, from?: string) => void
  private _peerConnectCallback?: (peerId: string) => void
  private _peerDisconnectCallback?: (peerId: string) => void
  private peerId: string
  private peers: Map<string, PeerConnection> = new Map()
  private signalingConns: WebSocket[] = []
  private announcedPeers: Set<string> = new Set()
  private announceInterval?: ReturnType<typeof setInterval>
  // Signaling reconnect: true between connect() and disconnect(); failed
  // attempts and the pending retry timer per server URL.
  private _shouldConnect: boolean = false
  private signalingAttempts: Map<string, number> = new Map()
  private signalingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private _stopResumeWatch?: ResumeWatch
  /** Signaling sockets handleResume() replaced: their late onclose must not dial again. */
  private _abandonedSockets = new Set<WebSocket>()
  /** Signaling sockets that have not opened yet (see dialSignalingNow). */
  private _dialingSockets = new Set<WebSocket>()
  private _stopNetworkWatch?: () => void
  private _stopNetworkChangeWatch?: () => void
  private _resetting: boolean = false // handleResume(): removePeer() must not announce the old id

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
      signaling: options.signaling ?? ['wss://y-webrtc-eu.fly.dev'],
      password: options.password ?? '',
      maxConns: options.maxConns ?? 64,
      peerOpts,
      connectTimeout: options.connectTimeout ?? 30000,
      resumeAfterMs: options.resumeAfterMs ?? 30000,
      debug: options.debug ?? false,
    }

    this._passive = options.passive ?? false
    if (options.dial !== undefined) this.configureSparse({ dial: options.dial })

    // Generate unique peer ID
    this.peerId = this.generatePeerId()

    this.log(
      `Initialized — peerId: ${this.peerId}, maxConns: ${this.options.maxConns}`,
      `\n  signaling: [${this.options.signaling.join(', ')}]`,
      `\n  iceServers: [${((peerOpts.config?.iceServers as IceServer[]) ?? []).map((s) => (Array.isArray(s.urls) ? s.urls[0] : s.urls)).join(', ')}]`,
    )
  }

  /**
   * Connect to the room via signaling servers and start discovering peers.
   */
  async connect(config: ConnectionConfig): Promise<void> {
    if (this._connected) {
      throw new Error('Already connected')
    }

    this._room = config.room
    this._shouldConnect = true
    this.log(`🔌 Connecting to room "${config.room}" as ${this.peerId}`)

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

    // Still mark as connected even if no signaling servers work
    // This allows BroadcastChannel-only mode for same-browser tabs
    this._connected = true
    this.log(
      `✅ Connected to room "${this._room}" — ${this.signalingConns.length}/${this.options.signaling.length} signaling server(s)`,
    )

    // Start periodic re-announce to help late joiners discover us
    this.announceInterval = setInterval(() => this.announce(), 5000)

    if (this.options.resumeAfterMs > 0) {
      this._stopResumeWatch = watchResume(this.options.resumeAfterMs, (sleptMs) =>
        this.handleResume(sleptMs),
      )
    }

    // The network is back, or somebody looks at the page again: not the
    // moment to sit out a backoff (a sleep shorter than resumeAfterMs kills
    // a signaling socket just as well). Browser only.
    this._stopNetworkWatch = watchPageBack(() => this.dialSignalingNow())

    // The page's network CHANGED: every link runs over an address that is
    // gone, and waiting for ICE to say so costs 15 s on Chrome and 25-30 s
    // on Firefox (a real phone, WiFi off and on: test/e2e/phone-session.mjs
    // simple-peer, repro-simple-peer-sleep parts 13-15). The same repair as
    // after a sleep - the links are just as dead.
    this._stopNetworkChangeWatch = watchNetworkChange((why) => this.rejoinRoom(why))
  }

  /**
   * The page slept (see watchResume): every link is dead on the other side
   * or about to be, and the room holds dead entries under our peer id that
   * would swallow our announces until their ICE times out. Start over
   * under a new id - no entry anywhere matches it - and with fresh
   * signaling sockets (the old ones may be half-open); their onopen
   * subscribes and announces. GenericProvider resyncs each link as it
   * opens (onPeerConnect).
   */
  private handleResume(sleptMs: number): void {
    this.rejoinRoom(`Page slept ${sleptMs}ms`)
  }

  /**
   * Every link is dead (the page slept, or its network changed under it) and
   * the room holds entries under our peer id that would swallow our announces
   * until their ICE times out. Start over under a new id and dial at once.
   */
  private rejoinRoom(why: string): void {
    if (!this._connected) return
    this.log(`⏰ ${why} — rebuilding all links under a new peer id`)
    this.peerId = this.generatePeerId()
    this._resetting = true
    for (const id of Array.from(this.peers.keys())) this.removePeer(id)
    this._resetting = false
    // Not "close and let onclose reconnect": a socket that died while the
    // page slept does not answer the closing handshake, and the browser
    // reports it closed only seconds later. A real phone (Chrome on Android,
    // display off for 87 s / 206 s) had its links back 9.5 / 11.0 s after
    // the return - 1.5 s after 42 s in the background, when the socket was
    // still alive (test/e2e/phone-session.mjs; repro-simple-peer-sleep, part
    // 11). Give the old sockets up and dial at once.
    for (const ws of this.signalingConns.slice()) {
      this._abandonedSockets.add(ws)
      this.signalingConns.splice(this.signalingConns.indexOf(ws), 1)
      ws.close()
    }
    this.dialSignalingNow()
  }

  /**
   * Dial every signaling server we have no open socket to, NOW - not when
   * the backoff says so. The second thing the real phone showed: with the
   * display off for 203 s the socket died in the background, four reconnects
   * failed, and the page woke up with "retry 5 in 5841 ms" pending - the
   * sleep was noticed after 0.16 s, there was no open socket to replace, and
   * nothing happened for six seconds (repro-simple-peer-sleep, part 12). An
   * attempt still in flight is given up with the timers: on a network that
   * was down it hangs until its 10 s timeout. Also called when the browser
   * says the network is back, and when the tab becomes visible again.
   */
  private dialSignalingNow(): void {
    if (!this._shouldConnect) return
    for (const timer of this.signalingTimers.values()) clearTimeout(timer)
    this.signalingTimers.clear()
    this.signalingAttempts.clear()
    for (const ws of this._dialingSockets) {
      this._abandonedSockets.add(ws)
      ws.close()
    }
    this._dialingSockets.clear()
    const open = new Set(this.signalingConns.map((ws) => ws.url))
    for (const url of this.options.signaling) {
      if (!open.has(url) && !open.has(url + '/')) this.connectSignaling(url).catch(() => {})
    }
  }

  /**
   * ConferenceTransport's hooks (providers/conference): a room of
   * `expectedPeers` that does not fit into a full mesh gets the dial rule,
   * unless the `dial` option has set one already.
   */
  configureSparse(options: { dial?: number; expectedPeers?: number; passive?: boolean }): void {
    if (options.passive !== undefined) this._passive = options.passive
    const dial =
      options.dial ??
      (this._sparse === undefined && (options.expectedPeers ?? 0) > 16
        ? Math.max(4, Math.ceil(Math.log(options.expectedPeers!)))
        : undefined)
    if (dial !== undefined) this._sparse = new SparseDial({ dial, maxConns: this.options.maxConns, passive: this._passive })
    else if (this._sparse) this._sparse.passive = this._passive
  }

  setRoomSize(peers: number): void {
    this._sparse?.setRoomSize(peers)
  }

  /** Publish our peer id to the room on every open signaling connection. */
  private announce(): void {
    // A partial mesh: only while short of links. Every announce goes to every
    // peer of the room - 300 peers announcing every 5 s are 18,000 signaling
    // messages a second.
    if (this._sparse ? !this._sparse.wantsLinks(this.peers.size) : this.peers.size >= this.options.maxConns) return
    // A partial mesh: an announce is answered by chance - too few answers, and the next try is not 5 s away.
    if (this._sparse && this._announceRetry === undefined) {
      this._announceRetry = setTimeout(() => {
        this._announceRetry = undefined
        if (this._connected) this.announce()
      }, 1500)
    }
    for (const ws of this.signalingConns) {
      this.sendSignaling(ws, {
        type: 'publish',
        topic: this._room,
        from: this.peerId,
        ...(this._sparse && this._passive ? { passive: true } : {}),
      })
    }
  }

  /**
   * Disconnect from all peers and signaling servers.
   */
  disconnect(): void {
    this._shouldConnect = false
    for (const timer of this.signalingTimers.values()) clearTimeout(timer)
    this.signalingTimers.clear()
    this.signalingAttempts.clear()
    if (!this._connected) return

    this.log(
      `🔌 Disconnecting — ${this.peers.size} peer(s), ${this.signalingConns.length} signaling server(s)`,
    )

    this._stopResumeWatch?.()
    this._stopResumeWatch = undefined
    this._stopNetworkWatch?.()
    this._stopNetworkWatch = undefined
    this._stopNetworkChangeWatch?.()
    this._stopNetworkChangeWatch = undefined

    // Stop re-announce interval
    if (this.announceInterval) {
      clearInterval(this.announceInterval)
      if (this._announceRetry !== undefined) clearTimeout(this._announceRetry)
      this._announceRetry = undefined
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
    const unsendable: PeerConnection[] = []
    for (const peerConn of this.peers.values()) {
      if (peerConn.connected) {
        try {
          this.sendToPeer(peerConn, dataToSend)
          sentCount++
        } catch (error) {
          this.log(
            `❌ Send failed to ${peerConn.peerId}:`,
            (error as Error).message,
          )
          unsendable.push(peerConn)
        }
      }
    }
    for (const peerConn of unsendable) this.dropUnsendable(peerConn)

    // Only log when the picture is non-trivial (missing peers or no peers at all)
    if (sentCount === 0) {
      this.log(`⚠️ Send: 0 peers connected — ${data.length}B dropped`)
    } else if (sentCount < this.peers.size) {
      const skipped = this.peers.size - sentCount
      this.log(
        `📤 Sent ${data.length}B to ${sentCount}/${this.peers.size} peer(s) — ${skipped} not yet connected`,
      )
    }
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
      `📦 Chunking ${data.length}B → ${totalChunks} chunks (msgId=${messageId})`,
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
          this.log(
            `⏸️ Backpressure on ${peerConn.peerId}: buffered ${channel.bufferedAmount}B, waiting...`,
          )
          channel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT / 2
          channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null
            this.log(`▶️ Buffer drained on ${peerConn.peerId}, resuming chunks`)
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
  onMessage(callback: (data: Uint8Array, from?: string) => void): () => void {
    this._callback = callback
    return () => {
      this._callback = undefined
    }
  }

  /**
   * Transport.sendTo: deliver to one connected peer (the `from` id passed
   * to onMessage), chunked and flow-controlled like a broadcast send.
   */
  sendTo(peerId: string, data: Uint8Array): void {
    if (!this._connected) return
    const peerConn = this.peers.get(peerId)
    if (!peerConn || !peerConn.connected) return
    const dataToSend = this.options.password
      ? this.encrypt(data, this.options.password)
      : data
    try {
      this.sendToPeer(peerConn, dataToSend)
    } catch (error) {
      this.log(`❌ sendTo failed for ${peerId}:`, (error as Error).message)
      this.dropUnsendable(peerConn)
    }
  }

  /**
   * send() threw on a link simple-peer has reported connected: rebuild it.
   * Logging it and keeping the entry lost the frame for good - and with it
   * the link, in one direction. Seen with 50 real browsers, about one join
   * in six, always on the ANSWERING side of a link (Chrome 151, a busy
   * machine): the RTCDataChannel object says readyState 'connecting' after
   * its own 'open' event - minutes later still - while getStats() calls the
   * channel open and messages arrive on it, and every send() throws
   * "readyState is not 'open'". The first frame lost that way is the one
   * that carries our presence to a new link: that peer never learned us,
   * its roster stayed one short and our edits reached it only through third
   * peers' beacons (test/e2e/room-scenarios.mjs, DIAG=1: "sent 0 rcvd 2";
   * test/providers/repro-simple-peer-sleep.ts, part 7). Dropping the entry
   * reports the link gone and announces, so the pair dials again; the
   * other side sees the close. Only ever our own entry (see removeOwnEntry).
   */
  // ponytail: one rebuild per failed send, no backoff - a link that keeps coming up unsendable flaps at handshake speed; count and give up if that is ever seen.
  private dropUnsendable(peerConn: PeerConnection): void {
    if (this.peers.get(peerConn.peerId) !== peerConn) return
    this.log(`♻️ Link to ${peerConn.peerId} cannot send — dropping it so the pair dials again`)
    this.removePeer(peerConn.peerId)
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

  /** Transport.onPeerDisconnect: a peer's channel closed or errored (removePeer). */
  onPeerDisconnect(callback: (peerId: string) => void): () => void {
    this._peerDisconnectCallback = callback
    return () => {
      this._peerDisconnectCallback = undefined
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
      this._dialingSockets.add(ws)
      let resolved = false
      // Liveness, as lib0's WebsocketClient does it for y-webrtc: a ping
      // every 15 s, and a socket that has been silent for 30 s is closed -
      // a half-open socket (WiFi -> LTE, a suspended page) reports nothing
      // by itself. onclose then reconnects.
      let lastMessageAt = Date.now()
      let pingTimer: ReturnType<typeof setInterval> | undefined

      ws.onopen = () => {
        this._dialingSockets.delete(ws)
        if (this._abandonedSockets.has(ws)) {
          ws.close() // given up while it was connecting: its successor speaks for us
          return
        }
        this.log(`🟢 Signaling connected: ${url}`)
        this.signalingAttempts.delete(url)
        lastMessageAt = Date.now()
        pingTimer = setInterval(() => {
          if (Date.now() - lastMessageAt > 30000) ws.close()
          else this.sendSignaling(ws, { type: 'ping' })
        }, 15000)

        // Subscribe to room
        this.sendSignaling(ws, {
          type: 'subscribe',
          topics: [this._room],
        })

        // Announce presence with topic (room) for y-webrtc protocol
        if (this._sparse) {
          // A partial mesh: only while short of links, and with what announce() says about us.
          if (this._sparse.wantsLinks(this.peers.size)) {
            this.sendSignaling(ws, {
              type: 'publish',
              topic: this._room,
              from: this.peerId,
              ...(this._passive ? { passive: true } : {}),
            })
          }
        } else if (this.peers.size < this.options.maxConns) {
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
        lastMessageAt = Date.now()
        try {
          const msg: SignalingMessage = JSON.parse(event.data)
          // Only log signal-bearing messages to avoid flooding with pure topology pings
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
        this._dialingSockets.delete(ws)
        this.log(`🔴 Signaling disconnected: ${url}`)
        if (pingTimer) clearInterval(pingTimer)
        const index = this.signalingConns.indexOf(ws)
        if (index > -1) {
          this.signalingConns.splice(index, 1)
        }
        // A socket handleResume() gave up has its successor already.
        if (this._abandonedSockets.delete(ws)) return
        this.scheduleSignalingReconnect(url)
      }

      // 10 s, or 4 s while the room is lost (see roomLost)
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.log(`⏱️ Signaling connection timeout: ${url}`)
          reject(new Error('Signaling connection timeout'))
          ws.close() // onclose schedules the next attempt
        }
      }, this.roomLost ? 4000 : 10000)
    })
  }

  /**
   * Re-open a signaling connection that closed while we should be
   * connected - a phone's OS closes the socket of a backgrounded page, and
   * without it the transport can neither announce nor receive offers
   * (repro-simple-peer-sleep, part 3). Same curve as WebSocketTransport
   * (round 7, item 4): doubling from 1 s, +-50 % jitter, capped at 10 s.
   * onopen subscribes and announces again.
   */
  private scheduleSignalingReconnect(url: string): void {
    if (!this._shouldConnect || this.signalingTimers.has(url)) return
    const attempt = (this.signalingAttempts.get(url) ?? 0) + 1
    this.signalingAttempts.set(url, attempt)
    const delay = Math.round(
      Math.min(this.roomLost ? 3000 : 10000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random()),
    )
    this.log(`🔄 Signaling reconnect #${attempt} to ${url} in ${delay}ms`)
    this.signalingTimers.set(
      url,
      setTimeout(() => {
        this.signalingTimers.delete(url)
        if (this._shouldConnect) this.connectSignaling(url).catch(() => {})
      }, delay),
    )
  }

  /**
   * Nothing left of the room: no signaling socket, no link. Then an attempt
   * costs nothing and waiting costs everything - the 10 s connect timeout and
   * a backoff up to 10 s are for a page that still has its peers. A phone
   * whose WiFi comes back is told by no browser event in Firefox (no
   * `navigator.connection`, no second `online`, see watchNetworkChange): only
   * the next attempt finds the network, and the second WiFi cycle of a real
   * phone took 60 s to get back into the room (phone-session.mjs simple-peer,
   * Firefox; repro-simple-peer-sleep part 16).
   */
  private get roomLost(): boolean {
    return this.signalingConns.length === 0 && this.peers.size === 0
  }

  /**
   * Handle messages from signaling server.
   */
  private handleSignalingMessage(msg: SignalingMessage): void {
    // Skip messages from ourselves
    if (msg.from && msg.from === this.peerId) return
    // Every publish goes to the whole topic, signals for others too: what the dial rule knows of the room's size.
    if (msg.from) this._sparse?.heard(msg.from)

    switch (msg.type) {
      case 'publish':
        // y-webrtc protocol: messages are published to topics
        // This is an envelope, the actual message could be an announce or signal
        if (this._sparse) {
          // A partial mesh: whoever decides to answer an announce dials, whatever
          // the ids say - the announcer cannot know whom to wait for. A publish
          // that carries a signal is no announce here.
          if (msg.from && !msg.signal && !this.peers.has(msg.from) && this._sparse.answers(msg.from, this.peers.size, msg.passive === true)) {
            this.log(`📡 Answering the announce of ${msg.from} (peers: ${this.peers.size + 1})`)
            this.createPeerConnection(msg.from, true)
          }
        } else if (msg.from) {
          // Treat as announce if it's a publish from another peer
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

            // If we're NOT the initiator, immediately re-announce so the initiator
            // can discover us (they may have missed our initial publish)
            if (!shouldInitiate) {
              this.log('📢 Re-announcing so initiator can find us...')
              this.announce()
            }
          }
        }
        // Handle embedded signal if present
        if (msg.signal && msg.from) {
          if (!msg.to || msg.to === this.peerId) {
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
        // Received WebRTC signal from peer
        if (msg.to === this.peerId && msg.signal) {
          this.handlePeerSignal(msg.from, msg.signal)
        } else if (!msg.to && msg.signal) {
          // Signal without explicit target — handle anyway (some servers strip `to`)
          this.handlePeerSignal(msg.from, msg.signal)
        }
        break

      case 'pong':
        break // liveness only, see connectSignaling()

      default:
        this.log(`❓ Unknown signaling message type: ${msg.type}`)
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
      this.log(`⏭️ Peer connection already exists: ${remotePeerId}`)
      return
    }

    this.log(
      `🤝 Creating ${initiator ? 'outbound (initiator)' : 'inbound (non-initiator)'} connection to ${remotePeerId}`,
    )

    const peer = new this.options.peer({
      initiator,
      ...this.options.peerOpts,
    })
    this.peerConnectionsCreated++

    const peerConn: PeerConnection = {
      peer,
      connected: false,
      initiator,
      peerId: remotePeerId,
      chunkBuffers: new Map(),
    }

    this.peers.set(remotePeerId, peerConn)

    // An offer nobody answers produces no event at all - without this the
    // entry stayed for good and swallowed every later announce of that
    // peer (repro-simple-peer-sleep, part 5).
    const connectTimer = setTimeout(() => {
      if (!peerConn.connected && this.peers.get(remotePeerId) === peerConn) {
        this.log(`⏱️ No connection to ${remotePeerId} after ${this.options.connectTimeout}ms — dropping the entry`)
        this.removePeer(remotePeerId)
      }
    }, this.options.connectTimeout)
    peer.on('close', () => clearTimeout(connectTimer))

    // Handle signaling data (ICE candidates and SDP)
    peer.on('signal', (signal: any) => {
      this.log(`📤 Signal to ${remotePeerId}: ${signal.type ?? 'candidate'}`)
      // Send as 'publish' only — broadcasting as BOTH 'publish' and 'signal' causes the
      // receiving peer to apply the same SDP offer twice, which triggers a WebRTC error
      // and destroys the peer before it can fully connect.
      this.broadcastSignaling({
        type: 'publish',
        from: this.peerId,
        to: remotePeerId,
        signal,
        topic: this._room,
      })
    })

    // Mark channel open and notify provider — called by either 'connect' or the first
    // 'data' event, whichever fires first (WebRTC can deliver data before 'connect' on
    // some browsers, causing replies to be dropped if we wait for 'connect' only).
    const onChannelOpen = (via: string) => {
      if (peerConn.connected) return // already fired
      peerConn.connected = true
      clearTimeout(connectTimer)
      const connectedCount = Array.from(this.peers.values()).filter(
        (p) => p.connected,
      ).length
      this.log(
        `✅ Peer channel open (${via}): ${remotePeerId} — ${connectedCount}/${this.peers.size} peer(s) connected`,
      )
      this._peerConnectCallback?.(remotePeerId)
    }

    // Handle connection
    peer.on('connect', () => onChannelOpen('connect'))

    // ICE state for debugging - through simple-peer's own event. Never assign
    // peer._pc.on*statechange: simple-peer wires the peer connection with
    // exactly those properties, and replacing them switched off its
    // failure detection (ICE 'failed' no longer closed the peer) and made
    // 'connect' depend on the order of the ICE and gathering events
    // (test/providers/repro-simple-peer-sleep.ts, parts 1-2).
    peer.on('iceStateChange', (ice: string, gathering: string) => {
      this.log(`🧊 ICE ${remotePeerId}: ${ice} (gathering: ${gathering})`)
    })

    // Handle incoming data
    peer.on('data', (data: ArrayBuffer) => {
      // Data flowing proves the channel is open — handle the race where 'data' fires
      // before 'connect' (seen on Chrome when the remote initiator sends immediately).
      onChannelOpen('data')
      this._stopResumeWatch?.alive() // a page that handles this has not slept, however late its timers are

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
          this._callback(decryptedData, remotePeerId)
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
            this._callback(decryptedData, remotePeerId)
            this.log(
              `📥 Reassembled ${totalLength}B from ${totalChunks} chunks (msgId=${messageId})`,
            )
          }
        } else {
          // Unknown type or legacy message without type marker - try as raw data
          const decryptedData = this.options.password
            ? this.decrypt(uint8Data, this.options.password)
            : uint8Data
          this._callback(decryptedData, remotePeerId)
        }
      } catch (error) {
        this.log('Error handling peer data:', error)
      }
    })

    // close/error arrive asynchronously: by then the entry under this id
    // may already be a newer link (handlePeerSignal() replaced it, or the
    // peer re-dialed after our announce) - only ever remove our own.
    const removeOwnEntry = () => {
      if (this.peers.get(remotePeerId) === peerConn) this.removePeer(remotePeerId)
    }

    // Handle errors
    peer.on('error', (error: Error) => {
      this.log(`❌ Peer error [${remotePeerId}]: ${error.message ?? error}`)
      removeOwnEntry()
    })

    // Handle close
    peer.on('close', () => {
      const connectedCount = Array.from(this.peers.values()).filter(
        (p) => p.connected && p.peerId !== remotePeerId,
      ).length
      this.log(
        `🔴 Peer channel closed: ${remotePeerId} — ${connectedCount}/${this.peers.size - 1} remaining`,
      )
      removeOwnEntry()
    })
  }

  /**
   * Handle WebRTC signal from peer.
   */
  private handlePeerSignal(remotePeerId: string, signal: any): void {
    let peerConn = this.peers.get(remotePeerId)

    // An offer for an entry that is already connected: the remote rebuilt
    // its side of the link (it lost us first) - this transport never
    // renegotiates. The old peer object would reject the offer (new DTLS
    // fingerprint) and lose it, leaving the remote's initiator half-open.
    if (peerConn?.connected && signal?.type === 'offer') {
      this.log(`♻️ Fresh offer from connected peer ${remotePeerId} — replacing the old link`)
      this.removePeer(remotePeerId)
      peerConn = undefined
    }

    // A partial mesh: two peers that are both short of links answer each
    // other's announce at the same moment, and each holds an initiator for
    // the other. The larger id's offer stands; the other end drops its own
    // and answers (an offer fed to an initiator is an error, and both
    // entries would sit there until connectTimeout).
    if (this._sparse && peerConn && !peerConn.connected && peerConn.initiator && signal?.type === 'offer') {
      if (this.peerId > remotePeerId) return
      this.log(`🤝 Glare with ${remotePeerId} — its offer stands, dropping ours`)
      this.peers.delete(remotePeerId)
      try {
        peerConn.peer.destroy()
      } catch (error) {
        // Ignore errors during cleanup
      }
      peerConn = undefined
    }

    if (!peerConn && this._sparse && signal?.type === 'offer' && !this._sparse.accepts(this.peers.size)) {
      this.log(`⚠️ Peer limit reached (${this.options.maxConns}), ignoring the offer of ${remotePeerId}`)
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
      const connectedCount = Array.from(this.peers.values()).filter(
        (p) => p.connected,
      ).length
      this.log(
        `🗑️ Removed peer ${peerId} — ${connectedCount} connected / ${this.peers.size} total`,
      )
      this._peerDisconnectCallback?.(peerId)
      // As y-webrtc does on a peer's close/error: announce at once, so a
      // peer that is still there re-dials within a signaling round trip
      // instead of the next 5 s tick.
      if (this._connected && !this._resetting) this.announce()
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
