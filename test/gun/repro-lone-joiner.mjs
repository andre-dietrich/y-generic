// Repro: a room whose peers are ALL gone - does a joiner get the document from
// what the relay holds?
//
//   npm install gun somewhere (inside this repo npm skips it, an optional peer dependency)
//   npx tsc -p tsconfig.bench.json
//   GUN=/path/to/node_modules/gun node test/gun/repro-lone-joiner.mjs
//
// Seen on the way through round 10 (2026-09-21), the same on v1.8.5: a writer
// sends three updates, a live witness hears them, the writer leaves; a joiner
// that connects to the empty room afterwards hears none of them - "Loading
// initial state... Initial state loaded" and nothing. With a peer in the room
// the core's sync covers it; alone, the relay's replay is all there is, and the
// README promises "Persistence: Built-in" (non-persistent mode: the circular
// buffer of update slots).
//
// Cause: the update listener loaded the node with `.once()` first and skipped
// every `.map()` answer until that had called back - which was every replayed
// slot (gun's once waits 99 ms for more answers, the slots' own answers are in
// by then), and the once callback itself sees the node's links, not the slots'
// data. The same skip lost the FIRST update of a fresh room to a peer that had
// subscribed a moment before it (a witness 50 ms in the room heard the second
// and third of three; 3 s in the room, all three): the once had not called
// back yet. One listener for everything now, processedUpdates dedupes.
//
// The real GunTransport with gun's browser websocket adapter under Node, three
// processes: A the witness, W the writer (three frames, one a second, after a
// 1.5 s pause), C the late joiner, forked after W is gone, 6 s to hear what W
// wrote. Exit code 1 when C misses one. Before the fix: A [101,102,103], C
// NOTHING - "Update slot before the initial load, skipped" three times in its
// log, then "Initial state loaded".
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fork, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const PORT = Number(process.env.GUN_RELAY_PORT ?? 8775)
const GUN = process.env.GUN ?? 'gun'
const MARKERS = [101, 102, 103]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const role = process.argv[2]

if (!role) {
  const relay = spawn('node', [join(root, 'Docker/gun/relay.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_PATH: GUN === 'gun' ? process.env.NODE_PATH ?? '' : dirname(GUN) },
    stdio: 'ignore',
    cwd: mkdtempSync(join(tmpdir(), 'gun-lone-')),
  })
  await sleep(1000)
  const room = 'repro-' + Math.random().toString(36).slice(2, 10)
  const child = (r) => {
    const p = fork(fileURLToPath(import.meta.url), [r, room], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] })
    p.stdout.on('data', (d) => process.stdout.write(String(d)))
    return p
  }
  const witness = child('A')
  await sleep(1500)
  const writer = child('W')
  await new Promise((resolve) => writer.on('exit', resolve))
  const heardLive = await new Promise((resolve) => {
    witness.on('message', resolve)
    witness.send('report')
  })
  witness.kill('SIGKILL')
  await sleep(1500)
  const joiner = child('C')
  const heardLate = await new Promise((resolve) => joiner.on('message', resolve))
  joiner.kill('SIGKILL')
  relay.kill('SIGKILL')
  console.log(`[repro] A, in the room while W wrote, heard live: ${JSON.stringify(heardLive)} (want ${JSON.stringify(MARKERS)})`)
  console.log(`[repro] C, alone in the room 1.5 s after W left, heard from the relay: ${heardLate.length ? JSON.stringify(heardLate) : 'NOTHING'} in 6 s`)
  process.exit(MARKERS.every((m) => heardLate.includes(m)) ? 0 : 1)
}

const room = process.argv[3]
let Gun
try {
  Gun = req(`${GUN}/gun.js`)
} catch {
  console.error('set GUN=/path/to/node_modules/gun')
  process.exit(2)
}
const logs = []
console.log = ((log) => (...a) => (/^\[repro\]/.test(String(a[0])) ? log(...a) : logs.push(a.join(' '))))(console.log)
console.warn = () => {}
const { GunTransport } = req(join(root, 'bench-dist/src/providers/gun/index.js'))
const transport = new GunTransport({
  gun: Gun,
  peers: [`http://127.0.0.1:${PORT}/gun`],
  gunOptions: { WebSocket: globalThis.WebSocket, multicast: false },
  batchInterval: 20,
  debug: role === 'C',
})
const heard = []
transport.onMessage((d) => d[4] === 0 && heard.push(d[5]))
await transport.connect({ room })

if (role === 'W') {
  await sleep(1500)
  for (const m of MARKERS) {
    transport.send(new Uint8Array([0, 0, 0, 0, 0, m])) // CRC header, MESSAGE_SYNC, marker
    await sleep(1000)
  }
  await sleep(500)
  transport.disconnect()
  setTimeout(() => process.exit(0), 100)
}
if (role === 'A') {
  process.on('message', () => process.send(heard))
  await sleep(600000)
}
if (role === 'C') {
  await sleep(6000)
  for (const l of logs.filter((l) => /initial|Initial|skipped|No existing|Received update|Processed/.test(l))) console.log('[repro]   C log: ' + l.slice(0, 120))
  process.send(heard)
  await sleep(600000)
}
