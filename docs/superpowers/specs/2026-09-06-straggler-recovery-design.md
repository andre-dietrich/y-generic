# Phase 1d: straggler recovery — ask when a beacon shows us behind, no partial responders, idle backoff on by default

## Goal

Close the recovery gap that phase 1c's unicast gates exposed: a peer that
is behind and has no signal of its own (its last update lost, or its
request answered by a responder that was itself behind) currently waits
for its *own* next periodic beacon — up to `syncInterval`, and up to
`idleBackoffMaxMs` with idle backoff on. After this phase any beacon from
a peer that is ahead of us triggers our request (after a grace that lets
in-flight updates arrive), responders that know they are incomplete stay
silent, the corruption bench runs with a realistic beacon, and idle
backoff is on by default because its worst case is gone.

## Context (measured at the end of phase 1c, main @ `abc7852`)

- Unicast mode, `bench-corruption-storm` (fixed bench, `syncInterval: 0`):
  the N=5 and N=10 cells at 50 % converge only at the 5 s resync backoff
  or not within 15 s (about one run in three has a stall); relay mode
  converges the same cells in 0.04-0.4 s. `bench-join-after-burst`'s
  WebSocket "in budget window" variant stalled once in five unicast runs
  (30 s), 40 instrumented repeats afterwards all passed in 33-86 ms.
- Mechanism (design doc 1c, "Finding from the unicast final gates"): a
  requester's response wait ends on the first SyncStep2 it receives
  (`_noteResponse(true)`), also when that reply came from a responder
  with pending structs or one that had not yet received the latest
  keystrokes. In relay mode other responders' broadcasts fill the rest
  in; a unicast reply heals only its addressee. `_handleDigest` does
  nothing when a beacon shows the *sender* ahead of us (`weBehind`).
- Idle backoff (design doc 1c, Task 4): −66 % deliveries in the first
  idle minute at N=50, converging to 12× less at the 5 s default
  interval; cost: a single keystroke lost for one peer in an idle room is
  healed only by that peer's own backed-off beacon — median 226 → 1,845
  ms in `bench-idle-backoff` (300 ms base / 2.4 s cap), up to 60 s at the
  defaults. The typist's own beacon 5 s later already shows every loser
  it is behind; nobody acts on it.

## Design

### A. Ask when a beacon shows us behind (`weBehind`)

In `_handleDigest`, for every non-ack beacon whose state vector is ahead
of ours (`weBehind`), remember that state vector and arm one check timer
(`_behindCheckTimer`, coalesced: a newer beacon that shows us behind
replaces the remembered vector, the timer keeps running) with delay
`max(_gapGraceMs, 2 · minRTT)` — 300 ms on a 15 ms link, ~1-1.4 s on the
Matrix profile. When it fires: if we are disconnected or a request of
ours is outstanding (`_responseWaitTimer`), nothing (that request is
being answered or retried); otherwise, if our current state vector is
still behind the remembered one, `_requestResync()` — the existing
coordinator (coalesced, exponential backoff, rate-limited) sends the
beacon and arms the response wait.

Why the grace: during typing at Matrix latency almost every receiver of a
periodic beacon is "behind" by a keystroke that is still in flight
(jitter ±140 ms); the check finds those caught up and does nothing. The
cost of a false positive is one 12-byte beacon × (N−1); the check is
timers only. Storm check: a lost keystroke that opens a sequence gap is
already requested by the gap check at 300 ms — the behind check then sees
the outstanding request and stays quiet; only the lost *last* update (no
gap) and the partially-answered requester gain a trigger, and they gain
it at the next beacon of any up-to-date peer (≤ `syncInterval` + grace)
instead of their own next beacon.

### B. Peers that know they are incomplete do not respond

At the top of `_replyToSyncRequest`: if `doc.store.pendingStructs !==
null || doc.store.pendingDs !== null`, return without replying. A
SyncStep2 is encoded from integrated structs only, so such a reply is
provably partial and its recipient needs another round; an ack from such
a peer confirms a state it cannot trust. Applies to relay and unicast
alike: in relay mode a partial broadcast reply also cancels the complete
replies other peers had pending (`_cancelPendingSyncReply` on any
overheard SyncStep2). The requester's response wait retries; in unicast
mode the 2 s rank bucket rotates the responders. Deliberately *not*
gated on "a request of ours is outstanding": two peers that each lack the
other's last update would then both stay silent for the 7 s of their
retries, while their (mutually partial but each complete for the other)
replies heal both at once.

### C. Join benches: realistic beacon, diagnostics

`bench-corruption-storm` and `bench-join-after-burst` run their peers with
`syncInterval` 2000 (override `SYNC_INTERVAL_MS`, as `bench-packet-loss`
and `bench-late-join` since phase 1b): with `0` a peer left behind — by
corruption, or a joiner whose reply predates the typist's last keystroke
— has no fallback at all, which is a statement about the option, not the
protocol. Both print every non-converged peer's state (length, typist
clock, pending structs, response wait, resync timer, budgets, `synced`)
when a run fails, so a rare stall is captured instead of counted. The
first such capture (baseline, below) is what turned design B from a
heuristic into a diagnosis: joiners stranded with *pending structs*,
`synced`, no request outstanding, never having requested a resync.

### E. A reply that leaves us with pending structs arms the gap check

`Y.encodeStateAsUpdate` — hence a SyncStep2 — includes the encoder's own
*pending* structs. A responder that is itself missing a struct therefore
hands its requester the same hole: the requester integrates what it can,
inherits the pending rest, flips `synced` and clears its response wait
(`_noteResponse(true)`), and nothing checks the store — the pending-struct
grace check (`_schedulePendingCheck`) was armed only from the
hash-mismatch branch of the *update* handler. Design B removes the
source; E removes the consequence: after applying a SyncStep2 or a push,
if `doc.store.pendingStructs`/`pendingDs` is non-null, arm the same grace
check, which requests the difference through the coordinator once the
response wait is over. Belt and braces, both cheap.

### D. Idle backoff on by default

`idleBackoffEnabled` defaults to `true`, `idleBackoffMaxMs` stays 60 s.
With A, a peer that lost the last update before the room went idle is
healed by the *typist's* next beacon (the typist had activity, its
interval is at the base), so the loser's own backed-off interval no
longer bounds the recovery. Measured in `bench-idle-backoff` part (b)
before and after; the option stays for those who want the old cadence.

## Benchmarks and gates

Baseline = `main` @ `abc7852` (snapshot `bench-dist-t1c6`; logs
`after1c6-final-*`, `corr-fixed`). Per task: `bench-corruption-storm`
(both dummy modes), `bench-join-after-burst` (both), `bench-idle-backoff`,
`bench-user-scaling` (both regimes), `bench-idle-room`,
`bench-periodic-awareness`, the fan-out-under-loss probe. Final gate on
the last commit: the phase-1c gate list, 3 × 3, in both dummy modes.

## Work items

1. C — bench beacons + diagnostics; baseline runs of both benches with
   the beacon on the current code (both modes).
2. B — no partial responders; measure.
3. A + E — behind check, pending check after replies; measure (headline:
   unicast corruption 50 % cells, join-after-burst unicast, `bench-idle-
   backoff` recovery, fan-out-under-loss probe).
4. D — default flip + README; measure `bench-idle-backoff` and
   `bench-idle-room` (60 s window).
5. Final gates, results, research-doc status.

## Results

Appended per step as measured, baseline first.

### Baseline (`main` @ `abc7852` + the Task 1 bench changes; logs `base1d`)

`bench-corruption-storm` with the 2 s beacon, 3 runs per mode, 50 % cells
(converged / convergence): relay N=2 0.20-0.55 s, N=5 0.06-0.63 s, N=10
0.08-0.25 s, every RESULT line passes; unicast N=2 0.22-0.35 s, N=5
0.87-0.99 s, N=10 1.4-2.9 s, every RESULT line passes — the beacon turns
the 1c stalls into "within one beacon interval" (the 5 s backoff no longer
decides). `bench-join-after-burst` still with `syncInterval 0` at this
point (the beacon was added to it after these runs, see below): relay
WebSocket in-budget 4,265-4,853 / fresh 4,167-4,363, Matrix 5,590-6,021 /
3,873-4,314, all converged; **unicast WebSocket "in budget window": 3 of 3
runs stalled** (30 s; 7,511-7,882 deliveries) — under the parallel load of
two bench processes, where the timing that produces the stall is common.
Captured state of the stranded joiners, e.g.:

```
STALL joiner 43: len=2005/2010 typistClock=2005 pending=true wait=false waitAttempts=0 resyncTimer=false resyncAttempts=0 reqBudget=1 synced=true confirmed=true
STALL joiner 47: len=2009/2010 typistClock=2009 pending=false wait=false ... resyncAttempts=0 synced=true confirmed=true
```

Two kinds. Joiners 43/44/49-type: `synced`, no request outstanding, never
requested a resync, *pending structs* — a SyncStep2 from a responder that
was itself missing a keystroke (in flight) handed over the hole (design
E's diagnosis; design B's source). Joiner 47-type: one keystroke short,
no pending structs — the responder answered before the typist's last
keystroke reached it, and that keystroke was broadcast before the joiner
was in the room; with `syncInterval 0` nothing can ever tell it (design
C's beacon, design A's trigger). `bench-idle-backoff`: idle messages
72 → 23 with backoff on; recovery of the update dropped before idle
median 68 ms (off) vs 1,843 ms (on), the number design D has to fix.

`bench-join-after-burst` with the 2 s beacon (3 runs per mode): all
variants converge in both modes. Relay WebSocket in-budget 4,216-4,510 /
fresh 3,961-4,637, Matrix 7,158-7,697 / 5,537-6,018 (the beacons of the 50
peers now land inside Matrix's ~600 ms window: request=1,568-1,960);
unicast WebSocket in-budget 1,842-3,683 (64 / 104 / **1,030 ms** — the
third run is a joiner-47-type straggler healed by the first periodic
beacon, ~1 s after the join) / fresh 2,081-2,315, Matrix 4,099-4,102 /
3,181-3,227. This is the 1d baseline for that bench; the 1c numbers
(syncInterval 0) are not comparable.
