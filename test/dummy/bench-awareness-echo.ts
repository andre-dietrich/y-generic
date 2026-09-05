/**
 * Regression bench for a pre-existing bug found while measuring Item 7 of
 * docs/superpowers/specs/2026-09-04-sync-optimization-round-3-ideas.md:
 * `_setupAwarenessSync()`'s update handler broadcast on EVERY awareness
 * 'update' event regardless of `origin`, despite its own comment ("...
 * unless they came from remote") saying otherwise - `git log -p` on that
 * handler shows the origin check was never actually implemented, since the
 * very first commit.
 *
 * Every transport this project targets is either a full-room relay
 * (websocket/pubnub/gun/matrix/ably/supabase) or wired as a full mesh
 * (peerjs/simple-peer/trystero - see CLAUDE.md), so the ORIGINAL sender's
 * broadcast already reaches every other peer directly. Re-broadcasting an
 * awareness update on receipt (origin === the receiving provider's own
 * instance, per `applyAwarenessUpdate(this.awareness, ..., this)`) is pure
 * echo: every one of the N-1 receivers re-broadcasts once, each reaching
 * N-1 peers, turning ONE state change into N*(N-1) wire deliveries instead
 * of N-1.
 *
 * This measures exactly that: N peers settle, one peer makes ONE awareness
 * field change, count total deliveries caused by it. Expected N-1 (fixed);
 * was N*(N-1) (bug).
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-awareness-echo.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const ROOM_SIZES = [3, 5, 10, 20, 50]

async function runOnce(N: number): Promise<number> {
  return silenced(async () => {
    const room = `bench-awareness-echo-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const providers: GenericProvider[] = []
    for (let i = 0; i < N; i++) {
      const doc = new Y.Doc()
      const transport = new DummyTransport({ hub, latency: 15, jitter: 0.1 })
      const provider = new GenericProvider(doc, transport, {
        batchUpdates: 0,
        verifyUpdates: true,
        syncInterval: 0,
      })
      provider.awareness.setLocalStateField('user', { id: i })
      providers.push(provider)
    }

    await Promise.all(providers.map((p) => p.connect({ room })))
    const deadline = Date.now() + 10000
    while (providers.some((p) => p.awareness.getStates().size < N)) {
      if (Date.now() > deadline) {
        throw new Error(`Timeout waiting for full presence exchange at N=${N}`)
      }
      await sleep(10)
    }
    await sleep(100)

    let messages = 0
    const original = hub.broadcast.bind(hub)
    ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (
      r: string,
      data: Uint8Array,
      sender: DummyTransport,
      options?: { latency?: number; dropRate?: number; jitter?: number },
    ) => {
      messages += Math.max(0, hub.getRoomSize(r) - 1)
      return original(r, data, sender, options)
    }

    providers[0].awareness.setLocalStateField('cursor', 42)
    await sleep(500)

    for (const p of providers) p.destroy()
    hub.clear()

    return messages
  })
}

async function main() {
  console.log('One awareness field change from one peer - total wire deliveries it causes:\n')
  console.log('    N | messages | expected (N-1) | pre-fix would be (N*(N-1))')
  for (const N of ROOM_SIZES) {
    const messages = await runOnce(N)
    console.log(
      `${String(N).padStart(5)} | ${String(messages).padStart(8)} | ${String(N - 1).padStart(14)} | ${String(N * (N - 1)).padStart(26)}`,
    )
    if (messages !== N - 1) {
      console.error(`REGRESSION: N=${N} expected ${N - 1} messages, got ${messages}`)
      process.exit(1)
    }
  }
  console.log('\nOK: every room size produced exactly N-1 messages (no echo amplification).')
  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
