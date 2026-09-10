/**
 * Benchmark: what does a join cost, per message class, on a relay transport
 * (or a mesh with DUMMY_UNICAST=1)?
 *
 *  (a) LATE JOIN: one empty peer joins a settled N-peer room with content
 *      (settle 20 s: past the 10 s rate-limit window and past the 15 s
 *      awareness renewal). Counted for a fixed 6 s window.
 *  (b) FRESH BURST: N empty peers connect concurrently into an empty room.
 *      Counted for a fixed 20 s window - this includes the CONFIRM retries of
 *      the response wait (1/2/4 s x RTT), which a count that stops at "all
 *      synced" misses entirely (phase 1e: 19k at all-synced vs 92k until
 *      quiet at N=100 on the phase-1d build), and, identically for every
 *      build, one 15 s awareness renewal per peer.
 *
 * Fixed windows and a 60 s periodic beacon (idle backoff off) keep periodic
 * traffic out of the count: with a quiet-based window and the 5 s beacon,
 * whether a build's backed-off ticks and the 15 s renewals landed inside
 * the window depended on the build's own backoff timing (phase 1e Task 4
 * measured 10,400 vs 30,500 for the same join for that reason alone).
 *
 * Deliveries are per recipient (a broadcast = N-1, a unicast = 1); the
 * number after the slash is broadcast/unicast sends. Presence is the
 * awareness class; "beacon" covers JOIN, CONFIRM, periodic and resync
 * digests; "ack" the digest acks.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-join-census.js
 *      N=50,100 PROFILES=WebSocket,Gun SETTLE_MS=11000 DUMMY_UNICAST=1 override.
 */
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { PROFILES as ALL_PROFILES, sleep, silenced, type Profile } from './bench-user-scaling'

const N_VALUES = (process.env.N ?? '50,100').split(',').map(Number)
const PROFILE_NAMES = (process.env.PROFILES ?? 'WebSocket,Gun').split(',')
const PROFILES: Profile[] = ALL_PROFILES.filter((p) => PROFILE_NAMES.some((n) => p.name.startsWith(n)))
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 20000)
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 60000)
const LATE_WINDOW_MS = 6000
const FRESH_WINDOW_MS = 20000
const UNICAST = process.env.DUMMY_UNICAST === '1'

type Cls = 'beacon' | 'ack' | 'syncStep2' | 'push' | 'awareness' | 'other'
const CLASSES: Cls[] = ['beacon', 'ack', 'syncStep2', 'push', 'awareness', 'other']
type Census = Record<Cls, number>

function classify(msg: Uint8Array, out: Census, mult: number): void {
  const d = decoding.createDecoder(msg)
  const t = decoding.readVarUint(d)
  if (t === 4) {
    while (decoding.hasContent(d)) classify(decoding.readVarUint8Array(d), out, mult)
    return
  }
  let cls: Cls = 'other'
  if (t === 0 || t === 3) {
    if (t === 3) {
      decoding.readVarUint(d)
      decoding.readVarUint(d)
    }
    const sub = decoding.readVarUint(d)
    cls = sub === 1 ? 'syncStep2' : sub === 0 ? 'beacon' : 'push'
  } else if (t === 5) {
    decoding.readVarUint(d)
    cls = decoding.readVarUint(d) & 2 ? 'ack' : 'beacon'
  } else if (t === 6) cls = 'push'
  else if (t === 1) cls = 'awareness'
  out[cls] += mult
}

function newCensus(): Census {
  const c = {} as Census
  for (const k of CLASSES) c[k] = 0
  return c
}

/** Shadow broadcast and unicast on the hub; count while `counting`. */
function shadowHub(hub: DummyHub) {
  const s = { counting: false, deliveries: newCensus(), sends: newCensus() }
  const count = (data: Uint8Array, recipients: number) => {
    if (!s.counting || data.length < 5) return
        classify(data.subarray(4), s.deliveries, recipients)
    classify(data.subarray(4), s.sends, 1)
  }
  const origB = hub.broadcast.bind(hub)
  ;(hub as any).broadcast = (room: string, data: Uint8Array, sender: DummyTransport, o?: any) => {
    count(data, Math.max(0, hub.getRoomSize(room) - 1))
    return origB(room, data, sender, o)
  }
  const origU = hub.unicast.bind(hub)
  ;(hub as any).unicast = (...args: Parameters<DummyHub['unicast']>) => {
    count(args[2], 1)
    return origU(...args)
  }
  return s
}

function fmt(s: ReturnType<typeof shadowHub>): string {
  const total = CLASSES.reduce((a, c) => a + s.deliveries[c], 0)
  return (
    `total ${String(total).padStart(6)} | ` +
    CLASSES.filter((c) => c !== 'other').map((c) => `${c} ${s.deliveries[c]}/${s.sends[c]}`).join(' | ')
  )
}

function mk(hub: DummyHub, p: Profile, id: number) {
  const doc = new Y.Doc()
  const prov = new GenericProvider(
    doc,
    new DummyTransport({ hub, latency: p.latency, jitter: p.jitter, unicast: UNICAST }),
    {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: SYNC_INTERVAL_MS,
      idleBackoffEnabled: false,
      disableBc: true,
    },
  )
  prov.awareness.setLocalStateField('user', { id })
  return { doc, prov }
}

async function forWindow(windowMs: number, tick?: () => void) {
  const t0 = Date.now()
  while (Date.now() - t0 < windowMs) {
    tick?.()
    await sleep(5)
  }
}

async function lateJoin(N: number, p: Profile): Promise<void> {
  await silenced(async () => {
    const room = `census-late-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const s = shadowHub(hub)
    const peers = Array.from({ length: N }, (_, i) => mk(hub, p, i))
    await Promise.all(peers.map((x) => x.prov.connect({ room })))
    peers[0].doc.getText('t').insert(0, 'hello world '.repeat(50))
    await sleep(SETTLE_MS)

    const joiner = mk(hub, p, N)
    s.counting = true
    const t0 = Date.now()
    await joiner.prov.connect({ room })
    let syncedAt = -1
    let contentAt = -1
    await forWindow(LATE_WINDOW_MS, () => {
      if (syncedAt < 0 && joiner.prov.synced) syncedAt = Date.now() - t0
      if (contentAt < 0 && joiner.doc.getText('t').length > 0) contentAt = Date.now() - t0
    })
    s.counting = false
    console.log(`${p.name.split(' ')[0].padEnd(9)} N=${String(N).padStart(3)} | ${fmt(s)} | content ${contentAt} ms, synced ${syncedAt} ms`)
    for (const x of peers) x.prov.destroy()
    joiner.prov.destroy()
    hub.clear()
  })
}

async function freshBurst(N: number, p: Profile): Promise<void> {
  await silenced(async () => {
    const room = `census-fresh-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const s = shadowHub(hub)
    const peers = Array.from({ length: N }, (_, i) => mk(hub, p, i))
    s.counting = true
    const t0 = Date.now()
    await Promise.all(peers.map((x) => x.prov.connect({ room })))
    let allSyncedAt = -1
    let atAllSynced = 0
    await forWindow(FRESH_WINDOW_MS, () => {
      if (allSyncedAt < 0 && peers.every((x) => x.prov.synced)) {
        allSyncedAt = Date.now() - t0
        atAllSynced = CLASSES.reduce((a, c) => a + s.deliveries[c], 0)
      }
    })
    s.counting = false
    console.log(
      `${p.name.split(' ')[0].padEnd(9)} N=${String(N).padStart(3)} | ${fmt(s)} | all synced ${allSyncedAt} ms at ${atAllSynced}`,
    )
    for (const x of peers) x.prov.destroy()
    hub.clear()
  })
}

async function main() {
  console.log(`mode: ${UNICAST ? 'unicast' : 'relay'}, syncInterval ${SYNC_INTERVAL_MS} ms`)
  console.log(`\n=== (a) one late joiner into a settled room with content, ${LATE_WINDOW_MS / 1000} s window (deliveries/sends per class) ===`)
  for (const p of PROFILES) for (const N of N_VALUES) await lateJoin(N, p)
  console.log(`\n=== (b) fresh-room join burst, ${FRESH_WINDOW_MS / 1000} s window ===`)
  for (const p of PROFILES) for (const N of N_VALUES) await freshBurst(N, p)
}
main()
