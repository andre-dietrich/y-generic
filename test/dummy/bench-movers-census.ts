/**
 * Benchmark: what does cursor-only movement (no typing) cost on the wire,
 * and what does a stationary observer see the movement lag by - the two
 * sides of the round-6, item-9 tradeoff (`awarenessInterval: 'auto'`).
 *
 * M movers set a changing cursor position at MOVE_HZ for DURATION_MS in an
 * N-peer room (one stationary observer, the rest idle bystanders filling
 * the room to size N - round-5 research doc's own example: "10 movers at
 * 10Hz in a 50-peer room"). Cursor payloads carry a send timestamp; the
 * observer's awareness `'change'` handler (item 8: only real changes fire
 * it) records arrival-time minus that timestamp as one lag sample. Reports
 * awareness deliveries/s, deliveries/s/peer, and the lag distribution -
 * the cost `awarenessInterval: 'auto'` trades away for fewer messages.
 *
 * AWARENESS_INTERVAL=auto to measure the room-size-adaptive throttle (round
 * 6); a number (default 100, the provider default) for the fixed baseline.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-movers-census.js
 *      N_VALUES=20,50 MOVERS=10 MOVE_HZ=10 DURATION_MS=10000 AWARENESS_INTERVAL=auto override.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'
import { shadowHub, CLASSES } from './bench-idle-room'

const N_VALUES = (process.env.N_VALUES ?? '20,50').split(',').map(Number)
const MOVERS = Number(process.env.MOVERS ?? 10)
const MOVE_HZ = Number(process.env.MOVE_HZ ?? 10)
const DURATION_MS = Number(process.env.DURATION_MS ?? 10000)
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 3000)
const AWARENESS_INTERVAL: number | 'auto' =
  process.env.AWARENESS_INTERVAL === 'auto'
    ? 'auto'
    : Number(process.env.AWARENESS_INTERVAL ?? 100)
const LATENCY = 20
const JITTER = 0.25

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}

async function run(N: number): Promise<void> {
  await silenced(async () => {
    const room = `bench-movers-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const shadow = shadowHub(hub)
    const docs: Y.Doc[] = []
    const providers: GenericProvider[] = []
    for (let i = 0; i < N; i++) {
      const doc = new Y.Doc()
      const transport = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
      const provider = new GenericProvider(doc, transport, {
        batchUpdates: 0,
        verifyUpdates: true,
        syncInterval: 5000,
        disableBc: true,
        awarenessInterval: AWARENESS_INTERVAL,
      })
      docs.push(doc)
      providers.push(provider)
      await provider.connect({ room })
      provider.awareness.setLocalState({ user: { name: 'u' + i, color: '#abc' }, cursor: null })
    }
    await sleep(SETTLE_MS)

    // Index 0: stationary observer. Indices 1..MOVERS: movers. The rest:
    // idle bystanders (already joined above, do nothing further).
    const observer = providers[0]
    const lagSamples: number[] = []
    observer.awareness.on(
      'change',
      ({ added, updated }: { added: number[]; updated: number[] }) => {
        const now = Date.now()
        for (const clientID of [...added, ...updated]) {
          const state = observer.awareness.getStates().get(clientID) as
            | { cursor?: { t?: number } }
            | undefined
          if (state?.cursor?.t !== undefined) lagSamples.push(now - state.cursor.t)
        }
      },
    )

    shadow.counting = true
    const ticks = Math.floor(DURATION_MS / (1000 / MOVE_HZ))
    const gapMs = 1000 / MOVE_HZ
    for (let k = 0; k < ticks; k++) {
      for (let m = 1; m <= Math.min(MOVERS, N - 1); m++) {
        providers[m].awareness.setLocalStateField('cursor', { x: k, y: k, t: Date.now() })
      }
      await sleep(gapMs)
    }
    await sleep(500)
    shadow.counting = false

    const sorted = [...lagSamples].sort((a, b) => a - b)
    const durationS = DURATION_MS / 1000
    console.log(
      `MOVERS N=${N} movers=${Math.min(MOVERS, N - 1)} hz=${MOVE_HZ} interval=${AWARENESS_INTERVAL} duration=${durationS}s: ` +
        `deliveries=${shadow.deliveries} (${(shadow.deliveries / durationS).toFixed(0)}/s, ${(shadow.deliveries / durationS / N).toFixed(1)}/s/peer) ` +
        `sends=${shadow.sends} lagSamples=${lagSamples.length}`,
    )
    if (sorted.length > 0) {
      console.log(
        `   lag(ms) min=${sorted[0]} p50=${percentile(sorted, 0.5)} p95=${percentile(sorted, 0.95)} max=${sorted[sorted.length - 1]}`,
      )
    }
    for (const c of CLASSES) {
      const cls = shadow.census[c]
      if (cls.count > 0) {
        console.log(
          `   ${c.padEnd(10)} ${String(cls.count).padStart(8)} deliveries ${(cls.bytes / 1024).toFixed(1).padStart(8)} KB`,
        )
      }
    }
    for (const p of providers) p.destroy()
    hub.clear()
  })
}

async function main() {
  console.log(
    `movers census: latency=${LATENCY}ms±${JITTER * 100}% movers=${MOVERS} hz=${MOVE_HZ} duration=${DURATION_MS}ms settle=${SETTLE_MS}ms awarenessInterval=${AWARENESS_INTERVAL}\n`,
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
