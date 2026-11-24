/**
 * Shared fakes for the unit tests: an in-memory transport that records what
 * the provider sends, a WebSocket stand-in, and a simple-peer stand-in.
 */
import type { Transport, ConnectionConfig } from '../../src/transport'

export const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')
export const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'))

export async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/**
 * Transport that records every frame handed to send()/sendTo() and lets the
 * test inject inbound frames with deliver(). Always reports connected once
 * connect() ran. Set `withSendTo` to expose the optional sendTo method.
 */
export class RecordingTransport implements Transport {
  sent: Uint8Array[] = []
  sentTo: Array<{ target: string; data: Uint8Array }> = []
  private _connected = false
  private _cb?: (d: Uint8Array) => void
  sendTo?: (target: string, data: Uint8Array) => void

  constructor(opts: { withSendTo?: boolean } = {}) {
    if (opts.withSendTo) {
      this.sendTo = (target, data) => {
        this.sentTo.push({ target, data: data.slice() })
      }
    }
  }

  async connect(_config: ConnectionConfig) {
    this._connected = true
  }
  disconnect() {
    this._connected = false
  }
  send(data: Uint8Array) {
    this.sent.push(data.slice())
  }
  onMessage(cb: (d: Uint8Array) => void) {
    this._cb = cb
    return () => {
      this._cb = undefined
    }
  }
  get isConnected() {
    return this._connected
  }
  deliver(data: Uint8Array) {
    this._cb?.(data)
  }
}

/**
 * WebSocket stand-in. Stays OPEN and silent until the test drives it, and
 * close() never fires onclose (the half-open, dead-TCP case).
 */
export class FakeWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWS[] = []
  readyState = FakeWS.CONNECTING
  binaryType = ''
  sent: any[] = []
  onopen: ((e?: any) => void) | null = null
  onmessage: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  onclose: ((e: any) => void) | null = null
  constructor(public url: string) {
    FakeWS.instances.push(this)
  }
  open() {
    this.readyState = FakeWS.OPEN
    this.onopen?.()
  }
  receive(data: any) {
    this.onmessage?.({ data })
  }
  send(data: any) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data)
  }
  close() {
    this.readyState = FakeWS.CLOSED
  }
  /** Server unreachable: the browser reports the failed connect. */
  fail() {
    this.readyState = FakeWS.CLOSED
    this.onerror?.({})
    this.onclose?.({ code: 1006 })
  }
  static latest() {
    return FakeWS.instances[FakeWS.instances.length - 1]
  }
}

/** RTCPeerConnection stand-in: on* properties plus addEventListener. */
export class FakePC {
  iceConnectionState = 'new'
  connectionState = 'new'
  oniceconnectionstatechange: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  private listeners: Record<string, Function[]> = {}
  addEventListener(event: string, cb: Function) {
    ;(this.listeners[event] ||= []).push(cb)
  }
  /** The browser reports a dead remote: ICE and the connection both fail. */
  fail() {
    this.iceConnectionState = 'failed'
    this.connectionState = 'failed'
    this.oniceconnectionstatechange?.()
    this.onconnectionstatechange?.()
    for (const ev of ['iceconnectionstatechange', 'connectionstatechange']) {
      ;(this.listeners[ev] || []).forEach((cb) => cb())
    }
  }
}

/**
 * RTCDataChannel stand-in with a buffer the test drains by hand, to exercise
 * the transport's backpressure path. Every send() adds to bufferedAmount.
 */
export class FakeChannel {
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onbufferedamountlow: (() => void) | null = null
  /** Empty the buffer and fire onbufferedamountlow, like the browser does. */
  drain() {
    this.bufferedAmount = 0
    this.onbufferedamountlow?.()
  }
}

/** simple-peer stand-in: a minimal event emitter, one per connection. */
export class FakePeer {
  static instances: FakePeer[] = []
  private listeners: Record<string, Function[]> = {}
  connected = false
  destroyed = false
  sent: Uint8Array[] = []
  signals: any[] = []
  _pc = new FakePC()
  _channel = new FakeChannel()
  constructor(public opts: any) {
    FakePeer.instances.push(this)
    // Like simple-peer: its own handler tears the peer down when ICE fails.
    this._pc.oniceconnectionstatechange = () => {
      if (this._pc.iceConnectionState === 'failed') this.destroy()
    }
  }
  on(event: string, cb: Function) {
    ;(this.listeners[event] ||= []).push(cb)
  }
  emit(event: string, arg?: any) {
    ;(this.listeners[event] || []).forEach((cb) => cb(arg))
  }
  send(data: Uint8Array) {
    this.sent.push(data.slice())
    this._channel.bufferedAmount += data.length
  }
  signal(s: any) {
    this.signals.push(s)
  }
  /** Like simple-peer, 'close' fires on a microtask, not inside destroy(). */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.connected = false
    queueMicrotask(() => this.emit('close'))
  }
  open() {
    this.connected = true
    this.emit('connect')
  }
  /** Deliver an inbound DataChannel message, as the remote would. */
  receive(data: Uint8Array) {
    this.emit('data', data)
  }
}
