/**
 * Gate (round 11): a room that does not fit into a full mesh. N
 * GenericProviders, each on the REAL ConferenceTransport
 * (src/providers/conference) over a simulated partial mesh - every joiner
 * gets DIAL links to random peers, nobody holds N-1.
 *
 * probe-partial-mesh.ts (round 9) measured what such a relay has to do, with
 * an ORACLE for the tree and for "that peer is gone". This gate has neither:
 * the tree is Plumtree's, departures are the transport's SUSPECT/ALIVE.
 *
 * Variants:
 *   full        the full mesh without the wrapper - the frame count to beat
 *   conference  partial mesh + ConferenceTransport
 *   leaves      same, LEAF_SHARE of the peers are leaves (`relay: false`: phones)
 *   flood       same topology, mode 'flood' (not gated: what y-webrtc's way costs)
 *   dial        nobody hands out the links: a simulated signaling channel (an
 *               announce reaches everybody SIG_MS later) and the REAL dial rule
 *               (src/providers/dial.ts), configured the way a user does it -
 *               `expectedPeers` on the wrapper (EXPECTED, default N)
 *   dialleaves  same, LEAF_SHARE of the peers are leaves
 *
 * Phases: N joins JOIN_MS apart -> idle -> peer 0 types KEYS characters
 * 100 ms apart -> the LAST joiner types -> cursor moves -> one pub/sub ->
 * a link between two living peers is cut (nobody may lose anybody) -> the
 * peer with the most tree links is killed while peer 0 types on (the
 * repair path) -> every roster must drop it, every document must be equal.
 *
 * FAILS on: an incomplete roster, a keystroke that took longer than 1.5 s
 * (the first one after a silence takes ~1 s to reach a peer that joined since,
 * see the typing phase; 3 s while the tree repairs itself after a kill), a ghost, a lost cursor or pub/sub message,
 * a peer missing after a link cut, more than RELAY_RATIO x (N-1) frames per
 * broadcast of the core (the relay's own cost: DIGESTs, PRUNEs, duplicates),
 * more than MAX_RATIO x the full mesh's frames per keystroke (what the core
 * adds on top when paths differ in length).
 *
 * Links are ordered and reliable like a data channel (FIFO per direction,
 * HOP_MS +-25 %). Every frame on every link is counted - DIGESTs, PRUNEs and
 * HELLOs too.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-partial-mesh.js
 *      N=100,150 DIAL=10 HOP_MS=20 KEYS=30 JOIN_MS=25 SEED=1 LEAF_SHARE=0.5 MAX_RATIO=2 RELAY_RATIO=1.5
 *      VARIANTS=full,conference,leaves,dial,dialleaves[,flood]   (N=300: ~4 min per variant)
 *      DIAG=1 names the holes of a roster and prints the frames around them; TRACE_FILE=path dumps all frames
 *      PHASES=join stops after the join.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import type { Transport } from '../../src/transport'
import { ConferenceTransport } from '../../src/providers/conference'
import { SparseDial } from '../../src/providers/dial'
import { sleep, silenced } from './bench-user-scaling'

const NS = (process.env.N ?? '100').split(',').map(Number)
const DIAL = Number(process.env.DIAL ?? 10)
const HOP_MS = Number(process.env.HOP_MS ?? 20)
const KEYS = Number(process.env.KEYS ?? 30)
const JOIN_MS = Number(process.env.JOIN_MS ?? 25)
const SEED = Number(process.env.SEED ?? 1)
const LEAF_SHARE = Number(process.env.LEAF_SHARE ?? 0.5)
// Against the full mesh's frames per keystroke. Not 1.5: the CORE sends more
// behind a relay - its periodic beacons are suppressed by overhearing an
// equal one, and with paths of 1-5 hops fewer are equal in time (N=300: 91
// beacons of the listeners while one peer types 30 characters, 55 on the
// full mesh; each is N-1 frames either way). Measured 1.1x at N=100, 1.45x at
// 150, 1.7x at 300. What the relay itself costs is RELAY_RATIO's business.
const MAX_RATIO = Number(process.env.MAX_RATIO ?? 2)
const RELAY_RATIO = Number(process.env.RELAY_RATIO ?? 1.5)
const KEY_LIMIT_MS = Number(process.env.KEY_LIMIT_MS ?? 1500) // see the typing phase
const VARIANTS = (process.env.VARIANTS ?? 'full,conference,leaves,dial,dialleaves').split(',')
const SIG_MS = Number(process.env.SIG_MS ?? 30)
const ANNOUNCE_MS = Number(process.env.ANNOUNCE_MS ?? 5000)

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A joiner dials `dial` random peers that are already there; `relays` limits whom (a leaf is no use as a neighbour). */
function buildTopology(n: number, dial: number, rand: () => number, isRelay: (i: number) => boolean): Set<number>[] {
  const adj = Array.from({ length: n }, () => new Set<number>())
  for (let j = 1; j < n; j++) {
    const candidates: number[] = []
    for (let i = 0; i < j; i++) if (isRelay(i) || j < 3) candidates.push(i)
    for (let d = 0; d < dial && candidates.length > 0; d++) {
      const i = candidates.splice(Math.floor(rand() * candidates.length), 1)[0]
      adj[i].add(j)
      adj[j].add(i)
    }
  }
  return adj
}

class MeshNet {
  tx = 0
  bytes = 0
  /** Frames by their first byte: the wrapper's frame type (HELLO, GOSSIP, UNICAST, DIGEST, GRAFT, PRUNE). */
  types: number[] = []
  readonly nodes: LinkTransport[] = []
  private _lastAt = new Map<string, number>()

  constructor(readonly adj: Set<number>[]) {}

  resetCounters(): void {
    this.tx = this.bytes = 0
    this.types = []
  }

  typeCounts(): string {
    return ['hello', 'gossip', 'unicast', 'digest', 'graft', 'prune'].map((name, t) => `${name} ${this.types[t] ?? 0}`).join(', ')
  }

  /** DIAG=1: every wrapper frame that names an origin, for holes() to print what happened around a hole. */
  readonly trace: Array<{ at: number; from: number; to: number; what: string; origin: string }> = []
  private _t0 = Date.now()
  now(): number {
    return Date.now() - this._t0
  }

  private _traceFrame(from: number, to: number, data: Uint8Array): void {
    const hex = (at: number) => Array.from(data.subarray(at, at + 6), (b) => b.toString(16).padStart(2, '0')).join('')
    const at = Date.now() - this._t0
    if (data[0] === 1) this.trace.push({ at, from, to, what: `gossip seq ${data[9]}${data[1] & 2 ? ' REPLY' : ''}${data[1] & 1 ? ' control' : ''} hops ${data[2]}`, origin: hex(3) })
    else if (data[0] === 2) this.trace.push({ at, from, to, what: `unicast -> ${hex(8)} hops ${data[1]} (${data.length} B)`, origin: hex(2) })
    else if (data[0] === 3) {
      // DIGEST: count and the first entry
      const count = data[1]
      this.trace.push({ at, from, to, what: `DIGEST ${count} entries, first ${hex(2)} hw ${data[8]}`, origin: hex(2) })
    } else if (data[0] === 4 || data[0] === 5) {
      const name = data[0] === 4 ? 'GRAFT' : 'PRUNE'
      if (data[1] === 0) this.trace.push({ at, from, to, what: name + '-ALL', origin: '*' })
      else this.trace.push({ at, from, to, what: name + (data[1] > 1 ? ` (+${data[1] - 1} more)` : ''), origin: hex(2) })
    }
  }

  deliver(from: LinkTransport, to: LinkTransport, data: Uint8Array): void {
    if (process.env.DIAG) this._traceFrame(from.index, to.index, data)
    this.tx++
    this.bytes += data.length
    this.types[data[0]] = (this.types[data[0]] ?? 0) + 1
    // A data channel is ordered: never overtake the frame before on this link.
    const key = from.index + '>' + to.index
    const at = Math.max(Date.now() + HOP_MS * (0.75 + Math.random() * 0.5), (this._lastAt.get(key) ?? 0) + 0.01)
    this._lastAt.set(key, at)
    setTimeout(() => {
      if (from.isConnected && to.isConnected && this.adj[from.index].has(to.index)) to.receive(data, from.id)
    }, at - Date.now())
  }

  // --- 'dial' variants: signaling, and links that come from the dial rule ---
  announces = 0
  linksOpened = 0
  private _pending = new Set<string>()

  announce(from: LinkTransport): void {
    this.announces++
    for (const node of this.nodes) {
      if (node !== from && node?.isConnected) setTimeout(() => node.heardAnnounce(from), SIG_MS * (0.75 + Math.random() * 0.5))
    }
  }

  /** `a` dials `b`: offer, answer, ICE - three signaling trips and a hop later the channel is open at both ends. */
  open(a: LinkTransport, b: LinkTransport): void {
    const key = Math.min(a.index, b.index) + '-' + Math.max(a.index, b.index)
    if (this._pending.has(key) || this.adj[a.index].has(b.index)) return // glare: one link
    this._pending.add(key)
    a.pending++
    b.pending++
    setTimeout(() => {
      this._pending.delete(key)
      a.pending--
      b.pending--
      if (!a.isConnected || !b.isConnected || !b.acceptsOffer()) return
      this.linksOpened++
      this.adj[a.index].add(b.index)
      this.adj[b.index].add(a.index)
      a.linkOpened(b.id)
      b.linkOpened(a.id)
    }, 3 * SIG_MS + HOP_MS)
  }

  /** A link between two living peers closes (ICE gave up on it): both ends hear it. */
  cut(a: number, b: number): void {
    this.adj[a].delete(b)
    this.adj[b].delete(a)
    setTimeout(() => {
      this.nodes[a].linkClosed(this.nodes[b].id)
      this.nodes[b].linkClosed(this.nodes[a].id)
    }, HOP_MS)
  }
}

/** One peer's set of data channels - what simple-peer / peerjs are to the wrapper. */
class LinkTransport implements Transport {
  isConnected = false
  readonly id: string
  private _onMessage?: (data: Uint8Array, from?: string) => void
  private _onConnect?: (peerId: string) => void
  private _onDisconnect?: (peerId: string) => void

  constructor(
    readonly net: MeshNet,
    readonly index: number,
    /** true: the links come from the dial rule, not from `net.adj` as built up front. */
    readonly dynamic = false,
  ) {
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
    if (this.dynamic) {
      const announce = () => {
        if (this.isConnected && this._sparse!.wantsLinks(this.linkCount())) this.net.announce(this)
      }
      announce()
      this._announceTimer = setInterval(announce, ANNOUNCE_MS)
      return
    }
    for (const other of this._neighbours()) {
      setTimeout(() => {
        this._onConnect?.(other.id)
        other._onConnect?.(this.id)
      }, HOP_MS)
    }
  }

  /** Also the "killed tab": the channels close, nothing is said. */
  disconnect(): void {
    if (!this.isConnected) return
    const neighbours = this._neighbours()
    this.isConnected = false
    if (this._announceTimer !== undefined) clearInterval(this._announceTimer)
    for (const other of neighbours) {
      setTimeout(() => {
        this.net.adj[other.index].delete(this.index)
        other.linkClosed(this.id)
      }, HOP_MS)
    }
  }

  linkClosed(peerId: string): void {
    this._onDisconnect?.(peerId)
    if (this._sparse?.wantsLinks(this.linkCount())) this.net.announce(this)
  }

  // --- 'dial' variants: what SimplePeerTransport does with ../../src/providers/dial.ts ---
  pending = 0
  passive = false
  private _sparse?: SparseDial
  private _announceTimer?: ReturnType<typeof setInterval>

  configureSparse(options: { expectedPeers?: number; passive?: boolean }): void {
    if (!this.dynamic) return
    this.passive = options.passive ?? false
    const dial = process.env.DIAL_RULE ? Number(process.env.DIAL_RULE) : Math.max(4, Math.ceil(Math.log(options.expectedPeers ?? 17)))
    this._sparse = new SparseDial({ dial, maxConns: 64, passive: this.passive })
  }
  setRoomSize(peers: number): void {
    this._sparse?.setRoomSize(peers)
  }
  linkCount(): number {
    return this.net.adj[this.index].size + this.pending
  }
  acceptsOffer(): boolean {
    return this._sparse?.accepts(this.linkCount()) ?? true
  }
  heardAnnounce(from: LinkTransport): void {
    if (!this.isConnected || !this._sparse || this.net.adj[this.index].has(from.index)) return
    if (this._sparse.answers(from.id, this.linkCount(), from.passive)) this.net.open(this, from)
  }
  linkOpened(peerId: string): void {
    this._onConnect?.(peerId)
  }

  send(data: Uint8Array): void {
    if (!this.isConnected) return
    for (const other of this._neighbours()) this.net.deliver(this, other, data)
  }

  sendTo(peerId: string, data: Uint8Array): void {
    if (!this.isConnected) return
    const other = this._neighbours().find((t) => t.id === peerId)
    if (other) this.net.deliver(this, other, data)
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

function percentile(sorted: number[], p: number): number {
  return sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

interface Result {
  row: Record<string, string | number>
  framesPerKey: number
  failures: string[]
}

async function runVariant(name: string, n: number): Promise<Result> {
  const rand = mulberry32(SEED)
  const wrapped = name !== 'full'
  const dynamic = name === 'dial' || name === 'dialleaves'
  const leafAt = (i: number) => (name === 'leaves' || name === 'dialleaves') && i > 0 && i % Math.round(1 / LEAF_SHARE) !== 0
  const adj = dynamic
    ? Array.from({ length: n }, () => new Set<number>())
    : wrapped
      ? buildTopology(n, DIAL, rand, (i) => !leafAt(i))
      : buildTopology(n, n, rand, () => true)
  const net = new MeshNet(adj)
  const providers: GenericProvider[] = []
  const wrappers: ConferenceTransport[] = []
  const failures: string[] = []
  const degrees = adj.map((s) => s.size)
  const row: Record<string, string | number> = {
    variant: name,
    N: n,
    'links/peer': `${Math.min(...degrees)}-${Math.max(...degrees)}`,
  }
  const coreSends = { broadcast: [] as number[], unicast: [] as number[], kinds: new Map<string, number>(), typist: 0 }
  const coreSendsOfOthers = (who: number) => {
    const sum = (a: number[]) => a.reduce((x, y, i) => x + (i === who ? 0 : (y ?? 0)), 0)
    const kinds = Array.from(coreSends.kinds, ([k, v]) => `${v} ${k}`).join(', ')
    const out = `${sum(coreSends.broadcast)} broadcasts, ${sum(coreSends.unicast)} unicasts: ${kinds}`
    coreSends.broadcast = []
    coreSends.unicast = []
    coreSends.kinds.clear()
    return out
  }
  const rosterOf = (p: GenericProvider) => Array.from(p.awareness.getStates().values()).filter((s) => (s as any).user).length
  /** "p3 lacks p47 (wrapper: never heard)" for the first few holes - what DIAG=1 is in the browser harness. */
  const holes = (alive: number[]): string => {
    const out: string[] = []
    for (const i of alive) {
      for (const j of alive) {
        if (i === j || out.length >= 6) continue
        const state = providers[i].awareness.getStates().get(providers[j].doc.clientID) as any
        if (state?.user) continue
        const o = wrapped ? (wrappers[i] as any)._origins.get(wrappers[j].id) : undefined
        let detail = ''
        if (wrapped) {
          // Every link of the peer with the hole: is it eager for that origin at our end / at the other end, and what has the other end got?
          const origin = wrappers[j].id
          const links = Array.from(adj[i]).map((m) => {
            const mine = (wrappers[i] as any)._links.get('p' + m)
            const theirs = (wrappers[m] as any)._links.get('p' + i)
            // E/L: eager or lazy for that origin; lower case: that is the link's default, upper case: a flip against it
            const flag = (w: any, l: any, way: 'in' | 'out') =>
              l === undefined ? '-' : (way === 'in' ? l.eagerIn : l.eagerOut).has(origin) ? (w._eager(l, origin, way) ? 'E' : 'L') : w._eager(l, origin, way) ? 'e' : 'l'
            // first letter: do WE expect that origin over this link, second: does the other end send it
            return `p${m}:${flag(wrappers[i], mine, 'in')}${flag(wrappers[m], theirs, 'out')}${m === j ? ' own' : ' hw' + ((wrappers[m] as any)._origins.get(origin)?.hw ?? '?')}`
          })
          detail = ` (wrapper: ${o === undefined ? 'never heard' : o.gone ? 'gone' : 'hw ' + o.hw}, state ${state === undefined ? 'none' : 'without user'}, p${j} sent ${(wrappers[j] as any)._seq}; links ${links.join(' ')})`
        }
        out.push(`p${i} lacks p${j}` + detail)
        if (wrapped && process.env.DIAG) {
          const origin = wrappers[j].id
          // The peer with the hole and whoever it takes for its feed.
          const watch = new Set([i, ...Array.from(adj[i]).filter((m) => (wrappers[i] as any)._eager((wrappers[i] as any)._links.get('p' + m), origin, 'in'))])
          // What the missing peer sent to this one alone: its answer to the JOIN.
          for (const t of net.trace) {
            if (t.origin === origin && t.what.startsWith(`unicast -> ${wrappers[i].id}`)) process.stderr.write(`    ${t.at} ms  p${t.from} -> p${t.to}  ${t.what}\n`)
          }
          for (const t of net.trace) {
            if (t.what.startsWith('unicast')) continue
            if ((watch.has(t.from) || watch.has(t.to)) && (t.origin === origin || (t.origin === '*' && t.at > 1000))) process.stderr.write(`    ${t.at} ms  p${t.from} -> p${t.to}  ${t.what}\n`)
          }
        }
      }
    }
    return out.join('; ')
  }
  const everybody = Array.from({ length: n }, (_, i) => i)

  // --- join ---
  for (let i = 0; i < n; i++) {
    const link = new LinkTransport(net, i, dynamic)
    let transport: Transport = link
    if (wrapped) {
      const wrapper = new ConferenceTransport(link, {
        relay: !leafAt(i),
        mode: name === 'flood' ? 'flood' : 'tree',
        feeds: process.env.FEEDS ? Number(process.env.FEEDS) : undefined,
        expectedRttMs: process.env.RTT_HINT ? Number(process.env.RTT_HINT) : undefined,
        expectedPeers: dynamic ? Number(process.env.EXPECTED ?? n) : undefined,
        firstLinkTimeoutMs: dynamic ? undefined : 5 * HOP_MS,
      })
      wrappers[i] = wrapper
      if (process.env.DIAG) {
        // When did this wrapper give a peer up?
        const gone = (wrapper as any)._gone.bind(wrapper)
        ;(wrapper as any)._gone = (peer: string, origin: unknown) => {
          net.trace.push({ at: net.now(), from: i, to: i, what: 'GONE', origin: peer })
          gone(peer, origin)
        }
      }
      transport = wrapper
    }
    {
      // What the CORE sends: broadcasts and unicasts per peer (the wrapper's own frames are not in here).
      const t = transport as any
      const send = t.send.bind(t)
      const sendTo = t.sendTo.bind(t)
      // After the 4-byte CRC: the core's message type, for a digest beacon its flags.
      const kind = (data: Uint8Array) => {
        const type = ['sync', 'awareness', 'pubsub', 'verified', 'batch', 'digest', 'push'][data[4]] ?? 'type' + data[4]
        return type === 'digest' ? `digest(flags ${data[6]})` : type
      }
      const note = (how: string, data: Uint8Array) => {
        if (i === coreSends.typist) return
        const key = how + ' ' + kind(data)
        coreSends.kinds.set(key, (coreSends.kinds.get(key) ?? 0) + 1)
      }
      t.send = (data: Uint8Array) => (note('broadcast', data), (coreSends.broadcast[i] = (coreSends.broadcast[i] ?? 0) + 1), send(data))
      t.sendTo = (to: string, data: Uint8Array) => (note('unicast', data), (coreSends.unicast[i] = (coreSends.unicast[i] ?? 0) + 1), sendTo(to, data))
    }
    const provider = new GenericProvider(new Y.Doc(), transport, { disableBc: true })
    providers.push(provider)
    // As the playgrounds do: presence is set once connect() has resolved.
    provider.connect({ room: 'gate' }).then(() => provider.awareness.setLocalStateField('user', { name: 'p' + i }))
    await sleep(JOIN_MS)
  }
  await sleep(4000)
  const rosters = providers.map(rosterOf)
  if (dynamic) {
    // What the dial rule built - `links/peer` above is from before the join.
    const built = adj.map((s) => s.size)
    row['links/peer'] = `${Math.min(...built)}-${Math.max(...built)} (mean ${(built.reduce((a, b) => a + b, 0) / n).toFixed(1)})`
    row['announces / links opened'] = `${net.announces} / ${net.linksOpened}`
  }
  row['join frames'] = net.tx
  row['join KB'] = Math.round(net.bytes / 1024)
  row['full rosters'] = `${rosters.filter((s) => s === n).length}/${n} (min ${Math.min(...rosters)})`
  if (wrapped) row['join: by type'] = net.typeCounts()
  if (rosters.some((s) => s !== n) && process.env.TRACE_FILE) {
    // The whole trace, with names instead of wrapper ids, to look at offline.
    const names = new Map(wrappers.map((w, i) => [w.id, 'p' + i]))
    const lines = net.trace.map((t) => `${t.at}\tp${t.from}\tp${t.to}\t${names.get(t.origin) ?? t.origin}\t${t.what.replace(/[0-9a-f]{12}/g, (id) => names.get(id) ?? id)}`)
    require('fs').writeFileSync(process.env.TRACE_FILE, lines.join('\n') + '\n')
  }
  if (rosters.some((s) => s !== n)) failures.push(`join: ${rosters.filter((s) => s !== n).length} rosters incomplete - ${holes(everybody)}`)

  if (process.env.PHASES === 'join') {
    for (const p of providers) p.destroy()
    return { row, framesPerKey: 0, failures }
  }

  // --- idle ---
  // IDLE_S (default 5): 60 s shows whether the core's idle backoff settles - in
  // real browsers a 100-peer conference room sent 1 kB/s per peer while idle.
  const idleS = Number(process.env.IDLE_S ?? 5)
  net.resetCounters()
  net.trace.length = 0
  coreSendsOfOthers(-1)
  const announcesBefore = net.announces
  const unroutableBefore = wrapped ? wrappers.reduce((sum, w) => sum + w.stats.unroutable, 0) : 0
  if (wrapped) row['join: unicasts through a tunnel'] = unroutableBefore
  // What the core sends per 10 s slice: does the idle backoff settle?
  const slices: string[] = []
  for (let t = 0; t < idleS; t += 10) {
    const before = net.tx
    const coreBefore = coreSends.broadcast.reduce((a, b) => a + (b ?? 0), 0) + coreSends.unicast.reduce((a, b) => a + (b ?? 0), 0)
    await sleep(Math.min(10, idleS - t) * 1000)
    const core = coreSends.broadcast.reduce((a, b) => a + (b ?? 0), 0) + coreSends.unicast.reduce((a, b) => a + (b ?? 0), 0) - coreBefore
    slices.push(`${net.tx - before}/${core}`)
  }
  if (idleS > 10) row['idle: frames/core sends per 10 s'] = slices.join(' ')
  if (wrapped && process.env.DIAG) {
    // Who still sends digests, and what is in them: the digest entries per (link, origin) over the idle phase.
    const per = new Map<string, number>()
    for (const t of net.trace) if (t.what.startsWith('DIGEST')) per.set(`p${t.from}->p${t.to}`, (per.get(`p${t.from}->p${t.to}`) ?? 0) + 1)
    const top = Array.from(per).sort((a, b) => b[1] - a[1]).slice(0, 6)
    row['idle: busiest digest links'] = top.map(([k, v]) => `${k}:${v}`).join(' ')
    const first = net.trace.find((t) => t.what.startsWith('DIGEST') && t.at > net.now() - 10000)
    if (first) row['idle: a late digest'] = `${first.at} ms p${first.from}->p${first.to} ${first.what}`
    // The story of one late digest: the origin it names, what the sender and the receiver had heard of it, when.
    if (first) {
      const originIdx = wrappers.findIndex((w) => w.id === first.origin)
      const story = net.trace.filter((t) => t.origin === first.origin && (t.from === first.from || t.to === first.from || t.to === first.to || t.from === first.to))
      row['idle: that digest, its origin'] = `p${originIdx}; frames of that origin at p${first.from} / p${first.to}: ` + story.map((t) => `${t.at}ms p${t.from}->p${t.to} ${t.what}`).join(' | ')
      const w = wrappers[first.from] as any
      const link = w._links.get('p' + first.to)
      row['idle: sender state'] = `announced ${w._announced.get(first.origin)} rounds ${w._announcedRounds.get(first.origin + ':' + (w._origins.get(first.origin)?.hw))} lazy links ${Array.from(w._links.values()).filter((l: any) => l.peer !== undefined).length}; link told ${link?.told.get(first.origin)} heard ${link?.heard.get(first.origin)}`
    }
  }
  row['idle frames/s'] = Math.round(net.tx / idleS)
  row['idle: core sends'] = coreSendsOfOthers(-1)
  if (dynamic) row['idle: announces'] = net.announces - announcesBefore
  if (wrapped) row['idle: unicasts through a tunnel'] = wrappers.reduce((sum, w) => sum + w.stats.unroutable, 0) - unroutableBefore
  if (wrapped) row['idle: by type'] = net.typeCounts()

  // --- typing: `who` types KEYS characters; every other living peer must have each within `limit` ms ---
  const type = async (who: number, keys: number, limit: number, alive: GenericProvider[]) => {
    const text = providers[who].doc.getText('t')
    const base = text.length
    const typedAt: number[] = []
    const delays: number[] = []
    const stop: Array<() => void> = []
    for (const p of alive) {
      if (p === providers[who]) continue
      const t = p.doc.getText('t')
      let had = t.length
      const observer = () => {
        const now = Date.now()
        for (; had < t.length; had++) if (had >= base && typedAt[had - base] !== undefined) delays.push(now - typedAt[had - base])
      }
      t.observe(observer)
      stop.push(() => t.unobserve(observer))
    }
    net.resetCounters()
    for (let k = 0; k < keys; k++) {
      typedAt.push(Date.now())
      text.insert(text.length, 'x')
      await sleep(100)
    }
    await sleep(limit)
    const frames = net.tx / keys
    const bytes = net.bytes / keys
    stop.forEach((off) => off())
    const inTime = delays.filter((d) => d <= limit).sort((a, b) => a - b)
    const expected = keys * (alive.length - 1)
    return { frames, bytes, share: inTime.length / expected, p50: percentile(inTime, 0.5), p95: percentile(inTime, 0.95), max: inTime[inTime.length - 1] ?? NaN }
  }

  coreSendsOfOthers(0)
  net.trace.length = 0
  if (wrapped && process.env.DIAG) {
    // Before typing: who has NO link that is eager-in for peer 0, and what do both ends of its links say?
    const o0 = wrappers[0].id
    const orphans: string[] = []
    for (let i = 1; i < n; i++) {
      const w = wrappers[i] as any
      const links = Array.from(adj[i])
      const feeds = links.filter((m) => w._eager(w._links.get('p' + m), o0, 'in'))
      const senders = links.filter((m) => (wrappers[m] as any)._eager((wrappers[m] as any)._links.get('p' + i), o0, 'out'))
      if (feeds.length === 0 || senders.length === 0)
        orphans.push(`p${i}: in ${feeds.map((m) => 'p' + m).join(',') || '-'} / out-at-them ${senders.map((m) => 'p' + m).join(',') || '-'}; origin ${JSON.stringify({ hw: w._origins.get(o0)?.hw, route: w._origins.get(o0)?.route })}`)
    }
    row["before typing: peers without a feed for peer 0"] = `${orphans.length}: ` + orphans.slice(0, 4).join(' | ')
    // ... and the mismatches: I think you send to me (in) but you do not (out)
    let mismatch = 0
    for (let i = 1; i < n; i++) for (const m of adj[i]) {
      const mine = (wrappers[i] as any)._eager((wrappers[i] as any)._links.get('p' + m), o0, 'in')
      const theirs = (wrappers[m] as any)._eager((wrappers[m] as any)._links.get('p' + i), o0, 'out')
      if (mine !== theirs) {
        mismatch++
        const a = (wrappers[i] as any)._links.get('p' + m)
        const b = (wrappers[m] as any)._links.get('p' + i)
        if (mismatch <= 4)
          row[`mismatch ${mismatch}`] = `p${i} thinks p${m} ${mine ? 'sends' : 'does not send'} (base ${a.lazy ? 'lazy' : 'eager'}, set ${a.eagerIn.get(o0)}); p${m} ${theirs ? 'sends' : 'does not'} (base ${b.lazy ? 'lazy' : 'eager'}, set ${b.eagerOut.get(o0)}); p${i} pruned p${m} for p0 at ${a.pruned.get(o0) ?? '-'}`
      }
    }
    row['before typing: in/out mismatches for peer 0'] = mismatch
  }
  if (process.env.PHASES === 'idle') {
    for (const p of providers) p.destroy()
    return { row, framesPerKey: 0, failures }
  }
  // KEY_LIMIT_MS: 1.5 s, not 1 s. Peer 0 is the oldest and has been silent
  // since the join burst; its tree covers the peers that were there then,
  // and everybody who joined since holds only its default feeds. Their first
  // keystroke comes the repair way - a DIGEST (500 ms tick) plus the GRAFT
  // delay (250 ms) plus a few hops: ~1 s, measured 0.9-1.0 s - and from
  // then on they are in the tree. A typist who has typed before is at p95
  // 60-90 ms.
  const first = await type(0, KEYS, KEY_LIMIT_MS, providers)
  if (wrapped && process.env.DIAG) {
    // Keystrokes that the tree did not deliver: who got a GRAFT reply of peer 0's frames, and what was that peer's tree for peer 0?
    const replies = net.trace.filter((t) => t.origin === wrappers[0].id && t.what.includes('REPLY'))
    const grafts = net.trace.filter((t) => t.origin === wrappers[0].id && t.what.startsWith('GRAFT'))
    const view = (i: number) =>
      Array.from(adj[i]).map((m) => {
        const w = wrappers[i] as any
        const l = w._links.get('p' + m)
        const theirs = (wrappers[m] as any)._links.get('p' + i)
        return `p${m}:${w._eager(l, wrappers[0].id, 'in') ? 'E' : 'l'}${(wrappers[m] as any)._eager(theirs, wrappers[0].id, 'out') ? 'E' : 'l'}`
      }).join(' ')
    row['typing: graft replies of peer 0 frames'] = `${replies.length} (${grafts.length} grafts): ` + replies.slice(0, 6).map((t) => `${t.at}ms p${t.from}->p${t.to} ${t.what} [p${t.to}: ${view(t.to)}]`).join(' | ')
  }
  // The relay's own efficiency: a core broadcast costs a full mesh N-1 frames, a perfect tree too.
  const coreBroadcasts = coreSends.broadcast.reduce((a, b) => a + (b ?? 0), 0)
  const relayRatio = wrapped ? (net.tx - (net.types[2] ?? 0)) / (coreBroadcasts * (n - 1)) : 1
  row['typing: core sends of the OTHER peers'] = coreSendsOfOthers(0)
  if (wrapped) row['frames per core broadcast / (N-1)'] = relayRatio.toFixed(2)
  if (wrapped && name !== 'flood' && relayRatio > RELAY_RATIO) failures.push(`the relay needs ${relayRatio.toFixed(2)} x (N-1) frames per broadcast, limit ${RELAY_RATIO}`)
  if (wrapped) row['typing: by type'] = net.typeCounts()
  row['frames/key'] = Math.round(first.frames)
  row['bytes/key'] = Math.round(first.bytes)
  row[`keys <=${KEY_LIMIT_MS}ms`] = `${(100 * first.share).toFixed(1)} %`
  row['p50/p95/max ms'] = `${first.p50}/${first.p95}/${first.max}`
  if (first.share < 1) failures.push(`typing (peer 0): ${(100 * first.share).toFixed(1)} % of the keystrokes within ${KEY_LIMIT_MS} ms`)

  const last = await type(n - 1, KEYS, KEY_LIMIT_MS, providers)
  row['last joiner: frames/key'] = Math.round(last.frames)
  row['last joiner: p95'] = last.p95
  if (last.share < 1) failures.push(`typing (last joiner): ${(100 * last.share).toFixed(1)} % of the keystrokes within ${KEY_LIMIT_MS} ms`)
  if (wrapped) {
    // Peer 0's tree, counted at both ends of every link: N-1 when it has settled.
    const tree = wrappers.reduce((sum, w) => sum + w.linkCount(wrappers[0].id).tree, 0) / 2
    row["peer 0's tree links"] = `${tree} (N-1 = ${n - 1})`
    const feeds = wrappers.map((w) => w.linkCount().feeds)
    row['feeds/peer'] = `${Math.min(...feeds)}-${Math.max(...feeds)}`
  }

  // --- cursor: peer 0, KEYS changes ---
  net.resetCounters()
  for (let k = 0; k < KEYS; k++) {
    providers[0].awareness.setLocalStateField('cursor', k)
    await sleep(100)
  }
  await sleep(1000)
  row['frames/cursor'] = Math.round(net.tx / KEYS)
  const id0 = providers[0].doc.clientID
  const sawCursor = providers.slice(1).filter((p) => (p.awareness.getStates().get(id0) as any)?.cursor === KEYS - 1).length
  row['see cursor'] = `${sawCursor}/${n - 1}`
  if (sawCursor !== n - 1) failures.push(`cursor: seen by ${sawCursor} of ${n - 1}`)

  // --- pub/sub: one message from peer 0 ---
  let heard = 0
  providers.slice(1).forEach((p) => p.pubsub.subscribe('gate', () => heard++))
  providers[0].pubsub.publish('gate', { hello: 1 })
  await sleep(1000)
  row['pubsub heard'] = `${heard}/${n - 1}`
  if (heard !== n - 1) failures.push(`pub/sub: heard by ${heard} of ${n - 1}`)

  // --- a link between two living peers closes: that is no departure ---
  if (wrapped) {
    const a = Math.floor(n / 3)
    const b = Array.from(adj[a])[0]
    net.resetCounters()
    net.trace.length = 0 // DIAG: from the cut on
    net.trace.push({ at: net.now(), from: a, to: b, what: 'CUT', origin: '*' })
    net.cut(a, b)
    await sleep(5000)
    const short = providers.map(rosterOf).filter((s) => s !== n).length
    row['link cut: frames'] = net.tx
    row['link cut: rosters short'] = short
    if (short > 0 && process.env.TRACE_FILE) {
      const names = new Map(wrappers.map((w, i) => [w.id, 'p' + i]))
      const lines = net.trace.map((t) => `${t.at}\tp${t.from}\tp${t.to}\t${names.get(t.origin) ?? t.origin}\t${t.what.replace(/[0-9a-f]{12}/g, (id) => names.get(id) ?? id)}`)
      require('fs').writeFileSync(process.env.TRACE_FILE, lines.join('\n') + '\n')
    }
    if (short > 0) failures.push(`link cut (p${a} - p${b}): ${short} rosters lost a living peer - ${holes(everybody)}`)
  }

  // --- a killed tab, the busiest tree node, while peer 0 types on ---
  let victim = Math.floor(n / 2)
  if (wrapped) {
    let most = -1
    wrappers.forEach((w, i) => {
      const tree = w.linkCount(wrappers[0].id).tree
      if (i !== 0 && tree > most) {
        most = tree
        victim = i
      }
    })
    row['victim tree links'] = most
  }
  const victimId = providers[victim].doc.clientID
  const survivors = providers.filter((_, i) => i !== victim)
  row['know victim addr'] = `${survivors.filter((p) => (p as any)._peerAddress.has(victimId)).length}/${n - 1}`
  const killedAt = Date.now()
  net.nodes[victim].disconnect()
  const repair = await type(0, 10, 3000, survivors)
  row['after kill: keys <=3s'] = `${(100 * repair.share).toFixed(1)} %`
  row['after kill: p95/max'] = `${repair.p95}/${repair.max}`
  if (repair.share < 1) failures.push(`after the kill: ${(100 * repair.share).toFixed(1)} % of the keystrokes within 3 s`)
  let stillIn = survivors.filter((p) => p.awareness.getStates().has(victimId)).length
  while (stillIn > 0 && Date.now() - killedAt < 12000) {
    await sleep(50)
    stillIn = survivors.filter((p) => p.awareness.getStates().has(victimId)).length
  }
  row['kill -> gone'] = stillIn === 0 ? `<= ${Date.now() - killedAt} ms` : `still in ${stillIn} rosters`
  if (stillIn > 0 && wrapped) {
    // Whose fault: the wrapper never said "gone", or the core could not tell whom that address was.
    const ghosts = providers.map((p, i) => ({ p, i })).filter(({ p, i }) => i !== victim && p.awareness.getStates().has(victimId))
    row['ghost at'] = ghosts
      .map(({ p, i }) => `p${i}: wrapper says ${(wrappers[i] as any)._origins.get(wrappers[victim].id)?.gone ? 'gone' : 'there'}, core ${(p as any)._peerAddress.has(victimId) ? 'has' : 'lacks'} the address`)
      .join('; ')
  }
  if (stillIn > 0) failures.push(`killed peer still in ${stillIn} rosters`)
  await sleep(2000)
  const short = survivors.map(rosterOf).filter((s) => s !== n - 1).length
  if (short > 0) failures.push(`after the kill: ${short} rosters are not ${n - 1} long - ${holes(everybody.filter((i) => i !== victim))}`)
  const want = providers[0].doc.getText('t').toString()
  const equal = survivors.filter((p) => p.doc.getText('t').toString() === want).length
  row['docs equal'] = `${equal}/${n - 1}`
  if (equal !== n - 1) failures.push(`documents: ${equal} of ${n - 1} equal`)
  if (wrapped) {
    const sum = (key: keyof ConferenceTransport['stats']) => wrappers.reduce((s, w) => s + w.stats[key], 0)
    row['dup/prune/graft/digest/suspect'] = `${sum('duplicates')}/${sum('prunes')}/${sum('grafts')}/${sum('digests')}/${sum('suspects')}`
  }

  for (const p of providers) p.destroy()
  return { row, framesPerKey: first.frames, failures }
}

async function main() {
  console.log(`partial mesh gate: N=${NS.join(',')}, ${DIAL} links per joiner, ${HOP_MS} ms per hop, ${KEYS} keystrokes, seed ${SEED}`)
  const rows: Record<string, string | number>[] = []
  const failed: string[] = []
  for (const n of NS) {
    let baseline: number | undefined
    for (const name of VARIANTS) {
      const result = await silenced(() => runVariant(name, n))
      rows.push(result.row)
      if (name === 'full') baseline = result.framesPerKey
      // Without the 'full' run: a full mesh sends N-1 frames per keystroke plus the acks the probe measured (1.4x).
      const limit = MAX_RATIO * (baseline ?? 1.4 * (n - 1))
      if (name !== 'full' && name !== 'flood') {
        if (result.framesPerKey > limit) result.failures.push(`${Math.round(result.framesPerKey)} frames per keystroke, limit ${Math.round(limit)}`)
        for (const f of result.failures) failed.push(`N=${n} ${name}: ${f}`)
      }
      console.log(`  N=${n} ${name} done${result.failures.length > 0 && name !== 'flood' ? ' - FAILED' : ''}`)
    }
  }
  // One column per variant reads better than console.table's 20 columns.
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))))
  console.table(Object.fromEntries(keys.map((k) => [k, Object.fromEntries(rows.map((r) => [`${r.variant} ${r.N}`, r[k] ?? '']))])))
  if (failed.length > 0) {
    console.log('FAIL')
    for (const f of failed) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('PASS')
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
