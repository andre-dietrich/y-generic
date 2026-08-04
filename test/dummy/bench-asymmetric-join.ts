/**
 * Correctness check (not a performance benchmark): does the SyncStep2
 * reply-suppression NACK-suppression scheme (Task 3, `_scheduleSyncReply`/
 * `_cancelPendingSyncReply` in `src/index.ts`) ever leave a peer permanently
 * stuck on stale/empty state in a room of N>=3?
 *
 * Why this scenario specifically: `bench-user-scaling.ts`'s existing
 * scenarios (fan-out, join-burst) always start every peer with IDENTICAL
 * (empty) state, so a "vacuous" SyncStep2 reply and a "real" one are
 * indistinguishable there - suppression wrongly picking the vacuous one
 * would be invisible to those scripts. This script makes the two
 * distinguishable: ONE peer is pre-loaded with real text content BEFORE
 * connecting; the rest start empty. If suppression - or the timing race
 * between an empty late-joiner and the pre-loaded peer's connect-time
 * `syncNow()` push - ever causes a peer to settle on the pre-loaded peer's
 * SyncStep2 request being answered by a different (empty) peer instead of
 * the pre-loaded one, that peer would never receive the real content and
 * this script's convergence check fails.
 *
 * See docs/superpowers/specs/2026-07-26-dummy-benchmark-scaling-design.md
 * "Part 4" for the underlying design and the "Known limitation, accepted"
 * paragraph this script's results are folded into.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-asymmetric-join.js
 */

import { DummyHub } from '../../src/providers/dummy/index'
import {
  PROFILES,
  sleep,
  silenced,
  makeProviders,
} from './bench-user-scaling'

const N_VALUES = [5, 10, 25]
const SAMPLES = 8
const CONVERGENCE_TIMEOUT_MS = 20000

// Fixed, easily-recognizable pre-loaded content - long enough that a
// vacuous SyncStep2 reply (empty state vector) is trivially distinguishable
// from the real one.
const PRELOADED_TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(20)

interface RunOutcome {
  converged: boolean
  waitedMs: number
  mismatchedPeers: number
}

async function runOnce(N: number): Promise<RunOutcome> {
  const profile = PROFILES.find((p) => p.name.startsWith('Matrix'))!
  return silenced(async () => {
    const room = `bench-asym-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const { docs, providers } = makeProviders(hub, profile, N)

    // Pre-load peer 0 with real content BEFORE connecting - the rest stay
    // empty. Order matters: the insert happens while the provider exists
    // but transport.isConnected is still false, so nothing is sent yet;
    // the content is only pushed/requested once connect() below runs.
    docs[0].transact(() => {
      docs[0].getText('content').insert(0, PRELOADED_TEXT)
    })

    const start = Date.now()
    await Promise.all(providers.map((p) => p.connect({ room })))

    const timeoutAt = start + CONVERGENCE_TIMEOUT_MS
    let converged = false
    while (Date.now() < timeoutAt) {
      if (docs.every((d) => d.getText('content').toString() === PRELOADED_TEXT)) {
        converged = true
        break
      }
      await sleep(20)
    }
    const waitedMs = Date.now() - start

    const mismatchedPeers = docs.filter(
      (d) => d.getText('content').toString() !== PRELOADED_TEXT,
    ).length

    for (const p of providers) p.destroy()
    hub.clear()

    return { converged, waitedMs, mismatchedPeers }
  })
}

async function main() {
  console.log(
    '=== Asymmetric-peer-data join correctness check (Matrix profile) ===',
  )
  console.log(
    'One peer pre-loaded with real content before connecting; rest start empty.',
  )
  console.log(
    `Asserting ALL peers converge to the pre-loaded content within ${CONVERGENCE_TIMEOUT_MS}ms.\n`,
  )

  let anyFailure = false

  for (const N of N_VALUES) {
    console.log(`-- N=${N}, ${SAMPLES} samples --`)
    let successes = 0
    const waitedTimes: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const outcome = await runOnce(N)
      if (outcome.converged) {
        successes++
        waitedTimes.push(outcome.waitedMs)
        console.log(`  sample ${i + 1}: converged in ${outcome.waitedMs}ms`)
      } else {
        anyFailure = true
        console.log(
          `  sample ${i + 1}: FAILED TO CONVERGE within ${CONVERGENCE_TIMEOUT_MS}ms ` +
            `(${outcome.mismatchedPeers}/${N} peers still mismatched)`,
        )
      }
    }
    const mean =
      waitedTimes.length > 0
        ? Math.round(waitedTimes.reduce((a, b) => a + b, 0) / waitedTimes.length)
        : NaN
    console.log(
      `  => ${successes}/${SAMPLES} converged. mean convergence time (successes only): ${mean}ms\n`,
    )
  }

  if (anyFailure) {
    console.log(
      'RESULT: at least one sample failed to converge - genuine correctness ' +
        'concern, see docs/superpowers/specs/2026-07-26-dummy-benchmark-scaling-design.md',
    )
    process.exit(1)
  } else {
    console.log(
      'RESULT: all samples converged reliably at every tested N. See spec ' +
        '"Part 4" for interpretation.',
    )
    process.exit(0)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
