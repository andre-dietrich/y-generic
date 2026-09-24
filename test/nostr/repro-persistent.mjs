// Repro: NostrTransport's persistent mode - A edits and is gone, B joins a room
// nobody is in. What B gets comes from the relay's stored snapshot alone: the
// live kind is not replayed (historyWindowSecs 0), no BroadcastChannel.
//
//   npm install nostr-tools somewhere (inside this repo npm prunes it again)
//   npx tsc -p tsconfig.bench.json
//   NOSTR_TOOLS=/path/to/node_modules/nostr-tools node test/nostr/repro-persistent.mjs
//
// Found in LiaScript (2026-09-24): a password room on Nostr with persistence
// on came back empty after everybody had left.
//
//  1 settled   A stays 3 s after its last edit (past persistDebounceMs), then
//              its page is killed. The control: B has the text.
//  2 unload    A's page unloads 300 ms after the edit - the snapshot is still
//              in its debounce, and a page that goes runs no further timer:
//              the provider's `beforeunload` calls Transport.flush().
//  3 destroy   A calls provider.destroy() 300 ms after the edit.
//  4 password  A and B behind a wrapper that encrypts every frame, as
//              LiaScript's wrapTransport does: the snapshot is built under
//              the wrapper, so it must be sealed the way a sent frame is
//              (`sealFrame`), and B's wrapper opens it. The relay's copy
//              must not hold the text in the clear.
//  5 typing    A edits every 400 ms for 12 s and is killed: a debounce that
//              every edit restarts never fires while somebody types
//              (persistMaxWaitMs). B must have the first edit.
// Exit code 1 unless all five hold.
// RELAY=wss://... runs it against that relay instead of Docker/nostr/relay.js
// (part 4 then asks the relay for what it keeps).
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'

const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const PORT = Number(process.env.NOSTR_RELAY_PORT ?? 8768)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The page: the provider registers its `beforeunload` where there is a window.
const unloadHandlers = new Set()
globalThis.window = {
  addEventListener: (type, fn) => type === 'beforeunload' && unloadHandlers.add(fn),
  removeEventListener: (type, fn) => unloadHandlers.delete(fn),
}

const tools = process.env.NOSTR_TOOLS ?? 'nostr-tools'
let pure, pool
try {
  pure = req(`${tools}/lib/cjs/pure.js`)
  pool = req(`${tools}/lib/cjs/pool.js`)
} catch {
  console.error('set NOSTR_TOOLS=/path/to/node_modules/nostr-tools')
  process.exit(2)
}
const Y = req('yjs')
const { GenericProvider } = req(join(root, 'bench-dist/src/index.js'))
const { NostrTransport } = req(join(root, 'bench-dist/src/providers/nostr/index.js'))

const SNAPSHOT_FILE = join(os.tmpdir(), `nostr-persistent-${process.pid}.json`)
const relay = process.env.RELAY
  ? null
  : fork(join(root, 'Docker/nostr/relay.js'), [], {
      env: { ...process.env, PORT: String(PORT), SNAPSHOT_FILE },
      stdio: 'ignore',
    })
if (relay) await sleep(500)
const relays = [process.env.RELAY ?? `ws://127.0.0.1:${PORT}`]

/** The snapshot events the relay keeps for `room`. */
async function storedSnapshots(room) {
  const d = (e) => e.tags.find((t) => t[0] === 'd')?.[1] ?? ''
  if (relay) {
    await sleep(500) // the relay writes its file 200 ms after an event
    return Object.values(JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'))).filter((e) => d(e).startsWith(room + '#'))
  }
  const q = new pool.SimplePool()
  const events = await q.querySync(relays, { kinds: [30078], '#d': [room + '#0'] }, { maxWait: 4000 })
  q.close(relays)
  return events
}

/** LiaScript's wrapTransport in miniature: XOR as the cipher, a tag to tell a sealed frame. */
function encrypting(t) {
  const seal = (d) => {
    const o = new Uint8Array(d.length + 2)
    o[0] = 0xaa
    o[1] = 0xbb
    for (let i = 0; i < d.length; i++) o[i + 2] = d[i] ^ 0x5a
    return o
  }
  const open = (f) => {
    if (f[0] !== 0xaa || f[1] !== 0xbb) return null // Crypto.decode throws on anything else
    return f.subarray(2).map((b) => b ^ 0x5a)
  }
  return {
    dropped: 0,
    connect: (config) => t.connect({ ...config, sealFrame: seal }),
    disconnect: () => t.disconnect(),
    send: (d) => t.send(seal(d)),
    onMessage(cb) {
      return t.onMessage((f) => {
        const d = open(f)
        if (d) cb(d)
        else this.dropped++
      })
    },
    onPeerConnect: (cb) => t.onPeerConnect(cb),
    flush: t.flush ? () => t.flush() : undefined,
    get isConnected() { return t.isConnected },
    get preferredBatchMs() { return t.preferredBatchMs },
    get preferredCompressMinBytes() { return t.preferredCompressMinBytes },
    get expectedRttMs() { return t.expectedRttMs },
  }
}

let liveKind = 27370
async function peer(room, password) {
  const doc = new Y.Doc()
  const t = new NostrTransport({
    finalizeEvent: pure.finalizeEvent,
    getPublicKey: pure.getPublicKey,
    SimplePool: pool.SimplePool,
    eventKind: ++liveKind,
  })
  const w = password ? encrypting(t) : t
  const before = new Set(unloadHandlers)
  const p = new GenericProvider(doc, w, { disableBc: true })
  const onUnload = [...unloadHandlers].find((fn) => !before.has(fn))
  await p.connect({ room, relays, historyWindowSecs: 0, persistent: true, doc })
  return {
    doc, t, w, p,
    text: () => doc.getText('t').toString(),
    /** The page is gone: no timer of it runs again, its sockets close. */
    kill() {
      t.persistTimer && clearTimeout(t.persistTimer)
      t.doc?.off('update', t._onDocUpdate)
      t.pool?.destroy()
      t.pool = null
      t.doc = null
      unloadHandlers.delete(onUnload)
      p.destroy() // this process goes on: nothing of the page may either
    },
    /** A page that unloads: `beforeunload` in this task, then nothing but its microtasks. */
    async unload() {
      onUnload()
      await new Promise((r) => setImmediate(r))
      this.kill()
    },
  }
}

async function bHas(room, token, password) {
  const b = await peer(room, password)
  const t0 = Date.now()
  while (Date.now() - t0 < 5000 && !b.text().includes(token)) await sleep(50)
  const ms = b.text().includes(token) ? Date.now() - t0 : -1
  const dropped = b.w.dropped ?? 0
  b.kill()
  return { ms, dropped }
}
const newRoom = () => 'persistent-' + Math.random().toString(36).slice(2, 10)
const fmt = ({ ms, dropped }) =>
  (ms < 0 ? 'NOTHING (5 s watched)' : `the text after ${ms} ms`) + (dropped ? `, ${dropped} frame(s) it could not open` : '')
const results = []

{
  const room = newRoom()
  const a = await peer(room)
  a.doc.getText('t').insert(0, 'token-settled')
  await sleep(3000)
  a.kill()
  const r = await bHas(room, 'token-settled')
  results.push(r.ms >= 0)
  console.log(`1 settled: B has ${fmt(r)}`)
}
{
  const room = newRoom()
  const a = await peer(room)
  await sleep(500)
  a.doc.getText('t').insert(0, 'token-unload')
  await sleep(300)
  await a.unload()
  const r = await bHas(room, 'token-unload')
  results.push(r.ms >= 0)
  console.log(`2 unload: B has ${fmt(r)}`)
}
{
  const room = newRoom()
  const a = await peer(room)
  await sleep(500)
  a.doc.getText('t').insert(0, 'token-destroy')
  await sleep(300)
  a.p.destroy()
  await sleep(500)
  const r = await bHas(room, 'token-destroy')
  results.push(r.ms >= 0)
  console.log(`3 destroy: B has ${fmt(r)}`)
}
{
  const room = newRoom()
  const a = await peer(room, true)
  a.doc.getText('t').insert(0, 'token-password')
  await sleep(3000)
  a.kill()
  const r = await bHas(room, 'token-password', true)
  // What the relay keeps: every stored event of this room, decoded.
  const stored = (await storedSnapshots(room)).map((e) => Buffer.from(JSON.parse(e.content).data, 'base64'))
  const clear = stored.some((bytes) => bytes.includes(Buffer.from('token-password')))
  results.push(r.ms >= 0 && stored.length > 0 && !clear)
  console.log(`4 password: B has ${fmt(r)}; the relay holds ${stored.length} snapshot event(s), ${clear ? 'the text IN THE CLEAR' : 'no text in the clear'}`)
}
{
  const room = newRoom()
  const a = await peer(room)
  const t0 = Date.now()
  for (let i = 0; Date.now() - t0 < 12000; i++) {
    a.doc.getText('t').insert(a.text().length, ` token-typing-${i}`)
    await sleep(400)
  }
  a.kill()
  const r = await bHas(room, 'token-typing-0 ')
  results.push(r.ms >= 0)
  console.log(`5 typing: 12 s of an edit every 400 ms, then killed - B has ${fmt(r)}`)
}

relay?.kill('SIGKILL')
process.exit(results.every(Boolean) ? 0 : 1)
