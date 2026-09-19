/**
 * Benchmark: a phone wakes up after sleeping longer than its awareness
 * lease - what does its first sweep tick do to the room's roster?
 *
 * A suspended page runs no timers and hears no renewals; when it resumes,
 * Date.now() has jumped by the length of the sleep and every remote
 * `lastUpdated` looks expired. The sweep (_startAwarenessSweep) removes
 * them all with origin 'timeout' and broadcasts the removal. Receivers
 * apply it (a null state at an equal clock is the one equal-clock update
 * y-protocols accepts): every bystander drops every other bystander, each
 * peer sees its own removal and re-announces itself.
 *
 * N providers on one DummyHub relay; the phone has a PHONE_LEASE_MS lease,
 * everybody else a one-hour lease, so only the phone's sweep reacts when
 * Date.now() is pushed forward by JUMP_MS (both shorter than the hour: the
 * jump is one-sided, as on a real phone). Reported for the WATCH_MS after
 * the jump: roster entries the bystanders lost, deliveries on the wire, and
 * when the phone's and the bystanders' rosters were complete again.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-wake-false-timeout.js
 *      N=10 PHONE_LEASE_MS=20000 JUMP_MS=60000 WATCH_MS=8000 override.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyTransport, DummyHub } from '../../src/providers/dummy/index'
import { instrumentHub, sleep } from './bench-user-scaling'

const N = Number(process.env.N ?? 10)
const PHONE_LEASE_MS = Number(process.env.PHONE_LEASE_MS ?? 20000)
const JUMP_MS = Number(process.env.JUMP_MS ?? 60000)
const WATCH_MS = Number(process.env.WATCH_MS ?? 8000)

async function main() {
  const hub = new DummyHub()
  const counter = instrumentHub(hub)
  const peers = Array.from({ length: N }, (_, i) => {
    const doc = new Y.Doc()
    const provider = new GenericProvider(doc, new DummyTransport({ hub, latency: 20 }), {
      awarenessTimeoutMs: i === 0 ? PHONE_LEASE_MS : 3600000,
    })
    provider.awareness.setLocalState({ name: i === 0 ? 'phone' : `desk-${i}` })
    return { doc, provider }
  })
  for (const p of peers) await p.provider.connect({ room: 'r' })
  await sleep(2500)
  const roster = (p: (typeof peers)[number]) => p.provider.awareness.getStates().size
  if (!peers.every((p) => roster(p) === N)) throw new Error('setup: rosters incomplete')

  // Bystanders: count every roster entry they lose after the jump.
  let lost = 0
  for (const p of peers.slice(1)) {
    p.provider.awareness.on('change', ({ removed }: { removed: number[] }) => (lost += removed.length))
  }

  const realNow = Date.now
  const before = counter.messages
  const jumpedAt = realNow()
  Date.now = () => realNow() + JUMP_MS

  let phoneMin = N
  let phoneBackAt = -1
  let allBackAt = -1
  while (realNow() - jumpedAt < WATCH_MS) {
    await sleep(25)
    const t = realNow() - jumpedAt
    phoneMin = Math.min(phoneMin, roster(peers[0]))
    if (phoneMin < N && phoneBackAt < 0 && roster(peers[0]) === N) phoneBackAt = t
    if (lost > 0 && allBackAt < 0 && peers.every((p) => roster(p) === N)) allBackAt = t
  }
  Date.now = realNow

  console.log(`N=${N}, phone lease ${PHONE_LEASE_MS} ms, clock jump ${JUMP_MS} ms, watched ${WATCH_MS} ms`)
  console.log(`  phone's roster dropped to:            ${phoneMin} of ${N}${phoneMin < N ? `, complete again after ${phoneBackAt < 0 ? 'never' : phoneBackAt + ' ms'}` : ''}`)
  console.log(`  roster entries lost by bystanders:    ${lost}${lost > 0 ? `, all rosters complete again after ${allBackAt < 0 ? 'never' : allBackAt + ' ms'}` : ''}`)
  console.log(`  deliveries in the window:             ${counter.messages - before}`)

  for (const p of peers) p.provider.destroy()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
