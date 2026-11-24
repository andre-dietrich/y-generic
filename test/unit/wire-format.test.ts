/**
 * Wire-format golden test.
 *
 * Every peer in a room must speak the same bytes, and 2.x has to stay
 * compatible with 2.0.x (see CLAUDE.md, "Wire types"). The fixture
 * `fixtures/wire-2.0.3.json` holds frames captured from the 2.0.3 code with
 * deterministic inputs. This test checks both directions:
 *
 * - encode: the current code still produces exactly those bytes
 * - decode: a fresh provider still understands the 2.0.3 bytes
 *
 * Frames the current code deliberately no longer sends are listed in
 * DECODE_ONLY: they skip the encode check, but must keep decoding for as long
 * as 2.0.x peers have to be supported.
 *
 * To re-capture (only when the current code IS the reference; existing
 * DECODE_ONLY entries are kept):
 *   WIRE_CAPTURE=1 npx vitest run test/unit/wire-format.test.ts
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

/**
 * 2.0.3 frames the current code no longer produces, on purpose:
 * - update_verified: opcode 3 (seq + state-vector hash). Updates go out as
 *   opcode 0 (update_plain) since the cleanup's batch 3; its hash check caused
 *   needless resyncs on concurrent edits.
 */
const DECODE_ONLY = new Set(['update_verified'])

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
  // update_verified (opcode 3) is no longer sent: see DECODE_ONLY.
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
async function openPeerTransport(opts: { password?: string } = {}) {
  FakePeer.instances = []
  const t = new SimplePeerTransport({ peer: FakePeer as any, signaling: [], ...opts })
  await t.connect({ room: 'wire' })
  ;(t as any).handlePeerSignal('remote', { type: 'offer' })
  const peer = FakePeer.instances[0]
  peer.open()
  return { t, peer }
}

async function captureSimplePeerFrames(): Promise<Record<string, string>> {
  const frames: Record<string, string> = {}
  {
    const { t, peer } = await openPeerTransport({ password: 'password' })
    t.send(new Uint8Array([1, 2, 3, 4, 5]))
    frames.sp_complete_xor = toHex(peer.sent[0])
    t.sendControl('remote', new Uint8Array([9, 8, 7]))
    frames.sp_control = toHex(peer.sent[1])
    t.disconnect()
  }
  {
    const { t, peer } = await openPeerTransport()
    t.send(new Uint8Array([1, 2, 3]))
    frames.sp_complete_plain = toHex(peer.sent[0])
    t.disconnect()
  }
  return frames
}

describe('wire format (2.0.3 golden)', async () => {
  const providerFrames = await captureProviderFrames()
  const spFrames = await captureSimplePeerFrames()
  const current = { ...providerFrames, ...spFrames }

  if (process.env.WIRE_CAPTURE) {
    const existing = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) : {}
    const kept = Object.fromEntries(
      Object.entries(existing).filter(([name]) => DECODE_ONLY.has(name)),
    )
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
    fs.writeFileSync(FIXTURE, JSON.stringify({ ...current, ...kept }, null, 2) + '\n')
  }
  const golden: Record<string, string> = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))

  describe('encode: current code produces the 2.0.3 bytes', () => {
    for (const name of Object.keys(golden)) {
      if (DECODE_ONLY.has(name)) continue
      test(name, () => {
        expect(current[name]).toBe(golden[name])
      })
    }
  })

  describe('decode: a fresh provider understands the 2.0.3 bytes', () => {
    test('opcode 0 update applies', async () => {
      const { doc, transport } = await makeProvider(2)
      transport.deliver(fromHex(golden.update_plain))
      expect(doc.getText('t').toString()).toBe('hi')
    })

    test('opcode 3 verified update applies', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { doc, transport } = await makeProvider(2)
      transport.deliver(fromHex(golden.update_verified))
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
      transport.deliver(fromHex(golden.update_verified))
      expect(doc.getText('t').toString()).toBe('hi')
      expect(warn).not.toHaveBeenCalled()
      expect(transport.sent).toEqual([]) // no resync push, no SyncStep1
    })

    test('opcode 0 SyncStep1 gets a SyncStep2 reply', async () => {
      const { doc, transport } = await makeProvider(1)
      doc.getText('t').insert(0, 'hi')
      transport.sent = []
      transport.deliver(fromHex(golden.sync_step1_empty))
      expect(toHex(transport.sent[0])).toBe(golden.sync_step2)
    })

    test('opcode 0 SyncStep2 applies and marks the provider synced', async () => {
      const { doc, provider, transport } = await makeProvider(2)
      const synced = vi.fn()
      provider.on('synced', synced)
      transport.deliver(fromHex(golden.sync_step2))
      expect(doc.getText('t').toString()).toBe('hi')
      expect(provider.synced).toBe(true)
      expect(synced).toHaveBeenCalledWith(true)
    })

    test('opcode 1 channel 0 reaches awareness only', async () => {
      const { provider, transport } = await makeProvider(2)
      transport.deliver(fromHex(golden.awareness_main))
      expect(provider.awareness.getStates().get(1)).toEqual({ user: { name: 'alice' } })
      expect(provider.appAwareness.getStates().has(1)).toBe(false)
    })

    test('opcode 1 channel 1 reaches appAwareness only', async () => {
      const { provider, transport } = await makeProvider(2)
      transport.deliver(fromHex(golden.awareness_app))
      expect(provider.appAwareness.getStates().get(1)).toEqual({ cursor: 3 })
      expect(provider.awareness.getStates().has(1)).toBe(false)
    })

    test('opcode 2 pubsub is delivered to subscribers', async () => {
      const { provider, transport } = await makeProvider(2)
      const got = vi.fn()
      provider.pubsub.subscribe('chat', got)
      transport.deliver(fromHex(golden.pubsub))
      expect(got).toHaveBeenCalledWith({ text: 'hi' }, 'chat')
    })

    test('opcode 4 targeted pubsub is delivered to its target', async () => {
      const { provider, transport } = await makeProvider(2, { localId: 'peer-b' })
      const got = vi.fn()
      provider.pubsub.subscribe('rpc', got)
      transport.deliver(fromHex(golden.pubsub_targeted_broadcast))
      transport.deliver(fromHex(golden.pubsub_targeted_sendto))
      expect(got).toHaveBeenCalledTimes(2)
      expect(got).toHaveBeenCalledWith({ n: 1 }, 'rpc')
    })

    test('opcode 4 targeted pubsub is dropped by everyone else', async () => {
      const { provider, transport } = await makeProvider(2, { localId: 'someone-else' })
      const got = vi.fn()
      provider.pubsub.subscribe('*', got)
      transport.deliver(fromHex(golden.pubsub_targeted_broadcast))
      expect(got).not.toHaveBeenCalled()
    })

    test('a frame with a bad CRC32 is rejected', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { doc, transport } = await makeProvider(2)
      const bytes = fromHex(golden.update_plain)
      bytes[0] ^= 0xff
      transport.deliver(bytes)
      expect(doc.getText('t').toString()).toBe('')
    })
  })

  describe('simple-peer framing', () => {
    test('0x00 complete frame is type byte + XOR(password) payload', () => {
      const bytes = fromHex(golden.sp_complete_xor)
      const key = new TextEncoder().encode('password')
      expect(bytes[0]).toBe(0x00)
      const plain = bytes.slice(1).map((b, i) => b ^ key[i % key.length])
      expect([...plain]).toEqual([1, 2, 3, 4, 5])
    })

    test('0x02 control frame is never XORed', () => {
      expect(golden.sp_control).toBe('02090807')
    })

    test('receiving 0x00 decrypts and hands the payload to the provider', async () => {
      const { t, peer } = await openPeerTransport({ password: 'password' })
      const got: Uint8Array[] = []
      t.onMessage((d) => got.push(d))
      peer.receive(fromHex(golden.sp_complete_xor))
      expect([...got[0]]).toEqual([1, 2, 3, 4, 5])
      t.disconnect()
    })

    test('receiving 0x02 goes to control listeners, not the provider', async () => {
      const { t, peer } = await openPeerTransport({ password: 'password' })
      const data: Uint8Array[] = []
      const control: Array<[string, number[]]> = []
      t.onMessage((d) => data.push(d))
      t.onControlFrame((id, p) => control.push([id, [...p]]))
      peer.receive(fromHex(golden.sp_control))
      expect(data).toEqual([])
      expect(control).toEqual([['remote', [9, 8, 7]]])
      t.disconnect()
    })

    test('0x01 chunked frames: 13-byte header, XORed data, reassembled on receive', async () => {
      const { t, peer } = await openPeerTransport({ password: 'password' })
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
      const { t: rx, peer: rxPeer } = await openPeerTransport({ password: 'password' })
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
    test('strips the CRC32 header on send and adds it on receive', async () => {
      FakeWS.instances = []
      vi.stubGlobal('WebSocket', FakeWS)
      try {
        const t = new WebSocketTransport()
        const p = t.connect({ room: 'wire', serverUrl: 'wss://relay', messageTimeout: 0 } as any)
        FakeWS.latest().open()
        await p

        const frame = fromHex(golden.update_plain)
        t.send(frame)
        expect(toHex(FakeWS.latest().sent[0])).toBe(toHex(frame.subarray(4)))

        const got: Uint8Array[] = []
        t.onMessage((d) => got.push(d))
        FakeWS.latest().receive(frame.slice(4).buffer)
        expect(toHex(got[0])).toBe(golden.update_plain)
        t.disconnect()
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
