// Repro: what is left of a NostrTransport's subscription after its relay
// socket closed - a relay restart, a phone whose page was frozen (Chrome
// closes a frozen page's WebSockets), a network switch.
//
//   npm install nostr-tools somewhere (inside this repo npm prunes it again)
//   npx tsc -p tsconfig.bench.json
//   NOSTR_TOOLS=/path/to/node_modules/nostr-tools node test/nostr/repro-relay-restart.mjs
//
// Found by test/e2e/room-scenarios.mjs nostr (2026-09-19): after a relay
// restart the relay saw 24 connections and 67 EVENTs of four peers, and ONE
// REQ - the new peer's. nostr-tools re-opens a socket for every publish
// (ensureRelay) but closes the subscriptions of a relay whose socket closed
// for good (closeAllSubscriptions, unless the pool was built with
// enableReconnect): a peer that keeps sending and never hears anybody again.
//
//  1 restart      A and B connected, the relay is killed for 2 s. B sends
//                 once a second: ms after the restart until A hears B.
//  2 down at join the relay is down while C connects (connect() resolves
//                 all the same), then starts. Until C hears B.
//  3 told         is the provider told that the peer hears again
//                 (onPeerConnect)? Hearing again is not having what was said
//                 meanwhile: 25 peers, 5 pages frozen for 20 s - the five
//                 had the missed text 21.9 s after the unfreeze, with the
//                 next beacon somebody happened to send. Want: never at the
//                 first subscription, once per return.
// 1 and 2 must be a number, 3 must hold. Exit code 1 otherwise (30 s watched).
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import os from 'node:os'

const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const PORT = Number(process.env.NOSTR_RELAY_PORT ?? 8767)
const WATCH_MS = Number(process.env.WATCH_MS ?? 30000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tools = process.env.NOSTR_TOOLS ?? 'nostr-tools'
let pure, pool
try {
  pure = req(`${tools}/lib/cjs/pure.js`)
  pool = req(`${tools}/lib/cjs/pool.js`)
} catch {
  console.error('set NOSTR_TOOLS=/path/to/node_modules/nostr-tools')
  process.exit(2)
}
const { NostrTransport } = req(join(root, 'bench-dist/src/providers/nostr/index.js'))

let relay = null
const startRelay = () => {
  relay = fork(join(root, 'Docker/nostr/relay.js'), [], {
    env: { ...process.env, PORT: String(PORT), SNAPSHOT_FILE: join(os.tmpdir(), `nostr-repro-${process.pid}.json`) },
    stdio: 'ignore',
  })
  return sleep(500)
}
const stopRelay = () => {
  relay?.kill('SIGKILL')
  relay = null
}

const room = 'repro-' + Math.random().toString(36).slice(2, 10)
const peer = async () => {
  const t = new NostrTransport({ finalizeEvent: pure.finalizeEvent, getPublicKey: pure.getPublicKey, SimplePool: pool.SimplePool })
  const heard = []
  const p = { t, heard, told: 0 }
  t.onMessage((d) => heard.push(d[0]))
  t.onPeerConnect?.(() => p.told++)
  await t.connect({ room, relays: [`ws://127.0.0.1:${PORT}`], historyWindowSecs: 0 })
  return p
}

/** B sends `mark` once a second; ms until `listener` heard it, or -1. */
async function untilHeard(sender, listener, mark) {
  const t0 = Date.now()
  while (Date.now() - t0 < WATCH_MS) {
    sender.t.send(new Uint8Array([mark])).catch(() => {})
    await sleep(1000)
    if (listener.heard.includes(mark)) return Date.now() - t0
  }
  return -1
}
const fmt = (ms) => (ms < 0 ? `NEVER (${WATCH_MS / 1000} s watched)` : `${ms} ms`)

await startRelay()
const a = await peer()
const b = await peer()
await sleep(500)
console.log(`baseline: A hears B after ${fmt(await untilHeard(b, a, 1))}`)
const toldAtFirst = a.told

stopRelay()
await sleep(2000)
await startRelay()
const restart = await untilHeard(b, a, 2)
console.log(`1 restart: A hears B again after ${fmt(restart)}`)

stopRelay()
await sleep(500)
const c = await peer() // resolves with no relay reachable
await sleep(2000)
await startRelay()
const downAtJoin = await untilHeard(b, c, 3)
console.log(`2 down at join: C hears B after ${fmt(downAtJoin)}`)

const told = toldAtFirst === 0 && a.told === 2 && c.told === 1
console.log(`3 told: A at its first subscription ${toldAtFirst} (want 0), after two relay restarts ${a.told} (want 2), C ${c.told} (want 1)`)

for (const p of [a, b, c]) p.t.disconnect()
stopRelay()
process.exit(restart < 0 || downAtJoin < 0 || !told ? 1 : 0)
