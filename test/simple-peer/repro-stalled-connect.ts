/**
 * Repro: a WebRTC connection that never opens and is never rebuilt in time.
 *
 * Reported from edrys-Lite (teacher + 2 students on one machine, ~1 run in 13):
 * one student gets no targeted messages for the whole session. Logs of the
 * failing runs showed the signaling completing (offer, answer, every
 * candidate; both sides `stable`), then ICE getting stuck one-sided: the
 * initiator (ICE-controlling) saw a successful check, nominated the pair,
 * reported `connected` and stopped checking, while the other side never got
 * an answer to its own checks and stayed `checking`. Neither side reaches
 * `failed`, so the data channel just never opens.
 *
 * Before the fix the stuck connection was dropped after a fixed 15s and only
 * rebuilt at the next re-announce (up to 5s later): a link outage of 15–20s
 * per stall, more if the rebuild stalled again.
 *
 * Here a fake simple-peer stalls chosen attempts in exactly that way, under
 * the real SimplePeerTransport and an in-memory signaling server (which, like
 * the real one, echoes publishes to every subscriber). Scenarios:
 *   1. the student → teacher link stalls once / twice in a row;
 *   2. the same with two signaling servers (every signal arrives twice);
 *   3. a candidate of the stalled attempt arrives after the retry started
 *      (with simple-peer, adding it fails and destroys the connection).
 * Each prints how long until every pair has an open channel, and checks a
 * targeted message gets through.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/simple-peer/repro-stalled-connect.js
 */

import { EventEmitter } from 'events'
import { SimplePeerTransport } from '../../src/providers/simple-peer/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SIGNAL_LATENCY = 5
const CONNECT_LATENCY = 30

// ---------------------------------------------------------------------------
// In-memory signaling server(s), installed as the global WebSocket.

class FakeSignalingServer {
  subscribers = new Map<string, Set<FakeWebSocket>>()
  log: any[] = []

  handle(ws: FakeWebSocket, msg: any) {
    if (msg.type === 'subscribe') {
      for (const t of msg.topics ?? []) {
        if (!this.subscribers.has(t)) this.subscribers.set(t, new Set())
        this.subscribers.get(t)!.add(ws)
      }
    } else if (msg.type === 'publish') {
      this.log.push(msg)
      for (const sub of this.subscribers.get(msg.topic) ?? []) sub.deliver(msg)
    } else if (msg.type === 'ping') {
      ws.deliver({ type: 'pong' })
    }
  }

  /** Deliver a message again, later (a signal delayed in flight). */
  replay(msg: any) {
    for (const sub of this.subscribers.get(msg.topic) ?? []) sub.deliver(msg)
  }
}

const servers = new Map<string, FakeSignalingServer>()

class FakeWebSocket {
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: any) => void) | null = null
  onclose: (() => void) | null = null
  private server: FakeSignalingServer

  constructor(url: string) {
    this.server = servers.get(url)!
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 1)
  }
  send(data: string) {
    const msg = JSON.parse(data)
    setTimeout(() => this.server.handle(this, msg), SIGNAL_LATENCY)
  }
  deliver(msg: any) {
    if (this.readyState !== 1) return
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), SIGNAL_LATENCY)
  }
  close() {
    this.readyState = 3
    for (const subs of this.server.subscribers.values()) subs.delete(this)
  }
}
;(globalThis as any).WebSocket = FakeWebSocket

// ---------------------------------------------------------------------------
// Fake simple-peer. A connection is identified by its two FakePeers; the
// offer/answer SDP and the candidates name the FakePeer that made them.

const fakePeers = new Map<string, FakePeer>()
let uidCounter = 0
/** Decides whether the attempt between two transports (by owner name) stalls. */
let stallPolicy: (initiatorOwner: string, otherOwner: string) => boolean = () => false
/** Owner name per transport peerId, filled in by the scenario. */
const ownerOf = new Map<string, string>()
let currentOwner = ''

class FakePeer extends EventEmitter {
  uid = `p${uidCounter++}`
  owner = currentOwner // transport that created it (set around createPeerConnection)
  initiator: boolean
  remote?: FakePeer
  connected = false
  destroyed = false
  stalled = false
  private pending: string[] = []

  constructor(opts: { initiator: boolean }) {
    super()
    this.initiator = opts.initiator
    fakePeers.set(this.uid, this)
    if (this.initiator) {
      setTimeout(() => {
        if (this.destroyed) return
        this.emit('signal', { type: 'offer', sdp: `o-${this.uid}` })
        this.emit('signal', { type: 'candidate', candidate: { candidate: `c-${this.uid}` } })
      }, 1)
    }
  }

  signal(data: any) {
    if (this.destroyed) throw new Error('cannot signal after peer is destroyed')
    if (data.candidate) {
      const from = data.candidate.candidate.slice(2)
      if (!this.remote) this.pending.push(from)
      else this.addCandidate(from)
      return
    }
    if (data.sdp) {
      if (this.remote) {
        // simple-peer: setRemoteDescription in the wrong state rejects → destroy
        this.fail('ERR_SET_REMOTE_DESCRIPTION')
        return
      }
      this.remote = fakePeers.get(data.sdp.slice(2))
      for (const c of this.pending) this.addCandidate(c)
      this.pending = []
      if (data.type === 'offer') {
        setTimeout(() => {
          if (this.destroyed) return
          this.emit('signal', { type: 'answer', sdp: `a-${this.uid}` })
          this.emit('signal', { type: 'candidate', candidate: { candidate: `c-${this.uid}` } })
        }, 1)
      } else {
        // initiator got the answer: ICE runs
        const other = this.remote!
        const stall = stallPolicy(this.owner, other.owner)
        this.stalled = other.stalled = stall
        if (!stall) {
          setTimeout(() => {
            if (this.destroyed || other.destroyed) return
            this.open()
            other.open()
          }, CONNECT_LATENCY)
        }
      }
    }
  }

  private addCandidate(from: string) {
    if (from !== this.remote?.uid) this.fail('ERR_ADD_ICE_CANDIDATE')
  }

  private open() {
    this.connected = true
    this.emit('connect')
  }

  private fail(code: string) {
    stats.errors.push(code)
    this.emit('error', new Error(code))
    this.destroy()
  }

  send(data: Uint8Array) {
    if (!this.connected || !this.remote || this.remote.destroyed) throw new Error('not open')
    const r = this.remote
    setTimeout(() => !r.destroyed && r.emit('data', data.slice().buffer), 1)
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    const wasConnected = this.connected
    setTimeout(() => this.emit('close'), 1)
    const r = this.remote
    if (wasConnected && r && !r.destroyed) setTimeout(() => r.destroy(), 1)
  }
}

const stats = { errors: [] as string[] }

// ---------------------------------------------------------------------------

interface Node {
  name: string
  t: SimplePeerTransport
  openAt: Map<string, number> // remote name → first time the channel opened
  received: string[]
}

async function scenario(
  title: string,
  opts: { signaling: number; stalls: number; staleCandidate?: boolean },
) {
  servers.clear()
  fakePeers.clear()
  ownerOf.clear()
  stats.errors = []
  const urls = Array.from({ length: opts.signaling }, (_, i) => `fake://sig${i}`)
  for (const u of urls) servers.set(u, new FakeSignalingServer())

  // The newest joiner initiates (higher peerId); stall its link to the teacher.
  let stallsLeft = opts.stalls
  stallPolicy = (a, b) => {
    const pair = [a, b].sort().join('-')
    if (pair === 'S2-T' && stallsLeft > 0) {
      stallsLeft--
      return true
    }
    return false
  }

  const start = Date.now()
  const nodes: Node[] = []
  for (const name of ['T', 'S1', 'S2']) {
    const t = new SimplePeerTransport({
      peer: FakePeer,
      signaling: urls,
      signalingTimeout: 0,
    })
    const node: Node = { name, t, openAt: new Map(), received: [] }
    const peerId = (t as any).peerId as string
    ownerOf.set(peerId, name)
    // FakePeer learns its owner from the transport creating it.
    const create = (t as any).createPeerConnection.bind(t)
    ;(t as any).createPeerConnection = (id: string, init: boolean) => {
      currentOwner = name
      create(id, init)
    }
    t.onPeerConnect((id) => {
      const other = ownerOf.get(id)!
      if (!node.openAt.has(other)) node.openAt.set(other, Date.now() - start)
    })
    t.onMessage((d) => node.received.push(new TextDecoder().decode(d)))
    nodes.push(node)
    await t.connect({ room: 'room' })
    await sleep(1100) // students join a second apart, as in the e2e test
  }

  if (opts.staleCandidate) {
    // Once S2 has offered again, deliver a candidate of its stalled attempt.
    const s2 = nodes[2].t as any
    const tId = (nodes[0].t as any).peerId
    const server = servers.get(urls[0])!
    const firstAttempt = server.log.find(
      (m) => m.from === s2.peerId && m.to === tId && m.signal?.type === 'offer',
    )?.attempt
    const waitRetry = async () => {
      for (;;) {
        const offers = server.log.filter(
          (m) => m.from === s2.peerId && m.to === tId && m.signal?.type === 'offer',
        )
        if (offers.length > 1) return
        await sleep(20)
      }
    }
    waitRetry().then(() => {
      const old = server.log.find(
        (m) => m.from === s2.peerId && m.to === tId && m.signal?.candidate && m.attempt === firstAttempt,
      )
      setTimeout(() => server.replay(old), 2)
    })
  }

  // Wait until all six channel ends are open (or give up).
  const deadline = Date.now() + 70000
  while (Date.now() < deadline && nodes.some((n) => n.openAt.size < 2)) await sleep(50)
  await sleep(200)

  // A targeted message from the teacher to S2.
  const s2Id = (nodes[2].t as any).peerId
  nodes[0].t.sendTo(s2Id, new TextEncoder().encode('ping'))
  await sleep(100)

  const tToS2 = nodes[0].openAt.get('S2')
  const s2ToT = nodes[2].openAt.get('T')
  const s2Join = 2 * 1100
  const fmt = (v?: number) => (v === undefined ? 'never' : `${((v - s2Join) / 1000).toFixed(1)}s`)
  const errorCounts = new Map<string, number>()
  for (const e of stats.errors) errorCounts.set(e, (errorCounts.get(e) ?? 0) + 1)
  const errors = [...errorCounts].map(([e, n]) => `${e}×${n}`).join(', ')
  console.log(
    `${title.padEnd(48)} T↔S2 open after ${fmt(tToS2)} / ${fmt(s2ToT)} (from S2 joining);`,
    `ping ${nodes[2].received.includes('ping') ? 'arrived' : 'LOST'};`,
    `S1 links ${nodes[1].openAt.size === 2 ? 'ok' : 'MISSING'};`,
    `errors: ${errors || 'none'}`,
  )
  for (const n of nodes) n.t.disconnect()
  await sleep(50)
  return tToS2 !== undefined && s2ToT !== undefined && nodes[2].received.includes('ping')
}

async function main() {
  const results = [
    await scenario('no stall', { signaling: 1, stalls: 0 }),
    await scenario('T↔S2 stalls once', { signaling: 1, stalls: 1 }),
    await scenario('T↔S2 stalls twice', { signaling: 1, stalls: 2 }),
    await scenario('stalls once, 2 signaling servers', { signaling: 2, stalls: 1 }),
    await scenario('stalls once, stale candidate after retry', { signaling: 1, stalls: 1, staleCandidate: true }),
  ]
  const ok = results.every(Boolean)
  console.log(ok ? 'OK' : 'FAILED')
  process.exit(ok ? 0 : 1)
}

main()
