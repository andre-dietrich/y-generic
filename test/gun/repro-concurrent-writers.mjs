// Repro: several peers write at the same time - does every update reach a peer
// that listens?
//
//   npm install gun somewhere (inside this repo npm skips it, an optional peer dependency)
//   npx tsc -p tsconfig.bench.json
//   GUN=/path/to/node_modules/gun node test/gun/repro-concurrent-writers.mjs
//   WRITERS=5 FRAMES=40 EVERY_MS=250 override.
//
// Found by test/e2e/room-scenarios.mjs gun, SCENARIOS=join,storm (2026-09-22):
// ten peers typing a character every 250 ms, the lag typed -> seen elsewhere
// 13 s at the median and 52 s at p95 (WebSocket, Nostr: 0.1-0.3 s), nothing lost
// in the end - the core's resync filled every hole, slowly.
//
// The GunTransport's update slots are a ring of 20 keys under the ROOM's node
// (`updates/slot-0` ... `slot-19`), and every writer counts from slot-0: two
// writers put into the same key, and gun keeps the one it orders last. And the
// receiver's dedupe key is the slot and the 100 ms window it was written in -
// two writers in one slot within 100 ms are one update to it.
//
// The real GunTransport with gun's browser websocket adapter under Node: a relay
// (Docker/gun/relay.js), a listener L, WRITERS writer processes that send FRAMES
// marked frames each, one every EVERY_MS, started 50 ms apart. Reported: how many
// of the frames L heard live (3 s after the last one). Exit code 1 if one is missing.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fork, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const PORT = Number(process.env.GUN_RELAY_PORT ?? 8776)
const GUN = process.env.GUN ?? 'gun'
const WRITERS = Number(process.env.WRITERS ?? 5)
const FRAMES = Number(process.env.FRAMES ?? 40)
const EVERY_MS = Number(process.env.EVERY_MS ?? 250)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const role = process.argv[2]

if (!role) {
  const relay = spawn('node', [join(root, 'Docker/gun/relay.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_PATH: GUN === 'gun' ? process.env.NODE_PATH ?? '' : dirname(GUN) },
    stdio: 'ignore',
    cwd: mkdtempSync(join(tmpdir(), 'gun-writers-')),
  })
  await sleep(1000)
  const room = 'repro-' + Math.random().toString(36).slice(2, 10)
  const child = (...args) => {
    const p = fork(fileURLToPath(import.meta.url), [...args, room], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] })
    p.stdout.on('data', (d) => process.stdout.write(String(d)))
    return p
  }
  const listener = child('L')
  await sleep(1500)
  const writers = []
  for (let w = 0; w < WRITERS; w++) {
    writers.push(child('W', String(w)))
    await sleep(50)
  }
  await Promise.all(writers.map((p) => new Promise((resolve) => p.on('exit', resolve))))
  await sleep(3000)
  const heard = await new Promise((resolve) => {
    listener.on('message', resolve)
    listener.send('report')
  })
  listener.kill('SIGKILL')
  relay.kill('SIGKILL')
  const want = WRITERS * FRAMES
  const got = new Set(heard).size
  const perWriter = Array.from({ length: WRITERS }, (_, w) => new Set(heard.filter((k) => k.startsWith(`${w}.`))).size)
  console.log(`[repro] ${WRITERS} writers, ${FRAMES} frames each, one every ${EVERY_MS} ms: the listener heard ${got} of ${want} live (per writer: ${perWriter.join(' ')})`)
  process.exit(got === want ? 0 : 1)
}

const room = process.argv[process.argv.length - 1]
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
const heard = []
transport.onMessage((d) => d[4] === 0 && heard.push(`${d[5]}.${d[6]}`))
await transport.connect({ room })

if (role === 'W') {
  const w = Number(process.argv[3])
  await sleep(500)
  for (let n = 0; n < FRAMES; n++) {
    transport.send(new Uint8Array([0, 0, 0, 0, 0, w, n])) // CRC header, MESSAGE_SYNC, writer, frame
    await sleep(EVERY_MS)
  }
  await sleep(500)
  transport.disconnect()
  setTimeout(() => process.exit(0), 100)
}
if (role === 'L') {
  process.on('message', () => process.send(heard))
  await sleep(600000)
}
