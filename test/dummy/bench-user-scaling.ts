/**
 * Benchmark: how do message count, bytes-on-wire, wall-clock time, and CPU
 * time scale as the number of simulated users in a room grows?
 *
 * Two workload shapes, run for each user count N and each latency profile:
 *
 * - Fan-out: N clients are already connected and synced; one client performs
 *   a burst of edits and we measure everything caused by propagating that
 *   burst to the other N-1 clients.
 * - Join-burst: N clients connect concurrently (simulating "everyone
 *   reconnects after a network blip") and we measure everything caused by
 *   bringing all N to `synced` state.
 *
 * Runs entirely in Node against DummyTransport - no browser needed. console
 * output is silenced during measured windows so the provider's own
 * console.warn/error calls (e.g. hash-mismatch logging) don't skew the
 * wall-clock/CPU numbers being measured.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-user-scaling.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'

export interface Profile {
  name: string
  latency: number
  jitter: number
}

export const PROFILES: Profile[] = [
  { name: 'WebSocket/PubNub/Supabase (push)', latency: 15, jitter: 0.2 },
  { name: 'WebRTC steady-state (post-handshake)', latency: 20, jitter: 0.1 },
  { name: 'Gun (100ms debounce + 300ms throttle + relay)', latency: 250, jitter: 0.3 },
  { name: 'Matrix (HTTP PUT send / long-poll receive)', latency: 350, jitter: 0.4 },
]

const USER_COUNTS = [5, 10, 25, 50, 100]
const EDIT_COUNT = 10

interface RunResult {
  totalMs: number
  cpuMs: number
  messages: number
  bytes: number
  /** fan-out only: deliveries counted at the moment every doc converged (the pre-phase-1b metric) */
  atConvergence?: number
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Shadow DummyHub.broadcast on this instance to count actual per-recipient
 * deliveries (messages/bytes), not just broadcast() call count. dropRate is
 * always 0 in this benchmark, so getRoomSize(room) - 1 is exact.
 */
export function instrumentHub(hub: DummyHub) {
  let messages = 0
  let bytes = 0
  const original = hub.broadcast.bind(hub)
  ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (
    room: string,
    data: Uint8Array,
    sender: DummyTransport,
    options?: { latency?: number; dropRate?: number; jitter?: number },
  ) => {
    const recipients = Math.max(0, hub.getRoomSize(room) - 1)
    messages += recipients
    bytes += recipients * data.length
    return original(room, data, sender, options)
  }
  return {
    get messages() {
      return messages
    },
    get bytes() {
      return bytes
    },
  }
}

/**
 * Silence console.warn/error for the duration of fn, restoring afterwards.
 * Prevents the provider's own diagnostic logging (hash mismatches, gap
 * warnings) from adding console I/O cost to the measured window.
 */
export async function silenced<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.warn = warn
    console.error = error
  }
}

export function makeProviders(
  hub: DummyHub,
  profile: Profile,
  N: number,
  dropRate: number = 0,
  syncInterval: number = 0,
): { docs: Y.Doc[]; providers: GenericProvider[] } {
  const docs: Y.Doc[] = []
  const providers: GenericProvider[] = []
  for (let i = 0; i < N; i++) {
    const doc = new Y.Doc()
    const transport = new DummyTransport({
      hub,
      latency: profile.latency,
      jitter: profile.jitter,
      dropRate,
    })
    const provider = new GenericProvider(doc, transport, {
      batchUpdates: 0,
      verifyUpdates: true,
      // 0 (default) isolates join/resync mechanics from the periodic beacon;
      // bench-packet-loss passes a real interval, because recovery from a
      // lost LAST update has no trigger but the periodic beacon by design.
      syncInterval,
    })
    // Bump local awareness state past the library's genesis clock (0) -
    // every real consumer app does this for presence/cursors, and it's a
    // precondition for Task 3's SyncStep2-reply-suppression peer-count gate
    // (this.awareness.getStates().size >= 3) to ever see other peers. See
    // docs/superpowers/specs/2026-07-26-dummy-benchmark-scaling-design.md
    // "Part 4" for why this line matters.
    provider.awareness.setLocalStateField('user', { id: i })
    docs.push(doc)
    providers.push(provider)
  }
  return { docs, providers }
}

async function runFanOut(N: number, profile: Profile): Promise<RunResult> {
  return silenced(async () => {
    const room = `bench-fanout-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const stats = instrumentHub(hub)
    const { docs, providers } = makeProviders(hub, profile, N)

    await Promise.all(providers.map((p) => p.connect({ room })))
    // Default: edit right after the join burst, while every peer's
    // 20-per-10s sync budget is still mostly spent on join replies. Override
    // with SETTLE_MS=<ms> (e.g. 12000) for a fresh budget - on the
    // high-latency profiles the two regimes differ by ~20x at N=100, see
    // docs/superpowers/specs/2026-09-05-digest-beacon-design.md (Task 3c).
    await sleep(Number(process.env.SETTLE_MS ?? profile.latency * 3 + 100))

    // Reset counters - only count messages caused by the edit burst below.
    const preExisting = { messages: stats.messages, bytes: stats.bytes }

    const textA = docs[0].getText('content')
    const cpuBefore = process.cpuUsage()
    const start = Date.now()

    for (let i = 0; i < EDIT_COUNT; i++) {
      docs[0].transact(() => {
        textA.insert(textA.length, 'a')
      })
    }

    const target = textA.toString()
    const timeoutAt = Date.now() + 30000
    while (docs.some((d) => d.getText('content').toString() !== target)) {
      if (Date.now() > timeoutAt) {
        throw new Error(`Timeout: fan-out N=${N} profile=${profile.name}`)
      }
      await sleep(5)
    }

    const totalMs = Date.now() - start
    const cpuAfter = process.cpuUsage(cpuBefore)
    const cpuMs = (cpuAfter.user + cpuAfter.system) / 1000
    const atConvergence = stats.messages - preExisting.messages

    // Keep counting until the room has been quiet for QUIET_MS (cap
    // TAIL_CAP_MS): the hash-mismatch/resync cascade under jitter runs on
    // for seconds AFTER every doc has the content (research doc item 13) -
    // counting only to convergence hid ~95% of it on the Gun/Matrix
    // profiles at N=100 (9,405 at convergence vs ~199,000 until quiet).
    const QUIET_MS = 1000
    const TAIL_CAP_MS = 10000
    const tailStart = Date.now()
    let lastCount = stats.messages
    let quietSince = Date.now()
    while (Date.now() - tailStart < TAIL_CAP_MS) {
      await sleep(50)
      if (stats.messages !== lastCount) {
        lastCount = stats.messages
        quietSince = Date.now()
      } else if (Date.now() - quietSince >= QUIET_MS) {
        break
      }
    }

    const result: RunResult = {
      totalMs,
      cpuMs,
      messages: stats.messages - preExisting.messages,
      bytes: stats.bytes - preExisting.bytes,
      atConvergence,
    }

    for (const p of providers) p.destroy()
    hub.clear()

    return result
  })
}

async function runJoinBurst(N: number, profile: Profile): Promise<RunResult> {
  return silenced(async () => {
    const room = `bench-join-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const stats = instrumentHub(hub)
    const { providers } = makeProviders(hub, profile, N)

    const cpuBefore = process.cpuUsage()
    const start = Date.now()

    await Promise.all(providers.map((p) => p.connect({ room })))

    const timeoutAt = Date.now() + 30000
    while (N > 1 && providers.some((p) => !p.synced)) {
      if (Date.now() > timeoutAt) {
        throw new Error(`Timeout: join-burst N=${N} profile=${profile.name}`)
      }
      await sleep(5)
    }
    // Short settle window for trailing awareness/sync replies to land.
    await sleep(profile.latency * 2 + 50)

    const totalMs = Date.now() - start
    const cpuAfter = process.cpuUsage(cpuBefore)
    const cpuMs = (cpuAfter.user + cpuAfter.system) / 1000

    const result: RunResult = {
      totalMs,
      cpuMs,
      messages: stats.messages,
      bytes: stats.bytes,
    }

    for (const p of providers) p.destroy()
    hub.clear()

    return result
  })
}

function printRow(N: number, r: RunResult): void {
  const tail = r.atConvergence === undefined ? '' : ` | ${String(r.atConvergence).padStart(8)}`
  console.log(
    `${String(N).padStart(5)} | ${String(r.totalMs).padStart(7)} | ${r.cpuMs.toFixed(1).padStart(6)} | ${String(r.messages).padStart(8)} | ${String(r.bytes).padStart(9)}${tail}`,
  )
}

async function main() {
  console.log('=== Fan-out cost (steady-state broadcast of a 10-edit burst) ===')
  console.log('"messages"/"bytes" = deliveries until the room is quiet for 1s (cap 10s); "atConv" = deliveries at the moment every doc converged.')
  for (const profile of PROFILES) {
    console.log(`\n-- Profile: ${profile.name} (latency=${profile.latency}ms, jitter=${profile.jitter}) --`)
    console.log('users | totalMs |  cpuMs | messages |     bytes |   atConv')
    for (const N of USER_COUNTS) {
      const r = await runFanOut(N, profile)
      printRow(N, r)
    }
  }

  console.log('\n=== Join-burst cost (N clients connecting concurrently) ===')
  for (const profile of PROFILES) {
    console.log(`\n-- Profile: ${profile.name} (latency=${profile.latency}ms, jitter=${profile.jitter}) --`)
    console.log('users | totalMs |  cpuMs | messages |     bytes')
    for (const N of USER_COUNTS) {
      const r = await runJoinBurst(N, profile)
      printRow(N, r)
    }
  }

  process.exit(0)
}

// Guarded so this file can be `import`ed (e.g. by
// bench-asymmetric-join.ts, which reuses makeProviders/sleep/silenced/
// PROFILES) without also running the full suite above as a side effect.
if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
