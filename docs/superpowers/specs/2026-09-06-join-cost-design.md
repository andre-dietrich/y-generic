# Phase 1e: presence relay, one-round bootstrap, ranked reply delay, edit-only backoff reset — design

## Goal

Take the remaining peer-count-proportional terms off the join path and
the active-room beacon on *relay* transports (WebSocket, PubNub, Supabase,
Matrix, Nostr, Gun, Ably), where phase 1c's unicast path does not apply.
Builds on phases 1-1d; baseline = `main` @ `20d0541` (end of phase 1d).

## Context (measured on `20d0541`, probe `test/dummy/bench-join-census.ts`)

One late joiner into a settled room with content, relay mode, deliveries:

| profile | N | total | presence | SyncStep2 sends |
|---|---|---|---|---|
| WebSocket | 100 | 12,300 | 10,100 | 10 |
| Gun | 100 | 14,993 | 10,100 | 23 |

Presence is 82 % of a late join: every peer answers the JOIN with its own
state, coalesced per burst (phase 1b) but still N−1 broadcasts of N−1.

A concurrent join burst of N empty peers into an *empty* room, counted
until the room is quiet (not until "all synced", which is what
`bench-user-scaling` counted):

| N | at all-synced | until quiet | of which CONFIRM retries + their acks |
|---|---|---|---|
| 50 | 3,822 | 22,393 | ~10,200 |
| 100 | 19,206 | 91,971 | ~42,600 |

Nobody is SETTLED in a fresh room, so every peer's response wait runs its
three CONFIRM retries (1/2/4 s, on Matrix 2.8/5.6/11.2 s), each a beacon
to N−1 that draws acks. The retries exist for loss; here everyone answered.

Relay-mode reply suppression draws its delay uniformly from
`[0, 1.5 · RTT]`; with one-way latency L about N·L/W repliers fire before
the first reply is overheard — 10-23 SyncStep2 sends per request above,
and the 16-34k spread of the WebRTC join-burst cell in phase 1d's gates.

Idle backoff (on since 1d) resets on *any* activity, remote updates
included: while one peer types, all N beacon at the base interval,
N·(N−1) deliveries per 5 s against N−1 per keystroke.

## Design

### 1. One-round bootstrap in a fresh room

An equal ack or equal beacon from an *unsettled* peer sets
`_equalUnsettledSeen` (it does not end the wait — a settled peer with
content may still answer). When the wait expires with that flag set,
retry once (a CONFIRM, so a slow holder gets a second chance), and if the
retry's wait also expires with only unsettled-equal answers, become
confirmed: two rounds instead of three, and the first joiners' acks then
carry SETTLED for everyone after them. `_responseWaitAttempts >= 3` stays
the fallback when nobody answers at all. Expected: fresh-room CONFIRM
beacons from 3·N to ≤ 2·N... measured below (the burst's acks are deduped
by the equal-beacon rule, so the ack term shrinks more than linearly).

Rejected: confirming on the first unsettled-equal ack with no retry —
saves one more round but a JOIN lost only to the content holder (per-link
loss on a mesh) would then wait for that holder's backed-off beacon.

### 2. Ranked reply delay in relay mode

`_responderRank(requester)` — the rank count `_selectedResponder` already
computes (hash of requester, 2 s bucket and peer id over `_knownPeers`) —
becomes the reply delay: `min(rank, 8) · slot`, `slot = max(0.75 · minRTT,
syncReplySuppressionMs)`; ranks ≥ 8 add a random spread of one window on
top (an avalanche guard if the first eight are all gone). Rank 0 answers
at once; rank r fires only after it could have overheard rank r−1's reply.
Overhearing and cancelling stay as they are. With no RTT sample or no
requester id (legacy SyncStep1) the uniform window remains.
`_selectedResponder` = `_responderRank(requester) < 3`, unchanged.

### 3. Presence relay on JOIN (relay path only)

`_schedulePresenceResponse` keeps its timer. When it fires on the
broadcast path: if `_responderRank(0) === 0` for the current bucket (one
relayer per 2 s bucket, independent of the requester), send the whole
awareness table (`encodeAwarenessUpdate(awareness, all state keys)`) as
one broadcast; else, if an awareness message that carried *our* clientID
at our current clock arrived since the timer was armed (`_presenceCovered`,
set in the MESSAGE_AWARENESS branch by decoding the update's client list),
send nothing; else broadcast our own state as today. The relayer's timer
delay is 0 (same-tick coalescing only); everyone else keeps
`clamp(2 · minRTT, 100, 500)`, which is at least one one-way latency after
the relayer's send wherever an RTT estimate exists. y-websocket's server
relays presence exactly this way; clocks are preserved by the encoding, a
peer's own echoed state at an equal clock is ignored by
`applyAwarenessUpdate`. Bytes are unchanged (the table goes to everyone);
message count per late join drops from (N−1)² to about N. The unicast
path (one unicast per joiner) stays.

### 4. Idle backoff resets on local edits only

`_markActivity()` stays the re-arm point, but is called only from the doc
update handler for *local* edits (`origin !== this`) and from the
corruption branch (evidence we lost something). Remote updates and any
awareness change no longer reset a backed-off timer: a listener has
nothing a beacon would announce, and with design A of phase 1d the
typist's base-interval beacon heals any listener that lost the keystroke.
Also the phase-1d note: the re-arm fires at a random point inside the base
interval instead of a full one.

### Bench changes (Task 0)

- `test/dummy/bench-join-census.ts` (from the probe): (a) one late joiner
  into a settled room with content, (b) a fresh-room join burst counted
  until 3 s of quiet; deliveries per class, N ∈ {50, 100}, WebSocket and
  Gun profiles, `DUMMY_UNICAST` honoured.
- `bench-user-scaling` join burst counts until the room is quiet for 1 s
  (cap 15 s), like its fan-out has since phase 1b; `atConv` keeps the old
  number.

## Gates

Per item: `bench-join-census`, `bench-user-scaling` (join burst both
modes; fan-out fresh), `bench-join-after-burst` (both modes),
`bench-idle-room`, `bench-idle-backoff`, `bench-periodic-awareness`. Final
on the last commit: the phase-1d gate list ×1 in both modes
(`bench-sync-latency`, `bench-late-join`, `bench-packet-loss` default +
fresh, `bench-corruption-storm`, `bench-idle-room` LOSTDELETE); every
convergence gate must pass.

## Results

Appended per step as measured, baseline first.
