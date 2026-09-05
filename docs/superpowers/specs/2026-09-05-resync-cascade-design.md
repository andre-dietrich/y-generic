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
