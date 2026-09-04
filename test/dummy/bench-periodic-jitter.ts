/**
 * Benchmark: does jittering connect()'s periodic-sync interval
 * (`GenericProvider.prototype._jitteredSyncInterval`, +/-20% per tick)
 * spread a room's periodic traffic out over time instead of leaving it
 * bunched into synchronized bursts?
 *
 * By design this does NOT reduce total message count - jitter only changes
 * *when* each peer's periodic tick fires, not how many it fires. The metric
 * that matters here is PEAK concurrent messages (messages landing in the
 * same short time bucket), not the total.
 *
 * Scenario: M peers connect() to a room within a tight window (Promise.all,
 * simulating "everyone joins near session start"), settle past the
 * connect()-time sync/awareness burst, then several `syncInterval` periods
 * elapse with no other activity (no edits, no awareness changes, no new
 * joiners) so every message observed during that window is attributable to
 * the periodic-sync tick. `syncInterval` is set short (300-500ms) so
 * several periods are observable within a few seconds of wall-clock time.
 * Messages are bucketed into 25ms windows across the observation period;
 * the peak bucket count is the headline number.
 *
 * Compares two variants in the same process:
 *   - 'unjittered': `_jitteredSyncInterval` shadowed to return
 *     `_syncInterval` unmodified - reproduces the pre-fix plain-setInterval
 *     behavior, where every peer's periodic timer starts at its own
 *     connect() call time with no per-tick randomization, so peers that
 *     connect() close together in time stay closely aligned tick after
 *     tick.
 *   - 'jittered': the real (post-fix) `_jitteredSyncInterval`, re-jittered
 *     freshly every tick.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-periodic-jitter.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const PEER_COUNTS = [10, 30]
const SYNC_INTERVAL_MS = 400
const PERIODS_TO_OBSERVE = 6
const LATENCY = 10
const JITTER = 0.1
const BUCKET_MS = 25

interface TimedEvent {
  t: number
  recipients: number
}

/** Same accounting as bench-user-scaling.ts's instrumentHub, but keeps a
 * per-broadcast-call timestamp instead of only a running total, so traffic
 * can be bucketed by time afterwards. */
function instrumentHubTimestamped(hub: DummyHub): TimedEvent[] {
  const events: TimedEvent[] = []
  const original = hub.broadcast.bind(hub)
  ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (
    room: string,
    data: Uint8Array,
    sender: DummyTransport,
    options?: { latency?: number; dropRate?: number; jitter?: number },
  ) => {
    const recipients = Math.max(0, hub.getRoomSize(room) - 1)
    events.push({ t: Date.now(), recipients })
    return original(room, data, sender, options)
  }
  return events
}

function peakBucket(events: TimedEvent[], windowStart: number): number {
  const buckets = new Map<number, number>()
  for (const e of events) {
    const bucket = Math.floor((e.t - windowStart) / BUCKET_MS)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + e.recipients)
  }
  let peak = 0
  for (const count of buckets.values()) peak = Math.max(peak, count)
  return peak
}

function totalCount(events: TimedEvent[]): number {
  return events.reduce((sum, e) => sum + e.recipients, 0)
}

async function runVariant(
  N: number,
  variant: 'unjittered' | 'jittered',
): Promise<{ peak: number; total: number }> {
  return silenced(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = GenericProvider.prototype as any
    const original = proto._jitteredSyncInterval
    if (variant === 'unjittered') {
      proto._jitteredSyncInterval = function (this: GenericProvider) {
        // @ts-expect-error accessing private field for benchmark shadowing
        return this._syncInterval
      }
    }

    try {
      const room = `bench-jitter-${variant}-${Math.random().toString(36).slice(2)}`
      const hub = new DummyHub()
      const events = instrumentHubTimestamped(hub)

      const docs: Y.Doc[] = []
      const providers: GenericProvider[] = []
      for (let i = 0; i < N; i++) {
        const doc = new Y.Doc()
        const transport = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
        const provider = new GenericProvider(doc, transport, {
          batchUpdates: 0,
          verifyUpdates: true,
          syncInterval: SYNC_INTERVAL_MS,
        })
        provider.awareness.setLocalStateField('user', { id: i })
        docs.push(doc)
        providers.push(provider)
      }

      // All peers connect() within a tight window - the scenario this item
      // targets (everyone joining near session start).
      await Promise.all(providers.map((p) => p.connect({ room })))

      // Let the connect()-time sync/awareness burst and initial settling
      // fully drain before starting the observation window, so it doesn't
      // pollute the periodic-tick-only measurement.
      await sleep(LATENCY * 3 + 150)

      const windowStart = Date.now()
      events.length = 0 // reset - only count what happens during observation

      await sleep(SYNC_INTERVAL_MS * PERIODS_TO_OBSERVE)

      const peak = peakBucket(events, windowStart)
      const total = totalCount(events)

      for (const p of providers) p.destroy()

      return { peak, total }
    } finally {
      proto._jitteredSyncInterval = original
    }
  })
}

async function main() {
  console.log(
    `Periodic-sync jitter burst-smoothing benchmark (syncInterval=${SYNC_INTERVAL_MS}ms, ${PERIODS_TO_OBSERVE} periods observed, ${BUCKET_MS}ms buckets)\n`,
  )
  console.log(
    'N'.padEnd(6) +
      'variant'.padEnd(14) +
      'peak/bucket'.padEnd(14) +
      'total'.padEnd(10),
  )

  for (const N of PEER_COUNTS) {
    const unjittered = await runVariant(N, 'unjittered')
    const jittered = await runVariant(N, 'jittered')

    console.log(
      String(N).padEnd(6) +
        'unjittered'.padEnd(14) +
        String(unjittered.peak).padEnd(14) +
        String(unjittered.total).padEnd(10),
    )
    console.log(
      String(N).padEnd(6) +
        'jittered'.padEnd(14) +
        String(jittered.peak).padEnd(14) +
        String(jittered.total).padEnd(10),
    )
    const reduction = (1 - jittered.peak / unjittered.peak) * 100
    console.log(
      `  -> peak bucket ${reduction >= 0 ? 'reduced' : 'increased'} by ${Math.abs(reduction).toFixed(1)}%, total changed by ${(
        ((jittered.total - unjittered.total) / unjittered.total) *
        100
      ).toFixed(1)}%\n`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
