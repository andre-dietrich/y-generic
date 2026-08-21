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

class FakeConnection {
  state = 'initialized'
  private handlers = new Map<string, Array<(sc?: any) => void>>()
  once(event: string, cb: (sc?: any) => void) {
    if (event === 'connected') setTimeout(cb, 0)
  }
  on(event: string, cb: (sc?: any) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, [])
    this.handlers.get(event)!.push(cb)
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
  }
}

class FakeChannel {
  presence = {
    async enter() {},
    async leave() {},
    async get() {
      return []
    },
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

async function main() {
  const results = await Promise.all([
    scenarioBasicRestore(),
    scenarioChunkedSnapshot(),
    scenarioMissingChunkAborts(),
  ])
  const allOk = results.every(Boolean)
  console.log(allOk ? '\n✅ All scenarios passed.' : '\n❌ One or more scenarios failed.')
  process.exit(allOk ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
