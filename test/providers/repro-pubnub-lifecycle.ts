/**
 * Repro: PubNubTransport through what a connection's life brings - the
 * browser saying the network went and came back, and a subscribe loop that
 * failed and found the network again by itself.
 *
 * The PubNub SDK (10.2.7, the playground's and the README's; legacy
 * subscription loop - `enableEventEngine` defaults to false) has two paths,
 * scripted here as they are in pubnub.10.2.7.js:
 *
 *  - the browser's `offline` / `online` (listenToBrowserNetworkEvents,
 *    default true; l. 18399-18421): `offline` emits PNNetworkDownCategory and
 *    then, unless the client was made with `restore: true` (default false,
 *    l. 4071), calls destroy(true) - which UNSUBSCRIBES FROM EVERY CHANNEL
 *    (l. 15986). `online` emits PNNetworkUpCategory and calls reconnect(),
 *    whose subscribe loop returns at once for an empty channel list
 *    (l. 7333). With `restore: true` `offline` only disconnects: the
 *    channels stay, `online` resumes the loop at the last timetoken.
 *  - a subscribe request that failed (a server or a proxy that went away,
 *    a dead WiFi the browser did not report; l. 7358-7386): the loop stops,
 *    PNNetworkIssuesCategory, a `time` call every 3 s, and when one answers
 *    PNReconnectedCategory and the loop resumes. (PNNetworkDown/Up come on
 *    this path only with `autoNetworkDetection`, default false.)
 *
 *  Part 1 - first connect: onPeerConnect must NOT fire (the provider's own
 *           connect() handles that).
 *  Part 2 - offline, online: does a message the room publishes afterwards
 *           arrive? Found in a real Chrome (room-scenarios.mjs pubnub,
 *           SCENARIOS=join,offline, 20 s without network): the returner
 *           never heard the room again - roster 1 of 8, its document apart
 *           for good - and went on sending.
 *  Part 3 - is the provider told that the link came back (onPeerConnect),
 *           after the `online` path? Nobody in the room noticed that we
 *           were away: what we typed meanwhile is unsent, and past the 30 s
 *           lease we expired the whole room.
 *  Part 4 - the same after the failed-subscribe path. Measured before the
 *           fix: 25 Chrome peers, a network outage of 45 s (room-scenarios
 *           pubnub, OUTAGE_MS=45000) - rosters complete 14.5 s after it, the
 *           text typed during it everywhere after 9.3 s (renewals and
 *           beacons of whoever came first).
 *  Part 5 - isConnected while the network is down on either path (a send
 *           then is a publish that fails, logged as an error).
 *  Part 6 - the page unloads: the provider sends our presence removal and
 *           calls Transport.flush() in the same task. A publish is a fetch of
 *           the SDK's without `keepalive`, and the page may take it along
 *           before it left: a reloaded page stayed a ghost in every roster
 *           for the 30 s lease, 2 of 35 reloads (room-scenarios.mjs pubnub,
 *           SCENARIOS=join,linger LINGER_GAP_MS=5000). flush() must send what
 *           went out in this task once more as a keepalive request to the
 *           publish endpoint - and nothing that went out in an earlier task.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-pubnub-lifecycle.js
 * Exit code 1 if a part fails.
 */
import { PubNubTransport } from '../../src/providers/pubnub/index'

type Listener = { status?: (e: any) => void; message?: (e: any) => void; presence?: (e: any) => void }

class ScriptedPubNub {
  static last: ScriptedPubNub
  private listeners: Listener[] = []
  channels = new Set<string>()
  looping = false // the subscribe loop runs: messages are delivered
  constructor(public config: any) {
    ScriptedPubNub.last = this
  }
  addListener(l: Listener): void {
    this.listeners.push(l)
  }
  status(category: string): void {
    for (const l of this.listeners) l.status?.({ category })
  }
  subscribe({ channels }: { channels: string[] }): void {
    for (const c of channels) this.channels.add(c)
    this.looping = true
    setTimeout(() => this.status('PNConnectedCategory'), 5)
  }
  unsubscribeAll(): void {
    this.channels.clear()
    this.looping = false
  }
  publish(): Promise<any> {
    return Promise.resolve({ timetoken: '1' })
  }
  hereNow(): Promise<any> {
    return Promise.resolve({ channels: {} })
  }
  /** pubnub.10.2.7.js networkDownDetected(), l. 18409 */
  offline(): void {
    this.status('PNNetworkDownCategory')
    this.looping = false // restore: disconnect(true) - the channels stay
    if (!this.config.restore) this.channels.clear() // destroy(true): unsubscribeAll
  }
  /** networkUpDetected(), l. 18417: reconnect() - startSubscribeLoop returns for no channels */
  online(): void {
    this.status('PNNetworkUpCategory')
    this.looping = this.channels.size > 0
  }
  /** processSubscribeResponse(), l. 7358-7384: PNNetworkIssuesCategory, then polling */
  subscribeFailed(): void {
    this.looping = false
    this.status('PNNetworkIssuesCategory')
  }
  /** the reconnection manager's time call answered, l. 7369-7377 */
  pollAnswered(): void {
    this.looping = this.channels.size > 0
    this.status('PNReconnectedCategory')
  }
  /** a message another peer published to the room */
  deliver(message: string, publisher: string): boolean {
    if (!this.looping || this.channels.size === 0) return false
    for (const l of this.listeners) l.message?.({ message, publisher, channel: [...this.channels][0] })
    return true
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  ;(globalThis as any).PubNub = ScriptedPubNub
  const transport = new PubNubTransport()
  let peerConnects = 0
  ;(transport as any).onPeerConnect?.(() => peerConnects++)
  const received: string[] = []
  transport.onMessage((_data, from) => received.push(from ?? '?'))
  await transport.connect({ publishKey: 'pub', subscribeKey: 'sub', room: 'repro' } as any)
  const pn = ScriptedPubNub.last
  const results: Array<[string, boolean]> = []
  const room = btoa('\x00\x00\x00\x00\x01') // a frame in the transport's base64 wire form

  await sleep(20)
  results.push([`1 first connect: onPeerConnect fired ${peerConnects} times (want 0)`, peerConnects === 0])

  pn.offline()
  const downOffline = transport.isConnected
  await sleep(20)
  pn.online()
  await sleep(20)
  const heard = pn.deliver(room, 'other-peer') && received.includes('other-peer')
  results.push([`2 offline -> online: a message of the room arrives ${heard} (want true); client made with restore: ${pn.config.restore}`, heard])
  results.push([`3 provider told the link is back after online: onPeerConnect fired ${peerConnects} times (want 1)`, peerConnects === 1])

  pn.subscribeFailed()
  const downIssues = transport.isConnected
  await sleep(20)
  pn.pollAnswered()
  await sleep(20)
  const heardAgain = pn.deliver(room, 'third-peer') && received.includes('third-peer')
  results.push([`4 failed subscribe -> reconnected: a message arrives ${heardAgain}, onPeerConnect fired ${peerConnects} times (want true, 2)`, heardAgain && peerConnects === 2])
  results.push([`5 isConnected while down: after offline ${downOffline}, after the failed subscribe ${downIssues} (want false, false); now ${transport.isConnected} (want true)`, !downOffline && !downIssues && transport.isConnected])

  const fetched: Array<{ url: string; init: any }> = []
  ;(globalThis as any).fetch = (url: string, init: any) => (fetched.push({ url, init }), Promise.resolve({ ok: true }))
  transport.send(new Uint8Array([9, 9, 9])) // an earlier task
  await sleep(10)
  transport.send(new Uint8Array([0, 0, 0, 0, 7])) // the removal, in the unloading task ...
  ;(transport as any).flush?.() // ... and flush() right after it
  const kept = fetched.filter((f) => f.init?.keepalive)
  const want = JSON.stringify(btoa('\x00\x00\x00\x00\x07'))
  results.push([
    `6 unload: keepalive requests ${kept.length} (want 1), to the publish endpoint ${kept[0]?.url.includes('/publish/pub/sub/0/') ?? false}, body the removal ${kept[0]?.init.body === want}`,
    kept.length === 1 && kept[0].url.includes('/publish/pub/sub/0/') && kept[0].init.body === want,
  ])

  for (const [line, ok] of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`)
  transport.disconnect()
  process.exit(results.every(([, ok]) => ok) ? 0 : 1)
}

main()
