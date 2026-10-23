/**
 * Self-check for src/providers/codec.ts: the CRC32 check value, a header the
 * core accepts, base64 both ways at a size above String.fromCharCode's
 * argument limit, and the password hash the providers used before (rooms of
 * older peers must still be found).
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/check-codec.js
 */
import assert from 'node:assert/strict'
import { crc32, addCRC32Header, stripCRC32Header, toBase64, fromBase64, hashPassword } from '../../src/providers/codec'

async function main() {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926) // the standard check value

  const msg = Uint8Array.from([0, 1, 2, 250])
  const framed = addCRC32Header(msg)
  assert.equal(new DataView(framed.buffer).getUint32(0), crc32(msg))
  assert.deepEqual(stripCRC32Header(framed), msg)

  const big = Uint8Array.from({ length: 300001 }, (_, i) => (i * 31) & 0xff)
  const b64 = toBase64(big)
  assert.equal(b64, Buffer.from(big).toString('base64'))
  assert.deepEqual(fromBase64(b64), big)
  assert.equal(toBase64(new Uint8Array(0)), '')

  // The SHA-256 of 'secret', first 16 hex chars: what nostr/ably/supabase computed before.
  assert.equal(await hashPassword('secret'), '2bb80d537b1da3e3')
  console.log('check-codec: ok')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
