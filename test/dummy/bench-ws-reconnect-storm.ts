/**
 * Benchmark: what does a classroom of WebSocket clients do to a relay that
 * is down - and how do they come back when it returns?
 *
 * WebSocketTransport reconnects on its own after an unintentional close.
 * Before round 7 the delay was a flat `reconnectDelay` (2 s) with no cap on
 * attempts: CLIENTS browsers in lockstep, one attempt every 2 s each, and
 * when the relay returns all of them reconnect - and send their JOIN
 * beacons - inside the same 2 s window. Round 7 makes the delay exponential
 * with jitter, capped at `maxReconnectDelay`.
 *
 * The WebSocket global is replaced by a stub that counts constructions and
 * fails (onerror + onclose) after 5 ms while `serverUp` is false, opens
 * otherwise. CLIENTS transports connect against it during an outage of
 * OUTAGE_MS; reported: connection attempts per 10 s bucket and per minute,
 * then the spread of reconnect times once the server is back (the herd's
 * width). No GenericProvider involved - this is the transport alone.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-ws-reconnect-storm.js
 *      CLIENTS=30 OUTAGE_MS=60000 RECONNECT_DELAY_MS=2000 MAX_RECONNECT_DELAY_MS=10000 override.
 */

import { WebSocketTransport } from '../../src/providers/websocket/index'
import { sleep } from './bench-user-scaling'

const CLIENTS = Number(process.env.CLIENTS ?? 30)
const OUTAGE_MS = Number(process.env.OUTAGE_MS ?? 60000)
const RECONNECT_DELAY_MS = process.env.RECONNECT_DELAY_MS
  ? Number(process.env.RECONNECT_DELAY_MS)
  : undefined
const MAX_RECONNECT_DELAY_MS = process.env.MAX_RECONNECT_DELAY_MS
  ? Number(process.env.MAX_RECONNECT_DELAY_MS)
  : undefined
const BUCKET_MS = 10000

let serverUp = false
let serverUpAt = 0
const attemptTimes: number[] = []
const openTimes: number[] = []

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null

  constructor(_url: string, _protocols?: unknown) {
    attemptTimes.push(Date.now())
    setTimeout(() => {
      if (serverUp) {
        this.readyState = FakeWebSocket.OPEN
        openTimes.push(Date.now() - serverUpAt)
        this.onopen?.()
      } else {
        this.readyState = FakeWebSocket.CLOSED
        this.onerror?.({})
        this.onclose?.({ code: 1006, reason: '' })
      }
    }, 5)
  }

  send(_data: unknown): void {}

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

async function main() {
  ;(globalThis as any).WebSocket = FakeWebSocket
  if ((globalThis as any).WebSocket !== FakeWebSocket) {
    throw new Error('could not replace the WebSocket global')
  }
  console.log(
    `ws reconnect storm: clients=${CLIENTS} outage=${OUTAGE_MS}ms ` +
      `reconnectDelay=${RECONNECT_DELAY_MS ?? 'default'} maxReconnectDelay=${MAX_RECONNECT_DELAY_MS ?? 'default'}\n`,
  )

  const transports: WebSocketTransport[] = []
  const config = {
    serverUrl: 'ws://stub',
    room: 'r',
    reconnectDelay: RECONNECT_DELAY_MS,
    maxReconnectDelay: MAX_RECONNECT_DELAY_MS,
  } as any
  const outageStart = Date.now()
  for (let i = 0; i < CLIENTS; i++) {
    const t = new WebSocketTransport()
    transports.push(t)
    // The first connect() rejects (server down); the transport's own
    // reconnect loop takes over from the close event.
    t.connect(config).catch(() => {})
  }
  await sleep(OUTAGE_MS)
  const outageAttempts = attemptTimes.length
  serverUp = true
  serverUpAt = Date.now()
  const cap = 2 * (MAX_RECONNECT_DELAY_MS ?? 10000) + 5000
  while (openTimes.length < CLIENTS && Date.now() - serverUpAt < cap) await sleep(50)

  const buckets: number[] = []
  for (const t of attemptTimes) {
    if (t >= serverUpAt) break
    const b = Math.floor((t - outageStart) / BUCKET_MS)
    buckets[b] = (buckets[b] ?? 0) + 1
  }
  console.log(
    `outage: ${outageAttempts} connection attempts in ${(OUTAGE_MS / 1000).toFixed(0)}s ` +
      `= ${((outageAttempts * 60000) / OUTAGE_MS).toFixed(0)}/min, ` +
      `${(outageAttempts / CLIENTS).toFixed(1)} per client`,
  )
  console.log(`   per ${BUCKET_MS / 1000}s bucket: ${buckets.map((b) => b ?? 0).join(' ')}`)
  const sorted = [...openTimes].sort((a, b) => a - b)
  console.log(
    `recovery: ${openTimes.length}/${CLIENTS} clients back, reconnect time after the server returned ` +
      `min=${sorted[0] ?? '-'}ms p50=${percentile(sorted, 0.5)}ms max=${sorted[sorted.length - 1] ?? '-'}ms`,
  )
  for (const t of transports) t.disconnect()
  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
