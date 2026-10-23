/**
 * Repro: IndexedDBTransport at its compaction threshold - how many merges of
 * the whole store does one burst of edits cost?
 *
 * The row count drops only when a compaction is done; every row stored while
 * it ran saw the count still at the threshold and queued another one - a
 * getAll and Y.mergeUpdates over the whole document each. A typist at the
 * threshold (500 rows by default) paid that once per keystroke for as long
 * as the merges took.
 *
 * The real IndexedDBTransport on fake-indexeddb, maxUpdates 20, 60 updates in
 * one burst. Then a second transport loads the store: the document must be
 * whole either way.
 *
 * Run (fake-indexeddb from anywhere on NODE_PATH, or `npm install --no-save fake-indexeddb`):
 *   npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-indexeddb-compact.js
 * Exit code 1 unless at most 3 compactions ran and the document is whole.
 */
import * as Y from 'yjs'
import { frameDocUpdate } from '../../src/index'
import { IndexedDBTransport } from '../../src/providers/indexeddb/index'

try {
  require('fake-indexeddb/auto')
} catch {
  console.error('fake-indexeddb is not installed: npm install --no-save fake-indexeddb (or NODE_PATH)')
  process.exit(2)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const room = 'compact-' + Math.random().toString(36).slice(2)
  const t = new IndexedDBTransport({ maxUpdates: 20 })
  t.onMessage(() => {})
  await t.connect({ room })
  let merges = 0
  const merge = (t as any).mergeStore.bind(t)
  ;(t as any).mergeStore = () => (merges++, merge())

  const doc = new Y.Doc()
  doc.on('update', (u: Uint8Array) => t.send(frameDocUpdate(u)))
  for (let i = 0; i < 60; i++) doc.getText('t').insert(doc.getText('t').length, `w${i} `)
  await sleep(1000)
  t.disconnect()

  const loaded = new Y.Doc()
  const r = new IndexedDBTransport({ maxUpdates: 20 })
  r.onMessage((frame) => {
    // frameDocUpdate's SyncStep2: [CRC32 x4][MESSAGE_SYNC][step 1][varUint8Array update]
    const syncProtocol = require('y-protocols/sync')
    const decoding = require('lib0/decoding')
    const encoding = require('lib0/encoding')
    const d = decoding.createDecoder(frame.subarray(5))
    syncProtocol.readSyncMessage(d, encoding.createEncoder(), loaded, null)
  })
  await r.connect({ room })
  await sleep(100)
  const whole = loaded.getText('t').toString() === doc.getText('t').toString()
  r.disconnect()
  console.log(`60 updates, threshold 20: ${merges} compaction(s) of the whole store (want <= 3); the reloaded document whole ${whole}`)
  process.exit(merges <= 3 && whole ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
