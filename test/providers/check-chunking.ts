/**
 * Self-check for src/providers/chunking.ts: split / shuffle / reassemble,
 * two interleaved ids, eviction of a stale id. Fails loudly on any break.
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/check-chunking.js
 */
import assert from 'node:assert/strict'
import { splitChunks, isChunk, ChunkAssembler } from '../../src/providers/chunking'

const big = Array.from({ length: 250001 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('')
const chunks = splitChunks(big, 60000)
assert.equal(chunks.length, 5)
assert.ok(chunks.every(isChunk))
assert.equal(chunks.map((c) => c.data).join(''), big)

const small = splitChunks('abc', 60000)
assert.equal(small.length, 1)
assert.equal(small[0].total, 1)

// shuffled delivery, two senders interleaved
const other = splitChunks('x'.repeat(120000), 60000)
const mixed = [...chunks, ...other].sort(() => Math.random() - 0.5)
const asm = new ChunkAssembler()
const done: string[] = []
for (const c of mixed) {
  const out = asm.push(c)
  if (out !== null) done.push(out)
}
assert.equal(done.length, 2)
assert.ok(done.includes(big))
assert.ok(done.includes('x'.repeat(120000)))

// eviction: 32 incomplete ids, then the 33rd pushes the oldest out
const bounded = new ChunkAssembler(32)
const first = splitChunks('a'.repeat(10), 5)
bounded.push(first[0])
for (let i = 0; i < 32; i++) bounded.push(splitChunks('b'.repeat(10), 5)[0])
assert.equal(bounded.push(first[1]), null, 'evicted id must not reassemble')

assert.equal(isChunk('plain'), false)
assert.equal(isChunk({ chunked: true }), false)
console.log('check-chunking: OK')
