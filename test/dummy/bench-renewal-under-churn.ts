/**
 * Benchmark: do the settled peers of a mesh room stay in each other's rosters
 * while other peers come and go?
 *
 * Found by test/e2e/room-scenarios.mjs with 50 browsers (2026-09-20): the run
 * is long enough to outlive a presence lease (300 s on a transport that
 * reports departures), and eight minutes in most peers were listed in exactly
 * two rosters - their own and the newest peer's - while all 49 links stood and
 * text still arrived everywhere in milliseconds.
 *
 * A peer renews its presence to the room when its own state is half a lease
 * old (_startAwarenessSweep: `lease / 2 <= now - mine.lastUpdated`). Since
 * round 8 every link that opens bumps the local clock so the new peer accepts
 * our state (_schedulePeerConnectSync) - through awareness.setLocalState(),
 * which also sets `lastUpdated`. The bumped state goes to the NEW link only,
 * but the renewal timer starts over for the whole room: with a join, a reload
 * or a resume more often than every half lease a settled peer never renews,
 * and everybody but the newcomers expires it.
 *
 * M settled peers on a mesh-like hub (peer events + unicast), lease LEASE_MS;
 * a visitor joins every VISIT_MS and leaves again. Reported: the smallest
 * number of settled peers any settled peer had in its roster, sampled from
 * one lease in until three. Exit code 1 if it ever was below M.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-renewal-under-churn.js
 *      M=6 LEASE_MS=4000 VISIT_MS=1200 override.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const M = Number(process.env.M ?? 6)
const LEASE_MS = Number(process.env.LEASE_MS ?? 4000)
const VISIT_MS = Number(process.env.VISIT_MS ?? 1200)

async function main() {
  let smallest = M
  let at = 0
  await silenced(async () => {
    const hub = new DummyHub()
    const room = `bench-renewal-${Math.random().toString(36).slice(2)}`
    const join = async (name: string) => {
      const transport = new DummyTransport({ hub, latency: 5, simulatePeerConnect: true, unicast: true })
      const provider = new GenericProvider(new Y.Doc(), transport, { disableBc: true, awarenessTimeoutMs: LEASE_MS })
      await provider.connect({ room })
      provider.awareness.setLocalStateField('user', { name })
      return provider
    }
    const settled: GenericProvider[] = []
    for (let i = 0; i < M; i++) settled.push(await join('s' + i))
    const ids = settled.map((p) => p.doc.clientID)

    const t0 = Date.now()
    let nextVisit = t0
    let visitor: GenericProvider | undefined
    while (Date.now() - t0 < 3 * LEASE_MS) {
      if (Date.now() >= nextVisit) {
        visitor?.destroy()
        visitor = await join('visitor')
        nextVisit += VISIT_MS
      }
      await sleep(100)
      if (Date.now() - t0 < LEASE_MS) continue
      for (const p of settled) {
        const seen = ids.filter((id) => p.awareness.getStates().has(id)).length
        if (seen < smallest) {
          smallest = seen
          at = Date.now() - t0
        }
      }
    }
    visitor?.destroy()
    for (const p of settled) p.destroy()
    hub.clear()
  })
  console.log(`renewal under churn: ${M} settled peers, lease ${LEASE_MS} ms, a visitor every ${VISIT_MS} ms, watched for three leases`)
  console.log(
    smallest === M
      ? `=> every settled peer saw all ${M} settled peers the whole time`
      : `=> a settled peer's roster was down to ${smallest} of ${M} settled peers (first seen ${at} ms in)`,
  )
  process.exit(smallest === M ? 0 : 1)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
