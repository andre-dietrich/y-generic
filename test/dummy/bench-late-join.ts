/**
 * Benchmark: when M peers are already fully synced/settled and K more peers
 * join shortly after, how much sync traffic (and how many resync-trigger
 * warnings) does that late join generate for the *whole* room?
 *
 * This is a *timing* asymmetry, distinct from every existing "many peers"
 * scenario in this repo:
 * - `bench-user-scaling.ts`'s join-burst connects all N peers concurrently
 *   from a cold room (nobody pre-synced).
 * - `bench-asymmetric-join.ts` is asymmetric in *data* (one peer pre-loaded
 *   with content) but still has every peer connect in the same
 *   `Promise.all` burst.
 *
 * Neither models "some peers already reached steady state, then a batch of
 * new peers arrives quickly" - the scenario behind the "too many resyncs
 * when I add peers quickly to an already-synced room" complaint this script
 * exists to measure.
 *
 * Only 2 of the 4 existing latency profiles are used (WebSocket-like and
 * Matrix - see bench-packet-loss.ts's header for the same rationale) to
 * keep the (profile x (M,K) x dropRate x samples) sweep tractable.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-late-join.js
 */

import { DummyHub } from '../../src/providers/dummy/index'
import {
  PROFILES,
  sleep,
  makeProviders,
  instrumentHub,
  type Profile,
} from './bench-user-scaling'

// Periodic beacon interval for the peers under test (see bench-packet-loss
// for the reasoning, same finding in phase 1b: with syncInterval 0 a lost
// LAST keystroke has, by design, nothing to recover it, and the pre-phase-1b
// builds only recovered it through the resync storms other losses triggered;
// the 3 % cells of this bench timed out in 1 of 9 samples on the final build
// before this change). Override: SYNC_INTERVAL_MS.
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 2000)
const TEST_PROFILES: Profile[] = PROFILES.filter(
  (p) => p.name.startsWith('WebSocket') || p.name.startsWith('Matrix'),
)
const MK_PAIRS: Array<{ M: number; K: number }> = [
  { M: 10, K: 5 },
  { M: 20, K: 10 },
  { M: 40, K: 10 },
  { M: 45, K: 5 },
]
const DROP_RATES = [0, 0.03]
const SAMPLES = 3
const CONVERGENCE_TIMEOUT_MS = 30000
// Gap between "M peers settled" and "K peers start connecting" - short,
// simulating peers being added in quick succession rather than a slow trickle.
const LATE_JOIN_DELAY_MS = 200
const EDIT_COUNT = 10

interface WarnCounts {
  hashMismatch: number
  rateLimited: number
  gapConfirmed: number
  corrupted: number
}

function newWarnCounts(): WarnCounts {
  return { hashMismatch: 0, rateLimited: 0, gapConfirmed: 0, corrupted: 0 }
}

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

async function runOnce(
  M: number,
  K: number,
  profile: Profile,
  dropRate: number,
): Promise<RunResult> {
  const { result, warns } = await withWarnCounts(async () => {
    const room = `bench-latejoin-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const stats = instrumentHub(hub)
    const { providers } = makeProviders(hub, profile, M + K, dropRate, SYNC_INTERVAL_MS)

    const settled = providers.slice(0, M)
    const late = providers.slice(M)

    // Phase 1: M peers connect and fully settle - not measured.
    await Promise.all(settled.map((p) => p.connect({ room })))
    const settleTimeoutAt = Date.now() + CONVERGENCE_TIMEOUT_MS
    while (Date.now() < settleTimeoutAt && settled.some((p) => !p.synced)) {
      await sleep(10)
    }
    await sleep(profile.latency * 2 + 100)

    // Reset counters - only count traffic caused by the K late joiners.
    const preExisting = { messages: stats.messages, bytes: stats.bytes }
    await sleep(LATE_JOIN_DELAY_MS)

    const start = Date.now()
    await Promise.all(late.map((p) => p.connect({ room })))

    const timeoutAt = Date.now() + CONVERGENCE_TIMEOUT_MS
    let converged = false
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
      messages: stats.messages - preExisting.messages,
      bytes: stats.bytes - preExisting.bytes,
    }

    for (const p of providers) p.destroy()
    hub.clear()

    return out
  })

  return { ...result, warns }
}

/**
 * Same staggered-join shape as runOnce(), but one of the already-settled
 * peers performs an edit burst at the exact moment the K late peers start
 * connecting - the scenario a plain idle late-join doesn't capture: real
 * apps keep editing while new collaborators join. This is where a
 * newly-joining peer's incremental catch-up can race an in-flight edit and
 * produce a genuine (not just reordering-suspected) hash mismatch, which is
 * the mechanism the MESSAGE_SYNC_VERIFIED reply-suppression gap (fixed in
 * src/index.ts) turns into a reply storm.
 */
async function runWithConcurrentEdit(
  M: number,
  K: number,
  profile: Profile,
  dropRate: number,
): Promise<RunResult> {
  const { result, warns } = await withWarnCounts(async () => {
    const room = `bench-latejoin-edit-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const stats = instrumentHub(hub)
    const { docs, providers } = makeProviders(hub, profile, M + K, dropRate, SYNC_INTERVAL_MS)

    const settledProviders = providers.slice(0, M)
    const lateProviders = providers.slice(M)

    // Phase 1: M peers connect and fully settle - not measured.
    await Promise.all(settledProviders.map((p) => p.connect({ room })))
    const settleTimeoutAt = Date.now() + CONVERGENCE_TIMEOUT_MS
    while (
      Date.now() < settleTimeoutAt &&
      settledProviders.some((p) => !p.synced)
    ) {
      await sleep(10)
    }
    await sleep(profile.latency * 2 + 100)

    const preExisting = { messages: stats.messages, bytes: stats.bytes }
    await sleep(LATE_JOIN_DELAY_MS)

    const start = Date.now()
    const textA = docs[0].getText('content')

    // Fire the late joins and the edit burst concurrently - neither awaits
    // the other, modeling "new peers arrive while someone is mid-edit".
    const connectPromise = Promise.all(
      lateProviders.map((p) => p.connect({ room })),
    )
    for (let i = 0; i < EDIT_COUNT; i++) {
      docs[0].transact(() => {
        textA.insert(textA.length, 'a')
      })
    }
    await connectPromise

    const target = textA.toString()
    const timeoutAt = Date.now() + CONVERGENCE_TIMEOUT_MS
    let converged = false
    while (Date.now() < timeoutAt) {
      if (
        providers.every((p) => p.synced) &&
        docs.every((d) => d.getText('content').toString() === target)
      ) {
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
      messages: stats.messages - preExisting.messages,
      bytes: stats.bytes - preExisting.bytes,
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
  runFn: (M: number, K: number, profile: Profile, dropRate: number) => Promise<RunResult>,
): Promise<boolean> {
  console.log(`\n=== ${label} ===`)
  let anyCollapse = false

  for (const profile of TEST_PROFILES) {
    console.log(`\n-- Profile: ${profile.name} (latency=${profile.latency}ms, jitter=${profile.jitter}) --`)
    console.log(
      'dropRate |  M |  K | converged | msgs(mean/min/max) |  ms(mean) | mismatch | rateLimited | gapConfirmed',
    )
    for (const dropRate of DROP_RATES) {
      for (const { M, K } of MK_PAIRS) {
        const samples: RunResult[] = []
        for (let i = 0; i < SAMPLES; i++) {
          samples.push(await runFn(M, K, profile, dropRate))
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
            `${String(M).padStart(2)} | ` +
            `${String(K).padStart(2)} | ` +
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
    `Sweeping (M, K) pairs x dropRate. M peers settle first, then K peers ` +
      `join ${LATE_JOIN_DELAY_MS}ms later. "collapse" = at least one sample ` +
      `failed to fully converge within ${CONVERGENCE_TIMEOUT_MS}ms.`,
  )

  const idleCollapsed = await runScenario('Idle late join (no concurrent edits)', runOnce)
  const editCollapsed = await runScenario(
    'Late join concurrent with an edit burst on a settled peer',
    runWithConcurrentEdit,
  )

  if (idleCollapsed || editCollapsed) {
    console.log(
      '\nRESULT: at least one (dropRate, M, K) combination failed to fully ' +
        'converge within the timeout - see rows above with converged < SAMPLES.',
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
