/**
 * End-to-end check against a real y-websocket-style server (the edrys relay,
 * a y-websocket fork that handles opcodes 0/1 on its own doc and relays
 * everything else verbatim). Two clients with the options edrys-Lite's
 * GenericWebsocketProviderAdapter passes:
 *
 *   1. late joiner B receives state A wrote BEFORE B connected (the server's
 *      SyncStep2 answer to the transport's y-websocket handshake)
 *   2. A's edit AFTER both are connected reaches B
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
 */
import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { WebSocketTransport } from '../../src/providers/websocket/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PORT = process.env.PORT || '4455'
const MODE = process.env.MODE || 'push-pull'

function mk(id: string) {
  const doc = new Y.Doc()
  const p = new GenericProvider(doc, new WebSocketTransport(), {
    verifyUpdates: false, // the server does not speak MESSAGE_SYNC_VERIFIED
    syncMode: MODE, // fork-only option; excess key is harmless upstream
    localId: id,
  } as any)
  return { doc, p }
}

async function main() {
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

  console.log(
    `MODE=${MODE}: late joiner got pre-existing state: ${lateJoin ? 'YES' : 'NO'} | post-connect edit arrived: ${laterEdit ? 'YES' : 'NO'}`,
  )
  a.p.destroy()
  b.p.destroy()
  setTimeout(() => process.exit(lateJoin && laterEdit ? 0 : 1), 300)
}

main()
