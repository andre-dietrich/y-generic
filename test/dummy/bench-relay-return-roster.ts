/**
 * Benchmark: a peer of a RELAY room loses its link for longer than the
 * presence lease and gets it back - how long until its roster is whole again?
 *
 * Found with a real phone (test/e2e/phone-session.mjs nostr, 2026-09-20): back
 * from a display that had been off for longer than the 120 s lease, the phone
 * showed two of the nine users. Its page had kept running, heard no renewal
 * and expired everybody - rightly. When the transport reported the link back
 * (`onPeerConnect`: NostrTransport hears the room again), the provider
 * announced ITSELF and synced the document, with a beacon that does not ask
 * for presence: that is right on a mesh, where the peer at the other end of
 * a new link sends its own, and wrong on a relay, where nobody noticed that
 * we were away. The others came back one by one with their renewals, up to
 * half a lease later, or at once if their state happened to change (the
 * typist's cursor).
 *
 * N peers on a relay hub (no unicast, no peer events), one of them changes
 * its presence once a second. The phone's link is cut in both directions for
 * 1.5 leases while its timers run on, then restored with one `onPeerConnect`,
 * as a relay transport reports a link that came back by itself.
 * Reported: the phone's roster when the link is back, 1 s later, and the ms
 * until it is whole. Exit code 1 if that takes longer than 1.5 s.
 *
 * Part 2, what asking costs when nobody needed to: a relay restart - EVERY
 * link away for 1 s, all back in the same moment, nobody's roster lost
 * anything. Reported: deliveries and bytes in the 3 s after the return.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-relay-return-roster.js
 *      N=9 LEASE_MS=10000 override; RTT_HINT_MS=600 gives every transport Nostr's `expectedRttMs`
 *      (longer answer windows) - the real phone got 8 of 9 at once and the ninth 55 s later.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import type { Transport, ConnectionConfig } from '../../src/transport'
import { sleep, silenced, instrumentHub } from './bench-user-scaling'

const N = Number(process.env.N ?? 9)
const LEASE_MS = Number(process.env.LEASE_MS ?? 10000)
const RTT_HINT_MS = Number(process.env.RTT_HINT_MS ?? 0)

/** A relay link the bench can cut: nothing in or out, and one `onPeerConnect` when it is back. */
class CuttableRelay implements Transport {
  private down = false
  private onBack?: (id: string) => void
  constructor(private inner: DummyTransport) {
    if (RTT_HINT_MS > 0) Object.defineProperty(this, 'expectedRttMs', { get: () => RTT_HINT_MS })
  }
  connect(config: ConnectionConfig): Promise<void> {
    return this.inner.connect(config)
  }
  disconnect(): void {
    this.inner.disconnect()
  }
  get isConnected(): boolean {
    return this.inner.isConnected
  }
  send(data: Uint8Array): void {
    if (!this.down) this.inner.send(data)
  }
  onMessage(cb: (data: Uint8Array, from?: string) => void): () => void {
    return this.inner.onMessage((data, from) => {
      if (!this.down) cb(data, from)
    })
  }
  onPeerConnect(cb: (id: string) => void): () => void {
    this.onBack = cb
    return () => (this.onBack = undefined)
  }
  cut(): void {
    this.down = true
  }
  restore(): void {
    this.down = false
    this.onBack?.('relay')
  }
}

async function main() {
  let atReturn = 0
  let after1s = 0
  let wholeMs = -1
  let restart = { messages: 0, bytes: 0, rosters: '' }
  await silenced(async () => {
    const hub = new DummyHub()
    const counter = instrumentHub(hub)
    const room = `bench-relay-return-${Math.random().toString(36).slice(2)}`
    const make = async (name: string, transport: Transport) => {
      const provider = new GenericProvider(new Y.Doc(), transport, { disableBc: true, awarenessTimeoutMs: LEASE_MS })
      await provider.connect({ room })
      provider.awareness.setLocalStateField('user', { name })
      return provider
    }
    const others: GenericProvider[] = []
    const links: CuttableRelay[] = []
    for (let i = 0; i < N; i++) {
      links.push(new CuttableRelay(new DummyTransport({ hub, latency: 5, jitter: 0.25 })))
      if (i < N - 1) others.push(await make('d' + i, links[i]))
      await sleep(200)
    }
    const link = links[N - 1]
    const phone = await make('phone', link)
    const typing = setInterval(() => {
      others[1].awareness.setLocalStateField('cursor', Date.now())
      // A peer that writes keeps its lease alive with its updates and never renews its
      // presence: its awareness clock stands still while the phone is away.
      if (process.env.WRITER !== '0') others[2].doc.getText('t').insert(0, '.')
    }, 1000)
    const roster = () => phone.awareness.getStates().size
    await sleep(2000)
    if (roster() !== N) throw new Error(`setup: the phone sees ${roster()} of ${N}`)

    link.cut()
    await sleep(LEASE_MS * 1.5)
    link.restore()
    const t0 = Date.now()
    atReturn = roster()
    while (Date.now() - t0 < LEASE_MS) {
      await sleep(50)
      if (after1s === 0 && Date.now() - t0 >= 1000) after1s = roster()
      if (roster() === N) {
        wholeMs = Date.now() - t0
        break
      }
    }
    if (after1s === 0) after1s = roster()

    // Part 2: the relay restarts.
    await sleep(LEASE_MS) // everybody settled and whole again, either way
    for (const l of links) l.cut()
    await sleep(1000)
    const before = { messages: counter.messages, bytes: counter.bytes }
    for (const l of links) l.restore()
    await sleep(3000)
    const sizes = [...others, phone].map((p) => p.awareness.getStates().size)
    restart = { messages: counter.messages - before.messages, bytes: counter.bytes - before.bytes, rosters: `${Math.min(...sizes)}-${Math.max(...sizes)} of ${N}` }

    clearInterval(typing)
    for (const p of [...others, phone]) p.destroy()
    hub.clear()
  })
  console.log(`relay room of ${N}, lease ${LEASE_MS} ms, the phone's link away for ${LEASE_MS * 1.5} ms (its timers ran on):`)
  console.log(`  the phone's roster when the link is back: ${atReturn} of ${N}, 1 s later: ${after1s} of ${N}`)
  console.log(`  whole again after: ${wholeMs < 0 ? `NEVER (${LEASE_MS} ms watched)` : `${wholeMs} ms`}   (want < 1500 ms)`)
  console.log(`a relay restart, every link away for 1 s and back at once: ${restart.messages} deliveries, ${restart.bytes} bytes in the 3 s after, rosters ${restart.rosters}`)
  process.exit(wholeMs < 0 || wholeMs >= 1500 ? 1 : 0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
