/**
 * Regression tests for bugs found in the 2.0.3 analysis (see the cleanup plan:
 * batch 2 fixes B2/B3 and the BroadcastChannel gap, batch 3 fixes B1, batch 5
 * fixes B4).
 *
 * Each test states the CORRECT behaviour and is marked `test.fails` while the
 * bug is present, so the suite stays green. When a fix lands, its test starts
 * passing, vitest reports the `fails` test as an error, and the marker must be
 * removed in the same commit as the fix.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { SimplePeerTransport } from '../../src/providers/simple-peer/index'
import { WebSocketTransport } from '../../src/providers/websocket/index'
import { RecordingTransport, FakePeer, FakeWS, flush } from './helpers'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
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

describe('B2: WebSocket startup failure leaves the provider deaf (batch 2)', () => {
  // If the first connect fails, GenericProvider.connect() throws before it
  // registers onMessage. The transport reconnects on its own, but the provider
  // stays in 'error' and every message lands in receivedBuffer forever.
  test.fails('the provider receives data once the transport reconnects', async () => {
    vi.useFakeTimers()
    FakeWS.instances = []
    vi.stubGlobal('WebSocket', FakeWS)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const doc = new Y.Doc()
    const provider = new GenericProvider(doc, new WebSocketTransport(), {
      disableBc: true,
      syncMode: 'pull',
      verifyUpdates: false,
    })
    const connecting = provider
      .connect({ room: 'b2', serverUrl: 'wss://relay', messageTimeout: 0 } as any)
      .catch(() => {})
    FakeWS.latest().fail()
    await connecting

    await vi.advanceTimersByTimeAsync(2000) // default reconnectDelay
    expect(FakeWS.instances).toHaveLength(2)
    FakeWS.latest().open()
    await flush()

    // The server sends an update (plain y-websocket bytes, no CRC header).
    const remote = new Y.Doc()
    remote.getText('t').insert(0, 'from server')
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 0)
    syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(remote))
    FakeWS.latest().receive(encoding.toUint8Array(e).buffer)

    expect(doc.getText('t').toString()).toBe('from server')
    expect(provider.status.state).toBe('connected')
    provider.destroy()
  })
})

describe('B3: simple-peer chunk flow control (batch 2)', () => {
  async function openPeer() {
    FakePeer.instances = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: [] })
    await t.connect({ room: 'b3' })
    ;(t as any).handlePeerSignal('remote', { type: 'offer' })
    const peer = FakePeer.instances[0]
    peer.open()
    return { t, peer }
  }
  const big = (fill: number) => new Uint8Array(200_000).fill(fill)
  const chunksFor = (n: number) => Math.ceil(n / (64 * 1024 - 13))

  // Each chunked send waiting on backpressure sets channel.onbufferedamountlow;
  // a second one overwrites the first's handler, stranding its remaining chunks.
  test.fails('two large messages to one peer are both sent completely', async () => {
    const { t, peer } = await openPeer()
    t.send(big(1))
    t.send(big(2))
    for (let i = 0; i < 20; i++) peer._channel.drain()

    expect(peer.sent).toHaveLength(2 * chunksFor(200_000))
    t.disconnect()
  })

  // A small message sent while a chunked one waits on backpressure goes out
  // immediately and arrives before the large message it followed.
  test.fails('a small message does not overtake a chunked one', async () => {
    const { t, peer } = await openPeer()
    t.send(big(1))
    t.send(new Uint8Array([42]))
    for (let i = 0; i < 20; i++) peer._channel.drain()

    const types = peer.sent.map((f) => f[0])
    expect(types[types.length - 1]).toBe(0x00) // the small one comes last
    t.disconnect()
  })

  // Receiver side: chunk headers are trusted as-is.
  test.fails('a chunk with chunkIndex >= totalChunks is not buffered', async () => {
    const { t, peer } = await openPeer()
    t.onMessage(() => {})
    const chunk = new Uint8Array(13 + 4)
    const view = new DataView(chunk.buffer)
    chunk[0] = 0x01
    view.setUint32(1, 7, true) // messageId
    view.setUint32(5, 5, true) // chunkIndex out of range
    view.setUint32(9, 2, true) // totalChunks
    peer.receive(chunk)

    const peerConn = (t as any).peers.get('remote')
    expect(peerConn.chunkBuffers.size).toBe(0)
    t.disconnect()
  })
})

describe('publishTo via sendTo skips BroadcastChannel (batch 2)', () => {
  // Two providers in one process share lib0's BroadcastChannel subscribers,
  // which stands in for two tabs of one browser.
  async function twoTabs() {
    // The provider only enables BroadcastChannel when `window` exists.
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    const room = `bc-${Math.random()}`
    const a = new GenericProvider(new Y.Doc(), new RecordingTransport({ withSendTo: true }), {
      syncInterval: 0,
    })
    const b = new GenericProvider(new Y.Doc(), new RecordingTransport(), {
      syncInterval: 0,
      localId: 'tab-b',
    })
    await a.connect({ room })
    await b.connect({ room })
    expect(a.bcConnected && b.bcConnected).toBe(true)
    return { a, b }
  }

  // Control: proves the two-tab setup works, so the test below fails only
  // because of the bug.
  test('a broadcast message reaches a same-browser tab', async () => {
    const { a, b } = await twoTabs()
    const got = vi.fn()
    b.pubsub.subscribe('chat', got)
    a.pubsub.publish('chat', { n: 1 })
    await flush()
    a.destroy()
    b.destroy()
    expect(got).toHaveBeenCalledWith({ n: 1 }, 'chat')
  })

  // _sendPubSubTo() hands the frame straight to transport.sendTo() and never
  // publishes it to other tabs, unlike every other frame (see _send()).
  test.fails('a targeted message reaches a same-browser tab', async () => {
    const { a, b } = await twoTabs()
    const got = vi.fn()
    b.pubsub.subscribe('rpc', got)
    a.pubsub.publishTo('tab-b', 'rpc', { n: 1 })
    await flush()
    a.destroy()
    b.destroy()
    expect(got).toHaveBeenCalledWith({ n: 1 }, 'rpc')
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
