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

## Part 2 — Protocol changes (`src/index.ts`), conditional on Part 1 findings

Two candidate fixes, each applied only if Part 1's numbers support it:

1. **Periodic instead of per-update hash verification.** Add a counter so
   `_sendUpdate` computes/sends the verification hash every Kth update (or
   after a short idle gap) rather than on every single update, when
   `verifyUpdates` is on. Sequence-number gap detection continues to run on
   every message regardless (it's cheap — O(1) `Set` ops per message) and
   remains the primary defense; the hash becomes a periodic checkpoint. The
   wire format gains a flag bit indicating whether a hash follows, since
   messages without a fresh hash still need to be structurally valid.
2. **Debounce `syncNow()` triggered by `onPeerConnect`.** Collapse multiple
   `onPeerConnect` events arriving within a short window (e.g. via the same
   debounce pattern already used for awareness batching) into a single
   `syncNow()` call, instead of one per newly-connected peer.

Both are additive to the existing exponential-backoff/rate-limiting
machinery already in the file — no removal of existing safety nets, only
reduced trigger frequency where the measurement shows it's excessive.

## Part 3 — `DummyHub` scheduling (`src/providers/dummy/index.ts`), conditional on Part 1 findings

If Part 1 shows the benchmark itself bottlenecked by timer volume rather
than by the code under test: change `DummyHub.broadcast()` to group
recipients by their computed delay (recipients sharing the same
latency/jitter profile can be bucketed) and fire one `setTimeout` per
bucket that delivers to all recipients in that bucket, instead of one timer
per recipient. Must preserve today's per-recipient independent jitter
semantics (recipients can still land in different buckets) and per-recipient
drop-rate behavior. Test-infrastructure-only change; does not affect the
real wire protocol or any other provider.

## Testing / verification plan

- No existing automated test suite (per `CLAUDE.md`) — verification is
  running the new and existing bench scripts and comparing before/after
  numbers, plus a manual smoke test via `npm run dev:dummy` /
  `test/dummy/edge-cases.html` to confirm normal 2-3 client sync still works
  visually after the `src/index.ts` changes.
- Part 2 change #1 (periodic hash) must not regress the just-landed
  reordering-tolerance fix in `c048682` — rerun
  `test/dummy/bench-sync-latency.ts` after the change and confirm
  hash-mismatch/backoff-cap counts stay at or below the current baseline
  (21 mismatches / 0 backoff-cap hits across all profiles, captured above).
- Each of Part 2/3's changes ships with a one-line before/after number in
  its commit message (matching this repo's existing convention, e.g.
  `c048682`'s "239 → 21" style), sourced from the Part 1 benchmark.
