/**
 * Repro: the network is back under a page that is looking at a dead WebSocket -
 * how long until the transport has its socket again?
 *
 * Found with a real phone (test/e2e/phone-session.mjs websocket, 2026-09-21),
 * display on, WiFi off for a minute and on again: `navigator.connection` said
 * "wifi" at 68.3 s of the page, the socket was connected at 81.2 s - 12.9 s, of
 * which 4.3 s an attempt that had started over mobile data and could only time
 * out, and 8.6 s the backoff after it (2 s doubling to 10 s, x0.5-1.5). The
 * other transports' "do it now" would not have helped either: with the display
 * on there is no `visibilitychange`, and a phone that falls back to mobile data
 * says `online` when the WiFi GOES, never when it comes back.
 *
 * The real WebSocketTransport on a stub WebSocket (opens after 5 ms, refuses
 * after 5 ms, or hangs) and a stub page (document / window /
 * navigator.connection that only collect their listeners).
 *  1 backoff   the server refuses until the wait is at its cap, then accepts,
 *              and the page hears `change` from navigator.connection: ms until
 *              the socket is open.
 *  2 in the air the server hangs, an attempt is on its way (it would time out
 *              after 10 s); the server accepts again and the page becomes
 *              visible: ms until open - the attempt must be given up, not
 *              waited for.
 *  3 quiet     while connected, and after disconnect(), the same events dial
 *              nothing.
 * 1 and 2 want less than 500 ms, 3 no new socket. Exit code 1 otherwise.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-websocket-wake.js
 */

import { WebSocketTransport } from '../../src/providers/websocket/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- the page: whoever listens is collected, the repro fires the events
const listeners: Record<string, Set<() => void>> = { visibilitychange: new Set(), online: new Set(), change: new Set() }
const listenable = {
  addEventListener: (type: string, fn: () => void) => listeners[type]?.add(fn),
  removeEventListener: (type: string, fn: () => void) => listeners[type]?.delete(fn),
}
const fire = (type: string) => [...listeners[type]].forEach((fn) => fn())
;(globalThis as any).document = { visibilityState: 'visible', ...listenable }
;(globalThis as any).window = listenable
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, connection: { type: 'wifi', ...listenable } }, configurable: true })

// ---- the network
let network: 'up' | 'refuse' | 'hang' = 'up'
let sockets = 0
let live: FakeWebSocket | null = null
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
    sockets++
    const mode = network
    setTimeout(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING || mode === 'hang') return
      if (mode === 'up') {
        this.readyState = FakeWebSocket.OPEN
        live = this
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
  /** what a server that went away does to an open socket */
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1006, reason: '' })
  }
}
;(globalThis as any).WebSocket = FakeWebSocket

async function untilOpen(transport: WebSocketTransport, timeoutMs: number): Promise<number> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (transport.isConnected) return Date.now() - t0
    await sleep(5)
  }
  return -1
}
const fmt = (ms: number) => (ms < 0 ? 'NEVER (20 s watched)' : `${ms} ms`)

async function main() {
  const transport = new WebSocketTransport()
  await transport.connect({ serverUrl: 'ws://stub', room: 'r', reconnectDelay: 500, maxReconnectDelay: 4000 } as any)

  // 1: the wait is at its cap (attempts after ~0.5, 1, 2, 4 s, then every 2-6 s)
  network = 'refuse'
  live!.drop()
  const before = sockets
  while (sockets - before < 5) await sleep(20) // the fifth attempt has just been made ...
  await sleep(20) // ... and refused: the next one is 2-6 s away
  network = 'up'
  fire('change')
  const backoff = await untilOpen(transport, 20000)
  console.log(`1 backoff: the server accepts again and navigator.connection says 'change' - socket open after ${fmt(backoff)}`)

  // 2: an attempt in the air
  await sleep(200)
  network = 'hang'
  live!.drop()
  await sleep(1200) // the first retry (0.25-0.75 s) is on its way and will not be answered
  network = 'up'
  fire('visibilitychange')
  const inTheAir = await untilOpen(transport, 20000)
  console.log(`2 in the air: an attempt hangs, the server accepts again and the page becomes visible - socket open after ${fmt(inTheAir)}`)

  // 3: nothing to do
  await sleep(200)
  let quiet = sockets
  for (const type of ['change', 'online', 'visibilitychange']) fire(type)
  await sleep(100)
  const whileConnected = sockets - quiet
  transport.disconnect()
  quiet = sockets
  for (const type of ['change', 'online', 'visibilitychange']) fire(type)
  await sleep(100)
  const afterDisconnect = sockets - quiet
  console.log(`3 quiet: new sockets while connected ${whileConnected} (want 0), after disconnect() ${afterDisconnect} (want 0)`)

  const ok = backoff >= 0 && backoff < 500 && inTheAir >= 0 && inTheAir < 500 && whileConnected === 0 && afterDisconnect === 0
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
