/**
 * Benchmark: one peer of a mesh room drops ALL its links at once and
 * re-opens them one by one (a phone resuming: the mesh transports rebuild
 * under a new peer id) - what happens to everybody else's roster?
 *
 * For the resuming peer every onPeerDisconnect looks like a departure:
 * GenericProvider removes those awareness states ('peer-left') and, after
 * the suppression delay, broadcasts the removal. By then some links are
 * back - the broadcast reaches the room and names every peer the resumer
 * has not re-learned yet. The receivers hold those peers at the very clock
 * the removal carries and drop them, although their own links to them
 * never went down. Found with 25 real browsers
 * (test/e2e/room-scenarios.mjs, simple-peer): bystanders that had nothing
 * to do with the five resuming peers were left in 8 of 25 rosters, for
 * good - since round 8 a peer bumps its clock for the presence it sends on
 * a new link, so the removal at the old clock no longer looks like its own
 * and it does not re-announce.
 *
 * N providers on a unicast DummyTransport with peer events. Each transport
 * is wrapped so single links can be cut and restored in both directions.
 * Peer 0 resumes: all its links are cut at once, then restored
 * RELINK_GAP_MS apart. Reported: roster entries bystanders lost that were
 * NOT peer 0, and whether every roster is complete WATCH_MS later.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-resume-roster.js
 *      N=10 RELINK_GAP_MS=400 WATCH_MS=6000 override.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyTransport, DummyHub } from '../../src/providers/dummy/index'
import type { Transport, ConnectionConfig } from '../../src/transport'
import { instrumentHub, sleep } from './bench-user-scaling'

const N = Number(process.env.N ?? 10)
const RELINK_GAP_MS = Number(process.env.RELINK_GAP_MS ?? 400)
const WATCH_MS = Number(process.env.WATCH_MS ?? 6000)

/** A DummyTransport whose links can be cut one by one: nothing in or out on a cut link, the peer reported gone, then back. */
class LinkTransport implements Transport {
  private cutLinks = new Set<string>()
  private onConnectCb?: (id: string) => void
  private onDisconnectCb?: (id: string) => void
  constructor(readonly inner: DummyTransport) {}
  get id(): string {
    return this.inner.id
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
  // A broadcast cannot skip a cut link on the way out - the receiving side drops it.
  send(data: Uint8Array): void {
    this.inner.send(data)
  }
  sendTo(peerId: string, data: Uint8Array): void {
    if (!this.cutLinks.has(peerId)) this.inner.sendTo!(peerId, data)
  }
  onMessage(cb: (data: Uint8Array, from?: string) => void): () => void {
    return this.inner.onMessage((data, from) => {
      if (from === undefined || !this.cutLinks.has(from)) cb(data, from)
    })
  }
  onPeerConnect(cb: (id: string) => void): () => void {
    this.onConnectCb = cb
    return this.inner.onPeerConnect!(cb)
  }
  onPeerDisconnect(cb: (id: string) => void): () => void {
    this.onDisconnectCb = cb
    return this.inner.onPeerDisconnect!(cb)
  }
  cut(peerId: string): void {
    this.cutLinks.add(peerId)
    this.onDisconnectCb?.(peerId)
  }
  restore(peerId: string): void {
    this.cutLinks.delete(peerId)
    this.onConnectCb?.(peerId)
  }
}

async function main() {
  const hub = new DummyHub()
  const counter = instrumentHub(hub)
  const peers = Array.from({ length: N }, (_, i) => {
    const doc = new Y.Doc()
    const transport = new LinkTransport(
      new DummyTransport({ hub, latency: 20, unicast: true, simulatePeerConnect: true }),
    )
    const provider = new GenericProvider(doc, transport)
    provider.awareness.setLocalState({ name: `peer-${i}` })
    return { doc, transport, provider }
  })
  for (const p of peers) await p.provider.connect({ room: 'r' })
  await sleep(2500)
  const roster = (p: (typeof peers)[number]) => p.provider.awareness.getStates().size
  if (!peers.every((p) => roster(p) === N)) throw new Error('setup: rosters incomplete')

  const resumer = peers[0]
  const bystanders = peers.slice(1)
  let lostOthers = 0
  for (const p of bystanders) {
    p.provider.awareness.on('change', ({ removed }: { removed: number[] }) => {
      lostOthers += removed.filter((id) => id !== resumer.doc.clientID).length
    })
  }

  const before = counter.messages
  // The removal broadcast waits a random part of >= 1 s; pin it to the middle
  // so it fires while some links are back and some are not - the case measured.
  const realRandom = Math.random
  Math.random = () => 0.5
  // Peer 0 resumes: every link goes at once ...
  for (const p of bystanders) {
    resumer.transport.cut(p.transport.id)
    p.transport.cut(resumer.transport.id)
  }
  // ... and comes back one by one.
  for (const p of bystanders) {
    await sleep(RELINK_GAP_MS)
    resumer.transport.restore(p.transport.id)
    p.transport.restore(resumer.transport.id)
  }
  Math.random = realRandom
  await sleep(WATCH_MS)

  const sizes = peers.map(roster)
  console.log(`N=${N}, links back ${RELINK_GAP_MS} ms apart, watched ${WATCH_MS} ms after the last one`)
  console.log(`  roster entries of OTHER peers lost by bystanders: ${lostOthers}`)
  console.log(`  rosters ${WATCH_MS} ms later: min ${Math.min(...sizes)}, max ${Math.max(...sizes)} of ${N} (complete: ${sizes.filter((s) => s === N).length} of ${N} peers)`)
  console.log(`  deliveries since the cut: ${counter.messages - before}`)

  for (const p of peers) p.provider.destroy()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
