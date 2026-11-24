/**
 * Regression tests for bugs found in the 2.0.3 analysis that are not fixed
 * yet (see the cleanup plan: batch 5 fixes B4).
 *
 * Each test states the CORRECT behaviour and is marked `test.fails` while the
 * bug is present, so the suite stays green. When a fix lands, its test starts
 * passing, vitest reports the `fails` test as an error, and the marker must be
 * removed in the same commit as the fix (moving the test next to the code's
 * other tests). Already fixed: B2, B3 and the BroadcastChannel gap (batch 2,
 * provider.test.ts and simple-peer.test.ts), B1 (batch 3, provider.test.ts).
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { flush } from './helpers'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('B4: every peer re-broadcasts remote awareness changes (batch 5)', () => {
  // The awareness update handlers ignore `origin`, so an update applied from
  // the network (origin === provider) is sent out again by every receiver.
  test.fails('peers do not echo an awareness update they received', async () => {
    const hub = new DummyHub()
    const sentBy = new Map<number, number>()
    const peers = await Promise.all(
      [1, 2, 3].map(async (id) => {
        const doc = new Y.Doc()
        doc.clientID = id
        const transport = new DummyTransport({ hub })
        const send = transport.send.bind(transport)
        transport.send = (data: Uint8Array) => {
          // [CRC32 x4][opcode] — count awareness frames per sender.
          if (data[4] === 1) sentBy.set(id, (sentBy.get(id) ?? 0) + 1)
          send(data)
        }
        const provider = new GenericProvider(doc, transport, {
          disableBc: true,
          syncInterval: 0,
          awarenessInterval: 0,
        })
        await provider.connect({ room: 'b4' })
        return provider
      }),
    )
    await flush()
    sentBy.clear()

    peers[0].awareness.setLocalStateField('user', { name: 'alice' })
    await flush()
    const counts = [1, 2, 3].map((id) => sentBy.get(id) ?? 0)
    const seen = peers[1].awareness.getStates().get(1)

    for (const p of peers) p.destroy()
    expect(seen).toEqual({ user: { name: 'alice' } }) // delivery itself works
    expect(counts).toEqual([1, 0, 0])
  })
})
