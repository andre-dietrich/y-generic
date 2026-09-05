# Digest Beacon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every SyncStep1 with a digest beacon (state vector + delete-set hash + JOIN flag) so peers reply only when something differs, presence is answered on join instead of re-announced every tick, and a lost delete is detectable.

**Architecture:** All changes live in `GenericProvider` (`src/index.ts`): a new private message type `MESSAGE_SYNC_DIGEST` (5) is emitted from the single SyncStep1 encoder, decoded in `_dispatchMessage`, and answered by a reply rule (SyncStep2 if the sender is behind or its delete-set hash differs; own beacon as ack on JOIN; nothing otherwise). A cached CRC32 over the normalized delete set closes the state-vector blind spot. The periodic tick shrinks to the beacon alone. Every step is measured before and after with `test/dummy/bench-*.ts` scripts; numbers go into the design doc's Results section.

**Tech Stack:** TypeScript 5, `yjs` 13.6 (`Y.createDeleteSetFromStructStore`, `Y.decodeStateVector`), `y-protocols/sync` (`writeSyncStep2`), `lib0` encoding/decoding, Node 24 for benches (compiled with `tsconfig.bench.json`, run from `bench-dist/`).

**Spec:** `docs/superpowers/specs/2026-09-05-digest-beacon-design.md`

## Global Constraints

- No new runtime dependencies (`package.json` `dependencies` unchanged).
- `Transport` (`src/transport.ts`) is not modified.
- Wire changes only inside this project's private message types; plain `MESSAGE_SYNC` SyncStep1 (type 0, sub 0) must still be accepted and answered exactly as today.
- No automated test runner exists: verification is `npm run build` (must compile), `npx tsc -p tsconfig.bench.json` (must compile), and the named bench scripts with their PASS/RESULT lines.
- Every implementation step records before/after numbers in the design doc's `## Results` section (baseline first). Raw logs go to the session scratchpad, never into the repo.
- Branch: `round-4-phase-1`. One commit per task, message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Bench gate (whole phase, on the final commit): `bench-idle-room` (a) SyncStep2 class at N=50 down ≥ 90 % vs baseline and Awareness class ≤ 2 × `N·(N-1)·10/15`; `bench-idle-room` (b) converges on baseline and after; `bench-packet-loss`, `bench-late-join`, `bench-sync-latency` 3 runs each with zero convergence timeouts; `bench-corruption-storm`, `bench-user-scaling` 1 run each, reported; `bench-periodic-awareness` PASS on all checks.

---

### Task 1: Baseline bench `bench-idle-room.ts` and baseline numbers

**Files:**
- Create: `test/dummy/bench-idle-room.ts`
- Modify: `tsconfig.bench.json` (add the new file to `include`)
- Modify: `.gitignore` (add `bench-dist/`)
- Modify: `test/dummy/bench-corruption-storm.ts:143-158` (`classifyOne`: count type 5 as `syncStep1`)
- Modify: `docs/superpowers/specs/2026-09-05-digest-beacon-design.md` (`## Results` → baseline tables)

**Interfaces:**
- Produces: `bench-idle-room.js` output lines `CENSUS N=<n> ...` and `LOSTDELETE converged=<bool> ms=<n>`; Task 3 re-runs the identical script.

- [ ] **Step 1: Write the bench script (parts a and b)**

```ts
/**
 * Benchmark: what does a fully-synced, completely idle room cost per second,
 * per message class - and does a lost delete-only update still heal?
 *
 * (a) Idle census: N peers connect, one edit, everyone converges, then
 *     nobody does anything for OBSERVE_MS. Every delivery in that window is
 *     protocol overhead by definition. Counted per class (request =
 *     SyncStep1 or digest beacon, SyncStep2, Update, Awareness) per
 *     recipient, via a shadowed DummyHub.broadcast (same convention as
 *     bench-user-scaling.ts's instrumentHub). Floors printed for
 *     comparison: request floor = N*(N-1) per syncInterval (one beacon per
 *     peer per tick is the protocol's minimum), awareness floor = one
 *     y-protocols renewal per peer per 15s (awareness.js: outdatedTimeout/2).
 * (b) Lost delete: two peers; A inserts, both converge; A deletes and the
 *     hub drops A's very next broadcast (batchUpdates=0, so that IS the
 *     delete update). Time until B's text equals A's, capped. The state
 *     vector does not cover deletions, so this is the scenario the
 *     delete-set hash exists for - see
 *     docs/superpowers/specs/2026-09-05-digest-beacon-design.md. On the
 *     pre-change code this heals via B's next empty SyncStep2 cycle (the
 *     reply always carries the full delete set); after the change it must
 *     heal via the dsHash mismatch in B's beacon. Same latency bound
 *     (one syncInterval + reply) either way - this part exists to make
 *     shipping "reply only on difference" WITHOUT the hash impossible.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-idle-room.js
 */

import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const SYNC_INTERVAL_MS = 1000
const LATENCY = 20
const JITTER = 0.25
const SETTLE_MS = 2500
const OBSERVE_MS = 10000
const N_VALUES = [5, 20, 50]
const LOST_DELETE_CAP_MS = 5000

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_SYNC_VERIFIED = 3
const MESSAGE_BATCH = 4
const MESSAGE_SYNC_DIGEST = 5

type Cls = 'request' | 'syncStep2' | 'update' | 'awareness' | 'other'
const CLASSES: Cls[] = ['request', 'syncStep2', 'update', 'awareness', 'other']
type Census = Record<Cls, { count: number; bytes: number }>

function newCensus(): Census {
  const c = {} as Census
  for (const k of CLASSES) c[k] = { count: 0, bytes: 0 }
  return c
}

/** Classify one CRC32-stripped message; recurses into MESSAGE_BATCH. */
function classifyOne(msg: Uint8Array, census: Census, mult: number): void {
  const decoder = decoding.createDecoder(msg)
  const msgType = decoding.readVarUint(decoder)
  if (msgType === MESSAGE_BATCH) {
    while (decoding.hasContent(decoder)) {
      classifyOne(decoding.readVarUint8Array(decoder), census, mult)
    }
    return
  }
  let cls: Cls = 'other'
  if (msgType === MESSAGE_SYNC || msgType === MESSAGE_SYNC_VERIFIED) {
    if (msgType === MESSAGE_SYNC_VERIFIED) {
      decoding.readVarUint(decoder) // seq
      decoding.readVarUint(decoder) // clientID
    }
    const sub = decoding.readVarUint(decoder)
    cls = sub === 0 ? 'request' : sub === 1 ? 'syncStep2' : 'update'
  } else if (msgType === MESSAGE_SYNC_DIGEST) {
    cls = 'request'
  } else if (msgType === MESSAGE_AWARENESS) {
    cls = 'awareness'
  }
  census[cls].count += mult
  census[cls].bytes += msg.length * mult
}

/**
 * Shadow hub.broadcast: count per-recipient deliveries by class while
 * `counting` is on, and swallow exactly one broadcast from `dropNextFrom`
 * (part b's lost delete).
 */
function shadowHub(hub: DummyHub) {
  const state = {
    counting: false,
    deliveries: 0,
    census: newCensus(),
    dropNextFrom: null as DummyTransport | null,
  }
  const original = hub.broadcast.bind(hub)
  ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (
    room: string,
    data: Uint8Array,
    sender: DummyTransport,
    options?: { latency?: number; dropRate?: number; jitter?: number },
  ) => {
    if (state.dropNextFrom === sender) {
      state.dropNextFrom = null
      return
    }
    if (state.counting) {
      const recipients = Math.max(0, hub.getRoomSize(room) - 1)
      state.deliveries += recipients
      if (data.length >= 5) classifyOne(data.subarray(4), state.census, recipients)
    }
    return original(room, data, sender, options)
  }
  return state
}

function makeProvider(hub: DummyHub, doc: Y.Doc, id: number | string): GenericProvider {
  const transport = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
  const provider = new GenericProvider(doc, transport, {
    batchUpdates: 0,
    verifyUpdates: true,
    syncInterval: SYNC_INTERVAL_MS,
    disableBc: true,
  })
  provider.awareness.setLocalStateField('user', { id })
  return provider
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(5)
  }
  return pred()
}

async function runCensus(N: number): Promise<void> {
  await silenced(async () => {
    const room = `bench-idle-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const shadow = shadowHub(hub)
    const docs: Y.Doc[] = []
    const providers: GenericProvider[] = []
    for (let i = 0; i < N; i++) {
      const doc = new Y.Doc()
      docs.push(doc)
      providers.push(makeProvider(hub, doc, i))
    }
    await Promise.all(providers.map((p) => p.connect({ room })))
    docs[0].getText('t').insert(0, 'hello')
    const converged = await waitUntil(
      () =>
        docs.every((d) => d.getText('t').toString() === 'hello') &&
        providers.every((p) => p.synced),
      15000,
    )
    await sleep(SETTLE_MS)

    shadow.counting = true
    await sleep(OBSERVE_MS)
    shadow.counting = false

    for (const p of providers) p.destroy()
    hub.clear()

    const secs = OBSERVE_MS / 1000
    const requestFloor = (N * (N - 1) * OBSERVE_MS) / SYNC_INTERVAL_MS
    const awarenessFloor = (N * (N - 1) * OBSERVE_MS) / 15000
    console.log(
      `CENSUS N=${N} converged=${converged} deliveries=${shadow.deliveries} ` +
        `perSec=${(shadow.deliveries / secs).toFixed(0)} perSecPerPeer=${(shadow.deliveries / secs / N).toFixed(1)} ` +
        `requestFloor=${requestFloor.toFixed(0)} awarenessFloor=${awarenessFloor.toFixed(0)}`,
    )
    for (const k of CLASSES) {
      const c = shadow.census[k]
      console.log(
        `   ${k.padEnd(10)} ${String(c.count).padStart(8)} deliveries ${(c.bytes / 1024).toFixed(1).padStart(8)} KB`,
      )
    }
  })
}

async function runLostDelete(): Promise<void> {
  await silenced(async () => {
    const room = `bench-lostdel-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const shadow = shadowHub(hub)
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = makeProvider(hub, docA, 'A')
    const b = makeProvider(hub, docB, 'B')
    await a.connect({ room })
    await b.connect({ room })

    docA.getText('t').insert(0, 'hello world')
    const synced = await waitUntil(
      () => docB.getText('t').toString() === 'hello world',
      5000,
    )

    // Drop A's very next broadcast - with batchUpdates=0 the delete below
    // is sent synchronously from inside the doc 'update' event, so no
    // timer (beacon, awareness) can interleave between these two lines.
    shadow.dropNextFrom = a.transport as DummyTransport
    docA.getText('t').delete(0, 6)
    const dropped = shadow.dropNextFrom === null

    shadow.counting = true
    const start = Date.now()
    const converged = await waitUntil(
      () => docB.getText('t').toString() === docA.getText('t').toString(),
      LOST_DELETE_CAP_MS,
    )
    const ms = Date.now() - start
    shadow.counting = false

    console.log(
      `LOSTDELETE setup=${synced} dropped=${dropped} converged=${converged} ms=${ms} ` +
        `deliveriesDuringHeal=${shadow.deliveries} A=${JSON.stringify(docA.getText('t').toString())} B=${JSON.stringify(docB.getText('t').toString())}`,
    )

    a.destroy()
    b.destroy()
    hub.clear()
  })
}

async function main() {
  console.log(
    `(a) idle census: syncInterval=${SYNC_INTERVAL_MS}ms latency=${LATENCY}ms±${JITTER * 100}% settle=${SETTLE_MS}ms observe=${OBSERVE_MS}ms\n`,
  )
  for (const N of N_VALUES) await runCensus(N)
  console.log('\n(b) lost delete-only update, 2 peers:\n')
  await runLostDelete()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Register the script and ignore the build output**

In `tsconfig.bench.json`, add `"test/dummy/bench-idle-room.ts",` to the `include` array after `"test/dummy/bench-awareness-removal-burst.ts",`.

In `.gitignore`, append a line `bench-dist/`.

- [ ] **Step 3: Teach `bench-corruption-storm.ts` about type 5**

In `classifyOne` (around line 143), the branch chain currently is `if (msgType === 0 || msgType === 3) {...} else if (msgType === 1) {...} else if (msgType === MESSAGE_BATCH) {...}`. Add before the `msgType === 1` branch:

```ts
  } else if (msgType === 5) {
    // MESSAGE_SYNC_DIGEST (Task 3 of the digest-beacon plan) - the request
    // class, replaces SyncStep1 on the wire; counted as syncStep1 so the
    // SyncStep2/SyncStep1 ratio stays comparable across the change.
    counts.syncStep1++
```

- [ ] **Step 4: Compile and run the new bench on unchanged `src/`**

Run: `npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-idle-room.js`
Expected: three `CENSUS` blocks (`converged=true`), with `syncStep2` and `awareness` each in the thousands at N=50; one `LOSTDELETE ... dropped=true converged=true ms=<≤ ~2100>`.

- [ ] **Step 5: Snapshot a baseline build and run every gate bench on it**

The baseline build must survive later recompiles, so copy it:

```bash
rm -rf bench-dist-baseline && cp -r bench-dist bench-dist-baseline
S=/tmp/claude-1000/-home-andre-Workspace-Projects-Freinet-y-generic/6b50eacd-cb7a-4c91-b173-593ebdf84e7e/scratchpad/baseline
mkdir -p $S
node bench-dist-baseline/test/dummy/bench-idle-room.js            > $S/idle-room.log 2>&1
node bench-dist-baseline/test/dummy/bench-periodic-awareness.js   > $S/periodic-awareness.log 2>&1
for i in 1 2 3; do node bench-dist-baseline/test/dummy/bench-packet-loss.js  > $S/packet-loss-$i.log 2>&1; done
for i in 1 2 3; do node bench-dist-baseline/test/dummy/bench-late-join.js    > $S/late-join-$i.log 2>&1; done
for i in 1 2 3; do node bench-dist-baseline/test/dummy/bench-sync-latency.js > $S/sync-latency-$i.log 2>&1; done
node bench-dist-baseline/test/dummy/bench-corruption-storm.js     > $S/corruption-storm.log 2>&1
node bench-dist-baseline/test/dummy/bench-user-scaling.js         > $S/user-scaling.log 2>&1
grep -h 'RESULT\|PASS\|FAIL\|CENSUS\|LOSTDELETE' $S/*.log
```

Add `bench-dist-baseline/` to `.gitignore` as well (same line style as `bench-dist/`).

Expected: every `RESULT:` line says converged / all combinations; `bench-periodic-awareness` prints two PASS lines (the *old* expectations).

- [ ] **Step 6: Record the baseline in the design doc**

Append under `## Results` in `docs/superpowers/specs/2026-09-05-digest-beacon-design.md`:

```markdown
### Baseline (branch `round-4-phase-1` before any `src/` change, commit <sha of Task 1>)

`bench-idle-room` (a), 10 s window, `syncInterval` 1000 ms:

| N | deliveries | /s | request | syncStep2 | update | awareness |
|---|---|---|---|---|---|---|
| 5 | … | … | … | … | … | … |
| 20 | … | … | … | … | … | … |
| 50 | … | … | … | … | … | … |

`bench-idle-room` (b): converged=…, ms=…

Gate benches (3 runs where stated): packet-loss …/…/… RESULT lines; late-join …; sync-latency …; corruption-storm SyncStep2/SyncStep1 ratio at N=10 …; user-scaling fan-out N=100 messages …; periodic-awareness (old expectations) mesh=0, plain=… awareness sends.
```

Fill every `…` from the logs (copy numbers, do not round beyond what the script prints).

- [ ] **Step 7: Commit**

```bash
git add test/dummy/bench-idle-room.ts tsconfig.bench.json .gitignore test/dummy/bench-corruption-storm.ts docs/superpowers/specs/2026-09-05-digest-beacon-design.md
git commit -m "Add bench-idle-room (idle census + lost-delete) and record phase-1 baseline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `computeDeleteSetHash` + cache (no wire change)

**Files:**
- Modify: `src/index.ts` (module-level function next to `computeDocHash`, ~line 165; new field next to `_compressionThresholdBytes`, ~line 364; invalidation in `_setupDocumentSync`, ~line 1164; new private method next to `_markActivity`, ~line 1138)
- Modify: `test/dummy/bench-idle-room.ts` (part c)

**Interfaces:**
- Produces: `export function computeDeleteSetHash(doc: Y.Doc): number` (unsigned 32-bit CRC32); `private _deleteSetHash(): number` on `GenericProvider` (cached); `private _dsHashCache: number | null`.
- Task 3 consumes `_deleteSetHash()` in the beacon encoder and the beacon handler.

- [ ] **Step 1: Write the failing check (part c of the bench)**

Append to `test/dummy/bench-idle-room.ts` before `async function main()`:

```ts
import { computeDeleteSetHash } from '../../src/index' // add to the import block at the top

/**
 * (c) Delete-set hash properties, no network. Two docs that reach the same
 * logical state through different struct splits (B receives A's inserts as
 * one update, A built them keystroke by keystroke) must hash equal; docs
 * that differ only in a deletion must hash differently; the hash must be
 * stable across a no-op re-encode; a doc with no deletions hashes like an
 * empty doc.
 */
function runHashProperties(): boolean {
  const a = new Y.Doc()
  const ta = a.getText('t')
  for (const ch of 'hello world') ta.insert(ta.length, ch)
  const b = new Y.Doc()
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const noDeletes = computeDeleteSetHash(a) === computeDeleteSetHash(new Y.Doc())

  ta.delete(0, 6) // A deletes 'hello ' - B does not get it
  const differs = computeDeleteSetHash(a) !== computeDeleteSetHash(b)

  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  const equalAfterSync = computeDeleteSetHash(a) === computeDeleteSetHash(b)

  // Two more replicas built from different sources (b's merged state, a's
  // full state) must agree with a: same logical delete set regardless of
  // how the structs were split on arrival.
  const c = new Y.Doc()
  Y.applyUpdate(c, Y.encodeStateAsUpdate(b))
  const e = new Y.Doc()
  Y.applyUpdate(e, Y.encodeStateAsUpdate(a))
  const stable =
    computeDeleteSetHash(e) === computeDeleteSetHash(a) &&
    computeDeleteSetHash(c) === computeDeleteSetHash(a)

  const ok = noDeletes && differs && equalAfterSync && stable
  console.log(
    `HASHPROPS noDeletes=${noDeletes} differs=${differs} equalAfterSync=${equalAfterSync} stable=${stable} => ${ok ? 'PASS' : 'FAIL'}`,
  )
  return ok
}
```

And in `main()`, before the census loop:

```ts
  console.log('(c) delete-set hash properties:\n')
  const hashOk = runHashProperties()
  if (!hashOk) process.exitCode = 1
```

- [ ] **Step 2: Compile to see it fail**

Run: `npx tsc -p tsconfig.bench.json`
Expected: error `Module '"../../src/index"' has no exported member 'computeDeleteSetHash'`.

- [ ] **Step 3: Implement the hash**

In `src/index.ts`, directly after `computeDocHash` (after its closing brace, ~line 172):

```ts
/**
 * Cheap, peer-deterministic hash of the document's delete set - the half of
 * a Yjs document's identity that the state vector does NOT cover (yjs
 * INTERNALS.md: "deletions are tracked in the DeleteSet, and do not update
 * the state vector"). Two docs that differ only by a lost delete-only
 * update have identical state vectors, so `computeDocHash` can never
 * detect that divergence; this hash can, at heartbeat granularity (see
 * `_encodeSyncStep1()` / `_handleDigest()`).
 *
 * Cost: `Y.createDeleteSetFromStructStore` walks every struct (Yjs keeps no
 * incremental delete set), so this is O(items) - fine once per heartbeat
 * (every empty SyncStep2 already did this exact walk inside
 * `encodeStateAsUpdate`), NOT fine per update; hence the cache in
 * `_deleteSetHash()`. Per-client runs come out already sorted and merged;
 * the only per-peer non-determinism is `Map` insertion order, fixed by
 * sorting client IDs before hashing.
 *
 * Exported for the property check in test/dummy/bench-idle-room.ts.
 * @internal
 */
export function computeDeleteSetHash(doc: Y.Doc): number {
  const ds = Y.createDeleteSetFromStructStore(doc.store)
  const encoder = encoding.createEncoder()
  const clients = Array.from(ds.clients.keys()).sort((x, y) => x - y)
  for (const client of clients) {
    encoding.writeVarUint(encoder, client)
    for (const item of ds.clients.get(client)!) {
      encoding.writeVarUint(encoder, item.clock)
      encoding.writeVarUint(encoder, item.len)
    }
  }
  return computeCRC32(encoding.toUint8Array(encoder))
}
```

Add the field, right after `private _compressionThresholdBytes?: number` (~line 364):

```ts
  // Cached computeDeleteSetHash(doc); null = stale. Invalidated on every
  // doc 'update' (deletes are content changes, so this is exact; inserts
  // invalidate needlessly but cheaply). See computeDeleteSetHash's doc for
  // why this must not be recomputed per update.
  private _dsHashCache: number | null = null
```

Add the accessor right after `_markActivity()` (~line 1140):

```ts
  /** Cached delete-set hash - see computeDeleteSetHash(). */
  private _deleteSetHash(): number {
    if (this._dsHashCache === null) {
      this._dsHashCache = computeDeleteSetHash(this.doc)
    }
    return this._dsHashCache
  }
```

In `_setupDocumentSync()`'s handler, as the first statement inside the arrow function (before `this._markActivity()`):

```ts
      this._dsHashCache = null
```

- [ ] **Step 4: Compile both configs and run the check**

Run: `npm run build && npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-idle-room.js 2>&1 | grep -E 'HASHPROPS|LOSTDELETE'`
Expected: `HASHPROPS noDeletes=true differs=true equalAfterSync=true stable=true => PASS` and `LOSTDELETE ... converged=true` (unchanged from baseline - no wire change yet). `npm run build` must exit 0; `_deleteSetHash()` is unused until Task 3, which is fine because `tsconfig.json` does not enable `noUnusedLocals` (check with `grep noUnused tsconfig.json`; if it ever does, Task 3 is the consumer - do Tasks 2 and 3 in one commit rather than adding a dummy use).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/dummy/bench-idle-room.ts
git commit -m "Add cached delete-set hash (computeDeleteSetHash) - closes the state-vector blind spot for lost deletes

No wire change yet; used by the digest beacon in the next commit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Digest beacon, reply rule, JOIN flag, presence on join

**Files:**
- Modify: `src/index.ts` — constants (~line 16), `connect()` (~lines 684-777), `_trySyncPushPull` (~1011), `syncNow` (~1056), `_schedulePeerConnectSync` (~1150), `_dispatchMessage` cases (~1464, ~1551), `_encodeSyncStep1`/`_sendSyncStep1` (~2066-2100)
- Rewrite: `test/dummy/bench-periodic-awareness.ts`
- Modify: `docs/superpowers/specs/2026-09-05-digest-beacon-design.md` (`## Results` → after tables)

**Interfaces:**
- Consumes: `_deleteSetHash()` from Task 2; `_scheduleSyncReply`, `_sendSyncReply`, `_broadcastAwareness`, `_tryImmediateAwarenessMessage`, `_trySyncPushPull`, `_sendBatch`, `_send` (existing).
- Produces: `MESSAGE_SYNC_DIGEST = 5`, `DIGEST_VERSION = 1`, `DIGEST_FLAG_JOIN = 1`; `private _encodeSyncStep1(flags = 0)`; `private _trySyncPushPull(push = true, buildExtra?, flags = 0)`; `private _syncNow(flags)`; `private _handleDigest(decoder)`; `private _replyToSyncRequest(reply)`; `private _markSynced()`.

- [ ] **Step 1: Rewrite `bench-periodic-awareness.ts` to the new expectations (red)**

Replace the whole file with:

```ts
/**
 * Benchmark: does the periodic-sync tick still re-announce awareness (it
 * must not - on ANY transport since the digest beacon), and does a late
 * joiner still learn everyone's presence promptly via the JOIN-flagged
 * beacon instead? See docs/superpowers/specs/2026-09-05-digest-beacon-design.md §5.
 *
 * Part 1: N peers settle, then several syncInterval ticks with no other
 * activity - every MESSAGE_AWARENESS send in that window is periodic
 * re-announce traffic. Checked for both a simulated-onPeerConnect (mesh)
 * config and a plain relay config; expected 0 for both. (Round 3 made the
 * re-announce conditional on onPeerConnect; the digest beacon removes it
 * entirely - y-protocols/awareness's own 15s renewal is the staleness
 * bound, its 30s outdatedTimeout the removal bound.)
 * Part 2: a 6th peer joins a settled 5-peer plain room. It must (i) hold
 * all 5 remote presence states and (ii) be `synced` within
 * awarenessInterval + 3*latency + 200ms of connect() resolving.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-periodic-awareness.js
 */

import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'

const N = 2
const SYNC_INTERVAL_MS = 300
const TICKS_TO_OBSERVE = 4
const LATENCY = 10
const AWARENESS_INTERVAL_MS = 100 // GenericProvider default
const JOIN_ROOM_SIZE = 5
const JOIN_BOUND_MS = AWARENESS_INTERVAL_MS + 3 * LATENCY + 200

const MESSAGE_BATCH = 4
const MESSAGE_SYNC_DIGEST = 5

function classifyOne(msg: Uint8Array, out: { awareness: number; syncStep1: number }): void {
  const decoder = decoding.createDecoder(msg)
  const msgType = decoding.readVarUint(decoder)
  if (msgType === 1) {
    out.awareness++
  } else if (msgType === 0) {
    const subType = decoding.readVarUint(decoder)
    if (subType === 0) out.syncStep1++
  } else if (msgType === MESSAGE_SYNC_DIGEST) {
    out.syncStep1++
  } else if (msgType === MESSAGE_BATCH) {
    while (decoding.hasContent(decoder)) {
      classifyOne(decoding.readVarUint8Array(decoder), out)
    }
  }
}

function classify(wrapped: Uint8Array): { awareness: number; syncStep1: number } {
  const out = { awareness: 0, syncStep1: 0 }
  if (wrapped.length < 5) return out
  classifyOne(wrapped.subarray(4), out)
  return out
}

function withSendClassification(counts: { awareness: number; syncStep1: number }): () => void {
  const original = DummyTransport.prototype.send
  DummyTransport.prototype.send = function (data: Uint8Array) {
    const label = classify(data)
    counts.awareness += label.awareness
    counts.syncStep1 += label.syncStep1
    return original.call(this, data)
  }
  return () => {
    DummyTransport.prototype.send = original
  }
}

function makeProvider(hub: DummyHub, simulatePeerConnect: boolean, id: number | string): GenericProvider {
  const transport = new DummyTransport({ hub, latency: LATENCY, simulatePeerConnect })
  const provider = new GenericProvider(new Y.Doc(), transport, {
    batchUpdates: 0,
    verifyUpdates: true,
    syncInterval: SYNC_INTERVAL_MS,
  })
  provider.awareness.setLocalStateField('user', { id })
  return provider
}

async function runConfig(simulatePeerConnect: boolean): Promise<{ awareness: number; syncStep1: number }> {
  return silenced(async () => {
    const room = `bench-periodic-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const providers: GenericProvider[] = []
    for (let i = 0; i < N; i++) providers.push(makeProvider(hub, simulatePeerConnect, i))

    await Promise.all(providers.map((p) => p.connect({ room })))
    const timeoutAt = Date.now() + 15000
    while (Date.now() < timeoutAt && providers.some((p) => !p.synced)) await sleep(10)
    await sleep(LATENCY * 4 + 200)

    const counts = { awareness: 0, syncStep1: 0 }
    const restore = withSendClassification(counts)
    await sleep(SYNC_INTERVAL_MS * TICKS_TO_OBSERVE + SYNC_INTERVAL_MS / 2)
    restore()

    for (const p of providers) p.destroy()
    hub.clear()
    return counts
  })
}

async function runLateJoiner(): Promise<{ presenceMs: number; states: number; syncedMs: number; synced: boolean }> {
  return silenced(async () => {
    const room = `bench-joiner-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const providers: GenericProvider[] = []
    for (let i = 0; i < JOIN_ROOM_SIZE; i++) providers.push(makeProvider(hub, false, i))
    await Promise.all(providers.map((p) => p.connect({ room })))
    // Settle well past the join burst and at least two periodic ticks.
    await sleep(SYNC_INTERVAL_MS * 3)

    const joiner = makeProvider(hub, false, 'joiner')
    const start = Date.now()
    await joiner.connect({ room })
    const deadline = start + 5000
    let presenceMs = -1
    let syncedMs = -1
    while (Date.now() < deadline && (presenceMs < 0 || syncedMs < 0)) {
      if (presenceMs < 0 && joiner.awareness.getStates().size >= JOIN_ROOM_SIZE + 1) presenceMs = Date.now() - start
      if (syncedMs < 0 && joiner.synced) syncedMs = Date.now() - start
      await sleep(2)
    }
    const out = {
      presenceMs,
      states: joiner.awareness.getStates().size,
      syncedMs,
      synced: joiner.synced,
    }
    joiner.destroy()
    for (const p of providers) p.destroy()
    hub.clear()
    return out
  })
}

async function main() {
  console.log(
    `Part 1: ${N} peers, syncInterval=${SYNC_INTERVAL_MS}ms, observing ~${TICKS_TO_OBSERVE} ticks with no other activity.\n` +
      `Expected periodic request sends: N * ${TICKS_TO_OBSERVE} = ${N * TICKS_TO_OBSERVE}; expected awareness sends: 0 for BOTH configs.\n`,
  )
  const mesh = await runConfig(true)
  const plain = await runConfig(false)
  console.log('config                          | request | awareness')
  console.log(`onPeerConnect (mesh, simulated)  | ${String(mesh.syncStep1).padStart(7)} | ${String(mesh.awareness).padStart(9)}`)
  console.log(`no onPeerConnect (plain relay)   | ${String(plain.syncStep1).padStart(7)} | ${String(plain.awareness).padStart(9)}`)

  const meshOk = mesh.awareness === 0
  const plainOk = plain.awareness === 0
  console.log(meshOk ? '\nPASS: mesh config sent 0 periodic awareness messages.' : `\nFAIL: mesh config sent ${mesh.awareness} periodic awareness messages (expected 0).`)
  console.log(plainOk ? 'PASS: plain config sent 0 periodic awareness messages.' : `FAIL: plain config sent ${plain.awareness} periodic awareness messages (expected 0 - the tick must not re-announce; presence is answered on JOIN).`)

  console.log(`\nPart 2: late joiner into a settled ${JOIN_ROOM_SIZE}-peer plain room, bound ${JOIN_BOUND_MS}ms.\n`)
  const j = await runLateJoiner()
  const presenceOk = j.presenceMs >= 0 && j.presenceMs <= JOIN_BOUND_MS
  const syncedOk = j.synced && j.syncedMs <= JOIN_BOUND_MS
  console.log(`joiner: presence states=${j.states}/${JOIN_ROOM_SIZE + 1} after ${j.presenceMs}ms; synced=${j.synced} after ${j.syncedMs}ms`)
  console.log(presenceOk ? `PASS: joiner saw all ${JOIN_ROOM_SIZE} remote presence states within ${JOIN_BOUND_MS}ms.` : `FAIL: joiner presence took ${j.presenceMs}ms (states=${j.states}), bound ${JOIN_BOUND_MS}ms.`)
  console.log(syncedOk ? `PASS: joiner synced within ${JOIN_BOUND_MS}ms.` : `FAIL: joiner synced=${j.synced} after ${j.syncedMs}ms, bound ${JOIN_BOUND_MS}ms.`)

  process.exit(meshOk && plainOk && presenceOk && syncedOk ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Run it against the current code to see it fail**

Run: `npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-periodic-awareness.js`
Expected: `FAIL: plain config sent <N*ticks> periodic awareness messages`. (Part 2 may pass or fail on the old code depending on tick timing - record what it prints.)

- [ ] **Step 3: Constants and helpers in `src/index.ts`**

After `const MESSAGE_BATCH = 4 ...` (line 16):

```ts
// Digest beacon: replaces SyncStep1 on the wire. [version][flags][sender
// clientID][state vector][delete-set hash]. Receivers reply only when the
// sender is behind them or the delete-set hashes differ (SyncStep2, as
// before), or - on a JOIN-flagged beacon with equal state - with their own
// beacon as an ack; otherwise not at all. See
// docs/superpowers/specs/2026-09-05-digest-beacon-design.md and
// _handleDigest(). Versions are append-only: receivers read the fields
// they know and ignore trailing bytes.
const MESSAGE_SYNC_DIGEST = 5
const DIGEST_VERSION = 1
const DIGEST_FLAG_JOIN = 1 // bit 0: "I just joined - send me your presence and confirm my state"
```

Add two private helpers right after `_cancelPendingSyncReply()` (~line 1727-1733):

```ts
  /**
   * Route a SyncStep2 (or digest-ack) reply through the redundancy
   * suppression when there's genuine redundancy (>= 2 other known peers via
   * awareness - below that there's no "someone else" to rely on), else send
   * immediately. Both paths are rate-limited by `_sendSyncReply()`. Shared
   * by the MESSAGE_SYNC, MESSAGE_SYNC_VERIFIED and MESSAGE_SYNC_DIGEST cases.
   */
  private _replyToSyncRequest(reply: Uint8Array): void {
    if (this.awareness.getStates().size >= 3) {
      this._scheduleSyncReply(reply)
    } else {
      this._sendSyncReply(reply)
    }
  }

  /** Flip `synced` once and emit; idempotent. */
  private _markSynced(): void {
    if (!this._synced) {
      this._synced = true
      this.emit('synced', [true])
    }
  }
```

- [ ] **Step 4: Emit the beacon from the single SyncStep1 encoder**

Replace `_encodeSyncStep1()` (~line 2066) with:

```ts
  /**
   * Encode the digest beacon that replaces SyncStep1 (see
   * MESSAGE_SYNC_DIGEST). Still the one place every "request sync" path
   * goes through (connect()'s syncNow(), the periodic tick,
   * _requestResync()'s retry), so they all switched together.
   */
  private _encodeSyncStep1(flags: number = 0): Uint8Array {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC_DIGEST)
    encoding.writeVarUint(encoder, DIGEST_VERSION)
    encoding.writeVarUint(encoder, flags)
    encoding.writeVarUint(encoder, this.doc.clientID)
    encoding.writeVarUint8Array(encoder, Y.encodeStateVector(this.doc))
    encoding.writeVarUint(encoder, this._deleteSetHash())
    return encoding.toUint8Array(encoder)
  }
```

Replace `_sendSyncStep1(extra?)` (~line 2090) with the parameterless form (the tick no longer folds awareness in):

```ts
  /**
   * Send the periodic digest beacon. Rate limited to prevent spam. Returns
   * whether it actually sent (false means rate-limited).
   */
  private _sendSyncStep1(): boolean {
    if (!this._tryReserveSyncSlot()) {
      console.warn(
        `[GenericProvider] Sync rate limit exceeded (${this._maxSyncRequestsPerWindow} requests per ${this._syncRequestWindowMs / 1000}s), throttling...`,
      )
      return false // Drop the request
    }
    this._send(this._encodeSyncStep1())
    return true
  }
```

`_trySyncPushPull` (~line 1011): add a third parameter and pass it through. Signature becomes

```ts
  private _trySyncPushPull(
    push: boolean = true,
    buildExtra?: () => Uint8Array[],
    flags: number = 0,
  ): boolean {
```

and the line `messages.push(this._encodeSyncStep1())` becomes `messages.push(this._encodeSyncStep1(flags))`. Extend its doc comment with: `@param flags - digest beacon flags (DIGEST_FLAG_JOIN from syncNow(); 0 from the peer-connect debounce and the resync retry, see _syncNow()).`

- [ ] **Step 5: `syncNow()` sets JOIN; internal callers don't**

Replace the `syncNow()` method (~line 1056) so the public method is a thin wrapper:

```ts
  /**
   * Force an immediate sync with remote peers.
   * Useful after network interruptions or to manually trigger re-sync.
   * Sends the beacon with DIGEST_FLAG_JOIN: peers answer with their
   * presence and, if our state already matches theirs, with an ack beacon
   * so `synced` flips without a data round trip.
   */
  syncNow(): void {
    this._syncNow(DIGEST_FLAG_JOIN)
  }

  /**
   * syncNow() body. `flags` = 0 for callers that must NOT request presence:
   * `_schedulePeerConnectSync()` (mesh transports already re-broadcast
   * presence to a newcomer via their own onPeerConnect -> syncNow()).
   */
  private _syncNow(flags: number): void {
    if (!this.transport.isConnected) {
      console.warn('Cannot sync: transport not connected')
      return
    }

    // Try to fold the awareness broadcast into the same wire send as the
    // sync push+pull below. _tryImmediateAwarenessMessage() only returns
    // non-null (and only mutates awareness-throttle state) when the
    // throttle would have let an immediate send through anyway - so this
    // never changes awareness throttle semantics, only whether it travels
    // as its own message or bundled with the sync message going out "now"
    // too. Built inside buildExtra so it's only even attempted once a sync
    // rate-limit slot is confirmed reserved (see _trySyncPushPull's doc).
    let awarenessBatched = false
    const sent = this._trySyncPushPull(
      true,
      () => {
        const msg = this._tryImmediateAwarenessMessage([this.doc.clientID])
        if (msg) {
          awarenessBatched = true
          return [msg]
        }
        return []
      },
      flags,
    )

    // Awareness broadcasting is independently throttled and explicitly NOT
    // gated by the sync rate limiter above - preserve that exactly: it
    // always ends up broadcast one way or another (batched above, or via
    // its own throttled path here), regardless of whether the sync half
    // above was rate-limited.
    if (!sent || !awarenessBatched) {
      this._broadcastAwareness([this.doc.clientID])
    }
  }
```

In `_schedulePeerConnectSync()` (~line 1155) replace `this.syncNow()` with `this._syncNow(0)`.

`_requestResync()`'s retry already calls `this._trySyncPushPull(true, () => {...})` - it now gets `flags = 0` by default; no edit needed there.

- [ ] **Step 6: `connect()` — drop the duplicate awareness broadcast and simplify the tick**

Delete these lines right after `this.syncNow()` (~lines 692-693):

```ts
      // Broadcast local awareness state
      this._broadcastAwareness([this.doc.clientID])
```

and put this comment in their place:

```ts
      // (Local awareness goes out inside syncNow()'s batch, or via its
      // throttled fallback - a second broadcast here was a duplicate 100ms
      // later.)
```

Replace the whole `if (this.transport.isConnected && !this._destroying) { ... }` block inside the tick (~lines 735-771, from the `// Also re-announce awareness` comment through the closing `}` of the `else { this._sendSyncStep1() }`) with:

```ts
            if (this.transport.isConnected && !this._destroying) {
              // Beacon only. Presence is no longer re-announced per tick on
              // any transport: a joiner requests it via DIGEST_FLAG_JOIN
              // (see _handleDigest()), and y-protocols/awareness renews the
              // local state itself every outdatedTimeout/2 = 15s
              // (awareness.js _checkInterval), which the awareness update
              // handler broadcasts. Measured in
              // test/dummy/bench-idle-room.ts: the per-tick re-announce was
              // ~40% of an idle room's deliveries.
              this._sendSyncStep1()
            }
```

Also update the big comment above `if (this._syncInterval > 0)` (~line 695-707): the sentence `// Just request sync without sending full state (avoid redundant broadcasts)` stays; nothing else there refers to awareness.

- [ ] **Step 7: Decode the beacon and apply the reply rule**

In `_dispatchMessage` add a case before `case MESSAGE_SYNC: {` (~line 1464):

```ts
      case MESSAGE_SYNC_DIGEST: {
        this._handleDigest(decoder)
        break
      }
```

In the `MESSAGE_SYNC` case, replace

```ts
          if (!this._synced) {
            this._synced = true
            this.emit('synced', [true])
          }
```

with `this._markSynced()`, and replace the reply block

```ts
        if (encoding.length(encoder) > 1) {
          if (this.awareness.getStates().size >= 3) {
            this._scheduleSyncReply(encoding.toUint8Array(encoder))
          } else {
            this._sendSyncReply(encoding.toUint8Array(encoder))
          }
        }
```

with

```ts
        if (encoding.length(encoder) > 1) {
          this._replyToSyncRequest(encoding.toUint8Array(encoder))
        }
```

Make the same two substitutions in the `MESSAGE_SYNC_VERIFIED` case (its synced block is guarded by `&& localHash === expectedHash` - keep that condition, i.e. `if (syncMessageType === syncProtocol.messageYjsSyncStep2 && localHash === expectedHash) this._markSynced()`).

Add the handler right after `_dispatchMessage()` ends (before `_replySuppressionMaxDelay`):

```ts
  /**
   * Handle a digest beacon (MESSAGE_SYNC_DIGEST). Reply rule (design doc
   * §3): SyncStep2 if the sender is behind us or its delete-set hash
   * differs from ours (the SyncStep2 always carries our full delete set, so
   * it also heals a lost delete on their side - and their beacon does the
   * same for us, symmetrically, within one interval); our own beacon as an
   * ack if the beacon is JOIN-flagged and states are equal; nothing
   * otherwise - which is what removes the ~5 empty replies per heartbeat
   * measured at N=50 in test/dummy/bench-idle-room.ts. "Sender is ahead of
   * us" triggers no reply: our own next beacon fetches it. Nothing here
   * removes a recovery path (the round-2 lesson in
   * 2026-09-04-resync-message-reduction-design.md's addendum), only
   * replies that carry no information.
   *
   * `synced`: a beacon we are not behind, with equal delete-set hash, is a
   * stronger statement than the empty SyncStep2 it replaces ("you lack
   * nothing I have"), so it marks us synced too - this is what keeps two
   * fresh peers, or a whole concurrent join burst, converging to `synced`
   * with no acks needing to survive the rate limiter.
   */
  private _handleDigest(decoder: decoding.Decoder): void {
    decoding.readVarUint(decoder) // DIGEST_VERSION - append-only, nothing to branch on yet
    const flags = decoding.readVarUint(decoder)
    decoding.readVarUint(decoder) // sender clientID - reserved for unicast replies (round-4 research item 6)
    const remoteSv = decoding.readVarUint8Array(decoder)
    const remoteDsHash = decoding.readVarUint(decoder)
    // Any trailing bytes belong to a newer version; ignored by design.

    const remote = Y.decodeStateVector(remoteSv)
    const local = Y.decodeStateVector(Y.encodeStateVector(this.doc))
    let senderBehind = false
    for (const [client, clock] of local) {
      if ((remote.get(client) ?? 0) < clock) {
        senderBehind = true
        break
      }
    }
    let weBehind = false
    for (const [client, clock] of remote) {
      if ((local.get(client) ?? 0) < clock) {
        weBehind = true
        break
      }
    }
    const dsEqual = remoteDsHash === this._deleteSetHash()

    if (senderBehind || !dsEqual) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeSyncStep2(encoder, this.doc, remoteSv)
      this._replyToSyncRequest(encoding.toUint8Array(encoder))
    } else if (flags & DIGEST_FLAG_JOIN) {
      this._replyToSyncRequest(this._encodeSyncStep1(0))
    }

    if (!weBehind && dsEqual) {
      this._markSynced()
    }

    if (flags & DIGEST_FLAG_JOIN && this.awareness.getLocalState() !== null) {
      // Presence on demand: the joiner asked. Throttled like every other
      // awareness broadcast, never suppressed (each responder's state is
      // distinct). Skipped when we have no state to announce.
      this._broadcastAwareness([this.doc.clientID])
    }
  }
```

- [ ] **Step 8: Compile both configs**

Run: `npm run build && npx tsc -p tsconfig.bench.json`
Expected: both exit 0. If `tsc` reports `_tryImmediateAwarenessMessage` or `_sendBatch` as unused: they are still used by `_syncNow()` / `_trySyncPushPull()`; if `noUnusedLocals` were on it would flag nothing here.

- [ ] **Step 9: Run the two direct benches**

Run: `node bench-dist/test/dummy/bench-periodic-awareness.js`
Expected: four PASS lines, exit 0.

Run: `node bench-dist/test/dummy/bench-idle-room.js`
Expected: `HASHPROPS ... PASS`; `CENSUS N=50` with `syncStep2` ≤ 10 % of the baseline value recorded in Task 1 and `awareness` ≤ 2 × `awarenessFloor`; `LOSTDELETE ... dropped=true converged=true ms=<≤ ~2100>`.

If `LOSTDELETE converged=false`: the dsHash path is broken - check `_dsHashCache` invalidation (Task 2 Step 3) and that `_handleDigest` compares `remoteDsHash === this._deleteSetHash()` as numbers (both unsigned via `>>> 0` in `computeCRC32`).

- [ ] **Step 10: Run the gate benches (after)**

```bash
S=/tmp/claude-1000/-home-andre-Workspace-Projects-Freinet-y-generic/6b50eacd-cb7a-4c91-b173-593ebdf84e7e/scratchpad/after
mkdir -p $S
node bench-dist/test/dummy/bench-idle-room.js            > $S/idle-room.log 2>&1
node bench-dist/test/dummy/bench-periodic-awareness.js   > $S/periodic-awareness.log 2>&1
for i in 1 2 3; do node bench-dist/test/dummy/bench-packet-loss.js  > $S/packet-loss-$i.log 2>&1; done
for i in 1 2 3; do node bench-dist/test/dummy/bench-late-join.js    > $S/late-join-$i.log 2>&1; done
for i in 1 2 3; do node bench-dist/test/dummy/bench-sync-latency.js > $S/sync-latency-$i.log 2>&1; done
node bench-dist/test/dummy/bench-corruption-storm.js     > $S/corruption-storm.log 2>&1
node bench-dist/test/dummy/bench-user-scaling.js         > $S/user-scaling.log 2>&1
grep -h 'RESULT\|PASS\|FAIL\|CENSUS\|LOSTDELETE' $S/*.log
```

Expected: every `RESULT:` line converged (zero timeouts in all 3 packet-loss / late-join / sync-latency runs). If any run times out, stop, do not commit, and write the finding into the design doc's Results as a failed gate - the next step is analysis, not tuning.

- [ ] **Step 11: Record after-numbers next to the baseline**

In the design doc's `## Results`, add `### After Task 3 (commit <sha>)` with the same table shapes as the baseline plus a `Δ` column (after/baseline as a percentage) for the census classes, and the gate lines. Also note the `bench-corruption-storm` SyncStep2/SyncStep1 ratio and `bench-user-scaling` join-burst message counts vs baseline (the ack beacons change the join path: report, do not gate).

- [ ] **Step 12: Commit**

```bash
git add src/index.ts test/dummy/bench-periodic-awareness.ts docs/superpowers/specs/2026-09-05-digest-beacon-design.md
git commit -m "Replace SyncStep1 with a digest beacon: reply only on difference, delete-set hash, presence on join

Every request now carries the state vector plus a delete-set hash. Peers
answer with SyncStep2 only when the requester is behind them or the
delete-set hashes differ, with an ack beacon on a JOIN-flagged request
with equal state, and not at all otherwise. Presence is answered on JOIN
instead of re-announced every periodic tick. synced also flips on a
received beacon we are not behind.

Measured in test/dummy/bench-idle-room.ts (numbers in the design doc).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: README notes

**Files:**
- Modify: `README.md` (near the existing `compressionThresholdBytes` / options documentation, and the IndexedDB section around line 288)

**Interfaces:** none.

- [ ] **Step 1: Find the anchors**

Run: `grep -n 'compressionThresholdBytes\|IndexedDBTransport\|syncInterval' README.md | head`

- [ ] **Step 2: Add the compatibility note**

Directly after the paragraph that documents `compressionThresholdBytes` (or, if the README has no such paragraph, at the end of the options section), add:

```markdown
> **Wire compatibility.** All peers in a room must run the same version of
> this library. Sync requests travel as a private digest message (state
> vector + delete-set hash), and several messages are batched into one
> envelope; an older peer drops both unread. This has been the case since
> message batching landed and is not new to the digest format.
```

- [ ] **Step 3: Add the persistence-first note**

In the IndexedDB section, after the sentence that describes `IndexedDBTransport` as local persistence, add:

```markdown
When you combine a persistence provider with a network provider on the
same `Y.Doc`, connect the persistence provider first and wait for its
`synced` event before calling `connect()` on the network provider. The
network provider's first request then carries your real state vector and
the reply is only the tail you are missing, instead of the whole document.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: wire-compatibility note for the digest beacon, persistence-first guidance

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review against the spec

- §1 wire → Task 3 Steps 3-4. §2 delete-set hash → Task 2. §3 reply rule → Task 3 Step 7. §4 synced → Task 3 Steps 3, 7 (`_markSynced`, digest rule). §5 JOIN flag, presence, tick, connect cleanup → Task 3 Steps 5-7. §6 compatibility → Task 4. Dropped items → no task, by design. Benchmarks and gates → Task 1 (baseline, new script, classifier), Task 3 Steps 1, 9-11. Work-item order → Tasks 1-4.
- Names used consistently: `computeDeleteSetHash`, `_deleteSetHash()`, `_dsHashCache`, `MESSAGE_SYNC_DIGEST`, `DIGEST_VERSION`, `DIGEST_FLAG_JOIN`, `_encodeSyncStep1(flags)`, `_trySyncPushPull(push, buildExtra, flags)`, `_syncNow(flags)`, `_handleDigest`, `_replyToSyncRequest`, `_markSynced`.
