/**
 * Benchmark: what does a fully-synced, completely idle room cost per second,
 * per message class - and does a lost delete-only update still heal?
 *
 * (a) Idle census: N peers connect, one edit, everyone converges, then
 *     nobody does anything for OBSERVE_MS. Every delivery in that window is
 *     protocol overhead by definition. Counted per class (request =
 *     SyncStep1 or digest beacon, SyncStep2, Update, Awareness) per
 *     recipient, via a shadowed DummyHub.broadcast (same convention as
 *     bench-user-scaling.ts's instrumentHub). Floors printed for
 *     comparison: request floor = N*(N-1) per syncInterval (one beacon per
 *     peer per tick is the protocol's minimum), awareness floor = one
 *     y-protocols renewal per peer per 15s (awareness.js: outdatedTimeout/2).
 * (b) Lost delete: two peers; A inserts, both converge; A deletes and the
 *     hub drops A's very next broadcast (batchUpdates=0, so that IS the
 *     delete update). Time until B's text equals A's, capped. The state
 *     vector does not cover deletions, so this is the scenario the
 *     delete-set hash exists for - see
 *     docs/superpowers/specs/2026-09-05-digest-beacon-design.md. On the
 *     pre-change code this heals via B's next empty SyncStep2 cycle (the
 *     reply always carries the full delete set); after the change it must
 *     heal via the dsHash mismatch in B's beacon. Same latency bound
 *     (one syncInterval + reply) either way - this part exists to make
 *     shipping "reply only on difference" WITHOUT the hash impossible.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-idle-room.js
 */

import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const SYNC_INTERVAL_MS = 1000
const LATENCY = 20
const JITTER = 0.25
const SETTLE_MS = 2500
const OBSERVE_MS = 10000
const N_VALUES = [5, 20, 50]
const LOST_DELETE_CAP_MS = 5000
const LOST_DELETE_SAMPLES = 5

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_SYNC_VERIFIED = 3
const MESSAGE_BATCH = 4
const MESSAGE_SYNC_DIGEST = 5

type Cls = 'request' | 'syncStep2' | 'update' | 'awareness' | 'other'
const CLASSES: Cls[] = ['request', 'syncStep2', 'update', 'awareness', 'other']
type Census = Record<Cls, { count: number; bytes: number }>

function newCensus(): Census {
  const c = {} as Census
  for (const k of CLASSES) c[k] = { count: 0, bytes: 0 }
  return c
}

/** Classify one CRC32-stripped message; recurses into MESSAGE_BATCH. */
function classifyOne(msg: Uint8Array, census: Census, mult: number): void {
  const decoder = decoding.createDecoder(msg)
  const msgType = decoding.readVarUint(decoder)
  if (msgType === MESSAGE_BATCH) {
    while (decoding.hasContent(decoder)) {
      classifyOne(decoding.readVarUint8Array(decoder), census, mult)
    }
    return
  }
  let cls: Cls = 'other'
  if (msgType === MESSAGE_SYNC || msgType === MESSAGE_SYNC_VERIFIED) {
    if (msgType === MESSAGE_SYNC_VERIFIED) {
      decoding.readVarUint(decoder) // seq
      decoding.readVarUint(decoder) // clientID
    }
    const sub = decoding.readVarUint(decoder)
    cls = sub === 0 ? 'request' : sub === 1 ? 'syncStep2' : 'update'
  } else if (msgType === MESSAGE_SYNC_DIGEST) {
    cls = 'request'
  } else if (msgType === MESSAGE_AWARENESS) {
    cls = 'awareness'
  }
  census[cls].count += mult
  census[cls].bytes += msg.length * mult
}

/**
 * Shadow hub.broadcast: count per-recipient deliveries by class while
 * `counting` is on, and swallow exactly one broadcast from `dropNextFrom`
 * (part b's lost delete).
 */
function shadowHub(hub: DummyHub) {
  const state = {
    counting: false,
    deliveries: 0,
    census: newCensus(),
    dropNextFrom: null as DummyTransport | null,
    dropped: newCensus(),
  }
  const original = hub.broadcast.bind(hub)
  ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (
    room: string,
    data: Uint8Array,
    sender: DummyTransport,
    options?: { latency?: number; dropRate?: number; jitter?: number },
  ) => {
    if (state.dropNextFrom === sender) {
      state.dropNextFrom = null
      if (data.length >= 5) classifyOne(data.subarray(4), state.dropped, 1)
      return
    }
    if (state.counting) {
      const recipients = Math.max(0, hub.getRoomSize(room) - 1)
      state.deliveries += recipients
      if (data.length >= 5) classifyOne(data.subarray(4), state.census, recipients)
    }
    return original(room, data, sender, options)
  }
  return state
}

function makeProvider(hub: DummyHub, doc: Y.Doc, id: number | string): GenericProvider {
  const transport = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
  const provider = new GenericProvider(doc, transport, {
    batchUpdates: 0,
    verifyUpdates: true,
    syncInterval: SYNC_INTERVAL_MS,
    disableBc: true,
  })
  provider.awareness.setLocalStateField('user', { id })
  return provider
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(5)
  }
  return pred()
}

async function runCensus(N: number): Promise<void> {
  await silenced(async () => {
    const room = `bench-idle-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const shadow = shadowHub(hub)
    const docs: Y.Doc[] = []
    const providers: GenericProvider[] = []
    for (let i = 0; i < N; i++) {
      const doc = new Y.Doc()
      docs.push(doc)
      providers.push(makeProvider(hub, doc, i))
    }
    await Promise.all(providers.map((p) => p.connect({ room })))
    docs[0].getText('t').insert(0, 'hello')
    const converged = await waitUntil(
      () =>
        docs.every((d) => d.getText('t').toString() === 'hello') &&
        providers.every((p) => p.synced),
      15000,
    )
    await sleep(SETTLE_MS)

    shadow.counting = true
    await sleep(OBSERVE_MS)
    shadow.counting = false

    for (const p of providers) p.destroy()
    hub.clear()

    const secs = OBSERVE_MS / 1000
    const requestFloor = (N * (N - 1) * OBSERVE_MS) / SYNC_INTERVAL_MS
    const awarenessFloor = (N * (N - 1) * OBSERVE_MS) / 15000
    console.log(
      `CENSUS N=${N} converged=${converged} deliveries=${shadow.deliveries} ` +
        `perSec=${(shadow.deliveries / secs).toFixed(0)} perSecPerPeer=${(shadow.deliveries / secs / N).toFixed(1)} ` +
        `requestFloor=${requestFloor.toFixed(0)} awarenessFloor=${awarenessFloor.toFixed(0)}`,
    )
    for (const k of CLASSES) {
      const c = shadow.census[k]
      console.log(
        `   ${k.padEnd(10)} ${String(c.count).padStart(8)} deliveries ${(c.bytes / 1024).toFixed(1).padStart(8)} KB`,
      )
    }
  })
}

/** Capture provider warnings (silenced() would swallow them) to see WHY a heal happened. */
async function withWarnTally<T>(
  fn: (warns: Record<string, number>) => Promise<T>,
): Promise<{ result: T; warns: Record<string, number> }> {
  const warns: Record<string, number> = {}
  const origWarn = console.warn
  const origError = console.error
  console.warn = (...args: unknown[]) => {
    const text = String(args[0] ?? '')
    const key = /Hash mismatch/.test(text)
      ? 'hashMismatch'
      : /Resync scheduled/.test(text)
        ? 'resyncScheduled'
        : /Sequence gap/.test(text)
          ? 'gapConfirmed'
          : /rate limit/.test(text)
            ? 'rateLimited'
            : /Corrupted/.test(text)
              ? 'corrupted'
              : 'otherWarn'
    warns[key] = (warns[key] ?? 0) + 1
  }
  console.error = () => {}
  try {
    return { result: await fn(warns), warns }
  } finally {
    console.warn = origWarn
    console.error = origError
  }
}

async function runLostDelete(sample: number): Promise<boolean> {
  const { result } = await withWarnTally(async (warns) => {
    const room = `bench-lostdel-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const shadow = shadowHub(hub)
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = makeProvider(hub, docA, 'A')
    const b = makeProvider(hub, docB, 'B')
    await a.connect({ room })
    await b.connect({ room })

    docA.getText('t').insert(0, 'hello world')
    const synced = await waitUntil(
      () => docB.getText('t').toString() === 'hello world',
      5000,
    )
    // Let the join settle: the joiner's full-state push carries a hash of
    // ITS state, so a peer holding more data reads a mismatch and schedules
    // a resync ~100ms later (see the design doc's Results for this
    // pre-existing artifact). Wait it out so the heal window below is
    // attributable to the lost delete alone. Then a random phase: the
    // periodic tick's phase relative to the drop is arbitrary anyway, so
    // heal latency is spread over roughly one interval - hence samples.
    await sleep(600 + Math.random() * SYNC_INTERVAL_MS)
    const warnsAtDrop = { ...warns }

    // Drop A's very next broadcast - with batchUpdates=0 the delete below
    // is sent synchronously from inside the doc 'update' event, so no
    // timer (beacon, awareness) can interleave between these two lines.
    shadow.dropNextFrom = a.transport as DummyTransport
    docA.getText('t').delete(0, 6)
    const dropped = shadow.dropNextFrom === null

    shadow.counting = true
    const start = Date.now()
    const converged = await waitUntil(
      () => docB.getText('t').toString() === docA.getText('t').toString(),
      LOST_DELETE_CAP_MS,
    )
    const ms = Date.now() - start
    shadow.counting = false

    const summary = (c: Census) =>
      CLASSES.filter((k) => c[k].count > 0)
        .map((k) => `${k}=${c[k].count}`)
        .join(',') || 'none'
    const healWarns = Object.entries(warns)
      .map(([k, v]) => [k, v - (warnsAtDrop[k] ?? 0)] as const)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(',') || 'none'
    const setupWarns = Object.entries(warnsAtDrop)
      .map(([k, v]) => `${k}=${v}`)
      .join(',') || 'none'
    const line =
      `LOSTDELETE sample=${sample} setup=${synced} dropped=${dropped} converged=${converged} ms=${ms} ` +
      `droppedClass=${summary(shadow.dropped)} healDeliveries=${shadow.deliveries} (${summary(shadow.census)}) ` +
      `healWarns=${healWarns} setupWarns=${setupWarns} ` +
      `A=${JSON.stringify(docA.getText('t').toString())} B=${JSON.stringify(docB.getText('t').toString())}`

    a.destroy()
    b.destroy()
    hub.clear()
    return { ok: synced && dropped && converged, line }
  })
  console.log(result.line)
  return result.ok
}

async function main() {

  console.log(
    `(a) idle census: syncInterval=${SYNC_INTERVAL_MS}ms latency=${LATENCY}ms±${JITTER * 100}% settle=${SETTLE_MS}ms observe=${OBSERVE_MS}ms\n`,
  )
  if (!process.env.SKIP_CENSUS) for (const N of N_VALUES) await runCensus(N)
  console.log(`\n(b) lost delete-only update, 2 peers, ${LOST_DELETE_SAMPLES} samples (cap ${LOST_DELETE_CAP_MS}ms):\n`)
  let allOk = true
  for (let i = 1; i <= LOST_DELETE_SAMPLES; i++) {
    if (!(await runLostDelete(i))) allOk = false
  }
  console.log(allOk ? '\nLOSTDELETE RESULT: PASS (all samples converged)' : '\nLOSTDELETE RESULT: FAIL')
  process.exit(allOk ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
