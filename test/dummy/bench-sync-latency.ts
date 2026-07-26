/**
 * Benchmark: does `batchUpdates` and `verifyUpdates` cost materially affect
 * time-to-convergence under different simulated transport latency profiles?
 *
 * Runs entirely in Node against DummyTransport - no browser needed.
 *
 * IMPORTANT CAVEAT: DummyHub delivers each send() independently via its own
 * setTimeout, so N rapid unbatched sends are delivered roughly in parallel,
 * not serialized. Real HTTP-based transports (e.g. Matrix's PUT-per-update)
 * have head-of-line blocking (browser connection limits) that this model does
 * NOT capture, so the "no batching" cost for such transports is understated
 * here. The `msgCount` numbers (transport-agnostic) are the more trustworthy
 * signal for those cases; `totalMs` is most trustworthy for push-style
 * transports (WebSocket/PubNub/Supabase/WebRTC) where DummyHub's model is
 * closer to reality.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-sync-latency.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'

interface Profile {
  name: string
  latency: number
  jitter: number
}

// Latency numbers are rough stand-ins for the *effective* per-message
// end-to-end delay of each real transport (network RTT + any internal
// debounce/throttle), not literal network RTT alone. See conversation
// analysis for how each figure was derived from the provider source.
const PROFILES: Profile[] = [
  { name: 'WebSocket/PubNub/Supabase (push)', latency: 15, jitter: 0.2 },
  { name: 'WebRTC steady-state (post-handshake)', latency: 20, jitter: 0.1 },
  { name: 'Gun (100ms debounce + 300ms throttle + relay)', latency: 250, jitter: 0.3 },
  { name: 'Matrix (HTTP PUT send / long-poll receive)', latency: 350, jitter: 0.4 },
]

interface RunConfig {
  batchUpdates: number
  verifyUpdates: boolean
}

const CONFIGS: RunConfig[] = [
  { batchUpdates: 0, verifyUpdates: true }, // current default
  { batchUpdates: 150, verifyUpdates: true },
  { batchUpdates: 0, verifyUpdates: false },
  { batchUpdates: 150, verifyUpdates: false },
]

const EDIT_COUNT = 30 // simulated rapid keystrokes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runOnce(
  profile: Profile,
  cfg: RunConfig,
  preloadChars: number,
): Promise<{ totalMs: number; msgCount: number }> {
  const room = `bench-${Math.random().toString(36).slice(2)}`
  const hub = new DummyHub()

  let msgCount = 0
  const origBroadcast = hub.broadcast.bind(hub)
  ;(hub as any).broadcast = (...args: any[]) => {
    msgCount++
    return (origBroadcast as any)(...args)
  }

  const docA = new Y.Doc()
  const docB = new Y.Doc()

  if (preloadChars > 0) {
    docA.transact(() => {
      docA.getText('content').insert(0, 'x'.repeat(preloadChars))
    })
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
  }

  const transportA = new DummyTransport({
    hub,
    latency: profile.latency,
    jitter: profile.jitter,
  })
  const transportB = new DummyTransport({
    hub,
    latency: profile.latency,
    jitter: profile.jitter,
  })

  const providerA = new GenericProvider(docA, transportA, {
    batchUpdates: cfg.batchUpdates,
    verifyUpdates: cfg.verifyUpdates,
    syncInterval: 0,
  })
  const providerB = new GenericProvider(docB, transportB, {
    batchUpdates: cfg.batchUpdates,
    verifyUpdates: cfg.verifyUpdates,
    syncInterval: 0,
  })

  await providerA.connect({ room })
  await providerB.connect({ room })

  // Let initial sync settle before measuring.
  await sleep(profile.latency * 3 + 100)
  msgCount = 0 // reset - only count messages caused by the edit burst below

  const textA = docA.getText('content')
  const start = Date.now()

  for (let i = 0; i < EDIT_COUNT; i++) {
    docA.transact(() => {
      textA.insert(textA.length, 'a')
    })
  }

  const target = textA.toString()
  const timeoutAt = Date.now() + 20000
  while (docB.getText('content').toString() !== target) {
    if (Date.now() > timeoutAt) {
      throw new Error(
        `Timeout waiting for convergence (profile=${profile.name}, cfg=${JSON.stringify(cfg)}, preload=${preloadChars})`,
      )
    }
    await sleep(5)
  }
  const totalMs = Date.now() - start

  providerA.destroy()
  providerB.destroy()
  hub.clear()

  return { totalMs, msgCount }
}

async function main() {
  const preloadSizes = [0, 200_000]

  for (const preload of preloadSizes) {
    console.log(
      `\n=== Preloaded doc size: ${preload === 0 ? 'empty' : preload + ' chars (~' + Math.round(preload / 1024) + 'KB)'} ===`,
    )
    for (const profile of PROFILES) {
      console.log(`\n-- Profile: ${profile.name} (latency=${profile.latency}ms, jitter=${profile.jitter}) --`)
      console.log(
        'batchUpdates | verifyUpdates | totalMs | msgCount',
      )
      for (const cfg of CONFIGS) {
        const { totalMs, msgCount } = await runOnce(profile, cfg, preload)
        console.log(
          `${String(cfg.batchUpdates).padStart(12)} | ${String(cfg.verifyUpdates).padStart(13)} | ${String(totalMs).padStart(7)} | ${String(msgCount).padStart(8)}`,
        )
      }
    }
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
