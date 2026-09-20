// Which public Gun relays work - today? They come and go: on 2026-09-20, of 40
// relays that the volunteer list (github.com/amark/gun/wiki/volunteer.dht) names
// or ever named, 2 accepted a WebSocket and ONE passed a write from one peer to
// another. Accepting a socket is not relaying: relay.peer.ooo says hi and
// delivers nothing.
//
//   npm install gun somewhere (inside this repo npm skips it, an optional peer dependency)
//   GUN=/path/to/node_modules/gun node test/gun/probe-relays.mjs                 # the volunteer list as it is now
//   GUN=... node test/gun/probe-relays.mjs https://host/gun https://other/gun    # or relays of your choice
//
// Per relay, three processes (two Gun instances of one process share a graph
// and talk past the relay) with Gun's BROWSER websocket adapter under Node
// (gun/gun.js + Node's global WebSocket - what a page runs): A subscribes,
// B writes three timestamps a second apart, C joins afterwards and reads once.
// Reported: ms until the relay said hi, the latency of each live write at A,
// whether the late reader got the value from the relay. ~20 s per batch of 10.
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const req = createRequire(import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const [role, url, key] = process.argv.slice(2)

if (role !== 'A' && role !== 'B' && role !== 'C') {
  let relays = process.argv.slice(2)
  if (relays.length === 0) {
    const list = await (await fetch('https://raw.githubusercontent.com/wiki/amark/gun/volunteer.dht.md')).text()
    relays = [...new Set(list.match(/https?:\/\/[^\s)>\]]+\/gun\b/g) ?? [])]
    console.log(`volunteer.dht names ${relays.length} relays`)
  }
  const child = (r, relay, k, delay) =>
    new Promise((resolve) =>
      setTimeout(() => {
        const p = fork(fileURLToPath(import.meta.url), [r, relay, k], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
        let report = {}
        p.on('message', (m) => (report = m))
        p.on('exit', () => resolve(report))
        setTimeout(() => p.kill('SIGKILL'), 30000)
      }, delay),
    )
  let working = 0
  for (let i = 0; i < relays.length; i += 10) {
    const rows = await Promise.all(
      relays.slice(i, i + 10).map(async (relay) => {
        const k = 'ygen-probe-' + Math.random().toString(36).slice(2)
        const [a, , c] = await Promise.all([child('A', relay, k, 0), child('B', relay, k, 0), child('C', relay, k, 10000)])
        return { relay, hi: a.hiMs ?? null, live: a.latencies ?? [], late: c.lateMs ?? null }
      }),
    )
    for (const r of rows) {
      if (r.live.length === 3) working++
      console.log(
        `${r.live.length === 3 ? 'WORKS' : r.hi === null ? 'dead ' : 'MUTE '} ${r.relay}  hi ${r.hi === null ? 'never' : r.hi + ' ms'}` +
          ` | live writes ${r.live.length}/3${r.live.length ? ' (' + r.live.join(', ') + ' ms)' : ''}` +
          ` | late reader ${r.late === null ? 'got nothing' : r.late + ' ms'}`,
      )
    }
  }
  console.log(`=> ${working} of ${relays.length} relays pass a live write from one peer to another`)
  process.exit(working > 0 ? 0 : 1)
}

console.log = console.warn = console.error = () => {}
let Gun
try {
  Gun = req(`${process.env.GUN ?? 'gun'}/gun.js`)
} catch {
  process.stderr.write('set GUN=/path/to/node_modules/gun\n')
  process.exit(2)
}
const t0 = Date.now()
const gun = new Gun({ peers: [url], WebSocket: globalThis.WebSocket, localStorage: false, radisk: false, multicast: false })
let hiMs = null
gun.on('hi', function (peer) {
  this.to.next(peer)
  hiMs ??= Date.now() - t0
})
if (role === 'A') {
  const latencies = []
  const seen = new Set()
  gun.get(key).get('v').on((v) => {
    if (typeof v !== 'number' || seen.has(v)) return
    seen.add(v)
    latencies.push(Date.now() - v)
  })
  await sleep(14000)
  process.send({ hiMs, latencies })
} else if (role === 'B') {
  await sleep(5000) // both sockets open, A subscribed
  for (let i = 0; i < 3; i++) {
    gun.get(key).get('v').put(Date.now())
    await sleep(1000)
  }
  await sleep(5000)
  process.send({ hiMs })
} else {
  let lateMs = null
  gun.get(key).get('v').once((v) => {
    if (typeof v === 'number') lateMs ??= Date.now() - t0
  })
  await sleep(8000)
  process.send({ lateMs })
}
await sleep(200)
process.exit(0)
