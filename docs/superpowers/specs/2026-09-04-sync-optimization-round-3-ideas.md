# Further sync optimization — round 3 research

## Status

Research only — no implementation, no benchmark evidence yet. This is a
candidate list for a future design doc + plan, not a decision record. Every
item below needs its own before/after bench run before being trusted, per
the hard-learned rule from the two prior rounds
(`docs/superpowers/specs/2026-07-26-dummy-benchmark-scaling-design.md` and
`docs/superpowers/specs/2026-09-04-resync-message-reduction-design.md`):
reasoning about traffic without measuring it under the specific scenario it
targets has produced a wrong call twice already (Task 2 of the 07-26 plan:
expected 5-10x, measured 1.3x; Item 2 of the 09-04 plan: passed its own hard
gate, then reverted after a *second* benchmark found it made packet-loss
convergence worse). Nothing here should be read as "should ship" — only
"worth measuring."

## Method

Read `src/index.ts` end to end again (now 1669 lines, post round 2), plus
`src/transport.ts`, `src/sync-monitor.ts`, and grepped all 12
`src/providers/*` transports for size/rate constraints that the core
protocol doesn't know about. Looked specifically for angles the first two
rounds didn't cover: they were scoped to *error-recovery* traffic (resync
triggers, mesh join bursts). This round looks at *steady-state* traffic
(the periodic heartbeat, ordinary typing, awareness) and at *transport-side
constraints* that turn byte-size into message-count on specific backends —
both outside the first two rounds' stated scope.

## Findings, roughly ranked by expected payoff / effort

### 1. Byte-size reduction IS message-count reduction on chunking transports — re-examine the "secondary metric" framing

**Finding:** `src/providers/pubnub/index.ts:59,215` chunks any payload over
~30KB (PubNub's 32 KiB hard limit) into multiple messages.
`src/providers/ably/index.ts:11,227-228` does the same for Ably's size
limit. The 09-04 design doc explicitly scoped "bytes-on-wire" as
"secondary/explanatory" to message count — true for WebSocket/PubNub-normal-size/Gun/etc.,
**false for PubNub and Ably specifically once a payload crosses their
chunk threshold**: on those two transports, a single oversized `syncNow()`
push or SyncStep2 reply literally *becomes* N wire messages, not one. A
document large enough to cross ~30KB (not exotic — a few thousand words of
rich text, or any doc with substantial history before GC) means every full-state
push/reply on those transports already multiplies message count today,
silently, with no benchmark currently measuring it (all `bench-*.ts`
scripts use `DummyTransport`, which has no size limit or chunking at all).

**Idea:** add a lightweight compression pass (no new dependency needed —
gzip via Node's/browser's native `CompressionStream`, which is standard in
modern runtimes, or a small pure-JS deflate if Node/browser coverage is a
concern) to `_send()` for payloads above some threshold (e.g. 2-4KB, below
which compression overhead isn't worth it). `Y.encodeStateAsUpdate` output
compresses well (structured, often-repetitive binary) — real-world y-webrtc
users report typically 3-6x reduction on synced-history payloads with plain
deflate. On PubNub/Ably that directly divides chunk count, hence message
count, by roughly that same factor for any push/reply that currently
crosses the chunk boundary.

**Validation:** new bench script measuring `Y.encodeStateAsUpdate` output
size and post-compression size across a range of synthetic doc sizes/edit
histories (no network needed for this first pass — it's a pure
size-reduction question), then a chunking-aware bench harness (would need
`DummyTransport` to grow an optional chunk-size-limit mode, mirroring how
round 2's Task 3 added `onPeerConnect` simulation for the same reason: the
scenario under test doesn't exist in `DummyTransport` today).

**Risk to flag up front (matches the round-2 Item-2 lesson):** compression
adds CPU cost per message and a fixed per-message overhead (compression
headers) that can make *small* messages larger, not smaller. This must be
gated by a size threshold and measured on the small-message path too
(typing-latency scenario, not just large-payload scenario) before shipping.

### 2. Combine push+pull+awareness into one wire message at shared trigger points

**Finding:** every place that currently calls `syncNow()` (`connect()`,
`_requestResync()`'s retry, `_schedulePeerConnectSync()`'s debounced
callback, the public API) sends the push+pull half via `_trySyncPushPull()`
**and then separately** calls `_broadcastAwareness()` — two (sometimes
three, since push and pull are each their own `_send()` call inside
`_trySyncPushPull`) independent wire messages for what is conceptually one
event. The periodic-sync interval (`connect()`, `src/index.ts:502-514`) does
the same: `_sendSyncStep1()` then `_broadcastAwareness()`, every
`syncInterval` (default 5s), for the entire lifetime of every connected
peer — this is the single largest *steady-state* (not error-recovery)
source of message volume in a long-lived room, and round 1/round 2 didn't
touch it (both were scoped to error/burst scenarios).

**Idea:** a new message type (`MESSAGE_BATCH = 4`) that concatenates
multiple already-encoded sub-messages (each still individually
`writeVarUint8Array`-framed) behind one CRC32 wrapper. `_send()` gains a
micro-queue: within the same synchronous tick (or a 0ms/microtask flush),
multiple `_send()` calls coalesce into one `MESSAGE_BATCH` envelope instead
of going out as separate wire sends. This is a pure framing change — no
protocol semantics change, every sub-message is still parsed exactly as
today by `_handleIncomingMessage`, just looped. Cuts message count by
roughly half at every trigger point listed above without changing any
timing/backoff/suppression logic already in place.

**Validation:** rerun `bench-sync-latency.ts` (steady-state periodic-sync
cost, the scenario this targets most directly) and `bench-user-scaling.ts`
— message count at N=50/100 should drop close to 2x for the periodic-sync
component specifically (awareness-only broadcasts and pure content-update
traffic are unaffected, so total reduction will be less than 2x room-wide —
compute the periodic-only component separately, don't just eyeball the
total). This is the most invasive item on this list (new message type,
touches `_send()` which is the single choke point) — proportionally, it
also needs the most benchmark scrutiny before being trusted, per the
compounding lesson of round 2's reversal.

### 3. Skip the periodic awareness re-broadcast when the transport already has `onPeerConnect`

**Finding:** `connect()`'s periodic-sync interval (`src/index.ts:506-511`)
re-broadcasts local awareness on *every* tick, with a comment explaining
why: "Transports without onPeerConnect ... never otherwise re-broadcast
presence to peers that joined after our last broadcast." But on transports
that *do* have `onPeerConnect` (peerjs, simple-peer, trystero — exactly the
mesh transports CLAUDE.md flags as the highest-message-volume risk
already), every new peer already triggers `_schedulePeerConnectSync()` →
`syncNow()` → an awareness broadcast on join. The periodic re-broadcast on
those transports is answering a problem (new peers missing presence) that's
already solved by a different mechanism — it's pure redundant traffic for
the entire connected lifetime of every mesh peer.

**Idea:** in `connect()`'s periodic-sync callback, only call
`_broadcastAwareness()` when `!this.transport.onPeerConnect`. One-line
conditional, no new state, no new option.

**Validation:** `bench-user-scaling.ts` or a new small script isolating
periodic-only traffic over a long-running (multi-interval) session on a
`DummyTransport` configured with the round-2 `onPeerConnect` simulation —
expect the periodic-awareness-broadcast message class to drop to ~0 for
that configuration, no change for a plain `DummyTransport` without it (the
default/current behavior must be provably unchanged there — that's the
correctness gate).

### 4. Jitter the periodic sync interval per instance

**Finding:** `_syncInterval` (default 5000ms) is a plain `setInterval`
starting from `connect()`'s own call time. Peers that connect within a
short window of each other (the common case: everyone joins near session
start, or reconnects near-simultaneously after a shared network blip) end
up with near-synchronized periodic timers — every `syncInterval`, most of
the room's `_sendSyncStep1()` + awareness calls fire in the same few
milliseconds instead of being spread across the window. NACK-suppression
already smooths the *reply* side of this, but the *request* burst itself
(N simultaneous SyncStep1s, N simultaneous awareness broadcasts) is
untouched — this is structurally the same "synchronized burst" problem
`_requestResync()`'s backoff and round-2's peer-connect debounce both exist
to solve, just for the *steady-state* periodic path instead of the
error/join path.

**Idea:** jitter the periodic interval by e.g. ±20% per instance (compute
once at `connect()` time, or re-jitter each tick) — spreads a room's
periodic traffic roughly evenly instead of in synchronized spikes. Doesn't
reduce total message count on its own, but reduces peak concurrent
messages, which matters for rate-limited/paid-per-request transports
(PubNub, Ably, Matrix) and for how much of the shared
`_tryReserveSyncSlot()` budget a burst consumes at once (a jittered spread
draws from the rolling window more evenly, leaving more headroom for a
genuine resync trigger landing in the same window instead of finding the
budget already exhausted by a periodic-tick pile-up).

**Validation:** new small bench scenario — M peers connecting within a
tight window, `syncInterval` left at a short value to make several periods
observable in a reasonable test duration, measuring peak
messages-per-100ms bucket before/after jitter (not total count, which is
unaffected by design — the metric here is burst smoothing).

### 5. Adaptive/backing-off periodic interval for idle rooms

**Finding:** `_syncInterval` is a fixed cadence for the entire connected
lifetime regardless of activity. A room that's been completely idle for an
hour still fires a full pull-request + awareness cycle every 5s, forever.
At the scale this project's benchmarks already target (tens to ~100 peers
per room), and more so at the scale of "many rooms on one deployment" (not
something `DummyTransport`/the current bench suite models at all — every
bench script simulates one room), idle background traffic is pure waste:
periodic sync exists to catch missed updates, and there's nothing to have
missed if nothing has changed.

**Idea:** back off the periodic interval (e.g. double it, capped at some
ceiling like 60s) after each tick that produces no hash mismatch / no
incoming traffic since the last tick, and reset to the base interval on any
local or remote document/awareness activity. Same shape as
`_requestResync()`'s existing exponential-backoff pattern, applied to the
*absence* of problems instead of their presence.

**Caution:** this directly trades off recovery latency after silent packet
loss during an idle period — the whole reason `syncInterval` exists is as a
loss-recovery backstop. A room that's been quiet for 10 minutes and then
silently drops one message needs the *next* periodic tick to catch it; if
that tick is now 60s away instead of 5s away, recovery is slower right when
it's needed. This is a real product trade-off (bandwidth/cost vs. worst-case
recovery latency), not a free win, and should probably ship as an opt-in
(default off, or default cap tuned conservatively) rather than the new
default — flag this explicitly for the user's decision rather than assuming
YAGNI-splitting the difference is fine.

### 6. Scale SyncStep2 reply-suppression window with room size

**Finding:** `_syncReplySuppressionMs` (default 30ms, `src/index.ts:1120`)
is a fixed random delay regardless of how many peers are in the room. The
round-2 design doc's own historical numbers (pre-rate-limiter-backstop)
showed the SyncStep2/SyncStep1 ratio growing from ~1.1-1.3 at N=2 to
~4.5-5.9 at N=10 — i.e. suppression alone degrades as N grows, which is why
the hard rate-limit backstop (`_sendSyncReply`'s `_tryReserveSyncSlot()`
gate) was added on top of it. That backstop bounds the *damage*, but a
larger room still has more independent repliers racing to answer the same
request within the same fixed 30ms window, so more of them lose the race
and get silently dropped by the backstop instead of never sending in the
first place — wasted computation and, on any transport where a
rate-limited attempt still costs something before being dropped locally
(none currently, but worth noting as an assumption), wasted cost.

**Idea:** scale the max suppression delay with a rough room-size signal
already available (`this.awareness.getStates().size`, already read at the
existing `>= 3` gate) — e.g. `min(cap, base * log2(peerCount))` — so a
100-peer room spreads replies over a wider window than a 3-peer room,
giving the "someone already answered" signal more time to actually be
overheard before more repliers commit.

**Validation:** rerun the existing `bench-user-scaling.ts` at high N
(50-100, the scale this project already benchmarks at) — compare the
SyncStep2/SyncStep1 ratio and the `_sendSyncReply` drop rate before/after.
This is the smallest, lowest-risk item on this list (touches one delay
computation, no new state) and could reasonably be sequenced first.

### 7. Awareness-removal broadcasts are redundant across the whole room, unsuppressed

**Finding:** `awarenessProtocol.Awareness`'s built-in `_checkInterval`
(`node_modules/y-protocols/awareness.js:59-77`, confirmed by reading the
dependency directly) independently sweeps every ~3s
(`outdatedTimeout/10`) and calls `removeAwarenessStates(..., 'timeout')`
for any peer silent for 30s+. Every connected provider in the room runs
this sweep independently against the same 30s timeout, so when one peer
goes silent (crash, dirty network drop — no clean `disconnect()`), *every
other peer in the room* detects and broadcasts the same removal within the
same ~3s window — an O(N) simultaneous "peer X is gone" broadcast burst for
one actual event, none of it covered by the existing SyncStep2-specific
NACK-suppression (which only applies to sync replies, not awareness
updates).

**Idea:** apply the same "delay + drop if overheard" pattern
`_scheduleSyncReply`/`_cancelPendingSyncReply` already implements, scoped
specifically to awareness updates whose *only* change is a removal (i.e.
`removed.length > 0 && added.length === 0 && updated.length === 0` in
`_setupAwarenessSync`'s handler) — genuinely low-value to send N times when
1 is enough, since it's pure "this peer is gone" information with no
per-sender content difference (unlike a cursor-position update, where every
sender's broadcast is meaningfully different and must not be suppressed).

**Judgment call:** this is the lowest-priority item here — it fires only on
ungraceful disconnects (not the common path), and the burst is one-shot per
departure, not sustained. Worth a benchmark to confirm the actual
message-count impact before investing implementation effort; likely small
relative to items 1-4 in absolute terms, included for completeness since it
follows the exact pattern that already proved valuable for SyncStep2.

## Explicitly out of scope for this round (with reasons)

- **Compact/renegotiated client IDs** — still no evidence this is a
  bottleneck (state-vector size scales with distinct-client count, not
  message count); unchanged from both prior docs' own scoping.
- **Changing the `Transport` interface itself** (e.g. a native
  multi-message batch-send primitive instead of framing batches inside
  existing `send()`) — item 2 above deliberately stays inside the existing
  4-method interface for the same reason the prior two rounds gave: bigger
  than this work justifies unless items within the existing interface prove
  insufficient.
- **Gossip/digest-based sync (send "I have state vector X" instead of full
  SyncStep2 replies to everyone)** — a materially bigger protocol redesign
  than anything else on this list; not proposed here, flagged only so it's
  visibly considered-and-rejected rather than silently missing, matching
  this project's own documentation convention for such items.

## Unrelated observation: orphaned uncommitted work

`test/dummy/bench-subdocs.ts` and `bench-dist/` are untracked
(`git status`) and reference a `_subChannels`/`_registerChannel()`/
`DocChannel` API that does not exist anywhere in current `src/index.ts` —
i.e. a TDD-red test written against a "Yjs subdocument sync" feature that
was apparently planned (the file's header references a
"Yjs subdocument sync for GenericProvider" plan) but no such plan document
exists anywhere in `docs/superpowers/` or git history. This looks like
interrupted work from a prior session, not part of this round's scope.

Worth flagging on its own merits, separate from message-count optimization:
Yjs subdocuments are a legitimate, structurally different lever for sync
*volume* reduction at the document-size level (lazy-load and sync only the
subdocs currently in use — e.g. the open chapter/page of a large
document — instead of the whole tree), which is a different axis entirely
from every item above (those all reduce message count for a *fixed* amount
of content; subdocs would reduce how much content needs syncing at all for
large documents). Recommend asking the user whether to resume/finish that
work as its own effort, or discard the orphaned file — not decided here.

## Suggested next step

Not a commitment to build all seven — sequence by expected payoff/risk
ratio if the user wants to proceed:

1. Item 6 (suppression-window scaling) — smallest, lowest-risk, reuses
   existing benchmark infra as-is.
2. Item 3 (skip redundant periodic awareness on mesh transports) — one-line
   conditional, needs the round-2 `onPeerConnect` simulation infra which
   already exists.
3. Item 4 (jitter periodic interval) — small, needs a new burst-smoothing
   metric (peak-per-bucket) that current bench scripts don't compute yet.
4. Item 1 (compression) — needs new `DummyTransport` chunking-limit mode
   before it's even benchmarkable; high real-world payoff specifically for
   PubNub/Ably users.
5. Item 2 (message batching) — highest payoff, highest risk/invasiveness;
   do last, after the smaller items have either shipped or been ruled out,
   so its own benchmark run isn't confounded by simultaneous unrelated
   changes.
6. Item 5 (idle backoff) — needs explicit user sign-off given the
   recovery-latency trade-off; not a default-on decision to make alone.
7. Item 7 (awareness-removal suppression) — lowest priority, do only if
   its own benchmark shows a real effect.

Each item still needs its own design-doc-level spec (trigger, fix, bench
script, hard gate) before implementation, following the same discipline as
both prior rounds — this document is the idea list that precedes that, not
a replacement for it.
