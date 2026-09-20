/**
 * Benchmark: does a page that goes away tell the room - when none of its
 * timers fires any more?
 *
 * Found by test/e2e/room-scenarios.mjs nostr with FIREFOX=10 (2026-09-20): a
 * reloaded peer left its old entry in every roster until the presence lease
 * ran out - "reload: rosters complete" 613 ms in a room of Chrome, 598 ms with
 * ten Firefox peers in a visible window each, 111,343 ms with the same ten as
 * HIDDEN tabs (120 s lease). The `beforeunload` handler removes the local
 * presence state, and the removal went out through the awareness throttle: a
 * timer, `setTimeout(0)` at best. A page being unloaded runs it in Chrome and
 * in a visible Firefox tab; a hidden Firefox tab clamps its timers to 1 s and
 * more, and is gone before that.
 *
 * Two peers on a hub. B "unloads": its `beforeunload` handlers run (through a
 * stub `window` - the core registers there), and from the moment they return
 * nothing B sends leaves the page any more, as if no timer ever ran again.
 *   part 1: B was idle before
 *   part 2: B changed its presence just before (the throttle holds a timer)
 *   part 3: B typed just before (the update batch holds a timer: 150 ms, Nostr's
 *           `preferredBatchMs`) - the same cause, and the room never gets those words
 * Reported: did A drop B within 300 ms, and (part 3) has it B's last words? Exit
 * code 1 if not.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-unload-removal.js
 *      TIMERS_ALIVE_MS=50: the control - B's timers run on for that long (Chrome, a visible
 *      Firefox tab); the build that failed with 0 passed with it.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const TIMERS_ALIVE_MS = Number(process.env.TIMERS_ALIVE_MS ?? 0)
const LAST_WORDS = 'last words'

// The core registers its unload handler on `window`, where there is one.
const unloadHandlers = new Set<() => void>()
;(globalThis as any).window = {
  addEventListener: (type: string, fn: () => void) => type === 'beforeunload' && unloadHandlers.add(fn),
  removeEventListener: (_type: string, fn: () => void) => unloadHandlers.delete(fn),
}

type Before = 'idle' | 'presence' | 'typed'

async function run(before: Before): Promise<{ dropped: boolean; text: string }> {
  let result = { dropped: false, text: '' }
  await silenced(async () => {
    const hub = new DummyHub()
    const room = `bench-unload-${Math.random().toString(36).slice(2)}`
    const make = async (name: string) => {
      const transport = new DummyTransport({ hub })
      const provider = new GenericProvider(new Y.Doc(), transport, { disableBc: true, awarenessTimeoutMs: 120000, batchUpdates: 150 })
      await provider.connect({ room })
      provider.awareness.setLocalStateField('user', { name })
      return { provider, transport }
    }
    const a = await make('A')
    unloadHandlers.clear() // only B unloads
    const b = await make('B')
    await sleep(1000)
    const sees = () => Array.from(a.provider.awareness.getStates().values()).some((s) => (s as any).user?.name === 'B')
    if (!sees()) throw new Error('setup: A never saw B')

    if (before === 'presence') b.provider.awareness.setLocalStateField('cursor', 1)
    if (before === 'typed') b.provider.doc.getText('t').insert(0, LAST_WORDS)
    for (const handler of [...unloadHandlers]) handler()
    if (TIMERS_ALIVE_MS > 0) await sleep(TIMERS_ALIVE_MS)
    // The page is gone: whatever a timer would send now never leaves it.
    b.transport.send = async () => {}
    await sleep(300)
    result = { dropped: !sees(), text: a.provider.doc.getText('t').toString() }

    a.provider.destroy()
    b.provider.destroy()
    hub.clear()
  })
  return result
}

async function main() {
  console.log('a page unloads and none of its timers fires any more: does the room drop it at once?')
  let failed = 0
  const parts: [string, Before][] = [['part 1, idle before', 'idle'], ['part 2, a presence change just before', 'presence'], ['part 3, typed just before', 'typed']]
  for (const [part, before] of parts) {
    const { dropped, text } = await run(before)
    const words = before !== 'typed' || text === LAST_WORDS
    if (!dropped || !words) failed++
    console.log(`  ${part}: ${dropped ? 'dropped within 300 ms' : 'STILL in the roster (until its lease runs out)'}${before === 'typed' ? (words ? ', its last words arrived' : ', its last words are LOST to the room') : ''}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
