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
 * Approach: corrupt a fraction of in-flight bytes at the DummyHub.broadcast
 * per-recipient delivery boundary (independent coin flip per recipient, like
 * real wire corruption would be) while one peer produces a steady stream of
 * edits, and count:
 *   - actual messages placed on the wire (instrumentHub)
 *   - "Corrupted message rejected" warnings (corruption detected)
 *   - "Sync rate limit exceeded" warnings (resync attempts the limiter
 *     dropped - the thing that would otherwise BE the storm)
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

const CORRUPTION_RATES = [0, 0.05, 0.2, 0.5, 0.9]
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
 * Shadow DummyHub.broadcast to independently corrupt each per-recipient
 * delivery at `corruptionRate`, flipping one bit in the CRC-wrapped payload
 * (guaranteed CRC32 mismatch on receipt - real wire corruption would land
 * anywhere in the byte range with the same effect).
 */
function withCorruption(hub: DummyHub, corruptionRate: number): () => void {
  const original = hub.broadcast.bind(hub)
  ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (
    room: string,
    data: Uint8Array,
    sender: DummyTransport,
    options?: { latency?: number; dropRate?: number; jitter?: number },
  ) => {
    let toSend = data
    if (corruptionRate > 0 && Math.random() < corruptionRate) {
      toSend = new Uint8Array(data)
      const idx = Math.floor(Math.random() * toSend.length)
      toSend[idx] ^= 0xff
    }
    return original(room, toSend, sender, options)
  }
  return () => {
    ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast =
      original
  }
}

function makeProviders(
  hub: DummyHub,
  N: number,
): { docs: Y.Doc[]; providers: GenericProvider[] } {
  const docs: Y.Doc[] = []
  const providers: GenericProvider[] = []
  for (let i = 0; i < N; i++) {
    const doc = new Y.Doc()
    const transport = new DummyTransport({ hub, latency: 15, jitter: 0.2 })
    const provider = new GenericProvider(doc, transport, {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: 0,
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
  return { docs, providers }
}

interface RunResult {
  messages: number
  bytes: number
  msgsPerSec: number
  converged: boolean
  convergeMs: number
  warns: WarnCounts
}

async function runOnce(N: number, corruptionRate: number): Promise<RunResult> {
  const { result, warns } = await withWarnCounts(async () => {
    const room = `bench-corrupt-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const stopCorrupting = withCorruption(hub, corruptionRate)
    const stats = instrumentHub(hub)
    const { docs, providers } = makeProviders(hub, N)

    await Promise.all(providers.map((p) => p.connect({ room })))
    await sleep(200)

    const pre = { messages: stats.messages, bytes: stats.bytes }
    const textA = docs[0].getText('content')

    const editTimer = setInterval(() => {
      docs[0].transact(() => textA.insert(textA.length, 'a'))
    }, EDIT_INTERVAL_MS)

    await sleep(EDIT_STREAM_MS)
    clearInterval(editTimer)

    const duringMessages = stats.messages - pre.messages
    const duringBytes = stats.bytes - pre.bytes

    // Corruption stops here - stop flipping bits on new broadcasts so we can
    // observe whether the group still converges afterward.
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
      'corrupt% | msgs(during) | msgs/sec | corrupted | rateLimited | hashMismatch | converged | convergeMs',
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

      console.log(
        `${String((rate * 100).toFixed(0) + '%').padStart(8)} | ` +
          `${String(r.messages).padStart(12)} | ` +
          `${String(r.msgsPerSec.toFixed(1)).padStart(8)} | ` +
          `${String(r.warns.corrupted).padStart(9)} | ` +
          `${String(r.warns.rateLimited).padStart(11)} | ` +
          `${String(r.warns.hashMismatch).padStart(12)} | ` +
          `${String(r.converged).padStart(9)} | ` +
          `${String(r.convergeMs).padStart(10)}` +
          (storm ? '  <-- STORM' : ''),
      )
    }
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
