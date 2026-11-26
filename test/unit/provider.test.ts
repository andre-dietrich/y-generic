/**
 * GenericProvider connect lifecycle, cross-tab delivery and awareness relay.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as bc from 'lib0/broadcastchannel'
import { GenericProvider } from '../../src/index'
import { WebSocketTransport } from '../../src/providers/websocket/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { RecordingTransport, FakeWS, flush } from './helpers'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** An update as the edrys relay sends it: plain y-websocket bytes. */
function serverUpdate(text: string): ArrayBuffer {
  const remote = new Y.Doc()
  remote.getText('t').insert(0, text)
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 0)
  syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(remote))
  return encoding.toUint8Array(e).buffer as ArrayBuffer
}

describe('connect with a WebSocket server unreachable at startup (B2)', () => {
  function setup() {
    vi.useFakeTimers()
    FakeWS.instances = []
    vi.stubGlobal('WebSocket', FakeWS)
    const doc = new Y.Doc()
    const provider = new GenericProvider(doc, new WebSocketTransport(), {
      disableBc: true,
      syncMode: 'pull',
    })
    return { doc, provider }
  }
  const config = { room: 'b2', serverUrl: 'wss://relay', messageTimeout: 0 } as any

  test('connect() resolves once a retry succeeds, and data flows', async () => {
    const { doc, provider } = setup()
    let resolved = false
    const connecting = provider.connect(config).then(() => (resolved = true))
    FakeWS.latest().fail()
    await flush()
    expect(resolved).toBe(false)
    expect(provider.status.state).toBe('connecting')

    await vi.advanceTimersByTimeAsync(2000) // default reconnectDelay
    expect(FakeWS.instances).toHaveLength(2)
    FakeWS.latest().open()
    await connecting
    expect(provider.status.state).toBe('connected')

    // Pull mode: the provider asked the server for its state on connect.
    expect(FakeWS.latest().sent[0][0]).toBe(0) // MESSAGE_SYNC (SyncStep1)

    FakeWS.latest().receive(serverUpdate('from server'))
    expect(doc.getText('t').toString()).toBe('from server')
    provider.destroy()
  })

  test('a connect attempt that hangs is abandoned and retried', async () => {
    const { provider } = setup()
    const connecting = provider.connect(config)
    const hung = FakeWS.latest()
    await vi.advanceTimersByTimeAsync(10000 + 2000)
    expect(FakeWS.instances).toHaveLength(2)
    FakeWS.latest().open()
    await connecting
    hung.open() // opening late must not take over
    expect(provider.status.state).toBe('connected')
    provider.destroy()
  })

  test('without autoReconnect, connect() rejects and the provider can retry', async () => {
    const { provider } = setup()
    const noRetry = { ...config, autoReconnect: false }
    const first = provider.connect(noRetry)
    FakeWS.latest().fail()
    await expect(first).rejects.toThrow('WebSocket connection failed')
    expect(provider.status.state).toBe('error')

    const second = provider.connect(noRetry)
    FakeWS.latest().open()
    await second
    expect(provider.status.state).toBe('connected')
    provider.destroy()
  })

  test('maxReconnectAttempts bounds the retries, then connect() rejects', async () => {
    const { provider } = setup()
    const first = provider.connect({ ...config, maxReconnectAttempts: 2 })
    const rejected = expect(first).rejects.toThrow()
    for (let i = 0; i < 3; i++) {
      FakeWS.latest().fail()
      await vi.advanceTimersByTimeAsync(2000)
    }
    await rejected
    expect(FakeWS.instances).toHaveLength(3)
    provider.destroy()
  })

  test('disconnect() while connecting stops the retries quietly', async () => {
    const { provider } = setup()
    const connecting = provider.connect(config)
    FakeWS.latest().fail()
    provider.disconnect()
    await expect(connecting).resolves.toBeUndefined()
    expect(provider.status.state).toBe('disconnected')
    await vi.advanceTimersByTimeAsync(60000)
    expect(FakeWS.instances).toHaveLength(1)
    provider.destroy()
  })
})

describe('concurrent editing (B1)', () => {
  // 2.0.3 sent updates as opcode 3 with a state-vector hash; a receiver that
  // had meanwhile applied a third peer's concurrent edit saw a mismatch and
  // scheduled a full-document resync, although nothing was lost.
  test('two concurrent typists converge without any resync', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const hub = new DummyHub()
    const bytes = { total: 0 }
    const peers = await Promise.all(
      [1, 2, 3].map(async (id) => {
        const doc = new Y.Doc()
        doc.clientID = id
        const transport = new DummyTransport({ hub, latency: 5, jitter: 0.5 })
        const send = transport.send.bind(transport)
        transport.send = (data: Uint8Array) => {
          bytes.total += data.length
          send(data)
        }
        const provider = new GenericProvider(doc, transport, {
          disableBc: true,
          syncInterval: 0,
          awarenessInterval: 0,
        })
        await provider.connect({ room: 'b1' })
        return { doc, provider }
      }),
    )
    await sleep(50)
    warn.mockClear()
    bytes.total = 0

    // Peers 1 and 2 type at the same time; peer 3 only listens.
    for (let i = 0; i < 10; i++) {
      peers[0].doc.getText('t').insert(0, 'a')
      peers[1].doc.getText('t').insert(0, 'b')
      await sleep(2)
    }
    await sleep(100)

    const texts = peers.map((p) => p.doc.getText('t').toString())
    for (const p of peers) p.provider.destroy()

    expect(texts[0]).toHaveLength(20)
    expect(new Set(texts).size).toBe(1)
    expect(warn).not.toHaveBeenCalled()
    // 20 one-character edits; with resyncs this was many kilobytes.
    expect(bytes.total).toBeLessThan(2000)
  })
})

describe('connect failure cleanup', () => {
  test('a failed connect unsubscribes from the transport', async () => {
    const transport = new RecordingTransport()
    transport.connect = async () => {
      throw new Error('nope')
    }
    const doc = new Y.Doc()
    const provider = new GenericProvider(doc, transport, { disableBc: true, syncInterval: 0 })
    await expect(provider.connect({ room: 'r' })).rejects.toThrow('nope')

    // A message arriving after the failure no longer reaches the provider.
    const remote = new Y.Doc()
    remote.getText('t').insert(0, 'x')
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 0)
    syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(remote))
    const frame = encoding.toUint8Array(e)
    const wrapped = new Uint8Array(4 + frame.length)
    wrapped.set(frame, 4)
    transport.deliver(wrapped)
    expect(doc.getText('t').toString()).toBe('')
    provider.destroy()
  })
})

describe('cross-tab delivery via BroadcastChannel', () => {
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

  test('a targeted message sent via sendTo also reaches a same-browser tab', async () => {
    const { a, b } = await twoTabs()
    const got = vi.fn()
    b.pubsub.subscribe('rpc', got)
    a.pubsub.publishTo('tab-b', 'rpc', { n: 1 })
    await flush()
    expect((a.transport as RecordingTransport).sentTo).toHaveLength(1)
    a.destroy()
    b.destroy()
    expect(got).toHaveBeenCalledWith({ n: 1 }, 'rpc')
  })

  test('a tab still running 2.x shares no channel with 3.x tabs', async () => {
    // 2.x used `yjs-<room>` and CRC32-prefixed frames; 3.x would mis-decode them.
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    const room = `bc-${Math.random()}`
    const old: ArrayBuffer[] = []
    const oldTab = (d: ArrayBuffer) => old.push(d)
    bc.subscribe(`yjs-${room}`, oldTab)
    const p = new GenericProvider(new Y.Doc(), new RecordingTransport(), { syncInterval: 0 })
    await p.connect({ room })
    p.pubsub.publish('chat', { n: 1 })
    await flush()
    bc.unsubscribe(`yjs-${room}`, oldTab)
    p.destroy()
    expect(old).toEqual([])
  })

  test('a targeted message for someone else is dropped by the other tab', async () => {
    const { a, b } = await twoTabs()
    const got = vi.fn()
    b.pubsub.subscribe('rpc', got)
    a.pubsub.publishTo('tab-c', 'rpc', { n: 1 })
    await flush()
    a.destroy()
    b.destroy()
    expect(got).not.toHaveBeenCalled()
  })
})

describe('awareness relay (B4)', () => {
  /**
   * Three providers on one hub. Counts the awareness frames each one sends,
   * per channel. `reachesAllPeers: false` makes a transport look like part of
   * a partial mesh.
   */
  async function threePeers(reachesAllPeers = true) {
    const hub = new DummyHub()
    const sent = new Map<string, number>()
    const peers = await Promise.all(
      [1, 2, 3].map(async (id) => {
        const doc = new Y.Doc()
        doc.clientID = id
        const transport = new DummyTransport({ hub })
        if (!reachesAllPeers) {
          Object.defineProperty(transport, 'reachesAllPeers', { value: false })
        }
        const send = transport.send.bind(transport)
        transport.send = (data: Uint8Array) => {
          // [opcode][channel]: count awareness frames.
          if (data[0] === 1) {
            const key = `${id}:${data[1]}`
            sent.set(key, (sent.get(key) ?? 0) + 1)
          }
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
    sent.clear()
    const count = (channel: number) => [1, 2, 3].map((id) => sent.get(`${id}:${channel}`) ?? 0)
    return { peers, sent, count }
  }

  test('peers do not echo an awareness update they received', async () => {
    const { peers, count } = await threePeers()
    peers[0].awareness.setLocalStateField('user', { name: 'alice' })
    await flush()
    const seen = peers[1].awareness.getStates().get(1)
    const counts = count(0)
    for (const p of peers) p.destroy()
    expect(seen).toEqual({ user: { name: 'alice' } })
    expect(counts).toEqual([1, 0, 0])
  })

  test('app awareness (module cursors) is not echoed either', async () => {
    const { peers, count } = await threePeers()
    peers[0].appAwareness.setLocalStateField('cursor', { x: 1 })
    await flush()
    const seen = peers[2].appAwareness.getStates().get(1)
    const counts = count(1)
    for (const p of peers) p.destroy()
    expect(seen).toEqual({ cursor: { x: 1 } })
    expect(counts).toEqual([1, 0, 0])
  })

  test('a remote state we timed out is not broadcast as a removal', async () => {
    const { peers, count } = await threePeers()
    peers[0].awareness.setLocalStateField('user', { name: 'alice' })
    await flush()
    // peers[1] stops hearing alice and times her out locally.
    awarenessProtocol.removeAwarenessStates(peers[1].awareness, [1], 'timeout')
    await flush()
    const stillAtThird = peers[2].awareness.getStates().get(1)
    const counts = count(0)
    for (const p of peers) p.destroy()
    expect(counts).toEqual([1, 0, 0])
    expect(stillAtThird).toEqual({ user: { name: 'alice' } })
  })

  test('a state applied locally for another clientID (module cursor) reaches peers', async () => {
    const { peers, count } = await threePeers()
    // A module iframe has its own Awareness; edrys applies its updates into appAwareness.
    const module = new awarenessProtocol.Awareness(new Y.Doc())
    module.setLocalStateField('cursor', { x: 5 })
    awarenessProtocol.applyAwarenessUpdate(
      peers[0].appAwareness,
      awarenessProtocol.encodeAwarenessUpdate(module, [module.clientID]),
      { transactionId: 'extern' },
    )
    await flush()
    const seen = peers[1].appAwareness.getStates().get(module.clientID)
    const counts = count(1)
    for (const p of peers) p.destroy()
    module.destroy()
    expect(seen).toEqual({ cursor: { x: 5 } })
    expect(counts).toEqual([1, 0, 0])
  })

  test('a peer removing our state is answered, so the others keep us', async () => {
    const { peers, count } = await threePeers()
    peers[0].awareness.setLocalStateField('user', { name: 'alice' })
    await flush()
    // peers[2] sends a removal of alice's state with a newer clock.
    const fake = new awarenessProtocol.Awareness(new Y.Doc())
    fake.clientID = 1
    fake.setLocalState({ user: { name: 'alice' } })
    fake.setLocalState(null)
    fake.setLocalState(null) // clock 2, above alice's 1
    const removal = awarenessProtocol.encodeAwarenessUpdate(fake, [1])
    // Origin = the provider, as for a frame received from the network.
    for (const p of [peers[0], peers[1]]) {
      awarenessProtocol.applyAwarenessUpdate(p.awareness, removal, p)
    }
    await flush()
    const atSecond = peers[1].awareness.getStates().get(1)
    const counts = count(0)
    for (const p of peers) p.destroy()
    fake.destroy()
    expect(atSecond).toEqual({ user: { name: 'alice' } })
    expect(counts[0]).toBeGreaterThan(1)
  })

  test('on a partial mesh, each peer relays remote changes once', async () => {
    const { peers, count } = await threePeers(false)
    peers[0].awareness.setLocalStateField('user', { name: 'alice' })
    await flush()
    const counts = count(0)
    for (const p of peers) p.destroy()
    expect(counts).toEqual([1, 1, 1])
  })

  test('disconnect() tells other peers we went offline', async () => {
    const hub = new DummyHub()
    const [a, b] = await Promise.all(
      [1, 2].map(async (id) => {
        const doc = new Y.Doc()
        doc.clientID = id
        const p = new GenericProvider(doc, new DummyTransport({ hub }), {
          disableBc: true,
          syncInterval: 0,
        })
        await p.connect({ room: 'leave' })
        return p
      }),
    )
    a.awareness.setLocalStateField('user', 'alice')
    a.appAwareness.setLocalStateField('cursor', 1)
    await new Promise((r) => setTimeout(r, 150)) // past the awareness throttle
    const seenBefore = b.awareness.getStates().has(1) && b.appAwareness.getStates().has(1)
    a.disconnect()
    await flush()
    const gone = !b.awareness.getStates().has(1) && !b.appAwareness.getStates().has(1)
    a.destroy()
    b.destroy()
    expect(seenBefore).toBe(true)
    expect(gone).toBe(true)
  })

  test('our own state is still sent when the transport reaches all peers', async () => {
    const { peers, count } = await threePeers()
    awarenessProtocol.removeAwarenessStates(peers[0].awareness, [1], 'window unload')
    await flush()
    const gone = peers[1].awareness.getStates().has(1)
    const counts = count(0)
    for (const p of peers) p.destroy()
    expect(counts).toEqual([1, 0, 0])
    expect(gone).toBe(false)
  })
})
