// Repro: does the presence removal of a page that is GOING AWAY reach the
// relay through Gun? The core sends it without any timer since v1.8.3
// (`origin === 'window unload'` -> _sendAwarenessNow, gate
// test/dummy/bench-unload-removal.ts), but the core's send is only the start
// of Gun's own way to the wire.
//
//   npm install gun somewhere (inside this repo npm skips it, an optional peer dependency)
//   npx tsc -p tsconfig.bench.json
//   GUN=/path/to/node_modules/gun node test/gun/repro-unload-removal.mjs
//
// Found by test/e2e/room-scenarios.mjs gun (25 browsers): a reloaded page
// leaves a ghost in every roster for the whole 120 s presence lease -
// 124,338 ms in round 8, 128,555 ms with the unload fix of v1.8.3 in round
// 10. Read, not measured, in round 8: "Gun writes through several timers, the
// presence removal of beforeunload does not reach the wire".
//
// This measures it. Three departures, each with its own marker, all through
// the real GunTransport (gun/gun.js with Node's global WebSocket: the browser
// adapter, as in repro-relay-restart.mjs):
//   same tick   send(removal) and process.exit() in the same tick - a page that is gone
//   flush       the same, with transport.flush() in between       - what the core does
//   flush, typed  the same for a document update, which the transport's own
//               `batchInterval` debounce holds back - the last words of a page
//   macrotask   exit in setTimeout(0)                             - one turn of the loop left
//   50 ms       exit 50 ms later                                  - the control
// A watches the room and prints which of them it heard, in ms after the
// leaver's process was gone. Exit code 1 when the departure WITH flush() was
// not heard; the one without it is the bug this measured (never heard, 8 s
// watched - gun's turn queue is drained by a task the page never runs).
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fork, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const PORT = Number(process.env.GUN_RELAY_PORT ?? 8771)
const GUN = process.env.GUN ?? 'gun'
const WATCH_MS = Number(process.env.WATCH_MS ?? 8000) // per departure, after the leaver is gone
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const role = process.argv[2]

// what a leaver sends: [CRC32 header][message type][marker]
const frame = (marker, type = 1) => new Uint8Array([0, 0, 0, 0, type, marker]) // 1 = MESSAGE_AWARENESS, 0 = MESSAGE_SYNC
const PARTS = [
  { marker: 11, mode: 'same tick', label: 'send(removal), then gone in the SAME TICK' },
  { marker: 41, mode: 'flush', label: 'send(removal), flush(), gone in the same tick' },
  { marker: 51, mode: 'flush', type: 0, label: 'typed (the batch), flush(), gone the same tick' },
  { marker: 21, mode: 'macrotask', label: 'gone in setTimeout(0)' },
  { marker: 31, mode: '50 ms', label: 'gone 50 ms later (control)' },
]

if (!role) {
  const cwd = mkdtempSync(join(tmpdir(), 'gun-unload-'))
  const relay = spawn('node', [join(root, 'Docker/gun/relay.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_PATH: GUN === 'gun' ? process.env.NODE_PATH ?? '' : dirname(GUN) },
    stdio: 'ignore',
    cwd,
  })
  await sleep(1000)
  const t0 = Date.now()
  const room = 'repro-' + Math.random().toString(36).slice(2, 10)
  const watcher = fork(fileURLToPath(import.meta.url), ['A', room], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] })
  watcher.stdout.on('data', (d) => process.stdout.write(String(d)))
  const report = new Promise((resolve) => watcher.on('message', resolve))
  await sleep(2000) // A is subscribed before anybody leaves

  const goneAt = {}
  for (const part of PARTS) {
    goneAt[part.marker] = await new Promise((resolve) => {
      const p = fork(fileURLToPath(import.meta.url), ['B', room, part.mode, String(part.marker), String(part.type ?? 1)], {
        stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
      })
      p.stdout.on('data', (d) => process.stdout.write(String(d)))
      p.on('exit', () => resolve(Date.now()))
    })
    await sleep(WATCH_MS) // the removal has this long to arrive
  }
  watcher.send('report')
  const heard = await report
  for (const part of PARTS) {
    const at = heard[part.marker]
    const ms = at === undefined ? undefined : at - goneAt[part.marker]
    console.log(
      `[repro] ${part.label.padEnd(46)} ${
        ms === undefined ? `NEVER heard (${WATCH_MS / 1000} s watched)` : ms < 0 ? `heard ${-ms} ms BEFORE it was gone` : `heard ${ms} ms after it was gone`
      }`,
    )
  }
  console.log(`[repro] everything A heard (marker: ms after the relay started): ${JSON.stringify(Object.fromEntries(Object.entries(heard).map(([m, at]) => [m, at - t0])))}`)
  watcher.kill('SIGKILL')
  relay.kill('SIGKILL')
  process.exit(heard[41] === undefined || heard[51] === undefined ? 1 : 0)
}

const room = process.argv[3]
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

if (role === 'A') {
  const heard = {} // marker -> when A heard it (this clock)
  transport.onMessage((d) => {
    if (heard[d[5]] === undefined) heard[d[5]] = Date.now()
  })
  await transport.connect({ room })
  process.on('message', (m) => m === 'report' && process.send(heard))
  await sleep(600000)
  process.exit(0)
}

// B: one departure. Its presence first, so the room knows this peer at all.
const [, , , , mode, markerArg, typeArg] = process.argv
const marker = Number(markerArg)
await transport.connect({ room })
transport.send(frame(marker - 1))
// A page that types has typed before: the first write to a gun node is the one
// that needs an answer from the relay, later ones are local state.
if (Number(typeArg) === 0) transport.send(frame(marker - 2, 0)) // a page that types has typed before
await sleep(2000)
transport.send(frame(marker, Number(typeArg))) // what a page that unloads still owes the room
if (mode === 'flush') {
  transport.flush() // what GenericProvider's beforeunload handler does
  process.exit(0)
}
if (mode === 'same tick') process.exit(0)
else if (mode === 'macrotask') setTimeout(() => process.exit(0))
else setTimeout(() => process.exit(0), 50)
