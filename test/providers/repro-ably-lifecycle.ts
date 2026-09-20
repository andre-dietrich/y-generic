/**
 * Repro: AblyTransport through what a connection's life brings - Ably's own
 * reconnect, and a channel over its message rate.
 *
 * ably-js reconnects by itself: a network blip, a frozen page, a phone out
 * of the background take the connection connected -> disconnected ->
 * connected (or through `suspended` after 2 min), the channel stays
 * attached or re-attaches, messages keep arriving. AblyTransport takes the
 * Realtime class as an option; here it gets a scripted one whose connection
 * states the test emits.
 *
 *  Part 1 - connected: send() once. Publishes: 1.
 *  Part 2 - 'disconnected', then 'connected' again: send() once. Publishes
 *           must be 2 - found by reading before test/e2e/room-scenarios.mjs
 *           ably measured it: `once('connected')` set the flag that
 *           'disconnected' clears, so the transport received for ever and
 *           never sent again.
 *  Part 3 - the same through 'suspended'.
 *  Part 4 - is the provider told that the link came back (onPeerConnect)?
 *           What was typed during the outage is unsent, and Ably dropped
 *           our presence if the outage outlived its 15 s.
 *  Part 5 - presence.enter() is refused once with Ably's 42913 "Rate limit
 *           exceeded; request rejected (nonfatal); metric = channel.maxRate;
 *           permitted rate = 50" - what test/e2e/room-scenarios.mjs ably got
 *           with 25 peers joining a free-tier channel within 5 s (peak 68
 *           frames/s): 1 of 25 failed to connect, in both runs. connect()
 *           must resolve, and the enter must be tried again.
 *  Part 6 - a publish is refused the same way. The transport is TOLD (the
 *           promise rejects) and used to log it: the message was lost for
 *           every receiver at once. A keystroke lost that way took the room
 *           2.5 s, 10.6 s or (before the core answered from incomplete
 *           peers) for ever to repair, a presence up to half a lease - 172 s
 *           until every roster of a 25-peer join was complete. Refused is not
 *           failed: it must be published again (within ~2 s, the rate is per
 *           second).
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-ably-lifecycle.js
 * Exit code 1 if a part fails.
 */
import { AblyTransport } from '../../src/providers/ably/index'

type Cb = (arg?: any) => void

class ScriptedRealtime {
  static last: ScriptedRealtime
  static refuseEnters = 0 // the next n presence.enter() calls are refused
  refusePublishes = 0 // the next n publish() calls are refused
  refused = 0
  published = 0
  enters = 0
  entered = false
  private handlers = new Map<string, Cb[]>()
  connection = {
    state: 'connecting',
    on: (event: string, cb: Cb) => void this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]),
    once: (event: string, cb: Cb) => {
      const wrapped: Cb = (arg) => {
        this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== wrapped))
        cb(arg)
      }
      this.connection.on(event, wrapped)
    },
    off: () => {},
  }
  channels = {
    get: () => ({
      subscribe: () => {},
      unsubscribe: () => {},
      publish: async () => {
        if (this.refusePublishes-- > 0) {
          this.refused++
          throw Object.assign(new Error('Rate limit exceeded; request rejected (nonfatal); metric = channel.maxRate'), { code: 42913, statusCode: 429 })
        }
        this.published++
      },
      detach: async () => {},
      presence: {
        enter: async () => {
          this.enters++
          if (ScriptedRealtime.refuseEnters-- > 0) {
            throw Object.assign(new Error('Rate limit exceeded; request rejected (nonfatal); metric = channel.maxRate'), { code: 42913, statusCode: 429 })
          }
          this.entered = true
        },
        leave: async () => {},
        get: async () => [],
        subscribe: () => {},
      },
    }),
  }
  constructor() {
    ScriptedRealtime.last = this
    setTimeout(() => this.emit('connected'), 5)
  }
  emit(state: string): void {
    this.connection.state = state
    for (const h of [...(this.handlers.get(state) ?? [])]) h({ current: state })
  }
  close(): void {}
}

const frame = new Uint8Array([0, 0, 0, 0, 1, 2, 3]) // 4 bytes CRC header + payload

async function main(): Promise<void> {
  const transport = new AblyTransport({ Realtime: ScriptedRealtime as any })
  let peerConnects = 0
  ;(transport as any).onPeerConnect?.(() => peerConnects++)
  await transport.connect({ room: 'repro', apiKey: 'x.y:z' } as any)
  const ably = ScriptedRealtime.last
  const results: Array<[string, boolean]> = []

  transport.send(frame)
  results.push([`1 connected: publishes ${ably.published} (want 1)`, ably.published === 1])

  ably.emit('disconnected')
  ably.emit('connected')
  transport.send(frame)
  results.push([`2 disconnected -> connected: publishes ${ably.published} (want 2), isConnected ${transport.isConnected}`, ably.published === 2])

  ably.emit('disconnected')
  ably.emit('suspended')
  ably.emit('connected')
  transport.send(frame)
  results.push([`3 suspended -> connected: publishes ${ably.published} (want 3), isConnected ${transport.isConnected}`, ably.published === 3])

  results.push([`4 provider told of the two reconnects: onPeerConnect fired ${peerConnects} times (want 2)`, peerConnects === 2])

  ably.refusePublishes = 1
  transport.send(frame)
  await new Promise((r) => setTimeout(r, 2500))
  results.push([`6 publish refused once (42913): refused ${ably.refused}, publishes ${ably.published} (want 4: the refused one went out again)`, ably.refused === 1 && ably.published === 4])

  ScriptedRealtime.refuseEnters = 1
  const late = new AblyTransport({ Realtime: ScriptedRealtime as any })
  const connected = await late.connect({ room: 'repro', apiKey: 'x.y:z' } as any).then(
    () => true,
    () => false,
  )
  await new Promise((r) => setTimeout(r, 3000))
  const l = ScriptedRealtime.last
  results.push([`5 enter refused once (42913): connect() resolved ${connected} (want true), enter() calls ${l.enters} (want 2), present ${l.entered} (want true)`, connected && l.enters === 2 && l.entered])
  await late.disconnect()

  for (const [line, ok] of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`)
  await transport.disconnect()
  process.exit(results.every(([, ok]) => ok) ? 0 : 1)
}

main()
