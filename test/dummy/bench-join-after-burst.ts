/**
 * Benchmark: K empty peers join a settled room of M peers that has content,
 * while one settled peer keeps typing - and they join shortly after the
 * room's own join burst, i.e. while every settled peer's 20-per-10s sync
 * budget (`_tryReserveSyncSlot()`) is still partly spent on the replies of
 * that burst. `bench-late-join.ts` covers the same shape but settles for
 * longer than the budget window first, which is why it never saw the
 * 13-second convergence that the digest beacon's first version had here
 * (docs/superpowers/specs/2026-09-05-digest-beacon-design.md, Task 3b).
 *
 * Two variants per profile: JOIN_AFTER_MS after the settled peers connected
 * (inside the budget window), and after SETTLE_LONG_MS (fresh budget).
 * Reports per-class deliveries and time to convergence; PASS = every
 * variant converges within CONVERGE_CAP_MS.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-join-after-burst.js
 */

import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { PROFILES, sleep, silenced, type Profile } from './bench-user-scaling'

const M = 40
const K = 10
const EDITS = 10
const CONTENT_CHARS = 2000
const JOIN_AFTER_MS = 600
const SETTLE_LONG_MS = 12000
const CONVERGE_CAP_MS = 30000
const PASS_CONVERGE_MS = 2000
const TEST_PROFILES: Profile[] = PROFILES.filter(
  (p) => p.name.startsWith('WebSocket') || p.name.startsWith('Matrix'),
)

type Cls =
  | 'request'
  | 'requestJoin'
  | 'ack'
  | 'syncStep2'
  | 'push'
  | 'update'
  | 'awareness'
  | 'other'
const CLASSES: Cls[] = ['request', 'requestJoin', 'ack', 'syncStep2', 'push', 'update', 'awareness', 'other']
type Census = Record<Cls, number>
const newCensus = (): Census => {
  const c = {} as Census
  for (const k of CLASSES) c[k] = 0
  return c
}

/** Classify one CRC32-stripped message; recurses into MESSAGE_BATCH (4). */
function classifyOne(msg: Uint8Array, census: Census, mult: number): void {
  const d = decoding.createDecoder(msg)
  const t = decoding.readVarUint(d)
  if (t === 4) {
    while (decoding.hasContent(d)) classifyOne(decoding.readVarUint8Array(d), census, mult)
    return
  }
  let cls: Cls = 'other'
  if (t === 0 || t === 3) {
    if (t === 3) {
      decoding.readVarUint(d) // seq
      decoding.readVarUint(d) // clientID
    }
    const sub = decoding.readVarUint(d)
    // A full-state push is a plain Update on the wire; tell it apart from
    // a keystroke by size (the settled doc here is 2 KB, a keystroke ~30 B).
    cls = sub === 0 ? 'request' : sub === 1 ? 'syncStep2' : msg.length > 200 ? 'push' : 'update'
  } else if (t === 5) {
    decoding.readVarUint(d) // version
    const flags = decoding.readVarUint(d)
    cls = flags & 2 ? 'ack' : flags & 1 ? 'requestJoin' : 'request'
  } else if (t === 6) {
    cls = 'push' // MESSAGE_SYNC_PUSH: connect-time full state (phase 1b)
  } else if (t === 1) {
    cls = 'awareness'
  }
  census[cls] += mult
}

function makeProvider(hub: DummyHub, profile: Profile, id: number): GenericProvider {
  const provider = new GenericProvider(
    new Y.Doc(),
    new DummyTransport({
      hub,
      latency: profile.latency,
      jitter: profile.jitter,
      unicast: process.env.DUMMY_UNICAST === '1',
    }),
    { batchUpdates: 0, verifyUpdates: true, syncInterval: 0 },
  )
  provider.awareness.setLocalStateField('user', { id })
  return provider
}

async function run(profile: Profile, joinAfterMs: number): Promise<{ ms: number; converged: boolean; census: Census; deliveries: number }> {
  return silenced(async () => {
    const room = `bench-jab-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const census = newCensus()
    let deliveries = 0
    let counting = false
    const original = hub.broadcast.bind(hub)
    ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (
      r: string,
      data: Uint8Array,
      sender: DummyTransport,
      options?: { latency?: number; dropRate?: number; jitter?: number },
    ) => {
      if (counting) {
        const n = Math.max(0, hub.getRoomSize(r) - 1)
        deliveries += n
        if (data.length >= 5) classifyOne(data.subarray(4), census, n)
      }
      return original(r, data, sender, options)
    }
    const originalUnicast = hub.unicast.bind(hub)
    ;(hub as unknown as { unicast: typeof hub.unicast }).unicast = (
      r: string,
      targetId: string,
      data: Uint8Array,
      sender: DummyTransport,
      options?: { latency?: number; dropRate?: number; jitter?: number },
    ) => {
      if (counting) {
        deliveries += 1
        if (data.length >= 5) classifyOne(data.subarray(4), census, 1)
      }
      return originalUnicast(r, targetId, data, sender, options)
    }

    const settled: GenericProvider[] = []
    for (let i = 0; i < M; i++) settled.push(makeProvider(hub, profile, i))
    await Promise.all(settled.map((p) => p.connect({ room })))
    settled[0].doc.getText('t').insert(0, 'x'.repeat(CONTENT_CHARS))
    const t0 = Date.now()
    while (Date.now() - t0 < 10000 && settled.some((p) => p.doc.getText('t').length !== CONTENT_CHARS)) await sleep(10)
    await sleep(Math.max(0, joinAfterMs - (Date.now() - t0)))

    counting = true
    const joiners: GenericProvider[] = []
    for (let i = 0; i < K; i++) joiners.push(makeProvider(hub, profile, M + i))
    const joining = Promise.all(joiners.map((p) => p.connect({ room })))
    const text = settled[0].doc.getText('t')
    for (let i = 0; i < EDITS; i++) text.insert(text.length, 'a')
    await joining
    const all = [...settled, ...joiners]
    const target = text.toString()
    const start = Date.now()
    while (
      Date.now() - start < CONVERGE_CAP_MS &&
      (all.some((p) => p.doc.getText('t').toString() !== target) || joiners.some((p) => !p.synced))
    ) {
      await sleep(10)
    }
    const ms = Date.now() - start
    const converged = all.every((p) => p.doc.getText('t').toString() === target) && joiners.every((p) => p.synced)
    await sleep(profile.latency * 2 + 100)
    counting = false

    for (const p of all) p.destroy()
    hub.clear()
    return { ms, converged, census, deliveries }
  })
}

async function main() {
  console.log(
    `M=${M} settled peers with ${CONTENT_CHARS} chars, one typing ${EDITS} chars while K=${K} empty peers join.\n` +
      `"in budget window" = joiners arrive ${JOIN_AFTER_MS}ms after the settled peers connected; "fresh budget" = after ${SETTLE_LONG_MS}ms.\n` +
      `Deliveries counted per recipient from the joiners' connect() until everyone converged (+ 2 latencies).\n`,
  )
  let allOk = true
  for (const profile of TEST_PROFILES) {
    for (const [label, joinAfter] of [
      ['in budget window', JOIN_AFTER_MS],
      ['fresh budget', SETTLE_LONG_MS],
    ] as const) {
      const r = await run(profile, joinAfter)
      const ok = r.converged && r.ms <= PASS_CONVERGE_MS
      if (!ok) allOk = false
      const classes = CLASSES.filter((k) => r.census[k] > 0)
        .map((k) => `${k}=${r.census[k]}`)
        .join(' ')
      console.log(
        `JOINBURST profile=${profile.name.split(' ')[0]} variant="${label}" converged=${r.converged} ms=${r.ms} deliveries=${r.deliveries} ${classes} => ${ok ? 'PASS' : 'FAIL'}`,
      )
    }
  }
  console.log(allOk ? `\nRESULT: PASS (all variants converged within ${PASS_CONVERGE_MS}ms)` : `\nRESULT: FAIL (a variant did not converge within ${PASS_CONVERGE_MS}ms)`)
  process.exit(allOk ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
