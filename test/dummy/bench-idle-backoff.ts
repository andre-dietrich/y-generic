/**
 * Benchmark for the `idleBackoffEnabled` option (src/index.ts): does backing
 * off connect()'s periodic-sync interval during idle stretches actually cut
 * message volume, and what does that cost in loss-recovery latency?
 *
 * Two parts, both run for `idleBackoffEnabled: false` (baseline/regression
 * gate - MUST look unchanged from before this option existed) and `true`
 * (the opt-in behavior):
 *
 * (a) Message-count-while-idle: two already-synced peers, no edits, no
 *     awareness churn, for a fixed wall-clock observation window. Messages
 *     are bucketed into `SYNC_INTERVAL_MS`-sized windows so the OFF variant
 *     should print a flat/steady per-bucket count (no backoff = same tick
 *     cadence as before this feature existed) while the ON variant's
 *     buckets should visibly thin out as the interval doubles.
 *
 * (b) Recovery latency: same two peers, but after several idle ticks have
 *     already elapsed (so ON's interval has had a chance to back off), ONE
 *     update from A is silently dropped en route to B (via a drop switch on
 *     B's transport, mirroring bench-reconnect-cycling.ts's withDropSwitch),
 *     and then BOTH peers go quiet again - no further edits, so B's own
 *     sequence-gap detection never fires (it only fires when a LATER
 *     message reveals the gap; here there isn't one - this is deliberately
 *     the "last message before the room goes idle" case, the one periodic
 *     sync exists to cover as a backstop). Recovery can only come from B's
 *     own next periodic SyncStep1 pull. We measure wall-clock time from the
 *     drop until B's document actually contains A's edit.
 *
 * This directly exercises the tradeoff idleBackoffEnabled's doc comment
 * warns about: ON should show materially higher recovery latency than OFF
 * in exchange for the part (a) message-count reduction. Report both numbers
 * honestly - this bench exists specifically to surface that tradeoff, not
 * to make the feature look free.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-idle-backoff.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced, instrumentHub } from './bench-user-scaling'

const SYNC_INTERVAL_MS = 300
const IDLE_BACKOFF_MAX_MS = 2400 // 300 -> 600 -> 1200 -> 2400 (capped) in 4 idle ticks
const LATENCY = 10
const JITTER = 0.1
const SETTLE_MS = LATENCY * 3 + 150

// The default sync rate limiter (maxSyncRequestsPerWindow: 20 per
// syncRequestWindowMs: 10000ms) is tuned around the DEFAULT syncInterval
// (5000ms - 2 periodic ticks/10s, well under the cap). This bench
// deliberately uses a much shorter SYNC_INTERVAL_MS so several periods are
// observable in a reasonable test duration (same reason bench-periodic-jitter.ts
// does) - at 300ms/tick that's up to ~33 ticks/10s for the OFF variant,
// which would repeatedly collide with the default rate limiter and throttle
// periodic ticks itself, confounding the idle-backoff measurement with an
// unrelated rate-limiter effect (confirmed empirically: an earlier run of
// this bench without this override showed OFF's recovery latency ballooning
// to ~5s - almost exactly the rate limiter's window - while ON, sending far
// fewer requests, sailed under the cap and recovered faster than the
// "unbacked-off" baseline, which is obviously not the real effect being
// measured). Raised generously here so the rate limiter is a non-factor and
// this bench isolates idle-backoff behavior specifically.
const MAX_SYNC_REQUESTS_PER_WINDOW = 100_000

// --- Part (a): message count while idle ------------------------------

const OBSERVE_MS = 9000 // enough for ~30 base ticks (OFF) vs ~5 backed-off ticks (ON)

async function runIdleMessageCount(
  enabled: boolean,
): Promise<{ total: number; buckets: number[] }> {
  return silenced(async () => {
    const room = `bench-idle-count-${enabled}-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()

    const docA = new Y.Doc()
    const transportA = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
    const providerA = new GenericProvider(docA, transportA, {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: SYNC_INTERVAL_MS,
      idleBackoffEnabled: enabled,
      idleBackoffMaxMs: IDLE_BACKOFF_MAX_MS,
      maxSyncRequestsPerWindow: MAX_SYNC_REQUESTS_PER_WINDOW,
    })
    providerA.awareness.setLocalStateField('user', { id: 'a' })

    const docB = new Y.Doc()
    const transportB = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
    const providerB = new GenericProvider(docB, transportB, {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: SYNC_INTERVAL_MS,
      idleBackoffEnabled: enabled,
      idleBackoffMaxMs: IDLE_BACKOFF_MAX_MS,
      maxSyncRequestsPerWindow: MAX_SYNC_REQUESTS_PER_WINDOW,
    })
    providerB.awareness.setLocalStateField('user', { id: 'b' })

    await Promise.all([
      providerA.connect({ room }),
      providerB.connect({ room }),
    ])
    await sleep(SETTLE_MS)

    // Only count what happens during the idle observation window.
    const stats = instrumentHub(hub)
    const bucketMs = SYNC_INTERVAL_MS
    const bucketCount = Math.ceil(OBSERVE_MS / bucketMs)
    const buckets = new Array(bucketCount).fill(0)
    const windowStart = Date.now()

    // Re-instrument with per-call timestamps so we can bucket, while still
    // reusing instrumentHub's recipient-counting logic for the total.
    const original = hub.broadcast.bind(hub)
    ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (
      r: string,
      data: Uint8Array,
      sender: DummyTransport,
      options?: { latency?: number; dropRate?: number; jitter?: number },
    ) => {
      const recipients = Math.max(0, hub.getRoomSize(r) - 1)
      const bucket = Math.min(
        bucketCount - 1,
        Math.floor((Date.now() - windowStart) / bucketMs),
      )
      buckets[bucket] += recipients
      return original(r, data, sender, options)
    }

    await sleep(OBSERVE_MS)

    providerA.destroy()
    providerB.destroy()

    return { total: buckets.reduce((a, b) => a + b, 0), buckets }
  })
}

// --- Part (b): recovery latency after a message dropped just before idle -

const IDLE_BEFORE_DROP_MS = 5000 // let backoff ramp up before we inject the loss
const POLL_MS = 20
const MAX_WAIT_MS = IDLE_BACKOFF_MAX_MS * 3

/** Same drop-switch pattern as bench-reconnect-cycling.ts's withDropSwitch. */
function withDropSwitch(transport: DummyTransport): {
  setDropNext: (v: boolean) => void
} {
  let dropNext = false
  const originalOnMessage = transport.onMessage.bind(transport)
  transport.onMessage = (callback: (data: Uint8Array) => void) => {
    return originalOnMessage((data: Uint8Array) => {
      if (dropNext) {
        dropNext = false
        return // drop it
      }
      callback(data)
    })
  }
  return {
    setDropNext: (v: boolean) => {
      dropNext = v
    },
  }
}

async function runRecoveryLatency(enabled: boolean): Promise<number> {
  return silenced(async () => {
    const room = `bench-idle-recovery-${enabled}-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()

    const docA = new Y.Doc()
    const transportA = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
    const providerA = new GenericProvider(docA, transportA, {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: SYNC_INTERVAL_MS,
      idleBackoffEnabled: enabled,
      idleBackoffMaxMs: IDLE_BACKOFF_MAX_MS,
      maxSyncRequestsPerWindow: MAX_SYNC_REQUESTS_PER_WINDOW,
    })
    providerA.awareness.setLocalStateField('user', { id: 'a' })

    const docB = new Y.Doc()
    const transportB = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
    // Drop switch must be installed before connect() - a joining transport
    // can receive messages inside connect() itself (see commit b02208f).
    const dropSwitch = withDropSwitch(transportB)
    const providerB = new GenericProvider(docB, transportB, {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: SYNC_INTERVAL_MS,
      idleBackoffEnabled: enabled,
      idleBackoffMaxMs: IDLE_BACKOFF_MAX_MS,
      maxSyncRequestsPerWindow: MAX_SYNC_REQUESTS_PER_WINDOW,
    })
    providerB.awareness.setLocalStateField('user', { id: 'b' })

    await Promise.all([
      providerA.connect({ room }),
      providerB.connect({ room }),
    ])
    await sleep(SETTLE_MS)

    // Let several idle ticks elapse first, so ON's interval has ramped up
    // by the time the loss happens - "partway through an idle-backoff
    // period", not at the very first tick.
    await sleep(IDLE_BEFORE_DROP_MS)

    const textA = docA.getText('content')
    dropSwitch.setDropNext(true)
    const dropTime = Date.now()
    docA.transact(() => textA.insert(0, 'x')) // this update to B is dropped

    // Both peers now go fully quiet - no further edits from either side -
    // so B's sequence-gap detection never gets a later message to reveal
    // the gap. Only B's own next periodic SyncStep1 pull can recover this.
    const textB = docB.getText('content')
    let recoveredAt = -1
    const deadline = dropTime + MAX_WAIT_MS
    while (Date.now() < deadline) {
      if (textB.toString() === 'x') {
        recoveredAt = Date.now()
        break
      }
      await sleep(POLL_MS)
    }

    providerA.destroy()
    providerB.destroy()

    if (recoveredAt < 0) {
      console.warn(
        `  [enabled=${enabled}] did NOT recover within ${MAX_WAIT_MS}ms!`,
      )
      return MAX_WAIT_MS
    }
    return recoveredAt - dropTime
  })
}

async function main() {
  console.log(
    `Idle-backoff benchmark (syncInterval=${SYNC_INTERVAL_MS}ms base, idleBackoffMaxMs=${IDLE_BACKOFF_MAX_MS}ms)\n`,
  )

  console.log('--- Part (a): message count while idle ---\n')
  for (const enabled of [false, true]) {
    const { total, buckets } = await runIdleMessageCount(enabled)
    console.log(
      `idleBackoffEnabled=${String(enabled).padEnd(5)} total=${String(total).padEnd(5)} per-${SYNC_INTERVAL_MS}ms-bucket: [${buckets.join(', ')}]`,
    )
  }

  console.log(
    '\n--- Part (b): recovery latency for a message dropped just before idle ---\n',
  )
  const TRIALS = 5
  for (const enabled of [false, true]) {
    const latencies: number[] = []
    for (let i = 0; i < TRIALS; i++) {
      latencies.push(await runRecoveryLatency(enabled))
    }
    latencies.sort((a, b) => a - b)
    const median = latencies[Math.floor(latencies.length / 2)]
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length
    console.log(
      `idleBackoffEnabled=${String(enabled).padEnd(5)} trials=[${latencies.join(', ')}]ms  median=${median}ms  avg=${avg.toFixed(0)}ms`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
