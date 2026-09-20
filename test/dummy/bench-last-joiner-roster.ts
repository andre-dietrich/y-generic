/**
 * Benchmark: does the LAST peer to join a relay room get the whole roster?
 *
 * Presence on demand (phase 1e): a JOIN beacon is answered by one relayer -
 * the first-ranked peer of a 2 s bucket - with the whole presence table, and
 * every other peer waits a window (clamp(2 x RTT, 100, 500) ms) and stays
 * silent if a table it overheard carried its state.
 *
 * Found by test/e2e/room-scenarios.mjs (25 browsers, 2026-09-20): every few
 * runs the last joiner's roster lacked 7-8 of 24 peers - every third one -
 * until their presence renewals, half a lease later: 80 s and 73 s on Nostr
 * (120 s lease), 27 s on PubNub (30 s). Earlier joiners have the same gap and
 * never show it: the answers to the next JOIN heal them.
 *
 * "Covered" was one flag per response timer, not per requester. A peer whose
 * timer was already running - started by the JOIN before - took the next
 * JOIN into the same timer, still marked covered by the table it had
 * overheard BEFORE that joiner was even subscribed. When the relayer role
 * had just moved on to a peer with such a running timer (it is only
 * evaluated when a timer starts), nobody relayed a table for the new JOIN
 * either, and the covered peers kept silent. Needs a window longer than the
 * gap between two joins: a transport with an RTT hint (Nostr 600 ms, Gun,
 * Matrix) or a slow link.
 *
 * N peers join GAP_MS apart on a relay hub (no unicast, no peer events),
 * with Nostr's RTT hint; the join before the last lands 300 ms before a 2 s
 * bucket boundary, the last one 50 ms after it. Reported: how many of RUNS
 * left the last joiner's roster incomplete 3 s later. Exit code 1 if any did.
 * (Not every run crosses a relayer CHANGE - the same peer can rank first in
 * both buckets - so the unfixed build fails in about two runs of three.)
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-last-joiner-roster.js
 *      N=12 GAP_MS=200 RUNS=12 RTT_HINT_MS=600 override.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const N = Number(process.env.N ?? 12)
const GAP_MS = Number(process.env.GAP_MS ?? 200)
const RUNS = Number(process.env.RUNS ?? 12)
const RTT_HINT_MS = Number(process.env.RTT_HINT_MS ?? 600)

async function run(): Promise<string[]> {
  let missing: string[] = []
  await silenced(async () => {
    const hub = new DummyHub()
    const room = `bench-last-joiner-${Math.random().toString(36).slice(2)}`
    const providers: GenericProvider[] = []
    for (let i = 0; i < N; i++) {
      const transport = new DummyTransport({ hub, latency: 5, jitter: 0.25 })
      Object.defineProperty(transport, 'expectedRttMs', { get: () => RTT_HINT_MS })
      const provider = new GenericProvider(new Y.Doc(), transport, { disableBc: true, awarenessTimeoutMs: 120000 })
      providers.push(provider)
      // As the playgrounds do: presence is set once connect() has resolved.
      provider.connect({ room }).then(() => provider.awareness.setLocalStateField('user', { name: 'p' + i }))
      if (i === N - 3) await sleep(2000 - ((Date.now() + 300) % 2000))
      else if (i === N - 2) await sleep(350)
      else await sleep(GAP_MS)
    }
    await sleep(3000)
    const seen = new Set(Array.from(providers[N - 1].awareness.getStates().values()).map((s) => (s as any).user?.name))
    missing = providers.map((_, i) => 'p' + i).filter((name) => !seen.has(name))
    for (const p of providers) p.destroy()
    hub.clear()
  })
  return missing
}

async function main() {
  console.log(`last joiner's roster: N=${N}, joins ${GAP_MS} ms apart, RTT hint ${RTT_HINT_MS} ms, the last join 50 ms after a relayer bucket boundary`)
  let incomplete = 0
  for (let r = 0; r < RUNS; r++) {
    const missing = await run()
    if (missing.length > 0) {
      incomplete++
      console.log(`  run ${r}: the last joiner sees ${N - missing.length} of ${N}, missing ${missing.join(' ')}`)
    }
  }
  console.log(`=> the last joiner's roster was incomplete 3 s after its join in ${incomplete} of ${RUNS} runs`)
  process.exit(incomplete > 0 ? 1 : 0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
