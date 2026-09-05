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
