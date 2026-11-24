/**
 * Wire-format golden test.
 *
 * Every peer in a room must speak the same bytes. `fixtures/wire-2.0.3.json`
 * holds frames captured from the 2.0.3 code with deterministic inputs; it is
 * the fixed reference and is never re-captured.
 *
 * 3.x changed exactly two things against 2.0.3:
 * - the provider no longer prefixes frames with a 4-byte CRC32, so each
 *   provider frame must equal its 2.0.3 counterpart minus those 4 bytes;
 * - simple-peer no longer XORs data with a password.
 * The WebSocket transport already stripped the CRC32 in 2.x before sending,
 * so the bytes on a WebSocket are unchanged: 2.0.3 clients and the edrys
 * relay keep working with 3.x. WebRTC and BroadcastChannel peers of 2.x and
 * 3.x are kept apart by a wire tag in the names they meet under (see
 * WIRE_TAG), not by this test.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { SimplePeerTransport } from '../../src/providers/simple-peer/index'
import { WebSocketTransport } from '../../src/providers/websocket/index'
import { RecordingTransport, FakePeer, FakeWS, toHex, fromHex } from './helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'wire-2.0.3.json')

/** 2.0.3 provider frames, which carried a CRC32 header (8 hex chars). */
const PROVIDER_FRAMES = [
  'sync_step1_empty',
  'update_plain',
  'update_verified',
  'sync_step2',
  'awareness_main',
  'awareness_app',
  'pubsub',
  'pubsub_targeted_broadcast',
  'pubsub_targeted_sendto',
]

/**
 * 2.0.3 frames the current code no longer produces, on purpose:
 * - update_verified: opcode 3 (seq + state-vector hash). Updates go out as
 *   opcode 0 (update_plain); its hash check caused needless resyncs on
 *   concurrent edits. Still decoded: 2.0.3 clients on the relay send it.
 * - sp_complete_xor: a simple-peer frame XORed with 'password'. 3.x peers
 *   never meet 2.x ones over WebRTC, so it is neither sent nor decoded.
 */
const NOT_SENT = new Set(['update_verified', 'sp_complete_xor'])

const golden: Record<string, string> = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))

/** A 2.0.3 frame as 3.x sends it: provider frames lose the CRC32 header. */
function v3(name: string): string {
  return PROVIDER_FRAMES.includes(name) ? golden[name].slice(8) : golden[name]
}

const providers: GenericProvider[] = []
afterEach(() => {
  while (providers.length) providers.pop()!.destroy()
  vi.restoreAllMocks()
})

/** Provider with fixed clientID and no timers/batching, so output is deterministic. */
async function makeProvider(
  clientID: number,
  opts: ConstructorParameters<typeof GenericProvider>[2] = {},
  transport = new RecordingTransport(),
) {
  const doc = new Y.Doc()
  doc.clientID = clientID
  const provider = new GenericProvider(doc, transport, {
    disableBc: true,
    syncInterval: 0,
    awarenessInterval: 0,
    batchUpdates: 0,
    syncMode: 'pull',
    ...opts,
  })
  providers.push(provider)
  await provider.connect({ room: 'wire' })
  return { doc, provider, transport }
}

/** Build every provider-level frame from the current code. */
async function captureProviderFrames(): Promise<Record<string, string>> {
  const frames: Record<string, string> = {}

  {
    // Pull-mode connect sends SyncStep1 first.
    const { transport } = await makeProvider(1)
    frames.sync_step1_empty = toHex(transport.sent[0])
  }
  {
    const { doc, transport } = await makeProvider(1)
    transport.sent = []
    doc.getText('t').insert(0, 'hi')
    frames.update_plain = toHex(transport.sent[0])
  }
  // update_verified (opcode 3) is no longer sent: see NOT_SENT.
  {
    // SyncStep2 reply to an empty peer's SyncStep1.
    const { doc, transport } = await makeProvider(1)
    doc.getText('t').insert(0, 'hi')
    transport.sent = []
    transport.deliver(fromHex(frames.sync_step1_empty))
    frames.sync_step2 = toHex(transport.sent[0])
  }
  {
    const { provider, transport } = await makeProvider(1)
    transport.sent = []
    provider.awareness.setLocalStateField('user', { name: 'alice' })
    frames.awareness_main = toHex(transport.sent[0])
    transport.sent = []
    provider.appAwareness.setLocalState({ cursor: 3 })
    frames.awareness_app = toHex(transport.sent[0])
  }
  {
    const { provider, transport } = await makeProvider(1)
    transport.sent = []
    provider.pubsub.publish('chat', { text: 'hi' })
    frames.pubsub = toHex(transport.sent[0])
    transport.sent = []
    provider.pubsub.publishTo('peer-b', 'rpc', { n: 1 })
    frames.pubsub_targeted_broadcast = toHex(transport.sent[0])
  }
  {
    const { provider, transport } = await makeProvider(
      1,
      {},
      new RecordingTransport({ withSendTo: true }),
    )
    provider.pubsub.publishTo('peer-b', 'rpc', { n: 1 })
    expect(transport.sentTo[0].target).toBe('peer-b')
    frames.pubsub_targeted_sendto = toHex(transport.sentTo[0].data)
  }

  return frames
}

/** simple-peer transport with one open FakePeer connection. */
async function openPeerTransport() {
  FakePeer.instances = []
  const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: [] })
  await t.connect({ room: 'wire' })
  ;(t as any).handlePeerSignal('remote', { type: 'offer' })
  const peer = FakePeer.instances[0]
  peer.open()
  return { t, peer }
}

async function captureSimplePeerFrames(): Promise<Record<string, string>> {
  const frames: Record<string, string> = {}
  {
    const { t, peer } = await openPeerTransport()
    t.send(new Uint8Array([1, 2, 3]))
    frames.sp_complete_plain = toHex(peer.sent[0])
    t.sendControl('remote', new Uint8Array([9, 8, 7]))
    frames.sp_control = toHex(peer.sent[1])
    t.disconnect()
  }
  return frames
}

describe('wire format (2.0.3 golden, minus CRC32 and XOR)', async () => {
  const providerFrames = await captureProviderFrames()
  const spFrames = await captureSimplePeerFrames()
  const current: Record<string, string> = { ...providerFrames, ...spFrames }

  describe('encode: current code produces the 2.0.3 bytes without CRC32/XOR', () => {
    for (const name of Object.keys(golden)) {
      if (NOT_SENT.has(name)) continue
      test(name, () => {
        expect(current[name]).toBe(v3(name))
      })
    }
  })

  describe('decode: a fresh provider understands the 2.0.3 bytes without CRC32', () => {
    test('opcode 0 update applies', async () => {
      const { doc, transport } = await makeProvider(2)
      transport.deliver(fromHex(v3('update_plain')))
      expect(doc.getText('t').toString()).toBe('hi')
    })

    test('opcode 3 verified update applies', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { doc, transport } = await makeProvider(2)
      transport.deliver(fromHex(v3('update_verified')))
      expect(doc.getText('t').toString()).toBe('hi')
      expect(warn).not.toHaveBeenCalled()
    })

    test('opcode 3 with a hash that does not match ours schedules no resync', async () => {
      // A 2.0.x sender's hash differs from ours whenever we applied an edit
      // it hadn't seen yet; that is not data loss.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { doc, transport } = await makeProvider(2)
      doc.getText('other').insert(0, 'local edit')
      transport.sent = []
      transport.deliver(fromHex(v3('update_verified')))
      expect(doc.getText('t').toString()).toBe('hi')
      expect(warn).not.toHaveBeenCalled()
      expect(transport.sent).toEqual([]) // no resync push, no SyncStep1
    })

    test('opcode 0 SyncStep1 gets a SyncStep2 reply', async () => {
      const { doc, transport } = await makeProvider(1)
      doc.getText('t').insert(0, 'hi')
      transport.sent = []
      transport.deliver(fromHex(v3('sync_step1_empty')))
      expect(toHex(transport.sent[0])).toBe(v3('sync_step2'))
    })

    test('opcode 0 SyncStep2 applies and marks the provider synced', async () => {
      const { doc, provider, transport } = await makeProvider(2)
      const synced = vi.fn()
      provider.on('synced', synced)
      transport.deliver(fromHex(v3('sync_step2')))
      expect(doc.getText('t').toString()).toBe('hi')
      expect(provider.synced).toBe(true)
      expect(synced).toHaveBeenCalledWith(true)
    })

    test('opcode 1 channel 0 reaches awareness only', async () => {
      const { provider, transport } = await makeProvider(2)
      transport.deliver(fromHex(v3('awareness_main')))
      expect(provider.awareness.getStates().get(1)).toEqual({ user: { name: 'alice' } })
      expect(provider.appAwareness.getStates().has(1)).toBe(false)
    })

    test('opcode 1 channel 1 reaches appAwareness only', async () => {
      const { provider, transport } = await makeProvider(2)
      transport.deliver(fromHex(v3('awareness_app')))
      expect(provider.appAwareness.getStates().get(1)).toEqual({ cursor: 3 })
      expect(provider.awareness.getStates().has(1)).toBe(false)
    })

    test('opcode 2 pubsub is delivered to subscribers', async () => {
      const { provider, transport } = await makeProvider(2)
      const got = vi.fn()
      provider.pubsub.subscribe('chat', got)
      transport.deliver(fromHex(v3('pubsub')))
      expect(got).toHaveBeenCalledWith({ text: 'hi' }, 'chat')
    })

    test('opcode 4 targeted pubsub is delivered to its target', async () => {
      const { provider, transport } = await makeProvider(2, { localId: 'peer-b' })
      const got = vi.fn()
      provider.pubsub.subscribe('rpc', got)
      transport.deliver(fromHex(v3('pubsub_targeted_broadcast')))
      transport.deliver(fromHex(v3('pubsub_targeted_sendto')))
      expect(got).toHaveBeenCalledTimes(2)
      expect(got).toHaveBeenCalledWith({ n: 1 }, 'rpc')
    })

    test('opcode 4 targeted pubsub is dropped by everyone else', async () => {
      const { provider, transport } = await makeProvider(2, { localId: 'someone-else' })
      const got = vi.fn()
      provider.pubsub.subscribe('*', got)
      transport.deliver(fromHex(v3('pubsub_targeted_broadcast')))
      expect(got).not.toHaveBeenCalled()
    })

    test('an undecodable frame is dropped, later frames still apply', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { doc, transport } = await makeProvider(2)
      const bytes = fromHex(v3('update_plain'))
      transport.deliver(bytes.slice(0, bytes.length - 3)) // truncated update
      expect(doc.getText('t').toString()).toBe('')
      expect(err).toHaveBeenCalled()
      transport.deliver(bytes)
      expect(doc.getText('t').toString()).toBe('hi')
    })

    test('an unknown opcode is ignored', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { doc, transport } = await makeProvider(2)
      transport.sent = []
      transport.deliver(new Uint8Array([9, 1, 2, 3]))
      expect(warn).toHaveBeenCalled()
      expect(doc.getText('t').toString()).toBe('')
      expect(transport.sent).toEqual([])
    })
  })

  describe('simple-peer framing', () => {
    test('0x00 complete frame is type byte + payload, unchanged', () => {
      expect(golden.sp_complete_plain).toBe('00010203')
    })

    test('0x02 control frame is type byte + payload', () => {
      expect(golden.sp_control).toBe('02090807')
    })

    test('receiving 0x00 hands the payload to the provider unchanged', async () => {
      const { t, peer } = await openPeerTransport()
      const got: Uint8Array[] = []
      t.onMessage((d) => got.push(d))
      peer.receive(fromHex(golden.sp_complete_plain))
      expect([...got[0]]).toEqual([1, 2, 3])
      t.disconnect()
    })

    test('a frame of unknown type is dropped', async () => {
      const { t, peer } = await openPeerTransport()
      const got: Uint8Array[] = []
      t.onMessage((d) => got.push(d))
      peer.receive(new Uint8Array([0x07, 1, 2, 3]))
      expect(got).toEqual([])
      t.disconnect()
    })

    test('receiving 0x02 goes to control listeners, not the provider', async () => {
      const { t, peer } = await openPeerTransport()
      const data: Uint8Array[] = []
      const control: Array<[string, number[]]> = []
      t.onMessage((d) => data.push(d))
      t.onControlFrame((id, p) => control.push([id, [...p]]))
      peer.receive(fromHex(golden.sp_control))
      expect(data).toEqual([])
      expect(control).toEqual([['remote', [9, 8, 7]]])
      t.disconnect()
    })

    test('0x01 chunked frames: 13-byte header, plain data, reassembled on receive', async () => {
      const { t, peer } = await openPeerTransport()
      const payload = new Uint8Array(70000).map((_, i) => i & 0xff)
      t.send(payload)
      // The first 64KB chunk fills the (fake) buffer; let it drain.
      peer._channel.drain()

      expect(peer.sent).toHaveLength(2)
      const views = peer.sent.map((c) => new DataView(c.buffer, c.byteOffset))
      for (const [i, c] of peer.sent.entries()) {
        expect(c[0]).toBe(0x01)
        expect(views[i].getUint32(5, true)).toBe(i) // chunkIndex
        expect(views[i].getUint32(9, true)).toBe(2) // totalChunks
      }
      expect(views[0].getUint32(1, true)).toBe(views[1].getUint32(1, true)) // messageId
      expect(peer.sent[0].length).toBe(64 * 1024)

      // Feed the chunks to a second transport: it must rebuild the payload.
      const { t: rx, peer: rxPeer } = await openPeerTransport()
      const got: Uint8Array[] = []
      rx.onMessage((d) => got.push(d))
      for (const c of peer.sent) rxPeer.receive(c)
      expect(got).toHaveLength(1)
      expect(Buffer.from(got[0]).equals(Buffer.from(payload))).toBe(true)
      t.disconnect()
      rx.disconnect()
    })
  })

  describe('websocket framing', () => {
    test('frames go out and come in unchanged: the same bytes as 2.0.3 on the socket', async () => {
      FakeWS.instances = []
      vi.stubGlobal('WebSocket', FakeWS)
      try {
        const t = new WebSocketTransport()
        const p = t.connect({ room: 'wire', serverUrl: 'wss://relay', messageTimeout: 0 } as any)
        FakeWS.latest().open()
        await p

        // 2.0.3 stripped the CRC32 before sending, so this is what it sent.
        const onSocket = v3('update_plain')
        t.send(fromHex(onSocket))
        expect(toHex(FakeWS.latest().sent[0])).toBe(onSocket)

        const got: Uint8Array[] = []
        t.onMessage((d) => got.push(d))
        FakeWS.latest().receive(fromHex(onSocket).buffer)
        expect(toHex(got[0])).toBe(onSocket)
        t.disconnect()
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
