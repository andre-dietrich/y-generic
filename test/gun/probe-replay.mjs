// Probe: does gun's `.map().on()` callback tell a REPLAY from a LIVE write?
//
//   npm install gun somewhere (inside this repo npm skips it, an optional peer dependency)
//   NODE_PATH=/path/to/node_modules GUN=/path/to/node_modules/gun node test/gun/probe-replay.mjs
//
// A subscriber that joins a room gets every existing slot replayed, and a
// slot's last value may be the presence of a tab killed minutes ago: to the
// subscriber it looked like a live peer, and it listed it for a lease of its
// own (25 browsers, a reload after a killed tab: 122 s, that one roster at 25;
// docs/superpowers/specs/2026-09-20-partial-mesh-relay-research.md, Gun). A
// bound on the slot's age is a wall clock, the writer's. This is the clock-free
// way, and GunTransport's awareness listener goes by it since round 10: gun
// passes the wire message as the callback's third argument, and an answer to
// the subscriber's own get carries `@` (the id of that get) - a live write
// does not. Prints, for two old slots, one new slot and one rewrite, what the
// callback sees. Expected: the two old slots with `@`; the new slot twice, live
// (no `@`) first and then as the answer to the get gun sends for a node it has
// not seen; the rewrite live only. What this probe does NOT show, seen in
// Chrome with 25 pages (the transport's debug log, DUMP_LOGS of the E2E
// harness): 60 ms after the answers, when the page wrote its own slot, gun
// re-emitted every slot once more "converted from old format" (gun.js
// `input`) - a message with neither `#` nor `@` and the original under VIA.
// The transport looks through VIA and takes only `#` without `@` as live.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const GUN = process.env.GUN ?? 'gun'
let Gun
try {
  Gun = req(`${GUN}/gun.js`)
} catch {
  console.error('set GUN=/path/to/node_modules/gun')
  process.exit(2)
}
const PORT = Number(process.env.GUN_RELAY_PORT ?? 8791)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const relay = spawn('node', [join(root, 'Docker/gun/relay.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
  cwd: mkdtempSync(join(tmpdir(), 'gun-probe-')),
})
await sleep(800)
console.log = ((log) => (...a) => (/^\[/.test(String(a[0])) ? log(...a) : undefined))(console.log)
console.warn = () => {}
const gun = () =>
  Gun({ peers: [`http://127.0.0.1:${PORT}/gun`], WebSocket: globalThis.WebSocket, multicast: false, localStorage: false, radisk: false })

const writer = gun()
const room = 'probe-' + Math.random().toString(36).slice(2, 8)
writer.get(room).get('awareness').get('slot-old-1').put({ data: 'old1', timestamp: Date.now() })
writer.get(room).get('awareness').get('slot-old-2').put({ data: 'old2', timestamp: Date.now() })
await sleep(1500)

const subscriber = gun()
const t0 = Date.now()
subscriber
  .get(room)
  .get('awareness')
  .map()
  .on((data, key, msg) => {
    // gun re-emits a whole node key by key ("convert from old format", gun.js
    // `input`), and the message the callback gets then is a converted one, the
    // original under VIA (or via): look through.
    let wire = msg
    while (wire && (wire.VIA || wire.via)) wire = wire.VIA || wire.via
    const kind = wire?.['@'] !== undefined ? 'an answer to our get: REPLAY' : wire?.['#'] !== undefined ? 'a LIVE write' : 'neither # nor @: internal'
    console.log(
      `[subscriber] +${Date.now() - t0} ms ${key} data=${data?.data} keys=${Object.keys(msg ?? {}).join(',')}${wire !== msg ? ` -> ${Object.keys(wire ?? {}).join(',')}` : ''}: ${kind}`,
    )
  })
await sleep(2500)
console.log('[subscriber] writes a slot of its own, as the transport does at connect')
subscriber.get(room).get('awareness').get('slot-mine').put({ data: 'mine', timestamp: Date.now() })
await sleep(1500)
console.log('[writer] a new slot, live')
writer.get(room).get('awareness').get('slot-live-3').put({ data: 'live3', timestamp: Date.now() })
await sleep(1500)
console.log('[writer] slot-old-1 rewritten, live')
writer.get(room).get('awareness').get('slot-old-1').put({ data: 'old1-again', timestamp: Date.now() })
await sleep(1500)
relay.kill('SIGKILL')
process.exit(0)
