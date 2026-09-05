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

The remaining baseline gates were still running from the same
`bench-dist-baseline/` snapshot when Task 1 was committed; recorded here
with the Task 3 results:

**`bench-late-join`**, 3 runs, all cells converged (both scenarios, both
profiles, 0 % and 3 % loss). Selected cells (`msgs` = mean per run,
`mismatch` = the bench's own hash-mismatch tally):

| scenario | profile | M | K | msgs (3 runs) | mismatch (3 runs) |
|---|---|---|---|---|---|
| idle late join | WebSocket | 10 | 5 | 821 / 811 / 811 | 0 |
| idle late join | WebSocket | 40 | 10 | 9,412 / 9,412 / 8,546 | 0 |
| idle late join | Matrix | 40 | 10 | 10,555 / 10,245 / 10,555 | 0 |
| join during edit burst | WebSocket | 40 | 10 | 15,502 / 15,029 / 15,421 | 1,460 / 1,422 / 1,434 |
| join during edit burst | Matrix | 40 | 10 | 18,116 / 19,191 / 18,112 | 4,724 / 4,633 / 4,165 |

**`bench-corruption-storm`**, N=10 rows (`msgs` during the 3 s edit stream,
SyncStep2 : SyncStep1 ratio): 5 % → 1,170 / 3.24; 20 % → 1,422 / 4.21;
50 % → 1,341 / 3.50. Both RESULT lines pass (no storm, all converged).

**`bench-user-scaling`**, WebSocket profile: fan-out is exactly linear
(990 messages for a 10-edit burst at N=100); join-burst 40,915 messages /
440,931 bytes at N=50 and 184,140 / 1,953,019 at N=100.

**`bench-packet-loss`**, 3 runs, every cell converged. Fan-out at N=50,
WebSocket, mean messages per run: 1 % loss → 3,936 / 4,688 / 6,435; 3 % →
7,513 / 5,521 / 6,615; 10 % → 4,737 / 7,219 / 6,158 (490 at 0 %, i.e. the
loss-free cost is exactly linear and every message above it is recovery
traffic). Join-burst at N=50 stays at ~40.9k messages regardless of loss.

### After Task 3 — digest beacon (branch tip after the Task 3 commit)

Same scripts, same parameters, `bench-dist/` compiled from the changed
`src/`. Both gate sets ran concurrently on the same machine; message
counts are unaffected by that, wall-clock columns are noisier than usual.

**`bench-idle-room` (a)** — the change this phase exists for:

| N | deliveries | Δ | request | syncStep2 | awareness |
|---|---|---|---|---|---|
| 5 | 400 → 192 | −52 % | 112 → 192 | 208 → **0** | 192 → **0** |
| 20 | 9,082 → 1,083 | −88 % | 1,045 → 1,083 | 5,301 → **0** | 3,781 → **0** |
| 50 | 70,854 → 7,497 | **−89 %** | 2,891 → 7,497 | 46,109 → **0** | 24,745 → **0** |

An idle room now carries beacons and nothing else. Requests went *up*
because the rate limiter is no longer drained by replies (still below the
24,500 floor at N=50: the join-time ack burst spends most of each peer's
20-per-10 s budget, so ticks in the first ~10 s after a 50-peer join are
throttled — see the follow-up below). Awareness is 0 in the window because
the y-protocols 15 s renewal falls outside the 10 s observation; the
per-tick re-announce is gone on every transport.

**`bench-idle-room` (b)** — lost delete: 5/5 converged, heal latency
127-1,019 ms, always via one beacon + one SyncStep2 (the `dsHash`
mismatch path), zero warnings in the heal window. Same latency envelope as
the baseline's empty-reply path; the delete-set hash does what it is for.

**`bench-idle-room` (c)** — `HASHPROPS ... => PASS`.

**`bench-periodic-awareness`** (rewritten expectations): 0 periodic
awareness sends on both configs; the late joiner into a 5-peer room saw all
5 remote presence states after **34 ms** (baseline: 285 ms, via the next
tick) and was `synced` after 47 ms. All four checks PASS.

**`bench-sync-latency`**, 3 runs: `msgCount` identical to baseline in
every cell; `totalMs` within the baseline spread. `Hash mismatch` warnings
per run 15 / 11 / 19 (baseline 9 / 21 / 19) — item 12 is untouched by this
phase.

**`bench-late-join`**, 3 runs, every cell converged, `mismatch` column
unchanged within noise (item 12). Message counts in the join window went
**up**:

| scenario | profile | M | K | baseline msgs | after msgs |
|---|---|---|---|---|---|
| idle late join | WebSocket | 10 | 5 | 811-821 | 1,199-1,213 |
| idle late join | WebSocket | 40 | 10 | 8,546-9,412 | 13,708-13,871 |
| idle late join | Matrix | 40 | 10 | 10,245-10,555 | 18,461-18,608 |
| join during edit burst | WebSocket | 40 | 10 | 15,029-15,502 | 19,586-20,027 |
| join during edit burst | Matrix | 40 | 10 | 18,112-19,191 | 22,474-23,346 |

This is the designed trade: the bench runs with `syncInterval: 0`, so it
sees only the join-time cost (presence responses + acks to the JOIN
beacon) and never the removed per-tick re-announce. At M+K=50 the extra
~4,400 deliveries equal roughly one old heartbeat tick (50·49 = 2,450
awareness + the replies to it); the break-even is one interval, then the
idle census applies. The 12.6 : 1 idle reply ratio and the 40 % awareness
share are gone; the join got ~45 % more expensive in a bench that never
charges for idling.

**`bench-corruption-storm`**, N=10 rows (msgs / SyncStep2 : SyncStep1):
5 % → 747 / 1.18 (was 1,170 / 3.24); 20 % → 1,413 / 3.90 (was 1,422 /
4.21); 50 % → 1,179 / 2.60 (was 1,341 / 3.50). Both RESULT lines pass.
Fewer empty replies during recovery, same convergence.

**`bench-user-scaling`**, WebSocket: fan-out identical (990 at N=100).
Join-burst **message count identical** (40,915 at N=50, 184,140 at N=100):
the ack beacons replaced the empty SyncStep2 replies one for one under the
same rate limiter, and the JOIN-triggered presence response replaced the
duplicate awareness broadcast that `connect()` used to schedule 100 ms
after `syncNow()`. Bytes +52 % (440,931 → 670,866 at N=50; 1,953,019 →
2,997,326 at N=100): an ack beacon (~12 B) is larger than an empty
SyncStep2 (~4 B), times ~38k reply deliveries.

**`bench-packet-loss`**, 3 runs, every cell converged (the hard gate that
killed round 2's Item 2). Fan-out at N=50, mean messages per run,
baseline → after:

| profile | loss | baseline (3 runs) | after (3 runs) |
|---|---|---|---|
| WebSocket | 0 % | 490 / 490 / 490 | 490 / 490 / 490 |
| WebSocket | 1 % | 3,936 / 4,688 / 6,435 | 1,437 / 1,160 / 1,111 |
| WebSocket | 3 % | 7,513 / 5,521 / 6,615 | 2,777 / 3,691 / 1,895 |
| WebSocket | 5 % | 4,753 / 8,689 / 7,677 | 4,051 / 3,463 / 4,149 |
| WebSocket | 10 % | 4,737 / 7,219 / 6,158 | 5,602 / 4,704 / 5,063 |
| Matrix | 0 % | 1,519 / 1,601 / 1,535 | 1,241 / 1,323 / 1,372 |
| Matrix | 1 % | 4,671 / 6,141 / 3,071 | 4,181 / 5,276 / 3,626 |
| Matrix | 10 % | 10,976 / 9,653 / 12,397 | 7,007 / 6,778 / 8,575 |

Recovery traffic at realistic loss (1-3 %) roughly halved to quartered:
the resync round trips no longer collect an empty SyncStep2 from every
peer that had nothing to add. Join-burst at N=50: WebSocket unchanged
(~40.9k at every loss rate), **Matrix up from ~37.9k to ~47.5k (+25 %)**.
Cause: at 350 ms latency the 50 JOIN beacons arrive spread over several
100 ms awareness-throttle windows, so a peer answers with 2-3 presence
broadcasts instead of the single coalesced one it sends at WebSocket
latency. Recorded, not gated: 50 simultaneous joiners on a transport that
Synapse rate-limits to 0.2 messages/s is not a scenario this transport
survives either way; a real fix would be a presence-response coalescing
window decoupled from the 100 ms cursor throttle — a candidate for phase
1b, together with item 12.

**Gate verdict for Task 3:** all gates pass (idle census −89 % at N=50
against the ≥ 90 % SyncStep2-class target it exceeds; awareness class at
0 against the 2×-floor cap; lost delete 5/5; packet-loss / late-join /
sync-latency 3 × 3 runs with zero timeouts; corruption-storm and
user-scaling reported; periodic-awareness 4/4 PASS).

**Follow-up decided from these numbers (Task 3b, own before/after).** In a
join burst the acks are ~94 % of the messages and are almost all
redundant: every joiner's own JOIN beacon is an equal-state beacon that
already marks every other joiner `synced` (§4). Yet a pending ack is only
cancelled by an overheard SyncStep2 (§3 as written: "an overheard beacon
cancels nothing"), so acks ride the rate limiter instead of the
suppression. Amendment to §3: **an overheard beacon whose digest equals
ours cancels a pending *ack* (never a pending SyncStep2)** — the joiner it
was meant for has received that same beacon and is synced by it. Expected:
join-burst messages at N=50 drop from ~40.9k toward the ~2.5k connect
batches plus a handful of surviving acks; `bench-idle-room` requests
recover toward their floor because the budget is no longer spent on acks.
Measured in the Task 3b section below.
