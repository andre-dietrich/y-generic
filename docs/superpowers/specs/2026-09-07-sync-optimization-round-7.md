# Sync optimization — round 7 (the axes nobody measured: state per peer, timers, persistence, transports)

## Status

Research **and implementation** on branch `round-7` from `main` @ 377485d
(v1.4.0, 2026-09-07). André asked for the full round: this document with
its baseline, four new benches, all six items with before/after numbers,
version 1.5.0. Per-item results are appended in "Results" as the commits
land. No wire-format change in this round - peers running v1.4.0 and v1.5.0
share a room without trouble (unlike round 5).

## Context

Rounds 3-6 (docs of 2026-09-04, -05, -06, -07) ground down the
message-count axis: idle room, typing, joins, awareness. Round 6 searched the
literature once more and found nothing left on that axis at this project's
scale. So this round swept the axes no earlier round had measured at all
(the round-5 bench map has zero coverage for any of them): state retained
per peer, timer lifecycle, bytes per message including the envelope, CPU per
received update, bundle size, and the storage side effects of the
transports themselves (IndexedDB, the Gun relay).

Method, same discipline as rounds 4-6: three code-reading passes (core,
providers, benches + the decision ledger of rounds 3-6), a throwaway Node
probe against `bench-dist/` for the numbers that need no scenario, and one
new `bench-*.ts` per item that needs one. Where a claim could be checked
locally in minutes, it was - every number below is reproducible with the
command given.

## Measured baseline (`main` @ 377485d)

### A. Closed with numbers - no change

| Axis | Measurement | Verdict |
|---|---|---|
| Bytes per keystroke | raw Yjs update 15 B → wire 33 B (`MESSAGE_SYNC_VERIFIED` envelope 18 B: 4 CRC32 + type + seq + 5 clientID + sync sub-type + length + 5 hash). With the cursor piggybacked (round 5, item 1): **274 B**, of which the awareness JSON is 222 characters. | The envelope is 6 % of a keystroke with a cursor and invisible behind every JSON transport's own wrapper (Gun ~300 B of node JSON, Nostr ~330 B per signed event, Matrix ~1 KB of HTTP per PUT). The cursor JSON dominates 8:1 - and shrinking it is the awareness delta André declined in round 5. Closed. |
| CPU per received update | `Y.encodeStateVector` (what `computeDocHash` hashes, once per sent and once per received update): 2.5 µs / 17 µs / 185 µs / 2.5 ms at 1 / 50 / 500 / 5,000 clientIDs with structs in the doc. `Y.applyUpdate` of a one-character update on the same docs: 11.5 µs / - / 79 µs / 1.2 ms. | The hash costs more than the apply from ~200 editing clientIDs on, but even at 5,000 it is under 3 ms per update - a classroom doc that lives a semester on a persistent backend collects hundreds, not thousands. Note for that day: a digest beacon carries the whole state vector, 6 B per clientID. Closed. |
| Bundle size | Parcel, minified: core + yjs + y-protocols + lib0 = 176.9 KB (49.4 KB gzip); yjs + y-protocols alone 141.5 KB (41.2 KB gzip). The provider's own share: **~35 KB minified, ~8 KB gzip**. | Nothing to cut; the 4,000 lines of `src/index.ts` are mostly comments. Closed. |
| Idle timer wakeups | Relay transport, provider-owned awareness: the lease sweep every lease/10 (2.4-3.6 s at the 30 s default) plus the beacon: ~21 wakeups/min; ~5/min at the playgrounds' 120 s lease. | Chrome throttles a hidden tab to one wakeup per minute regardless (round-5 item 6, parked). Closed - except that the sweep also ran after `disconnect()`, which is item 2. |

Probe (scratchpad, not committed): a fake transport capturing `send()`,
`Y.encodeStateVector` timed with `process.hrtime.bigint()` over 500-2,000
calls, bundle via `parcel build` of an entry importing `src/lib.ts`.

### B. Defects - the items of this round

**B.1 Phantom peers on relay transports.** Yjs gives every page load a fresh
random clientID. `_knownPeers` (a `Set`), `_peerAddress` and `_remoteSeqInfo`
learn each id from its beacons, verified updates and presence
(`src/index.ts:2116`, `:2156-2157`, `:2317-2318`, `:3215`) and forget it only
in `_handlePeerLeave` - which needs `Transport.onPeerDisconnect` (peerjs,
simple-peer, trystero, Supabase, Ably, PubNub with presence) - or in
`disconnect()`. On websocket, gun, matrix, nostr and pubnub-without-presence
every reload of any student adds one immortal entry. `_peerCount()`
(`:2513`) is `max(presence entries, _knownPeers.size + 1)` and feeds the
round-6 `'auto'` awareness interval (20 ms × peerCount), the
reply-suppression window (`_replySuppressionMaxDelay`, log2, capped 200 ms),
the presence-relay gate (`_knownPeers.size >= 3`) and `_responderRank`.

Probe: 2,000 one-shot senders (one verified update each, then gone) into a
provider with `awarenessInterval: 'auto'` → `_knownPeers` 2,000,
`_remoteSeqInfo` 2,000, `_peerCount()` 2,001, effective awareness interval
**40,020 ms**, reply window at its 200 ms cap, ~1 KB of heap per phantom.

`test/dummy/bench-reload-phantoms.ts` (new; part 1): a 20-peer relay room,
a random peer reloads every 200 ms, 30 times; a stationary observer reports
its tables right after the last reload and two 5 s leases later:

```
node --expose-gc bench-dist/test/dummy/bench-reload-phantoms.js
before reloads:     knownPeers=19 peerAddress=19 remoteSeqInfo=1  presence=20 peerCount=20 (live 20) autoAwarenessInterval=400ms
after 30 reloads:   knownPeers=49 peerAddress=49 remoteSeqInfo=31 presence=38 peerCount=50 (live 20) autoAwarenessInterval=1000ms
after 2 leases:     knownPeers=49 peerAddress=49 remoteSeqInfo=31 presence=20 peerCount=50 (live 20) autoAwarenessInterval=1000ms
```

The presence table heals through the lease (38 → 20); the three per-peer
tables never do, and the 20 live peers move their cursors at the interval of
a 50-peer room. A classroom of 30 with a handful of reloads per student per
session reaches this within an hour.

**B.2 The awareness sweep outlives `disconnect()`.** `_startAwarenessSweep()`
is called from the constructor (`src/index.ts:964`), re-arms itself every
tick (`:1625`) and is cleared only in `destroy()` (`:1335-1338`). A provider
that is `disconnect()`ed but not destroyed keeps ticking forever - and the
timer closure keeps provider, doc and transport reachable. LiaScript does
exactly this with its persistence provider (`sync/Base/index.ts`:
`persistProvider?.disconnect()`, never `destroy()`): one leaked provider per
classroom section.

`bench-reload-phantoms.ts` part 2 (`node --expose-gc`): 20 providers
constructed, connected, `disconnect()`ed:

```
lifecycle M=20: Timeout handles after construct=20 after disconnect()=20 sweep timers armed after disconnect()=20 providers alive after GC=20
```

Twenty timers before `connect()` was ever called, twenty after
`disconnect()`, and a full GC collects none of the twenty providers.

**B.3 The IndexedDB transport stores everything, replays everything, and
its compaction loses the document.** `IndexedDBTransport.send()`
(`src/providers/indexeddb/index.ts:234`) writes every frame the provider
sends as one row - a keystroke's batch with its piggybacked cursor, every
awareness broadcast, every digest beacon, and one full-document push per
load; `loadUpdates()` (`:301`) `getAll()`s the log and replays every row
through the provider (the previous session's presence and beacons
included); `autoCompact` defaults to off, and `compact()` (`:365-410`)
deletes the oldest 90 % of rows - document history that was never merged
into anything. The demo playground (`test/indexeddb/index.ts`) runs with
`autoCompact: true, compactThreshold: 100`, i.e. it loses its document
every hundred rows. LiaScript's own `DexieTransport` (liascript2,
`sync/Base/dexieTransport.ts`) re-implements the frame filter and gets it
half right: it drops awareness and pub/sub frames but keeps `MESSAGE_BATCH`
(type 4, every keystroke since round 5) and `MESSAGE_SYNC_DIGEST` (type 5,
every beacon) - and replays both on load, which its own comment describes
as "resurrects the client-IDs of long-gone sessions as phantom peers".

`test/dummy/bench-persist-log.ts` (new; `npm install --no-save
fake-indexeddb`): 1,000 keystrokes with a cursor change each, 10 ms apart,
then a reload, then `compact()` and another reload:

```
node bench-dist/test/dummy/bench-persist-log.js
session 1: 1015 rows, 124.7 KB (128 B per keystroke, 126 B per row)
session 2 (reload): load=58ms content=equal rows after load=1017 (124.8 KB) presence entries=2 knownPeers=1
compact(): 101 rows (12.2 KB); session 3 (reload): content=DIFFERENT (0 vs 1000 chars)
```

126 B per row for a 15 B update; the reload holds a presence entry for its
own previous clientID and counts it as a peer; after `compact()` the
document is **empty**.

**B.4 Gun replays every presence slot ever written to every joiner.**
`GunTransport.sendAwareness()` (`src/providers/gun/index.ts:644-674`) writes
each connection's presence into its own slot `aware-<time>-<random>` under
the room's `awareness` node; `setupAwarenessListener()` (`:682`) subscribes
with `.map().on()`, which replays every existing slot to a new subscriber.
Nothing ever nulls a slot, so the relay (radisk on the classroom image)
keeps all of them, and a joiner receives one awareness frame per connection
the room has ever seen - each one a presence entry, a `_knownPeers` phantom,
and a lease-timeout removal 30 s later.

`test/dummy/bench-gun-awareness-replay.ts` (new; the real `GunTransport`
against the in-memory fake Gun graph of `repro-gun-batch-corruption.ts`,
extended to replay existing children to a `.map().on()` subscriber as Gun
does): 50 peers that crashed an hour ago, 5 that crashed two minutes ago,
5 live, then a joiner:

```
node bench-dist/test/dummy/bench-gun-awareness-replay.js
slots in the graph before the join: 60
joiner: awareness frames delivered=66 presence entries=61 (self + 5 live + 55 phantoms) knownPeers=60
slots in the graph after one graceful leave: 61
```

(61 after the leave = the 60 old slots plus the joiner's; the leaver's slot
is still there.)

**B.5 WebSocket reconnects at a flat 2 s, forever, in lockstep.**
`attemptReconnect()` (`src/providers/websocket/index.ts:298-322`) waits
`reconnectDelay ?? 2000` ms, unlimited attempts by default. A classroom of
30 browsers hits a restarting relay 15 times a second and, when it returns,
all 30 reconnect - and send their JOIN beacons - in the same instant.

`test/dummy/bench-ws-reconnect-storm.ts` (new; a `WebSocket` stub that fails
while the server is "down"): 30 transports, 60 s outage:

```
node bench-dist/test/dummy/bench-ws-reconnect-storm.js
outage: 900 connection attempts in 60s = 900/min, 30.0 per client
   per 10s bucket: 150 150 150 150 150 150
recovery: 30/30 clients back, reconnect time after the server returned min=418ms p50=418ms max=418ms
```

**B.6 `y-provider`** is in `dependencies` (`package.json`) and imported
nowhere in `src/` or `test/` - it ships to every consumer for nothing.

## Items, ranked by payoff / effort

### 1. Remove `y-provider`

`npm uninstall y-provider`. Nothing imports it.

### 2. Arm the awareness sweep in `connect()`, clear it in `disconnect()`

`src/index.ts`: the constructor keeps only the clearing of y-protocols' own
3 s `_checkInterval` (still `_ownsAwareness`-gated: an app-supplied
awareness keeps its own sweep); `connect()` starts the sweep after the
transport is connected; `disconnect()` clears it next to `_syncIntervalId`;
`_startAwarenessSweep()` refuses to double-arm. The tick now always runs -
item 3 needs it with an app-supplied awareness too - but the renew/remove
half stays gated on `_ownsAwareness`.

Behavior change, recorded: while disconnected, remote presence entries no
longer time out locally; the first tick after a reconnect removes whatever
was not refreshed within the lease (a suppressed broadcast the room ignores,
it removed them long ago). The y-websocket alternative - drop every remote
state at disconnect - was rejected: y-protocols' `applyAwarenessUpdate`
ignores a re-delivered state at an equal clock, so after a short WiFi blip
every peer whose clock had not advanced would stay invisible until its next
renewal (up to lease/2), a visible flicker per blip.

Gate: `bench-reload-phantoms` part 2 → 0 timers after construct, 0 after
`disconnect()`, 0 providers alive after GC. Every round-6 gate unchanged
(nothing changes while connected).

### 3. Prune phantom peers with the lease

`src/index.ts`: `_knownPeers` becomes `Map<clientID, lastHeardMs>`, set at
the three learn sites; the sweep tick deletes ids not heard for a lease from
`_knownPeers`, `_peerAddress` and `_remoteSeqInfo`. Review rules, checked
before writing:

- A live peer renews its presence at lease/2 (the tick's own renewal), and
  that renewal is a message every receiver scans (`_scanAwarenessPayload().present`
  → `_knownPeers`), so no live peer with a presence state is ever pruned.
  A headless peer with no presence state may be, under Trickle, after a
  lease of silence - every reader tolerates an undercount (the `'auto'`
  floor is 100 ms, the window is log2, the relay gate is a threshold), and
  the next message re-adds it.
- `_remoteSeqInfo`: a fresh entry starts at `highest = -1` and
  `_trackRemoteSeq` reports a gap only when `highest >= 0`, so a pruned
  sender's next message cannot trigger a false gap check.
- `_peerAddress`: every unicast reply follows a request that re-learns the
  address first (`:2157`, `:2318`), so no unicast path degrades.
- `awareness.meta` (y-protocols) is left alone: it holds the clock a late or
  replayed message is checked against, and `_touchPeer` needs meta+states to
  tell live from departed. ~40 B per id ever seen, the same growth
  y-websocket has.

Gate: `bench-reload-phantoms` part 1 → 19 known peers and a 400 ms interval
two leases after the last reload. Every round-6 gate unchanged: the prune
fires only after a full lease of silence, which no live peer of any gate
reaches.

### 4. WebSocket: exponential backoff with jitter

`src/providers/websocket/index.ts`: delay = `min(maxReconnectDelay, reconnectDelay × 2^(attempt-1)) × (0.5..1.5)`,
`maxReconnectDelay` new, default 10 s; `reconnectAttempts` already resets on
open. Precedent: y-websocket caps at 2.5 s, Socket.IO at 5 s with a 0.5
randomization factor - both favor recovery latency over relay quiet; 10 s
keeps the mean recovery wait under 8 s while cutting the storm ~4x. The
jitter matters more than the exponent: it is the lockstep herd on return,
not the failed handshakes, that costs the relay (30 handshakes and 30 JOIN
beacons in one window).

Gate: `bench-ws-reconnect-storm` → attempts/min down ~4x, recovery spread
0-15 s instead of one instant.

### 5. Gun: skip stale presence slots, null the own slot on leave

`src/providers/gun/index.ts`: `setupAwarenessListener()` ignores a slot
whose `timestamp` is older than `AWARENESS_MAX_AGE_MS` (5 min, a constant:
the transport does not know the provider's lease, and a lease-sized bound
would make a peer with a 1-2 min clock offset invisible - a live slot is
rewritten every lease/2, so 5 min is never reached by one); `disconnect()`
`put(null)`s the own slot. Cooperative garbage collection (a joiner nulls
the stale slots it skips) is one more line and is deferred until join bytes
or relay growth are measured to need it (a joiner deleting a skewed-clock
live peer's slot would be harmless - rewritten at its next presence write -
but there is no number asking for it yet).

Gate: `bench-gun-awareness-replay` → 10 frames applied, 50 skipped, 5
phantoms (the two-minute crashes, gone after one lease), the leaver's slot
gone.

### 6. Persistence: `extractDocUpdates()` / `frameDocUpdate()` in the core, IndexedDB transport rebuilt on them

`src/index.ts` exports two pure functions for persistence transports:
`extractDocUpdates(frame)` returns the Yjs updates a CRC-wrapped frame
carries (recursing into `MESSAGE_BATCH`; `MESSAGE_SYNC_VERIFIED` and
`MESSAGE_SYNC` SyncStep2/Update, `MESSAGE_SYNC_PUSH`; nothing for
awareness, pub/sub, digests, SyncStep1), `frameDocUpdate(update)` wraps one
update as a plain `MESSAGE_SYNC` update frame the provider applies without
replying. `src/providers/indexeddb/index.ts` stores only the updates a frame
carries (one merged raw update per frame, ~15 B instead of ~126 B per
keystroke), loads them as one merged update and trims the log to that one
row (y-indexeddb's `PREFERRED_TRIM_SIZE` idea - needed because every load
appends a full-document push), and compacts by merging; `autoCompact`
defaults to on now that it is lossless. Old rows (whole frames) stay
readable - the loader parses both - so no migration. LiaScript's
`DexieTransport` can drop its own filter and compaction latch for the two
exports (a liascript2 change, not part of this round).

Gate: `bench-persist-log` → ~15 B per keystroke, one row after a load, no
presence entry and no known peer from the previous session, content equal
after `compact()`. Plus `npm run dev:indexeddb` once against a database
written by v1.4.0.

## Seen and parked (with reasons)

- **Matrix** `/sync` without a `filter` (returns state for every room the
  guest joined, not just this one) and a flat 5 s retry on error
  (`matrix/index.ts:226-244`): Matrix is parked since round 5.
- **Ably** `echoMessages: true` in persistent mode (`ably/index.ts:320`):
  LiveObjects requires it for writes; the self-echo is filtered client-side.
  Doubles inbound messages for persistent rooms only.
- **simple-peer** re-publishes presence to every signaling socket every 5 s
  while `peers.size < maxConns` (`simple-peer/index.ts:294-308`, i.e.
  always in a normal room) and rebuilds the chunk array per peer for large
  sends (`:400-421`); **peerjs** `becomeCoordinator()` (`peerjs/index.ts:701`)
  is never called. Mesh transports; no LiaScript classroom runs on them.
- **WebSocket, Ably and Supabase strip the CRC32** and compute a valid one
  on receipt (`websocket/index.ts:223/265`, `ably/index.ts:461/705`,
  `supabase/index.ts:318/463`): corruption detection is void there, but
  TLS makes wire corruption impossible and the only real corruption ever
  seen was Gun's batch concatenation (`repro-gun-batch-corruption.ts`),
  which keeps its CRC. Only a wasted CRC computation per message.
- **Envelope bytes, V2 updates, clientID compaction**: bytes; rejected three
  times before, now with the number that closes it (A: the cursor JSON is
  8x the envelope).
- **`awareness.meta` growth** (y-protocols keeps an entry per clientID ever
  seen): ~40 B each, the sweep iterates it; same in y-websocket. Bounded by
  page loads, left alone (item 3's review rules).
- **The wire-format capability byte** (round-4 decision 2): still open; no
  wire change this round, so not needed yet.

## Decisions for André (defaults chosen here, easy to change)

1. WebSocket `maxReconnectDelay` default 10 s (y-websocket 2.5 s, Socket.IO
   5 s; the bench takes `MAX_RECONNECT_DELAY_MS` to compare).
2. Gun `AWARENESS_MAX_AGE_MS` 5 min, a constant; cooperative slot GC parked.
3. IndexedDB `autoCompact` default on (lossless now); rows stay frames.

## Sources

- [y-websocket](https://github.com/yjs/y-websocket/blob/main/src/y-websocket.js) - `maxBackoffTime` 2500 ms, `log10`-shaped backoff.
- [Socket.IO client options](https://socket.io/docs/v4/client-options/#reconnectiondelay) - `reconnectionDelay` 1000, `reconnectionDelayMax` 5000, `randomizationFactor` 0.5.
- [y-indexeddb](https://github.com/yjs/y-indexeddb/blob/master/src/y-indexeddb.js) - `PREFERRED_TRIM_SIZE` 500: merge the log into one update.
- [Node.js `process.getActiveResourcesInfo()`](https://nodejs.org/api/process.html#processgetactiveresourcesinfo) - the timer count in `bench-reload-phantoms` part 2.
- [Gun `.map()`](https://gun.eco/docs/API#map) - replays existing properties to a new subscriber.

## Results

Appended per commit, in order. Every number: `npx tsc -p tsconfig.bench.json`
then the command given, on the build named.

### Item 1 — `y-provider` removed (commit 2)

`npm uninstall y-provider`: `package.json` and the lock file only; nothing
in `src/` or `test/` imported it.

### Item 2 — the sweep is armed in `connect()` and cleared in `disconnect()` (commit 3)

What changed in `src/index.ts`: the constructor only silences y-protocols'
own `_checkInterval` (still `_ownsAwareness`-gated); `_startAwarenessSweep()`
is called from `connect()` once the transport is up, refuses to double-arm,
gates the renew/remove half on `_ownsAwareness` (the peer-table prune of
item 3 runs for an app-supplied awareness too), and re-arms only while the
status is `connected` (a `disconnect()` from inside a listener stays a
disconnect); `disconnect()` clears the timer next to `_syncIntervalId`.
`bench-reload-phantoms` part 2 gained an allocation scrub before its GC:
the last-disconnected provider lingers in a transient V8 slot until fresh
allocations overwrite it (measured: exactly one survivor, always the last
one, gone after any later activity - not a reference anyone holds).

```
node --expose-gc bench-dist/test/dummy/bench-reload-phantoms.js
before: lifecycle M=20: Timeout handles after construct=20 after disconnect()=20 sweep timers armed after disconnect()=20 providers alive after GC=20
after:  lifecycle M=20: Timeout handles after construct=0  after disconnect()=0  sweep timers armed after disconnect()=0  providers alive after GC=0
```

Part 1 is unchanged on this build (49 known peers two leases after the
reloads) - that is item 3. The round-6 gates are run once on the item-3
build, which contains both changes; see there.

### Item 3 — phantom peers pruned by the lease (commit 4)

What changed in `src/index.ts`: `_knownPeers` is a `Map<clientID,
lastHeardMs>`, set where the `Set` was added (the awareness scan, the
verified-update sender, the digest sender; `_responderRank` iterates
`.keys()`); the sweep tick - which runs on every provider since item 2 -
deletes ids not heard for a lease from `_knownPeers`, `_peerAddress` and
`_remoteSeqInfo`. `awareness.meta` is untouched (the review rules above).
Two benches that read `_knownPeers.size` whitebox had their cast updated.

```
node --expose-gc bench-dist/test/dummy/bench-reload-phantoms.js
before: after 2 leases:   knownPeers=49 peerAddress=49 remoteSeqInfo=31 presence=20 peerCount=50 (live 20) autoAwarenessInterval=1000ms
after:  after 30 reloads: knownPeers=42 peerAddress=42 remoteSeqInfo=30 presence=35 peerCount=43 (live 20) autoAwarenessInterval=860ms
        after 2 leases:   knownPeers=19 peerAddress=19 remoteSeqInfo=19 presence=20 peerCount=20 (live 20) autoAwarenessInterval=400ms
```

Right after the last reload the tables still hold the reloads of the last
lease (42, not 49: the earliest are already gone); two leases later the
observer knows exactly the 19 others, and the cursors move at the 20-peer
interval again.

Gates on this build (items 2 + 3 together), round-6 invocations; the
comparison is the round-6 doc's number unless a fresh sample on 206fe7a
(the build before item 2) is named:

| Gate | Result |
|---|---|
| `bench-idle-room` steady state, N=20 / 50 | 23 /s / 149 /s (round 6: 23 / 153); lost delete 5/5; HASHPROPS PASS |
| `bench-typing-census` N=20 / 50, three runs | 1.30-1.36 / 1.46-1.50 sends per keystroke (round 6: 1.26 / 1.64 - the base cadence's beacons and acks move by a few sends per run) |
| `bench-movers-census` `AWARENESS_INTERVAL=auto`, N=20 / 50 | 500 /s, lag p50 94 ms / 549 /s, p50 84 ms (round 6: 498 / 549) |
| `bench-periodic-awareness` | 4/4 PASS |
| `bench-awareness-removal-burst`, timeout sweep / peer events | 1 removal broadcast per N, detect 30.0-30.4 s / 1-5 broadcasts, detect 6-7 ms (as in round 5) |
| `bench-late-join` | 16/16 cells converged, 0 mismatch, 0 rate-limited, 0 gaps |
| `bench-join-census` | late joiner identical (250 / 500 / 250 / 600 deliveries); fresh burst inside the run-to-run spread - two samples each: 206fe7a N=100 push 52,470 and 59,499 deliveries (ack sends 31 and 102), this build 55,539 and 53,460 (62 and 41). The prune cannot fire inside a 20 s window at a 30 s lease. |
| `bench-mesh-join-burst` | debounce below uncoalesced in every scenario, allSynced |
| `bench-reconnect-cycling` | 0 spurious gaps |
| `bench-rejoin-blank-doc` | 10/10 in both variants |
| `bench-asymmetric-join` | 8/8 at every N |
| `bench-packet-loss` | every cell converged on both profiles |
| `bench-corruption-storm` | bounded, converged |
| `bench-sync-latency` | one message per edit on the push profiles; a second one in some Gun/Matrix cells on both builds (206fe7a: the Gun verify-off cells; this build: other cells) - the profile's own jitter |
| `npm run build` | clean |
