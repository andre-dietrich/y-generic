/**
 * GenericProvider connect lifecycle and cross-tab delivery.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { GenericProvider } from '../../src/index'
import { WebSocketTransport } from '../../src/providers/websocket/index'
import { RecordingTransport, FakeWS, flush } from './helpers'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** An update as the edrys relay sends it: plain y-websocket bytes, no CRC. */
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
      verifyUpdates: false,
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
