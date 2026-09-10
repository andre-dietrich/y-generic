/**
 * Benchmark: what does a Gun room replay to a joiner from the presence of
 * peers that left long ago?
 *
 * GunTransport writes each client's awareness into its own slot
 * (`aware-<time>-<random>`, one per connection) under the room's
 * `awareness` node, and subscribes with `.map().on()` so that every
 * existing slot is replayed to a joiner. Before round 7 a slot was never
 * removed or aged out: the relay keeps every slot ever written, and a
 * joiner received all of them - each one a presence entry for a peer that
 * is gone, a phantom in `_knownPeers`, and a lease-timeout removal 30 s
 * later. Round 7 skips slots older than AWARENESS_MAX_AGE_MS on receipt
 * and nulls the own slot on disconnect().
 *
 * Runs the REAL GunTransport against the in-memory fake Gun graph from
 * repro-gun-batch-corruption.ts (copied: that file runs its repro on
 * import), extended so `.map().on()` replays existing children on
 * subscribe, as Gun does. STALE peers set their presence and crash (the
 * transport stops delivering, nothing is nulled), their slots are aged
 * STALE_AGE_MS; RECENT peers the same, aged RECENT_AGE_MS (inside the
 * bound: still replayed); LIVE peers stay. Then a joiner connects and we
 * count the awareness frames its transport delivers, the presence entries
 * and `_knownPeers` it ends up with, and finally the slots left in the
 * graph after one live peer leaves gracefully.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-gun-awareness-replay.js
 *      STALE=50 RECENT=5 LIVE=5 STALE_AGE_MS=3600000 RECENT_AGE_MS=120000 override.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { GunTransport } from '../../src/providers/gun/index'
import { sleep, silenced } from './bench-user-scaling'

const STALE = Number(process.env.STALE ?? 50)
const RECENT = Number(process.env.RECENT ?? 5)
const LIVE = Number(process.env.LIVE ?? 5)
const STALE_AGE_MS = Number(process.env.STALE_AGE_MS ?? 3600_000)
const RECENT_AGE_MS = Number(process.env.RECENT_AGE_MS ?? 120_000)

// ---------------------------------------------------------------------------
// Minimal fake Gun graph (see repro-gun-batch-corruption.ts), plus replay of
// existing children to a new `.map().on()` subscriber.
// ---------------------------------------------------------------------------
class FakeGunNode {
  key: string
  parent: FakeGunNode | null
  value: any = undefined
  children: Map<string, FakeGunNode> = new Map()
  private onListeners: Array<(value: any, key: string) => void> = []
  private mapListeners: Array<(value: any, key: string) => void> = []

  constructor(parent: FakeGunNode | null, key: string) {
    this.parent = parent
    this.key = key
  }

  get(subkey: string): FakeGunNode {
    if (!this.children.has(subkey)) {
      this.children.set(subkey, new FakeGunNode(this, subkey))
    }
    return this.children.get(subkey)!
  }

  put(value: any): void {
    this.value = value
    for (const fn of this.onListeners) queueMicrotask(() => fn(value, this.key))
    if (this.parent) {
      for (const fn of this.parent.mapListeners) {
        queueMicrotask(() => fn(value, this.key))
      }
    }
  }

  on(cb: (value: any, key: string) => void): void {
    this.onListeners.push(cb)
    if (this.value !== undefined) queueMicrotask(() => cb(this.value, this.key))
  }

  once(cb: (value: any, key: string) => void): void {
    queueMicrotask(() => cb(this.value, this.key))
  }

  map(): { on(cb: (value: any, key: string) => void): void } {
    const self = this
    return {
      on(cb: (value: any, key: string) => void) {
        self.mapListeners.push(cb)
        // Gun replays every existing property of the node to a new map
        // subscriber - this is what hands a joiner the whole history.
        for (const [key, child] of self.children) {
          if (child.value !== undefined) queueMicrotask(() => cb(child.value, key))
        }
      },
    }
  }
}

const sharedRoot = new FakeGunNode(null, 'root')

class FakeGun {
  constructor(_config?: any) {
    return sharedRoot as any
  }
}

interface Peer {
  doc: Y.Doc
  transport: GunTransport
  provider: GenericProvider
}

async function join(room: string, name: string): Promise<Peer> {
  const doc = new Y.Doc()
  const transport = new GunTransport({ gun: FakeGun as any, batchInterval: 50 })
  const provider = new GenericProvider(doc, transport, { syncInterval: 0, disableBc: true })
  await provider.connect({ room })
  provider.awareness.setLocalState({ user: { name } })
  await sleep(120) // the presence write lands (awareness is written immediately)
  return { doc, transport, provider }
}

/** The tab dies: the transport stops, nothing is said or nulled. */
function crash(peer: Peer): void {
  ;(peer.transport as any)._connected = false
  peer.provider.destroy()
}

function slotsOf(room: string): FakeGunNode {
  return sharedRoot.get(`yjs-room-${room}`).get('awareness')
}

function ageSlot(room: string, peer: Peer, ageMs: number): void {
  const id = (peer.transport as any).ownAwarenessId as string
  const slot = slotsOf(room).get(id)
  if (slot.value && typeof slot.value === 'object') slot.value.timestamp = Date.now() - ageMs
}

function liveSlots(room: string): number {
  let n = 0
  for (const child of slotsOf(room).children.values()) {
    if (child.value !== undefined && child.value !== null) n++
  }
  return n
}

async function main() {
  console.log(
    `gun awareness replay: stale=${STALE} (aged ${STALE_AGE_MS / 60000} min) recent=${RECENT} ` +
      `(aged ${RECENT_AGE_MS / 60000} min) live=${LIVE}\n`,
  )
  await silenced(async () => {
    const room = `bench-gun-replay-${Math.random().toString(36).slice(2)}`

    for (let i = 0; i < STALE; i++) {
      const p = await join(room, 'stale' + i)
      crash(p)
      ageSlot(room, p, STALE_AGE_MS)
    }
    for (let i = 0; i < RECENT; i++) {
      const p = await join(room, 'recent' + i)
      crash(p)
      ageSlot(room, p, RECENT_AGE_MS)
    }
    const live: Peer[] = []
    for (let i = 0; i < LIVE; i++) live.push(await join(room, 'live' + i))
    console.log(`slots in the graph before the join: ${liveSlots(room)}`)

    // The joiner: count the awareness frames its transport hands up.
    const doc = new Y.Doc()
    const transport = new GunTransport({ gun: FakeGun as any, batchInterval: 50 })
    let awarenessFrames = 0
    const origOnMessage = transport.onMessage.bind(transport)
    ;(transport as any).onMessage = (cb: (d: Uint8Array) => void) =>
      origOnMessage((d: Uint8Array) => {
        if (d.length > 4 && d[4] === 1) awarenessFrames++ // MESSAGE_AWARENESS after the CRC
        cb(d)
      })
    const joiner = new GenericProvider(doc, transport, { syncInterval: 0, disableBc: true })
    await joiner.connect({ room })
    joiner.awareness.setLocalState({ user: { name: 'joiner' } })
    await sleep(1000)
    const phantoms = joiner.awareness.getStates().size - 1 - LIVE
    console.log(
      `joiner: awareness frames delivered=${awarenessFrames} presence entries=${joiner.awareness.getStates().size} ` +
        `(self + ${LIVE} live + ${phantoms} phantoms) knownPeers=${(joiner as any)._knownPeers.size}`,
    )

    live[0].provider.destroy()
    await sleep(200)
    console.log(`slots in the graph after one graceful leave: ${liveSlots(room)}`)

    joiner.destroy()
    for (const p of live.slice(1)) p.provider.destroy()
  })
  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
