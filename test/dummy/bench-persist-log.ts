/**
 * Benchmark: what does a typing session leave behind in the IndexedDB
 * transport's log, what comes back on the next load, and is compaction
 * lossless?
 *
 * IndexedDBTransport is a persistence transport: `send()` writes rows,
 * `connect()` replays them. Before round 7 it wrote EVERY frame the
 * provider sends - a keystroke's batch with its piggybacked cursor
 * (round 5), every awareness broadcast, every digest beacon, and one
 * full-document push per load - replayed all of them on the next load
 * (presence and beacons of the previous session included: phantoms of
 * one's own past clientIDs), never compacted by default, and its
 * `compact()` deleted the oldest 90 % of rows: document history that had
 * never been merged. Round 7 stores only the Yjs updates a frame carries
 * (`extractDocUpdates`, exported by the core for any persistence
 * transport), loads one merged update and trims the log to that one row,
 * and compacts by merging.
 *
 * Session 1: KEYSTROKES keystrokes with a cursor change each, GAP_MS apart,
 * against fake-indexeddb (in-memory, survives across connections in the
 * same process). Reported: rows and bytes in the store, bytes per
 * keystroke. Session 2 (reload): load time, content equality, rows after
 * the load, presence entries and `_knownPeers` the reloaded provider holds
 * (phantoms of session 1). Then `compact()`, session 3: rows and content.
 *
 * Run: npm install --no-save fake-indexeddb && npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-persist-log.js
 *      KEYSTROKES=1000 GAP_MS=10 override.
 */

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('fake-indexeddb/auto')
} catch {
  console.error('fake-indexeddb is not installed: npm install --no-save fake-indexeddb')
  process.exit(1)
}

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import type { Transport } from '../../src/transport'
import { IndexedDBTransport } from '../../src/providers/indexeddb/index'
import { sleep, silenced } from './bench-user-scaling'

const KEYSTROKES = Number(process.env.KEYSTROKES ?? 1000)
const GAP_MS = Number(process.env.GAP_MS ?? 10)

interface Session {
  doc: Y.Doc
  transport: IndexedDBTransport
  provider: GenericProvider
  loadMs: number
}

async function open(room: string): Promise<Session> {
  const doc = new Y.Doc()
  const transport = new IndexedDBTransport()
  const provider = new GenericProvider(doc, transport, {
    syncInterval: 1000,
    disableBc: true,
    batchUpdates: 0,
  })
  const t0 = Date.now()
  await provider.connect({ room })
  const loadMs = Date.now() - t0
  return { doc, transport, provider, loadMs }
}

/** Rows and bytes in the transport's store, read raw. */
function census(transport: IndexedDBTransport): Promise<{ rows: number; bytes: number }> {
  const db = (transport as any).db as IDBDatabase
  return new Promise((resolve, reject) => {
    const req = db.transaction(['updates'], 'readonly').objectStore('updates').getAll()
    req.onsuccess = () => {
      const rows = req.result as Array<{ update: Uint8Array }>
      resolve({ rows: rows.length, bytes: rows.reduce((n, r) => n + r.update.length, 0) })
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * Part 0: a log written by v1.4.0 - every frame the provider sent, stored
 * whole, no `raw` flag - must still load. The frames are captured from a
 * provider on a recording transport (20 keystrokes with cursor changes,
 * presence, a beacon) and written the way v1.4.0's send() wrote them.
 */
async function legacyLog(): Promise<void> {
  const room = `bench-persist-legacy-${Math.random().toString(36).slice(2)}`
  const frames: Uint8Array[] = []
  const recorder: Transport = {
    isConnected: true,
    async connect() {},
    disconnect() {},
    send(data: Uint8Array) {
      frames.push(data.slice())
    },
    onMessage() {
      return () => {}
    },
  }
  const doc = new Y.Doc()
  const writer = new GenericProvider(doc, recorder, { syncInterval: 1000, disableBc: true, batchUpdates: 0 })
  await writer.connect({ room })
  writer.awareness.setLocalState({ user: { name: 'v1.4.0' }, cursor: null })
  for (let k = 0; k < 20; k++) {
    doc.getText('t').insert(k, 'b')
    writer.awareness.setLocalStateField('cursor', { k })
    await sleep(10)
  }
  await sleep(1200)
  const expected = doc.getText('t').toString()
  writer.destroy()

  // v1.4.0's schema and rows: { update: <whole frame>, timestamp }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(`yjs-${room}`, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('updates', { autoIncrement: true }).createIndex('timestamp', 'timestamp', { unique: false })
      db.createObjectStore('metadata')
    }
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['updates'], 'readwrite')
      const store = tx.objectStore('updates')
      for (const frame of frames) store.add({ update: frame, timestamp: Date.now() })
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
  })

  const s = await open(room)
  await sleep(300)
  const c = await census(s.transport)
  const text = s.doc.getText('t').toString()
  console.log(
    `legacy log: ${frames.length} v1.4.0 frames stored -> load=${s.loadMs}ms content=${text === expected ? 'equal' : 'DIFFERENT (' + text.length + ' vs ' + expected.length + ' chars)'} ` +
      `rows after load=${c.rows} (${c.bytes} B) presence entries=${s.provider.awareness.getStates().size} knownPeers=${(s.provider as any)._knownPeers.size}`,
  )
  s.provider.destroy()
}

async function main() {
  console.log(`persist log: keystrokes=${KEYSTROKES} gap=${GAP_MS}ms\n`)
  await silenced(legacyLog)
  await silenced(async () => {
    const room = `bench-persist-${Math.random().toString(36).slice(2)}`

    // Session 1: type.
    const s1 = await open(room)
    s1.provider.awareness.setLocalState({ user: { name: 'typist', color: '#abc' }, cursor: null })
    const text = s1.doc.getText('t')
    for (let k = 0; k < KEYSTROKES; k++) {
      text.insert(k, 'a')
      s1.provider.awareness.setLocalStateField('cursor', { anchor: k, head: k })
      await sleep(GAP_MS)
    }
    await sleep(1500) // a beacon or two after the last keystroke
    const c1 = await census(s1.transport)
    console.log(
      `session 1: ${c1.rows} rows, ${(c1.bytes / 1024).toFixed(1)} KB ` +
        `(${(c1.bytes / KEYSTROKES).toFixed(0)} B per keystroke, ${(c1.bytes / c1.rows).toFixed(0)} B per row)`,
    )
    const expected = text.toString()
    s1.provider.disconnect()

    // Session 2: reload.
    const s2 = await open(room)
    await sleep(300)
    const c2 = await census(s2.transport)
    const text2 = s2.doc.getText('t').toString()
    console.log(
      `session 2 (reload): load=${s2.loadMs}ms content=${text2 === expected ? 'equal' : 'DIFFERENT (' + text2.length + ' vs ' + expected.length + ' chars)'} ` +
        `rows after load=${c2.rows} (${(c2.bytes / 1024).toFixed(1)} KB) ` +
        `presence entries=${s2.provider.awareness.getStates().size} knownPeers=${(s2.provider as any)._knownPeers.size}`,
    )

    // Compact, then session 3.
    await s2.transport.compact()
    const c2c = await census(s2.transport)
    s2.provider.disconnect()
    const s3 = await open(room)
    await sleep(300)
    const text3 = s3.doc.getText('t').toString()
    console.log(
      `compact(): ${c2c.rows} rows (${(c2c.bytes / 1024).toFixed(1)} KB); session 3 (reload): ` +
        `content=${text3 === expected ? 'equal' : 'DIFFERENT (' + text3.length + ' vs ' + expected.length + ' chars)'}`,
    )
    s3.provider.destroy()
  })
  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
