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

### After Task 6 — overlapping requests share one pending reply (`bench-dist-t1c6` = commit `267991e`; probe logs `probe12-*-r2`)

Same probe as above (Matrix fan-out N=50, 1/3/5/10 % loss, 3 samples
each, back-to-back runs of both builds under the same machine load):

| regime | build | deliveries median (range) | SyncStep2 median (range) | convergence median (range) |
|---|---|---|---|---|
| fresh budget | Task 1-5 build | 9,947 (4,557-14,798) | 7,301 (1,960-11,662) | 749 ms (565-831) |
| fresh budget | **Task 6 build** | **4,018 (2,695-6,076)** | **1,323 (490-2,646)** | 803 ms (576-916) |
| default (spent budget) | Task 1-5 build | 19,796 (10,339-25,529) | 16,513 (7,301-21,903) | 922 ms (820-950) |
| default (spent budget) | **Task 6 build** | **4,655 (3,920-5,635)** | **1,176 (882-1,764)** | 1,038 ms (918-1,893) |

SyncStep2 traffic −80 %, total deliveries −60 % (fresh) / −77 %
(default); below the phase-1b baseline (5,684 / ~7-10k) as well.
Convergence is 50-115 ms later at the median: the flush had answered the
second requester at once, the merged reply waits for the pending timer
(one default-regime sample at 1,893 ms: a lost reply, healed by the
response-wait re-beacon). The gap-check and beacon counts are unchanged,
i.e. the fix removes replies, not requests.

Per-task set on the same build (`after1c-fixC`, relay mode, one run):
every gate passes (late-join and packet-loss all cells 3/3, both
corruption RESULT lines, periodic-awareness 4/4, LOSTDELETE 5/5). The fix
reaches beyond the probe's scenario — every cell in which several peers
are behind at the same time:

| bench | cell | Task 1-5 build | Task 6 build |
|---|---|---|---|
| late-join during edits, M=40 K=10 | Matrix 0 % / 3 % | 15,532-23,454 / 14,771-21,928 | **6,107 / 6,639** |
| late-join during edits, M=40 K=10 | WebSocket 0 % / 3 % | 5,149-5,394 / 5,361-5,492 | 5,296 / 4,298 |
| late-join idle, M=40 K=10 | Matrix / WebSocket | 6,881-7,011 / 4,383-5,069 | 6,894-7,025 / 4,808-5,102 |
| packet-loss fan-out N=50, default regime | Matrix 1 / 3 / 5 / 10 % | 11,972-17,346 | **3,169 / 3,463 / 4,067 / 4,475** |
| packet-loss fan-out N=50, default regime | WebSocket 3 / 5 / 10 % | 5,619-12,364 | **1,307 / 1,339 / 1,617** |
| packet-loss fan-out N=50, default regime | WebSocket 1 % | 2,989-8,036 | 9,130 (882-25,039: one storm sample, as 1b's 25,235) |
| packet-loss join burst N=50, 0-10 % | Matrix / WebSocket | 4,296-4,704 / 4,508-6,011 | 4,377-4,524 / 4,720-4,851 |
| join-after-burst | WebSocket in-budget / fresh | 4,412 / 4,314 | 4,804 / 4,314 |
| join-after-burst | Matrix in-budget / fresh | 5,835 / 4,510 | 5,737 / 4,265 |
| idle census N=50 | 15 s regime | 24,549 | 24,647 |
| corruption N=10 | 5 % | 873 | 846 |

Convergence under loss: fan-out Matrix 961-1,124 ms (was 886-1,070),
WebSocket 487-845 ms (was 545-777); late-join unchanged (Matrix during
edits 1,645-1,650 ms, was 1,572-1,619).

### Final gates — unicast mode (Task 1-5 build `bench-dist-t1c3`; logs `after1c-final-unicast`)

`DUMMY_UNICAST=1`: `bench-sync-latency` ×3 with 0 hash-mismatch warnings,
`bench-late-join` ×3 and `bench-packet-loss` ×3 + fresh with every cell
3/3, `bench-periodic-awareness` 4/4 (presence 134 ms, synced 32 ms),
`bench-idle-room` LOSTDELETE 5/5 in both regimes. **One RESULT line
failed:** `bench-corruption-storm`'s N=5 / 50 % cell did not converge
within its 15 s settle timeout (all other 11 cells did; storm check
passed). That bench constructed its transports without the `unicast`
option, so the cell ran the relay path — and the stall turned out to be
the bench's, not the protocol's (next section).

| bench | cell | relay (same build) | unicast |
|---|---|---|---|
| late-join idle, M=40 K=10 (3 runs) | WebSocket / Matrix | 4,383-5,069 / 6,881-7,011 | **947-968 / 4,743-4,772** |
| late-join during edits, M=40 K=10 | WebSocket 0 % / 3 % | 5,149-5,394 / 5,361-5,492 | **1,355-1,356 / 3,451-3,470** |
| late-join during edits, M=40 K=10 | Matrix 0 % / 3 % | 15,532-23,454 / 14,771-21,928 | **4,444-4,567 / 5,114-5,232** |
| packet-loss fan-out N=50, default regime | WebSocket 1-10 % | 2,989-12,364 | 3,114-4,421 |
| packet-loss fan-out N=50, default regime | Matrix 1-10 % | 11,972-17,346 | 3,469-5,010 |
| packet-loss fan-out N=50, fresh regime | WebSocket / Matrix 1-10 % | 1,176-5,227 / 3,283-7,971 | 3,092-4,162 / 4,152-8,320 |
| packet-loss join burst N=50, 0-10 % | WebSocket / Matrix | 4,508-6,011 / 4,296-4,704 | 5,134-5,320 / 2,682-2,872 |
| user-scaling join burst N=100, default / fresh | Gun | 17,820 / 17,226 | **10,956 / 10,915** |
| user-scaling join burst N=100, default / fresh | Matrix | 17,820 / 18,216 | **10,907 / 10,911** |
| user-scaling join burst N=100, default / fresh | WebSocket / WebRTC | 22,473 / 17,127, 34,254 / 19,899 | 20,808 / 20,800, 20,769 / 20,806 |
| user-scaling join burst N=50, default | Gun / Matrix / WebRTC / WebSocket | 4,704 / 4,410 / 5,047 / 4,851 | 2,849 / 2,853 / 5,295 / 4,071 |
| join-after-burst | WebSocket in-budget / fresh | 4,412 / 4,314 | **1,845 / 1,843** |
| join-after-burst | Matrix in-budget / fresh | 5,835 / 4,510 | **2,137 / 1,346** |
| idle census N=50 | default / 15 s | 24,941 / 24,549 | 24,941 / 24,206 |
| corruption N=10 | 5 % | 873 | 918 |

Convergence, the price of unicast under loss (nobody is healed by
somebody else's reply): late-join during edits at 3 % loss WebSocket
805-819 ms (relay 214-227), Matrix 2,250-2,348 ms (relay 1,598-1,612);
fan-out N=50 WebSocket 792-1,568 ms (relay 545-777), Matrix 1,360-2,283
ms default / 2,219-3,813 ms fresh (relay 886-1,070 / 496-791). Deliveries
are flat across loss rates in unicast mode (the ~3,1xx WebSocket fan-out
cells are 490 keystrokes + one 2 s periodic-beacon round of 49 peers + a
handful of unicast replies) — recovery there is paced by the periodic
beacon, not by replies.

### Finding from the unicast final gates: the corruption bench never stopped corrupting

Repeating `bench-corruption-storm` showed the N=2 / 50 % cell stalling in
3 of 5 runs on the Task 1-5 build and converging only after 5-10 s in
most others (both builds), while a probe with the same shape — 25 runs at
N=2 and 25 at N=5, 50 % corruption for 3 s, then observe — converged
every time, mostly within 0.3 s, worst case one 5 s resync backoff. An
instrumented copy of the bench then showed the stalled runs' state: the
peer behind had pending structs and an armed resync timer, its beacons
were being sent (3-4 request slots used), the editor's reply budget was
being used — i.e. requests and replies kept flowing and kept failing.

The cause is in the bench: `withCorruption` corrupts inside the callback
it registers on the transport at `connect()`, and its restore function
only put the transport's `onMessage` *method* back. The registered closure
— the one actually delivering to the provider — kept flipping bits for
the transport's lifetime, so the "converged once corruption stopped"
column was measured under continued corruption. At 5-20 % that still
converges (most replies get through); at 50 % every reply is a coin flip
and the single-responder N=2 cell fails whenever three 5 s retries in a
row lose. Fixed on 2026-09-06: the restore flips a flag the closure reads.
The bench also gains `unicast: DUMMY_UNICAST === '1'` like the other
benches, so its unicast-mode runs now exercise unicast replies. No
protocol change; the two other bench observations stand as before (no
storm; convergence once corruption really stops).

With the fixed bench on the Task 6 build (`corr-fixed`): relay mode 3/3
runs pass every cell; unicast mode 2/3 — one N=10 / 50 % cell did not
converge within 15 s, and eight instrumented unicast repeats of that cell
all converged, each at 5.0 s (the resync coordinator's backoff cap). Relay
mode converges the same cells in 0.04-0.4 s most of the time. This one is
the protocol's, and specific to unicast replies: a requester's response
wait ends on the first SyncStep2 it receives (`_noteResponse(true)`),
also when the responder was itself only partly caught up and its diff
does not complete the requester. In relay mode other peers' broadcast
replies fill the rest in; in unicast mode nothing arrives until the
requester's own next trigger — the coalesced resync timer (5 s cap) or,
in real deployments, the periodic beacon (`syncInterval` default 5 s; the
bench sets 0, which is why its stall is permanent). A stall needs a
second failed round on top. Not changed in this phase; candidates, in
order: **(B)** a peer that is itself mid-recovery (pending structs or an
outstanding response wait) does not act as a unicast responder — the
2 s rank bucket rotates the top-3 for the retry; **(A)** in unicast mode
re-arm one confirmation beacon after a data reply and stop only when it
draws no data; **(C)** request a resync when an overheard beacon shows
us behind (`weBehind`) — needs an in-flight guard of ≥ 1 RTT or it
storms during typing at Matrix latency.

### Final gates — Task 6 build, relay mode (`bench-dist-t1c6` = commits `267991e` + bench fix `f78a350`; logs `after1c6-final-relay`)

Every gate passes: `bench-sync-latency` ×3 with 0 hash-mismatch warnings,
`bench-late-join` ×3 and `bench-packet-loss` ×3 + fresh with every cell
3/3, both `bench-corruption-storm` RESULT lines (fixed bench), `bench-
periodic-awareness` 4/4 (presence 138 ms, synced 30 ms), `bench-idle-room`
LOSTDELETE 5/5 in both regimes. Task 1-5 build → Task 6 build, relay
mode, three runs each where the bench has them:

| bench | cell | Task 1-5 build | Task 6 build |
|---|---|---|---|
| late-join idle, M=40 K=10 | WebSocket / Matrix | 4,383-5,069 / 6,881-7,011 | 4,530-5,118 / 6,858-7,205 |
| late-join during edits, M=40 K=10 | WebSocket 0 % / 3 % | 5,149-5,394 / 5,361-5,492 | 4,724-5,231 / 4,838-5,312 |
| late-join during edits, M=40 K=10 | Matrix 0 % / 3 % | 15,532-23,454 / 14,771-21,928 | **6,097-6,444 / 6,360-6,686** |
| packet-loss fan-out N=50, default regime | WebSocket 1-10 % | 2,989-12,364 | **1,111-2,123** (one 1 % run 5,374) |
| packet-loss fan-out N=50, default regime | Matrix 1-10 % | 11,972-17,346 | **3,071-4,737** |
| packet-loss fan-out N=50, fresh regime | WebSocket / Matrix 1-10 % | 1,176-5,227 / 3,283-7,971 | **866-1,568 / 2,189-3,071** |
| packet-loss join burst N=50, 0-10 % | WebSocket / Matrix | 4,508-6,011 / 4,296-4,704 | 4,296-5,913 / 4,247-4,655 |
| user-scaling join burst N=100, default / fresh | Gun | 17,820 / 17,226 | 17,622 / 17,622 |
| user-scaling join burst N=100, default / fresh | Matrix | 17,820 / 18,216 | 18,018 / 17,523 |
| user-scaling join burst N=100, default / fresh | WebSocket / WebRTC | 22,473 / 17,127, 34,254 / 19,899 | 20,790 / 16,236, 23,958 / 15,840 |
| user-scaling join burst N=50, default | Gun / Matrix / WebRTC / WebSocket | 4,704 / 4,410 / 5,047 / 4,851 | 4,508 / 4,753 / 4,508 / 4,949 |
| user-scaling fan-out N=100, fresh | all profiles | 990 | 990 |
| join-after-burst | WebSocket in-budget / fresh | 4,412 / 4,314 | 4,363 / 4,069 |
| join-after-burst | Matrix in-budget / fresh | 5,835 / 4,510 | 5,737 / 4,265 |
| idle census N=50 | default / 15 s | 24,941 / 24,549 | 24,745 / 24,598 |
| corruption N=10 | 5 % | 873 | 846 |

Convergence under loss, Task 1-5 → Task 6: fan-out N=50 default regime
WebSocket 545-777 → 493-796 ms, Matrix 886-1,070 → 1,000-1,321 ms; fresh
regime WebSocket 119-380 → 105-266 ms, Matrix 496-791 → 696-881 ms;
late-join unchanged (Matrix during edits 1,631-1,703 ms). The Matrix
fan-out pays 100-250 ms for a third of the deliveries; everything else
is equal or faster.

### Final gates — Task 6 build, unicast mode (`bench-dist-t1c6`; logs `after1c6-final-unicast`)

`DUMMY_UNICAST=1`: `bench-sync-latency` ×3 with 0 hash-mismatch warnings,
`bench-late-join` ×3 and `bench-packet-loss` ×3 + fresh with every cell
3/3, `bench-periodic-awareness` 4/4 (presence 133 ms, synced 25 ms),
`bench-idle-room` LOSTDELETE 5/5 in both regimes, `bench-user-scaling`
identical to the Task 1-5 build (join burst N=100 Gun 10,934 / Matrix
10,911 / WebRTC 20,807 / WebSocket 20,814; fan-out N=100 fresh 990). Task
1-5 build → Task 6 build, unicast mode:

| bench | cell | Task 1-5 build | Task 6 build |
|---|---|---|---|
| late-join idle, M=40 K=10 (3 runs) | WebSocket / Matrix | 947-968 / 4,743-4,772 | 951-976 / 4,731-4,754 |
| late-join during edits, M=40 K=10 | WebSocket 0 % / 3 % | 1,355-1,356 / 3,451-3,470 | 1,355-1,361 / 3,466-4,239 |
| late-join during edits, M=40 K=10 | Matrix 0 % / 3 % | 4,444-4,567 / 5,114-5,232 | 4,397-4,779 / 5,282-6,427 |
| packet-loss fan-out N=50, default regime | WebSocket / Matrix 1-10 % | 3,114-4,421 / 3,469-5,010 | 3,106-4,440 / 4,586-5,772 |
| packet-loss fan-out N=50, fresh regime | WebSocket / Matrix 1-10 % | 3,092-4,162 / 4,152-8,320 | 2,125-3,678 / 3,349-7,887 |
| packet-loss join burst N=50, 0-10 % | WebSocket / Matrix | 5,134-5,320 / 2,682-2,872 | 5,158-5,319 / 2,703-2,855 |
| join-after-burst | WebSocket in-budget / fresh | 1,845 / 1,843 | **not converged (30 s; 7,349)** / 1,834 |
| join-after-burst | Matrix in-budget / fresh | 2,137 / 1,346 | 2,154 / 1,348 |
| idle census N=50 | default / 15 s | 24,941 / 24,206 | 24,451 / 24,647 |
| corruption N=10 | 5 % | 918 | 800 |

Two things did not pass in this mode, both of the kind described under
"the corruption bench never stopped corrupting" (a peer left behind with
no unicast reply completing it and no periodic beacon to fall back on):
`bench-corruption-storm` N=5 and N=10 at 50 % did not converge within
15 s (N=2 did, in 3.8 s; the three earlier fixed-bench runs on this build
had 0, 0 and 1 such cells), and `bench-join-after-burst`'s WebSocket
"in budget window" variant did not converge within 30 s once in five
unicast runs of that bench tonight (request=539 plain beacons over the 30
s, syncStep2=43 against 40 in a passing run: the peer behind kept asking
and got almost nothing back; 40 instrumented repeats of that variant
afterwards all converged in 33-86 ms, so the stall is rare and its peer
state was not captured). Convergence in unicast mode is otherwise
what Task 2 measured: late-join during edits at 3 % loss WebSocket 819 /
1,312 / 1,318 ms (Task 1-5 build 805-819), Matrix 2,375-3,155 ms
(2,250-2,348); fan-out N=50 WebSocket 795-1,693 ms, Matrix 1,618-2,498
ms. Relay mode has none of this: every relay run of every bench on the
Task 6 build passed.
