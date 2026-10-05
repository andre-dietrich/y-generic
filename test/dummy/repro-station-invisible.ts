/**
 * Repro: a long-running peer ("station") whose state a newcomer does not
 * receive for a long time.
 *
 * Reported from edrys-Lite: a station tab open for hours is missing for
 * "many minutes" in a freshly opened classroom, on both WebRTC and WebSocket,
 * while the pre-GenericProvider providers never showed this.
 *
 * Two suspects, both in GenericProvider (so transport-independent):
 *   A. SyncStep2 reply suppression: with >= 3 awareness states, a reply is
 *      delayed up to `syncReplySuppressionMs` and cancelled by ANY incoming
 *      SyncStep2, even one answering a different request.
 *   B. The shared sync budget (`_tryReserveSyncSlot`, 20 / 10s): replies,
 *      periodic SyncStep1s, resyncs and the peer-connect full-state push all
 *      draw from it; an exhausted budget drops them silently.
 *
 * Setup: the station holds content nobody else wrote (its own user entry).
 * B bystanders are already present and synced. A newcomer then joins; we
 * measure how long until the newcomer's doc contains the station's entry.
 * Each scenario runs with the stock provider and with suspect A disabled
 * (`_cancelPendingSyncReply` no-op'd) and suspect B disabled (huge budget).
 *
 * The mesh transport fires `onPeerConnect` on both ends when a newcomer joins,
 * like simple-peer does (GenericProvider then calls syncNow()).
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/repro-station-invisible.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'

const LATENCY = 20 // WebRTC steady-state profile
const JITTER = 0.1
const TIMEOUT_MS = 30000
const SAMPLES = 5
const BYSTANDER_COUNTS = [0, 1, 2, 4]
const SETTLE_MS = 20000 // > awareness renew (15s) so remote states are counted

type Variant = 'stock' | 'no-cancel' | 'no-budget'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Dummy transport that also reports peer connects, like simple-peer. */
class MeshTransport extends DummyTransport {
  private _peerCbs = new Set<(peerId: string) => void>()
  constructor(private mesh: Set<MeshTransport>, hub: DummyHub) {
    super({ hub, latency: LATENCY, jitter: JITTER })
  }
  onPeerConnect(cb: (peerId: string) => void): () => void {
    this._peerCbs.add(cb)
    return () => this._peerCbs.delete(cb)
  }
  async connect(config: any): Promise<void> {
    await super.connect(config)
    const others = [...this.mesh]
    this.mesh.add(this)
    // Data channel opens on both ends after a signaling round-trip.
    setTimeout(() => {
      for (const other of others) {
        other._firePeerConnect('x')
        this._firePeerConnect('x')
      }
    }, LATENCY * 3)
  }
  disconnect(): void {
    this.mesh.delete(this)
    super.disconnect()
  }
  private _firePeerConnect(id: string) {
    for (const cb of this._peerCbs) cb(id)
  }
}

function makePeer(hub: DummyHub, mesh: Set<MeshTransport>, variant: Variant) {
  const doc = new Y.Doc()
  const provider = new GenericProvider(doc, new MeshTransport(mesh, hub), {})
  const p = provider as any
  if (variant === 'no-cancel') p._cancelPendingSyncReply = () => {}
  if (variant === 'no-budget') p._maxSyncRequestsPerWindow = 1e9
  return { doc, provider }
}

async function runOnce(bystanders: number, variant: Variant): Promise<number | null> {
  const room = 'station-' + Math.random().toString(36).slice(2)
  const hub = new DummyHub()
  const mesh = new Set<MeshTransport>()
  const peers: ReturnType<typeof makePeer>[] = []

  const station = makePeer(hub, mesh, variant)
  station.doc.getMap('users').set('Station X', { role: 'station' })
  peers.push(station)
  await station.provider.connect({ room })

  for (let i = 0; i < bystanders; i++) {
    const b = makePeer(hub, mesh, variant)
    b.doc.getMap('users').set('student' + i, { role: 'student' })
    peers.push(b)
    await b.provider.connect({ room })
  }
  await sleep(SETTLE_MS)

  const newcomer = makePeer(hub, mesh, variant)
  newcomer.doc.getMap('users').set('owner', { role: 'teacher' })
  peers.push(newcomer)
  const t0 = Date.now()
  await newcomer.provider.connect({ room })

  let elapsed: number | null = null
  while (Date.now() - t0 < TIMEOUT_MS) {
    if (newcomer.doc.getMap('users').has('Station X')) {
      elapsed = Date.now() - t0
      break
    }
    await sleep(50)
  }
  for (const p of peers) p.provider.destroy()
  return elapsed
}

async function main() {
  // Keep library warnings out of the table, but count them.
  const warns = new Map<string, number>()
  console.warn = (...args: unknown[]) => {
    const key = String(args[0] ?? '').replace(/[-\d]+/g, '#').slice(0, 60)
    warns.set(key, (warns.get(key) ?? 0) + 1)
  }

  const variants: Variant[] = ['stock', 'no-cancel', 'no-budget']
  const runs: Promise<string>[] = []
  for (const b of BYSTANDER_COUNTS) {
    for (const v of variants) {
      runs.push(
        (async () => {
          const results: string[] = []
          for (let s = 0; s < SAMPLES; s++) {
            const ms = await runOnce(b, v)
            results.push(ms === null ? 'TIMEOUT' : ms + 'ms')
          }
          return `bystanders=${b}  ${v.padEnd(9)}  ${results.join('  ')}`
        })(),
      )
    }
  }
  for (const line of await Promise.all(runs)) process.stdout.write(line + '\n')
  process.stdout.write('\nwarnings:\n')
  for (const [k, n] of warns) process.stdout.write(`  ${n}x ${k}\n`)
  process.exit(0)
}

main()
