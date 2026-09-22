/**
 * Conference transport for GenericProvider: rooms that do not fit into a full
 * WebRTC mesh (100+ peers).
 *
 * GenericProvider needs a broadcast medium - "what I send reaches every peer
 * of the room, what I receive comes from its author". Reply suppression,
 * responder self-selection, presence on demand, the removal veto and pub/sub
 * all rest on that (docs/superpowers/specs/2026-09-20-partial-mesh-relay-research.md:
 * today's core on a partial mesh ends with 0 of 100 rosters complete). A
 * full mesh is such a medium, at N-1 RTCPeerConnections per browser.
 *
 * This wrapper sits UNDER the core and makes a PARTIAL mesh look like one.
 * The inner transport (simple-peer, peerjs - anything with `sendTo`,
 * `onPeerConnect`, `onPeerDisconnect`) holds a handful of links; the wrapper
 * passes frames on:
 *
 * - **Broadcast: Plumtree** (Leitao 2007), one tree PER ORIGIN. A link is
 *   EAGER or LAZY for an origin. A frame seen for the first time goes on over
 *   the links that are eager for its origin; a duplicate turns the link it
 *   came over lazy for that origin (PRUNE), so they settle into a spanning
 *   tree: N-1 frames per broadcast, like the full mesh. Lazy links only hear
 *   a DIGEST now and then ("I have origin X up to seq S"); a peer that misses
 *   something asks for it (GRAFT), which also makes that link eager again -
 *   the repair path when a tree link dies. Flooding the way y-webrtc does it
 *   costs 27x the frames (same research doc).
 *   Why per origin: with ONE tree for the room, two origins' frames going
 *   round the same cycle in opposite directions each prune a different link
 *   of it, and the tree falls apart - in a joining room all the time (the
 *   gate, first run: 40 of 49 tree links, 26 of 50 rosters complete).
 *   What a link is for an origin nobody has heard yet is the link's DEFAULT:
 *   every peer keeps FEEDS links eager by default and asks for the rest to
 *   be lazy (PRUNE-ALL, which the other end refuses when it would be left
 *   with fewer) - a new origin's first frame floods 2 links per peer, not k.
 * - **Unicast: a learning bridge.** The link a peer's frames arrive on first
 *   is the route back to it.
 * - **Membership.** A closed link does not say that the peer is gone - it
 *   may be reachable over others. The neighbour says SUSPECT to the room;
 *   the suspect, if it hears that, says ALIVE. No ALIVE within
 *   `suspectTimeoutMs`: every peer reports `onPeerDisconnect` to its core -
 *   what a full mesh's closed channel does. A page that leaves says LEAVE.
 * - **connect() resolves at the first link**, not before: the core sends its
 *   JOIN beacon ("send me your presence") when connect() resolves, and on a
 *   mesh no channel is open yet at that point. A full mesh does not care
 *   (every channel that opens brings that peer's presence); here most of the
 *   room never opens a channel to the joiner (21 of 100 rosters complete).
 *
 * The core sees the ORIGIN of a frame as `from` - an id of this wrapper's
 * own (12 hex chars), stable over a re-dial of the inner transport.
 *
 * Wire format: an envelope of its own. All peers of a room must use this
 * transport, in the same version.
 *
 * @example
 * ```typescript
 * import Peer from 'simple-peer'
 * import { SimplePeerTransport } from 'genericprovider/providers/simple-peer'
 * import { ConferenceTransport } from 'genericprovider/providers/conference'
 *
 * const transport = new ConferenceTransport(
 *   new SimplePeerTransport({ peer: Peer, signaling: ['wss://...'] }),
 *   { expectedPeers: 300 },
 * )
 * const provider = new GenericProvider(doc, transport)
 * ```
 */

import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { Transport, ConnectionConfig } from '../../transport'

/** What the wrapper needs from the transport below it. */
export type MeshTransport = Transport &
  Required<Pick<Transport, 'sendTo' | 'onPeerConnect' | 'onPeerDisconnect'>> & {
    /**
     * Optional, once before connect(): the room is expected to hold
     * `expectedPeers` - build a partial mesh if that is too many for a full
     * one; `passive`: this peer is a leaf. See ../dial.ts.
     */
    configureSparse?(options: { expectedPeers?: number; passive?: boolean }): void
    /**
     * Optional: the peers this wrapper has heard (itself included), for a
     * dial rule that answers an announce with probability ~ dial / N. The
     * peers that ARE there, not the expected ones: the first peers of a
     * lecture hall would answer each other with probability 5/300.
     */
    setRoomSize?(peers: number): void
  }

export interface ConferenceTransportOptions {
  /**
   * Estimated room size - a HINT, handed to the inner transport before it
   * connects (`configureSparse`): up to 16 peers it builds the full mesh it
   * always built, beyond that a partial one with ln(N) links per joiner. It
   * has to be known up front because the first peers of a room cannot see
   * how many will follow: without it a lecture hall first builds a full
   * mesh of its first 64 peers. Too large costs a small room a second hop,
   * too small costs a large room links; neither breaks it. Not needed when
   * the inner transport's own `dial` option is set.
   */
  expectedPeers?: number
  /**
   * `false`: a leaf - this peer never passes on somebody else's frames.
   * For phones and background tabs: iOS suspends
   * WebRTC when the display locks, and a suspended tree node takes its
   * whole subtree along until the repair path has healed it.
   * @default true
   */
  relay?: boolean
  /**
   * 'tree' (Plumtree) or 'flood' (every first-seen frame goes to every
   * link but the one it came over - y-webrtc's cost, for measurements).
   * @default 'tree'
   */
  mode?: 'tree' | 'flood'
  /**
   * Links this peer keeps eager BY DEFAULT (for origins it has not heard
   * yet); it asks for the others to be lazy. 1: the defaults form a tree.
   * @default 1
   */
  feeds?: number
  /** One DIGEST goes out per tick, to the lazy links in turn. @default 1000 */
  digestIntervalMs?: number
  /** How long a frame a DIGEST announced may still arrive by itself before it is GRAFTed. @default 400 */
  graftDelayMs?: number
  /** A SUSPECT without an ALIVE for this long: the peer is gone. @default 3000 */
  suspectTimeoutMs?: number
  /** connect() resolves at the first link, or after this when the room is empty. @default 3000 */
  firstLinkTimeoutMs?: number
  /**
   * The round trip the core should expect before it has measured one: a
   * frame and its answer cross 3-4 links each way. Without it the core
   * starts from a single link's timing, takes what is still on its way for
   * missing, and asks for it: at 300 peers the OTHER peers' cores sent 93
   * broadcasts and 196 unicasts while one peer typed 30 characters, against
   * 55 and 2 on a full mesh (bench-partial-mesh).
   * @default 250
   */
  expectedRttMs?: number
  /** Frames kept for GRAFT replies. @default 30000 ms / 4 MiB */
  cacheMs?: number
  cacheBytes?: number
  debug?: boolean
}

const F_HELLO = 0
const F_GOSSIP = 1
const F_UNICAST = 2
const F_DIGEST = 3
const F_GRAFT = 4
const F_PRUNE = 5

const G_CONTROL = 1 // payload is for the wrapper, not the core
const G_REPLY = 2 // a GRAFT reply: a duplicate of it says nothing about the tree
const G_TUNNEL = 4 // a unicast without a route, inside a broadcast: see _onUnicast
const U_CONTROL = 0x40 // in a UNICAST's hop byte: the payload is for the wrapper

const C_SUSPECT = 0
const C_ALIVE = 1
const C_LEAVE = 2
const C_REVIVE = 3 // unicast: "I had given you up" - see _alive

const HELLO_LEAF = 1
const WIRE_VERSION = 1
const ID_BYTES = 6
const MAX_HOPS = 32
const MAX_ABOVE = 1024 // out-of-order seqs remembered per origin before the gap is given up
const UNICAST_WINDOW = 256
const EARLY_MS = 3000 // see Origin.first

interface Link {
  id: string // the inner transport's address of this link
  peer?: string // the wrapper id behind it, from its HELLO
  leaf: boolean
  lazy: boolean // the default, both ways, for an origin without an entry below
  // Origins for which one direction is the opposite of the default. The
  // RECEIVER decides: `flipIn` is what we asked the other end for (PRUNE /
  // GRAFT), `flipOut` what it asked us for.
  flipIn: Set<string>
  flipOut: Set<string>
  pruned: Map<string, number> // origin -> when we last said PRUNE for it
  told: Map<string, number> // origin -> high-water mark this link heard from us in a DIGEST
  graftTimer?: ReturnType<typeof setTimeout>
  wanted: Map<string, number> // origin -> highest seq this link's DIGESTs announced and we lack
}

interface Origin {
  hw: number // every broadcast seq <= hw has been seen
  above: Set<number> // seen out of order
  aged: number // hw one digest tick ago: what a DIGEST may announce
  // First contact: what came before `first` is history - except what is
  // still on its way. A joiner's second frame reached a peer over a
  // shortcut (3 hops) 8 ms before its first, the JOIN beacon, came down the
  // tree (8 hops); dropped as "before my time", and the joiner never got
  // that peer's presence. Until `earlyUntil`, a seq below `first` counts.
  first: number
  top: number // highest seq seen: only a frame beyond it may move `route`
  early: Set<number>
  earlyUntil: number
  route?: string // link id the first copy came over
  unicastSeen: number[]
  gone: boolean
  goneAt?: number
  suspectTimer?: ReturnType<typeof setTimeout>
}

interface Cached {
  origin: string
  seq: number
  frame: Uint8Array
  at: number
}

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16)
  return s
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

function randomId(): string {
  const bytes = new Uint8Array(ID_BYTES)
  const c = (globalThis as any).crypto
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return toHex(bytes)
}

export class ConferenceTransport implements Transport {
  /** This peer's address in the room: what the core gets as `from` on the other side. */
  readonly id: string = randomId()
  /** Counters for benchmarks and the playground. */
  readonly stats = { duplicates: 0, prunes: 0, grafts: 0, digests: 0, suspects: 0, unroutable: 0 }

  private readonly _idBytes = fromHex(this.id)
  private readonly _opts: Required<Omit<ConferenceTransportOptions, 'expectedPeers'>> & { expectedPeers: number }
  private _seq = 0
  private _agedOwn = 0 // _seq one digest tick ago
  private _useq = 0
  private _refuted: string[] = [] // SUSPECT frames ('origin:seq') an ALIVE has answered
  private _ownTunnelled: number[] = [] // our unicasts that came back and went out again through a tunnel
  private _connected = false
  private _links = new Map<string, Link>()
  private _byPeer = new Map<string, Link>()
  private _origins = new Map<string, Origin>()
  private _cache: Cached[] = []
  private _cacheIndex = new Map<string, Cached>()
  private _cacheSize = 0
  private _digestTimer?: ReturnType<typeof setInterval>
  private _digestTurn = 0
  private _firstLink?: () => void
  private _unsubscribe: Array<() => void> = []
  private _pendingSuspects = new Map<string, ReturnType<typeof setTimeout>>()
  private _lastRoomSize = 0

  private _onMessage?: (data: Uint8Array, from?: string) => void
  private _onConnect?: (peerId: string) => void
  private _onDisconnect?: (peerId: string) => void

  constructor(
    private readonly inner: MeshTransport,
    options: ConferenceTransportOptions = {},
  ) {
    if (typeof inner.sendTo !== 'function' || typeof inner.onPeerConnect !== 'function' || typeof inner.onPeerDisconnect !== 'function') {
      throw new Error('ConferenceTransport needs a mesh transport with sendTo, onPeerConnect and onPeerDisconnect (simple-peer, peerjs)')
    }
    this._opts = {
      expectedPeers: options.expectedPeers ?? 0,
      relay: options.relay ?? true,
      mode: options.mode ?? 'tree',
      feeds: options.feeds ?? 1,
      digestIntervalMs: options.digestIntervalMs ?? 1000,
      graftDelayMs: options.graftDelayMs ?? 400,
      suspectTimeoutMs: options.suspectTimeoutMs ?? 3000,
      firstLinkTimeoutMs: options.firstLinkTimeoutMs ?? 3000,
      expectedRttMs: options.expectedRttMs ?? 250,
      cacheMs: options.cacheMs ?? 30000,
      cacheBytes: options.cacheBytes ?? 4 * 1024 * 1024,
      debug: options.debug ?? false,
    }
  }

  get isConnected(): boolean {
    return this._connected && this.inner.isConnected
  }

  get preferredBatchMs(): number | undefined {
    return this.inner.preferredBatchMs
  }

  get expectedRttMs(): number {
    return Math.max(this._opts.expectedRttMs, this.inner.expectedRttMs ?? 0)
  }

  /** Peers of the room this wrapper has heard and not given up, itself included. */
  get roomSize(): number {
    let n = 1
    for (const o of this._origins.values()) if (!o.gone) n++
    return n
  }

  /** Open links, how many are eager by default, and how many are eager for `origin` (its tree). */
  linkCount(origin: string = this.id): { links: number; feeds: number; tree: number } {
    let feeds = 0
    let tree = 0
    for (const l of this._links.values()) {
      if (!l.lazy) feeds++
      if (this._eager(l, origin, 'out')) tree++
    }
    return { links: this._links.size, feeds, tree }
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this._unsubscribe.push(
      this.inner.onMessage((frame, link) => {
        if (link !== undefined) this._onFrame(frame, link)
      }),
      this.inner.onPeerConnect((link) => this._linkUp(link)),
      this.inner.onPeerDisconnect((link) => this._linkDown(link)),
    )
    this.inner.configureSparse?.({ expectedPeers: this._opts.expectedPeers || undefined, passive: !this._opts.relay })
    this._publishRoomSize()
    await this.inner.connect(config)
    this._connected = true
    if (this._opts.mode === 'tree') {
      this._digestTimer = setInterval(() => this._digestTick(), this._opts.digestIntervalMs)
    }
    if (this._byPeer.size > 0) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this._opts.firstLinkTimeoutMs)
      this._firstLink = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    this._firstLink = undefined
  }

  disconnect(): void {
    if (this._connected && this._links.size > 0) this._broadcastControl(C_LEAVE)
    this._connected = false
    if (this._digestTimer !== undefined) clearInterval(this._digestTimer)
    this._digestTimer = undefined
    for (const timer of this._pendingSuspects.values()) clearTimeout(timer)
    this._pendingSuspects.clear()
    for (const o of this._origins.values()) if (o.suspectTimer !== undefined) clearTimeout(o.suspectTimer)
    for (const l of this._links.values()) if (l.graftTimer !== undefined) clearTimeout(l.graftTimer)
    this.inner.flush?.()
    this.inner.disconnect()
    for (const off of this._unsubscribe) off()
    this._unsubscribe = []
    this._links.clear()
    this._byPeer.clear()
    this._origins.clear()
    this._cache = []
    this._cacheIndex.clear()
    this._cacheSize = 0
    this._firstLink?.()
  }

  flush(): void {
    this.inner.flush?.()
  }

  send(data: Uint8Array): void {
    if (!this._connected) return
    this._originate(0, data)
  }

  sendTo(peerId: string, data: Uint8Array): void {
    this._sendUnicast(peerId, data, 0)
  }

  private _sendUnicast(peerId: string, data: Uint8Array, flags: number): void {
    if (!this._connected) return
    const e = encoding.createEncoder()
    encoding.writeUint8(e, F_UNICAST)
    encoding.writeUint8(e, flags)
    encoding.writeUint8Array(e, this._idBytes)
    encoding.writeUint8Array(e, fromHex(peerId))
    encoding.writeVarUint(e, ++this._useq)
    encoding.writeUint8Array(e, data)
    if (!this._routeUnicast(encoding.toUint8Array(e), peerId, undefined)) this._tunnel(this.id, peerId, this._useq, flags !== 0, data)
  }

  onMessage(callback: (data: Uint8Array, from?: string) => void): () => void {
    this._onMessage = callback
    return () => (this._onMessage = undefined)
  }

  onPeerConnect(callback: (peerId: string) => void): () => void {
    this._onConnect = callback
    return () => (this._onConnect = undefined)
  }

  onPeerDisconnect(callback: (peerId: string) => void): () => void {
    this._onDisconnect = callback
    return () => (this._onDisconnect = undefined)
  }

  // ---------------------------------------------------------------- links

  private _linkUp(linkId: string): Link {
    let link = this._links.get(linkId)
    if (link !== undefined) return link
    // A new link starts eager for everything; _onHello decides about its default.
    link = { id: linkId, leaf: false, lazy: false, flipIn: new Set(), flipOut: new Set(), pruned: new Map(), told: new Map(), wanted: new Map() }
    this._links.set(linkId, link)
    const e = encoding.createEncoder()
    encoding.writeUint8(e, F_HELLO)
    encoding.writeUint8Array(e, this._idBytes)
    encoding.writeUint8(e, this._opts.relay ? 0 : HELLO_LEAF)
    encoding.writeUint8(e, WIRE_VERSION)
    this._sendLink(link, encoding.toUint8Array(e))
    return link
  }

  /**
   * 'out': do we pass `origin`'s frames on over this link; 'in': do we expect
   * them over it. One flag for both looked simpler and cut peers off: a feed
   * that got a duplicate FROM us pruned the link, and with it what it sent
   * TO us - while our other source had just lost against it (the gate, a
   * link cut at N=100: five peers without any eager link for one origin,
   * its ALIVE never reached them). So the receiver alone says who sends to
   * it, and it prunes a link only over a duplicate - when another link has
   * just delivered.
   */
  private _eager(link: Link, origin: string, way: 'in' | 'out'): boolean {
    if (this._opts.mode === 'flood') return true
    // A peer's own frames go over its own links, whatever their default.
    const base = !link.lazy || origin === this.id || origin === link.peer
    return (way === 'in' ? link.flipIn : link.flipOut).has(origin) ? !base : base
  }

  private _setEager(link: Link, origin: string, way: 'in' | 'out', eager: boolean): void {
    const base = !link.lazy || origin === this.id || origin === link.peer
    const flip = way === 'in' ? link.flipIn : link.flipOut
    if (eager === base) flip.delete(origin)
    else flip.add(origin)
  }

  /** Links that are eager by default and lead to a peer that passes frames on. */
  private _feeds(except?: Link): number {
    let n = 0
    for (const l of this._links.values()) if (l !== except && l.peer !== undefined && !l.lazy && !l.leaf) n++
    return n
  }

  private _setDefault(link: Link, lazy: boolean): void {
    link.lazy = lazy
    link.flipIn.clear()
    link.flipOut.clear()
    if (!lazy) return
    // Not for the origins whose frames reach us over this link: a fresh
    // joiner's links are all eager until its HELLOs are through, it hands
    // its neighbours first copies meanwhile - and then both ends called the
    // link lazy, each taking the other for its feed (the gate: a peer that
    // joined a moment before was missing from one roster in 50, 1 run in 6).
    const keep: string[] = []
    for (const [id, o] of this._origins) if (o.route === link.id && !o.gone && id !== link.peer) keep.push(id)
    if (keep.length > 0) this._graft(link, keep)
  }

  private _linkDown(linkId: string): void {
    const link = this._links.get(linkId)
    if (link === undefined) return
    this._links.delete(linkId)
    if (link.graftTimer !== undefined) clearTimeout(link.graftTimer)
    const orphans: string[] = []
    for (const [id, o] of this._origins) {
      if (o.route !== linkId) continue
      o.route = undefined
      // The link's own peer too: a closed link does not say that it is gone, and its ALIVE has to find us.
      if (!o.gone) orphans.push(id)
    }
    const peer = link.peer
    // Only this link's own entry: a peer that re-dialled has a newer link here.
    if (peer !== undefined && this._byPeer.get(peer) === link) this._byPeer.delete(peer)
    if (!this._connected) return
    if (this._opts.mode === 'tree') this._regraft(orphans)
    if (peer !== undefined && !this._byPeer.has(peer)) this._scheduleSuspect(peer)
  }

  /**
   * A link went. Do not wait for a DIGEST to find out what it was good for:
   * keep FEEDS links eager by default, and ask every remaining neighbour for
   * the origins whose frames came over the lost link (`orphans`) - one of
   * them has a path, the duplicates prune the others again.
   */
  private _regraft(orphans: string[]): void {
    const candidates = Array.from(this._links.values()).filter((l) => l.peer !== undefined && !l.leaf)
    const lazy = candidates.filter((l) => l.lazy)
    while (this._feeds() < this._opts.feeds && lazy.length > 0) {
      const link = lazy.splice(Math.floor(Math.random() * lazy.length), 1)[0]
      this._setDefault(link, false)
      this.stats.grafts++
      this._sendLink(link, new Uint8Array([F_GRAFT, 0]))
    }
    if (orphans.length === 0) return
    for (const link of candidates) {
      const asks = orphans.filter((id) => !this._eager(link, id, 'in'))
      if (asks.length > 0) this._graft(link, asks)
    }
  }

  private _graft(link: Link, origins: string[]): void {
    const e = encoding.createEncoder()
    encoding.writeUint8(e, F_GRAFT)
    encoding.writeVarUint(e, origins.length)
    for (const id of origins) {
      encoding.writeUint8Array(e, fromHex(id))
      encoding.writeVarUint(e, Math.max(0, this._origins.get(id)?.hw ?? 0))
      this._setEager(link, id, 'in', true)
    }
    this.stats.grafts++
    this._sendLink(link, encoding.toUint8Array(e))
  }

  private _sendLink(link: Link, frame: Uint8Array): void {
    try {
      const result = this.inner.sendTo(link.id, frame)
      if (result instanceof Promise) result.catch(() => {})
    } catch {
      // The inner transport rebuilds a link whose send() throws; what was lost comes back over a DIGEST.
    }
  }

  // ------------------------------------------------------------- incoming

  private _onFrame(frame: Uint8Array, linkId: string): void {
    if (frame.length === 0) return
    // A frame may overtake the inner transport's "link open" event.
    const link = this._links.get(linkId) ?? this._linkUp(linkId)
    try {
      switch (frame[0]) {
        case F_HELLO:
          return this._onHello(frame, link)
        case F_GOSSIP:
          return this._onGossip(frame, link)
        case F_UNICAST:
          return this._onUnicast(frame, link)
        case F_DIGEST:
          return this._onDigest(frame, link)
        case F_GRAFT:
          return this._onGraft(frame, link)
        case F_PRUNE:
          return this._onPrune(frame, link)
      }
    } catch (error) {
      if (this._opts.debug) console.warn('[conference] bad frame', error)
    }
  }

  private _onHello(frame: Uint8Array, link: Link): void {
    if (frame.length < 1 + ID_BYTES + 2) return
    const peer = toHex(frame.subarray(1, 1 + ID_BYTES))
    if (peer === this.id) return
    const first = link.peer === undefined
    link.peer = peer
    link.leaf = (frame[1 + ID_BYTES] & HELLO_LEAF) !== 0
    this._byPeer.set(peer, link)
    const origin = this._origin(peer)
    this._alive(peer, origin)
    this._publishRoomSize()
    if (!first) return
    // Enough feeds already: this link is a lazy one, unless the other end needs it (_onPrune).
    if (this._opts.mode === 'tree' && this._feeds(link) >= this._opts.feeds) {
      this._sendLink(link, new Uint8Array([F_PRUNE, 0])) // before _setDefault's GRAFT
      this._setDefault(link, true)
    }
    this._firstLink?.()
    this._onConnect?.(peer)
  }

  private _origin(id: string, firstSeq?: number): Origin {
    let o = this._origins.get(id)
    if (o === undefined) {
      // What an origin sent before we heard of it is history: the core's join sync covers it.
      const hw = firstSeq === undefined ? -1 : firstSeq - 1
      o = { hw, above: new Set(), aged: hw, first: hw + 1, top: hw, early: new Set(), earlyUntil: Date.now() + EARLY_MS, unicastSeen: [], gone: false }
      this._origins.set(id, o)
      this._publishRoomSize()
    }
    return o
  }

  /** true when (origin, seq) is new. */
  private _markSeen(o: Origin, seq: number): boolean {
    if (o.hw === -1) {
      o.hw = o.aged = seq - 1
      o.first = seq
      o.earlyUntil = Date.now() + EARLY_MS
    }
    if (seq < o.first) {
      if (o.early.has(seq) || Date.now() > o.earlyUntil) return false
      o.early.add(seq)
      return true
    }
    if (seq <= o.hw || o.above.has(seq)) return false
    o.above.add(seq)
    while (o.above.delete(o.hw + 1)) o.hw++
    if (o.above.size > MAX_ABOVE) {
      // A gap nobody could fill: give it up (the core's anti-entropy owns the document).
      o.hw = Math.min(...o.above) - 1
      while (o.above.delete(o.hw + 1)) o.hw++
    }
    return true
  }

  private _onGossip(frame: Uint8Array, link: Link): void {
    const flags = frame[1]
    const hops = frame[2]
    const originId = toHex(frame.subarray(3, 3 + ID_BYTES))
    const d = decoding.createDecoder(frame.subarray(3 + ID_BYTES))
    const seq = decoding.readVarUint(d)
    const tree = this._opts.mode === 'tree' && !(flags & G_REPLY)
    if (originId === this.id) return this._duplicate(link, originId, tree)
    const origin = this._origin(originId, seq)
    if (!this._markSeen(origin, seq)) return this._duplicate(link, originId, tree)

    const payload = frame.subarray(3 + ID_BYTES + d.pos)
    // Routes must come from frames that ran through the room one after the
    // other - then they are loop-free. A straggler (a seq below one we have
    // seen, over a slower path) is no such frame: with routes taken from
    // them a peer's answer to a JOIN went p33 > p25 > p39 > p97 > p35 > p33.
    const front = seq > origin.top
    if (front) origin.top = seq
    if (origin.route === undefined || !this._links.has(origin.route) || (tree && front)) origin.route = link.id
    // The link that brought the latest first copy stays eager. Two frames
    // sent back to back (a joiner's beacon and its presence) can reach us
    // over two links in opposite order: the first frame's duplicate pruned
    // link B, the second comes over B first (our PRUNE still on its way) and
    // its duplicate prunes A - cut off from that origin, for good in an
    // idle room (the gate: one roster in 50 lacked a peer in 2 of 5 runs).
    if (tree && front && !this._eager(link, originId, 'in')) this._graft(link, [originId])
    if (flags & G_CONTROL) this._onControl(originId, origin, seq, payload)
    else if (flags & G_TUNNEL) this._onTunnel(payload)
    else if (!origin.gone) this._onMessage?.(payload, originId)
    else if (tree && front) {
      // Given up and sending: alive. Only a frame that is NEW says so - a
      // GRAFT reply comes out of a cache, up to `cacheMs` after its origin
      // left, and its presence inside would put a ghost into our roster.
      this._alive(originId, origin)
      this._onMessage?.(payload, originId)
    }

    if (!this._opts.relay || hops >= MAX_HOPS) return
    const next = frame.slice()
    next[1] = flags & ~G_REPLY
    next[2] = hops + 1
    this._remember(originId, seq, next)
    for (const other of this._links.values()) {
      if (other !== link && other.peer !== originId && this._eager(other, originId, 'out')) this._sendLink(other, next)
    }
  }

  private _duplicate(link: Link, origin: string, tree: boolean): void {
    this.stats.duplicates++
    if (!tree) return
    // Lazy here and still coming: the other end sees it differently - say it again, not per frame.
    const now = Date.now()
    if (!this._eager(link, origin, 'in') && now - (link.pruned.get(origin) ?? 0) < 1000) return
    this._setEager(link, origin, 'in', false)
    link.pruned.set(origin, now)
    this.stats.prunes++
    const e = encoding.createEncoder()
    encoding.writeUint8(e, F_PRUNE)
    encoding.writeVarUint(e, 1)
    encoding.writeUint8Array(e, fromHex(origin))
    this._sendLink(link, encoding.toUint8Array(e))
  }

  private _onPrune(frame: Uint8Array, link: Link): void {
    const d = decoding.createDecoder(frame.subarray(1))
    const count = decoding.readVarUint(d)
    for (let i = 0; i < count; i++) this._setEager(link, toHex(decoding.readUint8Array(d, ID_BYTES)), 'out', false)
    if (count > 0) return
    // PRUNE-ALL: "lazy by default". Not when that leaves us short of feeds.
    if (!link.leaf && this._feeds(link) < this._opts.feeds) {
      this._setDefault(link, false)
      this._sendLink(link, new Uint8Array([F_GRAFT, 0]))
    } else this._setDefault(link, true)
  }

  /**
   * Unicast follows the routes the origin's broadcasts left behind. They are
   * loop-free as long as they come from frames that ran through the room one
   * after the other; a route that is missing or points the wrong way shows
   * as a frame that comes BACK (to a peer that passed it on, or to its
   * origin). That peer sends it as a broadcast of its own with the
   * destination inside (a TUNNEL): N-1 frames down its tree, where sending
   * it over every link was 7,500 at 300 peers - instead of losing a peer's
   * answer to a JOIN.
   */
  private _onUnicast(frame: Uint8Array, link: Link): void {
    const control = (frame[1] & U_CONTROL) !== 0
    const hops = frame[1] & ~U_CONTROL
    const originId = toHex(frame.subarray(2, 2 + ID_BYTES))
    const dest = toHex(frame.subarray(2 + ID_BYTES, 2 + 2 * ID_BYTES))
    const d = decoding.createDecoder(frame.subarray(2 + 2 * ID_BYTES))
    const useq = decoding.readVarUint(d)
    const payload = frame.subarray(2 + 2 * ID_BYTES + d.pos)
    if (originId === this.id) {
      if (!this._ownTunnelled.includes(useq)) {
        this._ownTunnelled.push(useq)
        if (this._ownTunnelled.length > UNICAST_WINDOW) this._ownTunnelled.shift()
        this._tunnel(originId, dest, useq, control, payload)
      }
      return
    }
    const origin = this._origin(originId)
    if (origin.route === undefined || !this._links.has(origin.route)) origin.route = link.id
    if (dest === this.id) return this._deliverUnicast(originId, origin, useq, control, payload)
    if (!this._opts.relay) return
    if (this._unicastSeen(origin, useq)) {
      // A second time: it went in a circle.
      this.stats.duplicates++
      if (!this._unicastSeen(origin, -useq)) this._tunnel(originId, dest, useq, control, payload)
      return
    }
    const next = frame.slice()
    next[1] = Math.min(hops + 1, MAX_HOPS) | (control ? U_CONTROL : 0)
    if (hops >= MAX_HOPS || !this._routeUnicast(next, dest, link)) this._tunnel(originId, dest, useq, control, payload)
  }

  /** true when (origin, key) was seen before; remembers it. */
  private _unicastSeen(origin: Origin, key: number): boolean {
    if (origin.unicastSeen.includes(key)) return true
    origin.unicastSeen.push(key)
    if (origin.unicastSeen.length > UNICAST_WINDOW) origin.unicastSeen.shift()
    return false
  }

  /** One delivery, whether it came along the routes or through a tunnel. */
  private _deliverUnicast(originId: string, origin: Origin, useq: number, control: boolean, payload: Uint8Array): void {
    if (this._unicastSeen(origin, useq)) return void this.stats.duplicates++
    if (origin.gone) this._alive(originId, origin)
    if (!control) this._onMessage?.(payload, originId)
    else if (payload[0] === C_REVIVE) this._onConnect?.(originId)
  }

  /** false: no way known. */
  private _routeUnicast(frame: Uint8Array, dest: string, arrivedOn: Link | undefined): boolean {
    const direct = this._byPeer.get(dest)
    const routeId = this._origins.get(dest)?.route
    const next = direct ?? (routeId !== undefined ? this._links.get(routeId) : undefined)
    if (next === undefined || next === arrivedOn) return false
    this._sendLink(next, frame)
    return true
  }

  private _tunnel(originId: string, dest: string, useq: number, control: boolean, payload: Uint8Array): void {
    this.stats.unroutable++
    const e = encoding.createEncoder()
    encoding.writeUint8Array(e, fromHex(dest))
    encoding.writeUint8Array(e, fromHex(originId))
    encoding.writeVarUint(e, useq)
    encoding.writeUint8(e, control ? 1 : 0)
    encoding.writeUint8Array(e, payload)
    this._originate(G_TUNNEL, encoding.toUint8Array(e))
  }

  private _onTunnel(payload: Uint8Array): void {
    if (toHex(payload.subarray(0, ID_BYTES)) !== this.id) return
    const originId = toHex(payload.subarray(ID_BYTES, 2 * ID_BYTES))
    if (originId === this.id) return
    const d = decoding.createDecoder(payload.subarray(2 * ID_BYTES))
    const useq = decoding.readVarUint(d)
    const control = decoding.readUint8(d) === 1
    this._deliverUnicast(originId, this._origin(originId), useq, control, payload.subarray(2 * ID_BYTES + d.pos))
  }

  // ------------------------------------------------------------ broadcast

  private _originate(flags: number, payload: Uint8Array): void {
    const e = encoding.createEncoder()
    encoding.writeUint8(e, F_GOSSIP)
    encoding.writeUint8(e, flags)
    encoding.writeUint8(e, 0)
    encoding.writeUint8Array(e, this._idBytes)
    encoding.writeVarUint(e, ++this._seq)
    encoding.writeUint8Array(e, payload)
    const frame = encoding.toUint8Array(e)
    this._remember(this.id, this._seq, frame)
    for (const link of this._links.values()) if (this._eager(link, this.id, 'out')) this._sendLink(link, frame)
  }

  private _remember(origin: string, seq: number, frame: Uint8Array): void {
    if (this._opts.mode !== 'tree') return
    const entry: Cached = { origin, seq, frame, at: Date.now() }
    this._cache.push(entry)
    this._cacheIndex.set(origin + ':' + seq, entry)
    this._cacheSize += frame.length
    const oldest = entry.at - this._opts.cacheMs
    while (this._cache.length > 0 && (this._cacheSize > this._opts.cacheBytes || this._cache[0].at < oldest)) {
      const drop = this._cache.shift()!
      this._cacheIndex.delete(drop.origin + ':' + drop.seq)
      this._cacheSize -= drop.frame.length
    }
  }

  // ------------------------------------------------------- digest / graft

  /**
   * One DIGEST per tick, to the lazy links in turn: what it costs does not
   * grow with the number of links, and a peer that lacks something has
   * several lazy neighbours taking turns. It announces the state of one
   * tick AGO - what is still on its way over the tree is not "missing".
   */
  private _digestTick(): void {
    if (!this._connected) return
    const own = this._seq
    const lazy = Array.from(this._links.values()).filter((l) => l.peer !== undefined)
    let sent = false
    for (let i = 0; i < lazy.length && !sent; i++) {
      const link = lazy[(this._digestTurn + i) % lazy.length]
      const entries: Array<[string, number]> = []
      if (!this._eager(link, this.id, 'out') && this._agedOwn > (link.told.get(this.id) ?? 0)) entries.push([this.id, this._agedOwn])
      if (this._opts.relay) {
        for (const [id, o] of this._origins) {
          if (o.gone || o.aged < 0 || id === link.peer || this._eager(link, id, 'out')) continue
          if (o.aged > (link.told.get(id) ?? -1)) entries.push([id, o.aged])
        }
      }
      if (entries.length === 0) continue
      const e = encoding.createEncoder()
      encoding.writeUint8(e, F_DIGEST)
      encoding.writeVarUint(e, entries.length)
      for (const [id, hw] of entries) {
        encoding.writeUint8Array(e, fromHex(id))
        encoding.writeVarUint(e, hw)
        link.told.set(id, hw)
      }
      this.stats.digests++
      this._sendLink(link, encoding.toUint8Array(e))
      this._digestTurn = (this._digestTurn + i + 1) % lazy.length
      sent = true
    }
    this._agedOwn = own
    const forget = Date.now() - 2 * this._opts.cacheMs
    for (const [id, o] of this._origins) {
      o.aged = o.hw
      // Kept for a while: a late frame of a departed peer is still a duplicate.
      if (o.gone && o.goneAt !== undefined && o.goneAt < forget) this._origins.delete(id)
    }
  }

  private _onDigest(frame: Uint8Array, link: Link): void {
    const d = decoding.createDecoder(frame.subarray(1))
    const count = decoding.readVarUint(d)
    for (let i = 0; i < count; i++) {
      const id = toHex(decoding.readUint8Array(d, ID_BYTES))
      const hw = decoding.readVarUint(d)
      if (id === this.id) continue
      const known = this._origins.get(id)
      if (known === undefined || known.hw === -1) {
        // Never heard: its history is the join sync's business, its next frame is ours.
        const o = this._origin(id)
        if (o.hw < hw) {
          o.hw = o.aged = hw
          o.first = hw + 1
          o.earlyUntil = Date.now() + EARLY_MS
        }
        continue
      }
      if (known.gone || hw <= known.hw) continue
      if (hw > (link.wanted.get(id) ?? 0)) link.wanted.set(id, hw)
    }
    if (link.wanted.size === 0 || link.graftTimer !== undefined) return
    link.graftTimer = setTimeout(() => {
      link.graftTimer = undefined
      if (!this._connected || !this._links.has(link.id)) return
      const asks: string[] = []
      for (const [id, hw] of link.wanted) {
        const o = this._origins.get(id)
        if (o !== undefined && !o.gone && o.hw < hw) asks.push(id)
      }
      link.wanted.clear()
      if (asks.length > 0) this._graft(link, asks)
    }, this._opts.graftDelayMs)
  }

  private _onGraft(frame: Uint8Array, link: Link): void {
    const d = decoding.createDecoder(frame.subarray(1))
    const count = decoding.readVarUint(d)
    if (count === 0) return this._setDefault(link, false) // GRAFT-ALL
    for (let i = 0; i < count; i++) {
      const id = toHex(decoding.readUint8Array(d, ID_BYTES))
      const from = decoding.readVarUint(d)
      this._setEager(link, id, 'out', true)
      const to = id === this.id ? this._seq : (this._origins.get(id)?.hw ?? -1)
      for (let seq = from + 1; seq <= to; seq++) {
        const entry = this._cacheIndex.get(id + ':' + seq)
        if (entry === undefined) continue
        const reply = entry.frame.slice()
        reply[1] |= G_REPLY
        this._sendLink(link, reply)
      }
      link.told.set(id, to)
    }
  }

  // ----------------------------------------------------------- membership

  /** SUSPECT names its target; ALIVE names the SUSPECT it answers (that frame's origin and seq). */
  private _broadcastControl(type: number, peer?: string, seq?: number): void {
    const e = encoding.createEncoder()
    encoding.writeUint8(e, type)
    if (peer !== undefined) encoding.writeUint8Array(e, fromHex(peer))
    if (seq !== undefined) encoding.writeVarUint(e, seq)
    this._originate(G_CONTROL, encoding.toUint8Array(e))
  }

  /**
   * Our link to `peer` closed. Every neighbour of a dead peer notices that
   * at about the same time: wait a random moment, and say nothing if
   * somebody else's SUSPECT came by meanwhile.
   */
  private _scheduleSuspect(peer: string): void {
    const origin = this._origins.get(peer)
    if (origin === undefined || origin.gone || this._pendingSuspects.has(peer)) return
    this._pendingSuspects.set(
      peer,
      setTimeout(
        () => {
          this._pendingSuspects.delete(peer)
          if (!this._connected || this._byPeer.has(peer)) return
          const o = this._origins.get(peer)
          if (o === undefined || o.gone || o.suspectTimer !== undefined) return
          this.stats.suspects++
          this._suspect(peer, o)
          this._broadcastControl(C_SUSPECT, peer)
        },
        Math.random() * this._opts.suspectTimeoutMs * 0.1,
      ),
    )
  }

  private _suspect(peer: string, origin: Origin): void {
    if (origin.gone || origin.suspectTimer !== undefined) return
    origin.suspectTimer = setTimeout(() => {
      origin.suspectTimer = undefined
      if (this._byPeer.has(peer)) return
      this._gone(peer, origin)
    }, this._opts.suspectTimeoutMs)
  }

  private _gone(peer: string, origin: Origin): void {
    if (origin.suspectTimer !== undefined) clearTimeout(origin.suspectTimer)
    origin.suspectTimer = undefined
    if (origin.gone) return
    origin.gone = true
    origin.goneAt = Date.now()
    origin.route = undefined
    this._publishRoomSize()
    this._onDisconnect?.(peer)
  }

  private _alive(peer: string, origin: Origin): void {
    if (origin.suspectTimer !== undefined) clearTimeout(origin.suspectTimer)
    origin.suspectTimer = undefined
    const pending = this._pendingSuspects.get(peer)
    if (pending !== undefined) {
      clearTimeout(pending)
      this._pendingSuspects.delete(peer)
    }
    if (!origin.gone) return
    origin.gone = false
    this._publishRoomSize()
    // We told our core that this peer is gone, and the core dropped its
    // presence. It is not: tell it. Its wrapper reports us to ITS core as a
    // link that re-opened, which answers with its presence at a raised clock
    // (_schedulePeerConnectSync) - without this the roster waited for that
    // peer's next renewal, half a lease.
    this._sendUnicast(peer, new Uint8Array([C_REVIVE]), U_CONTROL)
  }

  private _onControl(originId: string, origin: Origin, seq: number, payload: Uint8Array): void {
    switch (payload[0]) {
      case C_SUSPECT: {
        const target = toHex(payload.subarray(1, 1 + ID_BYTES))
        if (target === this.id) return this._broadcastControl(C_ALIVE, originId, seq)
        if (this._byPeer.has(target)) return // our own link to it is the better witness
        // The answer may be here already: SUSPECT and ALIVE run down two
        // different trees. An ALIVE that arrived 25 ms before its SUSPECT
        // stopped no timer, and 3 s later a living peer was "gone".
        if (this._refuted.includes(originId + ':' + seq)) return
        const o = this._origins.get(target)
        if (o !== undefined) this._suspect(target, o)
        return
      }
      case C_ALIVE: {
        const d = decoding.createDecoder(payload.subarray(1 + ID_BYTES))
        this._refuted.push(toHex(payload.subarray(1, 1 + ID_BYTES)) + ':' + decoding.readVarUint(d))
        if (this._refuted.length > 128) this._refuted.shift()
        return this._alive(originId, origin)
      }
      case C_LEAVE:
        return this._gone(originId, origin)
    }
  }

  private _publishRoomSize(): void {
    const size = this.roomSize
    if (size === this._lastRoomSize) return
    this._lastRoomSize = size
    this.inner.setRoomSize?.(size)
  }
}
