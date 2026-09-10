/**
 * Repro: app-channel (module cursor) awareness must reach a peer that joins
 * after the state was set, on both a broadcast and a mesh transport.
 *
 * This is the monaco-editor cursor path in edrys-Lite: the module calls
 * Edrys.getState(..., 'Awareness'), which reaches GenericProvider.appAwareness
 * through the adapters, and sets a `user` field once in onReady(). Whichever
 * peer joins second must still see the first peer's cursor.
 *
 * Two regressions this covers, both from the v1.5.0 merge:
 *  1. connect() announced app state only when `_appAwareness` already existed.
 *     With the lazy getter, a module that touches the channel AFTER connect()
 *     (the normal case - onReady fires later) never announced at all.
 *  2. _schedulePeerConnectSync()'s digest-beacon rewrite dropped the
 *     pre-merge second _broadcastAwareness() on the app channel, so on mesh
 *     transports a late joiner was never told about existing cursors.
 *
 * Run:
 *   npx tsc -p tsconfig.bench.json && \
 *     node bench-dist/test/dummy/repro-app-awareness-late-join.js
 */
import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeProvider(hub: DummyHub, mesh: boolean) {
  const doc = new Y.Doc()
  const transport = new DummyTransport({
    hub,
    latency: 10,
    simulatePeerConnect: mesh,
    unicast: mesh,
  })
  const provider = new GenericProvider(doc, transport, {
    batchUpdates: 0,
    syncInterval: 0,
  })
  return { doc, provider }
}

async function scenario(mesh: boolean): Promise<boolean> {
  const hub = new DummyHub()
  const room = `repro-${Math.random().toString(36).slice(2)}`

  const a = makeProvider(hub, mesh)
  await a.provider.connect({ room })

  // Peer A's module sets its cursor AFTER connect() - as onReady() does.
  a.provider.appAwareness.setLocalStateField('user', { name: 'alice' })
  await sleep(200)

  // Peer B joins late and sets its own cursor.
  const b = makeProvider(hub, mesh)
  await b.provider.connect({ room })
  b.provider.appAwareness.setLocalStateField('user', { name: 'bob' })

  await sleep(800)

  const names = (p: GenericProvider) =>
    [...p.appAwareness.getStates().values()]
      .map((s: any) => s?.user?.name)
      .filter(Boolean)
      .sort()

  const seenByA = names(a.provider)
  const seenByB = names(b.provider)

  // The app channel must not have touched core presence state.
  const coreLeak = [...a.provider.awareness.getStates().values()].some(
    (s: any) => s?.user?.name === 'bob' || s?.user?.name === 'alice',
  )

  const label = mesh ? 'mesh (unicast + onPeerConnect)' : 'broadcast'
  console.log(`\n--- ${label} ---`)
  console.log('  A sees:', seenByA)
  console.log('  B sees:', seenByB)

  const bothSeeBoth =
    seenByA.join() === 'alice,bob' && seenByB.join() === 'alice,bob'

  console.log(
    bothSeeBoth
      ? '  PASS: both peers see both cursors'
      : '  FAIL: a cursor is missing',
  )
  console.log(
    coreLeak
      ? '  FAIL: app state leaked into core awareness'
      : '  PASS: channels disjoint',
  )

  a.provider.destroy()
  b.provider.destroy()
  return bothSeeBoth && !coreLeak
}

async function main() {
  const broadcast = await scenario(false)
  const mesh = await scenario(true)
  console.log(
    `\nRESULT: ${broadcast && mesh ? 'PASS' : 'FAIL'} (broadcast=${broadcast}, mesh=${mesh})`,
  )
  process.exit(broadcast && mesh ? 0 : 1)
}

main()
