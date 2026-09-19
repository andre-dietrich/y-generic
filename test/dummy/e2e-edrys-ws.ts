/**
 * End-to-end check against a real y-websocket-style server (the edrys relay,
 * a y-websocket fork that handles opcodes 0/1 on its own doc and relays
 * everything else verbatim). Two clients with the options edrys-Lite's
 * GenericWebsocketProviderAdapter passes:
 *
 *   1. late joiner B receives state A wrote BEFORE B connected (the server's
 *      SyncStep2 answer to the transport's y-websocket handshake)
 *   2. A's edit AFTER both are connected reaches B
 *   3. A types with a cursor: the first keystroke leaves together with a
 *      pending awareness update, the rest alone - does all of it reach B?
 *      (Found with 25 real browsers, test/e2e/room-scenarios.mjs: the
 *      piggybacked keystroke travelled as MESSAGE_BATCH, which the server
 *      relays but does not apply to its own doc; every later plain update
 *      depended on it, stayed pending in the server's doc and was never
 *      broadcast - typed text reached nobody.)
 *   4. A's socket dies and reconnects (a phone back from the background):
 *      the server dropped A's presence when the socket closed - how long
 *      until B and C list A again? (Before: A re-sent its state at the
 *      clock the room had just seen removed, which y-protocols ignores;
 *      A came back with its next renewal, up to a lease later.)
 *   5. (needs SERVER_JS) the relay restarts with an empty document; A then
 *      types. Does the text reach B and C? (Before, with 3+ clients: the
 *      server asks every client for its state with a plain SyncStep1; the
 *      reply was delayed by the reply suppression and then cancelled by
 *      the server's own - empty - SyncStep2, nobody refilled the server's
 *      doc, and every later update stayed pending there.)
 *
 * Before the handshake in WebSocketTransport.onopen, push-pull failed both
 * (2026-09-11): the provider only sends digest beacons, which the server
 * relays but never answers, so a joiner never pulled the server's document
 * and later edits stuck as pending dependencies. syncMode:'pull' (dev fork)
 * passed only because A withholds edits until asked.
 *
 * Server:
 *   git clone https://github.com/edrys-labs/edrys-websocket-server
 *   cd edrys-websocket-server && npm install --omit=dev
 *   PORT=4455 HOST=127.0.0.1 node src/server.js
 * Run:
 *   npx tsc -p tsconfig.bench.json && \
 *     PORT=4455 node bench-dist/test/dummy/e2e-edrys-ws.js
 *   MODE=pull selects the fork's syncMode (ignored by upstream).
 *   SERVER_JS=/path/to/edrys-websocket-server/src/server.js lets this script
 *   start (and, for check 5, restart) the relay itself on PORT.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { WebSocketTransport } from '../../src/providers/websocket/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PORT = process.env.PORT || '4455'
const MODE = process.env.MODE || 'push-pull'

const SERVER_JS = process.env.SERVER_JS
let relay: ChildProcess | undefined
function startRelay() {
  if (!SERVER_JS) return
  relay = spawn('node', [SERVER_JS], {
    env: { ...process.env, PORT, HOST: '127.0.0.1' },
    stdio: 'ignore',
  })
}

function mk(id: string) {
  const doc = new Y.Doc()
  const transport = new WebSocketTransport()
  const p = new GenericProvider(doc, transport, {
    verifyUpdates: false, // the server does not speak MESSAGE_SYNC_VERIFIED
    syncMode: MODE, // fork-only option; excess key is harmless upstream
    localId: id,
  } as any)
  return { doc, p, transport }
}

/** ms until cond() holds, -1 after timeoutMs. */
async function until(cond: () => boolean, timeoutMs: number): Promise<number> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return Date.now() - t0
    await sleep(50)
  }
  return -1
}

async function main() {
  startRelay()
  if (SERVER_JS) await sleep(1500)
  const room = 'e2e-' + Math.random().toString(36).slice(2)
  const url = `ws://127.0.0.1:${PORT}`
  const a = mk('A')
  await a.p.connect({ room, serverUrl: url } as any)
  await sleep(500)
  a.doc.getMap('m').set('before', 1)
  await sleep(1500)

  const b = mk('B')
  await b.p.connect({ room, serverUrl: url } as any)
  await sleep(2500)
  const lateJoin = b.doc.getMap('m').get('before') === 1

  a.doc.getMap('m').set('after', 2)
  await sleep(2500)
  const laterEdit = b.doc.getMap('m').get('after') === 2

  // 3. typing with a cursor: two awareness changes in a row - the first goes
  // out at once, the second waits in the throttle and rides with the first
  // keystroke; the following keystrokes travel alone.
  const text = a.doc.getText('t')
  a.p.awareness.setLocalStateField('cursor', { index: 0 })
  a.p.awareness.setLocalStateField('cursor', { index: 1 })
  for (const ch of 'typed with a cursor') {
    text.insert(text.length, ch)
    await sleep(15)
  }
  await sleep(3000)
  const typed = b.doc.getText('t').toString() === 'typed with a cursor'

  console.log(
    `MODE=${MODE}: late joiner got pre-existing state: ${lateJoin ? 'YES' : 'NO'} | post-connect edit arrived: ${laterEdit ? 'YES' : 'NO'} | text typed with a cursor arrived: ${typed ? 'YES' : `NO ("${b.doc.getText('t').toString()}")`}`,
  )

  // 4. A's socket dies and comes back; a third client makes it a room where
  // the reply suppression engages (>= 2 known peers).
  const c = mk('C')
  await c.p.connect({ room, serverUrl: url } as any)
  for (const x of [a, b, c]) x.p.awareness.setLocalStateField('user', { name: 'x' })
  await sleep(2500)
  const lists = (x: typeof a, y: typeof a) => x.p.awareness.getStates().has(y.doc.clientID)
  ;(a.transport as any).ws.close() // what the OS does to a backgrounded page's socket
  const dropped = await until(() => !lists(b, a) && !lists(c, a), 10000)
  const back = await until(() => lists(b, a) && lists(c, a), 40000)
  console.log(
    `A's socket died: dropped from the rosters after ${dropped} ms, listed again after ${back < 0 ? 'NEVER (40 s)' : back + ' ms'}`,
  )

  // 5. the relay restarts empty, then A types
  let afterRestart = true
  if (SERVER_JS) {
    relay!.kill('SIGKILL')
    await sleep(3000)
    startRelay()
    await sleep(15000) // reconnect backoff
    const t = a.doc.getText('t')
    t.insert(t.length, ' - and after the restart')
    const arrived = await until(
      () => [b, c].every((x) => x.doc.getText('t').toString().endsWith('after the restart')),
      30000,
    )
    afterRestart = arrived >= 0
    console.log(`relay restarted empty: text typed afterwards arrived after ${arrived < 0 ? 'NEVER (30 s)' : arrived + ' ms'}`)
  }

  for (const x of [a, b, c]) x.p.destroy()
  relay?.kill('SIGKILL')
  setTimeout(() => process.exit(lateJoin && laterEdit && typed && back >= 0 && afterRestart ? 0 : 1), 300)
}

main()
