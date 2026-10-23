// Repro: what GunTransport writes, and when.
//
//   npm install gun somewhere (inside this repo npm skips it, an optional peer dependency)
//   npx tsc -p tsconfig.bench.json
//   GUN=/path/to/node_modules/gun node test/gun/repro-writes.mjs
//
// The real GunTransport (and GenericProvider for parts 2-4) with gun's browser
// websocket adapter under Node, a relay (Docker/gun/relay.js), one process per peer.
//
//  1 stream   W sends a frame every 40 ms for 2 s (default batchInterval, 100 ms).
//             send()'s batch was a debounce every frame restarted: nothing left
//             W while it kept sending - the core's batchUpdates had the same
//             (fixed in c793f81: LiaScript drawing on Nostr, 9.4 s lag). L must
//             hear every frame within 1 s of its sending, not at the stream's end.
//  2 idle     A and B persistent, A edits once, then nobody does anything for
//             12 s: no snapshot write. send() scheduled one for every frame that
//             was not presence - the periodic digest beacons too, from every
//             peer, and B for edits it only received.
//  3 typing   T persistent, an edit every 50 ms for 5 s, then killed. More
//             batches than T's ring of 10 update slots holds: a joiner gets the
//             first edit from the snapshot only - which a debounce every edit
//             restarted never wrote (persistMaxWaitMs).
//  4 unload   U persistent, edits once and flush()es 100 ms later (the page's
//             unload, inside the debounce): the snapshot node must hold the edit.
//  5 cleared  P1 persistent writes a snapshot, a NON-persistent peer N joins (it
//             clears the snapshot: `cleared: true`), P2 persistent edits and
//             writes one again. gun merges a put into the node field by field,
//             so `cleared` stayed true under P2's data and loadSnapshot() skipped
//             it: one non-persistent visit disabled the room's snapshot for good.
// Exit code 1 unless all five hold.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fork, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const PORT = Number(process.env.GUN_RELAY_PORT ?? 8777)
const GUN = process.env.GUN ?? 'gun'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const role = process.argv[2]

if (!role) {
  const relay = spawn('node', [join(root, 'Docker/gun/relay.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_PATH: GUN === 'gun' ? process.env.NODE_PATH ?? '' : dirname(GUN) },
    stdio: 'ignore',
    cwd: mkdtempSync(join(tmpdir(), 'gun-writes-')),
  })
  await sleep(1000)
  const child = (r, room) => {
    const p = fork(fileURLToPath(import.meta.url), [r, room], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] })
    p.stdout.on('data', (d) => process.stdout.write(String(d)))
    return p
  }
  const reply = (p) => new Promise((resolve) => p.once('message', resolve))
  const newRoom = () => 'repro-' + Math.random().toString(36).slice(2, 10)
  const results = []

  {
    const room = newRoom()
    const L = child('L', room)
    await sleep(1500)
    const W = child('W', room)
    const { total, maxLag } = await reply(L)
    W.kill('SIGKILL')
    L.kill('SIGKILL')
    results.push(total === 50 && maxLag < 1000)
    console.log(`[repro] 1 stream: L heard ${total} of 50 frames, the longest lag ${maxLag} ms (want 50, < 1000 - a lag of the whole 2 s stream: nothing left while W sent)`)
  }
  {
    const room = newRoom()
    const A = child('A', room)
    const B = child('B', room)
    const [a, b] = await Promise.all([reply(A), reply(B)])
    A.kill('SIGKILL')
    B.kill('SIGKILL')
    results.push(a.idle === 0 && b.idle === 0 && b.total === 0 && b.text === 'token-idle')
    console.log(`[repro] 2 idle: snapshot writes in 12 s of a quiet room: A ${a.idle}, B ${b.idle} (want 0, 0); B, which never edited, wrote ${b.total} (want 0); B has the edit ${b.text === 'token-idle'}`)
  }
  {
    const room = newRoom()
    const T = child('T', room)
    await reply(T) // 5 s of typing done
    T.kill('SIGKILL')
    const J = child('J', room)
    const { text } = await reply(J)
    J.kill('SIGKILL')
    const first = text.includes(' t0 ')
    results.push(first)
    console.log(`[repro] 3 typing: a joiner after the typist was killed has ${text.length} chars, the first edit ${first ? 'among them' : 'MISSING'} (want it)`)
  }
  {
    const room = newRoom()
    const U = child('U', room)
    await new Promise((resolve) => U.on('exit', resolve))
    const S = child('S', room)
    const { stored } = await reply(S)
    S.kill('SIGKILL')
    results.push(stored)
    console.log(`[repro] 4 unload: the snapshot node holds the edit flushed 100 ms after it: ${stored} (want true)`)
  }

  {
    const room = newRoom()
    const P1 = child('P1', room)
    await reply(P1)
    P1.kill('SIGKILL')
    const N = child('N', room)
    await reply(N)
    N.kill('SIGKILL')
    const P2 = child('P2', room)
    await reply(P2)
    P2.kill('SIGKILL')
    const S = child('S5', room)
    const { cleared, hasP2 } = await reply(S)
    S.kill('SIGKILL')
    results.push(!cleared && hasP2)
    console.log(`[repro] 5 cleared: after P1, a non-persistent N and P2 the snapshot node says cleared ${cleared}, holds P2's edit ${hasP2} (want false, true)`)
  }

  relay.kill('SIGKILL')
  process.exit(results.every(Boolean) ? 0 : 1)
}

const room = process.argv[3]
let Gun
try {
  Gun = req(`${GUN}/gun.js`)
} catch {
  console.error('set GUN=/path/to/node_modules/gun')
  process.exit(2)
}
console.log = ((log) => (...a) => /^\[repro\]/.test(String(a[0])) && log(...a))(console.log)
console.warn = () => {}
const Y = req('yjs')
const { GenericProvider } = req(join(root, 'bench-dist/src/index.js'))
const { GunTransport } = req(join(root, 'bench-dist/src/providers/gun/index.js'))
const transport = new GunTransport({
  gun: Gun,
  peers: [`http://127.0.0.1:${PORT}/gun`],
  gunOptions: { WebSocket: globalThis.WebSocket, multicast: false },
})

if (role === 'L' || role === 'W') {
  const heard = new Map() // send time -> lag
  transport.onMessage((d) => {
    if (d[4] !== 0 || d.length < 13) return
    const sent = Number(new DataView(d.buffer, d.byteOffset + 5, 8).getFloat64(0))
    heard.set(sent, Date.now() - sent)
  })
  await transport.connect({ room })
  if (role === 'W') {
    for (let i = 0; i < 50; i++) {
      const f = new Uint8Array(13) // CRC header, MESSAGE_SYNC, the send time
      new DataView(f.buffer).setFloat64(5, Date.now())
      transport.send(f)
      await sleep(40)
    }
    await sleep(600000)
  }
  // L: the stream takes 2 s; report 4 s after the first frame was sent
  while (heard.size === 0) await sleep(10)
  await sleep(Math.max(0, Math.min(...heard.keys()) + 4000 - Date.now()))
  process.send({ total: heard.size, maxLag: Math.max(...heard.values()) })
  await sleep(600000)
}

if (role === 'N') {
  await transport.connect({ room }) // not persistent: clears the stored snapshot
  await sleep(1500)
  process.send('done')
  await sleep(600000)
}
if (role === 'S5') {
  await transport.connect({ room, persistent: true, doc: new (req('yjs').Doc)() })
  const snap = await new Promise((resolve) => transport.gun.get(`yjs-room-${room}`).get('snapshot').once(resolve))
  const hasP2 = !!snap?.data && Buffer.from(snap.data, 'base64').includes(Buffer.from('token-p2'))
  process.send({ cleared: !!snap?.cleared, hasP2 })
  await sleep(600000)
}

// Parts 2-5: a persistent provider
const doc = new Y.Doc()
let writes = 0
const save = transport.saveSnapshot.bind(transport)
transport.saveSnapshot = (...a) => (writes++, save(...a))
const provider = new GenericProvider(doc, transport, { disableBc: true })
await provider.connect({ room, persistent: true, doc, persistDebounceMs: 300, persistMaxWaitMs: 1000 })
const text = () => doc.getText('t').toString()

if (role === 'A' || role === 'B') {
  if (role === 'A') {
    await sleep(1500)
    doc.getText('t').insert(0, 'token-idle')
  }
  await sleep(4000) // A's write is done
  const before = writes
  await sleep(12000)
  process.send({ idle: writes - before, total: writes, text: text() })
  await sleep(600000)
}
if (role === 'T') {
  await sleep(1000)
  const t0 = Date.now()
  for (let i = 0; Date.now() - t0 < 5000; i++) {
    doc.getText('t').insert(text().length, ` t${i} `)
    await sleep(50)
  }
  process.send('typed')
  await sleep(600000)
}
if (role === 'P1' || role === 'P2') {
  await sleep(1000)
  doc.getText('t').insert(0, role === 'P1' ? 'token-p1 ' : 'token-p2 ')
  await sleep(2000) // past persistDebounceMs: written
  process.send('done')
  await sleep(600000)
}
if (role === 'J') {
  await sleep(6000)
  process.send({ text: text() })
  await sleep(600000)
}
if (role === 'U') {
  await sleep(1000)
  doc.getText('t').insert(0, 'token-unload')
  await sleep(100)
  transport.flush()
  setImmediate(() => process.exit(0)) // the page is gone: no timer of it runs again
}
if (role === 'S') {
  // what the relay holds under the snapshot node, read raw
  const gun = transport.gun
  const snap = await new Promise((resolve) => gun.get(`yjs-room-${room}`).get('snapshot').once(resolve))
  const stored = !!snap?.data && Buffer.from(snap.data, 'base64').includes(Buffer.from('token-unload'))
  process.send({ stored })
  await sleep(600000)
}
