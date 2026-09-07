# Sync optimization — round 6 (item 9: room-size-adaptive awareness throttle)

## Context

André asked to re-review the message-count optimizations and search the
literature/web again for anything further. Round 5 (`main` @ `931f808`,
merged earlier the same day, 2026-09-07) had just run this exact exercise
for the per-peer periodic emissions and per-keystroke framing (Trickle
beacons, piggybacked awareness, an MQTT-style keep-alive lease, diff-only
reconnect/peer-connect pushes, `waitFor`), each shipped with measured
before/after benchmarks, and explicitly rejected several gossip/anti-entropy
alternatives (see that doc's "Rejected this round").

Fresh web research this session (ConflictSync - bandwidth-efficient set
reconciliation via Bloom filters/Rateless IBLTs, arXiv:2505.01144;
Plumtree/epidemic broadcast trees; Merkle-CRDTs, arXiv:2004.00107;
VCube-Sync/VCube-PS, a hypercube-topology CRDT sync datastore, ACM DEBS '23;
Automerge's own Bloom-filter sync protocol; Hocuspocus's fixed-window
update/awareness batching; a "Cellular Mesh" WebRTC topology writeup) found
nothing that beats what round 5 already shipped or already rejected, for
this project's actual scale:

- ConflictSync, Merkle-CRDTs and VCube-Sync all target the *large-scale,
  high-divergence* regime (thousands of replicas, partition healing after
  long offline periods) - solving a different problem than a classroom
  room of tens of peers that's usually only briefly out of sync. The
  digest/hash comparison they build on is already what `computeDocHash`
  and the digest beacon do here, at a fraction of the complexity.
- Plumtree and "Cellular Mesh" are both tree/gossip topologies to cut
  mesh broadcast from O(N²) - the same shape as round 5's rejected
  "Scuttlebutt for mesh transports" (rejected because it would replace the
  overhear-and-suppress machinery the whole reply path is built on, for
  gains only relevant past mesh sizes this project doesn't target - see
  round-5 doc, "WebRTC ... under 100 users per document").
- Automerge's Bloom-filter sync and Hocuspocus's batching are both
  already-implemented ideas here: digest-based comparison (item 3, this
  round-5 predecessor's Trickle beacons) and update+awareness piggyback
  batching (round 5, item 1) respectively.

The one item round 5 identified but left open, because it needed a real
measurement instead of a guess:

> **Item 9 — room-size-adaptive awareness throttle.** Cursor-only traffic
> (mouse movement, no typing) is rate x (N-1) per mover, bounded only by
> the fixed `awarenessInterval` (100ms default) - unlike every other class
> round 5 touched, this one is *unbounded by room size*. Liveblocks (cited
> precedent, [client reference](https://liveblocks.io/docs/api-reference/liveblocks-client))
> ships a 100ms default throttle and lets apps go to 16ms, but nothing
> scales it with room size by default. Round 5 proposed `awarenessInterval:
> 'auto'` = `max(transport hint ?? 100, c*N)` ms (c~10) but didn't build it,
> pending a measurement of the tradeoff (fewer messages vs. slower-looking
> cursors) instead of guessing `c`.

This round builds that measurement and the opt-in implementation.

## Idea

`awarenessInterval: 'auto'` (`src/index.ts`): the option's type widens from
`number` to `number | 'auto'`. `_effectiveAwarenessInterval()`
(`src/index.ts:2517-2528`) resolves it at each throttle check - not once at
construction - to `max(transport.preferredAwarenessMs ?? 100,
AWARENESS_AUTO_MS_PER_PEER * peerCount())`, `AWARENESS_AUTO_MS_PER_PEER =
20` (raised from round 5's starting guess of 10 - see "Decision", below:
André chose more message-count reduction over less cursor lag). Both call sites that used to
read the `_awarenessInterval` field directly now call this instead:
`_broadcastAwareness` (`src/index.ts:3540` onward) and
`_tryImmediateAwarenessMessage` (`src/index.ts:3662` onward, the round-5
item-1 piggyback path). `_peerCount()` already exists (`src/index.ts:2505`,
used for reply-suppression gating), so this is purely a new read of
existing state, no new tracking. The library default is unchanged (a fixed
100ms) - `'auto'` is opt-in, per round 5's own note that this is "a latency
trade, not a free win."

## Validation

New `test/dummy/bench-movers-census.ts`: M movers (default 10) set a
changing cursor position at `MOVE_HZ` (default 10Hz) for `DURATION_MS` in
an N-peer room; a stationary observer's awareness `'change'` handler (round
5 item 8: fires only on real changes) records arrival-time minus a
send-timestamp embedded in the cursor payload as one lag sample per
observed update. Reports deliveries/s, deliveries/s/peer, and the lag
distribution - the round-5 doc's own example scenario ("10 movers at 10Hz
in a 50-peer room").

```
npx tsc -p tsconfig.bench.json
node bench-dist/test/dummy/bench-movers-census.js                      # fixed 100ms (default)
AWARENESS_INTERVAL=auto node bench-dist/test/dummy/bench-movers-census.js
N_VALUES=100 node bench-dist/test/dummy/bench-movers-census.js         # and again with AWARENESS_INTERVAL=auto
```

10 movers, 10Hz, 10s window - first pass, `AWARENESS_AUTO_MS_PER_PEER = 10`:

| N | interval | deliveries | /s | /s/peer | sends | lag p50 | lag p95 | lag max |
|---|---|---|---|---|---|---|---|---|
| 20 | 100ms (fixed) | 19,038 | 1,904 | 95.2 | 1,002 | 22ms | 27ms | 30ms |
| 20 | auto (=200ms) | 9,728 | 973 (**-49%**) | 48.6 | 512 | 96ms | 118ms | 126ms |
| 50 | 100ms (fixed) | 49,098 | 4,910 | 98.2 | 1,002 | 23ms | 29ms | 33ms |
| 50 | auto (=500ms) | 10,437 | 1,044 (**-79%**) | 20.9 | 213 | 93ms | 121ms | 127ms |
| 100 | 100ms (fixed) | 99,099 | 9,910 | 99.1 | 1,001 | 28ms | 41ms | 48ms |
| 100 | auto (=1000ms) | 10,989 | 1,099 (**-89%**) | 11.0 | 111 | 88ms | 129ms | 136ms |

The fixed-interval N=50 row (4,910/s) matches the round-5 doc's estimate
("~4,900 deliveries/s") almost exactly, confirming the bench measures what
item 9 described. `'auto'` holds deliveries/s roughly flat as N grows
(973 -> 1,044 -> 1,099, vs. 1,904 -> 4,910 -> 9,910 fixed) at the cost of
cursor lag moving from imperceptible (~20-40ms, inside one network RTT)
to clearly perceptible but still well under a second (p50 ~90-100ms, p95
under 130ms even at N=100) - the tradeoff is real and now has numbers,
not a guess.

Re-run after André asked for more message-count reduction
(`AWARENESS_AUTO_MS_PER_PEER = 20`, doubling the per-peer slope - same
command, `AWARENESS_INTERVAL=auto`):

| N | interval | deliveries | /s | /s/peer | sends | lag p50 | lag p95 | lag max |
|---|---|---|---|---|---|---|---|---|
| 20 | auto (=400ms) | 4,978 | 498 (**-74%** vs. fixed) | 24.9 | 262 | 94ms | 117ms | 122ms |
| 50 | auto (=1000ms) | 5,488 | 549 (**-89%** vs. fixed) | 11.0 | 112 | 91ms | 124ms | 125ms |
| 100 | auto (=2000ms) | 6,039 | 604 (**-94%** vs. fixed) | 6.0 | 61 | 96ms | 126ms | 129ms |

Doubling the slope roughly doubles the reduction (-49/-79/-89% ->
-74/-89/-94%) while the lag distribution barely moves (p50 still ~90-100ms,
p95 still under 130ms at every N) - the movement itself, not the
throttle's steepness, is what the observer actually perceives (their own
network RTT + the throttle's floor already dominate at c=10; going to c=20
mostly trades a message rate nobody was looking at anyway). This is why
20 was chosen over 10 - see "Decision", below.

Gates (unaffected by the refactor - `_effectiveAwarenessInterval()` returns
the unchanged fixed value whenever `awarenessInterval` stays a plain
number, which every existing bench and the library default both do):

- `bench-typing-census` (default `awarenessInterval`): N=20 1.26
  sends/keystroke, N=50 1.64 - matches round-5's shipped numbers.
- `bench-periodic-awareness`: both configs PASS, 0 periodic awareness
  sends; late joiner sees all presence within the 330ms bound.
- `bench-awareness-removal-burst`: 1 detector / 1 removal broadcast per N,
  detectMs ~30s (the timeout-sweep control path, unchanged).
- `bench-idle-room` (`SYNC_INTERVAL_MS=5000 IDLE_BACKOFF=1 SETTLE_MS=90000
  OBSERVE_MS=60000 N_VALUES=20,50`, the steady-state backoff-cap gate every
  round 5 item used): N=20 23/s (round-5 build: ~22/s), N=50 153/s
  (round-5 build: ~145/s) - inside the jittered-sweep spread every round-5
  item's own re-runs of this gate showed; lost-delete 5/5 converged.
  Default `awarenessInterval` (a fixed number), so `_effectiveAwarenessInterval()`
  never takes the `'auto'` branch here - no wire-visible change expected,
  and none measured.

`npm run build` (full `tsc`) - `awarenessInterval`'s widened type does not
break `dist/lib.d.ts`; `number` remains a valid value.

## Sources

- [Liveblocks client reference](https://liveblocks.io/docs/api-reference/liveblocks-client) - `throttle` default 100ms, min 16ms (cited already in round 5, item 9's origin).
- [ConflictSync: Bandwidth Efficient Synchronization of Divergent State](https://arxiv.org/pdf/2505.01144) - Bloom-filter/Rateless-IBLT set reconciliation; targets large-scale divergence, not applicable at this project's room sizes.
- [Merkle-CRDTs: Merkle-DAGs meet CRDTs](https://arxiv.org/pdf/2004.00107) - DAG-head gossip; same shape as the already-rejected Scuttlebutt alternative.
- [Epidemic Broadcast Trees (Plumtree)](https://www.dpss.inesc-id.pt/~ler/reports/srds07.pdf) - eager/lazy-push broadcast trees for large gossip overlays; same rejection reasoning as Scuttlebutt (round 5).
- [Efficient Synchronization of CRDTs using VCube-PS](https://dl.acm.org/doi/fullHtml/10.1145/3615366.3615421) - hypercube topology for large CRDT clusters; out of this project's scale.
- Hocuspocus release notes (fixed-window update+awareness batching, encode-once broadcast) - already-shipped equivalent here (round 5, item 1; `_encodeAwareness`/`_sendBatch` sharing one encode across recipients).

## Decision, taken 2026-09-07

André chose `AWARENESS_AUTO_MS_PER_PEER = 20` (more message-count
reduction) after seeing both tables above - the lag cost of going from 10
to 20 turned out to be marginal (the observer's own RTT and the 100ms
floor already dominate perceived lag more than the slope does), so there
was little reason to leave message-count savings on the table. This closes
round-5's "Decisions for André" §5.
