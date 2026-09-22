/**
 * Repro: what do non-fatal PeerJS errors do to PeerJSTransport's room
 * coordinator?
 *
 * PeerJS reports on the Peer object, as 'error' events, things that are no
 * reason to give up: 'peer-unavailable' (a connect() to a peer that is
 * gone - the server's EXPIRE) and 'network' ("Lost connection to server.",
 * followed by 'disconnected' - what a phone gets when the OS drops the
 * signaling WebSocket of a backgrounded page). The Peer survives both
 * (peerjs 1.5.5, peer.ts: emitError without destroy).
 *
 * PeerJSTransport takes the PeerJS constructor as an option; here it gets a
 * scripted one (ids claimed on a fake server, 'open' after 5 ms, errors
 * emitted by the test).
 *
 *  Part 1 - coordinator via connect(): emit 'peer-unavailable'.
 *  Part 2 - coordinator via connect(): emit 'network' + 'disconnected'.
 *  Part 3 - coordinator via a won re-election: emit 'peer-unavailable'.
 *
 * Reported per part: is the coordinator's Peer destroyed, which Peers were
 * constructed afterwards, does the transport still claim to be connected.
 *
 * Parts 4-10 script a regular peer (coordinator link open, mesh links to
 * 'zzz-*' peers, which sort above our id: we are the initiator):
 *
 *  Part 4  - a mesh link closes, both sides keep the coordinator: is the
 *            peer re-dialed?
 *  Part 5  - the coordinator dies but the server still holds its id: the
 *            election's claim fails. Does the claim cost us our Peer and
 *            its healthy mesh links?
 *  Part 6  - (coordinator side) a peer we hold an entry for connects again:
 *            is the new connection accepted?
 *  Part 7  - a dial that is never answered (connectTimeout: 1000): does
 *            the entry expire so the peer can be dialed again?
 *  Part 8  - signaling server down, every reconnect() fails after 5 ms:
 *            reconnect() calls in 10 s.
 *  Part 13 - the page comes back while the transport sits in that backoff: the
 *            server is there again, and the tab becomes visible. A real phone
 *            (Chrome on Android, 67 s in the background, no sleep reported):
 *            "server link lost 16 | reconnect 3 at 1948 | connected to
 *            coordinator 3974" - all links back after 4.5 s, against 1.5 s
 *            when the resume path ran. How long until the next reconnect()?
 *  Part 9  - a non-coordinator peer sends 'peer-left' for a third peer: do
 *            we close our healthy link to it?
 *  Part 10 - the first connection to the coordinator times out: is it
 *            ever tried again (next 12 s)?
 *  Part 12 - a link's ICE state goes 'disconnected' and stays there
 *            (iceDisconnectTimeout: 1000) - what Chrome reports for a peer
 *            that vanished; PeerJS itself closes on 'failed' only. And a
 *            link that recovers within the timeout.
 *  Part 11 - the page was suspended: Date.now() jumps by 60 s
 *            (resumeAfterMs: 15000). Does the transport leave and re-join
 *            under a new Peer?
 *  Part 14 - the page slept, and the PeerJS server is not there when it
 *            re-joins (it refuses the first two Peers). Found by
 *            room-scenarios.mjs peerjs, STORM=faults (three pages unfrozen
 *            while the server restarted): "Re-join after resume failed", and
 *            nothing after it - the three stayed out of the room for good,
 *            their documents apart. The re-join must be tried again until it
 *            holds; a disconnect() of the app ends the tries. Exit code 1 if not.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-peerjs-coordinator.js
 */

import { PeerJSTransport } from '../../src/providers/peerjs/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The transport checks navigator.onLine before it reconnects.
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
// ... and listens for the tab becoming visible and the browser's `online` (part 13).
const pageListeners: Record<string, Set<() => void>> = {}
const eventTarget = {
  addEventListener: (type: string, fn: () => void) => (pageListeners[type] ??= new Set()).add(fn),
  removeEventListener: (type: string, fn: () => void) => pageListeners[type]?.delete(fn),
}
Object.defineProperty(globalThis, 'document', { value: { visibilityState: 'visible', ...eventTarget }, configurable: true })
Object.defineProperty(globalThis, 'window', { value: eventTarget, configurable: true })
const pageEvent = (type: string) => pageListeners[type]?.forEach((fn) => fn())

type Handler = (...args: any[]) => void

class Emitter {
  private handlers = new Map<string, Handler[]>()
  on(event: string, h: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), h])
  }
  once(event: string, h: Handler): void {
    const wrapped: Handler = (...args) => {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((x) => x !== wrapped))
      h(...args)
    }
    this.on(event, wrapped)
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) h(...args)
  }
}

class FakeConn extends Emitter {
  closed = false
  constructor(public peer: string) {
    super()
  }
  send(_d: unknown): void {}
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

class FakePeer extends Emitter {
  static all: FakePeer[] = []
  static taken = new Set<string>()
  static dials: string[] = []
  static serverDown = false
  static reconnects = 0
  static refuseNew = 0 // the next n Peers get no id from the server
  destroyed = false
  disconnected = false
  registered = false
  conns: FakeConn[] = []
  /** The fake server this Peer belongs to: one subclass per part, see reset(). */
  private get srv(): typeof FakePeer {
    return this.constructor as typeof FakePeer
  }
  constructor(public id: string, _opts: unknown) {
    super()
    this.srv.all.push(this)
    setTimeout(() => {
      if (this.destroyed) return
      if (this.srv.refuseNew > 0) {
        this.srv.refuseNew--
        this.emit('error', { type: 'server-error', message: 'Could not get an ID from the server.' })
        return
      }
      if (this.srv.taken.has(id)) {
        this.emit('error', { type: 'unavailable-id', message: `ID "${id}" is taken` })
      } else {
        this.srv.taken.add(id)
        this.registered = true
        this.emit('open', id)
      }
    }, 5)
  }
  connect(peerId: string): FakeConn {
    this.srv.dials.push(peerId)
    const conn = new FakeConn(peerId)
    this.conns.push(conn)
    return conn
  }
  reconnect(): void {
    if (this.destroyed) throw new Error('This peer cannot reconnect to the server. It has already been destroyed.')
    if (!this.disconnected) throw new Error(`Peer ${this.id} cannot reconnect because it is not disconnected from the server!`)
    this.srv.reconnects++
    this.disconnected = false
    setTimeout(() => {
      if (this.destroyed) return
      if (this.srv.serverDown) this.dropSignaling()
      else this.emit('open', this.id)
    }, 5)
  }
  /** What peerjs does when its socket to the server goes away. */
  dropSignaling(): void {
    this.disconnected = true
    this.emit('error', { type: 'network', message: 'Lost connection to server.' })
    this.emit('disconnected', this.id)
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.registered) this.srv.taken.delete(this.id) // a refused claimant frees nothing
    for (const c of this.conns) c.close()
  }
}

/**
 * A fresh fake server per part: a transport of an earlier part keeps some
 * of its retry timers after disconnect(), and must not construct Peers
 * into the part being measured.
 */
let Server: typeof FakePeer = FakePeer
function reset(): void {
  Server = class extends FakePeer {
    static all: FakePeer[] = []
    static taken = new Set<string>()
    static dials: string[] = []
    static serverDown = false
    static reconnects = 0
    static refuseNew = 0
  }
}

const encode = (o: object) => new TextEncoder().encode(JSON.stringify(o))
const dialsTo = (id: string) => Server.dials.filter((d) => d === id).length

/** A regular peer: somebody else is coordinator, our link to it is open, mesh links to `meshPeers` are open. */
async function regularPeer(meshPeers: string[], extra: object = {}) {
  reset()
  Server.taken.add('yjs-coordinator-r')
  const options: any = { peer: Server, ...extra } // options of later items are not in the type on older builds
  const transport = new PeerJSTransport(options)
  const connecting = transport.connect({ room: 'r' })
  await sleep(600) // claim refused, regular peer open, 500 ms wait, connect() to the coordinator
  const regular = Server.all[Server.all.length - 1]
  const coordConn = regular.conns[0]
  coordConn.emit('open')
  await connecting
  coordConn.emit('data', encode({ type: 'peer-list', peers: meshPeers }))
  const mesh = meshPeers.map((id) => regular.conns.find((c) => c.peer === id)!)
  for (const c of mesh) c.emit('open')
  if (transport.connectedPeers !== meshPeers.length + 1) throw new Error('setup: mesh links not open')
  return { transport, regular, coordConn, mesh }
}

function report(label: string, transport: PeerJSTransport, coordinator: FakePeer, from: number): void {
  const later = Server.all.slice(from).map((p) => `${p.id}${p.destroyed ? ' (destroyed)' : ''}`)
  console.log(`  ${label}`)
  console.log(`    coordinator Peer destroyed:   ${coordinator.destroyed}`)
  console.log(`    Peers constructed afterwards: ${later.length === 0 ? 'none' : later.join(', ')}`)
  console.log(`    transport.isConnected:        ${transport.isConnected}`)
}

async function claimedCoordinator() {
  reset()
  const transport = new PeerJSTransport({ peer: Server })
  await transport.connect({ room: 'r' })
  const coordinator = Server.all[0]
  if (coordinator.id !== 'yjs-coordinator-r' || coordinator.destroyed) throw new Error('setup: no coordinator')
  return { transport, coordinator }
}

async function main() {
  console.log("Part 1 - coordinator, PeerJS emits the non-fatal 'peer-unavailable'")
  {
    const { transport, coordinator } = await claimedCoordinator()
    const from = Server.all.length
    coordinator.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer yjs-r-gone' })
    await sleep(7000) // the recreated peer's 500 ms wait + 5 s coordinator timeout
    report('after 7 s:', transport, coordinator, from)
  }

  console.log("\nPart 2 - coordinator, the signaling socket drops: 'network' error, then 'disconnected'")
  {
    const { transport, coordinator } = await claimedCoordinator()
    const from = Server.all.length
    coordinator.disconnected = true
    coordinator.emit('error', { type: 'network', message: 'Lost connection to server.' })
    coordinator.emit('disconnected', coordinator.id)
    await sleep(7000)
    report('after 7 s:', transport, coordinator, from)
  }

  console.log("\nPart 3 - coordinator by re-election, then 'peer-unavailable'")
  {
    reset()
    Server.taken.add('yjs-coordinator-r') // somebody else is coordinator
    const transport = new PeerJSTransport({ peer: Server })
    const connecting = transport.connect({ room: 'r' })
    await sleep(600) // claim refused, regular peer open, 500 ms wait, connect() to the coordinator
    const regular = Server.all[Server.all.length - 1]
    const coordConn = regular.conns[0]
    coordConn.emit('open')
    await connecting
    Server.taken.delete('yjs-coordinator-r') // the coordinator leaves ...
    coordConn.emit('close') // ... and we, alone, win the election
    await sleep(100)
    const coordinator = Server.all[Server.all.length - 1]
    if (coordinator.id !== 'yjs-coordinator-r' || coordinator.destroyed) throw new Error('setup: election not won')
    const from = Server.all.length
    coordinator.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer yjs-r-gone' })
    await sleep(7000)
    report('after 7 s:', transport, coordinator, from)
  }

  console.log('\nPart 4 - a mesh link closes, the coordinator link stays')
  {
    const { transport, mesh } = await regularPeer(['zzz-b'])
    const before = dialsTo('zzz-b')
    mesh[0].emit('close')
    await sleep(6000)
    console.log(`  re-dials of the lost peer in 6 s: ${dialsTo('zzz-b') - before}, connectedPeers: ${transport.connectedPeers}`)
    transport.disconnect()
  }

  console.log("\nPart 5 - the coordinator dies, the server still holds its id: the election's claim fails")
  {
    const { transport, regular, coordConn } = await regularPeer(['zzz-b'])
    coordConn.emit('close') // 'yjs-coordinator-r' stays taken: a dead registration
    await sleep(300)
    console.log(`  our Peer destroyed: ${regular.destroyed}, mesh links still open: ${transport.connectedPeers}`)
    transport.disconnect()
  }

  console.log('\nPart 6 - a peer we hold an entry for connects again (coordinator side)')
  {
    const { transport, coordinator } = await claimedCoordinator()
    const first = new FakeConn('yjs-r-phone')
    coordinator.emit('connection', first)
    first.emit('open')
    const second = new FakeConn('yjs-r-phone')
    coordinator.emit('connection', second)
    second.emit('open')
    console.log(`  new connection refused: ${second.closed}, old entry closed: ${first.closed}, connectedPeers: ${transport.connectedPeers}`)
    transport.disconnect()
  }

  console.log('\nPart 7 - a dial that is never answered, connectTimeout 1000 ms')
  {
    const { transport, coordConn } = await regularPeer([], { connectTimeout: 1000 })
    coordConn.emit('data', encode({ type: 'peer-joined', peerId: 'zzz-gone' }))
    await sleep(1500)
    const before = dialsTo('zzz-gone')
    coordConn.emit('data', encode({ type: 'peer-joined', peerId: 'zzz-gone' }))
    console.log(`  after 1500 ms the peer joins again: new dials = ${dialsTo('zzz-gone') - before}`)
    transport.disconnect()
  }

  console.log('\nPart 8 - signaling server down, every reconnect() fails after 5 ms')
  {
    const { transport, regular } = await regularPeer([])
    Server.serverDown = true
    regular.dropSignaling()
    await sleep(10000)
    console.log(`  reconnect() calls in 10 s: ${Server.reconnects}`)
    Server.serverDown = false
    transport.disconnect()
  }

  console.log('\nPart 13 - the tab becomes visible while a reconnect waits in its backoff (the server is back)')
  {
    const { transport, regular } = await regularPeer([])
    Server.serverDown = true
    regular.dropSignaling()
    await sleep(6000) // attempts 1-4 have failed, the next one is seconds away
    const before = Server.reconnects
    Server.serverDown = false
    const t0 = Date.now()
    pageEvent('visibilitychange')
    while (Server.reconnects === before && Date.now() - t0 < 12000) await sleep(20)
    console.log(`  next reconnect() after: ${Server.reconnects === before ? 'NEVER (12 s)' : Date.now() - t0 + ' ms'}`)
    transport.disconnect()
  }

  console.log("\nPart 9 - a non-coordinator peer sends 'peer-left' for a third peer")
  {
    const { transport, mesh } = await regularPeer(['zzz-b', 'zzz-c'])
    mesh[0].emit('data', encode({ type: 'peer-left', peerId: 'zzz-c' }))
    console.log(`  our link to the third peer closed: ${mesh[1].closed}, connectedPeers: ${transport.connectedPeers} of 3`)
    transport.disconnect()
  }

  console.log('\nPart 10 - the first connection to the coordinator times out')
  {
    reset()
    Server.taken.add('yjs-coordinator-r') // a dead registration: the dial is never answered
    const transport = new PeerJSTransport({ peer: Server })
    await transport.connect({ room: 'r' }) // resolves after the 5 s timeout
    const before = dialsTo('yjs-coordinator-r')
    await sleep(12000)
    console.log(`  further dials of the coordinator in 12 s: ${dialsTo('yjs-coordinator-r') - before}`)
    transport.disconnect()
  }

  console.log("\nPart 12 - ICE 'disconnected' that stays / that recovers, iceDisconnectTimeout 1000 ms")
  {
    const { transport, mesh } = await regularPeer(['zzz-b', 'zzz-c'], { iceDisconnectTimeout: 1000 })
    mesh[0].emit('iceStateChanged', 'disconnected') // stays
    mesh[1].emit('iceStateChanged', 'disconnected') // recovers
    await sleep(500)
    mesh[1].emit('iceStateChanged', 'connected')
    await sleep(1000)
    console.log(`  silent link closed: ${mesh[0].closed}, recovered link closed: ${mesh[1].closed}, connectedPeers: ${transport.connectedPeers} of 3`)
    transport.disconnect()
  }

  console.log('\nPart 11 - the page slept: Date.now() jumps by 60 s, resumeAfterMs 15000')
  {
    const { transport, regular } = await regularPeer(['zzz-b'])
    let gone = 0
    transport.onPeerDisconnect(() => gone++)
    const realNow = Date.now
    Date.now = () => realNow() + 60000
    await sleep(2500)
    Date.now = realNow
    const fresh = Server.all.filter((p) => !p.destroyed && p !== regular).map((p) => p.id)
    console.log(
      `  old Peer destroyed: ${regular.destroyed}, links reported gone: ${gone} of 2, new Peer: ${fresh.join(', ') || 'none'}`,
    )
    transport.disconnect()
  }

  console.log('\nPart 14 - the page slept, and the server refuses the first two Peers of the re-join')
  let failed = false
  {
    const { transport, regular } = await regularPeer(['zzz-b'])
    Server.refuseNew = 2
    const realNow = Date.now
    Date.now = () => realNow() + 60000
    await sleep(2500)
    Date.now = realNow
    await sleep(8000) // retries: ~1 s, ~2 s, ...
    const open = Server.all.filter((p) => !p.destroyed && p !== regular && p.registered).map((p) => p.id)
    const tried = Server.all.filter((p) => p !== regular).length
    const back = open.length > 0
    console.log(`  Peers tried after the resume: ${tried}, open now: ${open.join(', ') || 'none'} (want one)`)
    transport.disconnect()
    Server.refuseNew = 1000
    const before = Server.all.length
    await sleep(6000)
    const after = Server.all.length - before
    console.log(`  after the app's disconnect(), with the server refusing: ${after} more Peers in 6 s (want 0)`)
    if (!back || after > 0) failed = true
    console.log(`  ${back && after === 0 ? 'ok' : 'FAIL'}`)
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
