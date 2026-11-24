/**
 * Regression tests for bugs found in the 2.0.3 analysis that are not fixed
 * yet (see the cleanup plan: batch 3 fixes B1, batch 5 fixes B4).
 *
 * Each test states the CORRECT behaviour and is marked `test.fails` while the
 * bug is present, so the suite stays green. When a fix lands, its test starts
 * passing, vitest reports the `fails` test as an error, and the marker must be
 * removed in the same commit as the fix (moving the test next to the code's
 * other tests). B2, B3 and the BroadcastChannel gap were fixed in batch 2;
 * their tests now live in provider.test.ts and simple-peer.test.ts.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { flush } from './helpers'

afterEach(() => {
  vi.restoreAllMocks()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('B1: verified sync resyncs on ordinary concurrent edits (batch 3)', () => {
  // The state-vector hash in MESSAGE_SYNC_VERIFIED is taken by the sender
  // right after its own edit. A receiver that has meanwhile applied a
  // concurrent edit from a third peer has a different state vector, so the
  // check fails although nothing was lost, and every such message schedules a
  // full-document resync.
  test.fails('two concurrent typists cause no resync', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hub = new DummyHub()
    const peers = await Promise.all(
      [1, 2, 3].map(async (id) => {
        const doc = new Y.Doc()
        doc.clientID = id
        const provider = new GenericProvider(
          doc,
          new DummyTransport({ hub, latency: 5, jitter: 0.5 }),
          { disableBc: true, syncInterval: 0, awarenessInterval: 0 },
        )
        await provider.connect({ room: 'b1' })
        return { doc, provider }
      }),
    )
    await sleep(50)
    warn.mockClear()

    // Peers 1 and 2 type at the same time; peer 3 only listens.
    for (let i = 0; i < 10; i++) {
      peers[0].doc.getText('t').insert(0, 'a')
      peers[1].doc.getText('t').insert(0, 'b')
      await sleep(2)
    }
    await sleep(100)

    const resyncs = warn.mock.calls.filter((c) => /Hash mismatch/.test(String(c[0])))
    for (const p of peers) p.provider.destroy()

    // Convergence itself already works; the bug is the wasted resyncs.
    expect(peers[2].doc.getText('t').length).toBe(20)
    expect(resyncs).toEqual([])
  })
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
