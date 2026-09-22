/**
 * Repro / gate (round 11): the REAL SimplePeerTransport and the real
 * simple-peer library building a PARTIAL mesh with the dial rule
 * (src/providers/dial.ts, option `dial`) - what ConferenceTransport needs
 * from the transport below it.
 *
 * A loopback `wrtc`: two FakePCs find each other through the id in their
 * SDP, their data channels are wired to each other. A fake global WebSocket
 * that is y-webrtc's signaling server: subscribe, publish to everybody else
 * on the topic. Nothing here knows about the dial rule.
 *
 *  Part 1 - N peers, `dial: 4`, joining JOIN_MS apart. Is the room ONE graph,
 *           does every peer hold at least `dial` links, how many does the
 *           busiest hold, how many RTCPeerConnections did a peer create
 *           (Chrome allows a renderer 500, closed ones included) - and does
 *           the announcing stop? Without the rule every peer announces every
 *           5 s to every peer: N^2 / 5 signaling messages a second.
 *  Part 2 - a room that starts: 12 peers at the same moment. Every pair that
 *           finds each other does so from both ends at once (glare). Is
 *           anybody left with a half-open entry?
 *  Part 3 - leaves (`passive: true`, a phone): do they dial nobody, and
 *           never each other?
 *  Part 4 - a peer loses all its links (its neighbours are killed). Does it
 *           announce again and get new ones?
 *  Part 5 - control: without `dial` the same room is the full mesh it always was.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-simple-peer-sparse.js
 *      N=40 JOIN_MS=50 override.
 */

import { SimplePeerTransport } from '../../src/providers/simple-peer'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Peer = require('simple-peer')

const N = Number(process.env.N ?? 40)
const JOIN_MS = Number(process.env.JOIN_MS ?? 50)
const ROOM = 'sparse-room'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class LoopChannel {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onbufferedamountlow: (() => void) | null = null
  other?: LoopChannel
  constructor(public label: string) {}
  send(data: unknown): void {
    const other = this.other
    if (this.readyState !== 'open' || !other) throw new Error('channel not open')
    setTimeout(() => other.readyState === 'open' && other.onmessage?.({ data }), 1)
  }
  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }
  open(): void {
    this.readyState = 'open'
    this.onopen?.()
  }
}

/** An RTCPeerConnection that finds its counterpart through the id in the SDP. */
class LoopPC {
  static all = new Map<string, LoopPC>()
  static created = 0
  readonly id = 'pc' + ++LoopPC.created
  iceConnectionState = 'new'
  iceGatheringState = 'new'
  connectionState = 'new'
  signalingState = 'stable'
  localDescription: unknown = null
  remoteDescription: unknown = null
  oniceconnectionstatechange: (() => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  onsignalingstatechange: (() => void) | null = null
  onicecandidate: ((e: unknown) => void) | null = null
  ondatachannel: ((e: unknown) => void) | null = null
  channel?: LoopChannel
  remote?: LoopPC
  closed = false
  constructor(_config: unknown) {
    LoopPC.all.set(this.id, this)
  }
  createDataChannel(label: string): LoopChannel {
    this.channel = new LoopChannel(label)
    return this.channel
  }
  private _sdp(): string {
    return `v=0\r\no=${this.id}\r\n`
  }
  createOffer(): Promise<unknown> {
    return Promise.resolve({ type: 'offer', sdp: this._sdp() })
  }
  createAnswer(): Promise<unknown> {
    return Promise.resolve({ type: 'answer', sdp: this._sdp() })
  }
  setLocalDescription(d: unknown): Promise<void> {
    this.localDescription = d
    return Promise.resolve()
  }
  setRemoteDescription(d: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = d
    const remote = LoopPC.all.get(/o=(pc\d+)/.exec(d.sdp)?.[1] ?? '')
    if (!remote) return Promise.reject(new Error('no such peer connection'))
    this.remote = remote
    // The initiator has the answer now: both ends know each other.
    if (d.type === 'answer') setTimeout(() => this._connect(remote), 5)
    return Promise.resolve()
  }
  private _connect(answerer: LoopPC): void {
    if (this.closed || answerer.closed || answerer.remote !== this) return
    const theirs = new LoopChannel(this.channel!.label)
    theirs.other = this.channel
    this.channel!.other = theirs
    answerer.channel = theirs
    for (const pc of [this, answerer] as LoopPC[]) {
      pc.iceGatheringState = 'complete'
      pc.onicegatheringstatechange?.()
      pc.iceConnectionState = 'connected'
      pc.oniceconnectionstatechange?.()
      pc.connectionState = 'connected'
      pc.onconnectionstatechange?.()
    }
    answerer.ondatachannel?.({ channel: theirs })
    this.channel!.open()
    theirs.open()
  }
  addIceCandidate(): Promise<void> {
    return Promise.resolve()
  }
  getStats(): Promise<unknown[]> {
    return Promise.resolve([{ type: 'candidate-pair', id: 'p', selected: true }])
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.iceConnectionState = 'closed'
    this.connectionState = 'closed'
    this.channel?.close()
    // The other end notices: its channel closes, its ICE fails.
    const remote = this.remote
    if (remote && !remote.closed && remote.remote === this) {
      setTimeout(() => {
        if (remote.closed) return
        remote.channel?.close()
        remote.iceConnectionState = 'failed'
        remote.oniceconnectionstatechange?.()
        remote.connectionState = 'failed'
        remote.onconnectionstatechange?.()
      }, 5)
    }
  }
}

const wrtc = {
  RTCPeerConnection: LoopPC,
  RTCSessionDescription: class {
    constructor(d: object) {
      Object.assign(this, d)
    }
  },
  RTCIceCandidate: class {
    constructor(d: object) {
      Object.assign(this, d)
    }
  },
}

/** y-webrtc's signaling server: what is published to a topic goes to every OTHER socket subscribed to it. */
class HubWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static sockets = new Set<HubWebSocket>()
  static announces = 0
  static delivered = 0
  readyState = 0
  topics = new Set<string>()
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    setTimeout(() => {
      this.readyState = HubWebSocket.OPEN
      HubWebSocket.sockets.add(this)
      this.onopen?.()
    }, 1)
  }
  send(data: string): void {
    const msg = JSON.parse(data)
    if (msg.type === 'subscribe') for (const t of msg.topics ?? []) this.topics.add(t)
    if (msg.type !== 'publish') return
    if (!msg.signal) HubWebSocket.announces++
    for (const other of HubWebSocket.sockets) {
      if (other === this || !other.topics.has(msg.topic)) continue
      HubWebSocket.delivered++
      setTimeout(() => other.readyState === HubWebSocket.OPEN && other.onmessage?.({ data }), 2)
    }
  }
  close(): void {
    if (this.readyState === HubWebSocket.CLOSED) return
    this.readyState = HubWebSocket.CLOSED
    HubWebSocket.sockets.delete(this)
    this.onclose?.()
  }
}
;(globalThis as { WebSocket: unknown }).WebSocket = HubWebSocket

interface Node {
  transport: SimplePeerTransport
  links: Set<string>
  id: string
}

async function join(extra: object): Promise<Node> {
  const options: any = { peer: Peer, signaling: ['wss://hub'], peerOpts: { wrtc }, ...extra }
  const transport = new SimplePeerTransport(options)
  const links = new Set<string>()
  transport.onPeerConnect((id) => links.add(id))
  transport.onPeerDisconnect((id) => links.delete(id))
  await transport.connect({ room: ROOM })
  return { transport, links, id: (transport as any).peerId }
}

/** Is the room one graph? Links as the transports report them. */
function components(nodes: Node[]): number {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  let count = 0
  for (const start of nodes) {
    if (seen.has(start.id)) continue
    count++
    const queue = [start]
    seen.add(start.id)
    while (queue.length > 0) {
      for (const id of queue.pop()!.links) {
        const next = byId.get(id)
        if (next && !seen.has(id)) {
          seen.add(id)
          queue.push(next)
        }
      }
    }
  }
  return count
}

const halfOpen = (nodes: Node[]) =>
  nodes.reduce((sum, n) => sum + Array.from((n.transport as any).peers.values()).filter((p: any) => !p.connected).length, 0)

/**
 * An announce is answered by chance, so a peer may need a second one (1.5 s
 * later) or the 5 s tick: wait until every peer has `want` links, 12 s at most.
 */
async function settled(nodes: Node[], want: number): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < 12000 && nodes.some((n) => n.links.size < want)) await sleep(100)
  await sleep(300)
  return Date.now() - start
}

async function leave(nodes: Node[]): Promise<void> {
  for (const n of nodes) n.transport.disconnect()
  await sleep(100)
  LoopPC.all.clear()
}

async function main() {
  const failures: string[] = []
  const check = (ok: boolean, what: string) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`)
    if (!ok) failures.push(what)
  }
  const degrees = (nodes: Node[]) => nodes.map((n) => n.links.size)

  console.log(`Part 1 - ${N} peers, dial: 4, joining ${JOIN_MS} ms apart`)
  let nodes: Node[] = []
  for (let i = 0; i < N; i++) {
    nodes.push(await join({ dial: 4 }))
    await sleep(JOIN_MS)
  }
  console.log(`         everybody has its links ${await settled(nodes, 4)} ms after the last join`)
  let deg = degrees(nodes)
  const created = nodes.map((n) => n.transport.peerConnectionsCreated)
  check(components(nodes) === 1, `the room is one graph (${components(nodes)} component(s))`)
  check(Math.min(...deg) >= 4, `every peer holds at least 4 links (min ${Math.min(...deg)}, max ${Math.max(...deg)}, mean ${(deg.reduce((a, b) => a + b, 0) / N).toFixed(1)} - a full mesh: ${N - 1})`)
  check(Math.max(...deg) < N - 1, `nobody holds a link to everybody (max ${Math.max(...deg)})`)
  check(Math.max(...created) <= 2 * Math.max(...deg), `RTCPeerConnections created per peer: max ${Math.max(...created)}`)
  check(halfOpen(nodes) === 0, `no half-open entries (${halfOpen(nodes)})`)
  const before = HubWebSocket.announces
  await sleep(5500) // one announce tick
  check(HubWebSocket.announces === before, `a settled room is silent on the signaling channel: ${HubWebSocket.announces - before} announces in 5.5 s (a full mesh of ${N}: ${N})`)
  console.log(`         announces so far: ${before} for ${N} joins`)

  console.log('Part 4 - the neighbours of one peer are killed')
  const victim = nodes[N - 1]
  const neighbours = nodes.filter((n) => victim.links.has(n.id))
  for (const n of neighbours) n.transport.disconnect()
  nodes = nodes.filter((n) => !neighbours.includes(n))
  await sleep(200)
  await settled(nodes, 4)
  check(victim.links.size >= 4, `it has links again: ${victim.links.size} (lost ${neighbours.length})`)
  check(components(nodes) === 1, `the room is one graph (${components(nodes)} component(s))`)
  await leave(nodes)

  console.log('Part 2 - 12 peers at the same moment (glare)')
  nodes = await Promise.all(Array.from({ length: 12 }, () => join({ dial: 4 })))
  await settled(nodes, 4)
  deg = degrees(nodes)
  check(components(nodes) === 1, `the room is one graph (${components(nodes)} component(s))`)
  check(Math.min(...deg) >= 4, `every peer holds at least 4 links (min ${Math.min(...deg)}, max ${Math.max(...deg)})`)
  check(halfOpen(nodes) === 0, `no half-open entries (${halfOpen(nodes)})`)
  // Both ends count the link, and their ids agree.
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const oneSided = nodes.reduce((sum, n) => sum + Array.from(n.links).filter((id) => !byId.get(id)?.links.has(n.id)).length, 0)
  check(oneSided === 0, `every link is known at both ends (${oneSided} one-sided)`)
  await leave(nodes)

  console.log('Part 3 - 8 relays, then 8 leaves (passive: true)')
  nodes = []
  for (let i = 0; i < 16; i++) {
    nodes.push(await join({ dial: 4, passive: i >= 8 }))
    await sleep(JOIN_MS)
  }
  await settled(nodes, 4)
  const leaves = nodes.slice(8)
  const leafIds = new Set(leaves.map((n) => n.id))
  const leafToLeaf = leaves.reduce((sum, n) => sum + Array.from(n.links).filter((id) => leafIds.has(id)).length, 0)
  check(leafToLeaf === 0, `no link between two leaves (${leafToLeaf})`)
  check(Math.min(...degrees(leaves)) >= 4, `every leaf holds at least 4 links (min ${Math.min(...degrees(leaves))}, max ${Math.max(...degrees(leaves))})`)
  check(Math.max(...degrees(leaves)) <= 8, `a leaf holds what it asked for, not what others ask of it (max ${Math.max(...degrees(leaves))})`)
  await leave(nodes)

  console.log(`Part 5 - control: ${Math.min(N, 20)} peers without \`dial\``)
  nodes = []
  for (let i = 0; i < Math.min(N, 20); i++) {
    nodes.push(await join({}))
    await sleep(JOIN_MS)
  }
  await sleep(1500)
  deg = degrees(nodes)
  check(Math.min(...deg) === nodes.length - 1, `a full mesh: every peer holds ${nodes.length - 1} links (min ${Math.min(...deg)})`)
  await leave(nodes)

  console.log(failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
