/**
 * Benchmark: does GenericProvider's sync protocol survive nonzero simulated
 * packet loss (`DummyTransport`'s `dropRate`) gracefully, or does it "go to
 * its knees" (the failure mode this script exists to reproduce) as loss and
 * peer count both grow?
 *
 * `dropRate` has existed in `DummyHub`/`DummyTransport` since the
 * beginning (`src/providers/dummy/index.ts`, per-recipient/per-message coin
 * flip - see that file's `broadcast()`), but grep across every existing
 * benchmark (`bench-user-scaling.ts`, `bench-sync-latency.ts`,
 * `bench-asymmetric-join.ts`) shows it is never set above 0 anywhere - this
 * script closes that gap.
 *
 * Two workload shapes (reusing `bench-user-scaling.ts`'s shapes and
 * infrastructure, with `dropRate` threaded through and a generous 30s
 * convergence timeout since loss can genuinely slow recovery, not just
 * indicate a bug):
 * - Fan-out: N already-connected/synced clients; one performs an edit
 *   burst; measure messages/bytes/time until all N converge, or timeout.
 * - Join-burst: N clients connect concurrently under loss; measure
 *   messages/bytes/time until all reach `synced`, or timeout.
 *
 * Only 2 of the 4 existing latency profiles are used (WebSocket-like, the
 * most common real-world push transport, and Matrix, the slowest/worst
 * case) - crossing all 4 profiles x 5 drop rates x 4 N x 2 shapes x
 * multiple samples would make this benchmark impractically slow to run
 * without adding meaningfully different signal (Gun/WebRTC sit between
 * these two extremes on latency, which is the dimension that interacts
 * with loss-recovery timing).
 *
 * "Messages" here counts broadcast *attempts* (same convention as
 * `bench-user-scaling.ts`'s `instrumentHub`), not confirmed deliveries -
 * this is what reveals protocol chattiness/resync storms, independent of
 * whether any given attempt was actually dropped.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-packet-loss.js
 */

import { DummyHub } from '../../src/providers/dummy/index'
import {
  PROFILES,
  sleep,
  makeProviders,
  instrumentHub,
  type Profile,
} from './bench-user-scaling'

const TEST_PROFILES: Profile[] = PROFILES.filter(
  (p) => p.name.startsWith('WebSocket') || p.name.startsWith('Matrix'),
)
const DROP_RATES = [0, 0.01, 0.03, 0.05, 0.1]
const N_VALUES = [5, 10, 25, 50]
const SAMPLES = 3
const EDIT_COUNT = 10
const CONVERGENCE_TIMEOUT_MS = 30000

interface WarnCounts {
  hashMismatch: number
  rateLimited: number
  gapConfirmed: number
  corrupted: number
}

function newWarnCounts(): WarnCounts {
  return { hashMismatch: 0, rateLimited: 0, gapConfirmed: 0, corrupted: 0 }
}

/** Like bench-user-scaling.ts's silenced(), but categorizes warnings instead of swallowing them silently. */
async function withWarnCounts<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warns: WarnCounts }> {
  const warns = newWarnCounts()
  const origWarn = console.warn
  const origError = console.error
  console.warn = (...args: unknown[]) => {
    const msg = String(args[0] ?? '')
    if (msg.includes('Hash mismatch #')) warns.hashMismatch++
    else if (msg.includes('Sync rate limit exceeded')) warns.rateLimited++
    else if (msg.includes('Sequence gap confirmed')) warns.gapConfirmed++
    else if (msg.includes('Corrupted message rejected')) warns.corrupted++
  }
  console.error = () => {}
  try {
    const result = await fn()
    return { result, warns }
  } finally {
    console.warn = origWarn
    console.error = origError
  }
}

interface RunResult {
  converged: boolean
  totalMs: number
  messages: number
  bytes: number
  warns: WarnCounts
}

async function runFanOut(
  N: number,
  profile: Profile,
  dropRate: number,
): Promise<RunResult> {
  const { result, warns } = await withWarnCounts(async () => {
    const room = `bench-pl-fanout-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const stats = instrumentHub(hub)
    const { docs, providers } = makeProviders(hub, profile, N, dropRate)

    await Promise.all(providers.map((p) => p.connect({ room })))
    await sleep(profile.latency * 3 + 200)

    const preExisting = { messages: stats.messages, bytes: stats.bytes }

    const textA = docs[0].getText('content')
    const start = Date.now()

    for (let i = 0; i < EDIT_COUNT; i++) {
      docs[0].transact(() => {
        textA.insert(textA.length, 'a')
      })
    }

    const target = textA.toString()
    const timeoutAt = Date.now() + CONVERGENCE_TIMEOUT_MS
    let converged = false
    while (Date.now() < timeoutAt) {
      if (docs.every((d) => d.getText('content').toString() === target)) {
        converged = true
        break
      }
      await sleep(10)
    }

    const totalMs = Date.now() - start
    const out = {
      converged,
      totalMs,
      messages: stats.messages - preExisting.messages,
      bytes: stats.bytes - preExisting.bytes,
    }

    for (const p of providers) p.destroy()
    hub.clear()

    return out
  })

  return { ...result, warns }
}

async function runJoinBurst(
  N: number,
  profile: Profile,
  dropRate: number,
): Promise<RunResult> {
  const { result, warns } = await withWarnCounts(async () => {
    const room = `bench-pl-join-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const stats = instrumentHub(hub)
    const { providers } = makeProviders(hub, profile, N, dropRate)

    const start = Date.now()
    await Promise.all(providers.map((p) => p.connect({ room })))

    const timeoutAt = Date.now() + CONVERGENCE_TIMEOUT_MS
    let converged = N <= 1
    while (Date.now() < timeoutAt) {
      if (providers.every((p) => p.synced)) {
        converged = true
        break
      }
      await sleep(10)
    }
    await sleep(profile.latency * 2 + 100)

    const totalMs = Date.now() - start
    const out = {
      converged,
      totalMs,
      messages: stats.messages,
      bytes: stats.bytes,
    }

    for (const p of providers) p.destroy()
    hub.clear()

    return out
  })

  return { ...result, warns }
}

function mean(xs: number[]): number {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : NaN
}

async function runScenario(
  label: string,
  runOnce: (N: number, profile: Profile, dropRate: number) => Promise<RunResult>,
) {
  console.log(`\n=== ${label} ===`)
  let anyCollapse = false

  for (const profile of TEST_PROFILES) {
    console.log(`\n-- Profile: ${profile.name} (latency=${profile.latency}ms, jitter=${profile.jitter}) --`)
    console.log(
      'dropRate |   N | converged | msgs(mean/min/max) |  ms(mean) | mismatch | rateLimited | gapConfirmed',
    )
    for (const dropRate of DROP_RATES) {
      for (const N of N_VALUES) {
        const samples: RunResult[] = []
        for (let i = 0; i < SAMPLES; i++) {
          samples.push(await runOnce(N, profile, dropRate))
        }
        const converged = samples.filter((s) => s.converged).length
        const msgs = samples.map((s) => s.messages)
        const times = samples.filter((s) => s.converged).map((s) => s.totalMs)
        const mismatch = samples.reduce((a, s) => a + s.warns.hashMismatch, 0)
        const rateLimited = samples.reduce((a, s) => a + s.warns.rateLimited, 0)
        const gapConfirmed = samples.reduce((a, s) => a + s.warns.gapConfirmed, 0)

        if (converged < SAMPLES) anyCollapse = true

        console.log(
          `${String((dropRate * 100).toFixed(0) + '%').padStart(8)} | ` +
            `${String(N).padStart(3)} | ` +
            `${String(`${converged}/${SAMPLES}`).padStart(9)} | ` +
            `${String(`${mean(msgs)}/${Math.min(...msgs)}/${Math.max(...msgs)}`).padStart(19)} | ` +
            `${String(mean(times)).padStart(9)} | ` +
            `${String(mismatch).padStart(8)} | ` +
            `${String(rateLimited).padStart(11)} | ` +
            `${String(gapConfirmed).padStart(12)}`,
        )
      }
    }
  }

  return anyCollapse
}

async function main() {
  console.log(
    'Sweeping dropRate x N. "collapse" = at least one sample failed to ' +
      `converge within ${CONVERGENCE_TIMEOUT_MS}ms.`,
  )

  const fanOutCollapsed = await runScenario('Fan-out under packet loss', runFanOut)
  const joinBurstCollapsed = await runScenario(
    'Join-burst under packet loss',
    runJoinBurst,
  )

  if (fanOutCollapsed || joinBurstCollapsed) {
    console.log(
      '\nRESULT: at least one (dropRate, N) combination failed to converge ' +
        'within the timeout - see rows above with converged < SAMPLES.',
    )
    process.exit(1)
  } else {
    console.log('\nRESULT: all combinations converged within the timeout.')
    process.exit(0)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
