/**
 * Repro: PeerJSTransport as the inner transport of ConferenceTransport - the
 * PARTIAL mesh (`dial` / configureSparse, src/providers/dial.ts).
 *
 * PeerJS's rendezvous is a single well-known name, not a broadcast topic: the
 * coordinator is the only place that knows the room. So the sampling happens
 * there, and the receiving peer keeps what it is not dialing in reserve. The
 * parts below drive the receiving side against a scripted PeerJS constructor
 * (ids claimed on a fake server, 'open' after 5 ms, messages fed by the test).
 *
 *  Part 1 - a peer-list of ids that all sort BELOW ours. The full mesh's rule
 *           is "only the lower id dials" - under a sample only ONE side is
 *           told about the pair, so that rule means half of every sample
 *           yields no link at all. Are they dialed, and are they capped at
 *           `dial` instead of the whole list?
 *  Part 2 - a link drops once (a blip: retried), then again. Is it replaced
 *           out of the RESERVE - the ids of the sample we did not dial -
 *           without asking the coordinator again?
 *  Part 3 - the coordinator says 'peer-left' for a peer we hold a healthy
 *           link to. Its roster is leases; a lease that ran out must not
 *           close a link. Departures are ConferenceTransport's.
 *  Part 4 - the tabs of one browser (BroadcastChannel) announce themselves.
 *           Left unconditional they build a full clique underneath the
 *           sampled mesh - and no browser harness would see it, they all run
 *           one isolated context per peer.
 *  Part 5 - COORDINATOR SIDE: 60 peers in the roster, a 61st joins. Does it
 *           get a SAMPLE instead of the roster, is the sample drawn anew
 *           every time (the first entries of a Set would make the room's
 *           oldest peers hubs), is a leaf left out of it, and is the joiner
 *           announced to a SUBSET rather than to everybody?
 *  Part 6 - Is the coordinator link still a LINK? It must not be: under a
 *           sample it is transient, and a link that comes and goes every
 *           minute would make every peer of the room broadcast a suspicion
 *           about the coordinator, once a minute (ConferenceTransport's
 *           _linkDown -> _scheduleSuspect).
 *  Part 7 - The coordinator is gone and three peers have DISJOINT views of
 *           the room - the old election took the lowest id of a complete
 *           knownPeers, which a sample destroys. Does exactly one of them
 *           end up holding the name, without a claim storm, and without
 *           anybody losing a mesh link over it?
 *  Part 8 - A peer stops renewing. Does its lease run out of the samples,
 *           and does a sample stay long enough to dial with meanwhile?
 *  Part 10 - The peer falls below `dial` links, and to zero. Does it go
 *           back for more at once instead of waiting out its heartbeat?
 *  Part 11 - A LEAF finds nobody at the name (a room that is starting, a
 *           handover), then a relay peer takes it. A leaf waits 12-22 s
 *           before it claims; does it go on asking meanwhile, or sit alone
 *           for all of it? (bench-partial-mesh rendezvousleaves: every leaf
 *           that joined in the first second missed the join - 18.9 s here.)
 *  Part 12 - CONTROL: a room of leaves only. Does the leaf still claim the
 *           name in the end? (20-22 s, as before part 11's change.)
 *  Part 9 - CONTROL: configureSparse never called. Everything of
 *           repro-peerjs-coordinator.ts's world must hold to the byte - the
 *           whole list dialed, the id rule in force, the re-dial unconditional.
 *
 * Every part is gated: exit code 1 if one fails.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-peerjs-sparse.js
 */

import { PeerJSTransport } from '../../src/providers/peerjs/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
const noListeners = { addEventListener: () => {}, removeEventListener: () => {} }
Object.defineProperty(globalThis, 'document', { value: { visibilityState: 'visible', ...noListeners }, configurable: true })
Object.defineProperty(globalThis, 'window', { value: noListeners, configurable: true })

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
  sent: unknown[] = []
  constructor(public peer: string, public metadata?: unknown) {
    super()
  }
  send(d: unknown): void {
    this.sent.push(d)
  }
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
  destroyed = false
  registered = false
  conns: FakeConn[] = []
  private get srv(): typeof FakePeer {
    return this.constructor as typeof FakePeer
  }
  constructor(public id: string, _opts: unknown) {
    super()
    this.srv.all.push(this)
    setTimeout(() => {
      if (this.destroyed) return
      if (this.srv.taken.has(id)) {
        this.emit('error', { type: 'unavailable-id', message: `ID "${id}" is taken` })
      } else {
        this.srv.taken.add(id)
        this.registered = true
        this.emit('open', id)
      }
    }, 5)
  }
  connect(peerId: string, opts?: any): FakeConn {
    this.srv.dials.push(peerId)
    const conn = new FakeConn(peerId, opts?.metadata)
    this.conns.push(conn)
    // PeerJS reports a dial to an id the server does not know on the PEER, not on the
    // connection - the transport's whole coordinator-is-gone path hangs off this.
    if (!this.srv.taken.has(peerId)) {
      setTimeout(() => {
        if (!this.destroyed && !this.srv.taken.has(peerId)) {
          this.emit('error', { type: 'peer-unavailable', message: `Could not connect to peer ${peerId}` })
        }
      }, 5)
    }
    return conn
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.registered) this.srv.taken.delete(this.id)
    for (const c of this.conns) c.close()
  }
}

let Server: typeof FakePeer = FakePeer
function reset(): void {
  Server = class extends FakePeer {
    static all: FakePeer[] = []
    static taken = new Set<string>()
    static dials: string[] = []
  }
}

/** Wait for a condition, or give up. Returns how long it took, -1 if it never came. */
async function until(cond: () => boolean, timeoutMs: number): Promise<number> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return Date.now() - t0
    await sleep(25)
  }
  return -1
}

const encode = (o: object) => new TextEncoder().encode(JSON.stringify(o))
const dialsTo = (id: string) => Server.dials.filter((d) => d === id).length
/** These peers are really in the room: a dial to them is not answered 'peer-unavailable'. */
const exists = (ids: string[]) => ids.forEach((id) => Server.taken.add(id))

/** Links of the mesh: the coordinator's is signaling, and the dial rule does not count it. */
function meshLinks(transport: PeerJSTransport): number {
  const peers = (transport as any).peers as Map<string, unknown>
  return peers.size - (peers.has('yjs-coordinator-r') ? 1 : 0)
}

/** With expectedPeers 100 the rule asks for max(4, ceil(ln 100)) = 5 links. */
const DIAL = 5

/**
 * A regular peer of a sampled room: the coordinator link is open, and the wrapper
 * above has already said how big the room is expected to be and how big it is.
 */
async function sparsePeer(extra: object = {}, opts: { sparse?: boolean; roomSize?: number } = {}) {
  reset()
  Server.taken.add('yjs-coordinator-r') // somebody else holds the room's name
  const transport = new PeerJSTransport({ peer: Server, ...extra } as any)
  if (opts.sparse !== false) transport.configureSparse({ expectedPeers: 100 })
  const connecting = transport.connect({ room: 'r' })
  await sleep(600) // claim refused, regular peer open, 500 ms wait, connect() to the coordinator
  const regular = Server.all[Server.all.length - 1]
  const coordConn = regular.conns[0]
  coordConn.emit('open')
  await connecting
  if (opts.sparse !== false) transport.setRoomSize(opts.roomSize ?? 100)
  return { transport, regular, coordConn, peerId: (transport as any).peerId as string }
}

/** A peer that holds the room's name, with the wrapper's hints already given. */
async function sparseCoordinator() {
  reset()
  const transport = new PeerJSTransport({ peer: Server } as any)
  transport.configureSparse({ expectedPeers: 100 })
  await transport.connect({ room: 'r' })
  // Nobody holds the room's name: two failed sessions, then the sidecar claim.
  await until(() => Server.all.some((p) => p.id === 'yjs-coordinator-r' && p.registered), 8000)
  transport.setRoomSize(100)
  const coordinator = Server.all.find((p) => p.id === 'yjs-coordinator-r')
  if (!coordinator || coordinator.destroyed) throw new Error('setup: the room name was never claimed')
  if (Server.all[0].id === 'yjs-coordinator-r') throw new Error('setup: the name became our identity')
  return { transport, coordinator }
}

/** A peer dials the coordinator and sends its join; returns its connection. */
function joins(coordinator: FakePeer, id: string, msg: Record<string, unknown> = {}): FakeConn {
  const conn = new FakeConn(id)
  coordinator.emit('connection', conn)
  conn.emit('open')
  conn.emit('data', encode({ type: 'join', peerId: id, sparse: true, want: 5, leaf: false, ...msg }))
  return conn
}

/** The last peer-list a connection was sent. */
function lastPeerList(conn: FakeConn): any {
  for (let i = conn.sent.length - 1; i >= 0; i--) {
    const msg = JSON.parse(new TextDecoder().decode(conn.sent[i] as Uint8Array))
    if (msg.type === 'peer-list') return msg
  }
  return undefined
}

/** Open every dial the transport made to one of `ids`. */
function openDialsTo(regular: FakePeer, ids: string[]): string[] {
  const opened: string[] = []
  for (const id of ids) {
    const conn = regular.conns.find((c) => c.peer === id && !c.closed)
    if (conn) {
      conn.emit('open')
      opened.push(id)
    }
  }
  return opened
}

let failed = false
function check(label: string, ok: boolean, detail: string): void {
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`)
  if (!ok) failed = true
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- Part 1
  console.log("\nPart 1 - a sample of ids that all sort BELOW ours (the full mesh would dial none of them)")
  {
    const { transport, regular, coordConn, peerId } = await sparsePeer()
    // 'aaa-*' sorts below 'yjs-r-<rnd>', which is what a regular peer is called.
    const sample = Array.from({ length: 20 }, (_, i) => `aaa-${String(i).padStart(2, '0')}`)
    exists(sample)
    const below = sample.filter((id) => id < peerId).length
    coordConn.emit('data', encode({ type: 'peer-list', peers: sample }))
    await sleep(50)
    const dialed = sample.filter((id) => dialsTo(id) > 0)
    const links = meshLinks(transport)
    console.log(`    our id ${peerId}, ${below} of ${sample.length} sample ids sort below it`)
    check('the sample is dialed at all', dialed.length > 0, `${dialed.length} of ${sample.length} dialed`)
    check('and capped at the dial rule', links === DIAL, `mesh links = ${links}, want ${DIAL}`)
    check('the rest is not dialed', dialed.length < sample.length, `${sample.length - dialed.length} left alone`)
    ;(transport as any).disconnect()
  }

  // ---------------------------------------------------------------- Part 2
  console.log('\nPart 2 - a link drops: is it replaced out of the reserve, without asking the coordinator?')
  {
    const { transport, regular, coordConn } = await sparsePeer()
    const sample = Array.from({ length: 20 }, (_, i) => `aaa-${String(i).padStart(2, '0')}`)
    exists(sample)
    coordConn.emit('data', encode({ type: 'peer-list', peers: sample }))
    await sleep(50)
    const dialedFirst = sample.filter((id) => dialsTo(id) > 0)
    openDialsTo(regular, dialedFirst)
    await sleep(20)
    const sentBefore = coordConn.sent.length
    const victim = dialedFirst[0]

    // A link that merely blipped is worth one retry of the same id.
    regular.conns.find((c) => c.peer === victim && !c.closed)!.close()
    await sleep(3600)
    check('a link that dropped once is retried', dialsTo(victim) === 2, `dials of it: ${dialsTo(victim)}, want 2`)

    // It did not come back. Now the peer is replaced, not chased: knownPeers holds every
    // id ever handed to us, and sticking to a dead one is how a sparse peer starves.
    regular.conns.find((c) => c.peer === victim && !c.closed)!.close()
    await sleep(3600)
    const fresh = sample.filter((id) => dialsTo(id) > 0 && !dialedFirst.includes(id))
    check('then replaced out of the reserve', fresh.length > 0, `new ids dialed: ${fresh.length} (${fresh.join(', ') || 'none'})`)
    check('and not chased any further', dialsTo(victim) === 2, `dials of the lost one: ${dialsTo(victim)}, want 2`)
    check('the coordinator was not asked', coordConn.sent.length === sentBefore, `messages to it: ${coordConn.sent.length - sentBefore}`)
    ;(transport as any).disconnect()
  }

  // ---------------------------------------------------------------- Part 3
  console.log("\nPart 3 - the coordinator says 'peer-left' for a peer we hold a healthy link to")
  {
    const { transport, regular, coordConn } = await sparsePeer()
    const sample = Array.from({ length: 20 }, (_, i) => `aaa-${String(i).padStart(2, '0')}`)
    exists(sample)
    coordConn.emit('data', encode({ type: 'peer-list', peers: sample }))
    await sleep(50)
    const dialed = sample.filter((id) => dialsTo(id) > 0)
    openDialsTo(regular, dialed)
    await sleep(20)
    const victim = dialed[0]
    const before = transport.connectedPeers
    coordConn.emit('data', encode({ type: 'peer-left', peerId: victim }))
    await sleep(50)
    const conn = regular.conns.find((c) => c.peer === victim)!
    check('the link stayed open', !conn.closed, `connectedPeers ${before} -> ${transport.connectedPeers}`)
    ;(transport as any).disconnect()
  }

  // ---------------------------------------------------------------- Part 4
  console.log('\nPart 4 - the tabs of one browser announce themselves (BroadcastChannel)')
  {
    const { transport, regular, coordConn } = await sparsePeer()
    // Fill up on links first, so the rule has every reason to say no.
    const sample = Array.from({ length: 20 }, (_, i) => `aaa-${String(i).padStart(2, '0')}`)
    exists(sample)
    coordConn.emit('data', encode({ type: 'peer-list', peers: sample }))
    await sleep(50)
    openDialsTo(regular, sample.filter((id) => dialsTo(id) > 0))
    await sleep(20)
    const bc = new BroadcastChannel('yjs-peerjs-r')
    ;(bc as any).unref?.()
    const tabs = Array.from({ length: 10 }, (_, i) => `tab-${i}`)
    exists(tabs)
    for (const id of tabs) bc.postMessage({ type: 'announce', peerId: id })
    await sleep(120)
    const dialedTabs = tabs.filter((id) => dialsTo(id) > 0).length
    check('the local tabs did not all become links', dialedTabs < tabs.length, `${dialedTabs} of ${tabs.length} dialed`)
    bc.close()
    ;(transport as any).disconnect()
  }

  // ---------------------------------------------------------------- Part 5
  console.log('\nPart 5 - COORDINATOR SIDE: 60 in the roster, a 61st joins')
  {
    const { transport, coordinator } = await sparseCoordinator()
    const members = Array.from({ length: 60 }, (_, i) => `m-${String(i).padStart(2, '0')}`)
    const memberConns = members.map((id) => joins(coordinator, id, { want: 0, leaf: id === 'm-00' }))
    await sleep(50)

    const first = joins(coordinator, 'joiner-1')
    await sleep(20)
    const reply = lastPeerList(first)
    check('the reply is a sample', reply !== undefined && reply.peers.length < members.length, `${reply?.peers?.length} of ${members.length} ids`)
    check('and big enough to dial with', (reply?.peers?.length ?? 0) >= DIAL, `${reply?.peers?.length} ids, dial ${DIAL}`)
    check('the leaf is not in it', !reply?.peers?.includes('m-00'), reply?.peers?.includes('m-00') ? 'it is' : 'left out')
    check('it carries a successor chain', Array.isArray(reply?.successors) && reply.successors.length > 0, `${reply?.successors?.join(', ')}`)
    check('and a renewal interval', typeof reply?.renewInMs === 'number' && reply.renewInMs >= 60000, `${reply?.renewInMs} ms`)

    // Drawn anew each time: the union of many samples has to cover the room, and no id
    // may be in all of them. The first entries of a Set would give the same few every time.
    const seen = new Map<string, number>()
    let empty = 0
    for (let i = 2; i <= 21; i++) {
      const conn = joins(coordinator, `joiner-${i}`)
      const peers = lastPeerList(conn)?.peers
      if (peers === undefined) empty++
      for (const id of peers ?? []) seen.set(id, (seen.get(id) ?? 0) + 1)
      conn.close() // the session is over; the roster keeps its lease
    }
    await sleep(20)
    const busiest = Math.max(...seen.values())
    check('every joiner was answered', empty === 0, `${empty} of 20 got no sample`)
    check('20 samples cover most of the room', seen.size >= members.length * 0.8, `${seen.size} of ${members.length} ids appeared`)
    check('and no id is in all of them', busiest < 20, `the busiest appeared ${busiest} times of 20`)

    // ONE joiner is announced to a few, not to the room. (Cumulatively, over many joins,
    // everybody hears about somebody - that is the point of a random subset.)
    const heardOf = (c: FakeConn, who: string) =>
      c.sent.some((d) => {
        const m = JSON.parse(new TextDecoder().decode(d as Uint8Array))
        return m.type === 'peer-joined' && m.peerId === who
      })
    joins(coordinator, 'joiner-last').close()
    await sleep(20)
    const announced = memberConns.filter((c) => heardOf(c, 'joiner-last')).length
    check('one joiner is announced to a subset', announced > 0 && announced <= DIAL, `${announced} of ${members.length} members heard of it, cap ${DIAL}`)

    // Holding the name does not excuse it from being in the room: the sessions above are
    // NOT links, so the coordinator is at zero and has to dial its own `dial` out of the
    // roster it happens to be holding.
    members.forEach((id) => Server.taken.add(id))
    const ownLinks = await until(() => ((transport as any).peers.size as number) >= DIAL, 12000)
    const links = (transport as any).peers.size as number
    check('the coordinator takes links of its own', ownLinks >= 0, ownLinks < 0 ? `only ${links} links after 12 s` : `${links} links after ${ownLinks} ms`)
    check('and not one per peer of the room', links <= DIAL * 2, `${links} links, dial ${DIAL}`)

    // One of its own links dies. A lease roster says nothing about that, and there are no
    // links to announce it over - so no peer-left, and nobody is told to forget a live peer.
    const linked = Array.from((transport as any).peers.keys() as Iterable<string>)
    const regular = Server.all.find((fp) => fp.id !== 'yjs-coordinator-r' && !fp.destroyed)!
    regular.conns.find((c) => c.peer === linked[0] && !c.closed)?.close()
    await sleep(80)
    const saidLeft = [...memberConns, ...regular.conns].some((c: FakeConn) =>
      c.sent.some((d) => JSON.parse(new TextDecoder().decode(d as Uint8Array)).type === 'peer-left'),
    )
    check('a lost link is no peer-left', !saidLeft, saidLeft ? 'it announced one' : 'none announced')
    ;(transport as any).disconnect()
  }

  // ---------------------------------------------------------------- Part 6
  console.log('\nPart 6 - the coordinator link is a SESSION, not a link of the mesh')
  {
    const connected: string[] = []
    const disconnected: string[] = []
    const { transport, regular, coordConn } = await sparsePeer({ coordinatorRenewMs: 1000 })
    transport.onPeerConnect((id) => connected.push(id))
    transport.onPeerDisconnect((id) => disconnected.push(id))
    const sample = Array.from({ length: 20 }, (_, i) => `aaa-${String(i).padStart(2, '0')}`)
    exists(sample)
    coordConn.emit('data', encode({ type: 'peer-list', peers: sample }))
    await sleep(50)
    openDialsTo(regular, sample.filter((id) => dialsTo(id) > 0))

    check('it is not in the peer map', !(transport as any).peers.has('yjs-coordinator-r'), `connectedPeers ${transport.connectedPeers}`)
    check('nothing was reported about it', !connected.includes('yjs-coordinator-r'), `reported: ${connected.join(', ') || 'nothing'}`)

    // The sample is in: the session's work is done.
    const closed = await until(() => coordConn.closed, 4000)
    check('the session closes after its sample', closed >= 0, closed < 0 ? 'still open after 4 s' : `after ${closed} ms`)
    check('closing it reported no departure', !disconnected.includes('yjs-coordinator-r'), `reported: ${disconnected.join(', ') || 'nothing'}`)
    check('and the transport is still connected', transport.isConnected, `isConnected ${transport.isConnected}`)

    // It comes back on its own, and claims nothing while doing so.
    const peersBefore = Server.all.length
    const dialsBefore = dialsTo('yjs-coordinator-r')
    const again = await until(() => dialsTo('yjs-coordinator-r') > dialsBefore, 4000)
    check('the heartbeat goes back for its lease', again >= 0, again < 0 ? 'never went back' : `after ${again} ms`)
    check('and no election was started', Server.all.length === peersBefore, `Peers constructed since: ${Server.all.length - peersBefore} (want 0)`)
    ;(transport as any).disconnect()
  }

  // ---------------------------------------------------------------- Part 7
  console.log('\nPart 7 - the coordinator is gone, three peers with disjoint views of the room')
  {
    reset()
    Server.taken.add('yjs-coordinator-r')
    const made: any[] = []
    for (let i = 0; i < 3; i++) {
      const t = new PeerJSTransport({ peer: Server, coordinatorRenewMs: 1000 } as any)
      t.configureSparse({ expectedPeers: 100 })
      const connecting = t.connect({ room: 'r' })
      await sleep(400)
      const own = Server.all[Server.all.length - 1]
      own.conns[0].emit('open')
      await connecting
      t.setRoomSize(100)
      made.push({ t, own, session: own.conns[0] })
    }
    // Each one holds links to peers of its own - disjoint, as samples are.
    const ids = made.map((m) => (m.t as any).peerId as string)
    const chain = [...ids].sort().slice(0, 3) // what a coordinator's roster would hand out
    made.forEach((m, i) => {
      const mine = [`p${i}-a`, `p${i}-b`, `p${i}-c`, `p${i}-d`, `p${i}-e`]
      exists(mine)
      m.session.emit('data', encode({ type: 'peer-list', peers: mine, successors: chain, renewInMs: 1000 }))
    })
    await sleep(80)
    made.forEach((m, i) => openDialsTo(m.own, [`p${i}-a`, `p${i}-b`, `p${i}-c`, `p${i}-d`, `p${i}-e`]))
    await sleep(30)
    const linksBefore = made.map((m) => (m.t as any).peers.size as number)

    // The coordinator vanishes. Its registration goes with it.
    Server.taken.delete('yjs-coordinator-r')
    made.forEach((m) => m.session.close())

    const claimed = await until(() => Server.all.some((p) => p.id === 'yjs-coordinator-r' && p.registered), 15000)
    const holders = Server.all.filter((p) => p.id === 'yjs-coordinator-r' && p.registered && !p.destroyed)
    const attempts = Server.all.filter((p) => p.id === 'yjs-coordinator-r').length
    check('somebody took the name', claimed >= 0, claimed < 0 ? 'nobody did in 15 s' : `after ${claimed} ms`)
    check('exactly one holds it', holders.length === 1, `${holders.length} holder(s)`)
    check('without a claim storm', attempts <= 2, `${attempts} peer(s) tried for it, want <= 2 of 3`)
    const linksAfter = made.map((m) => (m.t as any).peers.size as number)
    check('nobody lost a mesh link over it', linksAfter.every((n, i) => n >= linksBefore[i]), `${linksBefore.join('/')} -> ${linksAfter.join('/')}`)
    made.forEach((m) => (m.t as any).disconnect())
  }

  // ---------------------------------------------------------------- Part 8
  console.log('\nPart 8 - a peer stops renewing: does its lease run out of the samples?')
  {
    const { transport, coordinator } = await sparseCoordinator()
    const members = Array.from({ length: 20 }, (_, i) => `m-${String(i).padStart(2, '0')}`)
    const quiet = members.slice(0, 10)
    for (const id of members) joins(coordinator, id, { want: 0 }).close()
    await sleep(30)
    // The roster's lease comes from the renewal interval the coordinator hands out
    // (60 s by default). Age it by hand instead of waiting two and a half minutes.
    const roster = (transport as any)._roster as Map<string, { expires: number }>
    const now = Date.now()
    for (const id of quiet) roster.get(id)!.expires = now - 1

    const seen = new Set<string>()
    let shortest = Infinity
    for (let i = 0; i < 10; i++) {
      const conn = joins(coordinator, `late-${i}`)
      const peers = lastPeerList(conn)?.peers ?? []
      shortest = Math.min(shortest, peers.length)
      for (const id of peers) seen.add(id)
      conn.close()
    }
    const ghosts = quiet.filter((id) => seen.has(id))
    check('nobody is handed a peer that stopped renewing', ghosts.length === 0, `${ghosts.length} ghost(s) in 10 samples`)
    check('and a sample is still long enough to dial with', shortest >= DIAL, `the shortest held ${shortest} ids, dial ${DIAL}`)
    ;(transport as any).disconnect()
  }

  // --------------------------------------------------------------- Part 10
  console.log('\nPart 10 - short of links: does it go back for more at once?')
  {
    const { transport, regular, coordConn } = await sparsePeer()
    const sample = Array.from({ length: 6 }, (_, i) => `aaa-${i}`) // barely more than dial
    exists(sample)
    coordConn.emit('data', encode({ type: 'peer-list', peers: sample }))
    await sleep(50)
    const dialed = sample.filter((id) => dialsTo(id) > 0)
    openDialsTo(regular, dialed)
    await until(() => coordConn.closed, 4000) // the session did its work and went

    // Three of five links die and the reserve is too thin to cover it.
    const dialsBefore = dialsTo('yjs-coordinator-r')
    for (const id of dialed.slice(0, 3)) {
      Server.taken.delete(id)
      regular.conns.find((c) => c.peer === id && !c.closed)?.close()
    }
    const back = await until(() => dialsTo('yjs-coordinator-r') > dialsBefore, 15000)
    check('it goes back for more within seconds', back >= 0 && back < 5000, back < 0 ? 'never went back' : `after ${back} ms`)
    ;(transport as any).disconnect()
  }

  // --------------------------------------------------------------- Part 11
  console.log('\nPart 11 - a LEAF finds nobody at the name, then somebody takes it')
  {
    reset()
    const transport = new PeerJSTransport({ peer: Server } as any)
    transport.configureSparse({ expectedPeers: 100, passive: true })
    await transport.connect({ room: 'r' })
    // Two sessions find nobody (peer-unavailable): from here a leaf waits 12-22 s before it claims.
    await until(() => dialsTo('yjs-coordinator-r') >= 2, 5000)
    await sleep(50)
    const dialsBefore = dialsTo('yjs-coordinator-r')
    Server.taken.add('yjs-coordinator-r') // a relay peer of the room claimed it meanwhile
    const back = await until(() => dialsTo('yjs-coordinator-r') > dialsBefore, 25000)
    check('it asks the new holder within seconds, not after its own claim', back >= 0 && back < 8000, back < 0 ? 'never asked' : `after ${back} ms`)
    ;(transport as any).disconnect()
  }

  // --------------------------------------------------------------- Part 12
  console.log('\nPart 12 - CONTROL: a room of leaves only - nobody else will ever take the name')
  {
    reset()
    const transport = new PeerJSTransport({ peer: Server } as any)
    transport.configureSparse({ expectedPeers: 100, passive: true })
    const t0 = Date.now()
    await transport.connect({ room: 'r' })
    const held = await until(() => Server.all.some((p) => p.id === 'yjs-coordinator-r' && p.registered), 40000)
    check('the leaf still claims it in the end', held >= 0, held < 0 ? 'never claimed' : `after ${Date.now() - t0} ms`)
    ;(transport as any).disconnect()
  }

  // ---------------------------------------------------------------- Part 9
  console.log('\nPart 9 - CONTROL: configureSparse never called - the full mesh, unchanged')
  {
    const { transport, regular, coordConn, peerId } = await sparsePeer({}, { sparse: false })
    const above = Array.from({ length: 8 }, (_, i) => `zzz-${i}`) // sort above ours: we dial
    const below = Array.from({ length: 8 }, (_, i) => `aaa-${i}`) // sort below: we wait
    exists([...above, ...below])
    coordConn.emit('data', encode({ type: 'peer-list', peers: [...above, ...below] }))
    await sleep(50)
    check('every peer above our id is dialed', above.every((id) => dialsTo(id) > 0), `${above.filter((id) => dialsTo(id) > 0).length} of ${above.length}`)
    check('the id rule still holds below it', below.every((id) => dialsTo(id) === 0), `${below.filter((id) => dialsTo(id) > 0).length} of ${below.length} dialed (want 0)`)
    openDialsTo(regular, above)
    await sleep(20)
    const victim = above[0]
    const redialsBefore = dialsTo(victim)
    regular.conns.find((c) => c.peer === victim && !c.closed)!.close()
    await sleep(3600)
    check('a lost link is re-dialed unconditionally', dialsTo(victim) > redialsBefore, `re-dials: ${dialsTo(victim) - redialsBefore}`)
    check("the coordinator link counts as a peer", (transport as any).peers.has('yjs-coordinator-r'), 'it is in peers')
    ;(transport as any).disconnect()
  }

  console.log(failed ? '\nFAILED' : '\nall parts ok')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
