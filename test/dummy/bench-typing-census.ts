/**
 * Benchmark: what does one keystroke cost on the wire, per message class?
 *
 * T typists in an N-peer room, one keystroke every GAP_MS for DURATION_MS.
 * A keystroke is what an editor binding produces: a text insert (one Yjs
 * update) and a cursor awareness update (y-quill, y-codemirror.next and
 * y-prosemirror all dedupe the cursor by relative position, and a keystroke
 * moves it - so every keystroke sets it). Deliveries are counted per
 * recipient via the shadowed DummyHub of bench-idle-room.ts; "sends per
 * keystroke" is the transport-level message count (a MESSAGE_BATCH is one
 * send), which is what count-limited backends (Matrix rc_message, Supabase
 * msg/s) bill.
 *
 * Two regimes matter (round-5 research doc, baseline A):
 *   SETTLE_MS=3000 (default): the base cadence - every peer still beacons
 *     at syncInterval, as in the first ~75 s after a join burst.
 *   SETTLE_MS=90000: the steady state - idle backoff has parked the
 *     listeners at the 60 s cap, only the typist beacons at the base
 *     interval (phase 1e), and the 15 s awareness renewals of the listeners
 *     show up as the third message per keystroke.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-typing-census.js
 *      N_VALUES=20,50 TYPISTS=1 GAP_MS=200 DURATION_MS=10000 SETTLE_MS=3000 override.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'
import { shadowHub, CLASSES } from './bench-idle-room'

const N_VALUES = (process.env.N_VALUES ?? '20,50').split(',').map(Number)
const TYPISTS = Number(process.env.TYPISTS ?? 1)
const GAP_MS = Number(process.env.GAP_MS ?? 200)
const DURATION_MS = Number(process.env.DURATION_MS ?? 10000)
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 3000)
// DUMMY_PEER_EVENTS=1: a transport that reports joins and departures (the
// mesh transports, PubNub presence) - the awareness lease then defaults to
// 5 min and the listeners' 15 s renewals leave the steady-state count
// (round 5, item 2).
const PEER_EVENTS = process.env.DUMMY_PEER_EVENTS === '1'
// SAME_CURSOR=1: the typist re-sets the SAME cursor value on every
// keystroke - an app that writes unchanged presence state. Before round 5
// item 8 every such call was a broadcast (y-protocols emits 'update' for
// every setLocalState); now only a changed state is.
const SAME_CURSOR = process.env.SAME_CURSOR === '1'
// AWARENESS_TIMEOUT_MS=<ms>: the presence lease for the peers under test (see bench-idle-room).
const AWARENESS_TIMEOUT_MS = process.env.AWARENESS_TIMEOUT_MS
  ? Number(process.env.AWARENESS_TIMEOUT_MS)
  : undefined
const LATENCY = 20
const JITTER = 0.25

async function run(N: number): Promise<void> {
  await silenced(async () => {
    const room = `bench-typing-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const shadow = shadowHub(hub)
    const docs: Y.Doc[] = []
    const providers: GenericProvider[] = []
    for (let i = 0; i < N; i++) {
      const doc = new Y.Doc()
      const transport = new DummyTransport({
        hub,
        latency: LATENCY,
        jitter: JITTER,
        unicast: process.env.DUMMY_UNICAST === '1',
        simulatePeerConnect: PEER_EVENTS,
      })
      const provider = new GenericProvider(doc, transport, {
        batchUpdates: 0,
        verifyUpdates: true,
        syncInterval: 5000,
        disableBc: true,
        awarenessTimeoutMs: AWARENESS_TIMEOUT_MS,
      })
      docs.push(doc)
      providers.push(provider)
      await provider.connect({ room })
      provider.awareness.setLocalState({ user: { name: 'u' + i, color: '#abc' }, cursor: null })
    }
    await sleep(SETTLE_MS)

    shadow.counting = true
    const keystrokes = Math.floor(DURATION_MS / GAP_MS)
    for (let k = 0; k < keystrokes; k++) {
      for (let t = 0; t < TYPISTS; t++) {
        const text = docs[t].getText('t')
        text.insert(text.length, 'a')
        providers[t].awareness.setLocalStateField(
          'cursor',
          SAME_CURSOR ? { anchor: 0, head: 0 } : { anchor: text.length, head: text.length },
        )
      }
      await sleep(GAP_MS)
    }
    await sleep(500)
    shadow.counting = false

    const total = keystrokes * TYPISTS
    const converged = docs.every((d) => d.getText('t').length === keystrokes * TYPISTS)
    console.log(
      `TYPING N=${N} typists=${TYPISTS} gap=${GAP_MS}ms settle=${SETTLE_MS / 1000}s keystrokes=${total} converged=${converged}: ` +
        `deliveries=${shadow.deliveries} (${(shadow.deliveries / total).toFixed(1)} per keystroke, N-1=${N - 1}) ` +
        `sends=${shadow.sends} (${(shadow.sends / total).toFixed(2)} per keystroke)`,
    )
    for (const k of CLASSES) {
      const c = shadow.census[k]
      if (c.count > 0) {
        console.log(
          `   ${k.padEnd(10)} ${String(c.count).padStart(8)} deliveries ${(c.bytes / 1024).toFixed(1).padStart(8)} KB`,
        )
      }
    }
    for (const p of providers) p.destroy()
    hub.clear()
  })
}

async function main() {
  console.log(
    `typing census: latency=${LATENCY}ms±${JITTER * 100}% typists=${TYPISTS} gap=${GAP_MS}ms duration=${DURATION_MS}ms settle=${SETTLE_MS}ms unicast=${process.env.DUMMY_UNICAST === '1'} peerEvents=${PEER_EVENTS} awarenessTimeout=${AWARENESS_TIMEOUT_MS ?? 'default'}\n`,
  )
  for (const N of N_VALUES) await run(N)
  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
