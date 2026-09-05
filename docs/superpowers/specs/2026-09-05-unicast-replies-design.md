# Phase 1c: transport latency hint, unicast replies, idle-backoff numbers — design

## Goal

Take the join path off its remaining O(N²) terms on transports that can
address a single peer (the WebRTC meshes and the in-memory dummy; relay
transports keep today's behaviour), stop the fresh-room CONFIRM retries
that a fixed 1 s first wait causes on slow transports, and put numbers in
front of the idle-backoff default decision. Builds on phases 1 and 1b
(`2026-09-05-digest-beacon-design.md`, `2026-09-05-resync-cascade-design.md`);
baseline = `main` @ `87bad0c`, whose final-gate logs are the "before".

## Context (measured at the end of phase 1b)

- Join burst N=100: WebSocket 17,721 deliveries, Matrix 81,774 — the
  Matrix figure is mostly CONFIRM retries (a joiner's first response wait
  is `max(1000, 4 · minRTT)` with no RTT sample yet, i.e. 1 s, shorter than
  Matrix's round trip plus suppression) and the acks they collect.
- Every reply (SyncStep2, ack) and every presence response to a JOIN is a
  broadcast: N−1 deliveries for one intended recipient. On a mesh transport
  each of those is N−1 WebRTC sends by the responder.
- Reply suppression works by *overhearing*; it cannot work for unicast.
- Idle traffic is one beacon per peer per interval, N·(N−1) per interval;
  `idleBackoffEnabled` (round 3, default off) would cut it but trades
  worst-case loss-recovery latency. Decision open since round 3.

## Design

### A. `Transport.expectedRttMs?` — a latency hint

Optional field on `Transport`, like `preferredBatchMs`: the round-trip time
class the transport author expects (Matrix 700, Nostr 600, Gun 500;
push transports leave it undefined). `GenericProvider` seeds its RTT
samples with it at connect, so the first response wait and the first
suppression window already fit the transport; measured samples replace it
as they arrive (the minimum-of-8 rule, so a pessimistic hint gives way to
reality quickly). `DummyTransport` exposes `2 · latency` when a latency is
configured — it models a transport that knows its class.

### B. Unicast replies

**Interface.** `Transport.onMessage(callback: (data: Uint8Array, from?: string) => void)`
— transports that know the sender pass its address as `from` (mesh peer
id, dummy transport id); relays call `callback(data)` as today.
`Transport.sendTo?(peerId: string, data: Uint8Array): void | Promise<void>`
— optional, like `onPeerConnect`.

**Core.** `_peerAddress: Map<clientID, string>` learned wherever a sender's
clientID is decoded (digest beacons, verified updates) together with a
`from`. A SyncStep2 reply, an ack or a presence response for a specific
requester is sent with `sendTo` when the transport has it and the
requester's address is known; otherwise broadcast, exactly as today. CRC32
wrapping and compression apply unchanged; BroadcastChannel is not used for
unicast (a same-browser request arrives without `from` and takes the
broadcast path).

**Who replies.** Overhearing cannot thin unicast replies, so the unicast
path uses responder self-selection instead of the delay-and-cancel
suppression. ~~a responder answers iff `hash(requester, me) mod
floor((peerCount − 1) / 3) === 0`~~ — measured first: independent
probability-3/N selection left ~5 % of requests with no responder at all,
which then waited for the 1 s retry (`bench-join-after-burst` WebSocket
in-budget converged in 1,022 ms). **As built:** every candidate ranks all
peers it knows by `hash(requester, bucket, peerId)` and answers iff fewer
than three rank below itself. Views of the peer set agree wherever the
knowledge agrees, the true first-ranked peer is first in its own view, so
the set is never empty; a 2 s time bucket rotates the ranking so three
departed peers at the top cost one retry, not a stall. Everyone answers in
rooms of four or fewer. Replies go out immediately (no suppression delay:
joins get faster). The broadcast path keeps today's suppression untouched.

**Presence.** The coalesced presence response (phase 1b, Task 6) keeps the
addresses of the joiners it covers; when all are known it sends one unicast
per joiner instead of one broadcast — (N−1) deliveries per joiner instead
of (N−1)².

**Transports.** `DummyTransport` (`unicast: true` option, default false so
every existing bench keeps measuring the relay path; `DummyHub.unicast()`),
peerjs (`peers.get(id).conn.send`, `from = conn.peer`), simple-peer
(`sendToPeer`, `from = peerConn.peerId`), trystero (`sendUpdate(data, peerId)`,
`from` already provided by `receive`). Relays: unchanged.

### C. Idle backoff — numbers, not a change

`bench-idle-backoff.ts` (round 3) re-run on the phase-1c build, plus
`bench-idle-room` with `IDLE_BACKOFF=1` at N=50 over a longer window, to
give the decision two numbers: deliveries per minute in a quiet room with
and without backoff, and worst-case heal latency of a lost update at the
backed-off interval. No default change in this phase.

### D. Overlapping SyncStep2 requests share one pending reply (added from the final-gate finding, see Results)

`_scheduleSyncReply` keeps one pending reply. Until now a SyncStep2
request from a *second* requester arriving inside the suppression window
flushed the pending reply immediately — an unsuppressed broadcast — and
scheduled the new one. With the window at 1.5 × RTT (design A makes that
the state from the first request on; any room reaches it after its first
answered request anyway), several peers behind after a lossy edit burst
turned every beacon into ~4-5 broadcast replies. Now the pending reply is
re-encoded from the componentwise minimum of both requesters' state
vectors — one SyncStep2 that contains everything either of them lacks —
and keeps its timer, so it stays suppressible by an overheard reply. Acks
and legacy plain-`SyncStep1` requests (no target state vector) keep the
flush. Unicast replies are unaffected (sent at once, never pending).
Cost: the second requester's answer arrives at the pending timer instead
of immediately (+50-115 ms median on the Matrix fan-out under loss), and a
requester may receive structs it already has (ignored by Yjs; on a
broadcast transport every peer received the reply anyway).

## Benchmarks and gates

Baseline = `bench-dist-base1c/` (phase-1b final; logs in `after1b-final8`).
Per item: `bench-user-scaling` (both regimes, tail), `bench-join-after-burst`,
`bench-idle-room` (default and 15 s), `bench-periodic-awareness`,
`bench-corruption-storm`; B additionally in `DUMMY_UNICAST=1` mode for all
of them and `bench-late-join` ×1 / `bench-packet-loss` ×1 in unicast mode.
Final gate on the last commit: phase-1b gate list, 3 × 3, in both dummy
modes for late-join and packet-loss.

## Work items

1. A — hint field, provider values, dummy, seeding; measure.
2. B — interface + core + dummy (`unicast`, `hub.unicast`, `from`) +
   bench helpers (`DUMMY_UNICAST`, unicast counted in `instrumentHub` and
   the census shadows); measure in both modes.
3. B — peerjs / simple-peer / trystero `sendTo` + `from` (no dummy bench
   covers these; verified by build and by the manual `dev:*` playgrounds
   being unchanged in behaviour when `sendTo` is absent).
4. C — numbers into this document.
5. Final gates, results, README (transport authors: `from`, `sendTo`,
   `expectedRttMs`).
6. D — merge instead of flush (found by the final gates of 1-5); measure
   with the fan-out-under-loss probe and the per-task set; final gates
   again on the resulting build in both modes.

## Results

Appended per step as measured, baseline first.

### Baseline (`main` @ `87bad0c`, end of phase 1b; logs `after1b-final8`)

Join burst N=100 (default / fresh budget): WebSocket 17,721 / 18,513,
WebRTC 19,305 / 18,315, Gun 54,054 / 51,084, Matrix 81,774 / 78,210.
`bench-join-after-burst`: WebSocket in-budget 4,461, fresh 4,363; Matrix
in-budget 5,774, fresh 5,735. Idle census N=50: 24,598 / 24,598.
Corruption N=10 at 5 %: 900. All relay mode (the dummy had no unicast).

### After Task 1 — `expectedRttMs` hint

Join burst N=100 (default / fresh): WebSocket 17,325 / 24,453, WebRTC
22,968 / 17,523, **Gun 17,919 / 17,721** (was 54,054 / 51,084), **Matrix
17,325 / 18,612** (was 81,774 / 78,210). The slow profiles now cost what
WebSocket costs: a joiner whose first wait is `4 · 700 ms` no longer fires
a CONFIRM retry before the room's first replies can have arrived, and the
suppression window fits the latency from the first reply on.
`bench-join-after-burst` within noise (WebSocket 4,755 / 4,069, Matrix
6,021 / 4,314); idle census 24,794 / 24,402; periodic-awareness 4/4.

### After Task 2 — unicast replies (dummy in both modes; Task 3 adds the real mesh transports)

**Relay mode** (`DUMMY_UNICAST` unset — every existing deployment on a
relay transport): identical to Task 1 within noise, as required — join
burst N=100 WebSocket 17,721 / 22,473, Matrix 17,919 / 17,325;
`bench-join-after-burst` 4,755 / 4,216 / 5,345 / 4,118; idle census
24,647; periodic-awareness 4/4; corruption both RESULT lines.

**Unicast mode** (`DUMMY_UNICAST=1` — what peerjs/simple-peer/trystero get
from Task 3), deliveries, relay → unicast on the same build:

| bench | cell | relay | unicast |
|---|---|---|---|
| join-after-burst | WebSocket in-budget / fresh | 4,755 / 4,216 | **1,849 / 1,837** |
| join-after-burst | Matrix in-budget / fresh | 5,345 / 4,118 | **2,132 / 1,357** |
| late-join, idle | WebSocket M=40 K=10 | 4,988-5,135 | **967** |
| late-join, idle | Matrix M=40 K=10 | 14,803-15,416 | **4,754** |
| late-join, during edits | WebSocket, 0 % / 3 % | 5,263-5,361 / 5,427-5,541 | **1,357 / 4,087** |
| late-join, during edits | Matrix, 0 % / 3 % | 16,332-19,636 / 17,752-19,636 | **4,604 / 4,953** |
| user-scaling join burst | N=100 Gun / Matrix | 16,830 / 17,919 | **10,907 / 10,934** |
| user-scaling join burst | N=100 WebSocket / WebRTC | 17,721 / 18,018 | 20,798 / 20,788 |
| packet-loss fan-out N=50 | WebSocket 1 / 3 / 5 / 10 % | 1,584-14,226 / 6,860-7,873 / 8,003-10,094 / 9,326-15,353 | **3,124 / 3,127 / 3,121 / 3,877** |
| packet-loss fan-out N=50 | Matrix 1 / 10 % | 7,187-7,383 / 7,791-10,192 | **4,366 / 4,808** |
| idle census N=50 | default / 15 s | 24,647 / 24,647 | 24,500 / 24,500 |

Every gate passes in unicast mode too (late-join and packet-loss all
cells 3/3, corruption both RESULT lines, periodic-awareness 4/4, idle-room
(b)/(c)). SyncStep2 replies per join: ~3-5 in total instead of one per
peer that overheard nothing in time.

Two things the unicast column also shows: **(1)** the WebSocket/WebRTC
join burst at N=100 is *higher* under unicast (17.7k → 20.8k) while
Gun/Matrix drop by 40 % — with 100 joiners at once every one of the 99
responders answers each joiner's presence request individually (99 × 99
unicasts) where the broadcast path coalesced a responder's answer to the
whole burst into one broadcast (also 99 × 99 deliveries, but the relay's
acks and replies were thinned by overhearing, which the unicast path
replaces with ~3 self-selected responders per joiner: 300 acks × 1 vs
fewer, suppressed broadcasts × 99); a burst of 100 simultaneous joiners
is the one shape where broadcast-plus-overhearing is competitive, and it
is also the least realistic one. **(2)** Convergence under loss is slower
with unicast: late-join during edits at 3 % loss 221 → 1,193 ms
(WebSocket), packet-loss fan-out N=50 570-1,030 → 809-1,352 ms
(WebSocket), 491-662 → 1,591-1,975 ms (Matrix). A broadcast reply to one
peer incidentally healed every other peer that had lost the same
keystroke; a unicast heals only its addressee, and the others wait for
their own gap check plus beacon, or the 2 s periodic beacon. That is the
trade the design makes on purpose — a fifth to a third of the deliveries
for roughly twice the recovery latency under loss — and `gapGraceMs` /
`syncInterval` remain the knobs for deployments that want it the other way.

### Task 4 — idle backoff, the decision numbers (design C; no default change)

`bench-idle-room` with `IDLE_BACKOFF=1`, `SETTLE_MS=15000`,
`OBSERVE_MS=60000`, base interval 1 s (the bench's), cap 60 s
(`idleBackoffMaxMs` default). Deliveries in the 60 s window:

| N | backoff off | backoff on | what "on" converges to |
|---|---|---|---|
| 5 | 1,268 (1,188 beacons) | 352 (292 beacons) | 1 beacon round / 60 s |
| 20 | 24,149 (22,724) | 6,897 (5,377) | ≈ 380 / 60 s |
| 50 | 156,555 (147,000) | 52,920 (43,120) | ≈ 2,450 / 60 s |

The first minute already shows −66 % at N=50 while the interval is still
doubling (1 → 2 → 4 → 8 → 16 → 32 → 60 s); from the second minute on, a
quiet room pays one beacon per peer per minute instead of one per second
(60× less at this bench's interval, 12× less at the default 5 s
interval). Awareness (the 15 s renewal) is unchanged by the option.

`bench-idle-backoff` (round 3's own script, 300 ms base / 2.4 s cap so the
effect fits a short run): idle traffic 70 → 24 messages; **recovery of a
message dropped just before the room went idle: median 226 ms → 1,845 ms**,
i.e. one backed-off interval. At the defaults (5 s base, 60 s cap) that
worst case is up to 60 s.

Since phase 1 the trade is only that: beacons no longer collect replies,
so a backed-off beacon that finds nothing wrong costs 12 bytes × (N−1) and
nothing else. What "on" gives up is exactly the recovery latency of a loss
that happens while everyone is idle; the digest beacon's own detection
(state vector + delete-set hash) is unchanged, only its cadence. Options
for the decision: keep off (today); on with the 60 s cap; on with a lower
cap such as 20-30 s (worst case ≤ 30 s, still 4-6× less idle traffic at
the default interval). Not changed in this phase.

### Final gates — relay mode (`bench-dist-t1c3` = commit `649d49b`; logs `after1c-final-relay`)

Every gate passes: `bench-sync-latency` ×3 with 0 hash-mismatch warnings,
`bench-late-join` ×3 and `bench-packet-loss` ×3 + fresh regime with every
cell 3/3, both `bench-corruption-storm` RESULT lines, `bench-periodic-
awareness` 4/4 (joiner presence 139 ms, synced 44 ms), `bench-idle-room`
LOSTDELETE 5/5 in both regimes. Deliveries, phase-1b final → phase-1c
final, relay mode:

| bench | cell | 1b final | 1c final |
|---|---|---|---|
| late-join idle, M=40 K=10 | Matrix (3 runs) | 14,803-15,416 | **6,881-7,011** |
| late-join idle, M=40 K=10 | WebSocket | 4,137-5,135 | 4,383-5,069 |
| late-join during edits, M=40 K=10 | Matrix 0 % / 3 % | 16,332-19,636 / 17,752-19,636 | 15,532-23,454 / 14,771-21,928 |
| late-join during edits, M=40 K=10 | WebSocket 0 % / 3 % | 5,263-5,361 / 5,427-5,541 | 5,149-5,394 / 5,361-5,492 |
| packet-loss join burst N=50 | Matrix, 0-10 % loss | 19,894-21,021 | **4,296-4,704** |
| packet-loss join burst N=50 | WebSocket, 0-10 % loss | 4,818-6,190 | 4,508-6,011 |
| packet-loss fan-out N=50, default regime | Matrix 0 % | 7,219-7,677 | **898-996** |
| packet-loss fan-out N=50, default regime | Matrix 1-10 % | 7,056-10,192 (0.48-0.66 s) | 11,972-17,346 (0.89-1.07 s) |
| packet-loss fan-out N=50, fresh regime | Matrix 0/1/3/5/10 % | 2,956 / 3,528 / 5,259 / 3,430 / 4,149 | 1,454 / 3,283 / 4,083 / 7,971 / 7,922 |
| packet-loss fan-out N=50, both regimes | WebSocket 1-10 % | 1,323-15,353 | 1,176-12,364 |
| user-scaling join burst N=100, default / fresh | Gun | 54,054 / 51,084 | **17,820 / 17,226** |
| user-scaling join burst N=100, default / fresh | Matrix | 81,774 / 78,210 | **17,820 / 18,216** |
| user-scaling join burst N=100, default / fresh | WebSocket | 17,721 / 18,513 | 22,473 / 17,127 |
| user-scaling join burst N=100, default / fresh | WebRTC | 19,305 / 18,315 | 34,254 / 19,899 |
| user-scaling join burst N=50, default | Gun / Matrix | 13,573 / 19,747 | **4,704 / 4,410** |
| user-scaling fan-out N=100 until quiet, default | Gun / Matrix | 43,560 / 30,492 | 14,850 / 990 |
| join-after-burst | WebSocket in-budget / fresh | 4,461 / 4,363 | 4,412 / 4,314 |
| join-after-burst | Matrix in-budget / fresh | 5,774 / 5,735 | 5,835 / 4,510 |
| idle census N=50 | default / 15 s | 24,598 / 24,598 | 24,941 / 24,549 |
| corruption N=10 | 5 % | 900 | 873 |

The WebRTC join burst at 34,254 is a one-off in the noisiest cell (the
default regime's spent-budget join burst; the same build's other runs of
that cell: 17,523-22,968, fresh regime 19,899). The one row that got worse is the **Matrix fan-out under loss** — examined
next.

### Finding from the final gates: the pending-reply flush amplifies loss recovery at high latency

The Matrix fan-out under loss (N=50, ten keystrokes, 1-10 % loss) costs
more on the 1c build than on 1b, and converges later. Probe
(`probe12.mjs` in the session scratchpad: same shape as the bench's
fan-out, one profile, message classes of the recovery traffic, window =
edit start → convergence + 800 ms, fresh budget, 3 samples per loss rate,
1/3/5/10 %):

| build / condition | deliveries (median, range) | SyncStep2 deliveries | convergence |
|---|---|---|---|
| 1b final | 5,684 (4,067-9,457) | 1,372-6,762 | 491-701 ms |
| 1c final | 9,310 (5,488-13,181) | 2,499-10,045 | 632-825 ms |
| 1c final, `expectedRttMs` disabled | 5,782 (3,871-8,526) | 1,764-6,370 | 490-659 ms |
| 1c final, hint disabled, **second** burst in the same room | 12,054 (6,811-21,903) | 4,459-17,836 | 627-871 ms |
| (same rooms, first burst) | 7,301 (3,528-9,212) | 1,323-7,105 | 490-671 ms |

So the hint is the trigger, not the cause: without it the first burst
after a join runs with an unknown RTT (suppression window = the room-size
formula, ≤ 200 ms, shorter than the 350 ms one-way latency), and the
*second* burst — once one answered request has produced an RTT sample —
behaves exactly like the 1c build's first. Every room older than one
answered request has been in this state since phase 1b Task 3; the hint
only starts there.

**Mechanism.** `_scheduleSyncReply` holds one pending reply. A request
from a *different* requester arriving while a SyncStep2 is pending
flushes the pending reply immediately (unsuppressed) and schedules the
new one. With the window at 1.5 × RTT (~1 s on Matrix) and several peers
behind after a lossy burst — each missing a different keystroke, each
beaconing (gap check, or the 2 s periodic beacon while still behind) —
nearly every pending reply is flushed by the next beacon instead of being
cancelled by an overheard answer: ~4-5 broadcast SyncStep2 per beacon
(11,417 of 14,455 deliveries in one 3 % sample), and because the first
reply now comes later (spread over ~1 s instead of ~200 ms), more peers
are still behind when their periodic beacon fires, adding waves. With the
RTT unknown nothing is overheard either (window < latency), but a pending
reply lives only ~200 ms, so few are flushed and the first reply arrives
sooner.

**Prototype (not committed; `fixC.patch` in the session scratchpad,
built as `bench-dist-fixC`).** A second SyncStep2 request inside the
window no longer flushes the pending reply: the pending reply is
re-encoded as a SyncStep2 from the componentwise minimum of both state
vectors (one answer that contains everything either requester lacks) and
keeps its timer and its suppressibility. Acks and legacy plain-`SyncStep1`
requests (no target state vector) keep the flush. ~25 lines including a
`minStateVector` helper (`Y.encodeStateVector` accepts a `Map`).
