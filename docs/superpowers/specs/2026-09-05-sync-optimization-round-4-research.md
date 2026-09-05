# Sync optimization — round 4 research (protocol, communication, transports)

## Status

Research only — no implementation. Same rule as rounds 1-3: every item
below is "worth measuring", not "should ship". Two of the three prior
rounds produced a confidently-reasoned item that a benchmark then killed
(07-26 Task 2: expected 5-10x, got 1.3x; 09-04 Item 2: passed its own gate,
reverted after a second bench). This round adds one new discipline on top:
where a claim could be checked locally in minutes, it was — the numbers in
"Measured baseline" below come from two throwaway Node probes against the
current `main` (`e2cf824`), reproduced in the appendix so they can be turned
into proper `test/dummy/bench-*.ts` scripts when an item is picked up.

## What round 3 delivered (audit)

All seven round-3 ideas shipped between `e017ee4` and `4a541e4`:

| Round-3 item | Commit | Default |
|---|---|---|
| 6. Reply-suppression window scales with room size | `e017ee4` | on (`min(200, 30·log2 N)`) |
| 3. Skip periodic awareness re-announce on `onPeerConnect` transports | `9fc27f7` | on |
| 4. Jittered periodic interval (±20%, re-jittered per tick) | `abeadc1` | on |
| 1. deflate-raw above 2 KB | `04162b3` | **off** (`compressionThresholdBytes`) |
| 2. push+pull+awareness in one `MESSAGE_BATCH` | `cd355cf` | on |
| 5. Idle backoff of periodic interval | `d732c87` | **off** (`idleBackoffEnabled`) |
| 7. Awareness-removal suppression | `4a541e4` | on |
| (bonus) awareness echo fix | `2e77a8a` | on — N(N-1) → N-1 per change |

`src/index.ts` is now 2572 lines. The message-count *error-recovery* path
(rounds 1-2) and the *steady-state framing* (round 3) are both well
covered. What is **not** covered, and what this round targets:

1. The **content** of steady-state messages is still "tell me everything /
   here is everything (empty)". Every heartbeat sends a full state vector,
   and every peer that hears it replies with a SyncStep2 even when the
   reply is byte-for-byte empty.
2. The verification hash has a **false-negative class**: `computeDocHash`
   hashes the state vector, which does not include deletions.
3. The `Transport` interface has been declared out of scope three times. It
   is now the single largest remaining lever (unicast replies), so this
   round argues for revisiting that decision explicitly rather than
   inheriting it a fourth time.
4. Transport-specific constraints (Ably bills in 5 KiB units, Synapse
   rate-limits at 0.2 msg/s, WebRTC interop chunk is 16 KiB, Supabase now
   takes binary) are known individually but the core protocol has no way
   to learn them except `preferredBatchMs`.
5. Document-size axis (subdocs, persistence-first sync) — flagged in round
   3 as orphaned work, still orphaned (`test/dummy/bench-subdocs.ts`).

## Method

- Re-read `src/index.ts` end to end (2572 lines), `src/transport.ts`,
  `src/providers/*` (grep for size limits, base64, chunking, onPeerConnect),
  `y-protocols/sync.js` + `awareness.js` and the relevant parts of
  `yjs.mjs` in `node_modules` (what `writeSyncStep2` actually writes; what
  `Awareness._checkInterval` actually does).
- Two local probes (appendix A/B): protocol-property checks with plain
  `yjs`/`y-protocols`, and an idle-room traffic census over `DummyHub`.
- Five parallel web-research passes: CRDT sync protocols (Automerge, Loro,
  delta-state CRDT literature), set reconciliation (Negentropy/NIP-77,
  IBLT/RIBLT, Merkle trees, FEC), gossip + presence (GossipSub, Plumtree,
  y-webrtc, Figma/Liveblocks/Loro EphemeralStore), compression + transport
  limits (CompressionStream formats, per-backend size/rate/billing), and
  partial sync (subdocs, AFFiNE, Hocuspocus multiplexing, y-indexeddb).
  Sources are linked per item.

## Measured baseline (this round, current `main`)

### A. Idle room census — nobody types, everyone is synced

`DummyHub`, latency 20 ms ±5, `syncInterval: 1000` (5x faster than the
default to fit a 10 s window; scale by 1/5 for defaults), `disableBc`. All
peers have awareness state. Deliveries counted per recipient over 10 s
after a 2.5 s settle. `DummyTransport` has no `onPeerConnect`, so this is
the WebSocket/PubNub/Ably/Supabase/Matrix/Nostr/Gun code path.

| N | deliveries / 10 s | /s | /s/peer | SyncStep1 | SyncStep2 | Awareness |
|---|---|---|---|---|---|---|
| 5 | 440 | 44 | 8.8 | 116 | 236 | 204 |
| 20 | 8,588 | 859 | 43 | 1,387 | 4,674 | 3,914 |
| 50 | 59,878 | 5,988 | 120 | 7,154 | **35,525** | **24,353** |

Three things fall out of this:

- **SyncStep2 : SyncStep1 = 5 : 1 at N=50.** Reply suppression (round 1,
  scaled in round 3) does not come close to the ideal ~1 at this scale and
  latency. Every one of those 35k replies is empty — 173 KB / 35,525 ≈ 5
  bytes each: message type + `SyncStep2` tag + a 2-byte empty update + the
  delete set. They exist only because `readSyncMessage` always answers a
  SyncStep1 and `_dispatchMessage` always sends a non-trivial encoder.
- **Awareness is 40% of idle traffic** on this code path — the periodic
  re-announce (round 3 item 3 only removed it for `onPeerConnect`
  transports). Meanwhile `y-protocols/awareness` *already* renews the local
  state every `outdatedTimeout/2` = 15 s via `setLocalState(getLocalState())`,
  which unconditionally emits `'update'` (awareness.js:35), which the
  provider broadcasts. So at the default 5 s tick, the room re-announces
  presence 4x per 15 s where the protocol itself needs 1x.
- **Scaling is O(N²) per tick by construction** (every request and every
  reply is a broadcast). At defaults (5 s) an idle 50-peer room still costs
  ~1,200 deliveries/s, ~60 KB/s. On Supabase (one broadcast to N counts N
  events against a 100-2,500 msg/s project cap) or Ably (billed per
  delivered message) that is real money for zero information.

### B. Protocol properties (plain yjs 13.6.29 / y-protocols 1.0.7)

1. **Delete-set blind spot, confirmed.** A: `"hello world"`, B receives it,
   A deletes `"hello "`, that update is lost. Result: `A="world"`,
   `B="hello world"`, **state vectors byte-identical, `computeDocHash`
   equal** — the current verification can never trigger a resync for this.
   `Y.encodeSnapshot(Y.snapshot(doc))` (state vector + delete set) differs
   (16 B vs 8 B). A SyncStep2 computed against B's *equal* state vector is
   12 bytes and **does** repair B — because `writeStateAsUpdate` always
   writes the entire delete set regardless of the target vector
   (yjs.mjs `writeStateAsUpdate` → `writeDeleteSet(createDeleteSetFromStructStore(store))`).
   So today the periodic heartbeat silently heals this; with
   `syncInterval: 0`, or after any change that suppresses empty replies
   (item 1 below), the divergence would be permanent unless the hash gains
   a delete-set component (item 2).
2. **Heartbeat payload sizes.** 20 clients: state vector 118-141 B; an
   "empty" SyncStep2 is 162-185 B (it is the delete set). Full-doc encode
   after 10k insert/delete cycles: V1 442 B, V2 360 B; deflate: 208 / 271.
3. **V1 vs V2 update format — no win here.** 5,000 words typed
   character-by-character: V1 31.4 KB, V2 31.4 KB, both deflate to 0.2 KB
   (repetitive lorem — real prose will be ~5-8x, see
   `bench-compression-ratio.ts`). For the small-history docs above V2 was
   *larger* than V1 and compressed *worse*. Literature confirms V2 only
   wins on Y.Map-heavy docs with huge histories ([yjs#675][yjs675]: 8.9 MB
   → 452 KB, but decode 10x slower). **Rejected for this project** — see
   "Rejected" below.
4. **Single keystroke update: 26 B.** Typical y-quill awareness update:
   **215 B**, of which 205 B is `JSON.stringify(state)`. Presence is ~8x a
   keystroke on the wire.

## Findings, ranked by expected payoff / effort

### 1. Digest SyncStep1: reply only when something differs

**Finding.** Every SyncStep1 is answered by (almost) every peer, and in a
synced room every answer is empty (baseline A). `readSyncStep1` has no
"nothing to send" branch — `writeSyncStep2` always writes
`encodeStateAsUpdate(doc, sv)`, which is never empty because of the delete
set. The reply-suppression machinery (`_scheduleSyncReply`,
`_replySuppressionMaxDelay`, `_sendSyncReply`'s rate gate) exists to fight
the *redundancy* of these replies; nothing yet questions their *necessity*.

**Idea.** Send the periodic SyncStep1 in the project's own envelope with a
digest: `[MESSAGE_SYNC_DIGEST][senderClientID][stateVector][dsHash]`. On
receipt: compute the diff *both ways* from the received vector
(`Y.encodeStateVector(doc)` vs received; `encodeStateAsUpdate(doc, sv)`
length beyond the delete-set floor), compare `dsHash` with the local one
(item 2). If the requester is neither behind nor ahead and the delete-set
hashes match — **send nothing**. Otherwise fall through to today's
SyncStep2 path (which also heals the delete set). This is the
"digest heartbeat" idea from the set-reconciliation literature reduced to
its Yjs-native form: the state vector already *is* the optimal per-client
summary, the only waste is answering it when it matches.

**Expected effect.** In the idle census at N=50 the 35,525 SyncStep2
deliveries go to ~0, i.e. idle traffic drops ~60% before touching
awareness. Under real edits the reply rate is unchanged (something differs
→ reply). This also makes the reply-suppression window less critical: with
no empty replies, the remaining replies are ones that carry data, where
"someone else already answered" is still valid but far rarer.

**Risk / lesson from round 2.** Item 2 of 09-04 died because removing a
recovery path (push) removed the single-message-survival property under
loss. Item 1 here does *not* remove any recovery path — a peer that is
actually behind still gets its SyncStep2, and a peer that is ahead still
gets a SyncStep1 in return (add that: today `readSyncStep1` never asks
back; y-websocket's server does). What it removes is replies that carry no
information. The one thing it *does* remove is the implicit delete-set
healing of empty replies — which is why it must ship together with item 2.

**Validation.** Turn appendix B into `test/dummy/bench-idle-room.ts`
(deliveries per class per second, N ∈ {5, 20, 50, 100}); hard gate: rerun
`bench-packet-loss.ts` and `bench-late-join.ts` 3x with zero convergence
timeouts (the "lost delete" scenario needs adding to `bench-packet-loss`:
drop exactly one delete-only update and assert convergence within one
`syncInterval`).

Sources: [Yjs PROTOCOL.md][yprotocols], [discuss.yjs.dev 2669 "how can I
tell if two documents are synced"][discuss2669], Log Periodic on
[range-based set reconciliation][rbsr] (why fingerprints-first beats
lists-first).

### 2. Add a delete-set hash to the verified envelope

**Finding.** Baseline B.1. `computeDocHash` is documented as "the last line
of defense against logical divergence" — it has a hole exactly the size of
every deletion. dmonad on this: "computing and comparing state vectors is
not enough, since they don't contain the delete set… there is no cheap way
to communicate what deletes a party has in SyncStep1" ([discuss 399][discuss399],
[yjs#374][yjs374], [INTERNALS.md][internals]). Existing providers
(y-websocket, Hocuspocus, y-partykit) never detect it; they rely on every
SyncStep2 carrying the full delete set, exactly as this project currently
does by accident.

**Idea.** Hash `doc.store.ds` (maintained incrementally by Yjs, so O(#deleted
runs) to walk, not O(#items) — do *not* use `Y.snapshot()` per update, it
rebuilds the delete set from the struct store). Normalize first: iterate
clients in numeric order; each client's `[clock, len]` runs are already
sorted and merged by Yjs, but dmonad notes edge cases where write order is
non-deterministic ([discuss 1651][discuss1651]) — sorting client IDs before
hashing covers it. Append the result as a second `varInt` after the
existing state-vector hash in `MESSAGE_SYNC_VERIFIED`, and include it in
item 1's digest. A mismatch routes into the existing `_requestResync()` —
SyncStep2's full delete set is the repair.

**Cost.** One more hash per sent/received verified update. The delete set
is small in practice (baseline B.2: 160-185 B for 10k cycles across 20
clients; 77k deleted chars → ~4.5 KB per [discuss 1651][discuss1651]). If
that ever matters, hash only on the heartbeat (item 1) and not per update
— still closes the permanent-divergence case, just at heartbeat latency.

**Validation.** Extend `bench-packet-loss.ts` with a delete-only-update
loss scenario and assert (a) the hash mismatch fires, (b) convergence
within one resync. Also assert zero false positives across the existing
scenarios (the normalization must be deterministic across peers).

### 3. Presence handshake instead of presence heartbeat

**Finding.** Baseline A: 40% of idle traffic is awareness on
non-`onPeerConnect` transports, and `y-protocols/awareness` already renews
every 15 s on its own. The 5 s tick re-announce exists for one reason:
a late joiner on a relay transport has no way to learn who is present
until they happen to re-announce. Round 3 item 3 solved this only where
`onPeerConnect` exists.

**Idea.** Answer presence on demand. A joiner's `connect()` already
broadcasts push+SyncStep1+awareness in one batch; every receiver sees the
new client appear as `added` in its awareness `'update'` handler
(`origin === this`). Respond to *that* by re-announcing the local state
(through the normal `_awarenessInterval` throttle, plus a small random
spread so N-1 responders don't fire in the same millisecond). Then delete
the periodic re-announce in `connect()`'s tick entirely; the native 15 s
renewal bounds staleness the same way the 30 s `outdatedTimeout` already
assumes.

**Expected effect.** One join costs (N-1)² deliveries once, instead of
N(N-1) every 5 s forever — break-even after one tick. Idle awareness
traffic drops to the protocol's own floor (1 renewal / 15 s / peer). With
item 1 the idle 50-peer room goes from ~1,200 deliveries/s to roughly
N(N-1)/5 + N(N-1)/15 ≈ 650 (SyncStep1 beacons + renewals), then to ~160
once the beacon itself is made cheap by unicast (item 6) — see the
"compound" row in Sequencing.

**Caveat.** A client that times out and comes back is `added` again →
another handshake burst; acceptable, rare. `y-protocols` production
editors (Figma, Liveblocks) all converge on "send presence on join and on
change, not on a timer" ([Figma][figma], [Liveblocks][liveblocks]).

**Validation.** `bench-idle-room.ts` (above) with awareness class
separated, and `bench-late-join.ts` extended to assert a joiner sees all
N-1 presence states within `awarenessInterval + 2·latency`.

### 4. Ground-truth gap detection via Yjs's own pending state

**Finding.** Gap detection today is *inferred* from per-sender sequence
numbers (`_trackRemoteSeq` / `_scheduleGapCheck`, 300 ms grace). Yjs
itself knows with certainty when an update could not be fully applied
because a causal dependency is missing: `doc.store.pendingStructs` (with a
`missing: Map<client, clock>` naming exactly what is absent) and
`doc.store.pendingDs` are set after `applyUpdate` and retried on the next
update. Loro surfaces the same thing as a first-class `ImportStatus.pending`
([Loro import status][loro-import]); Yjs keeps it internal but public on
the object.

**Idea.** After every applied remote update, check
`doc.store.pendingStructs !== null || doc.store.pendingDs !== null`:
- pending → something is *provably* missing: trigger the resync now
  (through `_requestResync()`, coalesced as today) instead of waiting for
  the grace timer or the next hash mismatch; and, given `missing` names
  the client+clock, this is precisely the information item 5's targeted
  NACK needs.
- confirmed sequence gap but **nothing pending and hash matches** → the
  missing message was covered by another path (BroadcastChannel echo,
  another peer's SyncStep2 that arrived first, a batched message that
  carried the same content) — skip the resync. Today this case still
  costs a full push+pull.

**Risk.** `store.pendingStructs` is not part of Yjs's documented public
API (it is a public field on an exported class, stable since 13.5, used
by y-indexeddb-adjacent tooling). Guard with `typeof` and fall back to the
current inference if absent.

**Validation.** `bench-packet-loss.ts` and `bench-corruption-storm.ts`:
count resyncs that were skipped-as-redundant vs. fired-early; hard gate as
always: no convergence timeouts.

### 5. Targeted NACK + per-sender replay ring instead of full resync

**Finding.** A confirmed gap or a hash mismatch today costs the *heaviest*
possible repair: push full state + pull (SyncStep1 → N replies). Round 2
proved the push half cannot be dropped under loss. But the push+pull was
never the *right size* for the common case — one dropped 26-byte keystroke.

**Idea.** New message `[MESSAGE_NACK][targetClientID][seq…]` (or, with
item 4, `[client, clock]` ranges straight from `pendingStructs.missing`).
Every sender keeps a ring of its last K encoded updates (K = `seqWindowSize`,
already 64) keyed by seq. On NACK, the named sender — or, on broadcast
transports, *any* peer holding that update — replays exactly that update;
other holders suppress via the existing overheard-reply pattern. The full
push+pull resync stays as the fallback when the NACK is not satisfied
within the existing backoff, so the round-2 "one path must survive alone"
property is preserved: the NACK path is *added*, nothing is removed.

**Expected effect.** Repair cost for single-message loss: 2 small messages
(NACK + replay) instead of (full-state push to N) + (SyncStep1 to N) +
(k·SyncStep2 to N). The idle census suggests the SyncStep2 fan-out alone
is ~5 replies at N=50.

**Rejected alternative — forward error correction.** XOR parity every k
updates (or RaptorQ/Reed-Solomon) recovers a single loss with zero round
trips, but pays 1/k bandwidth *always*, needs length padding (updates span
26 B to 100 KB), and only helps on the two transports with real loss
(unreliable WebRTC channels, Gun). No CRDT provider does this; the
literature is wireless multicast. Not worth it while a NACK costs 2 tiny
messages. ([Rateless IBLT][riblt] and [minisketch][minisketch] are the
same category — designed for millions of unordered items between two
parties; Yjs updates have perfect per-client locality, so the state vector
already dominates them. [Hoyte's own note][riblet] agrees.)

**Validation.** `bench-packet-loss.ts`: message count and convergence time
at 1-5% loss, N ∈ {10, 50}, NACK on vs off; gate: never worse than baseline
on convergence, target ≥2x fewer messages at 1% loss.

### 6. Optional unicast: `Transport.sendTo?(peerId, data)`

**Finding.** Rounds 1-3 all scoped out changing `Transport`. The cost of
that decision is now the dominant one: every SyncStep2 (a reply meant for
*one* peer) is delivered to N-1 peers, every NACK replay would be too, and
every presence-handshake response as well. Six of nine backends can
unicast cheaply today:

| Backend | Unicast mechanism | Cost |
|---|---|---|
| WebSocket relay | `to: peerId` in frame; relay forwards to one socket | server change |
| PubNub | per-peer channel `room.peer.<id>`, multi-channel subscribe on one connection | free |
| Ably | per-peer channel, or subscription filters on `extras.headers` | free / one extra attach |
| Supabase Realtime | per-peer topic (`room:peer:<id>`), one channel join each | N joins |
| Matrix | `PUT /sendToDevice/…` — not in room history | bound by `/sync` long-poll |
| Nostr | ephemeral kind 20000-29999 with `p` tag; recipient REQs `#p` | free |
| Gun | write to per-peer key path | free |
| peerjs / simple-peer / trystero | already per-connection | free — *today they fan out anyway* |

([PubNub channels][pubnub-ch], [Ably filters][ably-filters], [Supabase
broadcast][supa-bc], [Matrix send-to-device][matrix-std], [NIP-01][nip01].)

**Idea.** Add `sendTo?(peerId: string, data: Uint8Array)` next to the
existing optional `onPeerConnect?`. The core uses it for SyncStep2 replies,
NACK replays (item 5) and handshake responses (item 3) when present,
broadcast otherwise — zero behavior change for transports that don't
implement it. Prerequisite: the requester's identity must be in the
request — SyncStep1 today is a plain `MESSAGE_SYNC` with no sender field;
item 1's digest envelope adds `senderClientID`, and the transport maps
clientID → its own peer address on first sight (peerjs/simple-peer already
know the peer per connection; relays learn it from the envelope).

**Expected effect.** Received bytes per peer for the join/resync path drop
from O(N) replies × O(N) recipients to O(N) unicasts. On the mesh
transports this is the largest single win available, since a WebRTC
`syncNow()` full-state push to a new peer today is sent to *every* existing
connection, not just the new one — that is the O(N²) join burst CLAUDE.md
warns about, and it is a fan-out problem, not a protocol problem.

**Why now.** This reverses a three-round scoping decision, so it is a user
call, not an engineering one. The argument for: the remaining in-interface
wins (items 1-5) are all "send less often / send less"; only unicast
changes the *recipient count*, which is what actually scales with N.

**Validation.** `bench-mesh-join-burst.ts` and `bench-user-scaling.ts`
with `DummyTransport` gaining a `sendTo` simulation (like round 2 added
`onPeerConnect` simulation); compare deliveries, not sends.

### 7. Per-transport wire hints: size, compression floor, batch floor

**Finding.** The core knows one transport hint (`preferredBatchMs`). Real
constraints found this round:

| Transport | Hard size | Rate / billing | What the core should do |
|---|---|---|---|
| PubNub | 32 KiB | per-MAU, messages free | chunk ≤28 KB post-base64; don't over-batch |
| Ably | 64 KiB | **billed per 5 KiB unit**, × subscribers | compress from ~0; keep frames ≤5 KiB |
| Supabase | 256 KB / 3 MB | 100-2,500 msg/s per *project*, one broadcast = N events | batch aggressively; **binary broadcast** (supabase-js ≥ 2.91) removes base64 |
| Matrix (Synapse) | 65,536 B canonical JSON | `rc_message` **0.2/s**, burst 10 | `preferredBatchMs` ≥ 5,000; awareness throttle ≥ 5 s |
| Nostr (strfry) | 64 KiB event, 128 KiB frame | none by default; ephemeral kinds kept 300 s | ephemeral kinds for awareness (`27370` is regular today) |
| Gun | ~30 KB `opt.pack` | none | chunk ≤20 KB pre-base64 |
| WebRTC DC | 16 KiB interop-safe; Chromium closes >256 KiB | Chromium ignores EAGAIN → silent drop when full | chunk 16 KiB; gate on `bufferedAmountLowThreshold` (simple-peer uses 64 KiB) |
| WebSocket | server-defined | `permessage-deflate` **off by default** in `ws` | app-level deflate is not redundant |

([Ably billing][ably-bill], [Supabase limits][supa-limits], [Synapse
rc_message][synapse-rc], [strfry.conf][strfry], [Grahl on DC size
limits][grahl], [ws permessage-deflate][ws-deflate].)

**Idea.** Extend the *hint* pattern already in use: `maxMessageBytes?`,
`preferredCompressMinBytes?` on `Transport`, read as defaults for the
existing options exactly like `preferredBatchMs` — no new abstraction. Set
them in the six providers that know their numbers. Separately, switch
Supabase to binary payloads (drops the 33% base64 tax there; version-gate
because older clients silently drop binary).

**Rejected in this space.** brotli/zstd (Chromium's `CompressionStream` has
neither; wasm encoders are 140-680 KB — [nickb.dev][nickb]); base85/Z85
(+8 points over base64, invisible next to deflate); shared dictionaries
(HTTP-only, Chrome-only); WebTransport (needs an H3 server, kills
backend-agnostic).

**Validation.** `bench-chunking-compression.ts` already exists for the
chunking axis; add a per-transport-profile matrix. Supabase binary needs a
manual `dev:supabase` check against a real project.

### 8. Mesh transports: y-webrtc's partial-mesh trick

**Finding.** peerjs/simple-peer/trystero here are full meshes with no
forwarding (verified: no relay/forward code). y-webrtc scales past ~20
peers not with gossip but with `maxConns = 20 + floor(rand()·15)` and *no
routing at all*: because Yjs sync is idempotent and every peer runs
periodic SyncStep1, a partially connected room still converges
transitively; dmonad tested ~100 peers at a conference this way
([y-webrtc#22][ywebrtc22], [y-webrtc source][ywebrtc-src]).

**Idea.** Optional `maxConns` in the mesh transports with randomized cap.
No core change. Reduces per-peer connection count and thus every
broadcast's fan-out from N-1 to ~20-35.

**Rejected here.** GossipSub (v1.1 D=6 mesh + IHAVE/IWANT, v1.2 IDONTWANT),
Plumtree/HyParView (eager tree + lazy IHAVE, self-healing) — correct
concepts, but all presuppose forwarding, and `@chainsafe/libp2p-gossipsub`
drags the whole libp2p stack; a hand-rolled Plumtree is ~200 lines that
only pay off once `maxConns` exists *and* a benchmark shows partitions.
Recorded as "maybe after item 8", not now. ([GossipSub v1.2][gossipsub12],
[Plumtree][plumtree], [HyParView][hyparview].)

**Also worth one line:** a second WebRTC DataChannel with
`{ordered: false, maxRetransmits: 0}` for awareness only — a lost cursor
sample is superseded 100 ms later anyway, and it stops presence from
head-of-line-blocking document updates. Needs an optional
`sendUnreliable?` on `Transport`; peerjs and simple-peer expose per-channel
config, trystero doesn't. Low priority, mesh-only.

**Validation.** `bench-mesh-join-burst.ts` with a partial-mesh `DummyHub`
mode; convergence time and deliveries vs full mesh.

### 9. Awareness payload: split slow and fast fields

**Finding.** 215 B per cursor move, 205 B of it JSON — the `user: {name,
color}` half never changes, the `cursor` half changes at typing speed. Loro
built `EphemeralStore` (per-key LWW, binary, `encode(key)`) explicitly
because "Awareness doesn't support partial state updates, which means even
minor mouse movements require synchronizing the entire Awareness state"
([Loro ephemeral][loro-eph]). y-protocols has no partial update.

**Idea, wire-compatible.** Keep `awarenessProtocol.Awareness` (every editor
binding depends on `getStates()`); in the provider, when both peers are
y-generic (item 1's envelope makes that knowable), send the state as
`[clientID][clock][deltaJSON]` where `deltaJSON` contains only top-level
keys that changed since the last broadcast *acknowledged by the heartbeat*,
and reconstruct on receipt before `applyAwarenessUpdate`. Saves ~50-60% of
awareness bytes on cursor traffic. **Not** CBOR/MessagePack — 30% on <200 B
for a dependency nobody in the Yjs ecosystem takes.

**Judgment.** Bytes, not messages — secondary metric per this project's own
framing, except on Ably (5 KiB billing units make it irrelevant) and
Matrix/Supabase (count-limited, not byte-limited). Lowest priority of the
protocol items; listed because it is the only remaining lever on the
single most frequent message class.

### 10. Document-size axis: subdocs as guid-prefixed channels

**Finding.** `test/dummy/bench-subdocs.ts` (untracked) tests a
`DocChannel`/`_registerChannel()` design that exists nowhere in `src/`.
The ecosystem verdict on Yjs subdocs: API stable since 13.5, "production-ready
if you write the sync yourself" (AFFiNE/BlockSuite: per-guid refcount, pull
with state vector, push diff, subscribe; Liveblocks: guid-tagged messages
on one room socket), "not ready" if you expect a provider to do it
(y-websocket, y-indexeddb, Hocuspocus all don't; [yjs#526][yjs526] open
since 2023). ([AFFiNE#3029][affine], [Liveblocks subdocs][lb-subdocs],
[Hocuspocus guide][hocus-sub].)

**Idea.** Exactly what the orphaned bench encodes: one `Transport`
connection, a new message type `[MESSAGE_SUBDOC][guid][inner message]`,
root-doc traffic byte-identical to today. Per-guid: own sync state,
shared rate limiter, awareness root-only (document it). Transports with
native cheap channels (PubNub, Ably, Supabase, Nostr filters) may map
guid → channel via an optional hook; Matrix rooms are too heavy, WebSocket
one-socket-per-doc is what y-websocket already does and is "untenable" at
hundreds of subdocs ([discuss 2107][discuss2107]).

**Why it belongs in a sync-optimization round.** Every item above reduces
cost for a *fixed* amount of content. For LiaScript-style courses (many
chapters, one open at a time) subdocs reduce *how much content* each peer
syncs at all — a different axis with potentially larger absolute effect,
and the only real answer to "large document" (partial replication of one
Yjs doc is not a thing: the update format has no per-block addressing;
Loro's shallow snapshots don't map; snapshots need `gc: false`).

**Decision needed.** Resume (as its own design doc + plan, the bench
already exists as the red test) or delete the orphan. Not decided here.

### 11. Persistence-first sync

**Finding.** A peer that has `y-indexeddb` (or this project's IndexedDB
provider) connects and immediately sends SyncStep1 — if the local load has
not finished, its state vector is empty and it downloads the whole
document although it has 99% locally. Chronicle/Liveblocks measured 2-8 MB
first messages dropping to near zero after hydrating first
([anikd][anikd]).

**Idea.** `connect({ waitFor?: Promise<void> })` (or read the IndexedDB
transport's `whenSynced`): defer `syncNow()` until local persistence
resolved. Zero protocol change, and it composes with item 1 (equal vectors
→ no reply at all).

**Validation.** `bench-rejoin-blank-doc.ts` already covers the opposite
case; add a "rejoin with persisted copy" variant measuring SyncStep2 bytes.

## Rejected this round (considered, with reasons)

- **Yjs V2 update format** — measured (baseline B.3): no gain on text,
  larger on small docs, compresses worse after deflate; 10x decode cost in
  the one case it wins ([yjs#675][yjs675]). y-protocols has no V2 sync
  variant, so it would be a private negotiation for nothing.
- **Automerge-style Bloom "have" filters** — solve content-addressed hash
  DAGs; Yjs's `(client, clock)` state vector is already the exact summary.
  Automerge is itself replacing Bloom sync with sedimentree/RIBLT in
  beelay ([Kleppmann][kleppmann-bloom], [beelay][beelay]).
- **Negentropy / NIP-77 for peer-to-peer sync** — 2-3 round trips and a
  24 KB async JS file to reconcile what the state vector does in one. **The
  one legitimate use** is the Nostr provider's catch-up against relays
  that store updates as regular events *and* advertise NIP-77 (strfry does:
  damus, nos.lol, snort) — replaces `REQ since=` with gap-proof
  reconciliation. Only if the Nostr provider moves to stored events; today
  it is best served by ephemeral kinds (item 7). ([NIP-77][nip77],
  [hoytech/negentropy][negentropy], [strfry docs][strfry-neg].)
- **IBLT / Rateless IBLT / minisketch / Merkle search trees / Prolly
  trees** — millions-of-unordered-items tools; no small TS impls; Yjs
  locality makes them strictly worse than the state vector.
- **Delta-state CRDT BP/RR (Enes et al.)** — the concepts (don't send back
  to origin; forward only the newly-applied part) are real and Yjs gives
  them for free (`doc.on('update')` emits only the applied delta), but they
  only matter with *forwarding*, which no transport here does. Revisit if
  item 8 ever adds relaying. ([Enes et al.][enes])
- **FEC / XOR parity, RaptorQ** — see item 5.
- **GossipSub / Plumtree / HyParView as dependencies** — see item 8.
- **CBOR/MessagePack awareness, base85/Z85, brotli/zstd, shared
  dictionaries, WebTransport, WebSocketStream** — see items 7 and 9.
- **P2P agreed compaction (DXOS epochs, Jazz snapshots)** — Yjs `gc: true`
  already makes any live peer's SyncStep2 the compacted form; tombstone IDs
  cannot be pruned without breaking merge with peers holding the items.
- **Compact/renegotiated client IDs** — still no evidence (unchanged from
  rounds 1-3; baseline B.2 shows 6-7 B per client in the state vector).

## Sequencing (if the user wants to proceed)

Ordered by payoff/risk, with the dependency chain made explicit:

| # | Item | Effort | Wire | Depends on | Primary bench |
|---|---|---|---|---|---|
| 1 | 2. Delete-set hash | S | private envelope, +varInt | — | `bench-packet-loss` (+lost-delete scenario) |
| 2 | 1. Digest SyncStep1, reply only on diff | M | new type | 2 | new `bench-idle-room` |
| 3 | 3. Presence handshake | S | none | — | `bench-idle-room`, `bench-late-join` |
| 4 | 4. pendingStructs ground truth | S | none | — | `bench-packet-loss`, `bench-corruption-storm` |
| 5 | 11. Persistence-first `waitFor` | S | none | — | `bench-rejoin-blank-doc` variant |
| 6 | 7. Transport hints + Supabase binary | S/M | per-transport | — | `bench-chunking-compression` matrix |
| 7 | 5. NACK + replay ring | M | new type | 4 (nice), 1 | `bench-packet-loss` |
| 8 | 6. `sendTo?` unicast | M | interface | 1 (sender id) | `bench-mesh-join-burst`, `bench-user-scaling` |
| 9 | 8. Mesh `maxConns` | S | none | — | `bench-mesh-join-burst` partial mode |
| 10 | 9. Awareness delta | M | private | 1 | new byte-count bench |
| 11 | 10. Subdocs | L | new type | own design doc | existing `bench-subdocs.ts` (red) |

**Compound estimate for the idle 50-peer room** (baseline A, scaled to the
default 5 s interval, ~1,200 deliveries/s today): items 1+2 remove the
SyncStep2 class (~−60%); item 3 cuts awareness to the 15 s floor (~−30% of
the original); together ~130 SyncStep1 beacons/s + ~160 renewals/s remain
≈ 290/s, a ~4x reduction with no interface change. Item 6 does not reduce
the beacon (a broadcast by nature) but removes every remaining fan-out on
the join/resync path. **These are estimates from the census arithmetic, not
measurements — the whole point of this document's discipline is that they
get measured before being believed.**

## Decisions for the user (not made here)

1. **Extend `Transport` with optional `sendTo?`** (item 6) — reverses a
   three-round scoping decision; the case for is laid out above, the case
   against is that every existing transport gains an optional method and
   the WebSocket relay server needs a change to benefit.
2. **Wire-format versioning.** `compressionThresholdBytes` already made
   the format non-negotiable ("all peers must set this the same way").
   Items 1, 2, 5, 9 each add a private type or field. Before adding a
   fourth ad-hoc flag, consider one capability byte in item 1's digest
   envelope (peers advertise what they speak; the core degrades to plain
   y-protocols for peers that don't answer). Small, and it retroactively
   fixes the compression-flag compatibility cliff.
3. **Subdocs** (item 10) — resume or delete the orphaned bench.
4. **Idle backoff and compression defaults** — both shipped off in round 3.
   With item 1 in place the idle-backoff trade-off changes (a backed-off
   beacon that gets no reply costs nothing; the recovery-latency cost is
   unchanged) — worth re-deciding then, not now.

## Appendix A — protocol-property probe (Node, plain yjs)

```js
// node --input-type=module (cwd = repo root, so 'yjs' resolves)
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { deflateRawSync } from 'node:zlib'

// 1. delete-set blind spot
const a = new Y.Doc(), b = new Y.Doc()
a.getText('t').insert(0, 'hello world')
Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
a.getText('t').delete(0, 6)                     // this update is "lost"
console.log(Buffer.compare(Y.encodeStateVector(a), Y.encodeStateVector(b)) === 0) // true
console.log(a.getText('t').toString(), '|', b.getText('t').toString())            // world | hello world
const enc = encoding.createEncoder()
syncProtocol.writeSyncStep2(enc, a, Y.encodeStateVector(b))                       // 12 bytes
syncProtocol.readSyncMessage(decoding.createDecoder(encoding.toUint8Array(enc)), encoding.createEncoder(), b, 'x')
console.log(b.getText('t').toString())                                            // world (repaired by DS)

// 3. V1 vs V2 vs deflate on typed text
const d = new Y.Doc(), t = d.getText('t')
for (let i = 0; i < 5000; i++) for (const ch of 'lorem ') t.insert(t.length, ch)
for (const u of [Y.encodeStateAsUpdate(d), Y.encodeStateAsUpdateV2(d)])
  console.log(u.length, deflateRawSync(u).length)
```

## Appendix B — idle-room census (DummyHub, compiled bench build)

```js
// npx tsc -p tsconfig.bench.json first; then node this file from repo root
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { GenericProvider } = require('./bench-dist/src/index.js')
const { DummyHub, DummyTransport } = require('./bench-dist/src/providers/dummy/index.js')
console.warn = () => {}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function classify(msg, out, mult) {           // msg = CRC32-stripped payload
  const d = decoding.createDecoder(msg), t = decoding.readVarUint(d)
  if (t === 4) { while (decoding.hasContent(d)) classify(decoding.readVarUint8Array(d), out, mult); return }
  let key = 'type' + t
  if (t === 0) key = ['SyncStep1', 'SyncStep2', 'Update'][decoding.readVarUint(d)]
  else if (t === 3) { decoding.readVarUint(d); decoding.readVarUint(d); key = 'V-' + ['SyncStep1', 'SyncStep2', 'Update'][decoding.readVarUint(d)] }
  else if (t === 1) key = 'Awareness'
  out[key] = (out[key] || 0) + mult
}

for (const N of [5, 20, 50]) {
  const hub = new DummyHub(), count = {}
  let counting = false, wire = 0
  const orig = hub.broadcast.bind(hub)
  hub.broadcast = (room, data, sender, opts) => {
    if (counting) { const r = hub.getRoomSize(room) - 1; wire += r; classify(data.subarray(4), count, r) }
    return orig(room, data, sender, opts)
  }
  const provs = []
  for (let i = 0; i < N; i++) {
    const p = new GenericProvider(new Y.Doc(), new DummyTransport({ hub, latency: 20, jitter: 5 }),
      { syncInterval: 1000, disableBc: true })
    await p.connect({ room: 'r' }); p.awareness.setLocalState({ user: { name: 'u' + i } }); provs.push(p)
  }
  provs[0].doc.getText('t').insert(0, 'hello')
  await sleep(2500); counting = true; await sleep(10000); counting = false
  console.log(N, wire, count)
  for (const p of provs) p.destroy()
}
process.exit(0)
```

[yprotocols]: https://github.com/yjs/y-protocols/blob/master/PROTOCOL.md
[discuss2669]: https://discuss.yjs.dev/t/how-can-i-tell-if-two-documents-are-synced/2669
[discuss399]: https://discuss.yjs.dev/t/question-regarding-updates-and-state-vectors-in-y-leveldb/399
[discuss1651]: https://discuss.yjs.dev/t/delete-set-pruning-based-on-a-target-state-vector/1651
[discuss2107]: https://discuss.yjs.dev/t/subdocuments-in-ws-provider/2107
[yjs374]: https://github.com/yjs/yjs/issues/374
[yjs675]: https://github.com/yjs/yjs/issues/675
[yjs526]: https://github.com/yjs/yjs/issues/526
[internals]: https://github.com/yjs/yjs/blob/main/INTERNALS.md
[rbsr]: https://logperiodic.com/rbsr.html
[nip77]: https://github.com/nostr-protocol/nips/blob/master/77.md
[negentropy]: https://github.com/hoytech/negentropy
[strfry-neg]: https://github.com/hoytech/strfry/blob/master/docs/negentropy.md
[riblt]: https://arxiv.org/abs/2402.02668
[riblet]: https://github.com/hoytech/riblet
[minisketch]: https://github.com/bitcoin-core/minisketch
[kleppmann-bloom]: https://martin.kleppmann.com/2020/12/02/bloom-filter-hash-graph-sync.html
[beelay]: https://github.com/automerge/beelay/blob/main/docs/sedimentree.md
[enes]: https://arxiv.org/abs/1803.02750
[loro-import]: https://loro.dev/docs/concepts/import_status
[loro-eph]: https://www.loro.dev/docs/tutorial/ephemeral
[figma]: https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
[liveblocks]: https://liveblocks.io/docs/api-reference/liveblocks-client
[gossipsub12]: https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.2.md
[plumtree]: https://asc.di.fct.unl.pt/~jleitao/pdf/srds07-leitao.pdf
[hyparview]: https://asc.di.fct.unl.pt/~jleitao/pdf/dsn07-leitao.pdf
[ywebrtc22]: https://github.com/yjs/y-webrtc/issues/22
[ywebrtc-src]: https://github.com/yjs/y-webrtc/blob/master/src/y-webrtc.js
[pubnub-ch]: https://www.pubnub.com/docs/general/channels/overview
[ably-filters]: https://faqs.ably.com/subscription-filters
[ably-bill]: https://faqs.ably.com/how-does-ably-count-messages
[supa-bc]: https://supabase.com/docs/guides/realtime/broadcast
[supa-limits]: https://supabase.com/docs/guides/realtime/limits
[matrix-std]: https://spec.matrix.org/latest/client-server-api/#send-to-device-messaging
[synapse-rc]: https://matrix-org.github.io/synapse/latest/usage/configuration/config_documentation.html
[nip01]: https://github.com/nostr-protocol/nips/blob/master/01.md
[strfry]: https://github.com/hoytech/strfry/blob/master/strfry.conf
[grahl]: https://lgrahl.de/articles/demystifying-webrtc-dc-size-limit.html
[ws-deflate]: https://github.com/websockets/ws/blob/master/doc/ws.md
[nickb]: https://nickb.dev/blog/wasm-compression-benchmarks-and-the-cost-of-missing-compression-apis/
[affine]: https://github.com/toeverything/AFFiNE/issues/3029
[lb-subdocs]: https://liveblocks.io/docs/guides/how-to-use-yjs-subdocuments
[hocus-sub]: https://tiptap.dev/docs/hocuspocus/guides/multi-subdocuments
[anikd]: https://anikd.com/blog/optimizing-yjs-first-load/

## Addendum (2026-09-05, found while building the phase-1 baseline bench)

### 12. False-positive hash mismatch on every join into a room with content

**Finding (measured, deterministic).** `test/dummy/bench-idle-room.ts` part
(b) tallies provider warnings for a 2-peer room with zero loss and zero
reordering during setup: every sample shows exactly one `Hash mismatch` and
one `Resync scheduled` before the experiment even starts. Mechanism:
`connect()` → `syncNow()` pushes the joiner's full state as a
`MESSAGE_SYNC_VERIFIED` update whose trailing hash is `computeDocHash` of
the *joiner's* state vector. Any receiver that already holds more data
applies the (no-op) update, hashes its *own* state vector, sees a
different value and — since no sequence gap is pending — calls
`_requestResync()`. The receiver then pushes its full state and pulls
(SyncStep1 → SyncStep2 replies from everyone) ~100 ms later. "Sender is
behind me" is indistinguishable from "we diverged" with a single hash.

**Quantified (2026-09-05, after the digest beacon shipped).** A per-phase
warning tally on a 50-peer `DummyHub` room where one peer edits right
after everyone connects (probe sharing the bench build's Yjs instance —
an earlier version of this probe loaded a second Yjs copy, which inflated
its numbers; the corrected run is the one quoted): 531 `Hash mismatch`
warnings and 71 scheduled resyncs during the join, then 47 + 168 "rate
limit exceeded" hits and 16 + 16 further resync attempts during the
following 12.5 s of *complete idleness* — the retries re-arm on every
rate-limited attempt and compete with the periodic beacons for the same
20-per-10 s budget, so the periodic beacons of that window came out at
roughly a third of their expected rate. This is the dominant
cost in every join scenario the bench suite has, and it also throttles
the digest beacon's own steady state for ~10 s after a burst.

**Why it matters.** In a room of N peers with content, every join
deterministically triggers N-1 resyncs: N-1 full-document broadcasts
((N-1)² deliveries) plus N-1 SyncStep1 pulls each answered by ~k peers.
The round-1 design doc attributed the join-burst blow-up (509,850 messages
at N=100) to "hash mismatches [being] common (reordering across many
concurrent senders)"; this addendum shows a mismatch that needs no
reordering at all. It is very likely the dominant term of the join-burst
cost that the rate limiter bounds today — a hypothesis for
`bench-late-join.ts` / `bench-user-scaling.ts` to confirm by counting
`Hash mismatch` warnings during a join with zero loss.

**Fix candidates (measure, don't pick by argument):**
- (a) Send the connect-time push as a plain `MESSAGE_SYNC` SyncStep2
  (`writeSyncStep2(encoder, doc)` with no target vector = full state)
  instead of a hashed `VERIFIED` update. Receivers apply it and never
  hash-compare it. Keeps the single-message-survival property round 2
  requires; loses the push's sequence number (a lost push is caught by
  the digest-beacon exchange within one interval anyway).
- (b) Keep the hash but add a cheap monotone scalar (sum of all clocks in
  the sender's state vector, one varuint) to `VERIFIED` updates: on
  mismatch, `senderSum < mySum` → sender behind, do nothing (their beacon
  fetches the rest); `senderSum > mySum` → I am behind, pull only;
  equal → genuine divergence, resync as today.
- (c) With the digest beacon shipped, drop the hash-mismatch trigger's
  push half for the join case only — rejected on the round-2 evidence
  unless (a) or (b) turns out insufficient.

Not part of phase 1 (out of its design doc's scope); proposed as the first
item of phase 1b, sequenced right after the digest beacon because the
beacon's JOIN path is exactly where this fires.
