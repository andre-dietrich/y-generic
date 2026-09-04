/**
 * Benchmark: does connect()'s periodic-sync interval still re-broadcast
 * awareness on every tick for transports WITH onPeerConnect (mesh
 * transports - peerjs, simple-peer, trystero), even though a newly-joined
 * peer already gets awareness via _schedulePeerConnectSync() -> syncNow()
 * on join? And is the plain (no onPeerConnect) transport's periodic
 * awareness re-announce - which genuinely is the only thing bounding how
 * long a late-joining peer might miss this peer's presence on those
 * transports - left unchanged?
 *
 * Approach: connect N peers, let them fully settle (past any join-triggered
 * awareness traffic), then watch several `syncInterval` ticks with NO other
 * activity (no edits, no awareness field changes, no new joiners) so every
 * MESSAGE_AWARENESS send observed during that window is attributable
 * specifically to the periodic-sync interval's own re-announce, not to
 * anything else. Compares a `simulatePeerConnect: true` (onPeerConnect
 * present, DummyHub/DummyTransport's round-2 mesh simulation) config
 * against a plain DummyTransport (no onPeerConnect) config.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-periodic-awareness.js
 */

import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const N = 2
const SYNC_INTERVAL_MS = 300
const TICKS_TO_OBSERVE = 4
const LATENCY = 10

function classify(wrapped: Uint8Array): 'awareness' | 'syncStep1' | 'other' {
  if (wrapped.length < 5) return 'other'
  const decoder = decoding.createDecoder(wrapped.subarray(4))
  const msgType = decoding.readVarUint(decoder)
  if (msgType === 1) return 'awareness'
  if (msgType === 0) {
    const subType = decoding.readVarUint(decoder)
    if (subType === 0) return 'syncStep1'
  }
  return 'other'
}

function withSendClassification(counts: {
  awareness: number
  syncStep1: number
}): () => void {
  const original = DummyTransport.prototype.send
  DummyTransport.prototype.send = function (data: Uint8Array) {
    const label = classify(data)
    if (label === 'awareness') counts.awareness++
    else if (label === 'syncStep1') counts.syncStep1++
    return original.call(this, data)
  }
  return () => {
    DummyTransport.prototype.send = original
  }
}

async function runConfig(simulatePeerConnect: boolean): Promise<{
  awareness: number
  syncStep1: number
}> {
  return silenced(async () => {
    const room = `bench-periodic-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()

    const providers: GenericProvider[] = []
    for (let i = 0; i < N; i++) {
      const doc = new Y.Doc()
      const transport = new DummyTransport({
        hub,
        latency: LATENCY,
        simulatePeerConnect,
      })
      const provider = new GenericProvider(doc, transport, {
        batchUpdates: 0,
        verifyUpdates: true,
        syncInterval: SYNC_INTERVAL_MS,
      })
      provider.awareness.setLocalStateField('user', { id: i })
      providers.push(provider)
    }

    await Promise.all(providers.map((p) => p.connect({ room })))
    const timeoutAt = Date.now() + 15000
    while (Date.now() < timeoutAt && providers.some((p) => !p.synced)) {
      await sleep(10)
    }
    // Settle past any join-triggered awareness traffic (initial connect()
    // broadcast, plus onPeerConnect-triggered syncNow() for the mesh config)
    // before starting to count - only traffic from here on can be
    // attributable to the periodic interval.
    await sleep(LATENCY * 4 + 200)

    const counts = { awareness: 0, syncStep1: 0 }
    const restore = withSendClassification(counts)

    // Observe several ticks with zero other activity: no edits, no
    // awareness field changes, no new joiners.
    await sleep(SYNC_INTERVAL_MS * TICKS_TO_OBSERVE + SYNC_INTERVAL_MS / 2)

    restore()
    for (const p of providers) p.destroy()
    hub.clear()

    return counts
  })
}

async function main() {
  console.log(
    `${N} peers, syncInterval=${SYNC_INTERVAL_MS}ms, observing ~${TICKS_TO_OBSERVE} ticks with no other activity.\n` +
      `"awareness" = MESSAGE_AWARENESS sends during that window (periodic re-announce only, since no other\n` +
      `awareness-triggering event happens once settled). Expected periodic syncStep1 sends: N * ${TICKS_TO_OBSERVE} = ${N * TICKS_TO_OBSERVE}\n` +
      `(unaffected by this fix - only the awareness half is conditional).\n`,
  )

  const mesh = await runConfig(true)
  const plain = await runConfig(false)

  console.log('config                          | syncStep1 | awareness')
  console.log(
    `onPeerConnect (mesh, simulated)  | ${String(mesh.syncStep1).padStart(9)} | ${String(mesh.awareness).padStart(9)}`,
  )
  console.log(
    `no onPeerConnect (plain relay)   | ${String(plain.syncStep1).padStart(9)} | ${String(plain.awareness).padStart(9)}`,
  )

  const meshOk = mesh.awareness === 0
  const plainOk = plain.awareness >= N * (TICKS_TO_OBSERVE - 1) // allow ~1 tick of slack for timing

  console.log(
    meshOk
      ? '\nPASS: onPeerConnect-enabled config sent 0 periodic awareness messages.'
      : `\nFAIL: onPeerConnect-enabled config sent ${mesh.awareness} periodic awareness messages (expected 0).`,
  )
  console.log(
    plainOk
      ? 'PASS: plain (no onPeerConnect) config kept periodic awareness re-announce (correctness gate: fix must be conditional, not global).'
      : `FAIL: plain config only sent ${plain.awareness} awareness messages (expected close to ${N * TICKS_TO_OBSERVE}) - periodic awareness re-announce appears broken for ALL transports, not just onPeerConnect ones.`,
  )

  process.exit(meshOk && plainOk ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
