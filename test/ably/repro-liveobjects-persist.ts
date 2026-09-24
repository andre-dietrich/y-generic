/**
 * Verification script: does AblyTransport's LiveObjects-backed `persistent`
 * mode actually save/restore a Y.Doc snapshot correctly, including chunking
 * (a snapshot can exceed Ably's 64 KiB per-write limit) and graceful
 * handling of a corrupted/missing chunk?
 *
 * This script exercises the REAL AblyTransport class (not a reimplementation)
 * against a minimal in-memory fake of the Ably Realtime + LiveObjects SDK
 * surface, so any failures come from the actual production code path. No
 * network/API key needed — this is the no-credentials-required tier of
 * verification; a live test against real Ably LiveObjects is a separate,
 * manual step (see src/providers/ably/README.md).
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/ably/repro-liveobjects-persist.js
 *
 * Scenarios 4-7 (2026-09-24, what LiaScript's password rooms found - the Nostr
 * twin is test/nostr/repro-persistent.mjs):
 *  4 password   A and B behind LiaScript's encrypting wrapper (wrapTransport with
 *               stripHeaderBytes 4): the snapshot is built UNDER it, so it was
 *               stored in the clear and delivered as a frame the wrapper could
 *               not open. With `sealFrame` it is stored as the sealed frame, the
 *               way a sent one travels; B restores it, the store holds no text
 *               in the clear.
 *  5 awareness  behind that wrapper: presence changes only, no edit - no
 *               snapshot write (the transport told an awareness frame by its
 *               type byte, which the wrapper encrypts).
 *  6 unload     the page unloads 100 ms after an edit, inside the debounce: the
 *               provider's `beforeunload` calls Transport.flush().
 *  7 typing     an edit every 100 ms for 1.5 s, debounce 300 ms, max wait
 *               600 ms: a debounce every edit restarts never fires.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { AblyTransport } from '../../src/providers/ably/index'

// ---------------------------------------------------------------------------
// Minimal fake Ably SDK: just enough of the Realtime/Channel/LiveObjects
// surface AblyTransport actually uses, backed by shared per-channel state
// (mirrors the FakeGunNode pattern in repro-gun-batch-corruption.ts) so
// multiple FakeRealtime instances observe each other's writes — like
// multiple clients pointed at the same Ably app.
// ---------------------------------------------------------------------------

const rooms = new Map<string, Map<string, any>>() // channel name -> LiveMap store
const writes = new Map<Map<string, any>, number>() // LiveMap store -> set() calls

// The page: the provider registers its `beforeunload` where there is a window.
const unloadHandlers: Array<() => void> = []
;(globalThis as any).window = {
  addEventListener: (type: string, fn: () => void) => type === 'beforeunload' && unloadHandlers.push(fn),
  removeEventListener: () => {},
}

class FakeConnection {
  state = 'initialized'
  private handlers = new Map<string, Array<(sc?: any) => void>>()
  once(event: string, cb: (sc?: any) => void) {
    if (event === 'connected') setTimeout(cb, 0)
  }
  // The transport waits for its FIRST 'connected' on `on`, not `once` (ably-js
  // reconnects by itself and the transport has to hear that too - the round-8
  // lifecycle fix, repro-ably-lifecycle.ts). A fake that only files the handler
  // away never connects: `Ably connection timeout`, 10 s in. ably-js emits to
  // `on` handlers registered before the connection opens, so this one does too.
  on(event: string, cb: (sc?: any) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, [])
    this.handlers.get(event)!.push(cb)
    if (event === 'connected')
      setTimeout(() => {
        this.state = 'connected'
        cb()
      }, 0)
  }
  off() {}
}

class FakeLiveMapRoot {
  constructor(private store: Map<string, any>) {}
  get(key: string) {
    const store = this.store
    return { value: () => store.get(key) }
  }
  async set(key: string, value: any): Promise<void> {
    this.store.set(key, value)
    writes.set(this.store, (writes.get(this.store) ?? 0) + 1)
  }
}

class FakeChannel {
  presence = {
    async enter() {},
    async leave() {},
    async get() {
      return []
    },
    // The transport drops a peer the moment Ably reports its leave. Nobody
    // leaves in this fake, so nothing is ever emitted - but the method has to
    // exist, or connect() throws before the persistence path is reached.
    async subscribe(_event: string, _cb: (member: any) => void) {},
    unsubscribe() {},
  }
  object: { get(): Promise<FakeLiveMapRoot> }
  constructor(private store: Map<string, any>) {
    this.object = { get: async () => new FakeLiveMapRoot(this.store) }
  }
  async subscribe(_cb: (message: { data: any }) => void) {}
  unsubscribe() {}
  async publish(_eventName: string, _data: any) {}
  async detach() {}
}

class FakeRealtime {
  connection = new FakeConnection()
  channels: { get(name: string, options?: any): FakeChannel }
  constructor(_options: Record<string, any>) {
    this.channels = {
      get: (name: string) => {
        if (!rooms.has(name)) rooms.set(name, new Map())
        return new FakeChannel(rooms.get(name)!)
      },
    }
  }
  close() {}
}

const FakeLiveObjects = {} // presence-only marker; FakeRealtime doesn't care about its shape

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Scenario 1: basic save + restore across a full disconnect/reconnect
// ---------------------------------------------------------------------------
async function scenarioBasicRestore(): Promise<boolean> {
  const room = `ably-persist-repro-${Math.random().toString(36).slice(2)}`
  const docA = new Y.Doc()
  const transportA = new AblyTransport({ Realtime: FakeRealtime as any, LiveObjects: FakeLiveObjects })
  const providerA = new GenericProvider(docA, transportA, { syncInterval: 0 })

  await providerA.connect({ apiKey: 'fake', room, persistent: true, doc: docA, persistDebounceMs: 30 })
  docA.getText('content').insert(0, 'hello from persistent ably test')
  await sleep(150) // let the debounced save fire on its own (not just the disconnect flush)
  providerA.disconnect()
  await sleep(50)

  const docB = new Y.Doc()
  const transportB = new AblyTransport({ Realtime: FakeRealtime as any, LiveObjects: FakeLiveObjects })
  const providerB = new GenericProvider(docB, transportB, { syncInterval: 0 })
  await providerB.connect({ apiKey: 'fake', room, persistent: true, doc: docB, persistDebounceMs: 30 })
  await sleep(50)

  const restored = docB.getText('content').toString()
  providerB.disconnect()

  const ok = restored === 'hello from persistent ably test'
  console.log(`[basic restore] "${restored}" ${ok ? '✅' : '❌'}`)
  return ok
}

// ---------------------------------------------------------------------------
// Scenario 2: snapshot larger than MAX_MESSAGE_SIZE forces multi-chunk
// storage and reassembly
// ---------------------------------------------------------------------------
async function scenarioChunkedSnapshot(): Promise<boolean> {
  const room = `ably-persist-chunk-repro-${Math.random().toString(36).slice(2)}`
  const docA = new Y.Doc()
  const transportA = new AblyTransport({ Realtime: FakeRealtime as any, LiveObjects: FakeLiveObjects })
  const providerA = new GenericProvider(docA, transportA, { syncInterval: 0 })

  const bigText = 'x'.repeat(100_000) // encoded snapshot will exceed the 55000-byte chunk threshold
  await providerA.connect({ apiKey: 'fake', room, persistent: true, doc: docA, persistDebounceMs: 30 })
  docA.getText('content').insert(0, bigText)
  await sleep(150)
  providerA.disconnect()
  await sleep(50)

  const chunkCount = rooms.get(room)?.get('snapshot-count')
  const usedMultipleChunks = typeof chunkCount === 'number' && chunkCount > 1

  const docB = new Y.Doc()
  const transportB = new AblyTransport({ Realtime: FakeRealtime as any, LiveObjects: FakeLiveObjects })
  const providerB = new GenericProvider(docB, transportB, { syncInterval: 0 })
  await providerB.connect({ apiKey: 'fake', room, persistent: true, doc: docB, persistDebounceMs: 30 })
  await sleep(50)

  const restored = docB.getText('content').toString()
  providerB.disconnect()

  const ok = restored === bigText && usedMultipleChunks
  console.log(
    `[chunked snapshot] chunks=${chunkCount} length-match=${restored.length === bigText.length} ${ok ? '✅' : '❌'}`,
  )
  return ok
}

// ---------------------------------------------------------------------------
// Scenario 3: a missing/corrupted chunk aborts the load without delivering
// partial garbage
// ---------------------------------------------------------------------------
async function scenarioMissingChunkAborts(): Promise<boolean> {
  const room = `ably-persist-missing-chunk-repro-${Math.random().toString(36).slice(2)}`
  const docA = new Y.Doc()
  const transportA = new AblyTransport({ Realtime: FakeRealtime as any, LiveObjects: FakeLiveObjects })
  const providerA = new GenericProvider(docA, transportA, { syncInterval: 0 })

  const bigText = 'y'.repeat(100_000)
  await providerA.connect({ apiKey: 'fake', room, persistent: true, doc: docA, persistDebounceMs: 30 })
  docA.getText('content').insert(0, bigText)
  await sleep(150)
  providerA.disconnect()
  await sleep(50)

  // Simulate corruption: delete one of the middle chunk keys directly from
  // the shared store, as if a write partially failed.
  const store = rooms.get(room)!
  const count = store.get('snapshot-count')
  if (typeof count !== 'number' || count < 2) {
    console.log('[missing chunk] ❌ setup did not produce a multi-chunk snapshot, cannot test')
    return false
  }
  store.delete('snapshot-1')

  const docB = new Y.Doc()
  const transportB = new AblyTransport({ Realtime: FakeRealtime as any, LiveObjects: FakeLiveObjects })
  const providerB = new GenericProvider(docB, transportB, { syncInterval: 0 })
  let threw = false
  try {
    await providerB.connect({ apiKey: 'fake', room, persistent: true, doc: docB, persistDebounceMs: 30 })
  } catch {
    threw = true
  }
  await sleep(50)

  const content = docB.getText('content').toString()
  providerB.disconnect()

  const ok = !threw && content === '' // no crash, and no partial/corrupt data delivered
  console.log(`[missing chunk aborts] threw=${threw} deliveredLength=${content.length} ${ok ? '✅' : '❌'}`)
  return ok
}

// ---------------------------------------------------------------------------
// Scenarios 4-7: see the header
// ---------------------------------------------------------------------------

/** LiaScript's wrapTransport(transport, password, 4) in miniature: XOR as the
 * cipher, a tag to tell a sealed frame, 4 leading bytes for Ably to strip. */
function encrypting(t: AblyTransport) {
  const seal = (d: Uint8Array): Uint8Array => {
    const o = new Uint8Array(4 + 2 + d.length)
    o[4] = 0xaa
    o[5] = 0xbb
    for (let i = 0; i < d.length; i++) o[6 + i] = d[i] ^ 0x5a
    return o
  }
  const w = {
    dropped: 0,
    connect: (config: any) => t.connect({ ...config, sealFrame: seal }),
    disconnect: () => t.disconnect(),
    send: (d: Uint8Array) => t.send(seal(d)),
    onMessage: (cb: (d: Uint8Array, from?: string) => void) =>
      t.onMessage((f, from) => {
        const c = f.subarray(4) // what Ably added
        if (c[0] !== 0xaa || c[1] !== 0xbb) return void w.dropped++ // Crypto.decode throws
        cb(c.subarray(2).map((b) => b ^ 0x5a), from)
      }),
    onPeerConnect: t.onPeerConnect ? (cb: any) => t.onPeerConnect!(cb) : undefined,
    onPeerDisconnect: t.onPeerDisconnect ? (cb: any) => t.onPeerDisconnect!(cb) : undefined,
    flush: (t as any).flush ? () => (t as any).flush() : undefined,
    get isConnected() {
      return t.isConnected
    },
  }
  return w
}

async function peer(room: string, password: boolean, extra: Record<string, any> = {}) {
  const doc = new Y.Doc()
  const t = new AblyTransport({ Realtime: FakeRealtime as any, LiveObjects: FakeLiveObjects })
  const w = password ? encrypting(t) : null
  const before = unloadHandlers.length
  // No BroadcastChannel: Node has one, and A would hand B the text through it.
  const provider = new GenericProvider(doc, (w ?? t) as any, { syncInterval: 0, disableBc: true })
  const onUnload = unloadHandlers[before]
  await provider.connect({ apiKey: 'fake', room, persistent: true, doc, persistDebounceMs: 30, ...extra })
  await sleep(50)
  return { doc, t, w, provider, onUnload, text: () => doc.getText('content').toString() }
}

/** The page is gone: no timer of it fires again, nothing is disconnected. */
function kill(p: { t: AblyTransport }) {
  const t = p.t as any
  clearTimeout(t.persistTimer)
  t.persistentMode = false
}

async function scenarioPassword(): Promise<boolean> {
  const room = `ably-persist-password-${Math.random().toString(36).slice(2)}`
  const a = await peer(room, true)
  a.doc.getText('content').insert(0, 'token-password')
  await sleep(150)
  a.provider.disconnect()
  await sleep(50)
  // What the store holds of A - before B's disconnect writes B's state over it.
  const stored = Array.from(rooms.get(room)!.entries())
    .filter(([k]) => /^snapshot-\d+$/.test(k))
    .map(([, v]) => Buffer.from(new Uint8Array(v)))
  const clear = stored.some((bytes) => bytes.includes(Buffer.from('token-password')))
  const b = await peer(room, true)
  const restored = b.text()
  const dropped = b.w!.dropped
  b.provider.disconnect()
  const ok = restored === 'token-password' && stored.length > 0 && !clear
  console.log(
    `[password] restored="${restored}" dropped=${dropped} stored-chunks=${stored.length} ` +
      `${clear ? 'TEXT IN THE CLEAR' : 'no text in the clear'} ${ok ? '✅' : '❌'}`,
  )
  return ok
}

async function scenarioAwarenessNoWrites(): Promise<boolean> {
  const room = `ably-persist-awareness-${Math.random().toString(36).slice(2)}`
  const a = await peer(room, true)
  a.doc.getText('content').insert(0, 'x')
  await sleep(150)
  const store = rooms.get(room)!
  const before = writes.get(store) ?? 0
  for (let i = 0; i < 10; i++) {
    a.provider.awareness.setLocalStateField('cursor', i)
    await sleep(20)
  }
  await sleep(150)
  const after = writes.get(store) ?? 0
  a.provider.disconnect()
  const ok = before > 0 && after === before
  console.log(`[awareness only] snapshot writes ${before} -> ${after} after 10 presence changes ${ok ? '✅' : '❌'}`)
  return ok
}

async function scenarioUnloadFlush(): Promise<boolean> {
  const room = `ably-persist-unload-${Math.random().toString(36).slice(2)}`
  const a = await peer(room, false, { persistDebounceMs: 1000 })
  a.doc.getText('content').insert(0, 'token-unload')
  await sleep(100)
  a.onUnload()
  await sleep(0)
  kill(a)
  const b = await peer(room, false)
  const restored = b.text()
  b.provider.disconnect()
  const ok = restored === 'token-unload'
  console.log(`[unload flush] restored="${restored}" ${ok ? '✅' : '❌'}`)
  return ok
}

async function scenarioTypingMaxWait(): Promise<boolean> {
  const room = `ably-persist-typing-${Math.random().toString(36).slice(2)}`
  const a = await peer(room, false, { persistDebounceMs: 300, persistMaxWaitMs: 600 })
  const t0 = Date.now()
  for (let i = 0; Date.now() - t0 < 1500; i++) {
    a.doc.getText('content').insert(a.text().length, ` t${i}`)
    await sleep(100)
  }
  kill(a)
  const b = await peer(room, false)
  const restored = b.text()
  b.provider.disconnect()
  const ok = restored.startsWith(' t0 ')
  console.log(`[typing max wait] restored ${restored.length} chars ${ok ? '✅' : '❌'}`)
  return ok
}

async function main() {
  const results: boolean[] = []
  for (const scenario of [
    scenarioBasicRestore,
    scenarioChunkedSnapshot,
    scenarioMissingChunkAborts,
    scenarioPassword,
    scenarioAwarenessNoWrites,
    scenarioUnloadFlush,
    scenarioTypingMaxWait,
  ]) {
    results.push(await scenario())
  }
  const allOk = results.every(Boolean)
  console.log(allOk ? '\n✅ All scenarios passed.' : '\n❌ One or more scenarios failed.')
  process.exit(allOk ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
