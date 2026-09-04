# Further sync message-count reduction — design

## Goal

Reduce the number of messages `GenericProvider` needs to converge a room when
peers come online/offline, when sync errors occur (corruption, hash
mismatch), or under network problems (loss, jitter, reordering) — building on
the three rounds of optimization already landed (see
`docs/superpowers/specs/2026-07-26-dummy-benchmark-scaling-design.md` and
`docs/superpowers/plans/2026-07-26-sync-storm-ratelimit.md`): the shared
rate-limit gate, `syncNow()`'s push+pull sharing that gate, and SyncStep2
NACK-suppression.

## Context

Reading `src/index.ts` end to end (1611 lines) plus the two prior design
docs surfaced one bug and three further optimization opportunities that
weren't addressed by the prior three rounds. Each item below gets its own
benchmark evidence before/after — the prior work's own history (Task 2 in
the 2026-07-26 plan expected a 5-10x reduction, measured only 1.3x, and the
real bottleneck turned out to be something else entirely) is a direct
warning against shipping any of these on reasoning alone.

**Scale target:** same as the prior work — up to ~50-100 simulated peers in
one room via `DummyTransport`/`DummyHub`. Primary metric: message count.
Bytes-on-wire and wall-clock are secondary/explanatory.

**Out of scope (unchanged from the prior design doc, still true):**
- Any change to `Transport` (`src/transport.ts`) itself, e.g. real unicast
  send — bigger than this work justifies, per the prior doc's own decision.
- Incremental/delta state-vector hashing — no evidence it's a bottleneck.
- Compact session-scoped client IDs.

## Work items, in order

### 1. Bug fix: clear gap-check state on `disconnect()`, not just `destroy()`

**Problem:** `destroy()` (`src/index.ts:602-606`) clears
`_gapCheckTimers`; `disconnect()` (`src/index.ts:510-587`) does not. A gap
check scheduled before a `disconnect()`/reconnect cycle survives into the
new connection and can fire `_requestResync()` against sequence-number state
from the *previous* session — a spurious resync (extra push+pull messages)
right after a peer reconnects, which is the opposite of this project's goal.

**Fix:** in `disconnect()`, clear every timer in `_gapCheckTimers` (mirroring
`destroy()`'s loop) and clear `_remoteSeqInfo`, so a fresh connection starts
gap-detection from a clean slate — matches how `_syncRequestTimes` is already
reset in `disconnect()` for the same "don't inherit stale state" reason.

**Validation:** new script `test/dummy/bench-reconnect-cycling.ts` — repeated
disconnect/reconnect cycles for 2-5 simulated peers (some cycles introduce a
genuine sequence gap via `dropRate`, some don't), asserting: (a) no
spurious `Sequence gap confirmed` warning fires for a gap that existed only
in a *prior* session, (b) total resync count and message count across N
cycles is measured before/after the fix. This is a correctness check first,
message-count reduction second.

### 2. Drop the "push full state" half of resync-triggered retries

**Problem:** `_requestResync()`'s scheduled retry (`src/index.ts:1205-1259`)
always calls `_trySyncPushPull()`, which pushes `Y.encodeStateAsUpdate(this.doc)`
(the *entire* document) to the whole room **and** sends a SyncStep1 pull —
for every hash-mismatch, corrupted-message, and confirmed-gap trigger. The
pull half already gets a targeted, diffed reply via the standard
SyncStep1→SyncStep2 exchange (further trimmed by NACK-suppression). The push
half exists so that offline edits reach peers without a round-trip — but
that only matters at `connect()` time. On a mid-session resync trigger, any
peer that's missing our data will eventually SyncStep1 us via its own
periodic sync or its own mismatch detection; broadcasting our full state
unprompted on every trigger is a genuine second message where the pull alone
would let the standard protocol supply exactly what's missing.

**Fix:** give `_trySyncPushPull()` a `push: boolean` parameter (default
`true`). `connect()`'s call to `syncNow()` and the public `syncNow()` API
keep pushing (default `true` / unchanged public behavior). `_requestResync()`'s
retry calls it with `push: false` — pull-only.

**Validation:** rerun (not just once) `bench-corruption-storm.ts`,
`bench-packet-loss.ts`, `bench-late-join.ts`, and — the hard correctness
gate, per the historical lesson that the first NACK-suppression prototype
passed once and then broke — `bench-sync-latency.ts` at least 3 times,
requiring zero `Timeout waiting for convergence` errors on every run. Compare
message counts before/after using the same repeated-sampling discipline as
the 2026-07-26 doc (10+ runs at higher N, report mean/range, not a single
sample).

### 3. Coalesce `onPeerConnect`-triggered `syncNow()` bursts

**Problem:** `connect()`'s `onPeerConnect` handler (`src/index.ts:454-463`)
calls `syncNow()` once per newly-connected remote peer, completely
uncoalesced. On a mesh transport where N peers join in a short window, this
fires up to N near-simultaneous `syncNow()` calls, each broadcasting full
state to everyone already connected — CLAUDE.md already documents this as a
known O(N²) risk (`peerjs`/`simple-peer`) that hasn't been fixed. This
mirrors exactly the pattern `_requestResync()` already solves for its own
triggers (one pending timer absorbs a burst instead of each trigger acting
independently) — `_requestResync()` itself is not reused here because its
resync semantics (exponential backoff, escalation counter, `push:false` per
item 2) are specific to error recovery, not peer-join notification; this
gets its own small debounce.

**Fix:** add `_pendingPeerConnectSyncTimeoutId` state; `onPeerConnect`'s
callback schedules a short debounced `syncNow()` call (window: reuse
`_syncReplySuppressionMs`-scale, e.g. a new `peerConnectDebounceMs` option,
default ~50ms) instead of calling `syncNow()` immediately — a burst of
connect events within that window collapses to one `syncNow()` call.

**Test infra needed:** `DummyTransport`/`DummyHub` doesn't implement
`onPeerConnect` today (confirmed by reading `src/providers/dummy/index.ts`
in full — no such method). Add a minimal simulation: `DummyHub.join()` gains
an optional notification to already-joined clients' `onPeerConnect`
subscribers when a new client joins the room (mirroring what a real mesh
transport does), and `DummyTransport` implements `onPeerConnect` by
subscribing to that. This is in scope per the prior design doc's own
scope note (`src/providers/dummy/index.ts` is explicitly listed as
touchable).

**Validation:** new script `test/dummy/bench-mesh-join-burst.ts` — an
already-settled room of M peers, then K peers join within a short window
(simulating mesh peer-discovery), measuring total messages attributable to
`onPeerConnect`-triggered syncs before/after the debounce, across a range of
K (e.g. 5/10/25). Also assert convergence still completes (no peer stuck
unsynced) — the debounce must not silently drop peers that connect after the
window closes.

## Order of execution

1 → 2 → 3, each as its own commit with its own before/after bench numbers,
same discipline as the 2026-07-26 plan (build, bench, record real numbers in
the commit message, not projected ones). Item 3 is last because it's the
only one requiring new test infrastructure, and its payoff is unconfirmed
until measured — if 1 and 2 already produce a satisfying reduction, 3 can be
descoped after its own benchmark is written and run, per YAGNI, without
having blocked on it earlier.

## Testing / verification plan

- No automated test suite (per `CLAUDE.md`) — verification is the listed
  bench scripts (new and existing), before/after, plus `npm run dev:dummy`
  manual smoke test after each item.
- Every "reduction" claim uses repeated sampling (per the 2026-07-26 doc's
  own hard-learned rule: single-sample comparisons at higher N are not
  reliable) — mean and range over 10+ runs where N >= 50, not one run.
- Item 2 and 3 must not regress `bench-sync-latency.ts` (zero convergence
  timeouts, hash-mismatch/backoff-cap counts within the established noisy
  baseline range) — run it 3+ times per item, not once.
- `npm run build` must pass with no TypeScript errors after each item;
  `dist/` is committed (tracked despite `.gitignore`, per CLAUDE.md) and
  must be rebuilt in the same commit as any `src/index.ts` change.
