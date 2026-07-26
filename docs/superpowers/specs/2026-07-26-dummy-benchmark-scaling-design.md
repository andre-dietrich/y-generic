# Dummy benchmarking & protocol scaling — design

## Goal

Benchmark `y-generic`'s sync protocol using `DummyTransport`/`DummyHub` across a
range of simulated user counts (not just the existing 2-client latency
benchmark), identify where message count / bytes-on-wire / CPU cost scale
worse than necessary as user count grows, and apply targeted fixes to the
wire protocol (`src/index.ts`) and, where it's the actual bottleneck, to the
dummy test infrastructure itself (`src/providers/dummy/index.ts`).

## Context

`test/dummy/bench-sync-latency.ts` already benchmarks 2 clients under 4
latency profiles (WebSocket-like, WebRTC, Gun, Matrix) with `batchUpdates` /
`verifyUpdates` toggled, measuring `totalMs` (convergence time) and
`msgCount`. It does not vary the number of simulated users, so it cannot
surface scaling behavior.

Commit `c048682` (just landed) fixed a false-positive hash-mismatch backoff
escalation under packet reordering — a correctness fix for one source of
unnecessary `syncNow()` full-state resyncs. It does not touch the three
scaling concerns below, which remain open.

Reading `src/index.ts` and `src/providers/dummy/index.ts` surfaced three
hypotheses about how cost scales with user count `N` in a room:

1. **`computeDocHash()` cost scales with N.** It's called on every sent and
   every received `MESSAGE_SYNC_VERIFIED` update (`src/index.ts` `_sendUpdate`
   and the `MESSAGE_SYNC_VERIFIED` branch of `_handleIncomingMessage`).
   `Y.encodeStateVector(doc)` is O(distinct clients in the doc), so as N
   grows, every single update — not just full syncs — pays an O(N) tax.
2. **`syncNow()` runs per `onPeerConnect` event and broadcasts full state.**
   For transports where `onPeerConnect` fires once per newly-connected
   remote peer (mesh-style transports), N peers joining in a short window
   can trigger up to N `syncNow()` calls, each broadcasting the full
   document state — a potential O(N²) full-state broadcast burst on
   "everyone reconnects at once" scenarios.
3. **`DummyHub.broadcast()` schedules one `setTimeout` per (sender, message,
   recipient) triple.** This is test-infrastructure-only, but at N≈100
   simulated clients sending concurrently it creates enough concurrent
   timers to make the benchmark itself the bottleneck rather than the code
   under test.

These are hypotheses to be confirmed by measurement (Part 1) before any fix
(Part 2/3) is applied — no fix ships without a benchmark number motivating it.

## Part 1 results (measured, superseding the hypotheses above)

`test/dummy/bench-user-scaling.ts` was implemented and run against `main`
(post `c048682`). Full output is in the session log; the key numbers:

**Fan-out (10-edit burst, already-synced room), messages delivered:**

| N   | expected (10×(N-1)) | measured (WebSocket profile) | measured (Matrix profile) |
|-----|---------------------|-------------------------------|----------------------------|
| 25  | 240                 | 1,248                         | 5,688                      |
| 50  | 490                 | 6,419                         | 27,979                     |
| 100 | 990                 | 19,206                        | 206,514                    |

**Join-burst (N clients connecting concurrently), messages delivered —
nearly identical across all 4 latency profiles (i.e. NOT latency-driven):**

| N   | messages | CPU time  |
|-----|----------|-----------|
| 10  | 585      | ~15-60ms  |
| 25  | 8,400    | ~75-240ms |
| 50  | 64,925   | ~400-570ms|
| 100 | 509,850  | ~2.9-3.3s |

A follow-up isolation run (fan-out, Matrix profile, `verifyUpdates` on vs.
off) confirms the cause precisely:

| N   | verifyUpdates=true | verifyUpdates=false (=expected baseline) |
|-----|---------------------|-------------------------------------------|
| 25  | 5,024               | 240                                       |
| 50  | 29,128              | 490                                       |
| 100 | 320,804             | 990                                       |

With `verifyUpdates` off, message counts land exactly on the theoretical
10×(N-1) baseline at every N — perfectly linear, no blow-up. The entire
super-linear cost is attributable to `verifyUpdates`'s hash-mismatch path.

**What's actually happening:** `syncNow()` (`src/index.ts:586`) has two
parts: an *uncapped* push of the full local document state
(`this._sendUpdate(update)`), and a *rate-limited* sync request
(`this._sendSyncStep1()`, gated by the existing `_syncRequestTimes` /
`_maxSyncRequestsPerWindow` limiter). `syncNow()` is called from the
hash-mismatch handler (`src/index.ts:886`) every time a peer detects a hash
mismatch. With many peers converging at once, hash mismatches are common
(reordering across many concurrent senders) and each one triggers a full,
*unthrottled* document-state broadcast to the entire room. Those broadcasts
themselves cause more concurrent traffic, which causes more mismatches
elsewhere, which trigger more broadcasts — a self-reinforcing cascade. This
is confirmed as the sole driver (not `computeDocHash`'s O(N) per-call cost,
which only shows up as a minor secondary cost proportional to the inflated
message count itself — CPU-per-message stays roughly constant across N).

**Hypothesis 1 (hash cost)**: not an independent bottleneck — its CPU cost
tracks message count, which is driven by hypothesis 2's cascade. No fix
needed beyond fixing hypothesis 2.

**Hypothesis 2 (repeated full-state broadcasts)**: confirmed as the
dominant cost, root-caused to `syncNow()`'s uncapped push, triggered
primarily by the hash-mismatch handler (not `onPeerConnect`, which
`DummyTransport` doesn't even implement — real mesh transports that do
implement it would compound this further, but that path isn't reachable in
this benchmark).

**Hypothesis 3 (DummyHub timer volume)**: not a bottleneck at this scale —
wall-clock time for fan-out stays within ~30-200ms even at 100 users and
tens of thousands of deliveries; Node handles the timer volume fine. Dropped
from scope.

## Decision

Part 2 is narrowed to a single fix: **gate `syncNow()`'s full-state push
behind the same rate limiter that already gates `_sendSyncStep1()`**, as one
combined check at the top of `syncNow()`, instead of only protecting the
sync-request half. This directly caps the cascade at its source, reuses
existing state (`_syncRequestTimes`/`_maxSyncRequestsPerWindow`/
`_syncRequestWindowMs`, `src/index.ts:237-239`), and doesn't touch the
primary edit-propagation path (`doc.on('update', ...)` → `_sendUpdate`,
`src/index.ts:611-627`), which is unaffected by this limiter and still
delivers every local edit immediately. The periodic-hash-verification idea
from the original Part 2 draft is dropped — not supported by measurement.

Part 3 (`DummyHub` timer batching) is dropped entirely — not supported by
measurement at the target scale (up to 100 users).

## Scope

- **In scope:** `src/index.ts` (wire protocol / provider logic),
  `src/providers/dummy/index.ts` (`DummyHub`/`DummyTransport`), benchmark
  scripts under `test/dummy/`.
- **Compatibility:** breaking wire-format changes are acceptable — no
  deployed clients depend on today's exact byte layout.
- **Target scale:** up to ~50-100 simulated users in one room. Primary
  metrics: message count and bytes-on-wire (transport-agnostic). Wall-clock
  and rough CPU time are secondary/explanatory, not the primary pass/fail
  metric (per existing bench script's own caveat: `DummyHub`'s per-message
  independent `setTimeout` model doesn't capture real head-of-line blocking
  for HTTP-style transports, so wall-clock is most trustworthy for
  push-style transports only).
- **Out of scope (YAGNI unless measurement says otherwise):**
  - Compact session-scoped client IDs (replacing the full ~32-bit clientID
    in `MESSAGE_SYNC_VERIFIED` with a smaller connection-local ID). Estimated
    saving is ~4 bytes/message against typical Yjs update payloads that are
    usually larger than that — low value for the complexity of introducing
    per-connection ID negotiation state.
  - Any change to `Transport` (`src/transport.ts`) itself, e.g. adding a
    targeted (non-broadcast) send capability to fix the `syncNow()`-per-peer
    fanout precisely. That would let a provider push full state to only the
    newly-joined peer instead of the whole room, but it's an interface
    change affecting every existing provider implementation — bigger than
    this task justifies. The debounce approach in Part 2 mitigates the same
    symptom without touching `Transport`.
  - Incremental/delta state-vector hashing to avoid full state-vector
    re-encoding. Not clearly worth the complexity unless Part 1 shows hash
    cost dominating at realistic N.

## Part 1 — Multi-user benchmark

Add a new benchmark script, `test/dummy/bench-user-scaling.ts`, sibling to
the existing `bench-sync-latency.ts` (same run instructions: compile via
`tsconfig.bench.json`, run with node).

- Spins up N `GenericProvider` + `DummyTransport` instances sharing one
  `DummyHub`/room, N ∈ {5, 10, 25, 50, 100}.
- Two workload shapes, run for each N:
  - **Fan-out cost**: one client performs a burst of edits (as in the
    existing bench's `EDIT_COUNT`), measure total messages and total bytes
    delivered hub-wide until all N clients converge.
  - **Join burst**: all N clients connect within a short window (simulating
    "everyone reconnects after a network blip"), measure messages/bytes
    attributable to `syncNow()`/initial sync until the room is quiescent.
- Reports, per N: total message count, total bytes-on-wire (sum of wrapped
  message lengths through `DummyHub.broadcast`), wall-clock time, and
  `process.cpuUsage()` delta across the measured window.
- Run once against current `main` (post `c048682`) to get the baseline
  referenced by Part 2/3's before/after numbers.

This part alone confirms or refutes the three hypotheses above before
anything else is touched.

## Part 2 — Protocol change (`src/index.ts`)

Restructure `syncNow()` so the rate-limit check that currently only guards
`_sendSyncStep1()` gates the *entire* method (full-state push + sync
request) with a single check at the top. If the room is already over the
`_syncRequestTimes`/`_maxSyncRequestsPerWindow` budget, `syncNow()` does
nothing for either half and returns — the next successful periodic sync (or
a future rate-limit window) catches up instead. Awareness broadcast stays
outside this gate (it has its own independent, much cheaper throttle via
`_awarenessInterval` and isn't part of the measured cascade).

This is a small, surgical change: extract the existing
check-then-record-timestamp logic (`src/index.ts:1002-1019`) into a shared
private method (e.g. `_tryReserveSyncSlot(): boolean`), call it once at the
top of `syncNow()`, and have `_sendSyncStep1()` skip its own now-redundant
internal check when called from `syncNow()` (or simply call the encoder
logic directly from `syncNow()` post-gate, since the rate limit was already
consumed). The periodic-sync `setInterval` callback in `connect()`
(`src/index.ts:409-425`) keeps its own existing inline check — it already
calls `_sendSyncStep1()` only, not `syncNow()`, so it's unaffected by this
change and needs no edit.

## Part 3 — dropped

Not pursued; see "Part 1 results" above.

## Addendum (post-implementation): Part 2 measured impact was smaller than expected, and the real driver found

Task 2 (the `syncNow()` rate-limit gate) was implemented and, before committing,
verified against the plan's own pass bar — rerunning `bench-user-scaling.ts`
repeatedly (not just once) at N=100. That repeated sampling revealed two things
the single-sample baseline above didn't:

1. **The benchmark is far noisier at N=100 than one sample suggests.** 21 runs
   per side (Matrix profile, fan-out) gave: pre-fix mean ~286,591 (range
   990-835,956), post-fix mean ~224,132 (range 990-616,473) — only a ~1.3x
   mean reduction, not the 5-10x expected, and not clearly outside the noise.
   The originally-recorded `206,514` baseline sat at the low end of the
   pre-fix distribution by chance.
2. **Root cause: the rate-limit gate barely engages in this scenario.**
   Instrumentation across all 100 clients showed only 0.6-3.6 `syncNow()`
   calls per client on average — far under the 20-per-10s cap — so the gate
   cannot be the mechanism producing any real reduction here.

The actual dominant cost: `DummyHub.broadcast()` (`src/providers/dummy/index.ts:98-140`)
has no unicast — every client's SyncStep1 *request* fans out to all N-1 peers,
and because `syncProtocol.readSyncMessage` answers a SyncStep1 by writing a
SyncStep2 reply, **every one of those N-1 peers independently generates and
broadcasts its own reply**, each again fanning out to N-1 peers. A single
`syncNow()` call's pull half costs O(N²) from this reply pile-up alone — which
dwarfs anything the per-client push cap saves, and which Task 2 never touched.
This matches the "Out of scope" note under Scope (adding targeted send was
deferred as "bigger than this task justifies") — that deferred item turned out
to be the dominant cost after all.

Task 2 was still committed (it's a real, if modest, improvement — see its
commit message for the honest ~1.3x number), and this addendum's finding
became Part 4 below.

## Part 4 — SyncStep2 reply suppression (validated, replaces the Transport-unicast idea)

Adding real point-to-point send to `Transport` (deferred above as too large)
turns out to be unnecessary. The redundant-reply problem can be solved
entirely inside `GenericProvider`, using the classic NACK-suppression pattern
from reliable multicast (e.g. Scalable Reliable Multicast): instead of
replying to a SyncStep1 request immediately, each peer that would reply waits
a short random delay; if it overhears another peer's SyncStep2 reply during
that delay (it will, since all replies are broadcast to everyone anyway), it
assumes the requester is now satisfied and drops its own redundant reply.

**Validated by prototype** (built and measured directly against
`test/dummy/bench-user-scaling.ts` and `test/dummy/bench-sync-latency.ts`,
then discarded — Task 3 below implements it properly):

- First version (suppress unconditionally on overhearing any SyncStep2):
  N=100 Matrix-profile fan-out, 15 repeated samples: mean 96,304 (range
  78,727-112,914) vs. the pre-fix mean of ~286,591 and worst-case of 835,956
  — roughly a 3x mean reduction and a **~7.4x reduction in worst-case**,
  collapsing the wild run-to-run variance into a tight band.
- That first version broke 2-peer correctness: `bench-sync-latency.ts` showed
  30 consecutive hash mismatches in one run, with one peer staying at an empty
  document ("Local: 0") far too long. Cause: with only 2 total peers, there is
  no "someone else" to rely on — suppressing the only viable reply just
  because *some* SyncStep2 was overheard (even one answering a different
  request entirely) silences the one reply the requester actually needed.
- **Fix:** gate suppression behind a cheap, already-available peer-count
  estimate — `this.awareness.getStates().size >= 3` (i.e. at least 2 other
  known peers besides self). Below that threshold, reply immediately as
  today; at/above it, suppression is safe because redundant repliers
  genuinely exist. After this gate: `bench-sync-latency.ts` ran clean across
  multiple repeated full runs (0 convergence timeouts; hash-mismatch counts
  of 10/14/40 across 3 runs, within the same noise range the un-suppressed
  baseline itself shows), and the N=100 improvement was retained.

**Decision:** implement this as Task 3 of the implementation plan, gated on
`awareness.getStates().size`, with a fixed suppression window (30ms in the
prototype — tune based on Task 3's own measurement, not hard-coded from the
prototype without re-verification). This stays entirely within
`src/index.ts` — no `Transport` interface change, no changes to any provider
under `src/providers/`.

**Known limitation, accepted:** the peer-count gate and the "any overheard
SyncStep2 cancels my pending reply" heuristic are coarse — a reply can still
be wrongly suppressed if it was answering a *different* request than the one
the observer has queued. This is acceptable because the system already
tolerates eventual (not immediate) consistency via redundant mechanisms
(periodic sync every `syncInterval` ms, hash-mismatch-triggered resync) — a
wrongly-suppressed reply just delays catch-up slightly rather than losing
data. A future refinement could correlate replies to specific requests, but
that needs a wire-format change and is not justified without evidence the
coarse heuristic causes real problems at realistic scale.

**Post-implementation correction — the shipped benchmark scripts didn't
exercise the gate at all:** when Task 3 was actually implemented and
re-verified against the unmodified `test/dummy/bench-user-scaling.ts` and
`test/dummy/bench-sync-latency.ts`, the peer-count gate
(`awareness.getStates().size >= 3`) never became true in either script, and
the N=100 fan-out numbers showed no improvement over the pre-fix baseline
(mean ~351,565, same wild variance as before). Root cause, confirmed with an
isolated unit test against `y-protocols/awareness`: the library's `Awareness`
constructor sets the local state via `setLocalState({})`, which leaves the
local meta clock at its genesis value of `0`. `applyAwarenessUpdate` only
accepts an incoming state when `currClock < clock` (or the null/removal
case) — for a clientID the receiver has never seen, `currClock` defaults to
`0`, so a sender whose clock is *also* still `0` is silently rejected. The
clock only advances once a consumer calls `setLocalState`/
`setLocalStateField` with real content (every actual consumer app does this
for cursor/presence). Neither benchmark script ever did, so
`awareness.getStates().size` stayed at `1` (self only) for every peer for the
whole run in both scripts — a benchmark gap, not a defect in the fix itself:
a throwaway patch adding one `provider.awareness.setLocalStateField(...)`
call per peer reproduced the originally-claimed numbers almost exactly (mean
63,830, range 990-108,009 over 12 runs on the fan-out scenario).

Both benchmark scripts were amended to call `setLocalStateField` once per
provider right after construction (`test/dummy/bench-user-scaling.ts`'s
`makeProviders()`, `test/dummy/bench-sync-latency.ts`'s `providerA`/
`providerB`) so they match what real consumer apps already do, and Task 3 was
re-verified against the amended scripts — see Task 3's commit message for the
resulting numbers. Note `bench-sync-latency.ts` is inherently a 2-peer
scenario, so `awareness.getStates().size` can reach at most `2` there even
after this fix — the `>= 3` gate structurally can never engage in that
script; the amendment only fixes the two peers' mutual awareness visibility
(1 -> 2), it does not and cannot exercise the suppression path itself. That
script's value is (and remains) purely a 2-peer *correctness* check — proving
the gate correctly stays closed (no suppression, no stall) when there's
genuinely no redundancy, not a demonstration of the suppression benefit.

**Documented limitation of the fix itself (not just the benchmark):** because
suppression is gated on awareness activity, an application that never touches
`awareness.setLocalState`/`setLocalStateField` (no cursors, no presence, pure
headless sync) gets **no** suppression benefit from Task 3, in exactly the
same way the unmodified benchmarks didn't — the gate's condition is simply
never satisfied, so the code always takes the pre-Task-3 "reply immediately"
path. This causes no regression (that path is identical to before Task 3),
but it does mean the O(N²) reply-storm fix is conditional on the app exercising
awareness at all, which is not guaranteed by `GenericProvider`'s API surface
itself. This is accepted as a known limitation rather than fixed here (fixing
it — e.g., decoupling the redundancy estimate from awareness — is a possible
future refinement, not in scope for Task 3).

## Testing / verification plan

- No existing automated test suite (per `CLAUDE.md`) — verification is
  running the new and existing bench scripts and comparing before/after
  numbers, plus a manual smoke test via `npm run dev:dummy` /
  `test/dummy/edge-cases.html` to confirm normal 2-3 client sync still works
  visually after the `src/index.ts` changes.
- The Part 2 change must not regress the just-landed reordering-tolerance
  fix in `c048682` — rerun `test/dummy/bench-sync-latency.ts` after the
  change and confirm hash-mismatch/backoff-cap counts stay at or below the
  current baseline (21 mismatches / 0 backoff-cap hits across all profiles,
  captured above).
- Rerun `test/dummy/bench-user-scaling.ts` after the change and confirm the
  fan-out message counts at N=25/50/100 (Matrix profile: 5,688 / 27,979 /
  206,514 before) land close to the `verifyUpdates=false` baseline (240 /
  490 / 990) rather than the measured blow-up — this is the concrete
  before/after number for the commit message.
- **Single-sample comparisons at N=100 are not reliable** (see the Addendum
  above) — any before/after claim for Task 3 must use repeated sampling
  (10+ runs per side) and report mean and range, not one run.
- Task 3 specifically must be verified against `bench-sync-latency.ts`
  (2-peer scenario) with multiple repeated full runs, not once — the
  prototype's first version passed a single run before failing on a later
  one. No `Timeout waiting for convergence` errors on any run is the hard
  requirement; mismatch/backoff-cap counts should stay within the
  established noisy-baseline range, not a hard exact number.
