/**
 * Benchmark: awareness traffic caused by one user moving a cursor, with and
 * without relaying remote awareness changes (B4).
 *
 * N providers share a DummyHub (every send reaches every peer, like the edrys
 * WebSocket relay or a complete WebRTC mesh). One of them updates its app
 * awareness MOVES times, 150ms apart (past the 100ms awareness throttle, so
 * each move is its own frame). We count awareness frames handed to send()
 * and frames delivered to receivers, in two modes:
 *
 * - relay: the transport reports `reachesAllPeers: false`, so every receiver
 *   re-broadcasts each change once (behaviour up to 3.0.0 on all transports,
 *   and still the behaviour on a partial WebRTC mesh).
 * - direct: `reachesAllPeers: true` (WebSocket, dummy, small full meshes);
 *   only the mover sends.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-awareness-relay.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'

const USER_COUNTS = [5, 10, 20, 30]
const MOVES = 10
const LATENCY = 15

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function run(n: number, relay: boolean) {
  const hub = new DummyHub()
  let sent = 0
  let delivered = 0
  const providers: GenericProvider[] = []
  for (let i = 0; i < n; i++) {
    const doc = new Y.Doc()
    const transport = new DummyTransport({ hub, latency: LATENCY, jitter: 0.2 })
    if (relay) Object.defineProperty(transport, 'reachesAllPeers', { value: false })
    const send = transport.send.bind(transport)
    transport.send = (data: Uint8Array) => {
      // [CRC32 x4][opcode]: opcode 1 is awareness.
      if (data[4] === 1) {
        sent++
        delivered += n - 1
      }
      send(data)
    }
    const provider = new GenericProvider(doc, transport, {
      disableBc: true,
      syncInterval: 0,
    })
    provider.appAwareness.setLocalStateField('cursor', { x: 0 })
    await provider.connect({ room: `relay-${n}-${relay}` })
    providers.push(provider)
  }
  await sleep(LATENCY * 10 + 300)
  sent = 0
  delivered = 0

  for (let m = 1; m <= MOVES; m++) {
    providers[0].appAwareness.setLocalStateField('cursor', { x: m })
    await sleep(150)
  }
  await sleep(LATENCY * 10 + 300)

  const ok = providers.every(
    (p) => p.appAwareness.getStates().get(providers[0].doc.clientID)?.cursor?.x === MOVES,
  )
  for (const p of providers) p.destroy()
  hub.clear()
  return { sent, delivered, ok }
}

async function main() {
  console.log(`Awareness frames for ${MOVES} cursor moves by one user`)
  console.log('    N | mode   | sent | delivered | all peers saw final state')
  for (const n of USER_COUNTS) {
    for (const relay of [true, false]) {
      const { sent, delivered, ok } = await run(n, relay)
      console.log(
        `${String(n).padStart(5)} | ${(relay ? 'relay' : 'direct').padEnd(6)} | ${String(sent).padStart(4)} | ${String(delivered).padStart(9)} | ${ok}`,
      )
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
