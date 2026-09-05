/**
 * Item 7 measurement
 * (docs/superpowers/specs/2026-09-04-sync-optimization-round-3-ideas.md):
 * how many separate peers broadcast a removal-only awareness update when
 * ONE peer goes silent WITHOUT a clean disconnect() (crash / dirty network
 * drop - disconnect() already broadcasts its own departure via
 * removeAwarenessStates(..., 'disconnect') before tearing down the
 * transport, so that path is NOT what this measures), and what that costs
 * in actual wire-delivered messages, across room sizes N.
 *
 * Background (confirmed by reading node_modules/y-protocols/awareness.js
 * directly): every Awareness instance runs its own `_checkInterval`
 * (`outdatedTimeout / 10` = 3000ms) that independently sweeps for peers
 * silent for `outdatedTimeout` (30000ms) and calls
 * `removeAwarenessStates(..., 'timeout')`. Both constants are module-level
 * `const`s, not configurable from a consumer - so this benchmark genuinely
 * waits ~34s of real time per room size to observe the actual sweep, same
 * convention as other real-time bench scripts (bench-idle-backoff.ts,
 * bench-reconnect-cycling.ts). GenericProvider's own `_setupAwarenessSync()`
 * update handler re-broadcasts on EVERY awareness 'update' regardless of
 * origin (no `origin === 'timeout'` filter, confirmed by reading
 * src/index.ts) - so if all N-1 survivors' `_checkInterval`s are
 * approximately phase-aligned (true here: every provider/Awareness
 * instance in this benchmark is constructed within milliseconds of the
 * others, right before connect()), they are expected to each independently
 * detect and broadcast the SAME removal within the same ~3s tick, before
 * any of their broadcasts has been received by the others (15ms simulated
 * latency vs. 3000ms tick granularity) - an O(N) broadcast burst producing
 * O(N^2) wire deliveries for one departure event.
 *
 * Measures two independent things:
 *   - "detectors": how many surviving peers' OWN local Awareness instance
 *     independently fired `removeAwarenessStates(..., 'timeout')` for the
 *     departed peer (observed directly via `awareness.on('update', ...)`
 *     with `origin === 'timeout'` on each survivor - the ground-truth
 *     signal for "this peer decided, on its own, to broadcast a removal").
 *   - wire cost: every `DummyHub.broadcast()` call is classified (after
 *     stripping the 4-byte CRC32 wrapper every _send() adds, and unwrapping
 *     MESSAGE_BATCH envelopes - mirrors bench-corruption-storm.ts's
 *     classifyOne()) as a "removal-only" awareness message (every entry's
 *     state === null) or not, and recipient counts (matching
 *     bench-user-scaling.ts's instrumentHub) are summed for the
 *     removal-only class specifically - this is the actual message-count
 *     figure to weigh against implementing a fix.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-awareness-removal-burst.js
 */

import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const MESSAGE_AWARENESS = 1
const MESSAGE_BATCH = 4

const ROOM_SIZES = [5, 10, 20, 50]
const LATENCY = 15
// outdatedTimeout (30000) + one _checkInterval period (3000) worst case,
// plus a margin for scheduling slop.
const TIMEOUT_WAIT_MS = 34000

interface Stats {
  totalMessages: number
  removalOnlyBroadcastCalls: number
  removalOnlyDeliveries: number
}

/**
 * Is `msg` (already CRC32-unwrapped, i.e. _handleIncomingMessage's input)
 * an awareness update where EVERY entry is a removal (state === null)?
 * Recurses into MESSAGE_BATCH envelopes (see _sendBatch()) since a
 * removal-only awareness broadcast can travel bundled with other
 * sub-messages in one wire send - only classified true if the WHOLE
 * envelope is removal-only awareness (a batch carrying anything else still
 * has to go out regardless of this benchmark's fix).
 */
function isRemovalOnlyAwareness(msg: Uint8Array): boolean {
  const decoder = decoding.createDecoder(msg)
  const msgType = decoding.readVarUint(decoder)

  if (msgType === MESSAGE_AWARENESS) {
    const payload = decoding.readVarUint8Array(decoder)
    const d2 = decoding.createDecoder(payload)
    const len = decoding.readVarUint(d2)
    if (len === 0) return false
    for (let i = 0; i < len; i++) {
      decoding.readVarUint(d2) // clientID
      decoding.readVarUint(d2) // clock
      const state = JSON.parse(decoding.readVarString(d2))
      if (state !== null) return false
    }
    return true
  }

  if (msgType === MESSAGE_BATCH) {
    let sawAny = false
    while (decoding.hasContent(decoder)) {
      sawAny = true
      const sub = decoding.readVarUint8Array(decoder)
      if (!isRemovalOnlyAwareness(sub)) return false
    }
    return sawAny
  }

  return false
}

/** Shadow hub.broadcast on this instance: count total + removal-only deliveries. */
function instrumentAwareness(hub: DummyHub): Stats {
  const stats: Stats = {
    totalMessages: 0,
    removalOnlyBroadcastCalls: 0,
    removalOnlyDeliveries: 0,
  }
  const original = hub.broadcast.bind(hub)
  ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (
    room: string,
    data: Uint8Array,
    sender: DummyTransport,
    options?: { latency?: number; dropRate?: number; jitter?: number },
  ) => {
    const recipients = Math.max(0, hub.getRoomSize(room) - 1)
    stats.totalMessages += recipients
    if (data.length > 4 && isRemovalOnlyAwareness(data.subarray(4))) {
      stats.removalOnlyBroadcastCalls++
      stats.removalOnlyDeliveries += recipients
    }
    return original(room, data, sender, options)
  }
  return stats
}

function makeRoom(
  hub: DummyHub,
  N: number,
): { docs: Y.Doc[]; providers: GenericProvider[]; transports: DummyTransport[] } {
  const docs: Y.Doc[] = []
  const providers: GenericProvider[] = []
  const transports: DummyTransport[] = []
  for (let i = 0; i < N; i++) {
    const doc = new Y.Doc()
    const transport = new DummyTransport({ hub, latency: LATENCY, jitter: 0.1 })
    const provider = new GenericProvider(doc, transport, {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: 0,
    })
    provider.awareness.setLocalStateField('user', { id: i })
    docs.push(doc)
    providers.push(provider)
    transports.push(transport)
  }
  return { docs, providers, transports }
}

/** Simulate a crash: stop sending AND stop receiving, with NO clean-departure broadcast. */
function crashPeer(hub: DummyHub, room: string, transport: DummyTransport): void {
  hub.leave(room, transport)
  ;(transport as unknown as { send: (data: Uint8Array) => void }).send = () => {}
}

interface RunResult {
  N: number
  detectors: number
  stats: Stats
}

async function runOnce(N: number): Promise<RunResult> {
  return silenced(async () => {
    const room = `bench-awareness-removal-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const { docs, providers, transports } = makeRoom(hub, N)

    await Promise.all(providers.map((p) => p.connect({ room })))

    // Wait for full presence exchange - every peer aware of all N clients.
    const deadline = Date.now() + 10000
    while (providers.some((p) => p.awareness.getStates().size < N)) {
      if (Date.now() > deadline) {
        throw new Error(`Timeout waiting for full presence exchange at N=${N}`)
      }
      await sleep(10)
    }
    await sleep(LATENCY * 2 + 50)

    const victimClientId = docs[0].clientID
    const survivors = providers.slice(1)

    // Ground truth: how many survivors' OWN local Awareness independently
    // fired a 'timeout' removal for the departed peer.
    let detectors = 0
    for (const p of survivors) {
      p.awareness.on(
        'update',
        ({ removed }: { removed: number[] }, origin: any) => {
          if (origin === 'timeout' && removed.includes(victimClientId)) {
            detectors++
          }
        },
      )
    }

    const stats = instrumentAwareness(hub)

    crashPeer(hub, room, transports[0])

    // Simulate realistic per-peer presence activity (cursor moves, etc.)
    // during the wait window at a cadence well under
    // outdatedTimeout/2 (15000ms) - a real active room's presence updates
    // keep meta.lastUpdated fresh from genuine activity, so
    // Awareness's own internal "renew local clock" branch
    // (node_modules/y-protocols/awareness.js's `_checkInterval`, the
    // `setLocalState(getLocalState())` call) essentially never fires.
    // WITHOUT this, every survivor here was constructed within
    // milliseconds of the others and never touched its own state again,
    // so their internal 15s auto-renewals stay phase-locked to the same
    // `_checkInterval` tick as the 30s (=2x15s) removal-due check from the
    // same shared time origin - and since GenericProvider's
    // `_awarenessUpdateHandler` fires per awareness 'update' event but
    // `_broadcastAwareness` coalesces same-tick calls into one pending
    // set, the removal always got bundled with that peer's own (non-null)
    // renewal in the SAME broadcast, silently making every removal
    // "impure" (added/updated non-empty) and invisible to
    // isRemovalOnlyAwareness - confirmed by an initial run of this
    // benchmark: detectors=4 but removalMsgs=0 at N=5. This activity
    // simulation is what makes the benchmark measure the condition item 7
    // actually targets instead of a same-tick-coalescing artifact of an
    // otherwise-idle room.
    const activityIntervals = survivors.map((p) =>
      setInterval(
        () => {
          if (p.awareness.getLocalState() !== null) {
            p.awareness.setLocalStateField('cursor', Math.random())
          }
        },
        2000 + Math.random() * 1000,
      ),
    )

    await sleep(TIMEOUT_WAIT_MS)

    for (const t of activityIntervals) clearInterval(t)
    for (const p of providers) p.destroy()
    hub.clear()

    return { N, detectors, stats }
  })
}

function printRow(r: RunResult): void {
  console.log(
    `${String(r.N).padStart(5)} | ${String(r.detectors).padStart(9)} | ` +
      `${String(r.stats.removalOnlyBroadcastCalls).padStart(11)} | ` +
      `${String(r.stats.removalOnlyDeliveries).padStart(11)} | ` +
      `${String(r.stats.totalMessages).padStart(13)}`,
  )
}

async function main() {
  console.log(
    'One peer crashes (no clean disconnect) mid-room; measuring the awareness-removal burst as OTHER peers independently timeout-detect it.',
  )
  console.log(`Each row waits ~${TIMEOUT_WAIT_MS / 1000}s of real time to observe the outdatedTimeout sweep.\n`)
  console.log('    N | detectors | removalMsgs | removalDlvr | totalWindowMsgs')
  const results: RunResult[] = []
  for (const N of ROOM_SIZES) {
    const r = await runOnce(N)
    printRow(r)
    results.push(r)
  }

  console.log('\ndetectors    = # surviving peers whose OWN checkInterval independently fired the timeout removal')
  console.log('removalMsgs  = # wire sends classified as removal-only awareness broadcasts')
  console.log('removalDlvr  = total recipient deliveries attributable to those sends (the real message-count cost)')
  console.log('totalWindowMsgs = all messages delivered during the ~34s observation window (includes simulated per-peer presence-activity traffic, unrelated to this burst)')

  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
