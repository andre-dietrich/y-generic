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
`_rttEstimateMs` (EWMA, α = 0.3, seeded from the first sample): when a
JOIN/CONFIRM/resync beacon goes out, remember the time; the first
SyncStep2 or matching ack after it yields one RTT sample.
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
committed; recorded with Task 2.

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
