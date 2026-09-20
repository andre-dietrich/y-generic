// Repro: does a GunTransport come back after its relay socket was gone for
// longer than two seconds - a relay restart, a frozen page (Chrome closes its
// WebSockets), a phone that slept?
//
//   npm install gun somewhere (inside this repo npm skips it, an optional peer dependency)
//   npx tsc -p tsconfig.bench.json
//   GUN=/path/to/node_modules/gun node test/gun/repro-relay-restart.mjs
//
// Found by test/e2e/room-scenarios.mjs gun (2026-09-20, 25 browsers): five
// pages frozen for 20 s never heard or reached anybody again, and after a 5 s
// relay restart EVERY peer was alone (rosters 1/1/1, editors different).
//
// gun 0.2020.1241's browser websocket adapter: wire.onclose calls
// reconnect(peer) - one attempt in 2 s - and then mesh.bye(peer), whose
// handler deletes the peer from opt.peers. If that one attempt fails,
// reconnect() returns at `if(!opt.peers[peer.url])`: Gun tries ONCE and gives
// up for good. This runs that adapter under Node (gun/gun.js with Node's
// global WebSocket; require('gun') would load the server adapter, which
// reconnects differently), in two processes (two Gun instances of one process
// share a graph and talk past the relay).
//
// Timeline: B sends a frame every second. The relay is killed at 8 s and back
// at 14 s. Reported by A: ms after the relay is back until it hears B again,
// and whether the provider was told (onPeerConnect). Exit code 1 on NEVER.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fork, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const PORT = Number(process.env.GUN_RELAY_PORT ?? 8769)
const GUN = process.env.GUN ?? 'gun'
const KILL_AT = 8000
const BACK_AT = 14000
const WATCH_MS = Number(process.env.WATCH_MS ?? 40000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const role = process.argv[2]

if (!role) {
  const cwd = mkdtempSync(join(tmpdir(), 'gun-repro-'))
  const startRelay = () =>
    spawn('node', [join(root, 'Docker/gun/relay.js')], {
      env: { ...process.env, PORT: String(PORT), NODE_PATH: GUN === 'gun' ? process.env.NODE_PATH ?? '' : dirname(GUN) },
      stdio: 'ignore',
      cwd,
    })
  let relay = startRelay()
  await sleep(1000)
  const room = 'repro-' + Math.random().toString(36).slice(2, 10)
  const t0 = Date.now()
  const child = (r) =>
    new Promise((resolve) => {
      const p = fork(fileURLToPath(import.meta.url), [r, room, String(t0)], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] })
      p.stdout.on('data', (d) => process.stdout.write(String(d)))
      p.on('exit', resolve)
    })
  const children = Promise.all([child('A'), child('B')])
  await sleep(KILL_AT)
  relay.kill('SIGKILL')
  await sleep(BACK_AT - KILL_AT)
  relay = startRelay()
  const codes = await children
  relay.kill('SIGKILL')
  process.exit(codes.some((c) => c !== 0) ? 1 : 0)
}

const room = process.argv[3]
const t0 = Number(process.argv[4])
let Gun
try {
  Gun = req(`${GUN}/gun.js`)
} catch {
  console.error('set GUN=/path/to/node_modules/gun')
  process.exit(2)
}
console.log = ((log) => (...a) => (/^\[repro\]/.test(String(a[0])) ? log(...a) : undefined))(console.log)
console.warn = () => {}
const { GunTransport } = req(join(root, 'bench-dist/src/providers/gun/index.js'))
const transport = new GunTransport({
  gun: Gun,
  peers: [`http://127.0.0.1:${PORT}/gun`],
  gunOptions: { WebSocket: globalThis.WebSocket, multicast: false },
})
const heard = [] // [ms after t0, marker]
let told = 0
transport.onMessage((d) => heard.push([Date.now() - t0, d[5]]))
transport.onPeerConnect?.(() => told++)
await transport.connect({ room })

if (role === 'B') {
  for (let k = 1; Date.now() - t0 < BACK_AT + WATCH_MS; k++) {
    transport.send(new Uint8Array([0, 0, 0, 0, 0, k % 250])) // CRC header, MESSAGE_SYNC, marker
    await sleep(1000)
  }
  process.exit(0)
}

while (Date.now() - t0 < BACK_AT + WATCH_MS && !heard.some(([ms]) => ms > BACK_AT)) await sleep(100)
const before = heard.filter(([ms]) => ms < KILL_AT).length
const after = heard.find(([ms]) => ms > BACK_AT)
console.log(`[repro] baseline: A heard ${before} frames of B before the relay was killed`)
console.log(`[repro] relay down for ${(BACK_AT - KILL_AT) / 1000} s: A hears B again ${after ? `${after[0] - BACK_AT} ms after it is back` : `NEVER (${WATCH_MS / 1000} s watched)`}`)
console.log(`[repro] provider told that the relay is back (onPeerConnect): ${told} times (want 1)`)
process.exit(before > 0 && after && told === 1 ? 0 : 1)
