# LiaScript: rebuild `DexieTransport` on y-generic 1.5.0's `extractDocUpdates()` / `frameDocUpdate()`

Handoff for whoever (human or AI) implements this in the LiaScript
repository (`liascript2`, checked against commit `392067f1`). Everything
needed is in this file; the y-generic side shipped on 2026-09-07 as
v1.5.0 (`main` @ `dca70cc`, tag `v1.5.0`). Read the whole document before
touching code - the ordering rules in "Target design" are what make it
safe.

## TL;DR

1. Upgrade the `y-generic` dependency from the pinned commit `2250550`
   (2026-09-04, 102 commits behind) to v1.5.0.
2. Replace the body of `src/typescript/sync/Base/dexieTransport.ts`:
   `send()` stores `frameDocUpdate(Y.mergeUpdates(extractDocUpdates(frame)))`
   and nothing when the frame carries no document update; `connect()` reads
   every row, merges them with `extractDocUpdates`, writes the merged frame
   back as the single row **before** handing it to the provider, then
   delivers it once. Delete `carriesDocumentState()`, `readVarUint()` and
   the `armCompaction()` latch.
3. Optionally give the browser connector one atomic
   `compactYjsUpdates()` method (read + merge + replace in one Dexie `rw`
   transaction) so a concurrent write can never be cleared away.
4. Optionally pass `waitFor: this.persistReady` to the network provider's
   `connect()` (y-generic round 5, item 7) so a page load no longer pushes
   the whole locally stored document to the room.
5. Verify in DevTools (Application → IndexedDB → the course database →
   `yjsUpdates`): one row per keystroke of ~20-40 bytes instead of
   ~130-300, two rows after a reload, content intact, no phantom peer.

## Background: what a y-generic transport is handed

`GenericProvider` (y-generic) speaks its whole protocol through
`Transport.send(frame)`, and a persistence transport receives every frame
the provider would send to a room. A frame is `[4 bytes CRC32][varUint
message type][...]`. The types, and whether they carry document state:

| type | name | carries document state? | payload after the type byte |
|---|---|---|---|
| 0 | `MESSAGE_SYNC` | only sub-types 1 and 2 | y-protocols sync sub-message: `0` SyncStep1 (a state vector - a request, no data), `1` SyncStep2 (an update), `2` Update (an update) |
| 1 | `MESSAGE_AWARENESS` | no | presence (cursors, names) |
| 2 | `MESSAGE_PUBSUB` | no | ephemeral pub/sub |
| 3 | `MESSAGE_SYNC_VERIFIED` | yes | `[seq][sender clientID][sync sub-message][doc hash]` |
| 4 | `MESSAGE_BATCH` | whatever its parts carry | N length-prefixed sub-frames (no CRC each) - since y-generic round 5 **every keystroke** is a batch of its update plus the piggybacked cursor awareness |
| 5 | `MESSAGE_SYNC_DIGEST` | no | the periodic beacon: state vector, delete-set hash, flags |
| 6 | `MESSAGE_SYNC_PUSH` | yes | the whole document as one update (sent once per `connect()`) |

Everything that is not document state is the provider's conversation with
the room. A persistence transport is not the room: stored and replayed on
the next page load, a presence frame resurrects the previous session's
clientID as a peer that never leaves, and a digest beacon makes the
provider *answer* the request of its own past self - into the store, which
multiplies rows on every load. y-generic's own IndexedDB transport had
exactly this design until round 7; `docs/superpowers/specs/2026-09-07-sync-optimization-round-7.md`
(item 6) has the numbers, `src/providers/indexeddb/index.ts` is the
rebuilt reference implementation.

## What LiaScript's `DexieTransport` does today (`src/typescript/sync/Base/dexieTransport.ts`)

- `carriesDocumentState()` (L71-87) drops types 1 and 2 and
  `MESSAGE_SYNC` SyncStep1, and **keeps every other type** - including
  `MESSAGE_BATCH` (4) and `MESSAGE_SYNC_DIGEST` (5) - stored as whole
  frames via `Database.appendYjsUpdate()` (L175-189).
  - A keystroke row therefore contains the cursor JSON that rode along in
    the batch: ~130-300 bytes per row for a 15-byte update.
  - Every beacon becomes a row, and on the next load it is replayed into
    the provider, which answers it (a SyncStep2 or an ack) - and that
    answer is stored again. The file's own comment documents the effect:
    "30 -> 81 -> 171 -> 239 rows for a document that contained a single
    chat message".
  - The presence inside every replayed batch is applied: the previous
    session's clientID shows up in `awareness.getStates()` and in the
    provider's peer table until its lease expires (30 s), and with
    y-generic 1.4.0+'s `awarenessInterval: 'auto'` it would count toward
    the cursor throttle.
- The compaction latch `armCompaction()` (L149-155) assumes that the
  first frame the provider sends after the replay is a full snapshot that
  supersedes every replayed row. Since y-generic round 4/5 that first send
  is a **batch** of `[MESSAGE_SYNC_PUSH, MESSAGE_SYNC_DIGEST, awareness]`
  - so the "snapshot row" also carries a beacon and presence, replayed on
  every load. The comment already calls the latch fragile ("safe *only* at
  this exact point").
- Nothing is wrong with the Dexie side: `yjsUpdates` (`++id, key`, schema
  version 2, `src/typescript/connectors/Browser/database.ts` L65) with
  rows `{ key, data: Uint8Array, created }` and the four functions
  `getYjsUpdates` / `appendYjsUpdate` / `replaceYjsUpdates` /
  `clearYjsUpdates` (L539-588, facade in
  `src/typescript/liascript/service/Database.ts` L310-341) stay as they
  are. Only *what* is written changes.

Measured in y-generic with the same design (its IndexedDB transport,
`test/dummy/bench-persist-log.ts`, 1,000 keystrokes with a cursor change
each): 1,015 rows / 124.7 KB, a presence entry and a known peer of the
previous session after reload, and the old lossy `compact()` emptied the
document. After the rebuild: 3 rows / 9.7 KB (−92 %), no phantom, content
intact, and a log written by the old code still loads.

## The two exports (y-generic ≥ 1.5.0, package root)

```typescript
import { extractDocUpdates, frameDocUpdate } from 'y-generic'
```

(`y-generic` is the alias liascript2's `package.json` gives the GitHub
dependency; the package root resolves to `dist/lib.js`, which re-exports
both. `dexieTransport.ts` currently imports only types from `y-generic` to
keep the eager bundle small - this runtime import costs nothing extra:
`sync/Base/index.ts` already imports `GenericProvider` from the same root,
so the core is in that chunk anyway. `sync/Base/persist.ts` must stay
dependency-free as its header says; it is not touched.)

`extractDocUpdates(frame: Uint8Array): Uint8Array[]` - the Yjs updates a
CRC-wrapped frame carries: the update of a `MESSAGE_SYNC_VERIFIED` or a
`MESSAGE_SYNC` SyncStep2/Update, the document of a `MESSAGE_SYNC_PUSH`,
each such part of a `MESSAGE_BATCH` (recursively); `[]` for awareness,
pub/sub, digests, SyncStep1 - and `[]` for anything it cannot parse, never
a partial read. The returned arrays are views into `frame`; do not store
them without copying (`Y.mergeUpdates` and `frameDocUpdate` both copy).

`frameDocUpdate(update: Uint8Array): Uint8Array` - wraps one update as a
CRC-wrapped `MESSAGE_SYNC` **SyncStep2** frame. Handed to the `onMessage`
callback, the provider applies it under its own origin (so it never comes
back through `send()`), treats it as the answer to its own request -
`synced` fires on that provider, its join retries stop - and sends nothing
back. This is what a local copy is: the peer that already had our
document.

Two properties the design below relies on:

- `extractDocUpdates(frameDocUpdate(u))` is `[u]`. So rows can stay
  **frames** - the rows written by today's code and the rows written by
  the new code are parsed by the same call, no schema change, no row flag,
  no migration.
- `extractDocUpdates(rawUpdateBytes)` is `[]`. So **never** store a bare
  update: the loader would drop it. Always store `frameDocUpdate(...)`.

Caveat: a provider constructed with `compressionThresholdBytes` (or a
transport with `preferredCompressMinBytes`) prefixes every frame with a
flag byte; `extractDocUpdates` does not handle that. The persistence
provider in LiaScript has neither, so this does not apply - keep it that
way.

## Target design

Row format: unchanged (`{ key, data, created }`), `data` = one CRC-wrapped
frame. New rows are `frameDocUpdate(update)` frames (~7 bytes over the
update). Old rows (whole frames of any type) are read by the same loader.

Ordering rule that keeps data safe: the **trim happens before the delivery**.
`connect()` reads the rows, merges, writes the merged frame back as the
one row, and only then hands the frame to the provider. If the delivery
came first, an edit made from a `synced` handler would be appended
between the read and the replace and then deleted by the replace.

### `src/typescript/sync/Base/dexieTransport.ts` (complete replacement)

```typescript
import type { Transport, ConnectionConfig } from 'y-generic'
import { extractDocUpdates, frameDocUpdate } from 'y-generic'
import * as Y from 'yjs'
import Database from '../../liascript/service/Database'

/** A Yjs transport that persists the document inside the already-open,
 * already-approved per-course Dexie database (see `sync/Base/persist.ts`
 * for why not a raw IndexedDB database of its own).
 *
 * It is handed every frame `GenericProvider` sends and stores only what
 * carries document state: `extractDocUpdates()` (y-generic) yields the Yjs
 * updates of a frame - none for presence, beacons and requests - and
 * `frameDocUpdate()` wraps an update as the SyncStep2 frame the provider
 * applies on load. Rows are such frames, so rows written by the earlier
 * version of this transport (whole provider frames of any type) load the
 * same way. Each `connect()` merges every row into one and writes it back
 * before the document is handed to the provider, so the log holds one
 * document plus the updates since - never the previous session's presence
 * or beacons (which used to come back as phantom peers, and were answered
 * into the store again: 30 -> 81 -> 171 -> 239 rows).
 */
export class DexieTransport implements Transport {
  private uidDB: string = ''
  private key: string = ''
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false

  // The merged stored document, framed, waiting until both `connect()` has
  // loaded it and `onMessage()` has attached a listener - whichever comes
  // second delivers it (`GenericProvider.connect()` calls `onMessage()`
  // before `transport.connect()`, but do not rely on the order).
  private pending: Uint8Array | null = null
  private replayed: boolean = false

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.uidDB = config.uidDB
    this.key = config.room

    const rows = await Database.getYjsUpdates(this.uidDB, this.key)
    const updates = rows.flatMap((row) => extractDocUpdates(row))

    if (updates.length === 0) {
      // Nothing (or only presence/beacon rows of the old format) - drop them.
      if (rows.length > 0) await Database.clearYjsUpdates(this.uidDB, this.key)
      this.pending = null
    } else {
      this.pending = frameDocUpdate(Y.mergeUpdates(updates))
      // Trim to one row BEFORE anything can be appended: every connect()
      // of the provider adds a full-document push, so the log would grow by
      // one document per page load otherwise. A single row in the new
      // format is left alone.
      if (rows.length !== 1 || !sameBytes(rows[0], this.pending)) {
        await Database.replaceYjsUpdates(this.uidDB, this.key, this.pending)
      }
    }

    this._isConnected = true
    this.replayIfReady()
  }

  disconnect(): void {
    this._isConnected = false
    this.messageCallback = undefined
    this.pending = null
    this.replayed = false
  }

  send(data: Uint8Array): void | Promise<void> {
    const updates = extractDocUpdates(data)
    if (updates.length === 0) return // presence, beacon, request: not ours to keep
    return Database.appendYjsUpdate(
      this.uidDB,
      this.key,
      frameDocUpdate(updates.length === 1 ? updates[0] : Y.mergeUpdates(updates)),
    )
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback
    this.replayIfReady()
    return () => {
      this.messageCallback = undefined
    }
  }

  /** Hand the merged document to the provider exactly once per connect(). */
  private replayIfReady(): void {
    if (this.replayed || !this._isConnected || !this.messageCallback) return
    this.replayed = true
    const frame = this.pending
    this.pending = null
    if (frame) this.messageCallback(frame)
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
```

Notes on the code:

- `Y.mergeUpdates` on one update re-encodes it; on many it folds
  consecutive inserts of one client into one struct - that is where most
  of the −92 % comes from, not the CRC.
- `sameBytes` is a byte compare on a document-sized frame once per page
  load; it only exists to skip a redundant rewrite. Dropping it and
  always rewriting when `rows.length > 0` is also fine.
- `Database.getYjsUpdates()` returns `Uint8Array[]` and, when no
  connector is registered, `[]` - the transport then simply has nothing
  and stores nothing (as today).
- The two-sided `replayIfReady()` is kept from the current file; the
  `armCompaction()` latch, `carriesDocumentState()` and `readVarUint()` are
  gone.
- `send()` may return the Dexie promise as before; `GenericProvider`
  tolerates a sync or async `send`.

### Optional: an atomic trim in the connector

`connect()` above reads in one transaction and replaces in another.
Between the two only the provider that is not yet connected could write -
it cannot, `send()` is only called while `transport.isConnected` is true.
The remaining window is a **second tab** of the same course and room
appending a row between this tab's read and replace; that row is cleared,
though its content is not lost to the document (both tabs hold it, and
every `connect()` pushes the whole document into the store). Today's code
has the same window. To close it, add to
`src/typescript/connectors/Browser/database.ts` (next to
`replaceYjsUpdates`, L570):

```typescript
  /** Read every row of `key`, hand the data to `merge`, and replace the rows
   * with its result - in one transaction, so a concurrent append is either
   * included or queued behind. Returns what `merge` returned. */
  async compactYjsUpdates(
    uidDB: string,
    key: string,
    merge: (rows: Uint8Array[]) => Uint8Array | null,
  ): Promise<Uint8Array | null> {
    const db = await this.openShared_(uidDB)
    return db.transaction('rw', db['yjsUpdates'], async () => {
      const rows = await db['yjsUpdates'].where('key').equals(key).toArray()
      const merged = merge(rows.map((row: { data: Uint8Array }) => row.data))
      if (rows.length === 0) return merged
      await db['yjsUpdates'].where('key').equals(key).delete()
      if (merged) await db['yjsUpdates'].add({ key, data: merged, created: new Date().getTime() })
      return merged
    })
  }
```

plus the pass-through in `src/typescript/liascript/service/Database.ts`
(same shape as `replaceYjsUpdates`, returning `null` without a connector).
`connect()` then becomes:

```typescript
    this.pending = await Database.compactYjsUpdates(this.uidDB, this.key, (rows) => {
      const updates = rows.flatMap((row) => extractDocUpdates(row))
      return updates.length === 0 ? null : frameDocUpdate(Y.mergeUpdates(updates))
    })
```

(`merge` must stay synchronous - Dexie transactions do not survive
`await`s on non-Dexie promises; `extractDocUpdates`, `Y.mergeUpdates` and
`frameDocUpdate` are all synchronous.)

## Step 0: the y-generic upgrade

`package-lock.json` resolves `y-generic` to `2250550` (2026-09-04, "fix:
resync retry silently dropped ..."), 102 commits before v1.5.0 and before
the two exports exist. Once the tag is pushed
(`git push origin main --tags` in y-generic):

```
npm install y-generic@github:andre-dietrich/y-generic#v1.5.0
```

(or `#dca70cc`). `node_modules/y-generic/dist/lib.d.ts` must then declare
`extractDocUpdates` and `frameDocUpdate`. What else changes between the
pinned commit and v1.5.0 that LiaScript should know:

- **Wire format.** Rounds 4 and 5 changed the sync protocol (digest
  beacons, batches, push messages, presence leases); "every peer of a room
  must run this version". LiaScript ships y-generic inside its own bundle,
  so all classroom peers upgrade together - but a LiaScript build on
  v1.5.0 will not sync with a build on the pinned commit.
- **The encryption wrapper** (`sync/Base/security.ts`,
  `wrapTransport(transport, password, stripHeaderBytes)`) pads/strips the
  4-byte CRC for WebSocket and Ably. That still holds: neither transport
  sets `preferredCompressMinBytes`, so no flag byte appears in front of
  the CRC. PubNub sets the hint (compression above 2 KB, a leading flag
  byte on every frame) but LiaScript uses it without the wrapper. Keep it
  that way; if a wrapper is ever put in front of PubNub, Matrix or Nostr,
  the flag byte comes first.
- **Presence lease.** Transports without a leave signal (Gun, WebSocket)
  drop a silent peer after `awarenessTimeoutMs` (default 30 s) and renew
  presence every lease/2. y-generic's own playgrounds use
  `awarenessTimeoutMs: 120000` on those transports (round 5's decision:
  −74 % idle traffic at N=50). Consider passing the same in
  `new GenericProvider(this.db.doc, transport, { awarenessTimeoutMs: 120000 })`
  for the Gun and WebSocket backends. Supabase, Ably, PubNub with the
  presence add-on and the mesh transports report departures themselves
  and default to 5 min.
- **Timers.** `disconnect()` now clears the presence sweep timer (v1.5.0,
  item 2), so `Base.destroy()`'s `persistProvider?.disconnect()` no longer
  leaks a provider per classroom section. Prefer `destroy()` when the
  provider is not reused, it also detaches the doc listeners.
- **`synced`** fires on the persistence provider once the stored document
  is applied. Nothing in LiaScript listens on that provider today; it is
  harmless.

## Optional step 2: `waitFor` instead of waiting

Today `Base.connect()` starts the persistence provider and the backends
wait for `persistReady` (or `Base.connect()` L381 does) before the
network provider says anything, so the local copy is loaded first. The
network provider's own `connect()` then pushes the **whole loaded
document** to the room (`MESSAGE_SYNC_PUSH`: a fresh provider has no
confirmed state). Round 5, item 7 added `connect({ waitFor })` for exactly
this pairing (`ConnectionConfig.waitFor` in y-generic's
`src/transport.ts`): the network provider connects its transport, awaits
the promise, treats the doc updates produced meanwhile as the load (not
broadcast) and the loaded state as confirmed by the room, then sends its
first beacon - the beacon reconciles both directions. Measured there: a
50 KB local copy cost the room a 50 KB push per page load; with `waitFor`
0.1 KB. In each network backend's `this.provider.connect({...})` add
`waitFor: this.persistReady`. The `Local` backend has no network provider
and keeps waiting on `persistReady` as it does.

## Verification

1. **Rows and bytes.** Open a persistent classroom, type ~20 characters,
   then DevTools → Application → IndexedDB → the course database →
   `yjsUpdates`, filter by the room's key: one row per keystroke (or per
   batch of quick keystrokes) of ~20-40 bytes, plus the connect-time push
   row. Before the change: ~130-300 bytes per row and a row per beacon
   while idle.
2. **Reload.** Content intact; the table holds 2 rows (the merged document
   and the new push). In the console of the page:
   `provider.awareness.getStates().size` of the persistence provider is 1
   (only this tab), and `(persistProvider as any)._knownPeers.size` is 0 -
   before the change both showed the previous session.
3. **Old rows.** With a classroom that has local data written by the
   current LiaScript build, upgrade and reload: content intact, and the
   old rows collapse to one on that load (they are parsed by the same
   `extractDocUpdates`).
4. **Idle.** Leave the tab open for two minutes without typing: no new
   rows (beacons and presence renewals are not stored).
5. **Automated (optional).** y-generic's `test/dummy/bench-persist-log.ts`
   is the template: `npm install --no-save fake-indexeddb`, run a provider
   against the transport for N keystrokes, reopen, compare
   `doc.getText(...).toString()` and the row count; a Dexie-backed version
   only needs `fake-indexeddb/auto` before Dexie is imported.

## Pitfalls

- Never store a bare update: `extractDocUpdates(rawUpdate)` is `[]` and
  the loader would drop it. Every stored row is a `frameDocUpdate(...)`
  frame (or an old whole frame).
- Trim before delivery (see "Ordering rule"); with the atomic connector
  method this is automatic.
- Do not feed rows through `extractDocUpdates` while a `compressionThresholdBytes`
  provider writes them (flag byte). The persistence provider has none.
- `Y.mergeUpdates([])` is never called: the `updates.length === 0` branch
  handles an empty or presence-only log.
- Keep `sync/Base/persist.ts` free of runtime imports (it is loaded
  eagerly); the two imports live in `dexieTransport.ts` only.
- Multi-tab: two tabs on the same course and room share the key; the
  non-atomic `connect()` has the same small clear-between-read-and-replace
  window today's code has, the atomic variant removes it.

## References (y-generic, `main` @ `dca70cc`)

- `src/index.ts` - `extractDocUpdates`, `frameDocUpdate` (with their doc
  comments) next to `computeDeleteSetHash`; the `MESSAGE_*` constants at
  the top of the file.
- `src/providers/indexeddb/index.ts` - the reference transport
  (`send()`, `mergeStore()`, `loadUpdates()`, `compact()`).
- `src/transport.ts` - `ConnectionConfig.waitFor`.
- `docs/superpowers/specs/2026-09-07-sync-optimization-round-7.md`,
  item 6 - the measurements; `test/dummy/bench-persist-log.ts` - the bench.
- `README.md`, "Persistence Transports".
