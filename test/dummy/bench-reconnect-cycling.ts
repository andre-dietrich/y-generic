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

/** Install a drop switch on transport, returning setters to control when drops occur. */
function withDropSwitch(transport: DummyTransport): {
  restore: () => void
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
    restore: () => {
      transport.onMessage = originalOnMessage
    },
    setDropNext: (v: boolean) => {
      dropNext = v
    },
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
  messagesAfterGraceWait: number
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
  const dropSwitch = withDropSwitch(transportB)
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

  // Drop one message from A to B to open a real sequence gap (seq 0 arrives,
  // seq 1 is dropped, seq 2 arrives, triggering gap detection).
  docA.transact(() => textA.insert(0, 'x')) // seq 0 - delivered
  await sleep(20)
  dropSwitch.setDropNext(true)
  docA.transact(() => textA.insert(0, 'y')) // seq 1 - dropped (flag auto-resets)
  await sleep(20)
  docA.transact(() => textA.insert(0, 'z')) // seq 2 - delivered, gap detected
  await sleep(20)

  // Gap check is now scheduled on B with GAP_GRACE_MS grace. Disconnect and
  // immediately reconnect B well before that grace period elapses.
  providerB.disconnect()
  await providerB.connect({ room })

  await sleep(50) // let the reconnect's own syncNow() traffic land
  const beforeGraceWait = stats.messages

  const spuriousGapWarnings = await withWarnCount(
    'Sequence gap confirmed',
    async () => {
      // Wait past the original grace period (opened well before now) plus margin.
      await sleep(GAP_GRACE_MS + 100)
    },
  )

  const messagesAfterGraceWait = stats.messages - beforeGraceWait

  dropSwitch.restore()
  providerA.destroy()
  providerB.destroy()
  hub.clear()

  return { spuriousGapWarnings, messagesAfterGraceWait }
}

async function main() {
  let totalSpurious = 0
  let totalMessages = 0
  for (let i = 0; i < CYCLES; i++) {
    const { spuriousGapWarnings, messagesAfterGraceWait } = await runCycle()
    totalSpurious += spuriousGapWarnings
    totalMessages += messagesAfterGraceWait
  }
  console.log(
    `Over ${CYCLES} disconnect/reconnect cycles racing a pending gap check:`,
  )
  console.log(`  spurious "Sequence gap confirmed" warnings: ${totalSpurious}`)
  console.log(`  total messages during grace-period wait: ${totalMessages}`)
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
