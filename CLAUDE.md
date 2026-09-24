# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`y-generic` (npm name `genericprovider`) is a backend-agnostic Yjs provider. The core
(`src/index.ts`'s `GenericProvider`) implements all Yjs sync/awareness/pub-sub protocol
logic; a `Transport` (`src/transport.ts`) is a 4-method interface (`connect`, `disconnect`,
`send`, `onMessage`, plus optional `onPeerConnect`) that callers implement per backend.
`src/providers/*` are reference transport implementations (dummy, websocket, gun, trystero,
peerjs, simple-peer, conference, indexeddb, matrix, pubnub, supabase, nostr) shipped as separate
subpath exports (`genericprovider/providers/<name>`), each independently tree-shakeable and
mostly gated behind optional peer dependencies.

## Commands

- `npm run build` — `rm -rf dist && tsc` (compiles `src/` per `tsconfig.json`; this is what
  `dist/` — the published artifact — is built from).
- `npm run dev:<provider>` — e.g. `npm run dev:dummy`, `npm run dev:gun`, `npm run dev:websocket`
  — serves `test/<provider>/index.html` via Parcel for interactive manual testing in a browser.
  `npm test` / `npm run dev:dummy`-equivalent opens `test.html`, the multi-client Dummy-transport
  playground (see `test/TEST.md` for the manual test scenarios it's designed to exercise).
- `npm run build:demo:<provider>` / `npm run build:demos` — builds the static demo site
  (deployed by `.github/workflows/deploy.yml` to GitHub Pages on push to `main`).

**There is no automated test runner (no jest/mocha/vitest).** Correctness is verified via:
1. The manual browser scenarios in `test/TEST.md`, run through `npm run dev:dummy`.
2. Standalone benchmark/repro scripts in `test/dummy/bench-*.ts` and `repro-*.ts`, compiled
   with the dedicated `tsconfig.bench.json` and run under plain Node — **not** through Parcel:
   ```
   npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-sync-latency.js
   ```
   Each bench file's header comment has its exact run command (a few need extras named
   there: `node --expose-gc`, `npm install --no-save fake-indexeddb`). These exist to reproduce and
   quantify specific protocol issues (sync latency across simulated network profiles, message
   count vs. user-count scaling, packet-loss/corruption storms, late-join/asymmetric-join
   behavior) — read the file's own header before changing it, they encode the scenario being
   measured.

When changing sync/awareness/resync logic in `src/index.ts`, prefer adding or extending a
`test/dummy/bench-*.ts` script over hand-testing, since these are what caught prior regressions
(resync storms, hash-mismatch false positives, awareness loss for late joiners) with actual
numbers instead of "seems fine when I tried it."

## Architecture

### Core protocol (`src/index.ts`)

`GenericProvider` owns a `Y.Doc`, a `Transport`, and an `awarenessProtocol.Awareness`
instance, and speaks a small message-type framing over whatever the transport moves as
`Uint8Array`: `MESSAGE_SYNC` (0), `MESSAGE_AWARENESS` (1), `MESSAGE_PUBSUB` (2),
`MESSAGE_SYNC_VERIFIED` (3, sync + CRC32 + doc-hash + sequence number). Everything below is
implemented once here so individual transports stay to the 4-method interface:

- **Sync protocol**: standard `y-protocols/sync` (SyncStep1/SyncStep2/Update), with an
  optional verified variant (`verifyUpdates`, default on) that wraps messages with a CRC32
  checksum, a cheap O(distinct-clients) doc hash (`computeDocHash`, hashes the *state vector*,
  not full content), and a per-sender sequence number for gap/duplicate/reorder detection.
- **Unified resync coordinator** (`_requestResync` / `_pendingResyncTimeoutId` /
  `_resyncAttemptCount`): hash-mismatch, corrupted-message, and confirmed-gap triggers all
  route through one pending timer and one shared exponential-backoff counter, so they can't
  each independently spam resyncs under sustained corruption — this replaced three
  independently-escalating triggers after that was found to cause an ~11x message-volume
  "resync storm" under 5% link corruption (see `docs/superpowers/plans/2026-07-26-sync-storm-ratelimit.md`).
- **Sync-request rate limiting** (`_syncRequestTimes` / `_maxSyncRequestsPerWindow`): caps
  SyncStep1 pulls and `syncNow()` pushes per rolling window; `syncNow()`'s full-state push
  shares the same limiter as resync retries.
- **SyncStep2 reply suppression** (`_pendingSyncReply`): when ≥2 peers are known, a reply to
  a SyncStep1 request is delayed briefly and dropped if another peer's reply is overheard
  first, since replies broadcast to the whole room — avoids redundant identical replies.
- **Update batching** (`_batchUpdate`, `batchUpdates` option) and **awareness throttling**
  (`_awarenessInterval`) are separate debounce paths — batching coalesces doc updates,
  throttling coalesces awareness broadcasts; both exist because awareness churns much faster
  than document content typically does.
- Cross-tab sync via `BroadcastChannel` is wired independently of the transport
  (`_setupBroadcastChannel`) so multiple tabs in the same browser stay in sync without
  round-tripping through the network transport.

`Transport.preferredBatchMs` lets a transport hint its own recommended default
`batchUpdates` value (e.g. HTTP-polling or internally-debounced relays should set this;
low-latency push transports like WebSocket/PubNub/connected WebRTC should leave it undefined).

`src/sync-monitor.ts` (`SyncHealthMonitor`) is a separate, optional, pub/sub-based
peer-to-peer-broadcast health check — distinct from and complementary to the built-in
per-update `verifyUpdates` hash check. See `src/SYNC-MONITORING.md` for when to reach for
which (short version: built-in verification for fast per-update desync detection, the
monitor only for periodic all-peers diagnostics/alerting).

### Providers (`src/providers/*`)

Each provider directory holds one `Transport` implementation, generally with its own
`README.md` covering that backend's setup and options. `dummy` is the in-memory reference
transport with no external dependency, used by both `test/TEST.md`'s manual scenarios and
the `test/dummy/bench-*.ts` benchmarks — read it first when implementing a new transport, or
when a bench script's `DummyHub`/`DummyTransport` behavior itself needs to change (the design
doc `docs/superpowers/specs/2026-07-26-dummy-benchmark-scaling-design.md` explains what's
protocol-under-test vs. what's test-infrastructure-only cost).

`peerjs`, `simple-peer` and `trystero` are true mesh P2P transports: `onPeerConnect` fires per
newly-joined remote peer and, since round 5, the provider answers each with one unicast digest
beacon (`_schedulePeerConnectSync`, debounced 50 ms) instead of a full-state `syncNow()`
broadcast — the O(N²) full-state burst the dummy benchmark design doc describes is history;
`test/dummy/bench-mesh-join-burst.ts` is the gate.

What phones do to these transports (a suspended page: silent links dropped by the room after
~30 s, a dead signaling socket, a wall-clock jump on resume) is covered by
`docs/superpowers/specs/2026-09-19-webrtc-mobile-resilience-research.md`. Its gates run the real
transports against scripted backends under plain Node - `test/providers/repro-simple-peer-sleep.ts`
(the real simple-peer on a fake `wrtc` + fake signaling socket), `test/providers/repro-peerjs-coordinator.ts`
(a scripted PeerJS constructor) - plus `test/dummy/bench-presence-after-relink.ts` and
`bench-wake-false-timeout.ts` for the core; run them after touching connection lifecycle code in
`simple-peer/`, `peerjs/` or the awareness sweep. Two real-browser E2E scripts go further than any
fake can (`test/simple-peer/e2e-resume.mjs`, `test/peerjs/e2e-handover.mjs`: headless Chrome via
`puppeteer-core`, real WebRTC; their headers name what they need) - the second one is what found
that Chrome parks a vanished peer's link in ICE `disconnected` forever.
`test/e2e/room-scenarios.mjs <simple-peer|peerjs|trystero|websocket|ably|pubnub|nostr|gun>` runs a
classroom-sized room (25 Chrome contexts) through join / concurrent typing / a killed tab / five
frozen pages / a reload / a server restart with one peer typing meanwhile / (peerjs) a killed
coordinator; `DIAG=1` names who is missing from whose roster, and every frame the room sends is
counted. Local servers, except `ably` and `pubnub` (the real services, keys in the gitignored `.env`:
`node --env-file=.env ...`) and `LIVE=1` (`nostr`, `gun` against the public relays named there) - what
cannot be restarted is reached through a CONNECT proxy that the "restart" cuts. Every failure it
found was invisible with 2-3 peers: `maxConns` cutting the mesh, a resuming peer's removal broadcast
emptying bystanders' rosters, Trystero not re-subscribing, three ways `verifyUpdates:false`
(y-websocket mode) left a hole in the server's copy of the document; on the relays and hosted
backends (third pass of the spec) a Nostr subscription and a Gun relay link that never came back,
Ably's rate limit failing a join, and two core bugs: peers that are ALL incomplete never answered a
sync request, and the last joiner's roster. Two rules they enforce: never assign
`peer._pc.on*statechange` (simple-peer owns those properties), and a connection's `close`/`error`
handler may only remove its own entry, never "whatever is under this peer id now".
What the harness finds gets a fast gate under plain Node before the fix:
`test/nostr/repro-relay-restart.mjs` and `test/gun/repro-relay-restart.mjs` (a relay that went away;
the library's path is an env var, see their headers), `test/nostr/repro-persistent.mjs` (Nostr's
`persistent` snapshot: what is still in its debounce when the page unloads or disconnects, and
behind an encrypting wrapper - LiaScript's password - the snapshot is built UNDER the wrapper, so
the wrapper hands its encryption down as `ConnectionConfig.sealFrame`), `test/gun/repro-lone-joiner.mjs` (what a
backend REPLAYS of the document must reach a joiner whose peers are all gone - an initial load
that skips what arrives before it called back loses exactly that, and the first update of a fresh
room too), `test/providers/repro-ably-lifecycle.ts` (a
scripted Ably `Realtime`: its own reconnect, a channel over its message rate),
`test/providers/repro-pubnub-lifecycle.ts` (a scripted PubNub along the SDK's two paths: the
browser's `offline` DESTROYS a client made without `restore: true` - deaf for good after `online`;
a failed subscribe polls back; an unloading page's publish needs a `keepalive` copy, `flush()`),
`test/dummy/bench-rate-limited-channel.ts` (a backend that REFUSES a publish loses it for every
receiver at once), `test/dummy/bench-last-joiner-roster.ts` (presence on demand) and
`test/dummy/bench-renewal-under-churn.ts` (what goes to ONE peer must not count as a presence
renewal to the room - found at 50 browsers only because that run outlived a 300 s lease; `RELAY=1`:
nor does our state at a clock the room already holds - the presence table a settled peer answers
a relay joiner with renewed it nowhere, PubNub with a reload every 6 s). A relay
transport whose link comes BACK by itself tells the provider through `onPeerConnect` (websocket,
nostr, ably, gun, pubnub) - never for the first connect. Opt-in scenarios of the harness: `linger`
(outlives a presence lease under churn - a passing standard run is over before one is;
`LINGER_GAP_MS=5000` checks while a short lease's ghost is still there), `offline` (a page's
network goes and comes back through the DevTools protocol - the browser fires `offline`/`online`,
the proxy cut of `restart` never does; `OUTAGE_MS=` makes that cut outlast a lease),
`storm` (sustained load, `STORM=typing,cursor,bulk,faults`: ten typists for a minute in unique
tokens - every page notes when it first saw each, so lag p50/p95 and what is missing; a presence
storm; 100 KB inserts while they type; a reload, frozen pages, an offline typist and a server
restart while they type. It found what 2-3 peers and short bursts never do: Gun's update slots
shared by every writer - `test/gun/repro-concurrent-writers.mjs`, a writer owns its slots - and a
PeerJS page that woke while the server was gone giving up its re-join - `repro-peerjs-coordinator`
part 14, a re-join tries until it holds. A block inserted where a typist types can split a
token: CRDT order, not a loss - insert far from them),
`bandwidth` (bytes per peer from `getStats()`) and `oneway` (a link that receives and cannot send,
made on purpose - Chrome does that by itself about once per 50-peer join: an `RTCDataChannel`
object that stays at `connecting` after its own `open`; a transport must rebuild a link whose
`send()` throws, never just log it - `repro-simple-peer-sleep` part 7, `repro-trystero-oneway`;
`docs/superpowers/specs/2026-09-20-join-presence-miss-note.md`). `DIAG=1` pairs two pages'
`RTCPeerConnection`s by ICE ufrag and prints what each end sent and received. `FIREFOX=10` runs
that many peers in a headless Firefox (tabs of one Firefox: all but the last are HIDDEN, and
Firefox delays a hidden tab's timers by up to ~20 s in a busy room; `FIREFOX_EACH=1`: a process
and a visible tab each). That is why a late timer is not a sleep: `watchResume` reports one only
when ticks AND links were silent for `resumeAfterMs` (30 s), at the first sign of life after the
silence - never "a message means awake", a waking page handles its queued messages first
(`repro-simple-peer-sleep` parts 8-10). `test/e2e/phone-session.mjs <simple-peer|conference|peerjs|trystero|nostr|websocket|gun|ably|pubnub>`:
a real phone in a room of headless peers, reporting on itself through its presence
(`conference`: `CONFERENCE_EXPECTED=`, `LEAF=1` puts the phone at the edge - and use more
than 16 desktop peers or the dial rule builds a FULL mesh and the wrapper relays nothing;
`trystero` is served over **https**, because `crypto.subtle`, which its room keys need, is
withheld from a plain-http LAN address - every page then finds nobody and sends "to 0
peers" for ever, which also means a classroom on Trystero needs https). What only the phone
found, round 13: Trystero installed `watchResume` in an `else` branch of
`getRelaySockets`, so no real page had sleep detection - away 40 s it took 20.5 s to
re-join, away 3 minutes it never did, while counting 7-8 links (conference: 0.5 s for the
same absences). Both watches run now; gate `repro-trystero-oneway` part 4. What a page
still owes the room when it unloads (its presence removal, a pending update batch) must not
wait for a timer - a hidden Firefox tab runs none before it is gone:
`test/dummy/bench-unload-removal.ts` - and a transport that defers its writes (Gun: its own
turn queue, drained by a task the page never runs) must put them on the wire in that same
task, `Transport.flush()`, called by the unload handler (`test/gun/repro-unload-removal.mjs`:
never heard -> heard before the process is gone; the same gate: a transport's `disconnect()` must
not erase the removal the provider just wrote, and what a backend REPLAYS to a joiner is history,
not presence - a killed tab's slot said "here" for a lease of the joiner's own; Gun tells an
answer to its own get (`@`) from a live write (`#`, looked through the `VIA` of a message gun
converted "from old format" - it re-emits every slot that way when the page writes its own),
`test/gun/probe-replay.mjs`, and hands no replayed presence up: the roster comes from the room's
answer to the JOIN; 128.5 s -> 0.5 s of 25 browsers); a relay peer back from a dead link asks the room for its
presence and forgets the clocks of whoever it expired (`bench-relay-return-roster.ts` - on a
relay nobody noticed that it was away); a peer that is told it is gone says at once that it
is not, at WHATEVER presence clock the removal comes - an editor binding's equal-state re-sets
raise the local clock without a broadcast, and they stamp `lastUpdated`: the sweep renews by
when the ROOM last heard us, never by that stamp (`bench-removed-at-old-clock.ts`, parts 1 and
2); a y-websocket
server is a peer with a fixed 30 s lease (keep the default `awarenessTimeoutMs` with one; check
6 of `e2e-edrys-ws.ts`); the harness's "0 of N" says a roster is not N long, not why - `DIAG=1`
prints the sizes; and never edit a playground's source while a harness
run serves it (parcel rebuilds under the run). Why the mesh stays full and what a relay under the
core would take: `docs/superpowers/specs/2026-09-20-partial-mesh-relay-research.md`
(`test/dummy/probe-partial-mesh.ts`).

`src/providers/conference/` (`ConferenceTransport`) is the way past the full mesh: a wrapper
UNDER the core around a mesh transport that holds a handful of links per peer (`dial`, the rule
in `src/providers/dial.ts`, wired into simple-peer) and passes frames on - Plumtree with one tree
PER ORIGIN and a state per DIRECTION of a link, digests + GRAFT as the repair path, unicast along
the way the origin's broadcasts came, SUSPECT / ALIVE / REVIVE / LEAVE for who is there. Its gate
is `test/dummy/bench-partial-mesh.ts` (N=100 by default, `N=150`, `N=300`; the real wrapper and the
real dial rule over simulated data channels and signaling, no oracle; `DIAG=1` names a roster's
holes and prints the frames around them, `TRACE_FILE=` dumps them all) plus
`test/providers/repro-simple-peer-sparse.ts` (the real simple-peer on a loopback `wrtc`). Run
both after touching either directory. Its last two phases - a page that UNLOADS (the core's
`beforeunload` in order, then the channels close) and RELOADS pages coming back under new
addresses (`RELOADS`, `RELOAD_GAP_MS`; 250 ms is the storm) - are measurements, not verdicts,
until round 13's departure findings are fixed: `GATE_DEPARTURE=1` turns them into one. They
run last on purpose, because they change who is in the room. What they say today: the removal
of an unloading page empties a full mesh in 25 ms and a LEAF-heavy partial mesh in 1.4 s, and
sometimes not at all - `docs/superpowers/specs/2026-09-22-conference-transport.md`, round 13,
which also has the round's fix and the two repairs that failed on the way to it. A page that
reloads says goodbye (`provider.disconnect()` -> C_LEAVE), but that frame is the LEAVER's
and travels the leaver's paths, so it reaches ~3.6 of 24 peers; those mark the origin `gone`
SILENTLY, and the dead link a moment later is then skipped ("already gone", 69 of 69 in a
420 s run) - so nobody tells the room, and whoever missed the goodbye also missed the
presence removal that took the same dying path and held the entry for the core's whole 300 s
lease (48 of 81 checks carried a ghost, `stats.suspects` was 0). **`_relayLeave`**: whoever
hears a C_LEAVE says it again in ITS OWN voice, scattered and suppressed like a suspicion,
and without a `_byPeer` check (a goodbye is the peer's word, not a guess). 48 of 81 -> 5, 17
broadcasts for 300 goodbyes heard, and an idle room of 300 stays at 533 frames/s against 524
untouched. Gate: the "deaf to goodbye" phase. What does NOT work, both measured before it:
`idleSuspectMs` (suspect what went quiet - correct, gated, and **ships off (0)** because an
idle room of 300 went to 19,611 frames/s: peers are legitimately silent for minutes and a
false departure costs a resync; turn it on below ~50 peers) and a C_LEAVE from the unloading
page via `Transport.leave` (reverted - it dies on the same path the presence removal dies
on, 50 ms without it vs 76 ms with). Also open: a killed tab takes 23-33 s instead of 6 s to
leave every roster. In the browser harness `conference` also runs
`linger`, `offline`, `storm` and `oneway` now, and `phone-session.mjs conference`
(`CONFERENCE_EXPECTED=`, `LEAF=1` puts the phone at the edge) is wired. Every rule in there was a failure of that gate first, each
named in the comment next to it: one tree for the room falls apart (two origins prune two links of
one cycle), one flag for both directions of a link cuts a peer off (its feed prunes over a
duplicate FROM it), a change of a link's default must keep the origins that arrive over it, a
route may only come from a frame that advances the front (else unicast goes in a circle), a seq
below the first one heard is not history for 3 s (a joiner's second frame overtook its JOIN
beacon), an ALIVE may arrive before its SUSPECT. The one thing it needed from the core: an
address learned from a single-state awareness frame. What it costs on top of the relay is the
core's: periodic beacons are suppressed less when paths differ in length (N=300: 91 vs 55).

`src/providers/resume.ts` (`watchResume`) is the shared sleep detector (a timer that finds
`Date.now()` far ahead of its last tick), used by both mesh transports to re-join under a new id.
`watchNetworkChange` says the page's NETWORK CHANGED (a `navigator.connection` `change` of the
`type`, or `online` after `offline` where there is none - Firefox): every WebRTC link then runs
over an address that is gone, and waiting for ICE to say so costs 15 s in Chrome and 25-30 s in
Firefox - the three mesh transports drop their links and re-join at once, as after a sleep
(`repro-simple-peer-sleep` parts 13-16, `repro-peerjs-coordinator` part 15,
`repro-trystero-oneway` part 3; each with the control that a `change` which is no change of
the network does nothing). A relay
transport needs none: the phone's OS closes its socket with the interface. And while a mesh
transport has no socket and no link, a signaling attempt times out after 4 s and its backoff is
capped at 3 s (Firefox reports NOTHING when the WiFi comes back: only the next attempt finds it -
a phone was 60 s out of the room).
`watchPageBack` next to it is the shared "the page has its network again" - `visibilitychange`
to visible, `online`, and `change` on `navigator.connection` (a phone that falls back to mobile
data says `online` when the WiFi GOES, not when it is back): simple-peer, PeerJS, Nostr,
WebSocket, Gun and Ably do not sit out a reconnect backoff then (`test/providers/repro-websocket-wake.ts`,
`test/gun/repro-page-back.mjs`, `repro-ably-lifecycle` part 7; PubNub's SDK polls every 3 s; a
"do it now" must also give up an attempt that is in the air over the network that is gone).

### Design docs

`docs/superpowers/specs/` and `docs/superpowers/plans/` contain point-in-time design/spec
documents for specific protocol changes (currently: resync-storm rate limiting, dummy
benchmark scaling). They're written *before* the corresponding code change and are useful for
the "why" behind decisions baked into `src/index.ts`, but treat them as historical rationale,
not current-state documentation — the code and its inline comments are authoritative for
current behavior.

## Package structure notes

- `main`/`types` point at `./dist/lib.js` / `./dist/lib.d.ts`. `dist/` is **tracked and
  committed** (not gitignored): every commit that touches `src/` rebuilds it with `npm run build`
  and includes the result, as the git history shows. `bench-dist/` (the `tsconfig.bench.json`
  output) is gitignored.
- Each transport is also its own `exports` subpath (e.g. `./providers/gun`) mapping to its own
  compiled file under `dist/providers/<name>/`, so consumers only pull in the transport they
  actually import.
- `gun`, `simple-peer`, and `peerjs` are `peerDependencies` marked optional — don't add new
  transport dependencies as regular `dependencies`; follow this pattern (peer + optional) so
  the core package stays dependency-free for consumers who don't need that transport.
