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
suppression: a responder answers iff `peerCount < 4` or
`hash(requesterClientID, myClientID) mod max(1, floor((peerCount − 1) / 3)) === 0`
— about three responders per request, chosen deterministically by both
ids so the set is stable, sent immediately (no suppression delay: joins get
faster). Three gives loss tolerance without overhearing; the requester's
response wait still retries if all three are lost. The broadcast path keeps
today's suppression untouched.

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
