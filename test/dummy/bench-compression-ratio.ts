/**
 * Benchmark: how much does gzip/deflate compression (via the standard
 * CompressionStream Web API) actually shrink Y.encodeStateAsUpdate output,
 * across a range of synthetic doc sizes/edit histories - and how much fixed
 * overhead does compression add to a TINY update (the common per-keystroke
 * case)?
 *
 * Pure size/CPU measurement, no network/DummyTransport involved - answers
 * "is compression worth building at all, and where should the size
 * threshold sit" before investing in the full _send()/_handleIncomingMessage
 * pipeline change. Per docs/superpowers/specs/2026-09-04-sync-optimization-
 * round-3-ideas.md item 1: don't assume the "3-6x" figure quoted there for
 * y-webrtc deflate - measure this codebase's actual encoding.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-compression-ratio.js
 */

import * as Y from 'yjs'

async function compress(
  data: Uint8Array,
  format: CompressionFormat,
): Promise<Uint8Array> {
  const cs = new CompressionStream(format)
  const writer = cs.writable.getWriter()
  writer.write(data as unknown as BufferSource)
  writer.close()
  const chunks: Uint8Array[] = []
  const reader = cs.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

const WORDS = (
  'the quick brown fox jumps over the lazy dog while collaborative ' +
  'editing tools synchronize document state across many connected peers ' +
  'using conflict free replicated data types for real time consistency'
).split(' ')

function word(i: number): string {
  return WORDS[i % WORDS.length]
}

/** One realistic per-keystroke update: a single character insert. */
function tinyKeystrokeUpdate(): Uint8Array {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const before = Y.encodeStateVector(doc)
  text.insert(0, 'x')
  // The update produced by ONE incremental edit, not the whole doc state -
  // this is what _sendUpdate() actually puts on the wire per keystroke.
  return Y.encodeStateAsUpdate(doc, before)
}

/** Medium doc: ~500 words typed in as whole-word transactions (no churn). */
function mediumDoc(): Uint8Array {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  for (let i = 0; i < 500; i++) {
    doc.transact(() => {
      text.insert(text.length, word(i) + ' ')
    })
  }
  return Y.encodeStateAsUpdate(doc)
}

/**
 * Large doc: ~5000 words with typing + backspace churn, so the state
 * carries real tombstone/structural overhead from edit history, not just
 * clean append-only content (matches "substantial history before GC" from
 * the round-3 doc's framing).
 */
function largeDocWithHistory(): Uint8Array {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  for (let i = 0; i < 5000; i++) {
    doc.transact(() => {
      text.insert(text.length, word(i) + ' ')
      // Every 10th word, simulate a backspace-correction: type 3 extra
      // chars then delete them - bloats tombstone/structural overhead.
      if (i % 10 === 0) {
        text.insert(text.length, 'xyz')
        text.delete(text.length - 3, 3)
      }
    })
  }
  return Y.encodeStateAsUpdate(doc)
}

interface Sample {
  name: string
  raw: Uint8Array
}

async function report(sample: Sample): Promise<void> {
  const { name, raw } = sample
  const gzipStart = process.hrtime.bigint()
  const gzip = await compress(raw, 'gzip')
  const gzipMs = Number(process.hrtime.bigint() - gzipStart) / 1e6

  const deflateStart = process.hrtime.bigint()
  const deflate = await compress(raw, 'deflate-raw')
  const deflateMs = Number(process.hrtime.bigint() - deflateStart) / 1e6

  const gzipRatio = raw.length / gzip.length
  const deflateRatio = raw.length / deflate.length

  console.log(
    `${name.padEnd(28)} | raw ${String(raw.length).padStart(7)}B | ` +
      `gzip ${String(gzip.length).padStart(7)}B (${gzipRatio.toFixed(2)}x, ${gzipMs.toFixed(2)}ms) | ` +
      `deflate-raw ${String(deflate.length).padStart(7)}B (${deflateRatio.toFixed(2)}x, ${deflateMs.toFixed(2)}ms)`,
  )
}

async function main() {
  console.log(`CompressionStream available: ${typeof CompressionStream !== 'undefined'}`)
  console.log('')

  await report({ name: 'tiny keystroke update', raw: tinyKeystrokeUpdate() })
  await report({ name: 'medium doc (~500 words)', raw: mediumDoc() })
  await report({
    name: 'large doc (~5000 words + churn)',
    raw: largeDocWithHistory(),
  })

  // A handful of small updates back to back, to see where compression
  // stops paying for its own fixed overhead (gzip header/trailer alone is
  // ~18-20 bytes; deflate-raw has none).
  console.log('\nSmall-update overhead sweep (single-char inserts at growing doc size):')
  for (const priorChars of [0, 100, 1000, 10000]) {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    if (priorChars > 0) text.insert(0, 'a'.repeat(priorChars))
    const before = Y.encodeStateVector(doc)
    text.insert(0, 'x')
    const raw = Y.encodeStateAsUpdate(doc, before)
    await report({ name: `  +1 char @ ${priorChars} prior chars`, raw })
  }

  // Batched-update sweep: N consecutive chars typed then flushed as one
  // update (what batchUpdates/a paste produces), to find where deflate-raw
  // crosses from "not worth it" to "clearly worth it".
  console.log('\nBatched-update sweep (N-char paste/batch flushed as one update):')
  for (const n of [10, 25, 50, 100, 200, 400, 800]) {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    const before = Y.encodeStateVector(doc)
    text.insert(0, 'a'.repeat(n))
    const raw = Y.encodeStateAsUpdate(doc, before)
    await report({ name: `  ${n}-char batch`, raw })
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
