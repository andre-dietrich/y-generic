/**
 * Does sustained wire corruption trigger a resync *storm* (message volume
 * that keeps climbing / grows worse than linear in corruption rate or peer
 * count), or is it bounded the way the code comments in src/index.ts claim?
 *
 * Context: _handleIncomingMessage's corrupted-message branch (src/index.ts
 * ~805-840) schedules its own independent setTimeout -> _sendSyncStep1() per
 * corrupted message - unlike the hash-mismatch branch, which coalesces
 * concurrent triggers into a single pending resync
 * (_pendingHashMismatchResyncId). That asymmetry is exactly the shape of the
 * bug that motivated _tryReserveSyncSlot() in the first place (see syncNow()
 * comment, ~line 673: "20-200x the theoretical linear cost" at 100 users
 * before the shared rate limiter existed). This script checks whether the
 * corrupted-message path, despite NOT coalescing, is still safe purely
 * because _sendSyncStep1() reserves a slot from the same shared limiter
 * before writing anything to the transport.
 *
 * The corrupted-message resync path is now coalesced the same way (one
 * commit fixed the single-peer-restrikes-itself case) - this script's
 * second job is to check whether a resync storm still shows up anyway due
 * to *cross-peer* fanout: SyncStep1/SyncStep2 are room-wide broadcasts, not
 * point-to-point, so N peers replying/re-requesting can still multiply
 * traffic combinatorially with N even when each individual peer behaves.
 *
 * Approach: corrupt independently per RECEIVING transport (each peer's
 * onMessage boundary gets its own coin flip per delivery - real wire
 * corruption happens per physical link, so this must NOT be shared across
 * recipients of the same send()) while one peer produces a steady stream of
 * edits, and count:
 *   - actual messages placed on the wire (instrumentHub)
 *   - "Corrupted message rejected" / "Sync rate limit exceeded" warnings
 *   - SyncStep1 vs SyncStep2 send counts (classify() peeks at the
 *     unwrapped-but-uncorrupted sender-side bytes) - if the SyncStep2/
 *     SyncStep1 ratio stays close to 1 regardless of N, reply-suppression
 *     is doing its job and any storm is explained elsewhere; if the ratio
 *     grows with N, redundant replies (not request volume) are the driver
 * across increasing corruption rates and increasing peer counts, then checks
 * whether wire messages/sec ever exceeds the per-provider cap
 * (maxSyncRequestsPerWindow / syncRequestWindowMs, default 20/10s = 2/s) by
 * more than steady per-edit traffic should account for, and whether the
 * group still converges once corruption stops.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-corruption-storm.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, instrumentHub } from './bench-user-scaling'

const CORRUPTION_RATES = [0, 0.05, 0.2, 0.5]
const N_VALUES = [2, 5, 10]
const EDIT_STREAM_MS = 3000 // how long the edit burst + corruption runs
const EDIT_INTERVAL_MS = 50 // one insert every 50ms while corrupting
const SETTLE_TIMEOUT_MS = 15000 // convergence grace period once corruption stops

interface WarnCounts {
  corrupted: number
  rateLimited: number
  hashMismatch: number
}

function newWarnCounts(): WarnCounts {
  return { corrupted: 0, rateLimited: 0, hashMismatch: 0 }
}

async function withWarnCounts<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warns: WarnCounts }> {
  const warns = newWarnCounts()
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => {
    const msg = String(args[0] ?? '')
    if (msg.includes('Corrupted message rejected')) warns.corrupted++
    else if (msg.includes('Sync rate limit exceeded')) warns.rateLimited++
    else if (msg.includes('Hash mismatch #')) warns.hashMismatch++
  }
  try {
    const result = await fn()
    return { result, warns }
  } finally {
    console.warn = origWarn
  }
}

/**
 * Corrupt at the RECEIVING transport's onMessage boundary rather than the
 * shared hub.broadcast() call. hub.broadcast() delivers the SAME data
 * object to every recipient of one send() - corrupting it there would give
 * every recipient of that message an identical corrupted (or identical
 * clean) copy, i.e. corruption shared across the whole room per message
 * rather than independent per wire link. Real network corruption happens
 * per physical link, so each recipient must get its own independent coin
 * flip. Returns a restore function.
 */
function withCorruption(
  transport: DummyTransport,
  corruptionRate: number,
): () => void {
  const originalOnMessage = transport.onMessage.bind(transport)
  transport.onMessage = (callback: (data: Uint8Array) => void) => {
    return originalOnMessage((data: Uint8Array) => {
      if (corruptionRate > 0 && Math.random() < corruptionRate) {
        const corrupted = new Uint8Array(data)
        const idx = Math.floor(Math.random() * corrupted.length)
        corrupted[idx] ^= 0xff
        callback(corrupted)
      } else {
        callback(data)
      }
    })
  }
  return () => {
    transport.onMessage = originalOnMessage
  }
}

/**
 * Classify an outgoing (never-corrupted, sender-side) wire message by type
 * for fanout analysis: is a resync's request (SyncStep1) answered by ~1
 * reply (SyncStep2) regardless of N (suppression working), or does the
 * reply count scale with N (suppression not engaging / not enough)?
 * Wire format: [4-byte CRC][varUint msgType][varUint syncSubType?]. Types
 * 0-3 and sync subtypes 0-2 all fit a single-byte varUint.
 */
function classify(data: Uint8Array): string {
  if (data.length < 5) return 'other'
  const msgType = data[4]
  if (msgType === 0 || msgType === 3) {
    const subType = data.length > 5 ? data[5] : -1
    if (subType === 0) return 'syncStep1'
    if (subType === 1) return 'syncStep2'
    if (subType === 2) return 'update'
    return 'sync-other'
  }
  if (msgType === 1) return 'awareness'
  if (msgType === 2) return 'pubsub'
  return 'other'
}

interface TypeCounts {
  syncStep1: number
  syncStep2: number
  update: number
  awareness: number
}

function newTypeCounts(): TypeCounts {
  return { syncStep1: 0, syncStep2: 0, update: 0, awareness: 0 }
}

/** Shadow DummyTransport.prototype.send globally to classify+count sends. */
function withSendClassification(counts: TypeCounts): () => void {
  const original = DummyTransport.prototype.send
  DummyTransport.prototype.send = function (data: Uint8Array) {
    const label = classify(data)
    if (label === 'syncStep1') counts.syncStep1++
    else if (label === 'syncStep2') counts.syncStep2++
    else if (label === 'update') counts.update++
    else if (label === 'awareness') counts.awareness++
    return original.call(this, data)
  }
  return () => {
    DummyTransport.prototype.send = original
  }
}

function makeProviders(
  hub: DummyHub,
  N: number,
  corruptionRate: number,
  syncReplySuppressionMs?: number,
): { docs: Y.Doc[]; providers: GenericProvider[]; stopCorrupting: () => void } {
  const docs: Y.Doc[] = []
  const providers: GenericProvider[] = []
  const restoreFns: Array<() => void> = []
  for (let i = 0; i < N; i++) {
    const doc = new Y.Doc()
    const transport = new DummyTransport({ hub, latency: 15, jitter: 0.2 })
    restoreFns.push(withCorruption(transport, corruptionRate))
    const provider = new GenericProvider(doc, transport, {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: 0,
      ...(syncReplySuppressionMs !== undefined ? { syncReplySuppressionMs } : {}),
    })
    // Bump local awareness state past the genesis clock (0) - required for
    // the SyncStep2 reply-suppression peer-count gate
    // (awareness.getStates().size >= 3) to ever engage. Without this every
    // peer replies to every SyncStep1 unconditionally, which would inflate
    // the measured "storm" with an artifact of this harness, not a real
    // production condition. See bench-user-scaling.ts's makeProviders().
    provider.awareness.setLocalStateField('user', { id: i })
    docs.push(doc)
    providers.push(provider)
  }
  return {
    docs,
    providers,
    stopCorrupting: () => {
      for (const fn of restoreFns) fn()
    },
  }
}

interface RunResult {
  messages: number
  bytes: number
  msgsPerSec: number
  converged: boolean
  convergeMs: number
  warns: WarnCounts
  types: TypeCounts
  minAwarenessSeen: number
  belowGatePct: number
}

async function runOnce(
  N: number,
  corruptionRate: number,
  syncReplySuppressionMs?: number,
): Promise<RunResult> {
  const { result, warns } = await withWarnCounts(async () => {
    const room = `bench-corrupt-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const stats = instrumentHub(hub)
    const { docs, providers, stopCorrupting } = makeProviders(
      hub,
      N,
      corruptionRate,
      syncReplySuppressionMs,
    )

    await Promise.all(providers.map((p) => p.connect({ room })))
    await sleep(200)

    const pre = { messages: stats.messages, bytes: stats.bytes }
    const textA = docs[0].getText('content')

    const types = newTypeCounts()
    const stopClassifying = withSendClassification(types)

    // Hypothesis: SyncStep2 reply-suppression only engages once a peer
    // sees awareness.getStates().size >= 3. Awareness broadcasts travel
    // over the same corrupted wire as everything else, so a peer whose
    // awareness updates keep getting corrupted may never cross that
    // threshold - and would then always reply immediately
    // (unsuppressed), regardless of the suppression window's length.
    // Sample the MINIMUM known-peer-count across all providers throughout
    // the run to see whether some peer(s) stay stuck below the gate.
    let minAwarenessSeen = Infinity
    let belowGateSamples = 0
    let totalSamples = 0
    const awarenessMonitor = setInterval(() => {
      const sizes = providers.map((p) => p.awareness.getStates().size)
      const min = Math.min(...sizes)
      if (min < minAwarenessSeen) minAwarenessSeen = min
      totalSamples++
      if (min < 3) belowGateSamples++
    }, 50)

    const editTimer = setInterval(() => {
      docs[0].transact(() => textA.insert(textA.length, 'a'))
    }, EDIT_INTERVAL_MS)

    await sleep(EDIT_STREAM_MS)
    clearInterval(editTimer)
    clearInterval(awarenessMonitor)
    stopClassifying()

    const duringMessages = stats.messages - pre.messages
    const duringBytes = stats.bytes - pre.bytes

    // Corruption stops here - stop flipping bits on new deliveries so we
    // can observe whether the group still converges afterward.
    stopCorrupting()

    const target = textA.toString()
    const convergeStart = Date.now()
    const timeoutAt = convergeStart + SETTLE_TIMEOUT_MS
    let converged = false
    while (Date.now() < timeoutAt) {
      if (docs.every((d) => d.getText('content').toString() === target)) {
        converged = true
        break
      }
      await sleep(20)
    }
    const convergeMs = Date.now() - convergeStart

    for (const p of providers) p.destroy()
    hub.clear()

    return {
      messages: duringMessages,
      bytes: duringBytes,
      msgsPerSec: duringMessages / (EDIT_STREAM_MS / 1000),
      converged,
      convergeMs,
      types,
      minAwarenessSeen,
      belowGatePct: totalSamples > 0 ? (belowGateSamples / totalSamples) * 100 : 0,
    }
  })

  return { ...result, warns }
}

async function main() {
  console.log(
    'Sustained corruption while one peer streams edits. "messages" counts ' +
      'actual per-recipient deliveries placed on the wire during the ' +
      `${EDIT_STREAM_MS}ms edit stream (instrumentHub) - the number that ` +
      'would blow up if the corrupted-message path caused a storm.\n',
  )

  let anyStorm = false
  let anyStuck = false

  for (const N of N_VALUES) {
    console.log(`\n=== N=${N} peers ===`)
    console.log(
      'corrupt% | msgs(during) | msgs/sec | corrupted | step1 | step2 | step2/step1 | minAware | belowGate% | converged | convergeMs',
    )
    let baselineMsgsPerSec = 0
    for (const rate of CORRUPTION_RATES) {
      const r = await runOnce(N, rate)
      if (rate === 0) baselineMsgsPerSec = r.msgsPerSec

      // Flag a storm if traffic grows much faster than corruption rate
      // itself could explain (e.g. >10x baseline) - the point of the
      // shared rate limiter is to keep per-provider resync traffic capped
      // at maxSyncRequestsPerWindow/syncRequestWindowMs regardless of how
      // many corrupted messages arrive.
      const storm = rate > 0 && r.msgsPerSec > baselineMsgsPerSec * 10 + 5
      if (storm) anyStorm = true
      if (!r.converged) anyStuck = true

      const ratio =
        r.types.syncStep1 > 0
          ? (r.types.syncStep2 / r.types.syncStep1).toFixed(2)
          : 'n/a'

      console.log(
        `${String((rate * 100).toFixed(0) + '%').padStart(8)} | ` +
          `${String(r.messages).padStart(12)} | ` +
          `${String(r.msgsPerSec.toFixed(1)).padStart(8)} | ` +
          `${String(r.warns.corrupted).padStart(9)} | ` +
          `${String(r.types.syncStep1).padStart(5)} | ` +
          `${String(r.types.syncStep2).padStart(5)} | ` +
          `${String(ratio).padStart(11)} | ` +
          `${String(r.minAwarenessSeen).padStart(8)} | ` +
          `${String(r.belowGatePct.toFixed(0) + '%').padStart(10)} | ` +
          `${String(r.converged).padStart(9)} | ` +
          `${String(r.convergeMs).padStart(10)}` +
          (storm ? '  <-- STORM' : ''),
      )
    }
  }

  // Hypothesis: the NACK-style SyncStep2 reply-suppression window
  // (syncReplySuppressionMs, default 30ms) is short relative to
  // transport round-trip latency (15ms one-way here), so as N grows, more
  // competing repliers draw a random delay short enough to fire BEFORE
  // they can hear the first winner's reply and cancel - i.e. suppression
  // effectiveness should degrade with N because the race window scales
  // with the number of competitors, not because of N itself. Test this
  // directly: does a much larger suppression window (10x default) pull
  // the step2/step1 ratio back down toward ~1 at N=10, all else equal?
  console.log('\n=== Hypothesis check: does a wider suppression window fix the N=10 reply fanout? ===')
  console.log('suppressionMs | step1 | step2 | step2/step1')
  for (const suppressionMs of [30, 300]) {
    const r = await runOnce(10, 0.2, suppressionMs)
    const ratio =
      r.types.syncStep1 > 0
        ? (r.types.syncStep2 / r.types.syncStep1).toFixed(2)
        : 'n/a'
    console.log(
      `${String(suppressionMs).padStart(13)} | ` +
        `${String(r.types.syncStep1).padStart(5)} | ` +
        `${String(r.types.syncStep2).padStart(5)} | ` +
        `${String(ratio).padStart(11)}`,
    )
  }

  console.log(
    anyStorm
      ? '\nRESULT: message volume grew far beyond what corruption rate alone ' +
          'explains for at least one (N, rate) - resync storm reproduced.'
      : '\nRESULT: no resync storm - wire traffic stayed bounded across all ' +
          'corruption rates and peer counts tested.',
  )
  console.log(
    anyStuck
      ? 'RESULT: at least one run failed to converge within the settle ' +
          'timeout after corruption stopped.'
      : 'RESULT: all runs converged to identical content once corruption stopped.',
  )

  process.exit(anyStorm || anyStuck ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
