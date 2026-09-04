/**
 * Benchmark: does debouncing onPeerConnect-triggered syncNow() calls (see
 * peerConnectDebounceMs) reduce message count when a burst of mesh peers
 * connect in a short window, compared to the actual pre-fix behavior
 * (syncNow() called directly, synchronously, per onPeerConnect event, with
 * no debounce machinery at all)?
 *
 * DummyTransport doesn't model a real mesh's per-peer data channels, so this
 * uses the onPeerConnect simulation added to DummyHub/DummyTransport
 * specifically for this benchmark: joining a room notifies every other
 * already-onPeerConnect-subscribed transport in the room (and vice versa),
 * mirroring how a mesh transport (peerjs, simple-peer) fires onPeerConnect
 * once per newly-opened data channel.
 *
 * Scenario: M peers are already settled and connected; K more peers then
 * connect within a short window (Promise.all). Measures total messages
 * attributable to the resulting onPeerConnect-triggered syncs, comparing
 * three points on the coalescing spectrum:
 *
 *   - 'uncoalesced': the actual pre-fix behavior - GenericProvider.prototype
 *     ._schedulePeerConnectSync is shadowed to call syncNow() synchronously,
 *     bypassing the debounce timer entirely (equivalent to connect()'s old
 *     onPeerConnect handler, which called `this.syncNow()` directly).
 *   - peerConnectDebounceMs: 0: the real _schedulePeerConnectSync path with
 *     a 0ms window. NOT equivalent to 'uncoalesced': setTimeout(fn, 0) still
 *     defers to a later event-loop tick, and the pending-timer guard is set
 *     synchronously up front - so onPeerConnect events fired within the same
 *     synchronous DummyHub.registerPeerConnect() notification loop still
 *     land on one pending timer and coalesce "for free," even at 0ms. This
 *     is opportunistic same-tick coalescing, not "no coalescing."
 *   - peerConnectDebounceMs: 50 (the default): guaranteed window coalescing
 *     - every onPeerConnect event within a rolling 50ms window collapses
 *     into one syncNow() call, regardless of event-loop tick boundaries.
 *
 * Also counts _tryReserveSyncSlot() attempts/drops (the shared sync
 * rate-limit budget syncNow() reserves from) per variant, to check whether
 * a burstier call pattern causes some syncNow() pushes to be silently
 * rate-limited away rather than actually sent - a possible confound when
 * comparing raw message counts across variants with very different call
 * frequencies.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-mesh-join-burst.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, instrumentHub, silenced } from './bench-user-scaling'

const SCENARIOS: Array<{ M: number; K: number }> = [
  { M: 5, K: 5 },
  { M: 10, K: 10 },
  { M: 20, K: 10 },
]

type Variant = 'uncoalesced' | 0 | 50

/**
 * Shadow GenericProvider.prototype._schedulePeerConnectSync to bypass the
 * debounce timer entirely and call syncNow() synchronously - reproduces the
 * actual pre-fix onPeerConnect handler (`if (!this._destroying)
 * this.syncNow()`), which no longer exists in source once
 * _schedulePeerConnectSync is in place. Global prototype patch, install/
 * restore per run so it never leaks across scenarios.
 */
function withUncoalescedPeerConnect(): () => void {
  const proto = GenericProvider.prototype as unknown as {
    _schedulePeerConnectSync: () => void
  }
  const original = proto._schedulePeerConnectSync
  proto._schedulePeerConnectSync = function (this: GenericProvider) {
    this.syncNow()
  }
  return () => {
    proto._schedulePeerConnectSync = original
  }
}

interface SlotStats {
  attempts: number
  drops: number
}

/**
 * Shadow GenericProvider.prototype._tryReserveSyncSlot to count how many
 * syncNow()-triggered push/pull attempts are made vs. silently dropped by
 * the shared sync rate limiter (_maxSyncRequestsPerWindow).
 */
function withSlotStats(stats: SlotStats): () => void {
  const proto = GenericProvider.prototype as unknown as {
    _tryReserveSyncSlot: () => boolean
  }
  const original = proto._tryReserveSyncSlot
  proto._tryReserveSyncSlot = function (this: GenericProvider) {
    stats.attempts++
    const ok = original.call(this)
    if (!ok) stats.drops++
    return ok
  }
  return () => {
    proto._tryReserveSyncSlot = original
  }
}

function makeMeshProvider(
  hub: DummyHub,
  id: number,
  peerConnectDebounceMs: number,
): { doc: Y.Doc; provider: GenericProvider } {
  const doc = new Y.Doc()
  const transport = new DummyTransport({ hub, latency: 10, jitter: 0.1 })
  const provider = new GenericProvider(doc, transport, {
    batchUpdates: 0,
    verifyUpdates: true,
    syncInterval: 0,
    peerConnectDebounceMs,
  })
  provider.awareness.setLocalStateField('user', { id })
  return { doc, provider }
}

async function runScenario(
  M: number,
  K: number,
  variant: Variant,
): Promise<{ messages: number; allSynced: boolean; slotStats: SlotStats }> {
  return silenced(async () => {
    const room = `bench-mesh-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const stats = instrumentHub(hub)
    const slotStats: SlotStats = { attempts: 0, drops: 0 }
    const restoreSlotStats = withSlotStats(slotStats)
    const restoreUncoalesced =
      variant === 'uncoalesced' ? withUncoalescedPeerConnect() : undefined
    const peerConnectDebounceMs = variant === 'uncoalesced' ? 0 : variant

    try {
      const settled: GenericProvider[] = []
      for (let i = 0; i < M; i++) {
        const { provider } = makeMeshProvider(hub, i, peerConnectDebounceMs)
        settled.push(provider)
      }
      await Promise.all(settled.map((p) => p.connect({ room })))
      await sleep(100)

      const pre = { messages: stats.messages }

      const joiners: GenericProvider[] = []
      for (let i = 0; i < K; i++) {
        const { provider } = makeMeshProvider(hub, M + i, peerConnectDebounceMs)
        joiners.push(provider)
      }
      await Promise.all(joiners.map((p) => p.connect({ room })))

      const all = [...settled, ...joiners]
      const timeoutAt = Date.now() + 15000
      while (Date.now() < timeoutAt && all.some((p) => !p.synced)) {
        await sleep(10)
      }
      await sleep(150) // settle window for trailing debounced syncs

      const allSynced = all.every((p) => p.synced)
      const messages = stats.messages - pre.messages

      for (const p of all) p.destroy()
      hub.clear()

      return { messages, allSynced, slotStats }
    } finally {
      restoreUncoalesced?.()
      restoreSlotStats()
    }
  })
}

async function main() {
  console.log('M = already-settled peers, K = peers joining in a burst\n')
  console.log(
    '   M |    K |      variant | messages | allSynced | slot drops/attempts',
  )
  for (const { M, K } of SCENARIOS) {
    for (const variant of ['uncoalesced', 0, 50] as const) {
      const { messages, allSynced, slotStats } = await runScenario(
        M,
        K,
        variant,
      )
      console.log(
        `${String(M).padStart(4)} | ${String(K).padStart(4)} | ${String(variant).padStart(13)} | ${String(messages).padStart(8)} | ${String(allSynced).padStart(9)} | ${slotStats.drops}/${slotStats.attempts}`,
      )
    }
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
