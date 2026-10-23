/**
 * Self-check for src/providers/dummy: one hub entry per transport, an
 * unsubscribe that unsubscribes, broadcast and unicast still delivering.
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/check-dummy.js
 */
import assert from 'node:assert/strict'
import { DummyTransport, DummyHub } from '../../src/providers/dummy/index'

async function main() {
  const hub = new DummyHub()
  const a = new DummyTransport({ hub, unicast: true })
  const b = new DummyTransport({ hub, unicast: true })
  let first = 0
  let second = 0
  b.onMessage(() => first++)
  await a.connect({ room: 'r' })
  await b.connect({ room: 'r' })
  a.onMessage(() => {})

  // A second onMessage() while connected replaces the first, it does not add to it.
  const off = b.onMessage(() => second++)
  a.send(new Uint8Array([1]))
  assert.equal(first, 0, 'the replaced callback still got the message')
  assert.equal(second, 1, 'the message arrived more or less than once')
  assert.equal(hub.getRoomSize('r'), 2)

  a.sendTo!(b.id, new Uint8Array([2]))
  assert.equal(second, 2, 'unicast did not arrive')

  off()
  a.send(new Uint8Array([3]))
  assert.equal(second, 2, 'an unsubscribed callback still got a message')
  assert.equal(hub.getRoomSize('r'), 1)

  b.disconnect()
  a.disconnect()
  assert.equal(hub.getRoomSize('r'), 0)
  console.log('check-dummy: ok')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
