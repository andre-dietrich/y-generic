/**
 * Probe (round 9 research, 2026-09-20): can GenericProvider run on a PARTIAL
 * WebRTC mesh the way y-webrtc does - every peer holds ~20-34 links instead
 * of N-1 and the room still behaves like one room?
 *
 * y-webrtc 10.3.0 (read in node_modules): `maxConns = 20 + floor(rand * 15)`,
 * checked only by the side that INITIATES on an 'announce' (an incoming offer
 * is always accepted), and `_docUpdateHandler` / `_awarenessUpdateHandler`
 * ignore `origin`: whatever changed a peer's doc or awareness is sent on to
 * all of its links. Flooding that ends because a duplicate changes nothing
 * and therefore fires no event. No timers, no periodic resync.
 *
 * GenericProvider deliberately does NOT re-send what it received (the comment
 * in _setupAwarenessSync: N*(N-1) deliveries per change), and reply
 * suppression, responder self-selection, presence on demand and removal
 * suppression all assume that a broadcast reaches every peer of the room.
 * So the probe puts the relay UNDER the core, in a Transport wrapper that
 * makes a partial mesh look like the broadcast medium the core expects:
 *
 *   full     every peer linked to every peer, no relay        (today)
 *   partial  y-webrtc's topology, no relay                     (today, maxConns too small - F1 of round 8)
 *   flood    y-webrtc's topology + relay: a frame seen for the first time
 *            goes on to every link but the one it came from    (y-webrtc's cost, under the core)
 *   tree     same, but a peer forwards only to its children in the
 *            shortest-path tree of the frame's origin. The tree comes from
 *            the simulator's global view - an ORACLE: the lower bound for a
 *            link-state or Plumtree design, its control traffic not counted
 *   fullflood / fulltree   the relay on a full mesh: what a room that fits
 *            under the cap would pay for it
 *
 * Links are ordered and reliable like a data channel (FIFO per direction,
 * HOP_MS +-25 %). Every frame on every link is counted.
 *
 * Phases per variant: N joins 25 ms apart -> 5 s idle -> peer 0 (the oldest,
 * farthest from the last joiners) types KEYS characters 100 ms apart ->
 * moves its cursor KEYS times -> one pub/sub message -> a peer is killed.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/probe-partial-mesh.js
 *      N=100 CAP_MIN=20 CAP_SPREAD=15 HOP_MS=20 KEYS=30 SEED=1 VARIANTS=full,partial,flood,tree override.
 *      TOPOLOGY=1 prints only what y-webrtc's join rule builds (200 seeds per N).
 *      RULE=random DIAL=10: a joiner gets DIAL links to random peers instead (both modes).
 *      JOIN_AT_FIRST_LINK=0 / MEMBERSHIP=0: the relay without the two things the probe found it needs.
 */

import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { GenericProvider } from '../../src/index'
import type { Transport } from '../../src/transport'
import { sleep, silenced } from './bench-user-scaling'

const N = Number(process.env.N ?? 100)
const CAP_MIN = Number(process.env.CAP_MIN ?? 20)
const CAP_SPREAD = Number(process.env.CAP_SPREAD ?? 15)
const HOP_MS = Number(process.env.HOP_MS ?? 20)
const KEYS = Number(process.env.KEYS ?? 30)
const SEED = Number(process.env.SEED ?? 1)
const VARIANTS = (process.env.VARIANTS ?? 'full,partial,flood,tree').split(',')
const JOIN_AT_FIRST_LINK = process.env.JOIN_AT_FIRST_LINK !== '0'
const MEMBERSHIP = process.env.MEMBERSHIP !== '0'
const RULE = process.env.RULE ?? 'ywebrtc'
const DIAL = Number(process.env.DIAL ?? 10)

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * y-webrtc's join rule, peers joining one after the other: the joiner
 * announces, every existing peer below ITS cap dials it, the joiner accepts
 * every offer. `capped: false` is the full mesh.
 */
function buildTopology(n: number, capped: boolean, rand: () => number): Set<number>[] {
  const adj = Array.from({ length: n }, () => new Set<number>())
  if (capped && RULE === 'random') {
    // The alternative: a joiner gets DIAL links to RANDOM peers below the hard cap.
    const hard = CAP_MIN + CAP_SPREAD - 1
    for (let j = 1; j < n; j++) {
      const candidates: number[] = []
      for (let i = 0; i < j; i++) if (adj[i].size < hard) candidates.push(i)
      for (let d = 0; d < DIAL && candidates.length > 0; d++) {
        const i = candidates.splice(Math.floor(rand() * candidates.length), 1)[0]
        adj[i].add(j)
        adj[j].add(i)
      }
    }
    return adj
  }
  const caps = adj.map(() => (capped ? CAP_MIN + Math.floor(rand() * CAP_SPREAD) : Infinity))
  for (let j = 1; j < n; j++) {
    for (let i = 0; i < j; i++) {
      if (adj[i].size < caps[i]) {
        adj[i].add(j)
        adj[j].add(i)
      }
    }
  }
  return adj
}

/** BFS parents from `root` over `alive` nodes; lowest index wins a tie. -1 = unreachable. */
function bfsParents(adj: Set<number>[], root: number, alive: (i: number) => boolean): { parent: number[]; depth: number[] } {
  const parent = new Array(adj.length).fill(-1)
  const depth = new Array(adj.length).fill(-1)
  depth[root] = 0
  let frontier = [root]
  while (frontier.length > 0) {
    const next: number[] = []
    for (const u of frontier.sort((a, b) => a - b)) {
      for (const v of Array.from(adj[u]).sort((a, b) => a - b)) {
        if (depth[v] !== -1 || !alive(v)) continue
        depth[v] = depth[u] + 1
        parent[v] = u
        next.push(v)
      }
    }
    frontier = next
  }
  return { parent, depth }
}

function graphStats(adj: Set<number>[]) {
  let diameter = 0
  let connected = true
  for (let r = 0; r < adj.length; r++) {
    const { depth } = bfsParents(adj, r, () => true)
    for (const d of depth) {
      if (d === -1) connected = false
      else if (d > diameter) diameter = d
    }
  }
  const degrees = adj.map((s) => s.size)
  return {
    connected,
    diameter,
    minDeg: Math.min(...degrees),
    maxDeg: Math.max(...degrees),
    avgDeg: degrees.reduce((a, b) => a + b, 0) / degrees.length,
    links: degrees.reduce((a, b) => a + b, 0) / 2,
  }
}

/** The simulated network: who is linked to whom, and every frame on every link counted. */
class MeshNet {
  tx = 0
  bytes = 0
  unroutable = 0
  duplicates = 0
  readonly nodes: LinkTransport[] = []
  readonly relays: RelayTransport[] = []
  private _lastAt = new Map<string, number>()
  private _trees = new Map<number, number[]>()

  constructor(readonly adj: Set<number>[]) {}

  resetCounters(): void {
    this.tx = this.bytes = this.unroutable = this.duplicates = 0
  }

  topologyChanged(): void {
    this._trees.clear()
  }

  deliver(from: LinkTransport, to: LinkTransport, data: Uint8Array): void {
    this.tx++
    this.bytes += data.length
    // A data channel is ordered: never overtake the frame before on this link.
    const key = from.index + '>' + to.index
    const at = Math.max(Date.now() + HOP_MS * (0.75 + Math.random() * 0.5), (this._lastAt.get(key) ?? 0) + 0.01)
    this._lastAt.set(key, at)
    setTimeout(() => {
      if (from.isConnected && to.isConnected) to.receive(data, from.id)
    }, at - Date.now())
  }

  /** ORACLE: is `child` a child of `me` in the shortest-path tree rooted at `origin`? */
  isTreeChild(origin: number, me: number, child: number): boolean {
    let parents = this._trees.get(origin)
    if (!parents) {
      parents = bfsParents(this.adj, origin, (i) => this.nodes[i]?.isConnected === true).parent
      this._trees.set(origin, parents)
    }
    return parents[child] === me
  }
}

/** One peer's set of data channels - what peerjs/simple-peer/trystero are to the core. */
class LinkTransport implements Transport {
  isConnected = false
  readonly id: string
  private _onMessage?: (data: Uint8Array, from?: string) => void
  private _onConnect?: (peerId: string) => void
  private _onDisconnect?: (peerId: string) => void

  constructor(readonly net: MeshNet, readonly index: number) {
    this.id = 'p' + index
    net.nodes[index] = this
  }

  private _neighbours(): LinkTransport[] {
    const out: LinkTransport[] = []
    for (const j of this.net.adj[this.index]) {
      const other = this.net.nodes[j]
      if (other?.isConnected) out.push(other)
    }
    return out
  }

  async connect(): Promise<void> {
    this.isConnected = true
    this.net.topologyChanged()
    for (const other of this._neighbours()) {
      setTimeout(() => {
        this._onConnect?.(other.id)
        other._onConnect?.(this.id)
      }, HOP_MS)
    }
  }

  /** Also the probe's "killed tab": the channels close, nothing is said. */
  disconnect(): void {
    if (!this.isConnected) return
    const neighbours = this._neighbours()
    const { depth } = bfsParents(this.net.adj, this.index, (i) => this.net.nodes[i]?.isConnected === true)
    this.isConnected = false
    this.net.topologyChanged()
    for (const other of neighbours) setTimeout(() => other._onDisconnect?.(this.id), HOP_MS)
    // See RelayTransport.peerUnreachable: the news travels one hop at a time.
    if (!MEMBERSHIP) return
    this.net.relays.forEach((relay, i) => {
      if (depth[i] > 1) setTimeout(() => relay.peerUnreachable(this.id), depth[i] * HOP_MS)
    })
  }

  send(data: Uint8Array): void {
    if (!this.isConnected) return
    for (const other of this._neighbours()) this.net.deliver(this, other, data)
  }

  /** Like the real mesh transports: no channel to that peer, no delivery. */
  sendTo(peerId: string, data: Uint8Array): void {
    if (!this.isConnected) return
    const other = this._neighbours().find((t) => t.id === peerId)
    if (other) this.net.deliver(this, other, data)
    else this.net.unroutable++
  }

  receive(data: Uint8Array, from: string): void {
    this._onMessage?.(data, from)
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
}

/**
 * The thing under test: a relay between the core and a partial mesh. Frame =
 * origin, per-origin sequence number, destination ('' = the room), payload.
 * A frame seen before is dropped; a new one is handed to the core with its
 * ORIGIN as `from` and sent on. sendTo() to a peer without a link follows the
 * link that peer's frames arrive on (a learning bridge), else floods.
 * Peer connect/disconnect stay per LINK: the core announces a lost
 * neighbour's departure to the room itself (_handlePeerLeave).
 */
class RelayTransport implements Transport {
  private _seq = 0
  // ponytail: grows with every frame; a real one keeps a per-origin high-water mark plus a small window.
  private _seen = new Map<string, Set<number>>()
  private _route = new Map<string, string>()
  private _links = new Set<string>()
  private _onMessage?: (data: Uint8Array, from?: string) => void
  private _onConnect?: (peerId: string) => void
  private _onDisconnect?: (peerId: string) => void

  private _firstLink?: () => void

  constructor(private readonly inner: LinkTransport, private readonly mode: 'flood' | 'tree') {
    inner.net.relays[inner.index] = this
    inner.onMessage((frame, link) => this._onFrame(frame, link!))
    inner.onPeerConnect((id) => {
      this._links.add(id)
      this._firstLink?.()
      this._onConnect?.(id)
    })
    inner.onPeerDisconnect((id) => {
      this._links.delete(id)
      for (const [origin, link] of this._route) if (link === id) this._route.delete(origin)
      this._onDisconnect?.(id)
    })
  }

  get isConnected(): boolean {
    return this.inner.isConnected
  }
  /**
   * The core sends its JOIN beacon ("send me your presence") when connect()
   * resolves. On a mesh that is before any channel is open and nobody hears
   * it - a full mesh does not care, every channel that opens brings that
   * peer's presence (_schedulePeerConnectSync). Behind a relay most of the
   * room never opens a channel to us, so connect() resolves with the first
   * link (plus one hop for the links that open with it; alone in the room:
   * after 5 hops of silence). JOIN_AT_FIRST_LINK=0 shows the difference.
   */
  async connect(): Promise<void> {
    await this.inner.connect()
    if (!JOIN_AT_FIRST_LINK || this._links.size > 0) return
    await new Promise<void>((resolve) => {
      this._firstLink = resolve
      setTimeout(resolve, 5 * HOP_MS)
    })
    await sleep(HOP_MS)
  }
  disconnect(): void {
    this.inner.disconnect()
  }

  /**
   * A peer WITHOUT a link to us is gone. The core cannot learn that from the
   * room: it vetoes a third party's removal of any peer it has an address
   * for (to the core an address means a live link - true on a full mesh,
   * false behind a relay), and a removal carries the remover's clock for
   * that peer, which is behind ours whenever a later link-open bumped it
   * (_schedulePeerConnectSync) - measured: a killed peer stayed in 35-76 of
   * 99 rosters. So the relay has to report departures itself, as
   * onPeerDisconnect, like a full mesh does. Here the simulator says so
   * (ORACLE, MEMBERSHIP=0 turns it off); a real relay knows it from the
   * link state it needs for the tree anyway: no path left = gone.
   */
  peerUnreachable(peerId: string): void {
    this._route.delete(peerId)
    this._onDisconnect?.(peerId)
  }

  send(data: Uint8Array): void {
    this._forward(this._frame('', data), this.inner.id, '', undefined)
  }

  sendTo(peerId: string, data: Uint8Array): void {
    this._forward(this._frame(peerId, data), this.inner.id, peerId, undefined)
  }

  private _frame(dest: string, payload: Uint8Array): Uint8Array {
    const e = encoding.createEncoder()
    encoding.writeVarString(e, this.inner.id)
    encoding.writeVarUint(e, ++this._seq)
    encoding.writeVarString(e, dest)
    encoding.writeVarUint8Array(e, payload)
    return encoding.toUint8Array(e)
  }

  private _onFrame(frame: Uint8Array, link: string): void {
    const d = decoding.createDecoder(frame)
    const origin = decoding.readVarString(d)
    const seq = decoding.readVarUint(d)
    const dest = decoding.readVarString(d)
    if (origin === this.inner.id) return
    let seen = this._seen.get(origin)
    if (!seen) this._seen.set(origin, (seen = new Set()))
    if (seen.has(seq)) {
      this.inner.net.duplicates++
      return
    }
    seen.add(seq)
    this._route.set(origin, link) // the first copy came the fastest way
    if (dest === '' || dest === this.inner.id) this._onMessage?.(decoding.readVarUint8Array(d), origin)
    if (dest !== this.inner.id) this._forward(frame, origin, dest, link)
  }

  private _forward(frame: Uint8Array, origin: string, dest: string, arrivedOn: string | undefined): void {
    if (dest !== '') {
      const next = this._links.has(dest) ? dest : this._route.get(dest)
      if (next !== undefined && next !== arrivedOn) {
        this.inner.sendTo(next, frame)
        return
      }
    }
    const net = this.inner.net
    for (const link of this._links) {
      if (link === arrivedOn) continue
      if (this.mode === 'tree' && dest === '' && !net.isTreeChild(Number(origin.slice(1)), this.inner.index, Number(link.slice(1)))) continue
      this.inner.sendTo(link, frame)
    }
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
}

const VARIANT_DEFS: Record<string, { capped: boolean; relay?: 'flood' | 'tree' }> = {
  full: { capped: false },
  partial: { capped: true },
  flood: { capped: true, relay: 'flood' },
  tree: { capped: true, relay: 'tree' },
  fullflood: { capped: false, relay: 'flood' },
  fulltree: { capped: false, relay: 'tree' },
}

function percentile(sorted: number[], p: number): number {
  return sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

async function runVariant(name: string): Promise<Record<string, string | number>> {
  const def = VARIANT_DEFS[name]
  const net = new MeshNet(buildTopology(N, def.capped, mulberry32(SEED)))
  const stats = graphStats(net.adj)
  const providers: GenericProvider[] = []
  const row: Record<string, string | number> = {
    variant: name,
    'links/peer': `${stats.minDeg}-${stats.maxDeg}`,
    hops: stats.diameter,
  }

  // --- join ---
  for (let i = 0; i < N; i++) {
    const link = new LinkTransport(net, i)
    const provider = new GenericProvider(new Y.Doc(), def.relay ? new RelayTransport(link, def.relay) : link, { disableBc: true })
    providers.push(provider)
    // As the playgrounds do: presence is set once connect() has resolved.
    provider.connect({ room: 'probe' }).then(() => provider.awareness.setLocalStateField('user', { name: 'p' + i }))
    await sleep(25)
  }
  await sleep(4000)
  const rosterSizes = providers.map((p) => Array.from(p.awareness.getStates().values()).filter((s) => (s as any).user).length)
  row['join frames'] = net.tx
  row['join KB'] = Math.round(net.bytes / 1024)
  row['full rosters'] = `${rosterSizes.filter((s) => s === N).length}/${N} (min ${Math.min(...rosterSizes)})`

  // --- idle ---
  net.resetCounters()
  await sleep(5000)
  row['idle frames/s'] = Math.round(net.tx / 5)

  // --- typing: peer 0, KEYS characters ---
  const text = providers[0].doc.getText('t')
  const typedAt: number[] = []
  const delays: number[] = []
  providers.slice(1).forEach((p) => {
    const t = p.doc.getText('t')
    let had = 0
    t.observe(() => {
      const now = Date.now()
      for (; had < t.length; had++) delays.push(now - typedAt[had])
    })
  })
  net.resetCounters()
  for (let k = 0; k < KEYS; k++) {
    typedAt.push(Date.now())
    text.insert(text.length, 'x')
    await sleep(100)
  }
  await sleep(1000)
  row['frames/key'] = Math.round(net.tx / KEYS)
  row['bytes/key'] = Math.round(net.bytes / KEYS)
  row['dup/key'] = Math.round(net.duplicates / KEYS)
  const fast = delays.filter((d) => d <= 1000).sort((a, b) => a - b)
  row['keys <=1s'] = `${((100 * fast.length) / (KEYS * (N - 1))).toFixed(1)} %`
  row['p50/p95/max ms'] = `${percentile(fast, 0.5)}/${percentile(fast, 0.95)}/${fast[fast.length - 1] ?? '-'}`
  await sleep(9000) // two periodic beacons: what dissemination missed, anti-entropy may still bring
  const want = text.toString()
  row['docs equal +10s'] = `${providers.filter((p) => p.doc.getText('t').toString() === want).length}/${N}`

  // --- cursor: peer 0, KEYS changes ---
  net.resetCounters()
  for (let k = 0; k < KEYS; k++) {
    providers[0].awareness.setLocalStateField('cursor', k)
    await sleep(100)
  }
  await sleep(1000)
  row['frames/cursor'] = Math.round(net.tx / KEYS)
  const id0 = providers[0].doc.clientID
  row['see cursor'] = `${providers.slice(1).filter((p) => (p.awareness.getStates().get(id0) as any)?.cursor === KEYS - 1).length}/${N - 1}`

  // --- pub/sub: one message from peer 0 ---
  let heard = 0
  providers.slice(1).forEach((p) => p.pubsub.subscribe('probe', () => heard++))
  providers[0].pubsub.publish('probe', { hello: 1 })
  await sleep(1000)
  row['pubsub heard'] = `${heard}/${N - 1}`

  // --- a killed tab: the channels close, nothing is said ---
  const victim = Math.floor(N / 2)
  const victimId = providers[victim].doc.clientID
  const survivors = providers.filter((_, i) => i !== victim)
  // A departure reported by the transport names an ADDRESS; the core can act
  // on it only where it has learned which clientID lives there.
  row['know victim addr'] = `${survivors.filter((p) => (p as any)._peerAddress.has(victimId)).length}/${N - 1}`
  const killedAt = Date.now()
  net.nodes[victim].disconnect()
  let stillIn = survivors.length
  while (stillIn > 0 && Date.now() - killedAt < 10000) {
    await sleep(50)
    stillIn = survivors.filter((p) => p.awareness.getStates().has(victimId)).length
  }
  row['kill -> gone'] = stillIn === 0 ? `${Date.now() - killedAt} ms` : `still in ${stillIn} rosters after 10 s`
  row['unroutable'] = net.unroutable

  for (const p of providers) p.destroy()
  return row
}

function printTopologies(): void {
  console.log(
    RULE === 'random'
      ? `random join rule (${DIAL} links to random peers below ${CAP_MIN + CAP_SPREAD - 1}), 200 seeds per N:`
      : `y-webrtc's join rule (cap ${CAP_MIN}-${CAP_MIN + CAP_SPREAD - 1}, sequential joins, no churn), 200 seeds per N:`,
  )
  for (const n of [25, 50, 100, 200, 400]) {
    let disconnected = 0
    let maxDiameter = 0
    let minDeg = Infinity
    let maxDeg = 0
    let links = 0
    for (let seed = 1; seed <= 200; seed++) {
      const s = graphStats(buildTopology(n, true, mulberry32(seed)))
      if (!s.connected) disconnected++
      maxDiameter = Math.max(maxDiameter, s.diameter)
      minDeg = Math.min(minDeg, s.minDeg)
      maxDeg = Math.max(maxDeg, s.maxDeg)
      links += s.links
    }
    console.log(
      `  N=${n}: not connected in ${disconnected}/200, diameter <= ${maxDiameter}, links/peer ${minDeg}-${maxDeg}, ` +
        `${Math.round(links / 200)} links vs ${(n * (n - 1)) / 2} in a full mesh`,
    )
  }
}

async function main() {
  if (process.env.TOPOLOGY) return printTopologies()
  console.log(`partial mesh probe: N=${N}, cap ${CAP_MIN}-${CAP_MIN + CAP_SPREAD - 1}, ${HOP_MS} ms per hop, ${KEYS} keystrokes, seed ${SEED}`)
  const rows: Record<string, string | number>[] = []
  for (const name of VARIANTS) {
    if (!VARIANT_DEFS[name]) throw new Error(`unknown variant ${name}`)
    rows.push(await silenced(() => runVariant(name)))
    console.log(`  ${name} done`)
  }
  console.table(rows)
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
