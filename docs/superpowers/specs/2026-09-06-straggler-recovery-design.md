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

### C. Corruption bench: realistic beacon, diagnostics

`bench-corruption-storm` runs its peers with `syncInterval` 2000
(override `SYNC_INTERVAL_MS`, as `bench-packet-loss` and `bench-late-join`
since phase 1b): with `0` a peer left behind by corruption has no
fallback at all, which is a statement about the option, not the protocol.
Both it and `bench-join-after-burst` print every non-converged peer's
state (length, typist clock, pending structs, response wait, resync
timer, budgets, `synced`) when a run fails, so the next rare stall is
captured instead of counted.

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

1. C — bench beacon + diagnostics; baseline runs of the corruption bench
   with the beacon on the current code (both modes).
2. B — no partial responders; measure.
3. A — behind check; measure (headline: unicast corruption 50 % cells,
   `bench-idle-backoff` recovery, fan-out-under-loss probe).
4. D — default flip + README; measure `bench-idle-backoff` and
   `bench-idle-room` (60 s window).
5. Final gates, results, research-doc status.

## Results

Appended per step as measured, baseline first.
