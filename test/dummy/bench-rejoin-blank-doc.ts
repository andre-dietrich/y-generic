/**
 * Correctness check (not a performance benchmark): the exact scenario
 * reported from LiaScript's live GUN/PeerJS testing - peer A connects,
 * writes content, then "goes away" (tab closed / cache cleared) and
 * reconnects to the SAME room under the SAME logical identity but with a
 * brand-new, EMPTY Y.Doc, while peer B stayed connected the whole time and
 * already has A's original content replicated into its own doc. Does A's
 * fresh doc ever converge to that content?
 *
 * Why neither existing bench script covers this:
 * - `bench-asymmetric-join.ts` is asymmetric in *data* (one peer pre-loaded)
 *   but every peer connects in the same `Promise.all` burst from a cold
 *   room - nobody is already settled when the asymmetry is introduced, and
 *   it's never run at N=2.
 * - `bench-late-join.ts` models a settled-then-late-join *timing* asymmetry
 *   at N>=15, but every peer there starts with IDENTICAL (empty) state - no
 *   data asymmetry at all.
 * - Neither models the same identity's doc going from "has content" to
 *   "empty" mid-session while a settled peer keeps the content.
 *
 * Two variants of how A's first session ends, since this determines whether
 * B is left with a stale awareness entry for A's old clientID:
 * - graceful: providerA1.disconnect() is called (removes A1's awareness
 *   state via awarenessProtocol.removeAwarenessStates).
 * - ungraceful: A1 is simply abandoned without disconnect() - modeling a
 *   browser tab closed without beforeunload firing (common for GUN/PeerJS
 *   backends per the bug report). A1's transport stays registered in the
 *   DummyHub and its awareness state lingers on B until GC'd by y-protocols'
 *   own timeout logic (which this script's timeout window is far too short
 *   to trigger), so B ends up knowing 3 distinct awareness clients (self,
 *   stale A1, fresh A2) even though only 2 real peers remain.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-rejoin-blank-doc.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { PROFILES, sleep, silenced, type Profile } from './bench-user-scaling'

const SAMPLES = 10
const CONVERGENCE_TIMEOUT_MS = 30000
const CONTENT = 'The quick brown fox jumps over the lazy dog. '.repeat(20)

interface RunOutcome {
  converged: boolean
  waitedMs: number
  syncedFired: boolean
}

async function runOnce(
  profile: Profile,
  gracefulOldDisconnect: boolean,
): Promise<RunOutcome> {
  return silenced(async () => {
    const room = `bench-rejoin-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()

    const mkTransport = () =>
      new DummyTransport({ hub, latency: profile.latency, jitter: profile.jitter })

    // Peer B: connects first, stays connected the entire scenario.
    const docB = new Y.Doc()
    const providerB = new GenericProvider(docB, mkTransport(), {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: 5000,
    })
    providerB.awareness.setLocalStateField('user', { id: 'B' })
    await providerB.connect({ room })

    // Peer A, session 1: connects and writes the content that must survive
    // its reconnect below.
    const docA1 = new Y.Doc()
    const providerA1 = new GenericProvider(docA1, mkTransport(), {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: 5000,
    })
    providerA1.awareness.setLocalStateField('user', { id: 'A' })
    await providerA1.connect({ room })
    docA1.transact(() => {
      docA1.getText('content').insert(0, CONTENT)
    })

    // Wait until B has genuinely received A's content (not just "A sent
    // it") before A "leaves" - this is the precondition the bug report
    // describes: the content is already part of the shared room state.
    const setupTimeoutAt = Date.now() + CONVERGENCE_TIMEOUT_MS
    while (
      Date.now() < setupTimeoutAt &&
      docB.getText('content').toString() !== CONTENT
    ) {
      await sleep(20)
    }
    if (docB.getText('content').toString() !== CONTENT) {
      throw new Error(
        "setup failed: peer B never received peer A's original content",
      )
    }
    await sleep(profile.latency * 2 + 100)

    // Peer A "leaves". Graceful = disconnect() called (real cleanup,
    // removes A1's awareness state on B). Ungraceful = A1 is simply
    // abandoned - its transport stays registered with the hub and its
    // awareness entry lingers on B, exactly like a browser tab closed
    // without beforeunload firing.
    if (gracefulOldDisconnect) {
      providerA1.disconnect()
    }

    // Peer A, session 2: SAME logical identity reconnects with a brand-new,
    // EMPTY Y.Doc - the identity token survived (same room), the doc did
    // not (fresh Y.Doc, no clientID reuse - Yjs assigns a new random one).
    const docA2 = new Y.Doc()
    const providerA2 = new GenericProvider(docA2, mkTransport(), {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: 5000,
    })
    providerA2.awareness.setLocalStateField('user', { id: 'A' })

    let syncedFired = false
    providerA2.on('synced', () => {
      syncedFired = true
    })

    const start = Date.now()
    await providerA2.connect({ room })

    const timeoutAt = start + CONVERGENCE_TIMEOUT_MS
    let converged = false
    while (Date.now() < timeoutAt) {
      if (docA2.getText('content').toString() === CONTENT) {
        converged = true
        break
      }
      await sleep(20)
    }
    const waitedMs = Date.now() - start

    providerB.destroy()
    // destroy() is safe whether or not disconnect() was already called
    // above (the ungraceful branch skips it by design, to leak the
    // transport registration/awareness state exactly like an abruptly
    // closed tab) - always clean up here so the process can exit.
    providerA1.destroy()
    providerA2.destroy()
    hub.clear()

    return { converged, waitedMs, syncedFired }
  })
}

async function runScenario(
  label: string,
  profile: Profile,
  gracefulOldDisconnect: boolean,
): Promise<boolean> {
  console.log(`\n-- ${label} (profile: ${profile.name}) --`)
  let anyFailure = false
  const waitedTimes: number[] = []
  let syncedFiredCount = 0

  for (let i = 0; i < SAMPLES; i++) {
    const outcome = await runOnce(profile, gracefulOldDisconnect)
    if (outcome.converged) {
      waitedTimes.push(outcome.waitedMs)
      if (outcome.syncedFired) syncedFiredCount++
      console.log(
        `  sample ${i + 1}: converged in ${outcome.waitedMs}ms ` +
          `(synced event fired: ${outcome.syncedFired})`,
      )
    } else {
      anyFailure = true
      console.log(
        `  sample ${i + 1}: FAILED TO CONVERGE within ${CONVERGENCE_TIMEOUT_MS}ms`,
      )
    }
  }

  const mean =
    waitedTimes.length > 0
      ? Math.round(waitedTimes.reduce((a, b) => a + b, 0) / waitedTimes.length)
      : NaN
  console.log(
    `  => converged: ${waitedTimes.length}/${SAMPLES}, mean=${mean}ms, ` +
      `synced-event fired ${syncedFiredCount}/${waitedTimes.length}`,
  )

  return anyFailure
}

async function main() {
  console.log(
    '=== Same-identity rejoin-with-blank-doc correctness check ===',
  )
  console.log(
    'Peer B stays connected throughout and already has peer A\'s content.\n' +
      'Peer A reconnects (same room) with a brand-new empty Y.Doc.\n' +
      `Asserting A's fresh doc converges to A's own previously-written\n` +
      `content within ${CONVERGENCE_TIMEOUT_MS}ms.`,
  )

  const profile = PROFILES.find((p) => p.name.startsWith('Matrix'))!

  let anyFailure = false
  anyFailure = (await runScenario('graceful old-session disconnect', profile, true)) || anyFailure
  anyFailure = (await runScenario('UNGRACEFUL old-session abandonment (tab closed)', profile, false)) || anyFailure

  if (anyFailure) {
    console.log(
      '\nRESULT: at least one sample failed to converge - genuine correctness bug.',
    )
    process.exit(1)
  } else {
    console.log('\nRESULT: all samples converged reliably in both variants.')
    process.exit(0)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
