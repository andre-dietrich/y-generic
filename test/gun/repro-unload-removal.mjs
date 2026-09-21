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
//   disconnect  send(removal), flush(), disconnect(), gone in setTimeout(0) - what a
//               playground's own beforeunload adds: provider.disconnect(); and a
//               browser runs a task or two between beforeunload and pagehide (seen
//               in a wire trace: gun's own queue drained itself 2 ms after the
//               handler, 6 ms before pagehide). Heard live by A like the others.
//               disconnect() nulled the slot (round 7: "take our presence slot with
//               us") and so erased the removal in it - the first half of why the
//               reloaded page held its own ghost (below); the slot keeps it now.
//   vanish      presence, then gone without a word 2 s later     - a killed tab
// Then C joins, after every leaver is gone, and gets every presence slot the
// relay holds replayed as the answer to its own get. That replay is history:
// the slot of a killed tab says "here" for as long as the relay keeps it, and a
// reloaded page listed the tab killed minutes before for a lease of its own
// (25 browsers: 122 s, alone at 25 - and, before the slot kept its removal, its
// own old id, put back by a seconds-old presence table in another peer's slot:
// 127.9 s). Since round 10 the transport hands NO replayed presence up - a
// joiner's roster comes from the room's answer to its JOIN - so C must hear
// none of the leavers' presence or removals, and must hear the presence A sends
// live once C is subscribed.
// A watches the room and prints which departures it heard, in ms after the
// leaver's process was gone. Exit code 1 when the departure WITH flush() was
// not heard, when C was replayed any presence, or when C missed the live one;
// the departure without flush() is the bug this measured first (never heard,
// 8 s watched - gun's turn queue is drained by a task the page never runs).
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
  { marker: 61, mode: 'disconnect', label: 'flush(), disconnect(), gone in setTimeout(0)' },
  { marker: 71, mode: 'vanish', label: 'presence, gone without a word 2 s later' },
]
const LIVE_MARKER = 81 // what A sends once C is subscribed

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
  // C joins now, after every leaver is gone: what the relay replays to it,
  // and then what A says live
  const late = fork(fileURLToPath(import.meta.url), ['C', room], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] })
  late.stdout.on('data', (d) => process.stdout.write(String(d)))
  const lateReplayed = await new Promise((resolve) => late.once('message', resolve))
  const lateLive = new Promise((resolve) => late.once('message', resolve))
  watcher.send('say')
  const lateHeard = await lateLive
  late.kill('SIGKILL')
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
  const replayedPresence = lateReplayed.filter((m) => m.type === 1).map((m) => m.marker)
  console.log(
    `[repro] C, joined after all of them, was replayed as presence: ${replayedPresence.length === 0 ? 'nothing' : replayedPresence.join(' ') + ' - history taken for peers'} (every frame replayed: ${JSON.stringify(lateReplayed.map((m) => m.marker))})`,
  )
  console.log(`[repro] C heard the presence A sent live once C was subscribed: ${lateHeard.includes(LIVE_MARKER) ? 'YES' : 'NO'}`)
  watcher.kill('SIGKILL')
  relay.kill('SIGKILL')
  process.exit(heard[41] === undefined || heard[51] === undefined || heard[61] === undefined || replayedPresence.length > 0 || !lateHeard.includes(LIVE_MARKER) ? 1 : 0)
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

if (role === 'C') {
  const heard = []
  transport.onMessage((d) => heard.push({ marker: d[5], type: d[4] }))
  await transport.connect({ room })
  await sleep(4000) // the replay of every slot
  process.send(heard.splice(0, heard.length))
  await sleep(1500) // A's live presence
  process.send(heard.map((m) => m.marker))
  await sleep(600000)
}

if (role === 'A') {
  const heard = {} // marker -> when A heard it (this clock)
  transport.onMessage((d) => {
    if (heard[d[5]] === undefined) heard[d[5]] = Date.now()
  })
  await transport.connect({ room })
  process.on('message', (m) => {
    if (m === 'report') process.send(heard)
    if (m === 'say') transport.send(frame(LIVE_MARKER)) // a live presence for C
  })
  await sleep(600000)
  process.exit(0)
}

// B: one departure. Its presence first, so the room knows this peer at all.
const [, , , , mode, markerArg, typeArg] = process.argv
const marker = Number(markerArg)
await transport.connect({ room })
if (mode !== 'vanish') transport.send(frame(marker - 1))
// A page that types has typed before: the first write to a gun node is the one
// that needs an answer from the relay, later ones are local state.
if (Number(typeArg) === 0) transport.send(frame(marker - 2, 0)) // a page that types has typed before
await sleep(2000)
transport.send(frame(marker, Number(typeArg))) // what a page that unloads still owes the room
if (mode === 'flush') {
  transport.flush() // what GenericProvider's beforeunload handler does
  process.exit(0)
}
if (mode === 'disconnect') {
  transport.flush()
  transport.disconnect() // ... and what a playground's own beforeunload adds
  setTimeout(() => process.exit(0)) // the task or two a browser still runs
}
if (mode === 'vanish') { await sleep(2000); process.exit(0) } // its presence was the marker; no removal, ever
if (mode === 'same tick') process.exit(0)
else if (mode === 'macrotask') setTimeout(() => process.exit(0))
else setTimeout(() => process.exit(0), 50)
