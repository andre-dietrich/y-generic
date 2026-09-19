/**
 * Benchmark: a mesh link dies and re-opens while both pages keep running
 * (a phone suspended for a minute, a WiFi -> LTE switch) - how long until
 * each side sees the other's presence again?
 *
 * On the drop the transport reports onPeerDisconnect and GenericProvider
 * removes the peer's awareness state ('peer-left'); y-protocols keeps the
 * peer's clock in awareness.meta. On the re-open both sides exchange a
 * plain digest beacon (_schedulePeerConnectSync). The peer's state has not
 * changed meanwhile, so whatever presence arrives carries the clock the
 * receiver still holds - and applyAwarenessUpdate ignores an equal clock
 * unless it is a removal. Presence then waits for the peer's next clock
 * bump: a state change, or the renewal at lease/2 (150 s with the mesh
 * default lease of 300 s).
 *
 * Two providers on a unicast DummyTransport with peer events; each
 * transport is wrapped so the bench can cut and restore the link in both
 * directions without either provider disconnecting. LEASE_MS shortens the
 * lease so the renewal is observable; the doc side is measured too (an
 * edit made while the link was down).
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-presence-after-relink.js
 *      LEASE_MS=20000 DOWN_MS=2000 override; EDIT=0 leaves the phone idle while the link is down;
 *      WATCH_MS is the observation window after the re-open (default 3 leases).
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyTransport, DummyHub } from '../../src/providers/dummy/index'
import type { Transport, ConnectionConfig } from '../../src/transport'
import { sleep } from './bench-user-scaling'

const LEASE_MS = Number(process.env.LEASE_MS ?? 20000)
const DOWN_MS = Number(process.env.DOWN_MS ?? 2000)
const EDIT = process.env.EDIT !== '0'
const WATCH_MS = Number(process.env.WATCH_MS ?? 3 * LEASE_MS)

/** A DummyTransport whose link the bench can cut: nothing in or out, peers reported gone, then back. */
class CuttableTransport implements Transport {
  private down = false
  private peers = new Set<string>()
  private onConnectCb?: (id: string) => void
  private onDisconnectCb?: (id: string) => void
  constructor(private inner: DummyTransport) {}
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
  sendTo(peerId: string, data: Uint8Array): void {
    if (!this.down) this.inner.sendTo!(peerId, data)
  }
  onMessage(cb: (data: Uint8Array, from?: string) => void): () => void {
    return this.inner.onMessage((data, from) => {
      if (!this.down) cb(data, from)
    })
  }
  onPeerConnect(cb: (id: string) => void): () => void {
    this.onConnectCb = cb
    return this.inner.onPeerConnect!((id) => {
      this.peers.add(id)
      cb(id)
    })
  }
  onPeerDisconnect(cb: (id: string) => void): () => void {
    this.onDisconnectCb = cb
    return this.inner.onPeerDisconnect!(cb)
  }
  cut(): void {
    this.down = true
    for (const id of this.peers) this.onDisconnectCb?.(id)
  }
  restore(): void {
    this.down = false
    for (const id of this.peers) this.onConnectCb?.(id)
  }
}

function makePeer(hub: DummyHub, name: string) {
  const doc = new Y.Doc()
  const transport = new CuttableTransport(
    new DummyTransport({ hub, latency: 20, unicast: true, simulatePeerConnect: true }),
  )
  const provider = new GenericProvider(doc, transport, { awarenessTimeoutMs: LEASE_MS })
  provider.awareness.setLocalState({ name })
  return { doc, transport, provider }
}

async function main() {
  const hub = new DummyHub()
  const a = makePeer(hub, 'desktop')
  const b = makePeer(hub, 'phone')
  await a.provider.connect({ room: 'r' })
  await b.provider.connect({ room: 'r' })
  await sleep(1000)
  const sees = (p: typeof a, q: typeof a) => p.provider.awareness.getStates().has(q.doc.clientID)
  console.log(`lease ${LEASE_MS} ms (renewal at ${LEASE_MS / 2} ms), link down for ${DOWN_MS} ms`)
  console.log(`before the cut:    desktop sees phone=${sees(a, b)}  phone sees desktop=${sees(b, a)}`)

  a.transport.cut()
  b.transport.cut()
  if (EDIT) b.doc.getText('t').insert(0, 'typed while the link was down')
  await sleep(DOWN_MS)
  console.log(`while cut:         desktop sees phone=${sees(a, b)}  phone sees desktop=${sees(b, a)}`)

  const restoredAt = Date.now()
  a.transport.restore()
  b.transport.restore()

  let docAt = -1
  let aSeesAt = -1
  let bSeesAt = -1
  while (Date.now() - restoredAt < WATCH_MS && ((EDIT && docAt < 0) || aSeesAt < 0 || bSeesAt < 0)) {
    const t = Date.now() - restoredAt
    if (docAt < 0 && a.doc.getText('t').toString().length > 0) docAt = t
    if (aSeesAt < 0 && sees(a, b)) aSeesAt = t
    if (bSeesAt < 0 && sees(b, a)) bSeesAt = t
    await sleep(25)
  }
  const fmt = (t: number) => (t < 0 ? `never (within ${WATCH_MS} ms)` : `${t} ms`)
  console.log(`after the re-open: document edit arrives at the desktop after ${EDIT ? fmt(docAt) : 'n/a (EDIT=0)'}`)
  console.log(`                   desktop sees the phone again after      ${fmt(aSeesAt)}`)
  console.log(`                   phone sees the desktop again after      ${fmt(bSeesAt)}`)

  a.provider.destroy()
  b.provider.destroy()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
