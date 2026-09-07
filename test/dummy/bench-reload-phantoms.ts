/**
 * Benchmark: what does a peer remember about peers that are gone, and what
 * does that memory cost the peers that stay?
 *
 * Yjs gives every page load a fresh random clientID. On a relay transport
 * without a leave signal (websocket, gun, matrix, nostr, pubnub without
 * presence) GenericProvider learns each id from its beacons, updates and
 * presence and - before round 7 - forgot it only in disconnect(). So every
 * reload of any student added one immortal entry to `_knownPeers`,
 * `_peerAddress` and `_remoteSeqInfo`, and `_peerCount()` - the room size
 * every delay knob reads: the 'auto' awareness throttle (round 6), the
 * reply-suppression window, the presence-relay gate - counted the dead
 * with the living.
 *
 * Part 1: an N-peer relay room in which a random peer reloads (destroy,
 * fresh doc + transport + provider, one keystroke) RELOADS times, every
 * RELOAD_EVERY_MS. A stationary observer reports, right after the last
 * reload and again two awareness leases later: the size of the three
 * per-peer tables, the live presence count, `_peerCount()` and the
 * effective 'auto' awareness interval - against the N peers actually in
 * the room. GRACEFUL=0 kills the tab instead (no disconnect(), no presence
 * null): the room learns of the departure only through the lease.
 *
 * Part 2 (node --expose-gc): the awareness sweep timer's lifecycle. Twenty
 * providers are constructed, connected, then disconnect()ed without
 * destroy() - the pattern of an app that drops a provider when a page
 * section closes. Reports the live Timeout handles attributable to them
 * after construction and after disconnect(), and how many providers a full
 * GC still cannot collect (a timer closure keeps provider, doc and
 * transport alive).
 *
 * Run: npx tsc -p tsconfig.bench.json && node --expose-gc bench-dist/test/dummy/bench-reload-phantoms.js
 *      N=20 RELOADS=30 RELOAD_EVERY_MS=200 AWARENESS_TIMEOUT_MS=5000 GRACEFUL=0 override.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const N = Number(process.env.N ?? 20)
const RELOADS = Number(process.env.RELOADS ?? 30)
const RELOAD_EVERY_MS = Number(process.env.RELOAD_EVERY_MS ?? 200)
// The presence lease: 5 s keeps the run short; the library default is 30 s
// on a relay transport, the playgrounds use 120 s.
const AWARENESS_TIMEOUT_MS = Number(process.env.AWARENESS_TIMEOUT_MS ?? 5000)
const GRACEFUL = process.env.GRACEFUL !== '0'
const LATENCY = 15
const JITTER = 0.2

interface Peer {
  doc: Y.Doc
  transport: DummyTransport
  provider: GenericProvider
}

function makePeer(hub: DummyHub, i: number): Peer {
  const doc = new Y.Doc()
  const transport = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
  const provider = new GenericProvider(doc, transport, {
    batchUpdates: 0,
    verifyUpdates: true,
    syncInterval: 5000,
    disableBc: true,
    awarenessInterval: 'auto',
    awarenessTimeoutMs: AWARENESS_TIMEOUT_MS,
  })
  provider.awareness.setLocalStateField('user', { name: 'u' + i })
  return { doc, transport, provider }
}

/** The observer's view of the room - private tables read whitebox. */
function snapshot(p: GenericProvider, live: number): string {
  const a = p as any
  return (
    `knownPeers=${a._knownPeers.size} peerAddress=${a._peerAddress.size} ` +
    `remoteSeqInfo=${a._remoteSeqInfo.size} presence=${p.awareness.getStates().size} ` +
    `peerCount=${a._peerCount()} (live ${live}) ` +
    `autoAwarenessInterval=${a._effectiveAwarenessInterval()}ms`
  )
}

async function part1(): Promise<void> {
  await silenced(async () => {
    const room = `bench-reload-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const peers: Peer[] = []
    for (let i = 0; i < N; i++) peers.push(makePeer(hub, i))
    await Promise.all(peers.map((p) => p.provider.connect({ room })))
    peers[1].doc.getText('t').insert(0, 'hello')
    await sleep(2000)
    const observer = peers[0].provider
    console.log(`before reloads:          ${snapshot(observer, N)}`)

    for (let k = 0; k < RELOADS; k++) {
      const idx = 1 + (k % (N - 1))
      const old = peers[idx]
      if (!GRACEFUL) {
        // The tab is gone: nothing is said to the room, the transport just
        // stops delivering. destroy() then finds a disconnected transport
        // and sends nothing.
        old.transport.disconnect()
      }
      old.provider.destroy()
      const fresh = makePeer(hub, N + k)
      peers[idx] = fresh
      await fresh.provider.connect({ room })
      fresh.doc.getText('t').insert(0, 'x')
      await sleep(RELOAD_EVERY_MS)
    }
    console.log(`after ${String(RELOADS).padStart(3)} reloads:       ${snapshot(observer, N)}`)
    await sleep(2 * AWARENESS_TIMEOUT_MS + 1000)
    console.log(`after 2 leases:          ${snapshot(observer, N)}`)
    for (const p of peers) p.provider.destroy()
    hub.clear()
  })
}

function timeoutHandles(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
}

async function part2(): Promise<void> {
  await silenced(async () => {
    const M = 20
    const room = `bench-lifecycle-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    await sleep(300) // nothing from an earlier part is in flight
    const base = timeoutHandles()
    let peers: Peer[] | null = []
    for (let i = 0; i < M; i++) peers.push(makePeer(hub, i))
    await sleep(300) // the one-shot awareness throttle of setLocalStateField fires
    const afterConstruct = timeoutHandles() - base
    await Promise.all(peers.map((p) => p.provider.connect({ room })))
    await sleep(500)
    for (const p of peers) p.provider.disconnect()
    // Let the transports' in-flight deliveries (latency timers) drain.
    await sleep(300)
    const afterDisconnect = timeoutHandles() - base
    const armedSweeps = peers.filter(
      (p) => (p.provider as any)._awarenessSweepId !== undefined,
    ).length
    const WeakRefCtor = (globalThis as any).WeakRef
    const refs: Array<{ deref(): unknown }> = peers.map((p) => new WeakRefCtor(p.provider))
    peers = null
    hub.clear()
    const gc = (globalThis as any).gc
    let survivors = -1
    if (typeof gc === 'function') {
      gc()
      await sleep(50)
      gc()
      survivors = refs.filter((r) => r.deref() !== undefined).length
    }
    console.log(
      `lifecycle M=${M}: Timeout handles after construct=${afterConstruct} ` +
        `after disconnect()=${afterDisconnect} sweep timers armed after disconnect()=${armedSweeps}` +
        (survivors >= 0
          ? ` providers alive after GC=${survivors}`
          : ' (run with --expose-gc for the GC count)'),
    )
  })
}

async function main() {
  console.log(
    `reload phantoms: N=${N} reloads=${RELOADS} every ${RELOAD_EVERY_MS}ms lease=${AWARENESS_TIMEOUT_MS}ms ` +
      `graceful=${GRACEFUL} latency=${LATENCY}ms±${JITTER * 100}%\n`,
  )
  await part2()
  console.log()
  await part1()
  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
