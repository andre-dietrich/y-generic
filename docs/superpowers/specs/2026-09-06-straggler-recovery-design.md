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
Matrix profile. When it fires: if we are disconnected, or a request of
ours went out within the last grace (`_requestSentAt`; its answer is
still on its way), nothing; otherwise, if our current state vector is
still behind the remembered one, `_requestResync()` — the existing
coordinator (coalesced, exponential backoff, rate-limited) sends the
beacon and arms the response wait. Not "a response wait is outstanding":
a new room's first peers keep their JOIN wait parked for seconds (three
retries, nobody SETTLED yet), and gated on that the check never fired in
`bench-idle-backoff` (Task 4's first measurement, 1,846 ms unchanged).

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

### D. Idle backoff on by default, activity re-arms the timer at once

`idleBackoffEnabled` defaults to `true`, `idleBackoffMaxMs` stays 60 s.
With A, a peer that lost the last update before the room went idle is
healed by the *typist's* next beacon, so the loser's own backed-off
interval no longer bounds the recovery — provided the typist's beacon
does come soon. It did not: `_markActivity()` only stamped a time, and
the interval was reset to the base at the *next tick*, up to the
backed-off interval away (the option's doc comment claimed "immediately";
Task 3's measurement shows the 1,845 ms that claim was hiding). Now any
activity on a backed-off peer clears the pending tick and re-arms it at
the base interval (at most once per idle stretch, since the interval is
then at the base until the next quiet tick). Measured in
`bench-idle-backoff` part (b) before and after; the option stays for
those who want the fixed cadence.

### F. The pending-struct check defers only to a recent request (found by the final gates)

`_schedulePendingCheck` deferred to *any* outstanding response wait
("look again once that request is answered"). A new room's first peers
keep their JOIN wait parked for three retries with nobody SETTLED yet —
19.6 s on a 700 ms link with the phase-1c hint — so a peer that lost a
keystroke in such a room never asked on its own; in phase 1c it was
rescued by the SyncStep2 broadcasts that other peers' requests drew
(`_noteResponse(true)` clears the wait), and with design B thinning those
broadcasts the fresh-budget Matrix fan-out took 1.5-2.2 s instead of
0.5-0.9 s. The check now defers only if a request of ours went out within
`max(gapGraceMs, 2 · minRTT)` — the same rule as design A's behind check,
for the same reason.

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
5. F — pending check defers only to a recent request (found by the
   Task 4 final gates); measure with the fan-out-under-loss probe and the
   per-task set; final gates again.
6. Final gates, results, research-doc status.

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

### After Task 2 — peers with pending structs do not answer (design B; `bench-dist-t1d2`; logs `after1d-t2`)

`bench-corruption-storm` (2 s beacon), 50 % cells, 3 runs: relay N=2 /
5 / 10 converge in 0.06-0.30 / 0.06-0.20 / 0.10-0.61 s (baseline
0.20-0.55 / 0.06-0.63 / 0.08-0.25), unicast 0.16-0.41 / 1.18-1.34 /
1.18-3.10 s (baseline 0.22-0.35 / 0.87-0.99 / 1.4-2.9) — within noise,
every RESULT line passes. `bench-join-after-burst`, still the
`syncInterval 0` build of that bench (compiled before Task 1's beacon
change): **unicast WebSocket "in budget window" converged in all 3 runs
(53 / 53 / 94 ms; 1,850-1,853 deliveries)** where the baseline stalled 3
of 3 under the same parallel load — the pending-struct inheritance was
the common case of the stall. Relay unchanged (WebSocket 4,412-4,461 /
4,118-4,412, Matrix 5,482-5,531 / 3,775-4,314). Fan-out-under-loss probe
(Matrix, N=50): fresh median 4,018 (2,842-5,537), 848 ms; default 4,312
(3,773-5,488), 1,100 ms — the Task 6 numbers. `bench-user-scaling` join
burst N=100 within noise (Gun 18,414 / Matrix 17,523 / WebRTC 17,622 /
WebSocket 20,988; fan-out fresh 990 everywhere).
With the beacon build of `bench-join-after-burst` (rebuilt `t1d2`, 3 runs
per mode): relay WebSocket in-budget 4,461-4,559 / fresh 4,020-4,706,
Matrix 7,491-7,550 / 5,418-5,743 (baseline 4,216-4,510 / 3,961-4,637,
7,158-7,697 / 5,537-6,018); unicast WebSocket in-budget 1,843-3,362 (86 /
103 / 1,033 ms) / fresh 1,974-2,180, Matrix 4,095-4,110 / 2,941-7,132
(728 / 929 / **2,446 ms**). Every run converged; the two slow ones are
joiner-47-type stragglers healed by their *own* periodic beacon — design
B closes the pending-struct source, not the in-flight-keystroke one; that
is design A's job (any peer's beacon, after the grace).
`bench-idle-backoff` unchanged (recovery median 41 ms off / 1,741 ms on).

### After Task 3 — behind check + pending check after replies (designs A and E; `bench-dist-t1d3`; logs `after1d-t3`)

Nothing got more expensive, and the loss gates hold: `bench-user-scaling`
join burst N=100 Gun 18,018 / Matrix 17,226 / WebRTC 18,810 / WebSocket
16,434 (Task 2: 18,414 / 17,523 / 17,622 / 20,988), fan-out N=100 fresh
990 on every profile (the behind check schedules timers during typing and
sends nothing); idle census N=50 24,696 (Task 2 build ~24,600);
`bench-periodic-awareness` 4/4; fan-out-under-loss probe Matrix fresh
median 3,969 / 841 ms, default 4,214 / 1,055 ms (Task 2: 4,018 / 848,
4,312 / 1,100); `bench-late-join` and `bench-packet-loss` ×1 in both
modes: every cell 3/3. `bench-corruption-storm` 50 % cells, 3 runs: relay
0.06-0.31 / 0.08-0.13 / 0.10-1.05 s (N=2/5/10), unicast 0.14-0.26 /
0.16-1.20 / 2.56-3.84 s — within the Task 2 ranges; the unicast N=10 cell
is paced by the 2 s beacon (a straggler is healed by the first beacon
that shows it behind plus the 300 ms grace), not by the 5 s backoff.
`bench-join-after-burst` (beacon build): relay unchanged (WebSocket
4,314-4,608, Matrix 7,589-8,226 in-budget); unicast WebSocket in-budget
67 / 1,032 / 1,037 ms — the two ~1 s cases are joiners whose three
responders all stayed silent (transient pending structs while the
keystroke burst reorders at 40 receivers), healed by the response wait's
1 s CONFIRM retry; the baseline had the same ~1,030 ms case in one run of
three, before design B existed.

**`bench-idle-backoff` recovery did not move: median 1,845 ms with
backoff on (baseline 1,843).** The bench drops the update from A to B and
then keeps both peers quiet; design A assumed A's next beacon comes at the
base interval because A had activity — but `_markActivity()` only stamps
a time, and the interval is reset to the base at the *next tick*, which
is still up to the backed-off interval away. So A's beacon arrives no
sooner than B's own. Design D therefore also makes activity re-arm the
periodic timer at the base interval immediately (the option's doc comment
already claimed this).

### After Task 4 — idle backoff on by default, activity re-arms the timer (design D; `bench-dist-t1d4`; logs `after1d-t4`)

`bench-idle-backoff` part (b), recovery of the update dropped just before
the room went idle (300 ms base / 2.4 s cap), two runs:

| | backoff off | backoff on, before | backoff on, after |
|---|---|---|---|
| trials | 28-305 ms | 1,604-1,862 ms | 142-792 ms |
| median | 202-204 ms | 1,843-1,846 ms | **753-770 ms** |

The chain is now: the typist's beacon at the base interval (re-armed by
its own edit), the loser's behind check one grace (300 ms) later, the
resync coordinator's 100 ms, the round trip — ~740 ms in the timeline
probe, three of three. At the defaults (5 s base) that is about one base
interval instead of up to 60 s. Part (a) unchanged: 71-74 → 23-24 idle
messages in the 9 s window. The first measurement of this task, with the
behind check gated on "a response wait is outstanding", was 1,846 ms —
the JOIN wait of a new room's first two peers stays parked for 7 s, and
the check never fired; hence the `_requestSentAt` condition in design A.

Nothing else moved: `bench-idle-room` census N=50 24,696 in the 10 s
window (bench forces backoff off) and 51,156 in a 60 s window with
backoff on (phase 1c measured 52,920 on / 156,555 off — the re-arm fires
only on activity, a quiet room is as quiet as before), LOSTDELETE 5/5
with backoff on and off (with backoff on,
the lost delete-only update heals in 66-930 ms — design A again);
`bench-user-scaling` join burst N=100 Gun 19,008 / Matrix 17,721 / WebRTC
18,216 / WebSocket 17,919, fan-out fresh 990; `bench-periodic-awareness`
4/4; `bench-corruption-storm` ×1 both modes pass (unicast N=10 at 50 %:
3.0 s); `bench-join-after-burst` ×1 both modes pass; `bench-late-join`
relay ×1 every cell 3/3.

### Final gates on the Task 4 build — relay mode (`bench-dist-t1d4` = commit `4f8bdd3`; logs `after1d-final-relay`; superseded by Task 5, kept for the finding)

Every gate passes: `bench-sync-latency` ×3 with 0 hash-mismatch warnings,
`bench-late-join` ×3 and `bench-packet-loss` ×3 + fresh with every cell
3/3, both `bench-corruption-storm` RESULT lines, `bench-periodic-
awareness` 4/4 (presence 133 ms, synced 66 ms), `bench-idle-room`
LOSTDELETE 5/5 in both regimes. Phase-1c final (Task 6 build) → phase-1d
final, relay mode:

| bench | cell | 1c final | 1d final |
|---|---|---|---|
| late-join idle, M=40 K=10 | WebSocket / Matrix | 4,530-5,118 / 6,858-7,205 | 4,862-5,044 / 6,832-6,861 |
| late-join during edits, M=40 K=10 | WebSocket 0 % / 3 % | 4,724-5,231 / 4,838-5,312 | 5,378 / 4,740 |
| late-join during edits, M=40 K=10 | Matrix 0 % / 3 % | 6,097-6,444 / 6,360-6,686 | 5,990 / 6,123 |
| packet-loss fan-out N=50, default regime | WebSocket 1-10 % | 1,111-2,123 | 1,045-1,846 (one 1 % run 3,512) |
| packet-loss fan-out N=50, default regime | Matrix 1-10 % | 3,071-4,737 | 3,201-4,377 |
| packet-loss fan-out N=50, fresh regime | WebSocket / Matrix 1-10 % | 866-1,568 / 2,189-3,071 | 1,078-1,601 / **1,519-2,319** |
| user-scaling join burst N=100, default / fresh | Gun / Matrix | 17,622 / 17,622, 18,018 / 17,523 | 17,622 / 17,721, 17,028 / 18,513 |
| user-scaling join burst N=100, default / fresh | WebSocket / WebRTC | 20,790 / 16,236, 23,958 / 15,840 | 20,493 / 17,028, 17,127 / 22,968 |
| user-scaling fan-out N=100, fresh | all profiles | 990 | 990 |
| join-after-burst (2 s beacon since 1d) | WebSocket in-budget / fresh | 4,461-4,559 / 4,020-4,706 (1d baseline) | 4,412 / 4,216 |
| join-after-burst (2 s beacon since 1d) | Matrix in-budget / fresh | 7,158-7,697 / 5,537-6,018 (1d baseline) | 7,942 / 4,412 |
| idle census N=50 | default / 15 s | 24,745 / 24,598 | 24,500 / 24,843 |
| corruption N=10 | 5 % | 846 | 909 |

Convergence: fan-out N=50 default regime WebSocket 564-888 ms (1c
493-796), Matrix 999-1,210 ms (1,000-1,321); **fresh regime Matrix
1,524-1,867 ms (1c 696-881)**, WebSocket 582-766 ms (105-266 — that
range was the pre-1d "spent-budget-free" best case; the default regime
did not move). The fresh-regime Matrix cell trades a third of its
deliveries for 0.8-1.0 s: with design B, responders that are transiently
reordering the burst (Matrix jitter puts keystrokes 100 ms apart out of
order at many receivers) stay silent, and a request that finds all of
them so is answered only on the response wait's retry (4 × RTT ≈ 2 s) or
the next beacon plus grace. Examined with a variant probe below.

### After Task 5 — the pending check defers only to a recent request (design F; `bench-dist-t1d5`; logs `after1d-t5`, `varcmp`, `varcmp2`)

The fresh-budget Matrix fan-out, taken apart with the probe (N=50, 1/3/5/10
% loss, 3 samples each, medians):

| build | deliveries | SyncStep2 | convergence |
|---|---|---|---|
| 1c final (`t1c6`) | 3,822 | 1,225 | 761 ms (504-858) |
| Task 4 build (`t1d4`) | 6,762 | 1,029 | 2,079 ms (1,323-2,215) |
| Task 4 build, design B relaxed (answer while the reordering is inside the grace) | 7,105 | 1,127 | 2,166 ms |
| Task 4 build, design B removed | 6,909 | 1,274 | 2,166 ms |
| **Task 5 build** (`t1d5`) | **2,744** | 637 | **1,336 ms** (1,228-1,582) |
| Task 5 build, design B relaxed | 2,744 | 735 | 1,355 ms |
| Task 5 build, design B removed | 2,646 | 784 | 1,307 ms |
| Task 5 build, idle backoff off | 4,508 | 1,274 | 883 ms (724-952) |

Three things fall out. **(1)** Design B costs nothing here — strict,
relaxed and removed are the same; it stays strict. **(2)** The Task 4
build's 2.1 s was the pending check parked behind the JOIN wait
(timeline: `pendingCheck wait=true attempts=2 sentAt=-3.6 s` five times
in a row, then a request only once an overheard reply cleared the wait;
"before burst: waits outstanding=50, confirmed=0" — a fresh 50-peer room
on a 700 ms link stays unconfirmed for 19.6 s). Design F removes that:
the loser asks 300 ms after the gap shows, one coordinator delay and one
round trip later it is healed — 1.2-1.4 s at this latency, every time.
**(3)** The remaining gap to 1c (1.34 s vs 0.76 s, with 30 % fewer
deliveries) is idle backoff, now on by default: the bench's 12 s settle
is an idle room, the 2 s beacon had backed off to 8 s, and in 1c the
periodic beacons that happened to fall into the first second of the burst
drew broadcast replies that healed every loser at once. With backoff off
on the same build: 883 ms and 4,508 deliveries. So the price of design D
in this cell is half a second of recovery after an idle stretch, paid in
exchange for the idle traffic; the recovery itself no longer depends on a
beacon landing by chance. A cheaper first beacon after backoff (re-arm at
a random point inside the base interval instead of a full one) would buy
some of it back — noted, not done.

Per-task set on the Task 5 build: `bench-corruption-storm` 3 runs per
mode, every RESULT line passes (50 % cells: relay 0.04-1.25 s, unicast
0.10-2.99 s); `bench-join-after-burst` 3 runs per mode, all converged
(relay WebSocket in-budget 4,510-4,608 / fresh 4,167-4,461, Matrix
7,550-7,893 / 3,971-4,461; unicast WebSocket 1,850-3,220 (52 / 79 / 820
ms) / 1,829-1,836, Matrix 4,098-4,115 / 1,341-1,727); `bench-idle-backoff`
recovery median 731 ms on / 203 ms off (part a: 23 vs 71);
`bench-user-scaling` join burst N=100 Gun 17,919 / Matrix 18,018 / WebRTC
21,087 / WebSocket 16,731, fan-out fresh 990; idle census N=50 24,990;
`bench-periodic-awareness` 4/4; `bench-late-join` and `bench-packet-loss`
×1 in both modes: every cell 3/3.

### Final gates — relay mode (`bench-dist-t1d5` = commit `68e8b25`; logs `after1d5-final-relay`)

Every gate passes: `bench-sync-latency` ×3 with 0 hash-mismatch warnings,
`bench-late-join` ×3 and `bench-packet-loss` ×3 + fresh with every cell
3/3, both `bench-corruption-storm` RESULT lines, `bench-periodic-
awareness` 4/4 (presence 133 ms, synced 33 ms), `bench-idle-room`
LOSTDELETE 5/5 in both regimes. Phase-1c final (Task 6 build) → phase-1d
final, relay mode:

| bench | cell | 1c final | 1d final |
|---|---|---|---|
| late-join idle, M=40 K=10 (3 runs) | WebSocket / Matrix | 4,530-5,118 / 6,858-7,205 | 4,607-5,004 / 6,901-7,253 |
| late-join during edits, M=40 K=10 | WebSocket 0 % / 3 % | 4,724-5,231 / 4,838-5,312 | 4,315-5,280 / 5,146-5,231 |
| late-join during edits, M=40 K=10 | Matrix 0 % / 3 % | 6,097-6,444 / 6,360-6,686 | 5,793-6,004 / 6,653-6,869 |
| packet-loss fan-out N=50, default regime | WebSocket 1-10 % | 1,111-2,123 | 915-2,368 |
| packet-loss fan-out N=50, default regime | Matrix 1-10 % | 3,071-4,737 | 3,479-5,096 |
| packet-loss fan-out N=50, fresh regime | WebSocket / Matrix 1-10 % | 866-1,568 / 2,189-3,071 | 1,111-2,238 / **1,617-2,499** |
| packet-loss join burst N=50, 0-10 % | WebSocket / Matrix | 4,296-5,913 / 4,247-4,655 | 4,459-6,615 / 4,198-4,639 |
| user-scaling join burst N=100, default / fresh | Gun / Matrix | 17,622 / 17,622, 18,018 / 17,523 | 18,612 / 18,810, 17,919 / 17,523 |
| user-scaling join burst N=100, default / fresh | WebSocket / WebRTC | 20,790 / 16,236, 23,958 / 15,840 | 18,117 / 17,523, 31,878 / 33,957 |
| user-scaling fan-out N=100, fresh | all profiles | 990 | 990 |
| join-after-burst (2 s beacon since 1d) | WebSocket in-budget / fresh | 4,461-4,559 / 4,020-4,706 (1d baseline) | 4,363 / 4,314 |
| join-after-burst (2 s beacon since 1d) | Matrix in-budget / fresh | 7,158-7,697 / 5,537-6,018 (1d baseline) | 7,579 / 4,069 |
| idle census N=50 | default / 15 s | 24,745 / 24,598 | 24,500 / 24,745 |
| corruption N=10 (2 s beacon since 1d) | 5 % | 846 | 1,008 |

Convergence: fan-out N=50 default regime WebSocket 464-746 ms (1c
493-796), Matrix 1,007-1,239 ms (1,000-1,321); fresh regime WebSocket
474-752 ms, Matrix 1,289-1,340 ms (1c 696-881 — the idle-backoff price
analysed under Task 5; the same build with backoff off: 883 ms);
late-join unchanged (Matrix during edits 1,658-1,716 ms; idle WebSocket
190-205 ms). The WebRTC join burst at 31,878 / 33,957 is the noisy cell,
not a change: a direct probe of that cell (N=100, 20 ms ± 10 %, three
runs per build) gives 27,522-33,264 on this build and 29,898-33,759 on
the 1c build — at that low jitter the 99 responders' suppression timers
fall close together and more replies fire before any is overheard; the
bench's own runs of it today spread 15,840-33,957 across builds. The
three other profiles sit where they were.

### Final gates — unicast mode (`bench-dist-t1d5`; logs `after1d5-final-unicast`)

`DUMMY_UNICAST=1`: every gate passes — `bench-sync-latency` ×3 with 0
hash-mismatch warnings, `bench-late-join` ×3 and `bench-packet-loss` ×3 +
fresh with every cell 3/3, **both `bench-corruption-storm` RESULT lines
(50 % cells: N=2 0.31 s, N=5 1.06 s, N=10 2.96 s; phase 1c: N=5 and N=10
did not converge)**, `bench-join-after-burst` all variants (78 / 52 / 694
/ 774 ms; phase 1c: one 30 s stall), `bench-periodic-awareness` 4/4,
`bench-idle-room` LOSTDELETE 5/5 in both regimes, no STALL dump anywhere.
Phase-1c final (Task 6 build) → phase-1d final, unicast mode:

| bench | cell | 1c final | 1d final |
|---|---|---|---|
| late-join idle, M=40 K=10 (3 runs) | WebSocket / Matrix | 951-976 / 4,731-4,754 | 945-973 / 4,719-4,754 |
| late-join during edits, M=40 K=10 | WebSocket 0 % / 3 % | 1,355-1,361 / 3,466-4,239 | 1,355-1,359 / **2,291-2,905** |
| late-join during edits, M=40 K=10 | Matrix 0 % / 3 % | 4,397-4,779 / 5,282-6,427 | 4,465-4,574 / 5,117-6,967 |
| packet-loss fan-out N=50, default regime | WebSocket / Matrix 1-10 % | 3,106-4,440 / 4,586-5,772 | 775-3,841 / 3,322-5,769 |
| packet-loss fan-out N=50, fresh regime | WebSocket / Matrix 1-10 % | 2,125-3,678 / 3,349-7,887 | 1,092-4,011 / 2,348-8,498 |
| packet-loss join burst N=50, 0-10 % | WebSocket / Matrix | 5,158-5,319 / 2,703-2,855 | 5,164-5,304 / 2,715-2,858 |
| user-scaling join burst N=100, default / fresh | Gun / Matrix | 10,934 / 10,887, 10,911 / 10,932 | 10,907 / 10,907, 10,887 / 10,865 |
| user-scaling join burst N=100, default / fresh | WebSocket / WebRTC | 20,814 / 20,832, 20,807 / 20,807 | 20,777 / 20,806, 20,768 / 20,778 |
| join-after-burst (2 s beacon since 1d) | WebSocket in-budget / fresh | not converged (30 s) / 1,834 | 1,843 / 1,835 |
| join-after-burst (2 s beacon since 1d) | Matrix in-budget / fresh | 2,154 / 1,348 | 4,107 / 1,386 |
| idle census N=50 | default / 15 s | 24,451 / 24,647 | 24,892 / 24,402 |
| corruption N=10 (2 s beacon since 1d) | 5 % | 800 | 853 |

Convergence, unicast: late-join during edits at 3 % loss WebSocket
658-742 ms (1c 819-1,318), Matrix 2,074-3,081 ms (2,375-3,155); fan-out
N=50 default regime WebSocket 466-1,232 ms (795-1,693), Matrix 1,413-2,309
ms (1,618-2,498); fresh regime WebSocket 1,020-2,203 ms, Matrix
2,140-4,150 ms (1c 2,219-3,813). The Matrix join-after-burst in-budget
variant carries the 2 s beacon round that now lands in its window
(request=1,960, as in the 1d baseline of that bench); everything else is
equal or better, and the two stall classes of phase 1c are gone with the
periodic beacon the benches now run with.
