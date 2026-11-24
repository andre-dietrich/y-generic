/**
 * WebSocketTransport behaviour edrys-Lite's WebSocket adapter depends on.
 * Liveness tests ported from edrys-Lite's tests/unit/ts/SignalingLiveness.test.ts.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketTransport } from '../../src/providers/websocket/index'
import { FakeWS } from './helpers'

beforeEach(() => {
  FakeWS.instances = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWS)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function connected(extra: Record<string, any> = {}) {
  const t = new WebSocketTransport()
  const p = t.connect({ room: 'room', serverUrl: 'wss://relay', ...extra } as any)
  FakeWS.latest().open()
  await p
  return t
}

describe('WebSocketTransport', () => {
  test('connects to <serverUrl>/<room>, trailing slash and escaping handled', async () => {
    const t = new WebSocketTransport()
    const p = t.connect({ room: 'a b', serverUrl: 'wss://relay/' } as any)
    expect(FakeWS.latest().url).toBe('wss://relay/a%20b')
    FakeWS.latest().open()
    await p
    t.disconnect()
  })

  test('messages sent before the socket opens are queued and flushed', async () => {
    const t = new WebSocketTransport()
    const p = t.connect({ room: 'room', serverUrl: 'wss://relay' } as any)
    t.send(new Uint8Array([7]))
    expect(FakeWS.latest().sent).toEqual([])
    FakeWS.latest().open()
    await p
    expect([...FakeWS.latest().sent[0]]).toEqual([7])
    t.disconnect()
  })

  test('messages received before onMessage is registered are buffered', async () => {
    const t = await connected()
    FakeWS.latest().receive(new Uint8Array([0, 1]).buffer)
    const got: Uint8Array[] = []
    t.onMessage((d) => got.push(d))
    expect(got).toHaveLength(1)
    expect([...got[0]]).toEqual([0, 1])
    t.disconnect()
  })

  test('text frames are ignored', async () => {
    const t = await connected()
    const got: Uint8Array[] = []
    t.onMessage((d) => got.push(d))
    FakeWS.latest().receive('hello')
    expect(got).toEqual([])
    t.disconnect()
  })

  test('reconnects after the server closes the socket', async () => {
    const t = await connected()
    FakeWS.latest().fail()
    expect(t.isConnected).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeWS.instances).toHaveLength(2)
    FakeWS.latest().open()
    expect(t.isConnected).toBe(true)
    t.disconnect()
  })

  test('disconnect() does not reconnect', async () => {
    const t = await connected()
    const ws = FakeWS.latest()
    t.disconnect()
    ws.onclose?.({ code: 1000 })
    await vi.advanceTimersByTimeAsync(60000)
    expect(FakeWS.instances).toHaveLength(1)
  })

  describe('liveness (ported from edrys-Lite)', () => {
    test('reconnects after 30s without a message', async () => {
      const t = await connected()
      await vi.advanceTimersByTimeAsync(29000)
      expect(t.isConnected).toBe(true)

      await vi.advanceTimersByTimeAsync(4000)
      expect(t.isConnected).toBe(false)

      await vi.advanceTimersByTimeAsync(2000) // default reconnectDelay
      expect(FakeWS.instances).toHaveLength(2)
      expect(FakeWS.latest().url).toBe('wss://relay/room')
      FakeWS.latest().open()
      expect(t.isConnected).toBe(true)
      t.disconnect()
    })

    test('steady traffic keeps the socket', async () => {
      const t = await connected()
      const ws = FakeWS.latest()
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(5000)
        ws.receive(new Uint8Array([0, 1, 0]).buffer)
      }
      expect(FakeWS.instances).toHaveLength(1)
      expect(t.isConnected).toBe(true)
      t.disconnect()
    })

    test('messageTimeout: 0 disables the check', async () => {
      const t = await connected({ messageTimeout: 0 })
      await vi.advanceTimersByTimeAsync(120000)
      expect(FakeWS.instances).toHaveLength(1)
      expect(t.isConnected).toBe(true)
      t.disconnect()
    })
  })
})
