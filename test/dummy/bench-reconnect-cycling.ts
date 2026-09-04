/**
 * Bug repro / regression check: does a sequence-number gap-check timer
 * scheduled before disconnect() survive into a later reconnect and fire a
 * spurious resync against stale sequence state?
 *
 * disconnect() (src/index.ts) resets several pieces of resync-related state
 * (_syncRequestTimes, _resyncAttemptCount, cancels _pendingResyncTimeoutId)
 * but - before this fix - did NOT clear _gapCheckTimers or _remoteSeqInfo,
 * unlike destroy() which does. A gap-check timer armed while still connected
 * keeps running even after disconnect()/reconnect(), and its callback only
 * guards on `this._destroying` (true only after destroy(), not disconnect())
 * and `this.transport.isConnected` (true again once reconnected) - so it can
 * fire `_requestResync()` using sequence-number bookkeeping from the
 * PREVIOUS connection, producing an extra, unnecessary push+pull after a
 * reconnect that happens to race a still-pending gap check.
 *
 * Approach: peer B receives a real sequence gap from peer A (one message
 * dropped at B's receiving boundary, mirroring bench-corruption-storm.ts's
 * withCorruption pattern but dropping instead of corrupting), which arms a
 * gap-check timer with a grace period. Before that grace period elapses, B
 * disconnects and immediately reconnects. We then wait past the grace period
 * and count: (a) "Sequence gap confirmed" warnings, (b) wire messages sent
 * in that window beyond what a normal reconnect's own syncNow() accounts
 * for. Repeated over several cycles.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-reconnect-cycling.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, instrumentHub } from './bench-user-scaling'

const GAP_GRACE_MS = 300
const CYCLES = 20

/** Drop exactly the (1-indexed) Nth message delivered to this transport's callback. */
function withNthMessageDropped(
  transport: DummyTransport,
  n: number,
): () => void {
  const originalOnMessage = transport.onMessage.bind(transport)
  let count = 0
  transport.onMessage = (callback: (data: Uint8Array) => void) => {
    return originalOnMessage((data: Uint8Array) => {
      count++
      if (count === n) return // drop it
      callback(data)
    })
  }
  return () => {
    transport.onMessage = originalOnMessage
  }
}

async function withWarnCount(
  match: string,
  fn: () => Promise<void>,
): Promise<number> {
  let count = 0
  const orig = console.warn
  console.warn = (...args: unknown[]) => {
    if (String(args[0] ?? '').includes(match)) count++
  }
  try {
    await fn()
  } finally {
    console.warn = orig
  }
  return count
}

async function runCycle(): Promise<{
  spuriousGapWarnings: number
  extraMessages: number
}> {
  const room = `bench-reconnect-${Math.random().toString(36).slice(2)}`
  const hub = new DummyHub()
  const stats = instrumentHub(hub)

  const docA = new Y.Doc()
  const transportA = new DummyTransport({ hub, latency: 5 })
  const providerA = new GenericProvider(docA, transportA, {
    batchUpdates: 0,
    verifyUpdates: true,
    syncInterval: 0,
    gapGraceMs: GAP_GRACE_MS,
  })
  providerA.awareness.setLocalStateField('user', { id: 'a' })

  const docB = new Y.Doc()
  const transportB = new DummyTransport({ hub, latency: 5 })
  const providerB = new GenericProvider(docB, transportB, {
    batchUpdates: 0,
    verifyUpdates: true,
    syncInterval: 0,
    gapGraceMs: GAP_GRACE_MS,
  })
  providerB.awareness.setLocalStateField('user', { id: 'b' })

  await Promise.all([
    providerA.connect({ room }),
    providerB.connect({ room }),
  ])
  await sleep(50)

  const textA = docA.getText('content')

  // Drop the 2nd MESSAGE_SYNC_VERIFIED update B receives from A, to open a
  // real sequence gap (A's seq 0 arrives, seq 1 is dropped, seq 2 arrives).
  const restore = withNthMessageDropped(transportB, 2)
  docA.transact(() => textA.insert(0, 'x')) // seq 0 - delivered
  await sleep(20)
  docA.transact(() => textA.insert(0, 'y')) // seq 1 - dropped
  await sleep(20)
  docA.transact(() => textA.insert(0, 'z')) // seq 2 - delivered, gap detected
  await sleep(20)
  restore()

  // Gap check is now scheduled on B with GAP_GRACE_MS grace. Disconnect and
  // immediately reconnect B well before that grace period elapses.
  providerB.disconnect()
  await providerB.connect({ room })

  await sleep(50) // let the reconnect's own syncNow() traffic land
  const baseline = { messages: stats.messages }

  const spuriousGapWarnings = await withWarnCount(
    'Sequence gap confirmed',
    async () => {
      // Wait past the original grace period (opened well before now) plus margin.
      await sleep(GAP_GRACE_MS + 100)
    },
  )

  const extraMessages = stats.messages - baseline.messages

  providerA.destroy()
  providerB.destroy()
  hub.clear()

  return { spuriousGapWarnings, extraMessages }
}

async function main() {
  let totalSpurious = 0
  let totalExtraMessages = 0
  for (let i = 0; i < CYCLES; i++) {
    const { spuriousGapWarnings, extraMessages } = await runCycle()
    totalSpurious += spuriousGapWarnings
    totalExtraMessages += extraMessages
  }
  console.log(
    `Over ${CYCLES} disconnect/reconnect cycles racing a pending gap check:`,
  )
  console.log(`  spurious "Sequence gap confirmed" warnings: ${totalSpurious}`)
  console.log(
    `  extra messages attributable to stale gap timers: ${totalExtraMessages}`,
  )
  console.log(
    totalSpurious > 0
      ? 'RESULT: stale gap-check timer fired after reconnect - bug reproduced.'
      : 'RESULT: no stale gap-check timer fired - clean.',
  )
  process.exit(totalSpurious > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
