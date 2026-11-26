/**
 * SimplePeerTransport behaviour that edrys-Lite depends on (see CLAUDE.md,
 * "How edrys-Lite uses this library"). Liveness tests ported from edrys-Lite's
 * tests/unit/ts/SignalingLiveness.test.ts; peer lifecycle tests adapted from
 * its EdrysSimplePeerTransport.test.ts.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { SimplePeerTransport } from '../../src/providers/simple-peer/index'
import { FakePeer, FakeWS, flush } from './helpers'

beforeEach(() => {
  FakeWS.instances = []
  FakePeer.instances = []
  vi.stubGlobal('WebSocket', FakeWS)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Transport with no signaling servers and one open connection per id. */
async function withPeers(ids: string[], opts: Record<string, any> = {}) {
  const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: [], ...opts })
  await t.connect({ room: 'room' })
  const peers: Record<string, FakePeer> = {}
  for (const id of ids) {
    ;(t as any).handlePeerSignal(id, { type: 'offer' })
    peers[id] = (t as any).peers.get(id).peer
    peers[id].open()
  }
  await flush()
  return { t, peers }
}

describe('peer lifecycle', () => {
  test('onPeerConnect supports several listeners (provider + edrys transport)', async () => {
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: [] })
    await t.connect({ room: 'room' })
    const a: string[] = []
    const b: string[] = []
    t.onPeerConnect((id) => a.push(id))
    const unsubB = t.onPeerConnect((id) => b.push(id))
    ;(t as any).handlePeerSignal('p1', { type: 'offer' })
    FakePeer.instances[0].open()
    expect(a).toEqual(['p1'])
    expect(b).toEqual(['p1'])

    unsubB()
    ;(t as any).handlePeerSignal('p2', { type: 'offer' })
    FakePeer.instances[1].open()
    expect(a).toEqual(['p1', 'p2'])
    expect(b).toEqual(['p1'])
    t.disconnect()
  })

  test('the first data frame counts as the channel opening', async () => {
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: [] })
    await t.connect({ room: 'room' })
    const opened: string[] = []
    t.onPeerConnect((id) => opened.push(id))
    ;(t as any).handlePeerSignal('p1', { type: 'offer' })
    FakePeer.instances[0].receive(new Uint8Array([0x02, 1]))
    expect(opened).toEqual(['p1'])
    expect(t.connectedPeers).toBe(1)
    t.disconnect()
  })

  test('onPeerDisconnect fires for every listener when a peer closes', async () => {
    const { t, peers } = await withPeers(['p1'])
    const a: string[] = []
    const b: string[] = []
    t.onPeerDisconnect((id) => a.push(id))
    t.onPeerDisconnect((id) => b.push(id))
    peers.p1.destroy()
    await flush()
    expect(a).toEqual(['p1'])
    expect(b).toEqual(['p1'])
    t.disconnect()
  })

  test('a failed ICE connection is reported as a disconnect (no ghost peer)', async () => {
    // simple-peer's own on* handlers turn ICE failure into 'close'; the
    // transport must listen with addEventListener and not replace them.
    const { t, peers } = await withPeers(['p1'])
    const left: string[] = []
    t.onPeerDisconnect((id) => left.push(id))
    peers.p1._pc.fail()
    await flush()
    expect(left).toEqual(['p1'])
    expect(t.connectedPeers).toBe(0)
    t.disconnect()
  })

  test('onPeerDisconnect does not fire for a peer that never opened', async () => {
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: [] })
    await t.connect({ room: 'room' })
    const left: string[] = []
    t.onPeerDisconnect((id) => left.push(id))
    ;(t as any).handlePeerSignal('p1', { type: 'offer' })
    FakePeer.instances[0].destroy()
    await flush()
    expect(left).toEqual([])
    t.disconnect()
  })

  test('disconnectPeer tears one peer down and reports it', async () => {
    const { t, peers } = await withPeers(['p1', 'p2'])
    const left: string[] = []
    t.onPeerDisconnect((id) => left.push(id))
    t.disconnectPeer('p1')
    await flush() // the late 'close' must not report p1 a second time
    expect(peers.p1.destroyed).toBe(true)
    expect(peers.p2.destroyed).toBe(false)
    expect(left).toEqual(['p1'])
    t.disconnect()
  })

  test('a late close of a replaced connection does not remove the new one', async () => {
    const { t, peers } = await withPeers(['p1'])
    const old = peers.p1
    ;(t as any).removePeer('p1')
    ;(t as any).handlePeerSignal('p1', { type: 'offer' })
    const fresh: FakePeer = (t as any).peers.get('p1').peer
    expect(fresh).not.toBe(old)
    old.emit('close')
    old.emit('error', new Error('late'))
    expect((t as any).peers.get('p1').peer).toBe(fresh)
    t.disconnect()
  })
})

describe('sending', () => {
  test('send reaches every open peer, sendTo only its target', async () => {
    const { t, peers } = await withPeers(['p1', 'p2'])
    t.send(new Uint8Array([1]))
    expect(peers.p1.sent).toHaveLength(1)
    expect(peers.p2.sent).toHaveLength(1)

    t.sendTo('p2', new Uint8Array([2]))
    expect(peers.p1.sent).toHaveLength(1)
    expect([...peers.p2.sent[1]]).toEqual([0x00, 2])
    t.disconnect()
  })

  test('sendTo and sendControl to an unknown peer are dropped quietly', async () => {
    const { t, peers } = await withPeers(['p1'])
    t.sendTo('nobody', new Uint8Array([1]))
    t.sendControl('nobody', new Uint8Array([1]))
    expect(peers.p1.sent).toHaveLength(0)
    t.disconnect()
  })
})

describe('send queue and flow control (B3)', () => {
  const big = (fill: number) => new Uint8Array(200_000).fill(fill)
  const chunksFor = (n: number) => Math.ceil(n / (64 * 1024 - 13))
  const drainAll = (peer: FakePeer) => {
    for (let i = 0; i < 50; i++) peer._channel.drain()
  }

  test('two large messages to one peer are both sent completely', async () => {
    const { t, peers } = await withPeers(['p1'])
    t.send(big(1))
    t.send(big(2))
    drainAll(peers.p1)
    expect(peers.p1.sent).toHaveLength(2 * chunksFor(200_000))
    t.disconnect()
  })

  test('frames leave in the order they were sent', async () => {
    const { t, peers } = await withPeers(['p1'])
    t.send(big(1))
    t.send(new Uint8Array([42]))
    t.send(big(2))
    drainAll(peers.p1)

    const n = chunksFor(200_000)
    const types = peers.p1.sent.map((f) => f[0])
    expect(types).toEqual([...Array(n).fill(0x01), 0x00, ...Array(n).fill(0x01)])
    t.disconnect()
  })

  test('both large messages arrive intact at the other side', async () => {
    const { t, peers } = await withPeers(['p1'])
    t.send(big(1))
    t.send(big(2))
    drainAll(peers.p1)

    const { t: rx, peers: rxPeers } = await withPeers(['tx'])
    const got: Uint8Array[] = []
    rx.onMessage((d) => got.push(d))
    for (const f of peers.p1.sent) rxPeers.tx.receive(f)
    expect(got.map((m) => [m.length, m[0], m[m.length - 1]])).toEqual([
      [200_000, 1, 1],
      [200_000, 2, 2],
    ])
    t.disconnect()
    rx.disconnect()
  })

  test('sends go out immediately while the buffer has room', async () => {
    const { t, peers } = await withPeers(['p1'])
    t.send(new Uint8Array([1]))
    t.send(new Uint8Array([2]))
    expect(peers.p1.sent).toHaveLength(2)
    t.disconnect()
  })

  test('control frames skip the queue', async () => {
    const { t, peers } = await withPeers(['p1'])
    t.send(big(1)) // fills the buffer, rest waits
    const before = peers.p1.sent.length
    t.sendControl('p1', new Uint8Array([7]))
    expect(peers.p1.sent).toHaveLength(before + 1)
    expect([...peers.p1.sent[before]]).toEqual([0x02, 7])
    t.disconnect()
  })

  test('a small frame queued behind a full buffer goes out when it drains (simple-peer’s own handler set)', async () => {
    // simple-peer assigns channel.onbufferedamountlow itself; a queue that only
    // resumes from that property never resumed, and a join's awareness frame
    // waited behind the full-state push until some later send.
    const { t, peers } = await withPeers(['p1'])
    t.send(new Uint8Array(40_000)) // one frame, over the 16KB pause mark
    t.send(new Uint8Array([42]))
    expect(peers.p1.sent).toHaveLength(1)
    peers.p1._channel.drain()
    expect(peers.p1.sent).toHaveLength(2)
    expect([...peers.p1.sent[1]]).toEqual([0x00, 42])
    expect(peers.p1._channel.simplePeerDrains).toBe(1) // its handler still runs
    t.disconnect()
  })

  test('a queue whose drain event never fires resumes on the fallback timer', async () => {
    vi.useFakeTimers()
    const { t, peers } = await withPeers(['p1'])
    t.send(new Uint8Array(40_000))
    t.send(new Uint8Array([42]))
    expect(peers.p1.sent).toHaveLength(1)
    peers.p1._channel.bufferedAmount = 0 // drained, but no event
    vi.advanceTimersByTime(300)
    expect(peers.p1.sent).toHaveLength(2)
    t.disconnect()
  })

  test('a removed peer’s queue is dropped, not sent on drain', async () => {
    const { t, peers } = await withPeers(['p1'])
    t.send(big(1))
    const before = peers.p1.sent.length
    t.disconnectPeer('p1')
    drainAll(peers.p1)
    expect(peers.p1.sent).toHaveLength(before)
    t.disconnect()
  })
})

describe('chunk reassembly limits (B3)', () => {
  function chunk(messageId: number, index: number, total: number, data = [0]) {
    const c = new Uint8Array(13 + data.length)
    const v = new DataView(c.buffer)
    c[0] = 0x01
    v.setUint32(1, messageId, true)
    v.setUint32(5, index, true)
    v.setUint32(9, total, true)
    c.set(data, 13)
    return c
  }
  async function receiver() {
    const { t, peers } = await withPeers(['p1'])
    const got: Uint8Array[] = []
    t.onMessage((d) => got.push(d))
    const buffers = () => (t as any).peers.get('p1').chunkBuffers as Map<number, any>
    return { t, peer: peers.p1, got, buffers }
  }

  test('chunks with an invalid header are dropped', async () => {
    const { t, peer, buffers } = await receiver()
    peer.receive(chunk(1, 5, 2)) // index out of range
    peer.receive(chunk(2, 0, 0)) // zero chunks
    peer.receive(chunk(3, 0, 1_000_000)) // absurd count
    peer.receive(new Uint8Array([0x01, 0, 0])) // truncated header
    expect(buffers().size).toBe(0)
    t.disconnect()
  })

  test('at most 16 partial messages are kept per peer, oldest evicted', async () => {
    const { t, peer, buffers } = await receiver()
    for (let id = 0; id < 20; id++) peer.receive(chunk(id, 0, 2))
    expect(buffers().size).toBe(16)
    expect(buffers().has(0)).toBe(false)
    expect(buffers().has(19)).toBe(true)
    t.disconnect()
  })

  test('a partial message is discarded after 30s without a chunk', async () => {
    vi.useFakeTimers()
    const { t, peer, buffers } = await receiver()
    peer.receive(chunk(1, 0, 2))
    vi.advanceTimersByTime(31000)
    peer.receive(chunk(2, 0, 2)) // any later chunk triggers the sweep
    expect([...buffers().keys()]).toEqual([2])
    t.disconnect()
  })

  test('partial messages from an untrusted peer are capped at 16MB in total', async () => {
    const { t, peers } = await withPeers(['p1'], { requireTrust: true })
    t.onMessage(() => {})
    const buffers = (t as any).peers.get('p1').chunkBuffers as Map<number, any>
    const big = new Array(256 * 1024).fill(7) // a max-size data channel message
    // 64 chunks of 256KB = 16MB fit across messages; the next one doesn't.
    for (let id = 0; id < 16; id++) {
      for (let i = 0; i < 4; i++) peers.p1.receive(chunk(id, i, 4096, big))
    }
    expect(buffers.size).toBe(16)
    peers.p1.receive(chunk(0, 4, 4096, big))
    expect(buffers.has(0)).toBe(false)
    let total = 0
    for (const b of buffers.values()) total += b.bytes
    expect(total).toBeLessThanOrEqual(16 * 1024 * 1024)
    t.disconnect()
  })

  test('a trusted peer may buffer more than the untrusted cap', async () => {
    const { t, peers } = await withPeers(['p1'], { requireTrust: true })
    t.onMessage(() => {})
    t.trustPeer('p1')
    const buffers = (t as any).peers.get('p1').chunkBuffers as Map<number, any>
    const big = new Array(256 * 1024).fill(7)
    for (let i = 0; i < 100; i++) peers.p1.receive(chunk(1, i, 4096, big)) // 25MB
    expect(buffers.get(1).chunks.size).toBe(100)
    t.disconnect()
  })

  test('a reused message id with a different chunk count starts over', async () => {
    const { t, peer, got } = await receiver()
    peer.receive(chunk(1, 0, 3, [9]))
    peer.receive(chunk(1, 0, 2, [1]))
    peer.receive(chunk(1, 1, 2, [2]))
    expect(got.map((m) => [...m])).toEqual([[1, 2]])
    t.disconnect()
  })
})

describe('peer discovery', () => {
  test('a peer announced earlier but no longer connected is reconnected', async () => {
    vi.useFakeTimers()
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: ['wss://sig'] })
    const p = t.connect({ room: 'room' })
    FakeWS.latest().open()
    await p
    const ws = FakeWS.latest()

    // A lower id than ours: we are not the initiator.
    const announce = { type: 'publish', topic: 'room', from: '0' }
    ws.receive(JSON.stringify(announce))
    expect(FakePeer.instances).toHaveLength(1)

    FakePeer.instances[0].destroy() // connection lost
    await flush()
    ws.receive(JSON.stringify(announce))
    expect(FakePeer.instances).toHaveLength(2)
    t.disconnect()
  })
})

describe('connect timeout', () => {
  const TURN = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }]

  async function stalledInitiator(iceServers?: any[]) {
    vi.useFakeTimers()
    const t = new SimplePeerTransport({
      peer: FakePeer as any,
      signaling: [],
      ...(iceServers ? { iceServers } : {}),
    })
    await t.connect({ room: 'room' })
    ;(t as any)._peerLastSeen.set('remote', Date.now())
    ;(t as any).createPeerConnection('remote', true)
    return t
  }

  test('the initiator drops a connection that never opens and offers again', async () => {
    const t = await stalledInitiator()
    expect(FakePeer.instances).toHaveLength(1)
    ;(t as any)._peerLastSeen.set('remote', Date.now() + 4000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakePeer.instances[0].destroyed).toBe(true)
    expect(FakePeer.instances).toHaveLength(2)
    expect(FakePeer.instances[1].opts.initiator).toBe(true)
    t.disconnect()
  })

  test('the retry goes relay-only when a TURN server is configured', async () => {
    const t = await stalledInitiator(TURN)
    expect(FakePeer.instances[0].opts.config.iceTransportPolicy).toBeUndefined()
    ;(t as any)._peerLastSeen.set('remote', Date.now() + 4000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakePeer.instances[1].opts.config.iceTransportPolicy).toBe('relay')
    t.disconnect()
  })

  test('without a TURN server the retry stays direct', async () => {
    const t = await stalledInitiator()
    ;(t as any)._peerLastSeen.set('remote', Date.now() + 4000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakePeer.instances[1].opts.config.iceTransportPolicy).toBeUndefined()
    t.disconnect()
  })

  test('a peer that left the room is not offered again', async () => {
    const t = await stalledInitiator()
    await vi.advanceTimersByTimeAsync(5000 + 12000) // past PEER_SEEN_WINDOW
    expect(FakePeer.instances.filter((p) => !p.destroyed)).toHaveLength(0)
    t.disconnect()
  })

  test('an offer with a new attempt id replaces the stuck connection', async () => {
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: [] })
    await t.connect({ room: 'room' })
    ;(t as any).handlePeerSignal('remote', { type: 'offer', sdp: 'one' }, 'a1')
    ;(t as any).handlePeerSignal('remote', { type: 'offer', sdp: 'two' }, 'a2')
    expect(FakePeer.instances).toHaveLength(2)
    expect(FakePeer.instances[0].destroyed).toBe(true)

    // A candidate from the old attempt is ignored, not applied.
    ;(t as any).handlePeerSignal('remote', { candidate: 'c' }, 'a1')
    expect(FakePeer.instances[1].signals).toEqual([{ type: 'offer', sdp: 'two' }])
    t.disconnect()
  })

  test('the same offer arriving twice (two signaling servers) is applied once', async () => {
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: [] })
    await t.connect({ room: 'room' })
    ;(t as any).handlePeerSignal('remote', { type: 'offer', sdp: 'one' }, 'a1')
    ;(t as any).handlePeerSignal('remote', { type: 'offer', sdp: 'one' }, 'a1')
    expect(FakePeer.instances).toHaveLength(1)
    expect(FakePeer.instances[0].signals).toHaveLength(1)
    t.disconnect()
  })
})

describe('signaling liveness (ported from edrys-Lite)', () => {
  async function connected() {
    vi.useFakeTimers()
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: ['wss://sig'] })
    const p = t.connect({ room: 'room' })
    FakeWS.latest().open()
    await p
    return t
  }

  test('pings a quiet socket, then reconnects it after 30s of silence', async () => {
    const t = await connected()
    const dead = FakeWS.latest()

    await vi.advanceTimersByTimeAsync(18000)
    expect(dead.sent.some((m) => m.type === 'ping')).toBe(true)
    expect(FakeWS.instances).toHaveLength(1)

    // Dropped at the first check past 30s, reconnected after ~360ms backoff.
    await vi.advanceTimersByTimeAsync(16000)
    expect(FakeWS.instances).toHaveLength(2)
    expect(t.signalingHealth.open).toBe(0)

    // Replacement opens and re-subscribes to the room.
    FakeWS.latest().open()
    expect(FakeWS.latest().sent.some((m) => m.type === 'subscribe')).toBe(true)
    expect(t.signalingHealth.open).toBe(1)
    t.disconnect()
  })

  test('a socket that keeps receiving messages is never dropped', async () => {
    const t = await connected()
    const ws = FakeWS.latest()
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(5000)
      // A healthy server echoes our own re-announce back.
      ws.receive(JSON.stringify({ type: 'publish', topic: 'room', from: (t as any).peerId }))
    }
    expect(FakeWS.instances).toHaveLength(1)
    expect(t.signalingHealth.open).toBe(1)
    t.disconnect()
  })

  test('the signaling topic is the room tagged with the wire version', async () => {
    // 2.x peers (CRC32 + XOR framing) subscribe to the bare room name and
    // must never connect to us.
    const t = await connected()
    const ws = FakeWS.latest()
    ws.sent = []
    await vi.advanceTimersByTimeAsync(5000)
    expect(ws.sent.map((m) => m.topics?.[0] ?? m.topic)).toEqual(['room/v3', 'room/v3'])
    t.disconnect()
  })

  test('re-subscribes and re-announces every 5s', async () => {
    const t = await connected()
    const ws = FakeWS.latest()
    ws.sent = []
    await vi.advanceTimersByTimeAsync(5000)
    expect(ws.sent.map((m) => m.type)).toEqual(['subscribe', 'publish'])
    t.disconnect()
  })

  test('retries when the first signaling connect fails', async () => {
    vi.useFakeTimers()
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: ['wss://sig'] })
    const p = t.connect({ room: 'room' })
    FakeWS.latest().fail()
    await p

    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeWS.instances).toHaveLength(2)
    FakeWS.latest().open()
    expect(t.signalingHealth.open).toBe(1)
    expect(FakeWS.latest().sent.some((m) => m.type === 'subscribe')).toBe(true)
    t.disconnect()
  })

  test('retries when the first signaling connect hangs', async () => {
    vi.useFakeTimers()
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: ['wss://sig'] })
    const p = t.connect({ room: 'room' })
    const hung = FakeWS.latest()
    await vi.advanceTimersByTimeAsync(10000) // connect timeout
    await p

    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeWS.instances).toHaveLength(2)
    FakeWS.latest().open()
    // The abandoned socket opening late must not become a second connection.
    hung.open()
    expect(t.signalingHealth.open).toBe(1)
    t.disconnect()
  })

  test('a dropped signaling socket is reconnected', async () => {
    const t = await connected()
    FakeWS.latest().fail()
    expect(t.signalingHealth.reconnecting).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeWS.instances).toHaveLength(2)
    t.disconnect()
  })

  test('disconnect() stops the check and does not reconnect', async () => {
    const t = await connected()
    const ws = FakeWS.latest()
    t.disconnect()
    // A real socket fires onclose after close(); it must not count as a drop.
    ws.onclose?.({ code: 1000 })
    await vi.advanceTimersByTimeAsync(120000)
    expect(FakeWS.instances).toHaveLength(1)
    expect(t.signalingHealth.reconnecting).toBe(0)
  })
})

describe('trust gate (requireTrust)', () => {
  /** A data frame as a peer sends it: [0x00][payload]. */
  const frame = (...bytes: number[]) => new Uint8Array([0x00, ...bytes])

  async function gated(ids = ['p1']) {
    const { t, peers } = await withPeers(ids, { requireTrust: true })
    const got: number[][] = []
    t.onMessage((d) => got.push([...d]))
    return { t, peers, got }
  }

  test('frames from an untrusted peer are held, then delivered in order on trust', async () => {
    const { t, peers, got } = await gated()
    peers.p1.receive(frame(1))
    peers.p1.receive(frame(2))
    expect(got).toEqual([])
    expect(t.isPeerTrusted('p1')).toBe(false)

    expect(t.trustPeer('p1')).toBe(true)
    expect(got).toEqual([[1], [2]])
    peers.p1.receive(frame(3))
    expect(got).toEqual([[1], [2], [3]])
    expect(t.isPeerTrusted('p1')).toBe(true)
    t.disconnect()
  })

  test('trust is per peer', async () => {
    const { t, peers, got } = await gated(['p1', 'p2'])
    t.trustPeer('p1')
    peers.p1.receive(frame(1))
    peers.p2.receive(frame(2))
    expect(got).toEqual([[1]])
    t.disconnect()
  })

  test('control frames bypass the gate', async () => {
    const { t, peers } = await gated()
    const control: number[][] = []
    t.onControlFrame((_id, payload) => control.push([...payload]))
    peers.p1.receive(new Uint8Array([0x02, 7]))
    expect(control).toEqual([[7]])
    t.disconnect()
  })

  test('chunked messages are held until trust as well', async () => {
    const { t, peers, got } = await gated()
    const header = (i: number, total: number) => {
      const h = new Uint8Array(13)
      const v = new DataView(h.buffer)
      h[0] = 0x01
      v.setUint32(1, 42, true)
      v.setUint32(5, i, true)
      v.setUint32(9, total, true)
      return h
    }
    peers.p1.receive(new Uint8Array([...header(0, 2), 1]))
    peers.p1.receive(new Uint8Array([...header(1, 2), 2]))
    expect(got).toEqual([])
    t.trustPeer('p1')
    expect(got).toEqual([[1, 2]])
    t.disconnect()
  })

  test('held frames are discarded when the peer disconnects; a new connection starts untrusted', async () => {
    const { t, peers, got } = await gated()
    peers.p1.receive(frame(1))
    t.disconnectPeer('p1')
    await flush()
    expect(t.trustPeer('p1')).toBe(false) // no connection

    ;(t as any).handlePeerSignal('p1', { type: 'offer' })
    const again = (t as any).peers.get('p1').peer as FakePeer
    again.open()
    again.receive(frame(2))
    expect(t.isPeerTrusted('p1')).toBe(false)
    t.trustPeer('p1')
    expect(got).toEqual([[2]])
    t.disconnect()
  })

  test('at most 256 frames are held per peer', async () => {
    const { t, peers, got } = await gated()
    for (let i = 0; i < 300; i++) peers.p1.receive(frame(i % 256))
    t.trustPeer('p1')
    expect(got).toHaveLength(256)
    t.disconnect()
  })

  test('without requireTrust, frames are delivered right away', async () => {
    const { t, peers } = await withPeers(['p1'])
    const got: number[][] = []
    t.onMessage((d) => got.push([...d]))
    peers.p1.receive(frame(1))
    expect(got).toEqual([[1]])
    t.disconnect()
  })
})

describe('reachesAllPeers (awareness relay hint)', () => {
  const seen = (t: SimplePeerTransport, id: string) =>
    (t as any)._peerLastSeen.set(id, Date.now())

  test('true while every peer seen via signaling is connected', async () => {
    const { t } = await withPeers(['p1', 'p2'])
    seen(t, 'p1')
    seen(t, 'p2')
    expect(t.reachesAllPeers).toBe(true)
    t.disconnect()
  })

  test('false while a peer in the room is not connected to us', async () => {
    const { t } = await withPeers(['p1'])
    seen(t, 'p1')
    seen(t, 'p3') // announced, but no connection (yet, or at capacity)
    expect(t.reachesAllPeers).toBe(false)
    t.disconnect()
  })

  test('a peer not seen for a while no longer counts', async () => {
    vi.useFakeTimers()
    const { t } = await withPeers(['p1'])
    seen(t, 'p1')
    seen(t, 'gone')
    expect(t.reachesAllPeers).toBe(false)
    vi.advanceTimersByTime(13000)
    expect(t.reachesAllPeers).toBe(true)
    t.disconnect()
  })

  test('false from 20 peers on, where some may be at their connection limit', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`)
    const { t } = await withPeers(ids, { maxConns: 34 })
    expect(t.reachesAllPeers).toBe(false)
    ;(t as any).removePeer('p0')
    await flush()
    expect(t.reachesAllPeers).toBe(true)
    t.disconnect()
  })

  test('a lower maxConns lowers the limit', async () => {
    const { t } = await withPeers(['p1', 'p2', 'p3'], { maxConns: 3 })
    expect(t.reachesAllPeers).toBe(false)
    t.disconnect()
  })
})

describe('identity info (prep for binding the handshake)', () => {
  test('localPeerId is the id announced to signaling', async () => {
    const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: ['wss://s'] })
    void t.connect({ room: 'room' })
    FakeWS.latest().open()
    const announced = FakeWS.latest().sent.find((m) => m.from)
    expect(t.localPeerId).toBeTruthy()
    expect(announced.from).toBe(t.localPeerId)
    t.disconnect()
  })

  test('getPeerFingerprints reads both DTLS fingerprints from the SDP', async () => {
    const { t, peers } = await withPeers(['p1'])
    const pc = peers.p1._pc as any
    expect(t.getPeerFingerprints('p1')).toEqual({ local: undefined, remote: undefined })
    pc.localDescription = { sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\na=setup:actpass\r\n' }
    pc.remoteDescription = { sdp: 'v=0\r\na=fingerprint:sha-256 CC:DD\r\n' }
    expect(t.getPeerFingerprints('p1')).toEqual({
      local: 'sha-256 AA:BB',
      remote: 'sha-256 CC:DD',
    })
    expect(t.getPeerFingerprints('nobody')).toBeUndefined()
    t.disconnect()
  })
})
