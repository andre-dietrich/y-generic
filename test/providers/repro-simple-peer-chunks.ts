/**
 * Repro: two large frames to one peer at the same time - do both arrive?
 *
 * SimplePeerTransport sends a frame above 64 KiB as chunks and waits whenever
 * the data channel's buffer is over 16 KiB. It waited through the channel's
 * `onbufferedamountlow` PROPERTY - one slot: the second frame that had to wait
 * replaced the first one's handler, and the first never sent another chunk.
 * Its receiver kept the half message for good; the update came back only
 * through a resync. Two large frames to one peer at once are an ordinary
 * moment: the full answer to a joiner (sendTo) and a large paste (send). The
 * property is simple-peer's as well (its stream backpressure).
 *
 * The real SimplePeerTransport on a scripted simple-peer whose channel fills
 * its buffer with what is sent and drains 32 KiB every 5 ms, firing
 * `bufferedamountlow` as a browser does (the property and the event).
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-simple-peer-chunks.js
 * Exit code 1 unless both frames arrive whole.
 */
import { SimplePeerTransport } from '../../src/providers/simple-peer/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeChannel extends EventTarget {
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onbufferedamountlow: (() => void) | null = null
  received: Uint8Array[] = []
  private drain = setInterval(() => {
    if (this.bufferedAmount === 0) return
    const before = this.bufferedAmount
    this.bufferedAmount = Math.max(0, before - 32 * 1024)
    if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.onbufferedamountlow?.()
      this.dispatchEvent(new Event('bufferedamountlow'))
    }
  }, 5)
  send(data: Uint8Array) {
    this.received.push(data)
    this.bufferedAmount += data.length
  }
  stop() {
    clearInterval(this.drain)
  }
}

class FakePeer {
  static last: FakePeer
  _channel = new FakeChannel()
  private handlers = new Map<string, Array<(...a: any[]) => void>>()
  constructor() {
    FakePeer.last = this
  }
  on(event: string, cb: (...a: any[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb])
  }
  emit(event: string, ...a: any[]) {
    for (const h of this.handlers.get(event) ?? []) h(...a)
  }
  send(data: Uint8Array) {
    this._channel.send(data)
  }
  signal() {}
  destroy() {
    this._channel.stop()
  }
}

async function main() {
  const transport = new SimplePeerTransport({ peer: FakePeer, signaling: [], resumeAfterMs: 0 })
  ;(transport as any)._connected = true
  ;(transport as any).createPeerConnection('remote', true)
  const peer = FakePeer.last
  peer.emit('connect')

  const a = Uint8Array.from({ length: 300000 }, (_, i) => i & 0xff)
  const b = Uint8Array.from({ length: 300000 }, (_, i) => (i * 7) & 0xff)
  transport.send(a) // a large paste, to everyone
  transport.sendTo('remote', b) // the full answer to this peer, at the same moment
  await sleep(2000)

  // Reassemble what the channel got: [type][messageId][index][total][data]
  const messages = new Map<number, { total: number; parts: Map<number, Uint8Array> }>()
  for (const chunk of peer._channel.received) {
    if (chunk[0] !== 1) continue
    const view = new DataView(chunk.buffer, chunk.byteOffset)
    const id = view.getUint32(1, true)
    const m = messages.get(id) ?? { total: view.getUint32(9, true), parts: new Map() }
    m.parts.set(view.getUint32(5, true), chunk.subarray(13))
    messages.set(id, m)
  }
  const whole = [...messages.values()].map((m) => {
    if (m.parts.size !== m.total) return null
    const out = new Uint8Array([...m.parts.values()].reduce((n, p) => n + p.length, 0))
    let o = 0
    for (let i = 0; i < m.total; i++) {
      out.set(m.parts.get(i)!, o)
      o += m.parts.get(i)!.length
    }
    return out
  })
  const same = (x: Uint8Array | null, y: Uint8Array) => !!x && x.length === y.length && x.every((v, i) => v === y[i])
  const gotA = whole.some((w) => same(w, a))
  const gotB = whole.some((w) => same(w, b))
  const parts = [...messages.values()].map((m) => `${m.parts.size}/${m.total}`).join(', ')
  console.log(`two 300 KB frames at once: chunks per frame ${parts}; send() whole ${gotA}, sendTo() whole ${gotB} (want true, true)`)
  // simple-peer's own handler on the property is left alone
  console.log(`the channel's onbufferedamountlow property: ${peer._channel.onbufferedamountlow === null ? 'null' : 'set'} (simple-peer's to own)`)
  transport.disconnect()
  peer.destroy()
  process.exit(gotA && gotB ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
