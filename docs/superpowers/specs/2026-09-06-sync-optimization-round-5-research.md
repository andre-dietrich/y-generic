# Sync optimization — round 5 research (per-peer periodic emissions, per-keystroke framing)

## Context

Rounds 1-4 (2026-07-26 … 2026-09-06) removed the recovery storms, the empty
SyncStep2 replies, the join-path O(N²) terms, the resync cascade and the
straggler stalls, and added unicast replies and transport wire hints. What
is left, by construction, are the **per-peer periodic emissions** — every
peer beacons once per interval and renews its awareness once per 15 s, so an
idle room still costs O(N²) deliveries per period — and the **per-keystroke
framing**: one document update plus one awareness update per keystroke.
None of the ideas below was considered in the round-3/4 docs (grepped for
trickle, visibility, locks, piggyback, keep-alive, `'change'`,
`onPeerDisconnect`: no hits).

## Status

Research **and implementation** (branch `round-5`, from `main` @
bd77eb9): on 2026-09-06 André asked for the plan to be executed with a
before/after benchmark for every change. The "Results" section at the end
records each item as it lands, with the exact commands. Items 6, 9 and 10
wait for the decisions listed under "Decisions for André".

Method as in rounds 1-4: read `src/index.ts` end to end (3,584 lines at
the start of the round), the y-protocols awareness source, every provider
(what each backend's SDK offers that the transport does not surface); two
throwaway probes for the baseline, turned into `test/dummy/bench-typing-census.ts`
and a steady-state mode of `bench-idle-room.ts`; an adversarial code-path
review of the four main items before implementing (its rules are quoted
per item); web research for the prior art per item (sources at the end).

## Measured baseline (this session, throwaway probe, `main` @ bd77eb9)

Throwaway probe against the bench build (`DummyHub`, 20 ms ± 5, relay
mode, `disableBc`, defaults: `syncInterval` 5000, idle backoff on,
`awarenessInterval` 100); reproduced by the benches named in "Results".

### A. Typing — one keystroke = text insert + cursor awareness

(what y-quill, y-codemirror.next and y-prosemirror all do: they dedupe the
cursor by relative position, and a keystroke moves it)

| N | typists | keystroke gap | settle | deliveries / keystroke | sends / keystroke | update | awareness | digest | SyncStep2 |
|---|---|---|---|---|---|---|---|---|---|
| 20 | 1 | 200 ms | 3 s | 52.1 (N-1 = 19) | 2.74 | 950 | 950 | 475 | 228 |
| 20 | 1 | 100 ms | 3 s | 49.4 | 2.60 | 1,900 | 1,900 | 570 | 570 |
| 20 | 5 | 200 ms | 3 s | 50.5 | 2.66 | 4,750 | 4,750 | 2,071 | 1,064 |
| 50 | 1 | 200 ms | 3 s | 199.9 (N-1 = 49) | 4.08 | 2,450 | 2,450 | 3,430 | 1,666 |
| 50 | 1 | 200 ms | 90 s (steady) | 148.0 / 149.0 (two runs) | 3.02 / 3.04 | 2,450 | 4,851 | 98 | 0 / 49 |

Four findings:

1. **Two wire messages per keystroke** (update + cursor awareness), each a
   broadcast: the cursor update always goes out as its own message, even
   though a document update is leaving in the same millisecond. At the
   100 ms throttle a 10-keys/s typist still sends every cursor sample.
2. **In the steady state the third message per keystroke is the room's
   awareness renewal**: 4,851 awareness deliveries = 50 cursor sends + 49
   renewals, i.e. all 49 listeners renewed inside the 10 s window. The
   renewals are phase-locked to the join (everyone set their state within
   the same second, y-protocols renews at `lastUpdated + 15 s`), so they
   arrive as one burst every 15 s. Amortised, renewals are a third of a
   typing room's traffic at N=50.
3. **Periodic beacons answered for in-flight keystrokes — base cadence
   only.** In the first ~75 s after a join (or with idle backoff off) a
   peer's periodic beacon is behind the room by whatever keystroke is in
   flight (20-45 ms window out of 200), and rank-0 responders answer at
   once with a SyncStep2 carrying the keystroke the sender is about to
   receive anyway: 34 replies to 70 beacons in 10 s at N=50 — 1,666 of
   9,996 deliveries (17 %); 8 % at N=20 with five typists. Once the
   listeners are backed off it is one reply per ~10 s (~1 %).
4. Digest beacons are 34 % of the N=50 base-cadence traffic and 1 % in the
   steady state (only the typist beacons at 5 s; phase 1e).

### B. Idle room at the backoff cap (N=50, settle 90 s, observe 60 s)

| deliveries / 60 s | /s | /s/peer | sends | awareness (renewals) | digest (beacons) |
|---|---|---|---|---|---|
| 12,250 | 204 | 4.1 | 250 | 9,800 (80 %) | 2,450 (20 %) |

Exactly the two floors (N(N-1)·60/15 and N(N-1)·60/60). Once idle backoff
has done its work, **80 % of what an idle room still costs is the
y-protocols 15 s awareness renewal**, which no round so far has touched;
the other 20 % is one beacon per peer per minute, each a full broadcast.

## Items, ranked by expected payoff / effort

Every item is "worth measuring", not "should ship" (the round-4 rule).

### 1. One keystroke, one message: piggyback pending awareness on outgoing updates

**Finding.** Baseline A.1. The machinery exists — `MESSAGE_BATCH` and
`_tryImmediateAwarenessMessage()` fold awareness into the connect-time
batch (`_trySyncPushPull`'s `buildExtra`) — but the per-keystroke path
(`_setupDocumentSync` → `_sendUpdate`, `src/index.ts:1447-1470`) never
looks at `_pendingAwarenessClients`.

**Idea.** Any outgoing wire message carries whatever awareness change is
pending: in the immediate-update path and the `_batchUpdate` flush, send
`_sendBatch([update, ...pendingAwareness])` and clear the awareness timer;
symmetrically, when the awareness throttle fires with a batched update
pending (`batchUpdates > 0`), flush both in one batch; the periodic tick
can carry pending awareness too. The throttle still bounds *separate*
awareness messages; a piggybacked one costs no message, only ~200 B.
Classic piggybacking (TCP delayed ACK, RFC 1122 §4.2.3.2; Nagle, RFC 896).

**Expected.** Typing traffic −33 % in the steady state (3.0 → 2.0 sends
per keystroke; the remaining third is item 2's renewal) and −50 % of the
update+awareness classes on every transport; on Matrix (Synapse
`rc_message` 0.2/s) it halves the PUT count a typist burns. Cursor-only
movement unchanged.

**Review (code-traced this session): holds.** `MESSAGE_BATCH` dispatch
(1738-1748) recurses in send order with the same `from`; the
`MESSAGE_SYNC_VERIFIED` and `MESSAGE_AWARENESS` cases share no state;
`_trackRemoteSeq` is per verified sub-message; the other tab applies the
BC copy with origin `this` and returns. Rules for the design: update
first in the batch; piggyback only on `_send` broadcasts, never on
`_sendDirect` or the BC-only publishes; on piggyback commit
`_lastAwarenessTime` and clear `_awarenessTimeoutId` exactly as
`_tryImmediateAwarenessMessage` does; if the carrier is rate-limited, fall
back to `_broadcastAwareness` as `_syncNow` does today (1341-1343).

**Validation.** New `test/dummy/bench-typing-census.ts` (probe part B):
sends per keystroke 3.0 → 2.0, deliveries per class; `bench-sync-latency`
convergence unchanged.

### 2. Awareness lease: transport liveness first, then a configurable timeout

**Finding.** Baseline B: after backoff, 80 % of an idle room and a third of
a typing room is y-protocols' own renewal (`awareness.js:59-77`:
`_checkInterval` every 3 s, renew at `outdatedTimeout/2` = 15 s, remove at
30 s). The provider treats both constants as given (only
`meta.get(...).clock` is read, at 2790). Liveness is the true floor of a
broadcast room — every peer must be heard once per lease, N(N-1)/lease
deliveries — so the only levers are the lease length and a membership
signal that does not travel as N-1 broadcasts. Seven providers receive
exactly that signal and drop it (survey this session): PubNub subscribes
with `withPresence: true` and its presence listener only logs; Ably calls
`presence.enter()`/`leave()` but never `presence.subscribe()`; Supabase
presence is unused; Matrix parses away `m.room.member`; trystero's
`onPeerLeave` only decrements a counter; peerjs' coordinator even
broadcasts `peer-left`; simple-peer's `close` calls `removePeer`.
`_knownPeers` is never pruned, so every suppression window and rank set
grows for the life of a session.

**Idea, in this order.**
- (a) Optional `Transport.onPeerDisconnect?(cb(peerId))` next to
  `onPeerConnect`. On it: remove that peer's awareness state locally
  without broadcasting (every peer receives the same signal — the same
  argument as the suppressed timeout removal), prune
  `_knownPeers`/`_peerAddress`. With the signal present, the lease becomes
  a long safety net (e.g. 5 min) and renewals all but disappear;
  departure detection gets *faster* than 30 s on WebRTC (channel close in
  seconds).
- (b) `awarenessTimeoutMs` option (default 30 000 = today): the provider
  runs its own sweep instead of y-protocols' `_checkInterval`, at the
  configured lease, with the renewal jittered (the measured renewals are
  phase-locked to the join and arrive as a burst). Room-wide setting, like
  every other wire-affecting option. The MQTT keep-alive rule (spec
  §3.1.2.10: PINGREQ only "in the absence of sending any other Control
  Packets") belongs here for free — any message from peer X refreshes
  `meta.get(X).lastUpdated`, any message we send refreshes ours — but it
  only pays when beacons are more frequent than lease/2 (base cadence);
  at the 60 s cap it saves nothing on its own.

**Expected.** N=50 idle: 204 → ~41 deliveries/s with (a) (−80 %); typing
steady state 3.0 → 2.0 sends per keystroke (with item 1: → 1.0). With (b)
alone the renewal class scales by 30 s/lease.

**Cost.** Ghost presence after a crash lasts up to the lease on transports
without a leave signal (Gun, Nostr, a WebSocket relay that does not report
membership) — a UX decision for André (decision 1 below).

**Review (code-traced): three rules.**
- The leave-triggered removal must reuse origin `'timeout'`:
  `removeAwarenessStates` emits `{removed:[X]}` with whatever origin is
  given, and the handler (1516-1591) broadcasts for every origin except
  `this` and `'timeout'` — a new origin string would be N-1 broadcasts per
  leave per peer, the very burst `_scheduleAwarenessRemoval` exists to
  stop. With `'timeout'` it is one suppressed broadcast room-wide, which
  also corrects joiners that got X in a relayed table just before.
- Leases are room-wide, default stays 30 s: a removal is authoritative by
  clock, so the shortest lease in a room wins for everyone and a
  longer-lease peer flaps (suppressed removal + its own clock-bump
  re-announce) every short lease. A late reordered message from X after
  the leave is applied as `updated` (its `meta` entry survives the
  removal) and lingers for a full lease — rare, accept.
- The keep-alive refresh must come from sender-id messages only (digest
  2019, verified update 1855), never from awareness table entries — a
  relayer would otherwise extend a crashed peer's ghost by a lease. Clear
  `_checkInterval` only when the provider created the `Awareness`
  instance (`options.awareness` may be app-owned); `meta` and
  `_checkInterval` are public in `awareness.d.ts`.

**Validation.** `bench-idle-room` steady mode: awareness class → ~0 with
the dummy hub's leave notification simulated (`hub.leave` exists);
`bench-awareness-removal-burst`: departure detected via the leave event
instead of the 30 s timeout — count and latency; a new "crash" case (peer
goes silent, no leave) removed after the lease.

### 3. Trickle beacons (RFC 6206): stay quiet when an equal digest was overheard

**Finding.** The periodic tick (`src/index.ts:947-982`) sends
`_sendSyncStep1()` unconditionally. An equal beacon overheard already
cancels a pending *ack* (`_cancelPendingAck`, called at 2057 and 2080);
nothing records "a settled peer with my exact digest beaconed 400 ms ago,
my tick adds nothing". Every beacon is a room-wide broadcast, so idle
beacons cost N(N-1) per interval: baseline B's 2,450 per minute at the
cap, 490/s in the base cadence.

**Idea.** Trickle's polite gossip: count equal (non-JOIN/CONFIRM/ACK)
beacons heard since the last tick; at the tick, send only if the count is
below the redundancy constant k (RFC 6206 §4.2, k = 1-5 typical; start at
1), then reset the count. Optionally Trickle's second rule: an
*inconsistent* beacon (someone behind or ahead) re-arms the interval at
the base value — a stronger signal than the "remote update" that phase 1e
deliberately stopped counting as activity; measure with and without.
Requests (JOIN, CONFIRM, resync) are never suppressed.

**Expected.** With unsynchronised per-peer intervals the room-wide send
rate settles where x·eˣ = N (x = W(N), Lambert W): ~2.2 beacons per
interval at N=20, ~2.9 at N=50, ~3.4 at N=100 — O(N) deliveries per
interval instead of N(N-1). N=50 idle at the cap: beacons 41 → ~2.3/s
(−94 % of the class, −19 % of the room; together with item 2(a) the idle
room drops from 204/s to low single digits). Base cadence after a join
burst: beacons 343/s → ~28/s, a third of that regime's traffic. Trickle
and Levis et al. (NSDI'04) report the same logarithmic scaling.

**Review (code-traced): holds with two rules, one mitigation.**
- Rule 1 — reset the equal-count whenever the local digest changes (the
  `_dsHashCache = null` line at 1448 fires for local and remote updates),
  and never suppress the beacon `_markActivity` re-arms. Without it a
  typist at the 60 s cap that counted equal beacons *before* its edit
  suppresses its post-edit beacon, and a listener that lost that last
  keystroke (no later sequence number, so no gap) is shown behind only by
  some other peer's backed-off tick — 60-120 s instead of ≤ 5 s (the
  phase-1d design D chain).
- Rule 2 — "equal" is the existing `equal` at 2043, delete-set hash
  included: a lost delete is healed only by the loser's own beacon, so an
  equality that ignored `dsEqual` would silence the loser forever. And
  item 4's in-flight relaxation must NOT feed this counter (a typist
  treating its own fresh structs as in flight would see every listener
  beacon as equal — rule 1's failure again). In the base cadence during
  typing ~25 % of beacons therefore stay unsuppressed; in the steady state
  only the typist beacons at 5 s (phase 1e) and nothing changes.
- Mitigation — `_knownPeers`/`_peerAddress` are learned only from digests
  and verified updates (SyncStep2 carries no sender id, awareness learns
  nothing), so a late joiner into an idle Trickle room fills `_knownPeers`
  from the ~W(N) phase-winning beacons only: partial views for
  `_responderRank` and the relayer election (over-answers, fails safe) and
  no unicast to unheard peers (falls back to broadcast). Cheap fix: add the
  clientIDs of every awareness payload to `_knownPeers` (ids only;
  addresses stay beacon-learned). Fewer equal beacons also cancel fewer
  pending acks in join bursts — measure in `bench-join-census`.
- Checked and holding: fresh room (bootstrap is by acks / three attempts),
  N=2, unicast mode, JOIN wait ended by an equal SETTLED beacon (still ~3
  per interval), lost delete-only update.

**Validation.** `bench-idle-room` with a steady-state mode (env
`SYNC_INTERVAL_MS`, `SETTLE_MS=90000`) at N ∈ {20, 50, 100}, beacon class
vs. the W(N) prediction; hard gates `bench-packet-loss`, `bench-late-join`,
`bench-idle-backoff`, `bench-corruption-storm`, `bench-join-census`
unchanged.

### 4. In-flight grace: do not answer a periodic beacon for structs younger than 2·RTT

**Finding.** Baseline A.3. `_handleDigest` (`src/index.ts:2083-2092`)
replies whenever `senderBehind`, and `_replyDelay` gives rank 0 a delay of
0. The `weBehind` direction already has this grace
(`_scheduleBehindCheck`, `max(gapGraceMs, 2·RTT)`); the `senderBehind`
direction has none. A lost keystroke is caught by the loser's own
sequence-gap / pending-struct check within `gapGraceMs`, so these replies
are redundant by design, not a recovery path. Base-cadence regime only
(the ~75 s after a join burst, or idle backoff off): 17 % of the traffic
at N=50, 8 % at N=20 with five typists; ~1 % in the steady state.

**Idea.** Track the arrival time of the latest clock per remote client
(`Y.parseUpdateMeta` on the verified-update path, `from`..`to`; the
typist stamps its *own* structs at generation time in the update handler,
otherwise it keeps answering at its rank slot). A beacon whose sender is
behind *only* by clocks younger than the grace is "in flight": no reply;
behind by anything older, or with a differing delete-set hash (a delete
moves no clock): reply as today. JOIN and CONFIRM keep the immediate
reply (a suppressed SyncStep2 would strand their wait). A resync beacon
is indistinguishable from a periodic one on the wire (flags 0), so the
rule keys on the age of the missing structs, not on the beacon kind.

**Review (code-traced): the grace must be `max(gapGraceMs, minRTT)`, not
2·RTT.** With 2·RTT a loser's gap-check resync (sent `gapGraceMs` + 100 ms
after the next keystroke opened the gap) reaches the responder while the
lost struct is still inside the window on Matrix/Nostr/Gun latencies —
nobody answers, the loser waits `max(1000, 4·RTT)` and retries: ~3.9 s
instead of ~1.1 s on Matrix, past `syncInterval` after a second loss.
At `max(gapGraceMs, minRTT)` the in-flight case (age < one-way latency +
jitter) is still covered and every gap/pending/behind-check resync (age ≥
`gapGraceMs` + 100 + latency) is answered. Reply merging and the ack path
are unaffected (a silent responder never enters `_replyToSyncRequest`).

**Risk.** A peer that beacons within the grace after losing the *last*
update before silence waits for the typist's next beacon (base interval)
instead of being answered at once — the phase-1d recovery chain, unchanged.
Gate: `bench-packet-loss` on the Matrix/Nostr/Gun profiles,
`bench-idle-backoff` recovery medians.

**Validation.** `bench-typing-census` with a 3 s settle: SyncStep2 class →
~0; with a 90 s settle: unchanged.

### 5. Reconnect and peer-connect push: the diff, not the document

**Finding.** `connect()` → `syncNow()` → `_trySyncPushPull(push = true)`
(`src/index.ts:1270-1275`) broadcasts `Y.encodeStateAsUpdate(doc)` — the
whole document — on every connect, every reconnect and, on mesh
transports, on every debounced `onPeerConnect` (`_schedulePeerConnectSync`
→ `_syncNow(0)`, to *all* connections, not the new one). On chunking
transports a 320 KB course is 5+ messages per push; the CLAUDE.md O(N²)
mesh-join warning is still true today.

**Idea.** Remember the state vector the room last confirmed for us
(`_confirmedSv`, taken at `_markSynced`/SETTLED equal beacon/SyncStep2).
On reconnect push `encodeStateAsUpdate(doc, _confirmedSv)`: offline edits
only; empty → no push at all. Round 2's single-message-survival property
holds — our new edits still travel in one message; the rest of the
document the room already confirmed, and a *replaced* room (new empty
peers) shows up behind in their own JOIN beacons, which we answer as for
any late joiner. On mesh transports, `onPeerConnect(peerId)` hands us the
`sendTo` address: send a plain beacon to that peer alone instead of a
full-state broadcast to everyone.

**Expected.** Reconnect of a flapping client: k chunks × (N-1) → 0-1
messages; mesh join burst: full pushes O(N²) → beacons O(N).

**Validation.** `bench-reconnect-cycling` gains a document-size axis and a
chunking profile (`bench-chunking-compression`'s); `bench-mesh-join-burst`
with `DUMMY_UNICAST=1` and `simulatePeerConnect`.

### 6. Hidden tabs: verify the awareness flap under Chrome's intensive throttling

**Finding (hypothesis, browser-only).** Chrome 88+ runs chained timers of a
page hidden > 5 min, silent > 30 s, chain ≥ 5, without WebRTC, once per
minute. y-protocols' renewal is such a chain: the hidden tab renews every
60 s, every other peer times it out at 30 s (suppressed removal, one
broadcast) and re-adds it at 60 s (`added`, one broadcast) — two N-1
broadcasts per minute per hidden tab, plus a flickering presence list.
For a class of 30 with half the tabs in the background that is ~15
deliveries/s, as much as all backed-off beacons together. WebSocket does
not exempt a page; WebRTC does (peerjs/simple-peer/trystero unaffected).
No `visibilitychange`/`pagehide` handling exists in `src/` today.

**Idea.** Item 2's lease (≥ 2 min, or transport liveness) removes the flap
outright. On top, on `visibilitychange`: hidden → jump the beacon interval
to the cap; visible → one beacon now (the `_markActivity` re-arm), so a
returning tab catches up in one round trip instead of waiting for a
backed-off tick. ~10 lines, no wire change.

**Validation.** Manual: two tabs on `dev:websocket`, one hidden for 6 min,
count `MESSAGE_AWARENESS` in the visible tab's console (the flap cannot be
reproduced in Node).

### 7. Persistence-first `connect({ waitFor })` (round-4 item 11, still open)

**Finding.** `IndexedDBTransport.loadUpdates()` replays stored records
through `onMessage` with no ordering against `connect()`'s `syncNow()`:
the JOIN beacon often carries an empty state vector, and the room answers
with the full document (chunked on Matrix/Nostr/Supabase) although the
local copy is complete.

**Idea.** `connect({ waitFor?: Promise<void> })`, or the IndexedDB
transport exposing `whenLoaded`; the provider awaits it before `syncNow()`.
Zero protocol change; composes with the digest beacon (equal → no reply).

**Validation.** `bench-rejoin-blank-doc` variant "rejoin with persisted
copy": SyncStep2 bytes and chunk count → 0.

### 8. Broadcast on `'change'`, not `'update'`

**Finding.** `_setupAwarenessSync` listens on `'update'`
(`src/index.ts:1593`), which y-protocols emits on *every*
`setLocalState()`; `'change'` (`awareness.js:132`) is the deep-equality
filtered one. The three editor bindings dedupe the cursor by relative
position themselves, so this only helps apps that re-set unchanged state
(y-protocols issue #2 is exactly this complaint). The renewal fires
`'update'` only — it is the one equal-state broadcast that must survive,
and item 2(b)'s sweep is where it belongs.

**Idea.** XS: broadcast on `'change'`; let item 2's sweep own the
renewal. Measure with a probe that re-sets an unchanged state.

### 9. Room-size-adaptive awareness throttle

**Finding.** Cursor-only traffic (mouse selection, no typing) is
rate × (N-1) per mover, bounded only by `awarenessInterval` (100 ms). Ten
movers at 10 Hz in a 50-peer room: ~4,900 deliveries/s — more than
everything else in this document combined. Liveblocks ships a 100 ms
default throttle and lets it go to 16 ms; nobody scales it with room size,
but nobody else broadcasts without a server either.

**Idea.** `awarenessInterval: 'auto'` = `max(transport hint ?? 100,
c·N)` ms (c ≈ 10: N=50 → 500 ms, 2 Hz). A latency trade, not a free
win — the message cost scales with N, the perceived lag does not — so a
default change is André's call. `batchUpdates` could take the same rule,
but at 5 keys/s nothing below ~250 ms coalesces anything.

**Validation.** New movers bench: M movers at 20 Hz, N peers, deliveries
vs. cursor lag.

### 10. One network peer per browser: leader tab via Web Locks (only if multi-tab matters)

**Finding.** Every tab is a full peer: its own transport connection,
beacons, renewals, replies. BroadcastChannel keeps tabs in sync locally but
does not stop them all talking to the network.

**Idea.** `navigator.locks.request(room)`: the holder connects the
transport and forwards BC ↔ transport verbatim (wrapped bytes, the
followers' clientIDs stay theirs); followers connect no transport and skip
their periodic tick. The lock is released automatically when the leader
tab closes; the next tab is promoted. Standard leader-election pattern
(RxDB, tab-election, MDN Web Locks).

**Expected.** Per-user emissions ÷ tabs. Worth it only if LiaScript users
commonly hold a course open in several tabs — decision 4 below.

## Rejected this round (with reasons)

- **Random-partner anti-entropy (Demers 1987 / Scuttlebutt) for mesh
  transports** — same O(N) order per round as Trickle, but replaces the
  overhear-and-suppress machinery the whole reply path is built on. Revisit
  only if Trickle fails on a mesh bench.
- **Beacon as keep-alive (cap the idle backoff at lease/2 so the beacon
  renews presence)** — moves N(N-1)/15 from the awareness class to the
  beacon class and forbids Trickle on it; liveness needs one emission per
  peer per lease whatever carries it.
- **Awareness delta (round-4 item 9), subdocs (item 10), NACK + replay ring
  (item 5)** — declined / parked / superseded by beacon + diff reply.
- **Cursor sampling by change magnitude** — positions are discrete; a
  binding-level concern.
- **Server-side coalescing of presence or beacons** — every backend that
  could do it needs a server the project does not own; out of scope by
  the backend-agnostic design.
- **CBOR/MessagePack, V2 updates, brotli** — bytes, rejected in round 4.
- **A second unreliable DataChannel for awareness** — mesh-only, bytes and
  head-of-line blocking, not message count.

## Sequencing (if André wants to proceed)

| # | Item | Effort | Wire | Depends on | Primary bench |
|---|---|---|---|---|---|
| 1 | 1. Piggyback awareness on updates | S | none (`MESSAGE_BATCH` exists) | — | new `bench-typing-census` |
| 2 | 2. Awareness lease (a: `onPeerDisconnect` in 7 providers, b: sweep + timeout option) | M | interface, optional | — | `bench-idle-room` steady mode, `bench-awareness-removal-burst` |
| 3 | 3. Trickle beacons (+ `_knownPeers` from awareness ids) | S | none | — | `bench-idle-room` steady mode, `bench-join-census`, `bench-late-join`, `bench-idle-backoff` |
| 4 | 4. In-flight grace for beacon replies | S | none | — | `bench-typing-census`, `bench-packet-loss`, `bench-idle-backoff` |
| 5 | 5. Diff push on reconnect, unicast beacon on peer connect | S | none | — | `bench-reconnect-cycling`, `bench-mesh-join-burst` |
| 6 | 6. Hidden-tab flap | XS | none | 2 | manual browser check |
| 7 | 7. `waitFor` | S | none | — | `bench-rejoin-blank-doc` |
| 8 | 8. `'change'` listener | XS | none | 2 | probe |
| 9 | 9. Adaptive awareness throttle | S | none | — | new movers bench |
| 10 | 10. Leader tab | M | none | — | browser |

**Compound estimate** (arithmetic on the measured baseline, to be
measured): idle 50-peer room at the backoff cap 204 deliveries/s today →
41/s after item 2(a) → ~2-3/s after item 3 (−99 %). One typist at
5 keys/s in a 50-peer room, steady state: 3.0 → 1.0 sends per keystroke
(items 1 + 2). The base-cadence regime after a join burst (N=50, one
typist): ~1,000 deliveries/s → ~275/s after items 1-4.

## Decisions for André (not made here)

1. **Awareness lease semantics.** On transports without a leave signal, how
   long may a crashed peer's presence linger: 30 s (today), 60 s, 2 min?
   With `onPeerDisconnect` the question only concerns Gun, Nostr and a
   plain WebSocket relay.
2. **Trickle parameters.** k = 1 (fewest messages) or 2 (one lost beacon
   does not silence a window); whether an inconsistent beacon re-arms the
   base interval.
3. **Piggyback bytes.** A piggybacked cursor adds ~200 B to a 26 B
   keystroke on every transport; on Ably (5 KiB billing units) invisible,
   on Matrix a win — acceptable as a default?
4. **Multi-tab.** Is a course open in several tabs common enough for item
   10 to matter?
5. **Adaptive awareness throttle** as a default or an opt-in `'auto'`.


## Sources

- [RFC 6206, The Trickle Algorithm](https://www.rfc-editor.org/rfc/rfc6206.html) — §4.2 the redundancy constant k, typical 1-5.
- Levis, Patel, Culler, Shenker: [Trickle: A Self-Regulating Algorithm for Code Propagation and Maintenance in Wireless Sensor Networks](https://csl.stanford.edu/~pal/pubs/trickle-nsdi04.pdf), NSDI 2004 — polite gossip, logarithmic scaling with density.
- Floyd, Jacobson, Liu, McCanne, Zhang: [A Reliable Multicast Framework for Light-weight Sessions](https://cseweb.ucsd.edu/classes/wi01/cse222/papers/floyd-srm-ton97.pdf), ToN 1997 — randomized-timer suppression, the lineage of this project's reply suppression.
- [MQTT 5.0 §3.1.2.10 Keep Alive](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html) — PINGREQ only in the absence of other control packets.
- [y-protocols PROTOCOL.md](https://github.com/yjs/y-protocols/blob/master/PROTOCOL.md) — 30 s removal, re-broadcast every 15 s; [y-protocols issue #2](https://github.com/yjs/y-protocols/issues/2) — update emitted without change.
- [Chrome: heavy throttling of chained JS timers (Chrome 88)](https://developer.chrome.com/blog/timer-throttling-in-chrome-88) — intensive throttling conditions; WebRTC exempts, WebSocket does not.
- [MDN Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), [RxDB leader election](https://rxdb.info/leader-election.html) — one tab holds the connection.
- [Liveblocks client reference](https://liveblocks.io/docs/api-reference/liveblocks-client) — `throttle` default 100 ms, min 16 ms.
- [RFC 1122 §4.2.3.2](https://www.rfc-editor.org/rfc/rfc1122) (delayed ACK), [RFC 896](https://www.rfc-editor.org/rfc/rfc896) (Nagle) — piggybacking.
- van Renesse, Dumitriu, Gough, Thomas: [Efficient Reconciliation and Flow Control for Anti-Entropy Protocols](https://www.cs.cornell.edu/home/rvr/papers/flowgossip.pdf), LADIS 2008 — Scuttlebutt (rejected alternative).

## Results

Every number below: `npx tsc -p tsconfig.bench.json` then the command
given, on the build named. Dummy relay 20 ms ± 25 %, N peers, one typist
at 5 keys/s for 10 s where typing is involved.

### Instruments (commit 1)

- `test/dummy/bench-typing-census.ts` (new): deliveries and sends per
  keystroke, per class; `SETTLE_MS=3000` = base cadence, `90000` = steady
  state.
- `test/dummy/bench-idle-room.ts`: `SYNC_INTERVAL_MS`, `N_VALUES` from the
  environment; the request floor is printed at the 60 s cap when
  `IDLE_BACKOFF=1`; the lost-delete check waits one microtask before
  reading the drop switch (item 1 moved the send there).

Baseline on `main` @ bd77eb9 with these instruments:

```
node bench-dist/test/dummy/bench-typing-census.js                      # base cadence
SETTLE_MS=90000 N_VALUES=50 node bench-dist/test/dummy/bench-typing-census.js   # steady
SYNC_INTERVAL_MS=5000 IDLE_BACKOFF=1 SETTLE_MS=90000 OBSERVE_MS=60000 N_VALUES=20,50 \
  node bench-dist/test/dummy/bench-idle-room.js                        # idle at the cap
```

| Scenario | deliveries | sends / keystroke | request | SyncStep2 | update | awareness |
|---|---|---|---|---|---|---|
| typing N=20 base | 2,337 (46.7 / keystroke) | 2.46 | 437 | 0 | 950 | 950 |
| typing N=50 base | 9,114 (182.3) | 3.72 | 3,577 | 637 | 2,450 | 2,450 |
| typing N=50 steady | 7,399 (148.0) | 3.02 | 98 | 0 | 2,450 | 4,851 |
| idle N=20 at the cap, 60 s | 1,900 (32 /s) | — | 380 | 0 | 0 | 1,520 |
| idle N=50 at the cap, 60 s | 12,250 (204 /s) | — | 2,450 | 0 | 0 | 9,800 |

### Item 1 — one keystroke, one message (commit 2)

What changed in `src/index.ts`: with `batchUpdates` 0 a local update is
merged into the pending batch and flushed at the end of the current task
(`queueMicrotask`) instead of synchronously from inside the Y.Doc
'update' event; the flush (`_sendUpdate`) folds the awareness change the
throttle is holding into the same `MESSAGE_BATCH` (`_takePendingAwareness`);
the awareness throttle's flush folds a waiting timed batch in, update first
(`_takePendingUpdate`); `disconnect()`/`destroy()` flush through the same
helper. The reviewer's rules hold: broadcast paths only, throttle state
committed as the timer would, sequence numbers untouched.

Same commands as the baseline:

| Scenario | before → after deliveries | sends / keystroke | request | SyncStep2 | update | awareness |
|---|---|---|---|---|---|---|
| typing N=20 base | 2,337 → 1,539 (−34 %) | 2.46 → **1.62** | 475 | 114 | 950 | 950 |
| typing N=50 base | 9,114 → 6,321 (−31 %) | 3.72 → **2.58** | 3,381 | 490 | 2,450 | 2,450 |
| typing N=50 steady | 7,399 → 4,949 (−33 %) | 3.02 → **2.02** | 98 | 0 | 2,450 | 4,851 |

The update and its cursor now share one send (the per-class delivery
counts are unchanged, the send count drops by exactly one per keystroke);
what remains above 1.0 in the steady state is the listeners' 15 s
awareness renewal (item 2) and, in the base cadence, beacons and in-flight
replies (items 3 and 4). Gates: `bench-idle-room` part (b) lost delete
5/5 converged (107-693 ms); `bench-sync-latency` one message per edit and
unchanged convergence on all four profiles (40-46 ms push, 241 ms Gun,
227 ms Matrix at `batchUpdates` 0).

### Item 3 — Trickle beacons (commit 3)

What changed in `src/index.ts`: `_equalBeaconsHeard` counts equal
periodic beacons (the existing `equal` in `_handleDigest`, delete-set hash
included) since the last tick; the tick stays silent when the count
reaches `trickleK` (new option, default 1, 0 = off), then resets the
count. The count also resets on every applied update (local or remote,
the `_dsHashCache = null` line), and the beacon `_markActivity` re-arms
after a local edit is never suppressed (`_beaconForced`) - the two rules
from the review. Joiners now also learn peer ids from awareness payloads
(`_scanAwarenessPayload().present` → `_knownPeers`), since settled peers
rarely beacon any more.

```
SYNC_INTERVAL_MS=5000 IDLE_BACKOFF=1 SETTLE_MS=90000 OBSERVE_MS=60000 N_VALUES=20,50 \
  node bench-dist/test/dummy/bench-idle-room.js
N_VALUES=50 node bench-dist/test/dummy/bench-typing-census.js
```

| Scenario | before → after deliveries | request (beacons) | SyncStep2 | awareness |
|---|---|---|---|---|
| idle N=20 at the cap, 60 s | 1,900 → 1,539 (−19 %) | 380 → **19** | 0 | 1,520 (unchanged) |
| idle N=50 at the cap, 60 s | 12,250 → 9,849 (−20 %) | 2,450 → **49** | 0 | 9,800 (unchanged) |
| typing N=50 base cadence (item 1 build → item 3) | 6,321 → 3,724 (−41 %) | 3,381 → 1,176 | 490 → 98 | 2,450 |

One beacon per minute room-wide in the idle room (the W(N) estimate of
~3 was pessimistic: with the count reset at each tick, the first beacon of
a window silences every peer whose window contains it). What is left of
the idle room is the awareness renewal - item 2. In the base cadence
during typing a quarter of the beacons still go out (transiently unequal
digests), and their in-flight replies drop with them.

Gates on the item-3 build: `bench-idle-room` lost delete 5/5;
`bench-idle-backoff` recovery after backoff median 608 ms (phase 1e:
546 ms; off: 244 ms), idle message count with backoff off 60 → 35 per 30
buckets (the two peers now alternate); `bench-late-join` every cell 3/3
converged on WebSocket and Matrix, 0 and 3 % loss; `bench-join-census`
late join N=100 500 deliveries (phase 1e: 500), fresh burst N=100
WebSocket 51,975 / Gun 51,282 (phase 1e: ~54k) - the join path never
suppresses; `bench-packet-loss` every cell 3/3 converged at 0-10 % loss, N 5-50, WebSocket and Matrix profiles (Matrix 10 % N=50: 4,426 deliveries, inside the phase-1e range); `bench-corruption-storm` bounded and converged at every rate (N=10, 50 % corruption: 873 deliveries during the 3 s stream vs 792 at 0 %).

### Item 2 — awareness lease: transport liveness, own sweep, keep-alive (commit 4)

What changed:
- `src/transport.ts`: optional `onPeerDisconnect?(cb(peerId))`, the
  counterpart of `onPeerConnect`; implemented by the dummy
  (`simulatePeerConnect`: the hub reports a transport leaving the room),
  trystero (`onPeerLeave`), simple-peer and peerjs (`removePeer`: channel
  close/error, coordinator `peer-left`), PubNub (presence `leave`/`timeout`
  on the subscription that already ran `withPresence`; messages now pass
  the publisher uuid as `from`). Ably (`presence.subscribe`), Supabase
  (`channel.track()` + presence events) and Matrix (`m.room.member`) have
  the signal too and are left for a later commit - untested backends.
- `src/index.ts`: `awarenessTimeoutMs` option (default 30 000, or
  300 000 when the transport implements `onPeerDisconnect`); when the
  provider created the `Awareness` instance it clears y-protocols'
  `_checkInterval` and runs its own sweep (`_startAwarenessSweep`: renew
  at lease/2 of silence, remove at the lease, period lease/10 jittered
  ±20 %); any digest, verified update or ack we send counts as our
  presence and any such message from a peer refreshes its lease
  (`_touchPeer`, the MQTT keep-alive rule); a reported leave removes that
  peer's state with origin `'peer-left'`, forgets its id and address
  (`_handlePeerLeave`). Leave-triggered removal broadcasts take a ten
  times longer suppression window (≥ 1 s): every survivor learns of a
  leave in the same millisecond, and at the reply window 28 of 49 fired
  before the first could be overheard. Pending removals are now merged
  (one broadcast for a burst of departures) instead of the first being
  flushed unsuppressed, and an overheard removal trims only the ids it
  covers.

```
SYNC_INTERVAL_MS=5000 IDLE_BACKOFF=1 SETTLE_MS=90000 OBSERVE_MS=60000 N_VALUES=50 \
  node bench-dist/test/dummy/bench-idle-room.js                                   # relay control
DUMMY_PEER_EVENTS=1 SYNC_INTERVAL_MS=5000 IDLE_BACKOFF=1 SETTLE_MS=90000 OBSERVE_MS=300000 N_VALUES=50 \
  node bench-dist/test/dummy/bench-idle-room.js                                   # one full 5-min lease
SETTLE_MS=90000 N_VALUES=50 [DUMMY_PEER_EVENTS=1] node bench-dist/test/dummy/bench-typing-census.js
[DUMMY_PEER_EVENTS=1] node bench-dist/test/dummy/bench-awareness-removal-burst.js
```

| Scenario | before (item-3 build) → after | request | awareness |
|---|---|---|---|
| idle N=50 at the cap, relay (lease 30 s), 60 s | 9,849 → 8,869 deliveries | 49 → 49 | 9,800 → 8,820 (window effect of the jitter; the long-run rate, one renewal per peer per 15 s, is unchanged on transports without a leave signal) |
| idle N=50 at the cap, **peer events** (lease 5 min), 300 s | 49,245 (5 × 9,849) → **4,998** (−90 %; 17 /s, 0.3 /s/peer) | 245 | 4,753 (one renewal per peer per 150 s) |
| typing N=50 steady, relay | 4,949 → 4,018; 2.02 → 1.64 sends / keystroke | 98 | 3,920 (30 renewals in the window instead of 49 - the burst is spread, not gone) |
| typing N=50 steady, **peer events** | 4,949 → **2,548** (−49 %); 2.02 → **1.04** sends / keystroke | 98 | 2,450 (cursor only) |

Departure of one peer (`bench-awareness-removal-burst`, detectors = survivors that dropped the state on their own; removalMsgs/removalDlvr = removal-only broadcasts and their deliveries; detectMs = until every survivor had dropped it):

| N | timeout sweep (control): detectors / msgs / deliveries / ms | leave signal: detectors / msgs / deliveries / ms |
|---|---|---|
| 5 | 2 / 1 / 3 / 30,177 | 4 / 1 / 3 / 8 |
| 10 | 1 / 1 / 8 / 30,339 | 9 / 1 / 8 / 5 |
| 20 | 2 / 1 / 18 / 30,094 | 19 / 4 / 72 / 5 |
| 50 | 3 / 1 / 48 / 29,987 | 49 / 2 / 96 / 7 |

(Before round 5 the timeout path already cost ~1 broadcast per departure
thanks to the round-3 suppression, at 30 s detection; the jittered sweep
now lets the first detector's broadcast pre-empt the others' sweeps, so
1-2 survivors detect on their own instead of all N-1 in the same 3 s
tick. The first leave-signal run, at the reply window, cost 28 broadcasts
/ 1,344 deliveries at N=50 - the number that motivated the long window.
A first version of that bench also counted its own teardown, where every
`destroy()` is a reported leave: 70 "removal" broadcasts at N=50 that
were the bench, not the protocol.)

Gates on the item-2 build: `bench-periodic-awareness` 0 periodic
awareness sends in both configs, joiner sees all presence in 37 ms;
`bench-idle-backoff` recovery after backoff median 630 ms (item-3 build: 608 ms; off: 262 ms). The lost-delete check (`bench-idle-room` part b)
with `SYNC_INTERVAL_MS=5000 IDLE_BACKOFF=1` failed its 11 s cap in 2 of 5
samples on this build and 1 of 5 on the relay control - not a regression
of this item but a pre-existing gap: a lost delete-only update is healed
only by the loser's own beacon, which idle backoff parks for up to 60 s
(the item-3 run of the same command passed 5/5 by phase luck). Fixed in
the next commit.

### Lost delete: the mismatch reply asks back (commit 5, found by item 2's gate)

A delete-only update moves no clock, so a beacon cannot show who lacks a
delete; both sides answer each other's beacon with their full delete set,
which heals the *sender* of the beacon being answered. The loser of a
lost delete was therefore healed only by its own next beacon - up to the
60 s idle-backoff cap - the one recovery path phase 1d's behind check did
not cover. Now a reply to a beacon whose delete-set hash differs carries
our own beacon in the same batch (`_encodeBatch([SyncStep2, beacon])`):
if the beacon's sender is the one ahead, it answers that with its delete
set. It terminates - a peer healed by the SyncStep2 half sees an equal
digest in the beacon half and stays silent - and costs 12 bytes on a
reply that goes out anyway.

A first version armed the phase-1d behind check on the mismatch instead
and asked after the grace. It healed the two-peer bench too, but every
peer that overheard the loser's beacon armed the same check, asked, and
got no answer (nobody was behind it), so its response wait retried:
`bench-packet-loss` fan-out on the Matrix profile cost ~2x the deliveries
at 3-10 % loss (N=25: 288 → 472, 232 → 640, 200 → 456). Reverted.

```
SKIP_CENSUS=1 SYNC_INTERVAL_MS=5000 IDLE_BACKOFF=1 node bench-dist/test/dummy/bench-idle-room.js   # x2
```

| | heal time, 10 samples | deliveries per heal | converged within 11 s |
|---|---|---|---|
| before (item-2 build) | 473 - 9,691 ms, median ~1.9 s | 2-6 | 9 / 10 |
| after | 330 - 3,968 ms, median ~1.9 s | 2-3 | **10 / 10** |

The bound is now the editor's own re-armed beacon (≤ one base interval)
plus one round trip, no longer the loser's backed-off tick. Gates:
`bench-packet-loss` all cells converged, fan-out and join burst within the item-3 build's spread on both profiles (Matrix fan-out 10 % N=50: 1,405 → 1,192; 5 % N=25: 232 → 360 with a 48-984 spread); `bench-idle-backoff` recovery after backoff median 547 ms; `bench-late-join` all cells converged.

### Item 4 — in-flight grace for beacon replies: measured, not shipped

What was tried in `src/index.ts`: `_recentArrivals` keeps, per client,
the start clocks and arrival times of recently applied verified updates
(our own stamped when sent); a periodic beacon whose sender is behind only
by clocks younger than a grace gets no SyncStep2; JOIN/CONFIRM beacons
and delete-set mismatches are answered as before.

```
N_VALUES=20 TYPISTS=5 node bench-dist/test/dummy/bench-typing-census.js   # x2, base cadence
N_VALUES=50 node bench-dist/test/dummy/bench-typing-census.js             # x2
node bench-dist/test/dummy/bench-packet-loss.js
```

| Scenario | before (item-2 build) → with item 4 | SyncStep2 deliveries |
|---|---|---|
| typing N=20, five typists, base cadence | 1.44 / 1.43 → 1.39 / 1.40 sends per keystroke; 6,859 / 6,783 → 6,612 / 6,650 deliveries | 209 / 114 → 0 / 0 |
| typing N=50, one typist, base cadence | 1.46 / 1.54 → 1.54 / 1.54 | 49 / 49 → 0 / 0 |

The class it targets does go to zero - but after Trickle (item 3) that
class was worth 2-3 % of a base-cadence typing room (17 % before item 3)
and nothing in the steady state. Against that, `bench-packet-loss` on the
Matrix profile (350 ms ± 40 %):

| grace | fan-out 10 % loss, N=50: deliveries mean (min/max), convergence | 1 % N=50 |
|---|---|---|
| none (previous build) | 1,192 (1,127-1,225), 1.1 s | 425 (392-490), 0.5 s |
| `max(gapGraceMs, minRTT)` (the review's formula) | 3,969 (3,822-4,067), 3.3 s | 3,626 (3,528-3,773), 2.0 s |
| `gapGraceMs` = 300 ms | 2,613 (1,127-4,949), 1.8 s | 702 (490-980), 0.7 s |

The first grace swallowed the losers' gap-check resync beacons outright
(the measured minimum round trip includes the responders' suppression
delays, so it is longer than the review assumed); the second is correct
by construction for the resync paths (a request arrives gap grace + 100
ms + flight after the struct it lacks) yet still showed outliers up to
4x and a slower mean at 10 % loss in three samples, and the bench is
noisy enough that three samples cannot separate a small real effect
from none. A 2 % gain does not pay for a recovery path that needs an
argument to be safe. Not shipped; the measurement is the deliverable
(`bench-idle-backoff`, `bench-late-join`, `bench-corruption-storm` were
green on both variants).

### Item 5 — the diff, not the document: reconnect push and peer-connect beacon (commit 6)

What changed in `src/index.ts`: `_confirmedSv`/`_confirmedDsHash` remember
the state any peer last confirmed equal to ours (the `equal` branch of
`_handleDigest`); `_trySyncPushPull` pushes `encodeStateAsUpdate(doc,
_confirmedSv)` - only what we produced since - and skips the push when
that carries no structs and no unconfirmed deletes (the first connect,
with nothing confirmed yet, still pushes everything). `onPeerConnect` now
passes the peer id through; on a transport with `sendTo` the debounced
peer-connect sync sends each new peer one plain beacon addressed to it
instead of `_syncNow(0)`'s full-state push + beacon broadcast to every
connection. `bench-mesh-join-burst` takes `DUMMY_UNICAST=1`;
`test/dummy/bench-reconnect-push.ts` is new.

```
node bench-dist/test/dummy/bench-mesh-join-burst.js                 # relay-style mesh (no sendTo)
DUMMY_UNICAST=1 node bench-dist/test/dummy/bench-mesh-join-burst.js # mesh with sendTo (peerjs, simple-peer, trystero)
node bench-dist/test/dummy/bench-reconnect-push.js                  # 50 KB doc, 16 KB chunks, 5 reconnects
CHUNK_KB=0 node bench-dist/test/dummy/bench-reconnect-push.js
```

| Scenario (messages attributable to the burst, debounce 50 ms) | before (item-2 build) → after |
|---|---|
| mesh join burst, no sendTo, M=5 K=5 / 10+10 / 20+10 | 242 / 1,038 / 2,217 → 242 / 1,019 / 2,072 |
| mesh join burst, sendTo, M=5 K=5 / 10+10 / 20+10 | 278 / 1,152 / 2,480 → **216 / 873 / 1,523** (−22 / −24 / −39 %); rate-limit attempts 80 → 30 |
| reconnect of a settled peer, 50 KB doc, 16 KB chunks | 6 sends (4 chunks of the 50 KB push + ack + presence) → **3 sends**, ~0.1 KB |
| reconnect of a settled peer, 50 KB doc, no chunking | 3 sends / 50.2 KB pushed → 3-4 sends / 0 KB pushed (beacon + awareness, ack, presence) |

Without `sendTo` the peer-connect sync still broadcasts a beacon (and no
longer a full push, which is the 7 % at M=20); with it, the burst's cost
is the joiners' own JOIN path. Gates: `bench-join-census` late join N=100 500 (relay) / 403 (unicast), fresh burst N=100 53,658 WebSocket / 49,896 Gun (item-3 build 51,975 / 51,282 - noise); `bench-late-join` all cells converged in relay and unicast mode; `bench-reconnect-cycling` 0 spurious gap checks; `bench-rejoin-blank-doc` 10/10 both variants (a new provider has nothing confirmed and still pushes everything); `bench-asymmetric-join` all converged.
