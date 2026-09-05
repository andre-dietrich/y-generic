/**
 * Benchmark: does the periodic-sync tick still re-announce awareness (it
 * must not - on ANY transport since the digest beacon), and does a late
 * joiner still learn everyone's presence promptly via the JOIN-flagged
 * beacon instead? See docs/superpowers/specs/2026-09-05-digest-beacon-design.md §5.
 *
 * Part 1: N peers settle, then several syncInterval ticks with no other
 * activity - every MESSAGE_AWARENESS send in that window is periodic
 * re-announce traffic. Checked for both a simulated-onPeerConnect (mesh)
 * config and a plain relay config; expected 0 for both. (Round 3 made the
 * re-announce conditional on onPeerConnect; the digest beacon removes it
 * entirely - y-protocols/awareness's own 15s renewal is the staleness
 * bound, its 30s outdatedTimeout the removal bound.)
 * Part 2: a 6th peer joins a settled 5-peer plain room. It must (i) hold
 * all 5 remote presence states and (ii) be `synced` within
 * awarenessInterval + 3*latency + 200ms of connect() resolving.
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
const AWARENESS_INTERVAL_MS = 100 // GenericProvider default
const JOIN_ROOM_SIZE = 5
const JOIN_BOUND_MS = AWARENESS_INTERVAL_MS + 3 * LATENCY + 200

const MESSAGE_BATCH = 4
const MESSAGE_SYNC_DIGEST = 5

/**
 * Classify one already-unwrapped-of-its-CRC32 message. Recurses into
 * MESSAGE_BATCH envelopes (see src/index.ts's _sendBatch()/_dispatchMessage())
 * so a tick's request+awareness traveling as ONE wire message still gets
 * counted as one of each logical message. Type 5 (digest beacon) is the
 * request class.
 */
function classifyOne(msg: Uint8Array, out: { awareness: number; syncStep1: number }): void {
  const decoder = decoding.createDecoder(msg)
  const msgType = decoding.readVarUint(decoder)
  if (msgType === 1) {
    out.awareness++
  } else if (msgType === 0) {
    const subType = decoding.readVarUint(decoder)
    if (subType === 0) out.syncStep1++
  } else if (msgType === MESSAGE_SYNC_DIGEST) {
    out.syncStep1++
  } else if (msgType === MESSAGE_BATCH) {
    while (decoding.hasContent(decoder)) {
      classifyOne(decoding.readVarUint8Array(decoder), out)
    }
  }
}

function classify(wrapped: Uint8Array): { awareness: number; syncStep1: number } {
  const out = { awareness: 0, syncStep1: 0 }
  if (wrapped.length < 5) return out
  classifyOne(wrapped.subarray(4), out)
  return out
}

function withSendClassification(counts: { awareness: number; syncStep1: number }): () => void {
  const original = DummyTransport.prototype.send
  DummyTransport.prototype.send = function (data: Uint8Array) {
    const label = classify(data)
    counts.awareness += label.awareness
    counts.syncStep1 += label.syncStep1
    return original.call(this, data)
  }
  return () => {
    DummyTransport.prototype.send = original
  }
}

function makeProvider(hub: DummyHub, simulatePeerConnect: boolean, id: number | string): GenericProvider {
  const transport = new DummyTransport({
    hub,
    latency: LATENCY,
    simulatePeerConnect,
    unicast: process.env.DUMMY_UNICAST === '1',
  })
  const provider = new GenericProvider(new Y.Doc(), transport, {
    batchUpdates: 0,
    verifyUpdates: true,
    syncInterval: SYNC_INTERVAL_MS,
  })
  provider.awareness.setLocalStateField('user', { id })
  return provider
}

async function runConfig(simulatePeerConnect: boolean): Promise<{ awareness: number; syncStep1: number }> {
  return silenced(async () => {
    const room = `bench-periodic-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const providers: GenericProvider[] = []
    for (let i = 0; i < N; i++) providers.push(makeProvider(hub, simulatePeerConnect, i))

    await Promise.all(providers.map((p) => p.connect({ room })))
    const timeoutAt = Date.now() + 15000
    while (Date.now() < timeoutAt && providers.some((p) => !p.synced)) await sleep(10)
    // Settle past any join-triggered awareness traffic (initial connect()
    // broadcast, onPeerConnect-triggered syncNow() for the mesh config,
    // JOIN-beacon presence responses) before counting - only traffic from
    // here on can be attributed to the periodic interval.
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

async function runLateJoiner(): Promise<{ presenceMs: number; states: number; syncedMs: number; synced: boolean }> {
  return silenced(async () => {
    const room = `bench-joiner-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const providers: GenericProvider[] = []
    for (let i = 0; i < JOIN_ROOM_SIZE; i++) providers.push(makeProvider(hub, false, i))
    await Promise.all(providers.map((p) => p.connect({ room })))
    // Settle well past the join burst and at least two periodic ticks.
    await sleep(SYNC_INTERVAL_MS * 3)

    const joiner = makeProvider(hub, false, 'joiner')
    const start = Date.now()
    await joiner.connect({ room })
    const deadline = start + 5000
    let presenceMs = -1
    let syncedMs = -1
    while (Date.now() < deadline && (presenceMs < 0 || syncedMs < 0)) {
      if (presenceMs < 0 && joiner.awareness.getStates().size >= JOIN_ROOM_SIZE + 1) presenceMs = Date.now() - start
      if (syncedMs < 0 && joiner.synced) syncedMs = Date.now() - start
      await sleep(2)
    }
    const out = {
      presenceMs,
      states: joiner.awareness.getStates().size,
      syncedMs,
      synced: joiner.synced,
    }
    joiner.destroy()
    for (const p of providers) p.destroy()
    hub.clear()
    return out
  })
}

async function main() {
  console.log(
    `Part 1: ${N} peers, syncInterval=${SYNC_INTERVAL_MS}ms, observing ~${TICKS_TO_OBSERVE} ticks with no other activity.\n` +
      `Expected periodic request sends: N * ${TICKS_TO_OBSERVE} = ${N * TICKS_TO_OBSERVE}; expected awareness sends: 0 for BOTH configs.\n`,
  )
  const mesh = await runConfig(true)
  const plain = await runConfig(false)
  console.log('config                          | request | awareness')
  console.log(`onPeerConnect (mesh, simulated)  | ${String(mesh.syncStep1).padStart(7)} | ${String(mesh.awareness).padStart(9)}`)
  console.log(`no onPeerConnect (plain relay)   | ${String(plain.syncStep1).padStart(7)} | ${String(plain.awareness).padStart(9)}`)

  const meshOk = mesh.awareness === 0
  const plainOk = plain.awareness === 0
  console.log(
    meshOk
      ? '\nPASS: mesh config sent 0 periodic awareness messages.'
      : `\nFAIL: mesh config sent ${mesh.awareness} periodic awareness messages (expected 0).`,
  )
  console.log(
    plainOk
      ? 'PASS: plain config sent 0 periodic awareness messages.'
      : `FAIL: plain config sent ${plain.awareness} periodic awareness messages (expected 0 - the tick must not re-announce; presence is answered on JOIN).`,
  )

  console.log(`\nPart 2: late joiner into a settled ${JOIN_ROOM_SIZE}-peer plain room, bound ${JOIN_BOUND_MS}ms.\n`)
  const j = await runLateJoiner()
  const presenceOk = j.presenceMs >= 0 && j.presenceMs <= JOIN_BOUND_MS
  const syncedOk = j.synced && j.syncedMs >= 0 && j.syncedMs <= JOIN_BOUND_MS
  console.log(`joiner: presence states=${j.states}/${JOIN_ROOM_SIZE + 1} after ${j.presenceMs}ms; synced=${j.synced} after ${j.syncedMs}ms`)
  console.log(
    presenceOk
      ? `PASS: joiner saw all ${JOIN_ROOM_SIZE} remote presence states within ${JOIN_BOUND_MS}ms.`
      : `FAIL: joiner presence took ${j.presenceMs}ms (states=${j.states}), bound ${JOIN_BOUND_MS}ms.`,
  )
  console.log(
    syncedOk
      ? `PASS: joiner synced within ${JOIN_BOUND_MS}ms.`
      : `FAIL: joiner synced=${j.synced} after ${j.syncedMs}ms, bound ${JOIN_BOUND_MS}ms.`,
  )

  process.exit(meshOk && plainOk && presenceOk && syncedOk ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
