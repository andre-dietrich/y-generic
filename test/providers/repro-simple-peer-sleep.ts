/**
 * Repro: what does SimplePeerTransport do when a phone's browser suspends
 * the page (another app in front, display off) and the phone comes back?
 *
 * The real simple-peer library runs against a fake `wrtc` (a scripted
 * RTCPeerConnection whose ICE / gathering / connection states the test
 * drives by hand) and a fake global WebSocket (the signaling server). Each
 * part runs the same event sequence twice: on a bare simple-peer instance
 * (control - what the library does on its own, and what y-webrtc gets) and
 * on a peer created by SimplePeerTransport.
 *
 *  Part 1 - does 'connect' fire? Two orders of the same events: ICE
 *           connects before / after candidate gathering completes.
 *  Part 2 - the remote side goes silent (phone asleep): ICE 'failed' +
 *           connectionState 'failed'. Is the peer removed, is
 *           onPeerDisconnect fired? Then the phone re-announces under its
 *           peer id: is a new connection created?
 *  Part 3 - the OS kills the signaling WebSocket. Reconnect attempts and
 *           announces in the following WAIT_MS.
 *  Part 4 - a peer we hold a connected entry for sends a fresh offer (it
 *           restarted its side of the link). Is the offer answered by a new
 *           peer connection, or fed to the old one?
 *  Part 5 - a half-open entry: we initiate, nobody ever answers
 *           (connectTimeout: 1000). Does the entry expire, and is the
 *           peer's next announce accepted?
 *  Part 6 - the page was suspended: Date.now() jumps by 60 s
 *           (resumeAfterMs: 15000). Does the transport drop its links and
 *           re-announce under a new peer id?
 *  Part 8 - a background tab, not a sleeping page: the timers come 17 s late
 *           (default options). Firefox delays the timers of a HIDDEN tab in a
 *           busy room by up to ~15 s, measured with 3 Firefox peers among 25:
 *           ticks 5.6, 9.0, 15.3, 17.6 s late (monotonic clock the same), the
 *           visible Firefox tab none - and with the old default of 15 s every
 *           such tick was taken for a sleep: all links dropped, the room joined
 *           again under a new id, once a minute, for every Firefox user with
 *           the tab in the background. A link survives 30 s of silence, so
 *           nothing shorter needs repairing. Are the links left alone?
 *  Part 9 - the same, beyond any threshold: no tick for 40 s while the link
 *           delivers a message every second (24 s late was measured on a busy
 *           test machine - a margin is not a design). A page that handles what
 *           its links deliver has not slept. Are the links left alone?
 *  Part 10 - and the trap in that: a page that DID sleep 40 s handles, as the
 *           first thing when it wakes, a message that queued before it fell
 *           asleep (seen with pages frozen through the DevTools protocol). Its
 *           links are dead by then. Is that still a sleep?
 *  Part 7 - a link that cannot send: simple-peer has fired 'connect', and the
 *           channel's send() throws "readyState is not 'open'". Seen with 50
 *           real browsers on the answering side of a link (Chrome 151, a busy
 *           machine, about one join in six): the RTCDataChannel object said
 *           'connecting' ten seconds after its own 'open' event, getStats()
 *           said open, messages arrived - and every send threw. The transport
 *           logged it and kept the entry: the peer's first frame (its presence)
 *           and everything after it never reached the other side, which kept
 *           a peer in its roster's blind spot for good. Is the link reported
 *           gone and re-announced, so that the pair dials again?
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-simple-peer-sleep.js
 *      WAIT_MS=11000 overrides part 3's observation window.
 */

import { SimplePeerTransport } from '../../src/providers/simple-peer/index'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Peer = require('simple-peer')

const WAIT_MS = Number(process.env.WAIT_MS ?? 11000)
const ROOM = 'repro-room'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeChannel {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onbufferedamountlow: (() => void) | null = null
  constructor(public label: string) {}
  send(_d: unknown): void {}
  close(): void {
    this.readyState = 'closed'
  }
  open(): void {
    this.readyState = 'open'
    this.onopen?.()
  }
}

class FakePC {
  static all: FakePC[] = []
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
  channel?: FakeChannel
  constructor(_config: unknown) {
    FakePC.all.push(this)
  }
  createDataChannel(label: string): FakeChannel {
    this.channel = new FakeChannel(label)
    return this.channel
  }
  createOffer(): Promise<unknown> {
    return Promise.resolve({ type: 'offer', sdp: 'v=0\r\n' })
  }
  createAnswer(): Promise<unknown> {
    return Promise.resolve({ type: 'answer', sdp: 'v=0\r\n' })
  }
  setLocalDescription(d: unknown): Promise<void> {
    this.localDescription = d
    return Promise.resolve()
  }
  setRemoteDescription(d: unknown): Promise<void> {
    this.remoteDescription = d
    return Promise.resolve()
  }
  addIceCandidate(): Promise<void> {
    return Promise.resolve()
  }
  getStats(): Promise<unknown[]> {
    return Promise.resolve([{ type: 'candidate-pair', id: 'p', selected: true }])
  }
  close(): void {
    this.iceConnectionState = 'closed'
    this.connectionState = 'closed'
  }
  // what the browser does: set the state, fire the handler
  ice(state: string): void {
    this.iceConnectionState = state
    this.oniceconnectionstatechange?.()
  }
  gathering(state: string): void {
    this.iceGatheringState = state
    this.onicegatheringstatechange?.()
  }
  conn(state: string): void {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }
}

const wrtc = {
  RTCPeerConnection: FakePC,
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

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static all: FakeWebSocket[] = []
  readyState = 0
  sent: { at: number; msg: { type: string } }[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    FakeWebSocket.all.push(this)
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    }, 1)
  }
  send(data: string): void {
    this.sent.push({ at: Date.now(), msg: JSON.parse(data) })
  }
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
  deliver(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

type Order = 'ice-first' | 'gathering-first'

/** The events of one successful connection, in the given order. */
function driveConnect(pc: FakePC, order: Order): void {
  pc.gathering('gathering')
  pc.ice('checking')
  pc.conn('connecting')
  if (order === 'ice-first') {
    pc.ice('connected')
    pc.conn('connected')
    pc.gathering('complete')
  } else {
    pc.gathering('complete')
    pc.ice('connected')
    pc.conn('connected')
  }
  pc.channel!.open()
}

async function barePeer(order: Order) {
  const peer = new Peer({ initiator: true, wrtc })
  const pc = FakePC.all[FakePC.all.length - 1]
  const seen = { connect: false, close: false, error: '' }
  peer.on('signal', () => {})
  peer.on('connect', () => (seen.connect = true))
  peer.on('close', () => (seen.close = true))
  peer.on('error', (e: { code: string }) => (seen.error = e.code))
  await sleep(20)
  driveConnect(pc, order)
  await sleep(300)
  return { peer, pc, seen }
}

async function makeTransport(extra: object = {}) {
  // options of later items are not in the type on older builds
  const options: any = { peer: Peer, signaling: ['wss://fake'], peerOpts: { wrtc }, ...extra }
  const transport = new SimplePeerTransport(options)
  const seen = { connect: 0, disconnect: 0 }
  transport.onPeerConnect(() => seen.connect++)
  transport.onPeerDisconnect(() => seen.disconnect++)
  await transport.connect({ room: ROOM })
  const ws = FakeWebSocket.all[FakeWebSocket.all.length - 1]
  await sleep(5)
  const ownId = (ws.sent.find((m) => (m.msg as any).from)!.msg as any).from as string
  return { transport, ws, seen, ownId }
}

/** A transport with one remote peer ('0-phone' sorts below any generated id: we initiate). */
async function transportPeer(order: Order, extra: object = {}) {
  const t = await makeTransport(extra)
  const before = FakePC.all.length
  t.ws.deliver({ type: 'publish', topic: ROOM, from: '0-phone' })
  if (FakePC.all.length !== before + 1) throw new Error('transport created no peer connection')
  const pc = FakePC.all[FakePC.all.length - 1]
  await sleep(20)
  driveConnect(pc, order)
  await sleep(300)
  return { ...t, pc }
}

/** A transport with one remote peer that initiates ('zzzz-desk' sorts above any generated id). */
async function transportAnsweringPeer() {
  const t = await makeTransport()
  t.ws.deliver({ type: 'publish', topic: ROOM, from: 'zzzz-desk' })
  t.ws.deliver({ type: 'publish', topic: ROOM, from: 'zzzz-desk', to: t.ownId, signal: { type: 'offer', sdp: 'v=0\r\n' } })
  const pc = FakePC.all[FakePC.all.length - 1]
  await sleep(20)
  pc.channel = new FakeChannel('from-remote')
  pc.ondatachannel?.({ channel: pc.channel })
  driveConnect(pc, 'ice-first')
  await sleep(300)
  return { ...t, pc }
}

async function main() {
  console.log("Part 1 - does 'connect' fire?")
  for (const order of ['ice-first', 'gathering-first'] as Order[]) {
    const bare = await barePeer(order)
    const viaTransport = await transportPeer(order)
    console.log(
      `  ${order.padEnd(16)} bare simple-peer: connect=${bare.seen.connect}   ` +
        `transport: onPeerConnect=${viaTransport.seen.connect > 0} connectedPeers=${viaTransport.transport.connectedPeers}`,
    )
    bare.peer.destroy()
    viaTransport.transport.disconnect()
  }

  console.log('\nPart 2 - the remote side goes silent: ICE failed, connection failed')
  const bare = await barePeer('ice-first')
  bare.pc.ice('disconnected')
  bare.pc.ice('failed')
  bare.pc.conn('failed')
  await sleep(50)
  console.log(`  bare simple-peer: close=${bare.seen.close} error=${bare.seen.error || '-'}`)

  const t = await transportPeer('ice-first')
  t.pc.ice('disconnected')
  t.pc.ice('failed')
  t.pc.conn('failed')
  await sleep(50)
  console.log(
    `  transport:        onPeerDisconnect=${t.seen.disconnect > 0} connectedPeers=${t.transport.connectedPeers}`,
  )
  const pcsBefore = FakePC.all.length
  t.ws.deliver({ type: 'publish', topic: ROOM, from: '0-phone' })
  console.log(
    `  the phone re-announces under its id: new peer connections created = ${FakePC.all.length - pcsBefore}`,
  )

  console.log(`\nPart 3 - the OS kills the signaling WebSocket; observing ${WAIT_MS} ms`)
  const socketsBefore = FakeWebSocket.all.length
  const killedAt = Date.now()
  t.ws.close()
  await sleep(WAIT_MS)
  const announces = FakeWebSocket.all
    .flatMap((w) => w.sent)
    .filter((s) => s.at >= killedAt && s.msg.type === 'publish').length
  console.log(
    `  reconnect attempts = ${FakeWebSocket.all.length - socketsBefore}, announces sent = ${announces}, transport.isConnected = ${t.transport.isConnected}`,
  )
  t.transport.disconnect()

  console.log('\nPart 4 - a fresh offer from a peer we hold a connected entry for')
  {
    const a = await transportAnsweringPeer()
    if (a.transport.connectedPeers !== 1) throw new Error('setup: answering peer not connected')
    const pcs = FakePC.all.length
    const answers = () => a.ws.sent.filter((m) => (m.msg as any).signal?.type === 'answer').length
    const answersBefore = answers()
    a.ws.deliver({ type: 'publish', topic: ROOM, from: 'zzzz-desk', to: a.ownId, signal: { type: 'offer', sdp: 'v=0\r\n' } })
    await sleep(100)
    console.log(
      `  new peer connections = ${FakePC.all.length - pcs}, old entry reported gone = ${a.seen.disconnect > 0}, answers sent = ${answers() - answersBefore}`,
    )
    a.transport.disconnect()
  }

  console.log('\nPart 5 - a half-open entry (we initiate, nobody answers), connectTimeout 1000 ms')
  {
    const h = await makeTransport({ connectTimeout: 1000 })
    h.ws.deliver({ type: 'publish', topic: ROOM, from: '0-phone' })
    await sleep(1500)
    const pcs = FakePC.all.length
    h.ws.deliver({ type: 'publish', topic: ROOM, from: '0-phone' })
    console.log(
      `  after 1500 ms: entry expired = ${h.seen.disconnect > 0}, the peer's next announce creates ${FakePC.all.length - pcs} new connection(s)`,
    )
    h.transport.disconnect()
  }

  console.log('\nPart 6 - the page slept: Date.now() jumps by 60 s, resumeAfterMs 15000')
  {
    const r = await transportPeer('ice-first', { resumeAfterMs: 15000 })
    const realNow = Date.now
    const jumpedAt = realNow()
    Date.now = () => realNow() + 60000
    await sleep(4000)
    Date.now = realNow
    const ids = new Set(
      FakeWebSocket.all
        .flatMap((w) => w.sent)
        .filter((m) => m.at >= jumpedAt && m.msg.type === 'publish' && !(m.msg as any).signal)
        .map((m) => (m.msg as any).from as string),
    )
    ids.delete(r.ownId)
    console.log(
      `  4 s after the jump: links dropped = ${r.seen.disconnect > 0}, connectedPeers = ${r.transport.connectedPeers}, announces under a new peer id = ${ids.size > 0}`,
    )
    r.transport.disconnect()
  }
  console.log("\nPart 8 - a hidden tab's timers come 17 s late (default options)")
  {
    const firstSocket = FakeWebSocket.all.length - 1 // this transport's socket, and any it opens from here on
    const r = await transportPeer('ice-first')
    const realNow = Date.now
    Date.now = () => realNow() + 17000
    await sleep(3000)
    Date.now = realNow
    const ids = new Set(
      FakeWebSocket.all
        .slice(firstSocket + 1)
        .flatMap((w) => w.sent)
        .filter((m) => m.msg.type === 'publish' && !(m.msg as any).signal)
        .map((m) => (m.msg as any).from as string),
    )
    ids.delete(r.ownId)
    console.log(`  3 s after the late tick: links dropped = ${r.seen.disconnect > 0}, connectedPeers = ${r.transport.connectedPeers}, announces under a new peer id = ${ids.size > 0}`)
    r.transport.disconnect()
  }

  const frame = () => ({ data: new Uint8Array([0, 1, 2, 3]).buffer }) // [MSG_TYPE_COMPLETE, payload]
  console.log('\nPart 9 - no tick for 40 s while the link delivers a message every second (default options)')
  {
    const r = await transportPeer('ice-first')
    const realNow = Date.now
    let ahead = 0
    Date.now = () => realNow() + ahead
    for (let second = 0; second < 40; second++) {
      ahead += 1000 // the clock moves on, the (real) 1 s ticks in between see only the last message's time
      r.pc.channel!.onmessage?.(frame())
      await sleep(5)
    }
    await sleep(1500)
    Date.now = realNow
    console.log(`  afterwards: links dropped = ${r.seen.disconnect > 0}, connectedPeers = ${r.transport.connectedPeers}`)
    r.transport.disconnect()
  }

  console.log('\nPart 10 - the page slept 40 s, and the first thing it handles is a message that queued before (default options)')
  {
    const r = await transportPeer('ice-first')
    const realNow = Date.now
    Date.now = () => realNow() + 40000
    r.pc.channel!.onmessage?.(frame())
    await sleep(200)
    Date.now = realNow
    console.log(`  afterwards: links dropped = ${r.seen.disconnect > 0}, connectedPeers = ${r.transport.connectedPeers}`)
    r.transport.disconnect()
  }

  console.log("\nPart 7 - 'connect' has fired, and the channel's send() throws: readyState is not 'open'")
  for (const how of ['sendTo', 'send'] as const) {
    const s = await transportAnsweringPeer()
    if (s.transport.connectedPeers !== 1) throw new Error('setup: answering peer not connected')
    s.pc.channel!.readyState = 'connecting'
    s.pc.channel!.send = () => {
      throw new Error("Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'")
    }
    const announces = () => s.ws.sent.filter((m) => m.msg.type === 'publish' && !(m.msg as any).signal).length
    const announcesBefore = announces()
    if (how === 'sendTo') s.transport.sendTo('zzzz-desk', new Uint8Array([1, 2, 3]))
    else s.transport.send(new Uint8Array([1, 2, 3]))
    await sleep(50)
    console.log(
      `  ${how.padEnd(7)} link reported gone = ${s.seen.disconnect > 0}, connectedPeers = ${s.transport.connectedPeers}, re-announced = ${announces() > announcesBefore}`,
    )
    s.transport.disconnect()
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
