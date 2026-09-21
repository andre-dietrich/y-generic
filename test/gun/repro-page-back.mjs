// Repro: the page says its network is back while GunTransport sits in a
// reconnect backoff - does it dial now, or after the backoff?
//
//   npm install gun somewhere (inside this repo npm skips it, an optional peer dependency)
//   npx tsc -p tsconfig.bench.json
//   GUN=/path/to/node_modules/gun node test/gun/repro-page-back.mjs
//
// A real phone on Gun (test/e2e/phone-session.mjs gun, 2026-09-21): with the
// display off the relay socket died again and again, and the transport's
// backoff doubled, 3 s, 6 s, 12 s. That the relay was back 0.2 s after the
// display came on was the pending timer firing on wake. A backoff set right
// before the WiFi goes, display on, is waited out in full - simple-peer,
// PeerJS, Nostr and WebSocket do not since round 10 (watchPageBack: visible
// again, `online`, a change of navigator.connection); Gun did.
//
// The real GunTransport with gun's browser websocket adapter under Node
// (gun/gun.js, as repro-relay-restart.mjs) and a stub page: a `document` and a
// `window` that only collect their listeners. The relay is killed at 3 s and
// back at 16 s; by then the transport has failed twice and waits 12 s (until
// ~26 s). Two parts, a process each:
//   event    at 17 s the page becomes visible: ms from the relay's return
//            until the transport says the relay is back - want under 2 s
//   control  nobody says anything: the backoff, ~10 s
// Exit code 1 when the event part is not under 2 s or the control is not slower.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fork, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const PORT = Number(process.env.GUN_RELAY_PORT ?? 8773)
const GUN = process.env.GUN ?? 'gun'
const KILL_AT = 3000
const BACK_AT = 16000
const EVENT_AT = 17000
const WATCH_MS = 20000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const role = process.argv[2]

if (!role) {
  const cwd = mkdtempSync(join(tmpdir(), 'gun-pageback-'))
  const startRelay = () =>
    spawn('node', [join(root, 'Docker/gun/relay.js')], {
      env: { ...process.env, PORT: String(PORT), NODE_PATH: GUN === 'gun' ? process.env.NODE_PATH ?? '' : dirname(GUN) },
      stdio: 'ignore',
      cwd,
    })
  const results = {}
  for (const part of ['event', 'control']) {
    let relay = startRelay()
    await sleep(1000)
    const room = 'repro-' + Math.random().toString(36).slice(2, 10)
    const t0 = Date.now()
    const child = fork(fileURLToPath(import.meta.url), [part, room, String(t0)], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] })
    child.stdout.on('data', (d) => process.stdout.write(String(d)))
    const done = new Promise((resolve) => child.on('message', resolve))
    await sleep(KILL_AT)
    relay.kill('SIGKILL')
    await sleep(BACK_AT - KILL_AT)
    relay = startRelay()
    results[part] = await done
    child.kill('SIGKILL')
    relay.kill('SIGKILL')
    await sleep(500)
  }
  const ms = (r) => (r === undefined ? `NEVER (${WATCH_MS / 1000} s watched)` : `${r} ms`)
  console.log(`[repro] relay back, page visible 1 s later: relay back at the transport ${ms(results.event)} after the relay's return`)
  console.log(`[repro] relay back, nobody says anything (control): ${ms(results.control)}`)
  process.exit(results.event !== undefined && results.event < 2000 && (results.control === undefined || results.control > results.event) ? 0 : 1)
}

const room = process.argv[3]
const t0 = Number(process.argv[4])
// A stub page: the transport's watchPageBack registers here.
const listeners = { document: new Map(), window: new Map() }
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (ev, fn) => listeners.document.set(ev, fn),
  removeEventListener: (ev) => listeners.document.delete(ev),
}
globalThis.window = {
  addEventListener: (ev, fn) => listeners.window.set(ev, fn),
  removeEventListener: (ev) => listeners.window.delete(ev),
}
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
let backAt
transport.onPeerConnect?.(() => (backAt ??= Date.now()))
await transport.connect({ room })
if (!listeners.document.has('visibilitychange')) console.log('[repro] the transport registered no visibilitychange listener')
await sleep(EVENT_AT - (Date.now() - t0))
if (role === 'event') listeners.document.get('visibilitychange')?.()
while (Date.now() - t0 < BACK_AT + WATCH_MS && backAt === undefined) await sleep(50)
process.send(backAt === undefined ? undefined : backAt - (t0 + BACK_AT))
await sleep(600000)
