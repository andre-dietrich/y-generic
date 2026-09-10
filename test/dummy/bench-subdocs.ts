/**
 * PARKED (2026-09-07, André's decision in round 5): this bench exercises a
 * subdocument design (DocChannel / _registerChannel, one MESSAGE_SUBDOC type
 * carrying guid-prefixed inner messages) that exists nowhere in src/ - it is
 * the red test for round-4 research item 10 (docs/superpowers/specs/
 * 2026-09-05-sync-optimization-round-4-research.md), kept so the design is
 * not lost. It is NOT in tsconfig.bench.json and does not compile against
 * the current provider. Resume with its own design doc and plan, or delete.
 */
/**
 * Verification script for Yjs subdocument sync support in GenericProvider.
 *
 * Exercises the real GenericProvider/DocChannel machinery (src/index.ts)
 * against the DummyTransport, covering each design detail from
 * docs/superpowers (see the "Yjs subdocument sync for GenericProvider" plan):
 *   1. Root-only usage still converges normally (no regression).
 *   2. A subdoc loaded BEFORE connect() is picked up by the constructor's
 *      _registerChannel() walk and syncs once connected.
 *   3. A subdoc loaded AFTER connect() (standard `.load()` call, no new
 *      y-generic API) is picked up live via the 'subdocs' event and synced
 *      without any explicit provider call.
 *   4. A subdoc removed from its parent tears down its channel on both the
 *      removing side and the receiving side (via the ordinary root-doc
 *      update that deletes the map entry).
 *   5. A subdoc-of-a-subdoc (nested two levels) is picked up recursively,
 *      both structurally (no network) and end-to-end over the wire.
 *   6. The sync rate limiter is shared across every channel (root + all
 *      subdocs), not given its own budget per channel.
 *   7. The public 'synced' event/getter stays scoped to the root channel
 *      only, even when subdocs are also syncing.
 *   8. destroy() tears down every subdoc channel's listeners - no further
 *      messages are sent for a subdoc edited after destroy().
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-subdocs.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  return predicate()
}

let passCount = 0
let failCount = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`✅ ${name}`)
    passCount++
  } catch (err) {
    console.log(`❌ ${name}`)
    console.log(`   ${err instanceof Error ? err.message : String(err)}`)
    failCount++
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function newRoom(label: string): string {
  return `bench-subdocs-${label}-${Math.random().toString(36).slice(2)}`
}

// ---------------------------------------------------------------------------
// 1. Root-only usage still converges normally
// ---------------------------------------------------------------------------
async function testRootOnlyConvergence(): Promise<void> {
  const hub = new DummyHub()
  const room = newRoom('root-only')
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const providerA = new GenericProvider(docA, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })
  const providerB = new GenericProvider(docB, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })

  try {
    await providerA.connect({ room })
    await providerB.connect({ room })

    docA.getText('content').insert(0, 'hello root')

    const converged = await waitFor(
      () => docB.getText('content').toString() === 'hello root',
    )
    assert(converged, 'root doc content did not converge')
    // A hash-mismatch race during concurrent connect (both peers' initial
    // pushes crossing in flight) is expected and self-heals via the
    // existing resync backoff - give it room to settle before asserting.
    const bothSynced = await waitFor(() => providerA.synced && providerB.synced)
    assert(bothSynced, 'providers never both reported synced')
  } finally {
    providerA.destroy()
    providerB.destroy()
    hub.clear()
  }
}

// ---------------------------------------------------------------------------
// 2 & 3. Subdoc loaded before connect() (A side) and after connect() (B side)
// ---------------------------------------------------------------------------
async function testSubdocLoadedBeforeAndAfterConnect(): Promise<void> {
  const hub = new DummyHub()
  const room = newRoom('subdoc-lifecycle')
  const docA = new Y.Doc()
  const docB = new Y.Doc()

  // Subdoc created and loaded BEFORE the provider is even constructed -
  // exercises the constructor's _registerChannel() initial walk of
  // doc.subdocs picking up an already-loaded child.
  const subdocA = new Y.Doc()
  docA.getMap('subdocs').set('sub1', subdocA)
  subdocA.load()

  const providerA = new GenericProvider(docA, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })
  const providerB = new GenericProvider(docB, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })

  try {
    // Registered at construction time, before connect() - whitebox check
    // that the pre-loaded subdoc was picked up immediately.
    assert(
      (providerA as any)._subChannels.has(subdocA.guid),
      'subdocA was not registered at provider construction time',
    )

    await providerA.connect({ room })
    await providerB.connect({ room })

    // The subdoc reference (guid + opts pointer, no content) arrives via
    // the ordinary root-doc sync. On the receiving side it starts
    // unloaded (shouldLoad: false) until the app calls .load() itself -
    // that's the existing Yjs API this feature rides on, not a new one.
    const gotReference = await waitFor(
      () => docB.getMap('subdocs').get('sub1') instanceof Y.Doc,
    )
    assert(gotReference, 'subdoc reference never arrived on docB')
    const subdocB = docB.getMap('subdocs').get('sub1') as Y.Doc
    assert(subdocB.guid === subdocA.guid, 'subdoc guid mismatch after sync')
    assert(
      !(providerB as any)._subChannels.has(subdocB.guid),
      'subdocB was registered before .load() was ever called',
    )

    // Edit subdocA's content BEFORE subdocB is loaded - providerB will
    // silently drop any subdoc-tagged message it receives in the meantime
    // (design decision: unknown-guid messages are dropped, not buffered).
    subdocA.getText('t').insert(0, 'hello-subdoc')
    await sleep(100)

    // Now load it - standard Yjs API, no y-generic method involved. This
    // should fire providerB's live 'subdocs' listener and register+sync
    // the channel without any explicit provider call.
    subdocB.load()

    const registered = await waitFor(() =>
      (providerB as any)._subChannels.has(subdocB.guid),
    )
    assert(registered, 'subdocB.load() did not register a channel')

    const converged = await waitFor(
      () => subdocB.getText('t').toString() === 'hello-subdoc',
    )
    assert(converged, 'subdoc content did not converge after .load()')
  } finally {
    providerA.destroy()
    providerB.destroy()
    hub.clear()
  }
}

// ---------------------------------------------------------------------------
// 4. Subdoc removal tears down the channel on both sides
// ---------------------------------------------------------------------------
async function testSubdocRemoval(): Promise<void> {
  const hub = new DummyHub()
  const room = newRoom('subdoc-removal')
  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const subdocA = new Y.Doc()
  docA.getMap('subdocs').set('sub1', subdocA)
  subdocA.load()

  const providerA = new GenericProvider(docA, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })
  const providerB = new GenericProvider(docB, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })

  try {
    await providerA.connect({ room })
    await providerB.connect({ room })

    await waitFor(() => docB.getMap('subdocs').get('sub1') instanceof Y.Doc)
    const subdocB = docB.getMap('subdocs').get('sub1') as Y.Doc
    subdocB.load()
    await waitFor(() => (providerB as any)._subChannels.has(subdocB.guid))

    const guid = subdocA.guid

    // Remove it on the A side - Yjs itself destroys subdocA right after
    // emitting the 'subdocs' removed event, which is what our
    // _unregisterSubdoc() cleanup piggybacks on.
    docA.getMap('subdocs').delete('sub1')

    const unregisteredOnA = await waitFor(
      () => !(providerA as any)._subChannels.has(guid),
    )
    assert(unregisteredOnA, 'providerA did not unregister the removed subdoc')

    // The deletion propagates to B as an ordinary root-doc update, which
    // triggers the same removal+destroy cascade there too.
    const unregisteredOnB = await waitFor(
      () => !(providerB as any)._subChannels.has(guid),
    )
    assert(unregisteredOnB, 'providerB did not unregister the removed subdoc')
  } finally {
    providerA.destroy()
    providerB.destroy()
    hub.clear()
  }
}

// ---------------------------------------------------------------------------
// 5. Nested subdoc-of-a-subdoc, structural + end-to-end
// ---------------------------------------------------------------------------
async function testNestedSubdoc(): Promise<void> {
  const hub = new DummyHub()
  const room = newRoom('nested-subdoc')
  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const subdocA1 = new Y.Doc()
  const subdocA2 = new Y.Doc()
  docA.getMap('subdocs').set('sub1', subdocA1)
  subdocA1.load()
  subdocA1.getMap('nested').set('sub2', subdocA2)
  subdocA2.load()

  const providerA = new GenericProvider(docA, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })
  const providerB = new GenericProvider(docB, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })

  try {
    // Purely structural, no network involved yet: the constructor's
    // recursive walk should have registered BOTH levels immediately.
    assert(
      (providerA as any)._subChannels.has(subdocA1.guid),
      'subdocA1 (first level) was not registered at construction',
    )
    assert(
      (providerA as any)._subChannels.has(subdocA2.guid),
      'subdocA2 (nested second level) was not registered at construction',
    )

    await providerA.connect({ room })
    await providerB.connect({ room })

    await waitFor(() => docB.getMap('subdocs').get('sub1') instanceof Y.Doc)
    const subdocB1 = docB.getMap('subdocs').get('sub1') as Y.Doc
    subdocB1.load()

    // subdocA2's reference only travels as part of subdocA1's OWN update
    // stream (it's a value inside subdocA1's Y.Map), so it only appears on
    // B once subdocB1 itself is loaded and has synced.
    const gotNestedRef = await waitFor(
      () => subdocB1.getMap('nested').get('sub2') instanceof Y.Doc,
    )
    assert(gotNestedRef, 'nested subdoc reference never arrived on subdocB1')
    const subdocB2 = subdocB1.getMap('nested').get('sub2') as Y.Doc
    assert(subdocB2.guid === subdocA2.guid, 'nested subdoc guid mismatch')

    subdocA2.getText('t').insert(0, 'deeply-nested')
    subdocB2.load()

    const converged = await waitFor(
      () => subdocB2.getText('t').toString() === 'deeply-nested',
    )
    assert(converged, 'nested subdoc content did not converge end-to-end')
  } finally {
    providerA.destroy()
    providerB.destroy()
    hub.clear()
  }
}

// ---------------------------------------------------------------------------
// 6. Rate limiter is shared across every channel, not per-channel
// ---------------------------------------------------------------------------
async function testSharedRateLimiter(): Promise<void> {
  const hub = new DummyHub()
  const room = newRoom('rate-limit')
  const docA = new Y.Doc()

  const subdocs: Y.Doc[] = []
  for (let i = 0; i < 5; i++) {
    const sub = new Y.Doc()
    docA.getMap('subdocs').set(`sub${i}`, sub)
    sub.load()
    subdocs.push(sub)
  }

  const transportA = new DummyTransport({ hub, latency: 5 })
  const providerA = new GenericProvider(docA, transportA, {
    syncInterval: 0,
    maxSyncRequestsPerWindow: 2,
    syncRequestWindowMs: 10000,
  })

  try {
    assert(
      (providerA as any)._subChannels.size === 5,
      'not all 5 subdocs were registered before connect',
    )

    // connect()'s own initial syncNow() already sweeps root + 5 subdocs (6
    // channels) through the SAME shared 2-slot budget - by the time it
    // returns, the window's budget is exhausted regardless of channel count.
    await providerA.connect({ room })

    // Only count sync-protocol messages (byte 4, right after the 4-byte
    // CRC32 header, is the message-type varUint - 0/3/4/5 are sync
    // variants). Awareness (1) is independently throttled and NOT gated by
    // the sync rate limiter by design, so a throttled awareness broadcast
    // flushing during this window would be an irrelevant false positive.
    let sentCount = 0
    const originalSend = transportA.send.bind(transportA)
    transportA.send = (data: Uint8Array) => {
      if ([0, 3, 4, 5].includes(data[4])) sentCount++
      return originalSend(data)
    }

    // Immediately call syncNow() again in the SAME rate-limit window. If
    // the budget were per-channel (5 subdocs + root each with their own
    // allowance), this would still send messages for untouched channels.
    // Since it's shared and already exhausted, this must send nothing.
    providerA.syncNow()
    await sleep(50)

    assert(
      sentCount === 0,
      `expected 0 sync messages from a second syncNow() in the same ` +
        `rate-limit window (shared budget already exhausted), got ` +
        `${sentCount} - rate limiting may have become per-channel instead ` +
        `of shared`,
    )
  } finally {
    providerA.destroy()
    hub.clear()
  }
}

// ---------------------------------------------------------------------------
// 7. 'synced' event/getter stays scoped to the root channel
// ---------------------------------------------------------------------------
async function testSyncedStaysRootScoped(): Promise<void> {
  const hub = new DummyHub()
  const room = newRoom('synced-scope')
  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const subdocA = new Y.Doc()
  docA.getMap('subdocs').set('sub1', subdocA)
  subdocA.load()
  subdocA.getText('t').insert(0, 'content')

  const providerA = new GenericProvider(docA, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })
  const providerB = new GenericProvider(docB, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })

  let syncedEventCount = 0
  providerB.on('synced', () => syncedEventCount++)

  try {
    await providerA.connect({ room })
    await providerB.connect({ room })

    await waitFor(() => docB.getMap('subdocs').get('sub1') instanceof Y.Doc)
    const subdocB = docB.getMap('subdocs').get('sub1') as Y.Doc
    subdocB.load()

    await waitFor(() => subdocB.getText('t').toString() === 'content')
    await waitFor(() => providerB.synced)
    await sleep(100) // let any extra periodic/duplicate SyncStep2 settle

    assert(
      syncedEventCount === 1,
      `expected exactly 1 'synced' emission (root-scoped only), got ` +
        `${syncedEventCount} - a subdoc's own SyncStep2 may be leaking ` +
        `into the public event`,
    )
  } finally {
    providerA.destroy()
    providerB.destroy()
    hub.clear()
  }
}

// ---------------------------------------------------------------------------
// 8. destroy() tears down every subdoc channel's listeners
// ---------------------------------------------------------------------------
async function testDestroyTearsDownSubdocs(): Promise<void> {
  const hub = new DummyHub()
  const room = newRoom('destroy-teardown')
  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const subdocA = new Y.Doc()
  docA.getMap('subdocs').set('sub1', subdocA)
  subdocA.load()

  const transportA = new DummyTransport({ hub, latency: 5 })
  const providerA = new GenericProvider(docA, transportA, { syncInterval: 0 })
  const providerB = new GenericProvider(docB, new DummyTransport({ hub, latency: 5 }), {
    syncInterval: 0,
  })

  try {
    await providerA.connect({ room })
    await providerB.connect({ room })
    await waitFor(() => docB.getMap('subdocs').get('sub1') instanceof Y.Doc)

    providerA.destroy()

    assert(
      (providerA as any)._subChannels.size === 0,
      'destroy() left subdoc channels registered',
    )

    let sentCount = 0
    const originalSend = transportA.send.bind(transportA)
    transportA.send = (data: Uint8Array) => {
      sentCount++
      return originalSend(data)
    }

    // subdocA itself is untouched by destroy() (only the removed-from-tree
    // case destroys a Y.Doc) - editing it post-destroy must produce no
    // outbound traffic, since its update listener was detached.
    subdocA.getText('t').insert(0, 'after destroy')
    await sleep(50)

    assert(
      sentCount === 0,
      `expected 0 messages sent for a subdoc edited after destroy(), got ${sentCount}`,
    )
  } finally {
    providerB.destroy()
    hub.clear()
  }
}

async function main() {
  await test('1. Root-only usage converges (no regression)', testRootOnlyConvergence)
  await test(
    '2+3. Subdoc loaded before connect() (A) and after connect() (B)',
    testSubdocLoadedBeforeAndAfterConnect,
  )
  await test('4. Subdoc removal tears down channel on both sides', testSubdocRemoval)
  await test('5. Nested subdoc-of-a-subdoc, structural + end-to-end', testNestedSubdoc)
  await test('6. Rate limiter is shared across every channel', testSharedRateLimiter)
  await test("7. 'synced' event/getter stays root-scoped", testSyncedStaysRootScoped)
  await test('8. destroy() tears down every subdoc channel', testDestroyTearsDownSubdocs)

  console.log(`\n${passCount} passed, ${failCount} failed`)
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
