# Phase 1b: end the resync cascade, split the sync budget, fix the join-path gates — design

## Goal

Remove the self-sustaining resync cascade that research doc items 12 and
13 describe (a full-state push fails every peer ahead of the pusher; every
hash mismatch pushes the whole document to the room; every request
collects a reply from every peer ahead of the requester at latencies the
suppression window cannot cover), and fix three smaller join-path
inefficiencies the phase-1 measurements exposed. All on top of the digest
beacon (`2026-09-05-digest-beacon-design.md`), whose Results section is
the baseline for everything here.

## Context (measured, see the digest-beacon design doc Results and research items 12/13)

- Fan-out at N=100, one editor, 10 keystrokes, no loss, Gun profile
  (250 ms ± 30 %): 198,990 deliveries once every peer has a fresh budget —
  the limiter ceiling — with ~6,900 hash mismatches and ~210-280 resyncs.
  Identical before and after phase 1. WebSocket/WebRTC: 990.
- Every join into a room with content triggers a hash mismatch on every
  peer that holds more data (the joiner's push is a hashed update of the
  joiner's state).
- A join burst's replies spend the requester's own recovery budget (Task 3
  converged in 13 s once); a settled room answers K identical joiners with
  K replies each until the peer-count gate (awareness states ≥ 3) opens,
  which in a burst is after the beacons; presence responses at Matrix
  latency go out 2-3 times per peer per burst.

## Design

### Item 1 — resync cascade

**1a. The connect-time push is not a hashed update.** New private message
type `MESSAGE_SYNC_PUSH` (6): payload = `Y.encodeStateAsUpdate(doc)`.
Receivers apply it (`Y.applyUpdate`, origin `this`) and do nothing else —
no hash comparison, no sequence tracking, no `synced` flip (a SyncStep2
would flip `synced`, and an empty joiner's push must not make another
empty joiner believe it has the room's content). This is the
single-message-survival path for offline edits that round 2 requires,
kept; only its side effect on peers ahead of the pusher goes.

**1b. A resync trigger sends a beacon, not the document.**
`_requestResync()` keeps its coalescing and backoff but its action becomes
`_sendSyncStep1(0)` + `_armResponseWait(0)` — a 12-byte beacon, and a
re-beacon after 1 s / 2 s / 4 s (scaled by the RTT estimate below) if no
SyncStep2 or equal beacon arrives. Peers ahead of the requester reply with
exactly the missing diff (SyncStep2 against the requester's state vector,
suppressed as before); peers not ahead stay silent. This covers all three
triggers (hash mismatch, corrupted message, confirmed sequence gap) — each
means "I may be missing something", never "others are missing my data";
the latter is what *their* periodic beacons and the connect push are for.
`syncNow()` (public; connect) is unchanged: push + JOIN beacon.

**1c. Suppression window and response wait follow the measured RTT.**
~~`_rttEstimateMs` (EWMA, α = 0.3, seeded from the first sample)~~ **As
built (Task 3): the minimum of the last 8 samples** — a sample includes the
responder's random suppression delay, so a mean would feed the window back
into itself; the fastest reply carries the least delay. When a
JOIN/CONFIRM/resync beacon goes out, remember the time; the first
SyncStep2 or matching ack after it yields one RTT sample (an equal periodic
beacon ends the wait but is not a sample).
`_replySuppressionMaxDelay()` becomes
`min(2000, max(current formula, 1.5 · rtt))`; `_armResponseWait()`'s first
delay becomes `max(1000, 4 · rtt)`. With no sample yet both keep today's
values.

**Expected:** Gun/Matrix fan-out at N=100 with a fresh budget from ~199k
toward "990 + a few hundred": a false positive costs one beacon and at
most a handful of replies; joins into a room with content no longer make
N-1 peers push the document; Matrix N=100 join burst loses its premature
CONFIRM retries.

**Rejected:** dropping the connect push (offline edits would wait for the
other side's periodic beacon); keeping the hash on the push but adding a
clock-sum discriminator (item 12 option b — more wire, same effect as 1a
with more branches); asking for acks on resync beacons (measured in phase
1 Task 3c: 4-5× more acks at Matrix latency).

### Item 2 — two budgets

`_tryReserveSyncSlot()` splits into a *request* budget (beacons, pushes,
`syncNow()`) and a *reply* budget (SyncStep2, acks), each
`maxSyncRequestsPerWindow` per `syncRequestWindowMs` (defaults unchanged,
20 per 10 s). A burst of replies can no longer starve a peer's own
recovery, and vice versa. Both reset on disconnect as today.

### Item 3 — peer count from what we have actually heard

`_knownPeers: Set<number>` of clientIDs seen as beacon senders
(`_handleDigest` reads the field it currently skips) and as
`MESSAGE_SYNC_VERIFIED` senders. `_peerCount()` =
`max(awareness.getStates().size, _knownPeers.size + 1)` replaces the two
direct `awareness.getStates().size` reads (`_replyToSyncRequest` gate,
`_replySuppressionMaxDelay`). Cleared on disconnect. In a join burst the
gate now opens with the first beacons instead of after the awareness
messages that trail them.

### Item 4 — presence responses coalesce on their own window

A JOIN beacon no longer calls `_broadcastAwareness()` directly; it arms
`_presenceResponseTimer` (delay `clamp(2 · rtt, 100, 500)` ms, single
timer, further JOINs while armed are absorbed) whose callback does the
broadcast. One presence message per peer per burst regardless of how far
the burst is spread by latency.

### Compatibility

Type 6 joins types 3-5 as private wire format; same-version-room rule as
documented in the README. No new options.

## Benchmarks and gates

Baseline = `main` @ `55d36f7` (end of phase 1), `bench-dist-baseline/`
snapshot. Both regimes for every bench that edits after a join burst:
default timing and `SETTLE_MS=12000`.

Per item, before/after: `bench-user-scaling` (both regimes; the Gun/Matrix
fan-out N=100 cell is item 1's headline), `bench-join-after-burst`,
`bench-idle-room` (default and 15 s), `bench-late-join` ×1,
`bench-packet-loss` ×1 (both regimes), `bench-corruption-storm`,
`bench-periodic-awareness`. Final gate on the phase's last commit: the
phase-1 gate list at 3 × 3 with zero timeouts.

Hard requirements (any failure blocks the commit): every convergence gate
passes; `bench-corruption-storm` still converges at every corruption rate
(the mismatch → beacon path is also the corruption-recovery path);
`bench-idle-room` (b) still heals a lost delete.

**Bench change during the phase:** `bench-packet-loss` now runs its peers
with `syncInterval: 2000` (`SYNC_INTERVAL_MS` override; was 0 via
`makeProviders`). Reason, found after Task 2: a lost *last* keystroke has,
by design, no trigger but the periodic beacon (no later update opens a
sequence gap or a pending dependency, no hash to mismatch). The pre-phase
builds recovered it anyway, because every other lost message's resync
pushed the whole document to the room and carried it along; with the
cascade gone the N=5 / 10 % fan-out cell timed out in 1 of 3 samples on an
intermediate build. Measuring loss recovery without the mechanism the
README prescribes for lossy links (~2 s) was measuring the storm. Baseline
and final are both re-measured with the new setting; the phase-1 numbers
for this bench are not comparable to the phase-1b ones.

## Work items, in order (one commit each)

1. 1a push type + baseline numbers recorded
2. 1b resync → beacon + response wait
3. 1c RTT estimate → suppression window + wait
4. Item 2 budgets
5. Item 3 peer count
6. Item 4 presence coalescing
7. Final gate run, results, README note (type 6)

## Results

Appended per step as measured, baseline first.

### Baseline (`main` @ `55d36f7`, end of phase 1; `bench-dist-baseline/`)

Default-timing gate logs are the phase-1 "Task 3c final" set (see the
digest-beacon design doc). New for this phase:

**`bench-user-scaling` fan-out with tail counting** (deliveries until the
room is quiet for 1 s; `atConv` = at the moment every doc converged, the
old metric). One editor, 10 keystrokes, no loss:

| profile | N | default timing: until quiet / atConv | fresh budget (`SETTLE_MS=12000`): until quiet / atConv |
|---|---|---|---|
| WebSocket | 50 | 1,813 / 490 | 2,450 / 490 |
| WebSocket | 100 | 8,910 / 990 | 9,009 / 990 |
| WebRTC | 100 | 7,623 / 990 | 7,920 / 990 |
| Gun | 50 | 38,808 / 2,793 | **49,490** / 2,352 |
| Gun | 100 | 160,974 / 9,801 | **198,990** / 9,603 |
| Matrix | 50 | 36,799 / 2,450 | **49,490** / 2,744 |
| Matrix | 100 | 149,985 / 10,395 | **198,990** / 10,197 |

Every doc has the content within one latency; what follows is the
cascade. 49,490 and 198,990 are the limiter ceilings for N=50 and N=100.
Even WebSocket at N=100 carries a 9x tail behind its linear 990.

`bench-join-after-burst`: WebSocket in-budget 5,049 / 96 ms, fresh 7,205 /
64 ms; Matrix in-budget 33,365 / 341 ms, fresh 19,161 / 539 ms. Idle
census N=50: default 18,081, 15 s settle 24,402. Join burst N=50 (probe):
5,194 / 185 ms.

### After Task 1 — `MESSAGE_SYNC_PUSH` (design 1a)

Item 12 is gone: `bench-idle-room` (b)'s setup phase shows `setupWarns=none`
in every sample (was one hash mismatch + one resync per sample);
`bench-join-after-burst` pushes are exactly the K joiners' (445) with no
resync pushes behind them:

| profile | variant | baseline | Task 1 |
|---|---|---|---|
| WebSocket | in budget window | 5,049 / 96 ms (SyncStep2 490) | **3,873 / 56 ms** (SyncStep2 245) |
| WebSocket | fresh budget | 7,205 / 64 ms (SyncStep2 392) | **5,343 / 42 ms** (SyncStep2 245) |
| Matrix | in budget window | 33,365 / 341 ms (SyncStep2 20,618) | **15,241 / 500 ms** (SyncStep2 4,263) |
| Matrix | fresh budget | 19,161 / 539 ms (SyncStep2 4,361) | **15,486 / 519 ms** (SyncStep2 4,557) |

Join burst N=50: 5,684 / 173 ms (pushes now 5 bytes each: 4.8 KB for
1,225 deliveries vs 14.3 KB). Idle census N=50 default settle 19,502
(18,081): the post-join retry storm is smaller, not gone — the cascade's
other half is still there:

Fan-out Gun N=100, fresh budget (probe with tail): **198,990** — unchanged
— but hash mismatches 6,899 → **353** and resyncs 210 → **105**. What
remains: each of the ~105 resyncs still pushes the document and beacons,
and each beacon collects ~20 SyncStep2 replies (the 200 ms suppression
window is shorter than the 250 ms one-way latency), until the *reply*
budgets are spent (189,189 SyncStep2 deliveries ≈ 99 peers × 20 slots ×
99 recipients). Tasks 2 and 3 address exactly those two factors. The
remaining 353 mismatches are late keystrokes arriving after a resync reply
had already fast-forwarded the receiver — Task 2's late-update guard.

The per-task bench set for Task 1 (late-join, packet-loss both regimes,
user-scaling both regimes with tail) was still running when this was
committed. **Its late-join and packet-loss logs are not Task 1 numbers:**
that set ran from `bench-dist/`, which was rebuilt for Tasks 2-3 while
the set was still going, so those two benches loaded intermediate builds.
They are excluded from the record. From Task 2 on, every per-task set
runs from a per-task snapshot (`bench-dist-tN/`), and the loss/join
gates are run once, 3 × 3, on the final build (see "Final gates").

### After Task 2 — resync sends a beacon; mismatch triggers filtered (design 1b)

Three changes, the third found by measuring the first two:

1. `_requestResync()`'s action is a beacon plus response wait (retry with
   a plain beacon after 1 s / 2 s / 4 s), no document push.
2. A hash mismatch on an update that added nothing (every client it
   touches ends at a clock we were already past — `Y.parseUpdateMeta` vs.
   our state vector) is not a trigger: it is a keystroke that arrived after
   a resync reply had fast-forwarded us.
3. A hash mismatch on an update Yjs could not fully integrate
   (`doc.store.pendingStructs` / `pendingDs` non-null) gets the gap grace
   (`gapGraceMs`, 300 ms) and a beacon only if still pending afterwards.
   Measuring 1 + 2 alone left the mismatch count where Task 1 had it
   (343 vs 353) and the cascade at the ceiling: since the connect push no
   longer carries a sequence number, a peer's first keystroke can be the
   first numbered message a receiver sees from it, so a reordered first
   burst had no earlier number to open a sequence gap against, and the
   pre-existing "reordering suspected" guard never engaged. Yjs's own
   pending store is the exact signal (research doc item 4, dropped from
   phase 1 as speculative — it stopped being speculative here).

**Fan-out Gun N=100, fresh budget (probe with tail), the phase's headline:**

| | deliveries until quiet | hash mismatches | resyncs |
|---|---|---|---|
| baseline (end of phase 1) | 198,990 | 6,899 | 210 |
| Task 1 | 198,990 | 353 | 105 |
| Task 2, changes 1+2 | 198,990 | 343 | 144 |
| **Task 2, final** | **990** (the 10 keystrokes × 99, nothing else) | **0** | **0** |

The probe's window also catches the y-protocols 15 s awareness renewal
(9,900 deliveries) once the settle plus tail exceed 15 s; it is not part
of the cascade and is listed separately.

`bench-join-after-burst`: WebSocket in-budget 7,989 / 225 ms, fresh
3,971 / 52 ms; Matrix in-budget 15,437 / 524 ms, fresh 14,653 / 529 ms —
the in-budget WebSocket row varies run to run (3,873-7,989 across Task 1
and 2 runs; its SyncStep2 count swings between 245 and 4,557), a
single-run number; the per-task set below is the record. Two fresh peers
and a 3-peer simultaneous join still reach `synced` (probe).

The full per-task set for Task 2 (user-scaling both regimes with tail,
late-join, packet-loss both regimes, corruption-storm, idle census,
periodic-awareness) is recorded below once the queued run completes.

### After Task 3 — RTT-driven suppression window and response wait (design 1c)

The estimate is the **minimum** of the last 8 round trips (JOIN/resync
beacon → first SyncStep2 or ack), not an EWMA: a sample includes the
responder's random suppression delay, so a mean would feed the window
back into itself (a wider window → slower replies → wider window, up to
the cap); the fastest reply carries the least delay and tracks the real
latency. Equal periodic beacons end a response wait but are not samples.
Window = `min(2000, max(room-size formula, 1.5 · minRTT))`; first
response-wait delay = `max(1000, 4 · minRTT)`.

`bench-join-after-burst` (single run; the queued set is the record):

| profile | variant | Task 2 | Task 3 |
|---|---|---|---|
| WebSocket | in budget window | 7,989 / 225 ms (SyncStep2 4,557) | 5,392 / 50 ms (SyncStep2 **147**) |
| WebSocket | fresh budget | 3,971 / 52 ms (SyncStep2 392) | 5,735 / 42 ms (SyncStep2 **147**) |
| Matrix | in budget window | 15,437 / 524 ms (SyncStep2 4,655) | **11,811** / 604 ms (SyncStep2 **784**) |
| Matrix | fresh budget | 14,653 / 529 ms (SyncStep2 4,067) | **11,713** / 608 ms (SyncStep2 **784**) |

Replies to the K=10 joiners on Matrix: ~46 per joiner → ~8; the ~80 ms
of extra convergence time is the wider window doing its job. WebSocket
totals in this bench are dominated by the presence responses now (4,116 /
4,361 of ~5,500), as are Matrix's (~9,200 of ~11,800) — Task 6. Concurrent
late-join probe on Matrix (M=40, K=10, 10 keystrokes): 11,860 deliveries,
SyncStep2 1,029 (phase 1 end: 18,181 / 5,586), zero warnings.

### After Task 4 — separate request and reply budgets (design item 2)

`bench-idle-room` (a) with the **default** 2.5 s settle, i.e. measured
right after the 50-peer join burst: N=50 requests 18,081 (phase 1 end) →
19,502 (Task 1) → **24,843** — the floor (24,500), reached without waiting
out the limiter window, because the burst's replies no longer spend the
request budget. N=20: 3,895 (floor 3,800). (b) 5/5. `bench-join-after-
burst` single run: WebSocket in-budget 4,020 / 106 ms, Matrix in-budget
11,713 / 622 ms — within the Task 3 spread; the in-budget variant is what
this change is for, and its per-task set is the record.

### After Task 5 — peer count from beacon and update senders (design item 3)

`_knownPeers` (beacon senders, verified-update senders) backs
`_peerCount()`, used by the suppression gate and the window formula; the
awareness-only count stays as a floor. Also folded in here, found while
checking this task: the pending-struct check (Task 2, change 3) now defers
to an outstanding request of ours — a joiner that receives keystrokes
before its content has a JOIN response wait running, and firing a second
beacon at 300 ms only raced the settled peers' suppression window.

`bench-join-after-burst`, three consecutive runs on this build — the
WebSocket "in budget window" row is the one cell of this bench that
swings: 5,147 / 9,606 / 4,020 deliveries (SyncStep2 392 / 6,272 / 588),
converging in 56-260 ms; all other rows are stable (WebSocket fresh
3,726-5,882 with SyncStep2 245-392; Matrix in-budget 11,419-11,909 with
SyncStep2 735-1,029, ~600 ms; Matrix fresh 11,909-12,007). Mechanism of
the swing, from the class counts: one settled peer is typing while the ten
empty joiners arrive, so the byte-identical-reply dedupe misses whenever a
keystroke lands between two JOIN beacons (the SyncStep2 for an empty
requester changes bytes), and a joiner that has already received the
content answers later joiners' JOIN beacons itself (it *is* ahead of them)
— both correct, both redundant with the settled peers' replies, both
racing suppression at 15 ms latency. Deduping by requested state vector
instead of reply bytes would remove the first; noted for a later phase,
not done here. Join burst N=50 (probe): 5,880 / 174 ms. Two fresh peers and
a 3-peer simultaneous join reach `synced`.

### After Task 6 — presence responses coalesced (design item 4)

One timer per peer answers every JOIN beacon that arrives within
`clamp(2 · minRTT, 100, 500)` ms of the first. `bench-join-after-burst`,
two runs, awareness class: Matrix in-budget 9,069-9,265 → **3,561**,
Matrix fresh 9,167 → **3,140**; total Matrix deliveries 11.4-12.0k →
**5.6-6.2k**. WebSocket unchanged (2,891: at 15 ms latency the 100 ms
cursor throttle already coalesced a burst). `bench-periodic-awareness`
Part 2 still passes: the late joiner sees all five presence states after
137 ms (was 33-36 ms; the coalescing delay is ~100 ms at WebSocket RTT),
inside the 330 ms bound, and is `synced` after 47 ms.

The WebSocket "in budget window" row of `bench-join-after-burst` swung
again (9,998 / 9,802 with SyncStep2 ~6,100 in two consecutive runs; 4,363
vs 9,606 in two runs of the equivalent probe). A per-sender breakdown of
the probe pins it: all of those SyncStep2s come from the settled peers,
~3 per peer, and the joiners' acks drop to 1 (their pending acks are
cancelled by the flood of overheard SyncStep2s). Cause: the ten keystrokes
are broadcast in the same tick as the ten JOIN beacons, so at each settled
peer keystroke and beacon arrivals interleave at random; every keystroke
that lands between two beacons changes the bytes of the reply to an empty
requester, the byte-identical dedupe misses, and the pending reply is
flushed as "a different request" — up to ten flushed replies per settled
peer instead of one. Fixed next (Task 7): dedupe by the requested state
vector and refresh the pending reply's bytes instead of flushing.

### After Task 7 — replies deduplicated by requested state vector

`_scheduleSyncReply()` now also remembers the requester's state vector a
pending SyncStep2 answers; a later request with the same state vector
refreshes the pending reply's bytes to the current document and keeps the
timer, instead of flushing the old reply. Byte-identical dedupe stays for
the cases it covers; acks and replies to plain SyncStep1s (no target
known) keep the flush behaviour.

Concurrent late-join probe, WebSocket, three runs: 4,461 / 5,147 / 5,000
deliveries with 8 / 20 / 17 SyncStep2 messages from the settled peers
(before: 4,363 or 9,606 with 7 or 119). `bench-join-after-burst`, two
runs: WebSocket in-budget **4,706 / 5,343** (SyncStep2 539 / 1,176;
before: 9,802-9,998 with ~6,100), fresh 4,559 / 4,461; Matrix in-budget
6,283 / 6,205, fresh 5,539 / 5,784. All variants PASS; two fresh peers and
a 3-peer simultaneous join reach `synced`.

### Per-task fast sets (each from that task's frozen build, `bench-dist-tN/`)

`bench-user-scaling` **fan-out N=100, deliveries until quiet** (default
timing / fresh budget):

| build | WebSocket | WebRTC | Gun | Matrix |
|---|---|---|---|---|
| baseline | 8,910 / 9,009 | 7,623 / 7,920 | 160,974 / 198,990 | 149,985 / 198,990 |
| Task 1 | 9,702 / 9,009 | 8,217 / 8,415 | 161,469 / 198,990 | 150,084 / 198,990 |
| Task 2 | **990 / 990** | 990 / 990 | **990 / 990** | **990 / 990** |
| Tasks 3-5 | 990 / 990 | 990 / 990 | 990 / 990 | 990 / 990 |
| Tasks 6-7 | 10,791* / 990 | 10,791* / 990 | 990 / 990 | 990 / 990 |

\* Not fan-out traffic: in the default-timing variant the edits start
145 ms after the 100-peer join, and Task 6 moved the join's coalesced
presence responses from ≤ 100 ms to ~130-150 ms after the first JOIN
beacon (2 × RTT), so exactly one presence broadcast per peer (99 × 99 =
9,801) now falls inside the counting window. The fresh-budget column and
the Gun/Matrix rows (settle ≥ 850 ms) show the fan-out itself: 990.

`bench-user-scaling` **join-burst N=100** (default / fresh): baseline
WebSocket 18,018 / 19,602, Matrix 84,150 / 84,447 → Task 7 16,335 /
18,612 and **69,201 / 69,300**; Gun 59,400 → 50,985. Matrix remains the
expensive profile: with no RTT sample yet, a joiner's first response wait
is the 1 s floor, shorter than the Matrix round trip plus suppression, so
many joiners send a CONFIRM retry that collects acks — a transport-provided
latency hint for the first wait is the obvious phase-1c item.

`bench-join-after-burst` (deliveries; WebSocket in-budget / fresh, Matrix
in-budget / fresh): baseline 5,049 / 7,205 / 33,365 / 19,161 → Task 7
**4,804 / 4,167 / 6,009 / 6,078**, all converging in ≤ 600 ms. Idle census
N=50 default settle: 18,081 → 24,598 (floor 24,500) from Task 4 on.
`bench-corruption-storm` N=10 at 5 % corruption: 774 → 756-873 messages
(ratio 1.06 → 1.07-1.5), both RESULT lines pass on every build.
`bench-periodic-awareness`: 4/4 PASS on every build; joiner presence 33-37
ms through Task 5, 133-138 ms from Task 6 (the coalescing delay), `synced`
24-58 ms.

### After Task 8 — a joiner's wait ends only with data or a confirmed peer's word

Found by the final gate: `bench-late-join` run 1, "join during edit burst",
WebSocket, 3 % loss, M=10 K=5 — 2/3. Repeating that cell (150 ×, 6 s cap,
`syncInterval: 0`) on the Task 7 build failed 5 times, always a *joiner*
that reported `synced` while lacking content, in three shapes:

- **missing 1 keystroke:** the last update was lost and nothing later
  arrived to open a gap — by design only the periodic beacon recovers
  this; the bench now runs one (see the packet-loss note above).
- **missing 10 (all keystrokes, content present):** the joiner received
  the keystrokes before its SyncStep2 (all pending on the first one, which
  was lost), the pending check fired while the JOIN response wait was
  running and — as of Task 5 — deferred to it and never looked again.
  Fixed: the check re-arms while a request is outstanding.
- **missing 510 (empty document, `synced`):** the joiner's SyncStep2 was
  lost; an *equal ack from a fellow empty joiner* then ended its response
  wait, so nothing ever asked again. Fixed with `DIGEST_FLAG_SETTLED`
  (bit 3): every beacon and ack carries whether its sender is *confirmed*
  — has received a SyncStep2, or an equal digest from a confirmed peer,
  or asked three times and got nothing better (the bootstrap for a
  brand-new room). Only data or an equal digest with that bit satisfies a
  joiner's wait; `synced` keeps its phase-1 meaning ("some peer has my
  state") — the two are now different things, and the design doc for
  phase 1 §4 should be read with that in mind.

Cost: in a brand-new room nobody is confirmed for the first ~7 s, so the
first peers each retry their JOIN three times (CONFIRM beacons, no
presence) before bootstrapping — join burst N=50 in an empty room (probe):
5,880 → 7,203 deliveries. Rooms with a settled peer pay nothing: its acks
carry the bit. Task 8 replaces Task 5's "defer" rule and is the last code
change of the phase; the final gates below ran on this build.

### Final gates (Task 8 build, `bench-dist-t8/`; baseline = end of phase 1 with the same bench scripts)

**Every gate passes:** `bench-sync-latency`, `bench-late-join`,
`bench-packet-loss` 3 × 3 runs with every cell 3/3, `bench-packet-loss`
fresh budget 1 run all cells, `bench-corruption-storm` both RESULT lines,
`bench-idle-room` (b)/(c), `bench-join-after-burst` 4/4,
`bench-periodic-awareness` 4/4. `bench-sync-latency` `Hash mismatch`
warnings: **0 / 0 / 0** (phase 1 end: 9-21 per run); `msgCount` 30-32 per
cell (30-31 before — the +1 is a joiner's CONFIRM retry in a fresh 2-peer
room).

**The headline** — `bench-user-scaling` fan-out N=100 with a fresh budget,
deliveries until the room is quiet:

| profile | end of phase 1 | phase 1b |
|---|---|---|
| WebSocket | 9,009 | **990** |
| WebRTC | 7,920 | **990** |
| Gun | 198,990 | **990** |
| Matrix | 198,990 | **990** |

Ten keystrokes reach 99 peers as ten updates each, and nothing else
happens. The default-timing fan-out rows on this build (WebSocket 23,760,
Gun 43,560, Matrix 30,492) are not fan-out traffic: the edits start
145-1,150 ms after a 100-peer join into an *empty* room, and that window
now contains the join's coalesced presence responses (Task 6) and the
first JOIN retries of peers that are not yet confirmed (Task 8); the
fresh-budget column and the Gun/Matrix rows of every earlier task show
the cascade itself is gone.

**`bench-late-join`** (M=40, K=10, `syncInterval: 2000` in both builds):

| scenario | profile | end of phase 1 | phase 1b (3 runs) | mismatch column |
|---|---|---|---|---|
| idle late join | WebSocket | 5,067 | 4,137-5,135 | 0 → 0 |
| idle late join | Matrix | 13,585 | 14,803-15,416 | 0 → 0 |
| join during edit burst | WebSocket | 7,760 | **5,263-5,361** | 1,436 → **0** |
| join during edit burst | Matrix | 41,370 | **16,332-19,636** | 6,040 → **0** |

**`bench-packet-loss`** (N=50, `syncInterval: 2000` in both builds; mean
messages to convergence, then mean ms):

| profile | loss | end of phase 1 | phase 1b, 3 runs | ms: before → after |
|---|---|---|---|---|
| WebSocket | 1 % | 3,724 | 1,584 / 14,226 / 1,584 | 168 → 570-860 |
| WebSocket | 3 % | 7,677 | 6,860 / 7,677 / 7,873 | 157 → 690-780 |
| WebSocket | 5 % | 8,542 | 9,473 / 8,003 / 10,094 | 154 → 600-1,030 |
| WebSocket | 10 % | 25,578 | 12,381 / 15,353 / 9,326 | 256 → 670-770 |
| Matrix | 1 % | 8,167 | 7,187 / 7,285 / 7,383 | 574 → 491-564 |
| Matrix | 10 % | 20,972 | 10,192 / 8,542 / 7,791 | 630 → 610-660 |

Fresh budget (1 run each): WebSocket 1/3/5/10 % 2,107 / 3,610 / 2,205 /
8,412 → 1,323 / 4,426 / 2,466 / 2,581; Matrix 9,424 / 8,477 / 9,996 /
11,809 → 3,528 / 5,259 / 3,430 / 4,149. Message counts are flat across
loss rates now where they used to grow with loss; **recovery latency on
WebSocket went up** from ~0.2 s to ~0.6-1.0 s at N=50: a lost keystroke
is now healed by one gap-grace period (300 ms) plus a beacon round trip,
where before it was healed — along with the rest of the storm — by the
first of many full-document pushes. That is the intended trade; the grace
period is an existing option (`gapGraceMs`) for deployments that prefer
the other side of it.

**Everything else on the final build:** join burst N=50/100 WebSocket
5,978 / 17,721 (18,018 before), Matrix 19,747 / 81,774 (84,150 before —
Task 8's fresh-room retries gave back most of Task 6's Matrix gain, see
the phase-1c note); `bench-join-after-burst` WebSocket 4,461 / 4,363,
Matrix 5,774 / 5,735 (baseline 5,049 / 7,205 / 33,365 / 19,161); idle
census N=50 24,598 default and 15 s (floor 24,500); corruption-storm N=10
at 5 %: 900 messages (774), ratio 1.05; late joiner presence 136 ms,
`synced` 34 ms.

**What this phase did not do (phase 1c candidates, in order):** a
transport-provided latency hint to seed the first response wait (the
Matrix join burst still pays CONFIRM retries); dedupe of the `synced`
semantics against `_confirmed`; `Transport.sendTo`; the idle-backoff
default; the orphaned subdoc work.
