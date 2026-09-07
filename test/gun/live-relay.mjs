// Live test of the Gun transport through a relay.
//
//   npm install --no-save gun                      (once; a peer dependency, not installed by default)
//   npx tsc -p tsconfig.bench.json
//   node test/gun/live-relay.mjs                   # starts its own relay (the installed gun) on port 8766
//   GUN_PEER=http://host:port/gun node test/gun/live-relay.mjs   # or against a relay of your own
//
// Two peers in two PROCESSES (two Gun instances in one Node process share
// one store and talk past the relay - the first version of this test saw
// A receive nothing from B), LAN multicast off so only the relay path is
// measured. The parent forks itself as A and B with the same room and a
// shared timeline; each child reports its own lines.
//
// The relay must speak the client's Gun version: the docker image
// gundb/gun ships 0.2020.520, and against it a 0.2020.1241 client sees
// data that existed before it subscribed but never a live write (raw
// probe, 2026-09-07: a second read after the write still showed the old
// slot). A relay from the same gun package (`Gun({ web: server })`, or
// node_modules/gun/examples/http.js) propagates at once.
//
// Gun has no leave signal, so this checks what round 5 changed on such a
// transport: (1) B converges on A's keystrokes through the relay and both
// see each other's presence; (2) an idle minute costs only the presence
// renewals of the lease (the playground's 120 s: one per peer per 60 s)
// and the backed-off beacons; (3) a reconnect of A sends no full-state
// push (item 5); (4) A closing its transport without a clean provider
// disconnect is dropped by B only after the lease - the documented trade.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const RELAY_PORT = Number(process.env.GUN_RELAY_PORT ?? 8766)
const peerUrl = process.env.GUN_PEER ?? `http://localhost:${RELAY_PORT}/gun`
const LEASE_MS = Number(process.env.AWARENESS_TIMEOUT_MS ?? 120000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const role = process.argv[2]

if (!role) {
  // Parent: a relay of our own unless GUN_PEER names one; one room, two
  // children, wait for both.
  let GunLib
  try {
    GunLib = req('gun')
  } catch {
    console.error('run: npm install --no-save gun')
    process.exit(2)
  }
  if (!process.env.GUN_PEER) {
    const server = http.createServer((_, res) => res.end('gun relay')).listen(RELAY_PORT)
    GunLib({ web: server, localStorage: false, radisk: false, multicast: false, file: `.gun-relay-${RELAY_PORT}` })
    await sleep(500)
  }
  const room = 'relay-test-' + Math.random().toString(36).slice(2, 8)
  console.log('room', room, '| relay', peerUrl, process.env.GUN_PEER ? '' : `(own, gun ${req('gun/package.json').version})`, '| lease', LEASE_MS, 'ms')
  const start = Date.now()
  const child = (r, delayMs) =>
    new Promise((resolve) =>
      setTimeout(() => {
        const p = fork(fileURLToPath(import.meta.url), [r, room, String(start)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
        p.stdout.on('data', (d) => process.stdout.write(String(d)))
        p.stderr.on('data', (d) => { const s = String(d); if (!/Hello wonderful|AXE|Welcome|Multicast|reusing same/.test(s)) process.stderr.write(s) })
        p.on('exit', resolve)
      }, delayMs),
    )
  await Promise.all([child('A', 0), child('B', 1500)])
  process.exit(0)
}

const room = process.argv[3]
const t0 = Number(process.argv[4])
const stamp = () => String(Date.now() - t0).padStart(6) + ' ms ' + role + ':'
const Y = req('yjs')
const { GenericProvider } = req(join(root, 'bench-dist/src/index.js'))
const { GunTransport } = req(join(root, 'bench-dist/src/providers/gun/index.js'))
let Gun
try {
  Gun = req('gun')
} catch {
  console.error('run: npm install --no-save gun')
  process.exit(2)
}
console.warn = () => {}
const doc = new Y.Doc()
const transport = new GunTransport({ gun: Gun, peers: [peerUrl], gunOptions: { multicast: false } })
const provider = new GenericProvider(doc, transport, { disableBc: true, awarenessTimeoutMs: LEASE_MS })
const seen = { sends: 0, awarenessSends: 0, bytes: 0 }
const origSend = transport.send.bind(transport)
transport.send = (data) => { seen.sends++; seen.bytes += data.length; if (data[4] === 1) seen.awarenessSends++; return origSend(data) }
const text = doc.getText('t')
const others = () => provider.awareness.getStates().size - 1
// Shared timeline (ms after t0): A types 2000-3400, both idle 5000-65000,
// A reconnects at 66000, A goes silent at 70000, B watches until 70000 + lease + 20 s.
const at = (ms) => sleep(Math.max(0, t0 + ms - Date.now()))
await provider.connect({ room })
provider.awareness.setLocalStateField('user', { name: role })
console.log(stamp(), 'connected')
if (role === 'A') {
  await at(2000)
  for (const ch of 'hello world') { text.insert(text.length, ch); await sleep(120) }
  console.log(stamp(), 'typed "hello world"')
} else {
  let converged = -1
  while (Date.now() - t0 < 5000) { if (text.toString() === 'hello world') { converged = Date.now() - t0; break }; await sleep(50) }
  console.log(stamp(), converged < 0 ? `text ${JSON.stringify(text.toString())} NOT converged by 5 s` : `text "hello world" converged at ${converged} ms (last keystroke ~3400 ms)`)
}
await at(5000)
console.log(stamp(), `sees ${others()} other presence state(s), synced=${provider.synced}; idle 60 s ...`)
const before = { s: seen.sends, a: seen.awarenessSends }
await at(65000)
console.log(stamp(), `sends during idle: ${seen.sends - before.s} (${seen.awarenessSends - before.a} awareness)`)
if (role === 'A') {
  await at(66000)
  provider.disconnect()
  await sleep(1000)
  const rc = { s: seen.sends, b: seen.bytes }
  await provider.connect({ room })
  await sleep(2500)
  console.log(stamp(), `reconnect cost: ${seen.sends - rc.s} sends, ${seen.bytes - rc.b} bytes (doc ${Y.encodeStateAsUpdate(doc).length} bytes) | synced=${provider.synced}`)
  await at(70000)
  transport.disconnect() // silent departure: no clean provider disconnect
  console.log(stamp(), 'transport closed (silent departure)')
  await sleep(2000)
  process.exit(0)
} else {
  await at(70000)
  const aId = [...provider.awareness.getStates().keys()].find((id) => id !== doc.clientID)
  const gone = Date.now()
  const cap = LEASE_MS + 20000
  let dropped = -1
  while (Date.now() - gone < cap) { if (aId === undefined || !provider.awareness.getStates().has(aId)) { dropped = Date.now() - gone; break }; await sleep(250) }
  console.log(stamp(), aId === undefined ? 'never saw A' : dropped < 0 ? `still sees A after ${cap} ms (lease ${LEASE_MS} ms)` : `dropped A after ${dropped} ms (lease ${LEASE_MS} ms)`)
  provider.destroy()
  process.exit(0)
}
