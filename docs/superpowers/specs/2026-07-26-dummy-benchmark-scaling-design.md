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
