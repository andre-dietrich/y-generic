/**
 * Benchmark: the room is told that a peer is gone - wrongly - at a presence
 * clock that peer has long passed. Does the peer say that it is still there?
 *
 * y-protocols never lets a remote removal delete the local state: it raises the
 * clock and reports the change, and the provider re-announces itself at once.
 * That only happens when the removal arrives at the clock the peer holds. An
 * editor binding re-sets its cursor with every remote edit (y-quill: twelve
 * characters typed by somebody else raised an idle peer's clock from 2 to 13) -
 * an equal state, and since round 5 (item 8) an equal state is not broadcast.
 * So the local clock runs ahead of what the room knows. A removal at the room's
 * clock is then older than the local one: y-protocols ignores it, nobody tells
 * the provider, and the peer stays out of every roster until it sends something
 * by itself - its renewal, half a lease later.
 *
 * Found with 25 browsers on the WebSocket playground (test/e2e/room-scenarios.mjs
 * websocket, IDLE_MS=45000): a y-websocket server runs y-protocols' awareness
 * with its fixed 30 s timeout, the playground renewed every 60 s (a 120 s lease) -
 * rosters of 2-3 of 24 from second 30 to second 60, again and again. Any wrong
 * removal does it: a peer with a slow clock, a relay that expires entries.
 *
 * Three peers on a hub. B re-sets its unchanged state RESETS times (nothing is
 * sent). A then tells the room that B is gone, at the clock the room knows - what
 * the server's timeout did. Reported: after how long A and C list B again.
 * RESETS=0 is the control: the removal arrives at B's own clock and y-protocols'
 * path heals it. Exit code 1 if it takes longer than 1 s.
 *
 * Part 2, the same re-sets and the renewal: y-protocols stamps `lastUpdated` with
 * every setLocalState(), also an equal one, and the sweep renewed by that stamp -
 * so a peer whose binding re-sets its cursor once a second believed it had just
 * renewed, for as long as somebody typed, while nothing had left the page. A
 * y-websocket server reads presence messages only (a digest tells it nothing): a
 * real phone saw its roster fall to 3-6 of 9 every 30 s, the server's timeout,
 * with the DEFAULT lease - eight browsers, one typing. B re-sets its unchanged
 * state once a second for three leases: the longest time A heard no presence of B
 * (want under 0.8 leases in y-websocket mode, `verifyUpdates: false`), and whether
 * A listed B the whole time.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-removed-at-old-clock.js
 *      RESETS=12 LEASE_MS=20000 RENEW_LEASE_MS=6000 override.
 */

import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const LEASE_MS = Number(process.env.LEASE_MS ?? 20000)

async function run(resets: number): Promise<number> {
  let backMs = -1
  await silenced(async () => {
    const hub = new DummyHub()
    const room = `bench-old-clock-${Math.random().toString(36).slice(2)}`
    const make = async (name: string) => {
      const provider = new GenericProvider(new Y.Doc(), new DummyTransport({ hub, latency: 5 }), { disableBc: true, awarenessTimeoutMs: LEASE_MS })
      await provider.connect({ room })
      provider.awareness.setLocalStateField('user', { name })
      return provider
    }
    const a = await make('A')
    const b = await make('B')
    const c = await make('C')
    await sleep(1500)
    const lists = (x: GenericProvider) => x.awareness.getStates().has(b.doc.clientID)
    if (!lists(a) || !lists(c)) throw new Error('setup: B is not in every roster')

    // What an editor binding does with every remote edit: the same state, set again.
    for (let i = 0; i < resets; i++) b.awareness.setLocalState(b.awareness.getLocalState())
    await sleep(300)

    // A tells the room that B is gone, at the clock the room knows (not 'timeout': that one is suppressed).
    awarenessProtocol.removeAwarenessStates(a.awareness, [b.doc.clientID], 'a server that expired it')
    const t0 = Date.now()
    while (Date.now() - t0 < LEASE_MS) {
      await sleep(25)
      if (Date.now() - t0 > 200 && lists(a) && lists(c)) {
        backMs = Date.now() - t0
        break
      }
    }
    for (const p of [a, b, c]) p.destroy()
    hub.clear()
  })
  return backMs
}

/** Part 2: B re-sets its unchanged state once a second. Longest silence of B's presence at A, and was B listed throughout? */
async function renewal(verifyUpdates: boolean, lease: number): Promise<{ gapMs: number; listed: boolean }> {
  let result = { gapMs: -1, listed: false }
  await silenced(async () => {
    const hub = new DummyHub()
    const room = `bench-renewal-${Math.random().toString(36).slice(2)}`
    const make = async (name: string) => {
      const provider = new GenericProvider(new Y.Doc(), new DummyTransport({ hub, latency: 5 }), { disableBc: true, awarenessTimeoutMs: lease, verifyUpdates })
      await provider.connect({ room })
      provider.awareness.setLocalStateField('user', { name })
      return provider
    }
    const a = await make('A')
    const b = await make('B')
    await sleep(1500)
    let heardAt = Date.now()
    let gapMs = 0
    let listed = true
    a.awareness.on('update', ({ added, updated }: { added: number[]; updated: number[] }) => {
      if (!added.includes(b.doc.clientID) && !updated.includes(b.doc.clientID)) return
      gapMs = Math.max(gapMs, Date.now() - heardAt)
      heardAt = Date.now()
    })
    const resets = setInterval(() => b.awareness.setLocalState(b.awareness.getLocalState()), 1000)
    const t0 = Date.now()
    while (Date.now() - t0 < 3 * lease) {
      await sleep(100)
      if (!a.awareness.getStates().has(b.doc.clientID)) listed = false
    }
    clearInterval(resets)
    result = { gapMs: Math.max(gapMs, Date.now() - heardAt), listed }
    for (const p of [a, b]) p.destroy()
    hub.clear()
  })
  return result
}

async function main() {
  console.log(`the room is told that B is gone, at the clock it knows of B (lease ${LEASE_MS} ms, so a renewal after ${LEASE_MS / 2} ms):`)
  let failed = 0
  for (const resets of [0, Number(process.env.RESETS ?? 12)]) {
    const ms = await run(resets)
    if (ms < 0 || ms > 1000) failed++
    console.log(`  B had re-set its unchanged state ${String(resets).padStart(2)} times: back in every roster after ${ms < 0 ? `NEVER (${LEASE_MS} ms watched)` : `${ms} ms`}`)
  }
  const lease = Number(process.env.RENEW_LEASE_MS ?? 6000)
  console.log(`B re-sets its unchanged state once a second for three leases of ${lease} ms and does nothing else:`)
  for (const verifyUpdates of [false, true]) {
    const { gapMs, listed } = await renewal(verifyUpdates, lease)
    const ok = listed && (verifyUpdates || gapMs < 0.8 * lease)
    if (!ok) failed++
    console.log(`  ${verifyUpdates ? 'verified mode      ' : 'y-websocket mode   '}: A heard no presence of B for up to ${gapMs} ms, listed B ${listed ? 'the whole time' : 'NOT the whole time'}${ok ? '' : '   <- FAIL'}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
