# Digest beacon: reply only on difference, delete-set hash, presence on join — design

## Goal

Cut the steady-state traffic of a synced room to the protocol's information
content, and close the verification hole for lost deletions, without
changing the `Transport` interface. This is "Phase 1" of the round-4
research (`2026-09-05-sync-optimization-round-4-research.md`, items 1, 2, 3;
items 4 and 11 explicitly dropped/reduced below).

## Context (measured on `main` @ `e2cf824`, see the research doc)

Idle room, N=50, `syncInterval` scaled to 1 s: ~6,000 deliveries/s of which
~60% are SyncStep2 replies carrying 5 bytes of nothing and ~40% are
awareness re-announces that duplicate `y-protocols/awareness`'s own 15 s
renewal. Every SyncStep1 is answered by ~5 peers even after two rounds of
reply suppression.

`computeDocHash` hashes the state vector. Deletions do not touch the state
vector. Two docs that differ only in a lost delete have identical hashes
forever; today only the empty periodic SyncStep2 (which always carries the
full delete set) heals this, by accident.

Three facts checked against `node_modules` that shape the design:

1. Yjs keeps no incremental delete set; `Y.snapshot(doc).ds` walks every
   struct (O(items)). A delete-set hash per update is unaffordable; per
   heartbeat it is *cheaper* than today, because every empty SyncStep2
   already does that same walk inside `encodeStateAsUpdate`.
2. `synced` is set only on receiving a SyncStep2. If replies stop when
   states are equal, two fresh peers would never become `synced`.
3. A presence handshake keyed on the awareness `added` event fails for a
   joiner with no local awareness state (a pure viewer): nothing is added,
   nobody answers.

## Design

### 1. Wire: `MESSAGE_SYNC_DIGEST` (type 5) replaces every SyncStep1

```
writeVarUint(5)                       // MESSAGE_SYNC_DIGEST
writeVarUint(1)                       // DIGEST_VERSION, append-only
writeVarUint(flags)                   // bit 0: DIGEST_FLAG_JOIN
writeVarUint(doc.clientID)            // sender
writeVarUint8Array(encodeStateVector) // as SyncStep1 today
writeVarUint(dsHash)                  // CRC32 of the normalized delete set
```

Emitted from the one place that encodes SyncStep1 today
(`_encodeSyncStep1`), so `connect()`'s `syncNow()`, the periodic tick and
`_requestResync()`'s retry all switch at once. Receivers read the fields
they know and ignore trailing bytes; future versions may only append.

Plain `MESSAGE_SYNC`/SyncStep1 is still *accepted* (unchanged code path,
always replies) but no longer sent.

Rejected: embedding SyncStep1 in `MESSAGE_SYNC_VERIFIED` (type 3) — that
envelope carries a per-sender sequence number, so a lost heartbeat would
register as a sequence gap and trigger resyncs. A separate digest message
next to a plain SyncStep1 doubles the message count.

### 2. Delete-set hash

```ts
function computeDeleteSetHash(doc): number
  ds = Y.snapshot(doc).ds                  // Map<client, DeleteItem[]>
  for client of sorted(ds.clients.keys()): // Map order is per-peer; sort
    writeVarUint(client)
    for {clock, len} of ds.clients.get(client): writeVarUint(clock); writeVarUint(len)
  return computeCRC32(bytes)
```

Per-client runs come out of `createDeleteSetFromStructStore` already sorted
and merged (adjacent deleted structs collapse into one run), so the only
non-determinism across peers is `Map` insertion order, fixed by sorting.
Cached in `_dsHashCache`, invalidated in the existing doc `'update'`
handler (fires for local and remote content changes; deletes are content
changes). Computed lazily when a beacon is encoded or received.

### 3. Reply rule on receiving a beacon

```
remote  = decodeStateVector(sv)           local = decodeStateVector(encodeStateVector(doc))
senderBehind = ∃ (client, clock) ∈ local : (remote[client] ?? 0) < clock
weBehind     = ∃ (client, clock) ∈ remote : (local[client]  ?? 0) < clock
dsEqual      = dsHash == _deleteSetHash()

if senderBehind || !dsEqual   → reply SyncStep2 = writeSyncStep2(doc, sv)   (as today: suppression + rate limit)
else if flags & JOIN          → reply our own beacon (flags = 0) as an ack  (same suppression + rate-limit path)
else                          → nothing

if !weBehind && dsEqual       → _markSynced()
if flags & JOIN && awareness.getLocalState() !== null → _broadcastAwareness([clientID])
```

- A SyncStep2 sent because only `dsHash` differs contains an empty struct
  section plus the full delete set — exactly the repair that heals a lost
  delete, on either side within one interval (the other side's beacon
  triggers the symmetric reply).
- "Sender ahead of us" triggers no reply; our own next beacon fetches it.
  This is the round-2 lesson respected: no recovery path is removed, only
  replies that carry no information.
- `_cancelPendingSyncReply()` semantics unchanged: an overheard SyncStep2
  cancels a pending reply (SyncStep2 or ack). An overheard beacon cancels
  nothing.

### 4. `synced`

Second rule next to the existing "received SyncStep2": a received beacon we
are not behind, with equal `dsHash`, marks us synced. Strictly stronger
than today's empty SyncStep2 ("you lack nothing I have"). Covers the
joiner (ack beacon), the first peer (second peer's JOIN beacon), and
concurrent join bursts (everyone's JOIN beacons are equal) without any
acks having to survive the rate limiter. A lone peer stays unsynced, as
today.

### 5. Join flag and presence

- `syncNow()` (public; called by `connect()`) → `_syncNow(DIGEST_FLAG_JOIN)`.
- `_schedulePeerConnectSync()` → `_syncNow(0)`: mesh transports already
  re-broadcast presence to the newcomer via their own `onPeerConnect`.
- `_requestResync()`'s retry → `_trySyncPushPull(true, extra, 0)`.
- Receivers of a JOIN beacon re-announce their own awareness through the
  existing 100 ms throttle (unsuppressed — every responder's state is
  distinct), skipped when the local state is `null`.
- The periodic tick becomes `_sendSyncStep1()` only. The awareness
  re-announce and its batch-folding in `connect()`'s tick are deleted; the
  15 s renewal in `y-protocols/awareness` (awareness.js:59-63) is the
  staleness bound, and `outdatedTimeout` is 30 s.
- `connect()`'s standalone `_broadcastAwareness([clientID])` right after
  `syncNow()` is deleted: `syncNow()` already batches or schedules it, so
  today this is a duplicate 100 ms later.

### 6. Compatibility

All peers in a room must run the same version. This has been true since
`MESSAGE_BATCH` (round 3): an old peer drops a new peer's connect batch
whole, including the SyncStep1 inside it. Type 5 adds nothing new to that
cliff; it is documented in the README alongside `compressionThresholdBytes`.

## Dropped from this phase

- **Item 4, `pendingStructs` ground truth.** With `verifyUpdates` on (the
  default) a missing dependency already produces an immediate hash
  mismatch. The remaining value (verifyUpdates off; skipping redundant
  resyncs) is speculative and would need its own grace timer. Deferred
  until a bench shows redundant resyncs are a measurable share.
- **Item 11, persistence-first.** No code: a consumer with a persistence
  provider awaits its `synced` before calling `connect()` on the network
  provider. One README paragraph.

## Benchmarks and gates — before/after per step

Every implementation step below is measured on the commit before it and
on the commit after it, with the same script and parameters, and both
numbers go into the "Results" addendum of this document. Baseline numbers
are taken on this branch *before* any `src/` change, with the new bench
script compiled against unchanged `src/`.

New: `test/dummy/bench-idle-room.ts`
- (a) **Idle census.** N ∈ {5, 20, 50}; `syncInterval` 1000 ms; DummyTransport
  latency 20 ms, jitter 0.25; all peers have awareness state; one edit at
  start; settle 2.5 s; observe 10 s. Reports deliveries and bytes per class
  (SyncStep1/Digest, SyncStep2, Update, Awareness) and deliveries/s.
- (b) **Lost delete.** Two peers, latency 20 ms, `syncInterval` 1000 ms.
  A inserts, sync, then A deletes and the hub drops A's very next
  broadcast. Measures time until B's text equals A's, cap 5 s. On `main`
  this heals within one interval via B's empty SyncStep2 request cycle;
  after the change it must heal within one interval via the `dsHash`
  mismatch. This part exists to make shipping the reply rule *without*
  the hash impossible.

Updated: `test/dummy/bench-periodic-awareness.ts` — both configurations
(with and without `onPeerConnect`) must now send 0 periodic awareness
messages; added: a late joiner into an N=5 room must see all 4 remote
presence states within `awarenessInterval + 3·latency + 200 ms`.

Updated classifiers: `bench-corruption-storm.ts` and
`bench-periodic-awareness.ts` peek at message types; type 5 counts as the
request class (SyncStep1) so their ratios stay comparable.

Gates for the whole phase (run after the last step, on the branch tip):
- `bench-idle-room` (a): SyncStep2 class at N=50 down ≥ 90% vs baseline;
  Awareness class within 2x of the 15 s-renewal floor `N·(N-1)·10/15`.
- `bench-idle-room` (b): converges on both baseline and after, ≤ 1 interval
  + resync backoff.
- `bench-packet-loss`, `bench-late-join`, `bench-sync-latency`: 3 runs each,
  zero convergence timeouts; message counts reported vs baseline.
- `bench-corruption-storm`, `bench-user-scaling`: 1 run each, reported.
- `bench-periodic-awareness`: PASS on all three checks.

## Work items, in order (one commit each)

1. `bench-idle-room.ts` + classifier updates + `.gitignore` `bench-dist/`;
   record baseline numbers for (a), (b), `bench-periodic-awareness`,
   `bench-packet-loss`, `bench-late-join`, `bench-sync-latency`,
   `bench-corruption-storm`, `bench-user-scaling`.
2. `computeDeleteSetHash` + `_dsHashCache` (no wire change yet; bench (b)
   unchanged by construction — this step is pure preparation and is
   verified by a unit-style check inside `bench-idle-room.ts`: two docs
   with equal state vectors and different deletes must hash differently,
   two independently built equal docs must hash equally).
3. Digest beacon: encode/decode, reply rule, `synced` rule, JOIN flag,
   presence-on-join, tick simplification, `connect()` cleanup. Measure
   everything in the gate list before/after.
4. README: compatibility note for type 5, persistence-first paragraph.

## Results

Appended per step as measured (baseline first). Nothing in this document
above this line is to be read as a measured result.

### Baseline (branch `round-4-phase-1`, `src/` unchanged from `main` @ `e2cf824`)

Machine-local numbers; compare within this document only. Every `bench-*`
below was run from a snapshot of the compiled baseline
(`bench-dist-baseline/`), so later `src/` changes cannot leak into it.

**`bench-idle-room` (a) — idle census**, 10 s window, `syncInterval` 1000 ms,
latency 20 ms ±25 %. "request" = SyncStep1 (or, after Task 3, the digest
beacon); floors are the protocol minimum for the window (one request per
peer per interval; one awareness renewal per peer per 15 s):

| N | deliveries | /s | /s/peer | request | syncStep2 | update | awareness | request floor | awareness floor |
|---|---|---|---|---|---|---|---|---|---|
| 5 | 388 | 39 | 7.8 | 120 | 188 | 0 | 200 | 200 | 13 |
| 20 | 10,127 | 1,013 | 50.6 | 988 | 6,289 | 0 | 3,838 | 3,800 | 253 |
| 50 | 69,874 | 6,987 | 139.7 | 3,577 | 45,031 | 0 | 24,843 | 24,500 | 1,633 |

Two things the census shows beyond the research doc's probe: (1) requests
land *below* their floor at N ≥ 20 (3,577 vs 24,500 at N=50) because the
shared rate limiter (20 per 10 s) throttles the periodic tick itself once
SyncStep2 replies eat the budget — the replies crowd out the requests they
answer; (2) SyncStep2 : request = 12.6 : 1 at N=50, i.e. reply suppression
is far from the ~1 it targets at this latency, and every one of those
replies is empty (219.9 KB / 45,031 ≈ 5 bytes).

**`bench-idle-room` (b) — lost delete**, 2 peers, 5 samples: all converged,
heal latency 131-832 ms (uniform over one interval, as expected from the
random tick phase), always via one request + one SyncStep2 (the reply's
full delete set), zero warnings in the heal window. Setup phase of every
sample: exactly one `Hash mismatch` + one `Resync scheduled` — the
pre-existing join artifact recorded as item 12 in the research doc's
addendum (the joiner's full-state push carries a hash of *its* state; a
peer holding more data reads that as divergence). Not caused by this
phase; visible here because the bench tallies warnings.

**`bench-sync-latency`**, 3 runs, no convergence timeouts. `msgCount` is
identical across runs for every cell (30 for `batchUpdates: 0`, 31 where a
join-artifact resync adds a message, 1 for `batchUpdates: 150`). `totalMs`
for the `batchUpdates: 0, verifyUpdates: true` row, empty doc: WebSocket
29-51, WebRTC 27-37, Gun 326-329, Matrix 473-491; 195 KB preloaded doc:
WebSocket 26-42, WebRTC 26-40, Gun 331-350, Matrix 474-497. `Hash mismatch`
warnings per run: 9 / 21 / 19 — all in 2-client runs with zero loss and
zero reordering, i.e. item 12 again.

Remaining baseline gates (`bench-late-join` ×3, `bench-corruption-storm`,
`bench-user-scaling`, `bench-packet-loss` ×3) were still running from the
same `bench-dist-baseline/` snapshot when Task 1 was committed; their
numbers are appended below in the commit that records them.
