# WebRTC transports on phones — why links die and do not come back (research)

## Status

Research **and implementation** on branch `round-8` from `main` @ 209a103
(2026-09-19), one commit per component (simple-peer, peerjs, core), version
1.6.0 - and a second pass the same day with 25 real browsers per transport
(WebSocket included), seven more findings, version 1.7.0: see "Second pass"
below. André's report: a phone browser joins a room over WebRTC;
another app comes to the front or the display goes off; the link breaks,
and coming back to the room is unreliable. Asked for: walk through every
WebRTC connection path (transport and core), find out what y-webrtc does
differently - then: fix every point and test each fix. All seven items are
done, plus an eighth the real-browser test turned up; every row below was measured on the unfixed code first (the unfixed
build is kept as `bench-dist-baseline/` while working) and again after its
fix. No wire-format change. `dist/` is rebuilt.

| Item | Gate | Before | After |
|---|---|---|---|
| 1 simple-peer: handlers left to simple-peer | `repro-simple-peer-sleep` 1-2 | gathering-first: no `onPeerConnect`; ICE `failed`: no `onPeerDisconnect`, 1 dead peer counted; returning peer: 0 connections | `onPeerConnect` in both orders; `onPeerDisconnect`, 0 peers; 1 connection |
| 2 simple-peer: signaling reconnect, ping, announce on close, live default server | part 3; `e2e-resume.mjs` step 3 (real Chrome) | 0 reconnects, 0 announces in 11 s; after a signaling restart a joiner finds the room **never** | 1 reconnect, 3 announces; joiner finds both peers in 1.0 s |
| 3 peerjs: claim handlers decide once | `repro-peerjs-coordinator` 1-3 | coordinator Peer destroyed in all three (part 3: zombie) | not destroyed, nothing rebuilt |
| 4 core: presence rides on the link's first beacon, clock bumped | `bench-presence-after-relink` | presence back after 12-29 s (20 s lease), 22-38 s (40 s lease); edit 102 ms | 76-78 ms both ways; edit 102 ms |
| 5 half-open entries expire; a fresh offer / dial replaces the old entry | simple-peer 4-5, peerjs 6-7 | offer fed to the old peer object, 0 new connections; entry blocks the id for good (0 re-dials); peerjs refuses the returning peer | old entry reported gone, 1 new connection, answered; entry expires, 1 new connection / dial; accepted |
| 6 resume: transports rebuild under a new id after a sleep; core's sweep grants a lease instead of expiring the room | simple-peer 6, peerjs 11, `bench-wake-false-timeout`, `e2e-resume.mjs` step 2 | nothing happens; phone's roster 1 of 10, bystanders lose 297 roster entries, 378 deliveries | links dropped, re-announce under a new id / new Peer; roster 10 of 10, 0 lost, 45-54 deliveries; real Chrome, 16-20 s frozen: text 51-69 ms, rosters 1.1-1.2 s after the unfreeze |
| 8 peerjs: a link that stays in ICE `disconnected` is closed (`iceDisconnectTimeout`, 15 s) - **found by the real-browser test, not by reading** | `test/peerjs/e2e-handover.mjs` (real Chrome, PeerJS cloud), `repro-peerjs-coordinator` 12 | the coordinator's tab is killed, a third peer joins: B and C see each other **never** (150 s watched, same on `main` @ 209a103) - Chrome keeps the dead link in `disconnected`, PeerJS closes on `failed` only | 21.1 s; C has the room's text; the failed-claim path of item 7 seen live ("claim failed, looking for the coordinator again" → connected) |
| 7 peerjs coordinator: claim before destroy, re-dial lost pairs, reconnect backoff, only the coordinator speaks for the room, coordinator retried, timers die with `disconnect()` | peerjs 4, 5, 8, 9, 10 | 0 re-dials; failed claim destroys our Peer and its mesh links; 1,888 `reconnect()` calls in 10 s; a peer's `peer-left` closes our healthy link; coordinator never dialed again | 1 re-dial; Peer and links intact; 4 calls; ignored; 2 dials in 12 s |

Regression gates of the core changes (baseline → after): `bench-mesh-join-burst`
at the default 50 ms debounce 260 / 1,038 / 2,275 → 251 / 1,076 / 2,304
messages, `allSynced` everywhere (run-to-run noise: the presence rides in
the beacon's frame, no delivery is added); `bench-reconnect-push` 3-4
deliveries per reconnect before and after; `bench-awareness-removal-burst`
(`DUMMY_PEER_EVENTS=1`, N = 5 / 10 / 20 / 50) removal deliveries 3 / 16 /
18 / 96 → 3 / 8 / 18 / 96, every survivor's state dropped after 4-7 ms in
both.

Found on the way, fixed with the items: in both mesh transports the
`close`/`error` handler of an OLD connection object removed whatever entry
held the peer's id by then - a newer link included (simple-peer reports
`close` asynchronously; it tore down the replacement link of item 5 in the
first run of its gate). Both transports now remove only their own entry.
PeerJS: `disconnect()` did not stop pending election / retry timers - a
disconnected transport kept constructing Peers (it corrupted the first run
of the repro); all session timers are now bound to an epoch.

**Not done, deliberately:** the PeerJS discovery design itself (one
coordinator id per room). Item 7 removes the self-destruction around it,
the single point of failure stays: while the PeerJS server holds a silent
coordinator's registration (its `alive_timeout`, 60 s) the mesh keeps
working but new joiners wait. Replacing discovery is a wire-visible
redesign that wants real multi-device PeerJS testing - documented as a
known limit in `src/providers/README.md` and the transport's header.
simple-peer in the same real-Chrome test drops a vanished peer after 16.2 s
(`e2e-resume.mjs` step 4; simple-peer also listens to `connectionState`,
which Chrome does move to `failed`) - no watchdog added there. Trystero:
nothing to fix in the wrapper. **Not tested: a real phone**, and no browser
but Chrome. The
CDP freeze of `e2e-resume.mjs` stops the page's timers but not Chrome's
network thread, so the link survives it (which is why step 2 also passes
on the unfixed code, in 37 ms - it proves the resume path works in a real
browser, not that it is needed); an OS-suspended phone browser is what the
scripted repros model. `online`/`visibilitychange` are still not used: the
timer-gap detector needs neither, a network switch without a sleep is
covered by ICE failure (~30 s) and the signaling ping (30-45 s).

The scripts (all but the last under plain Node,
`npx tsc -p tsconfig.bench.json && node bench-dist/<path>.js`):

| Script | What it runs |
|---|---|
| `test/providers/repro-simple-peer-sleep.ts` | the real `simple-peer` 9.11.1 on a scripted RTCPeerConnection + fake signaling socket, bare vs. through `SimplePeerTransport` |
| `test/providers/repro-peerjs-coordinator.ts` | `PeerJSTransport` on a scripted PeerJS constructor emitting the errors peerjs 1.5.5 emits |
| `test/dummy/bench-presence-after-relink.ts` | two `GenericProvider`s, a link cut and restored in both directions without a provider disconnect |
| `test/dummy/bench-wake-false-timeout.ts` | N providers, one with a short lease whose clock jumps (a phone waking up) |
| `test/peerjs/e2e-handover.mjs` | the PeerJS playground in a real headless Chrome against the PeerJS cloud: join, sync, the coordinator's tab killed, a third peer joins (needs `puppeteer-core` and network) |
| `test/simple-peer/e2e-resume.mjs` | the simple-peer playground in a real headless Chrome: real WebRTC, the real y-webrtc signaling server, a page frozen through the DevTools protocol, a signaling restart (needs `puppeteer-core`, see its header) |

Summary of what was broken (the findings as researched, before the fixes), most damaging first:

| # | Where | Finding | Measured |
|---|---|---|---|
| S1 | simple-peer | the transport's debug hooks overwrite simple-peer's own ICE / connection-state handlers: a dead link is never noticed | ICE `failed` → bare simple-peer closes (`ERR_ICE_CONNECTION_FAILURE`); transport: `onPeerDisconnect` never, `connectedPeers` stays 1 |
| S2 | simple-peer | the dead entry blocks the returning phone for good | phone re-announces under its id → **0** new connections |
| S3 | simple-peer | the signaling WebSocket never reconnects | socket killed → **0** reconnect attempts, **0** announces in 11 s, `isConnected` still `true` |
| S4 | simple-peer | same overwrite: `'connect'` fires only if ICE connects *before* gathering completes | gathering first → bare: `connect`; transport: no `onPeerConnect`, 0 connected peers |
| P1 | peerjs | error handlers of the coordinator claim stay attached; any later non-fatal PeerJS error destroys the coordinator | `peer-unavailable` or `network` → coordinator Peer destroyed; after a won re-election: destroyed, nothing constructed, `isConnected` `true` (zombie) |
| C1 | core | after a link re-opens the document heals at once, presence only with the next clock bump of the peer | edit 102 ms; presence 12-29 s at a 20 s lease, 22-38 s at 40 s. Mesh default lease is 300 s |
| P2-P6, C2 | peerjs, core | by code reading, not measured — see the sections below | - |

y-webrtc in one sentence: it is not smarter about phones (no
`visibilitychange`, no heartbeat, no ICE restart either) — it is more stable
because it leaves simple-peer's failure detection intact, its signaling
socket reconnects by itself (lib0 `WebsocketClient`), and it re-announces
the moment a peer closes. S1, S3 and S4 are regressions against it, not
missing features.

## Second pass: 25 peers in a real browser (v1.7.0)

André, after the v1.6.0 commits: "with how many peers did you test?" - three,
at most. `test/e2e/room-scenarios.mjs` now runs each WebRTC transport and the
WebSocket transport as a **classroom: 25 Chrome contexts** (isolated, one
renderer each, local servers: y-webrtc's signaling server, a PeerJS server,
a minimal NIP-01 relay for Trystero's nostr strategy, the edrys y-websocket
relay) through seven scenarios: join, five peers typing at once, a killed tab,
five pages frozen for 20 s (Chrome closes a frozen page's WebSockets: "Page
entered Back-Forward Cache" - the closest a desktop gets to a backgrounded
phone), a reload, a server restart with a new peer joining afterwards, and
(peerjs) the coordinator's tab killed. `DIAG=1` names who is missing from
whose roster.

Every failure below was invisible with two or three peers. None of them is a
regression of round 8 - except that F2 had a self-healing path which the
round-8 presence bump closed (which is how it became permanent and visible).

| # | Transport | Found at 25 peers | Cause | After the fix |
|---|---|---|---|---|
| F1 | simple-peer, peerjs | one peer ended with 20 of 24 links and missing from 4 rosters - at join, no churn needed | `maxConns` defaulted to 20-34 (y-webrtc's value). y-webrtc re-broadcasts what it receives, so a partial mesh works there; GenericProvider needs a FULL mesh (nobody relays). A room of 21+ peers lost pairs | default 64, documented as "every peer of the room must fit": 24 links everywhere |
| F2 | core (mesh) | after five peers resumed at once, bystanders that had nothing to do with it were left in 8 of 25 rosters, for good; final rosters 15-21 of 25, the document identical throughout | a peer that drops all its links itself (resume) took each onPeerDisconnect for a departure and, ~1 s later, broadcast the removal of everyone it had not re-learned yet; receivers held those peers at the same clock and dropped them, although their own links to them were fine | a removal claimed by a third party is ignored for a peer we hold a live link to (transports that report link closes); a peer whose LAST link went cancels its removal broadcast. `bench-resume-roster`: 8 foreign roster entries lost, one roster stuck at 2 of 10 -> 0 lost, all complete. E2E: all rosters complete 2.1 s after the unfreeze, full mesh |
| F3 | trystero | a page that had been frozen never connected to a peer that joined afterwards (18 of 24 rosters); after a relay restart nobody could join at all (0 links) | Trystero re-opens a relay socket that closed but does not send its subscriptions (REQ) again: the peer keeps its links and is deaf to every new offer. A phone in the background loses all relay sockets at once | new option `getRelaySockets` (the strategy module exports it): once none of the sockets we joined with is left, leave and re-join the room. Reload after a freeze: never -> 2.5 s; join after a relay restart: never -> 0.8 s |
| F4 | websocket (y-websocket style server) | typed text reached NOBODY as soon as the awareness state held a cursor (1 of 25 editors) | `verifyUpdates:false` servers keep their own copy of the document: they apply plain sync messages and broadcast what changed, and relay everything else unread. The first keystroke rode in a MESSAGE_BATCH with the cursor (round 5, item 1) - relayed, never applied to the server's doc; every later plain update depended on it, stayed pending there and was never broadcast | in this mode a document update always travels alone. `e2e-edrys-ws` check 3: NO ("t") -> YES; E2E: 60 concurrent characters everywhere after 23 ms |
| F5 | websocket | after a relay restart, text typed afterwards reached nobody (90 s watched) | the restarted server asks every client for its state with a plain SyncStep1; with 3+ clients the reply was delayed by the reply suppression and then cancelled by the server's own (empty) SyncStep2 - nobody refilled the server's doc | in this mode a plain SyncStep1 is answered at once, unsuppressed (a diff against the server's state vector). Check 5: never -> 50 ms; E2E: 19 ms |
| F6 | websocket | after a socket dropped and re-opened (frozen page, phone) the peer stayed out of the rosters for up to a lease (> 120 s in the playground) | the server removed its presence with the old socket; the transport reconnected by itself and the provider never learned of it, so it re-sent its state at the clock the room had just seen removed | `WebSocketTransport.onPeerConnect` fires on every RE-open; the provider bumps its clock, announces itself and pushes what the room has not confirmed. Check 4: 14.8 s -> 1.4-2.7 s; E2E: 2.8 s |
| F7 | websocket | bystanders dropped out of 23 rosters for a few seconds when a frozen peer's socket closed | the server books every awareness entry to the connection it arrived on and removes them all with it; a peer that had once relayed the whole presence table for a joiner (phase 1e) "owned" those users | no presence-table relay in this mode (the server hands a joiner the table itself) |

Found on the way, in the harness, not the library: five cursors typing at the
same spot interleave their runs - the editor, not a loss; the typing scenario
counts characters.

Results on the final code, 25 peers (ms; "rosters" = every peer lists every
other peer):

| Scenario | simple-peer | peerjs | trystero | websocket |
|---|---|---|---|---|
| join: rosters complete / links per peer | 37 / 24 | 1,921 / 24 | 434 / 24 | 405 / - |
| 60 characters of 5 concurrent typists everywhere | 39 | 76 | 971 | 23 |
| killed tab dropped from every roster | 17,217 | 22,253 | 7,053 | 454 |
| 5 pages frozen 20 s: missed text / rosters complete | 125 / 2,308 (5 of 5 resumed) | 138 / 1,777 (5 of 5 resumed) | 67 / 85 (re-join follows within seconds) | 2,834 / 2,841 |
| reload: rosters complete | 467 | 958 | 1,945 | 548 |
| server restart: new text everywhere / new peer in every roster | 33 / 733 | 20 / 1,221 | 27 / 1,128 | 19 / 775 |
| coordinator killed: dropped / new peer in, rosters complete | - | 23,050 / 24,770 after the kill | - | - |
| final: editors identical, rosters, links | yes, 25/25, 24 | yes, 25/25, 24 | yes, 25/25, 24 | yes, 25/25, - |

Regression gates of the core changes (v1.6.0 -> now): `bench-mesh-join-burst`
251 / 1,076 / 2,304 -> 269 / 1,057 / 2,217 messages, `allSynced` everywhere;
`bench-reconnect-push` 3-4 deliveries per reconnect in both; all repros and
benches of the first pass unchanged (`bench-presence-after-relink` 78 ms,
`bench-wake-false-timeout` 0 lost). No wire-format change.

Still not tested: a real phone, any browser but Chrome, the public
infrastructure (PeerJS cloud, public Nostr relays - a room of 25 against
somebody else's servers is not a test to run casually), rooms larger than 25.
For the edrys fork (`dev`): F4-F7 are in the path it uses - its `syncMode:
'pull'` and app-awareness opcode differ from `main`, so they want a run of
`room-scenarios.mjs websocket` on that branch.

## Third pass: the hosted backends and the relays, 25 peers (2026-09-20)

André: "can you test that with ably, nostr, pubnub and gundb as well?" - the
same classroom, `test/e2e/room-scenarios.mjs <ably|pubnub|nostr|gun>`. Ably
and PubNub run against the real services (keys in `.env`,
`node --env-file=.env`), Nostr and Gun against a local relay (the harness'
NIP-01 relay, `Docker/gun/relay.js`) and, with `LIVE=1`, against the public
relays named in `.env`. What nobody here can restart is reached through a
CONNECT proxy of the harness, and "restart" cuts that proxy for 5 s: every
socket of every peer dies at once - a network outage. New in the harness:
one peer types WHILE the server is down; every WebSocket frame (and PubNub
publish request) the room sends is counted through the DevTools protocol,
because a hosted backend meters exactly that; a peer that fails to join is
a result, not a crash; rosters that are incomplete after 10 s say who is
missing from whose.

Two of the eight findings are in the core and affect every transport.

| # | Where | Found at 25 peers | Cause | After the fix |
|---|---|---|---|---|
| T1 | nostr | after a relay restart text reached nobody (1 of 4 editors, rosters 1-2), a frozen page never got the missed text | nostr-tools closes a relay's subscriptions for good when its socket closes, while `publish()` re-opens the socket each time: after the restart the relay saw 24 connections, 67 EVENTs - and ONE REQ, the new peer's. The pool's own `enableReconnect` gives up on a socket that reports `error` before `close`, which is what a killed relay produces. A relay that is down at `connect()` is reported the same way, and `connect()` resolves | one subscription per relay, subscribed again when the relay closes it (1 s, doubling to 30 s), events deduplicated by id. `test/nostr/repro-relay-restart.mjs`: never -> 1.0 s, down at join never -> 1.0 s. E2E: 428 ms |
| T2 | nostr | hearing again is not knowing what was said: the five frozen pages had the missed text after 21.9 s, with the next beacon somebody happened to send | nobody asks | `onPeerConnect` when a relay holds the subscription again after NONE did (nostr-tools reports a failed attempt as EOSE, then close, in one tick - only an EOSE still open a microtask later counts). 21.9 s -> 1.2 s |
| T3 | ably | 1 of 25 peers failed to join, in both runs | Ably rejects what exceeds a channel's message rate - free tier 50 messages/s, error 42913 "nonfatal" - and the room peaks at 56-84 frames/s while 25 peers join within 8 s. A refused `presence.enter()` was thrown out of `connect()` | the enter is tried again until it holds and never fails `connect()`: 25 of 25 |
| T4 | ably | by reading, then scripted (`test/providers/repro-ably-lifecycle.ts`): after ably-js's own reconnect the transport receives and never sends again | `connection.once('connected')` set the flag that `'disconnected'` clears | `on('connected')`, and the provider is told (`onPeerConnect`). E2E, 5 s outage: text typed during it everywhere 15.2 s after the network is back (ably-js retries every 15 s), typed afterwards 413 ms. Not measured on the unfixed code: its run ended at T3 |
| T5 | ably | a refused publish was logged - and lost for every receiver at once. A refused presence: 21 of 25 rosters incomplete for 172 s (half of the 5 min lease). A refused keystroke: see C1 | the transport is told (the promise rejects) and did nothing | refused is not failed: published again after 1-2 s, further each time, five times. Rosters of a join with 33 refusals complete after 828 ms, five typists' 60 characters everywhere after 2.3 s |
| C1 | **core** | five peers typing at once on Ably (82-103 frames/s): the text was everywhere after 2.5 s, 6.6 s - or not within 80 s, 17 resync attempts on every peer, `synced` true on all | a peer with pending structs answered no sync request ("let a complete peer answer"). A refused publish is lost for ALL receivers: two typists, one refused keystroke each, and everybody holds a later struct it cannot integrate - each typist waits for the other's keystroke while holding the only copy of its own. Nobody is complete, nobody answers, for ever. The same silence would meet every later joiner of a room whose typist left after a refused keystroke | an incomplete peer answers LAST (after the whole reply horizon of the complete ones, whose reply cancels it) and never with an ack. `bench-rate-limited-channel` part 1 (4 peers, two refused keystrokes): never -> 1,068 ms; part 2 (25 peers, 50/s limit): converged in 3 of 6 runs -> 6 of 6 (1.8-10.4 s) |
| C2 | **core** | every few runs the LAST joiner's roster lacked 7-8 of 24 peers - every third one - for half a lease: 80 s and 73 s on Nostr, 27 s on PubNub. Earlier joiners have the same gap and never show it: the answers to the next JOIN heal them | presence on demand marked a peer "covered by the relayed table" once per response timer, not per requester: a timer still running took the next JOIN in, covered by a table sent before that joiner was subscribed - and when the 2 s relayer role had just moved on, nobody relayed for it either. Needs a response window longer than the gap between joins (an RTT hint: Nostr, Gun, Matrix; or a slow link) | a table answers the JOINs heard before it, no others. `bench-last-joiner-roster`: incomplete in 11 of 12 runs -> 0 of 12. E2E: 6 of 6 joins complete in 0.4-0.8 s. `bench-join-census`: a late join still costs 2 awareness sends |
| T6 | gun | five frozen pages never heard or reached anybody again; after a 5 s relay restart EVERY peer was alone (rosters 1/1/1, editors different) | gun 0.2020.1241, browser websocket adapter: `wire.onclose` calls `reconnect(peer)` - one attempt in 2 s - and then `mesh.bye(peer)`, whose handler deletes the peer from `opt.peers`; when that attempt fails, `reconnect()` returns at `if(!opt.peers[peer.url])`. Gun tries once | the transport puts the relay back and dials (3 s, doubling to 30 s) and tells the provider when it said hi again. `test/gun/repro-relay-restart.mjs` (that adapter under Node, relay down 6 s): never -> 3.3 s. E2E: frozen pages 3.7 s, text typed during the outage 5.8 s |

Open, found and not fixed: a reloaded Gun page leaves a ghost in every
roster for one lease (124 s) - Gun writes through several timers, the
presence removal of `beforeunload` does not reach the wire (by reading, not
by experiment). Gun's own protocol sent ~7,500 frames for a 25-peer join and
~50 frames/s when idle (Ably, PubNub, Nostr: 2-6 frames in 10 idle seconds).
PubNub needed no change; its SDK polls a lost network every 3 s.

Results on the final code, 25 peers (ms):

| Scenario | ably (live) | pubnub (live) | nostr (local / public relays) | gun (local) |
|---|---|---|---|---|
| join: rosters complete | 828 (33 refused sends) | 413 | 412-817 in 6 runs / 535 | 408 |
| frames sent during the join: total, peak per second | 353, 67 | 200, 55 | 194, 35 / 540, 128 | 7,493, 2,769 |
| frames in 10 idle seconds | 2 | 2 | 2 / 6 | 533 |
| 60 characters of 5 concurrent typists everywhere | 2,318 | 1,132 | 607 / 1,038 | 2,184 |
| killed tab dropped from every roster | 15,161 | 30,344 (no presence: the 30 s lease) | 120,898 / 120,827 (120 s lease) | 120,436 (120 s lease) |
| 5 pages frozen 20 s: missed text / rosters complete | 405 / 407 | 418 / 423 | 1,211 / 1,214 - 1,575 / 1,780 | 3,681 / 3,691 |
| reload: rosters complete | 778 | 709 | 588 / 556 | 124,338 (open, above) |
| outage 5 s: text typed DURING it everywhere, since it ended | 15,198 | 5,312 | 2,172 / 5,077 | 5,816 |
| text typed afterwards / a new peer in every roster | 413 / 1,058 | 459 / 979 | 416 / 880 - 412 / 1,272 | 407 / 953 |
| final: editors identical, rosters | yes, 25/25 | yes, 25/25 | yes, 25/25 / yes, 25/25 | yes, 25/25 |
| sends the backend refused, whole run | 42 | 22 (during the outage) | 0 / 0 | 0 |

Gun against the public relays of `.env` (`LIVE=1`) is not in the table:
nothing arrived (rosters 0 of 25 complete, text in 1 of 25 editors), and it
is the relays - plain Gun, two Node processes, no y-generic:
`gun.defucc.me` never says hi, `relay.peer.ooo` says hi and does not pass a
live write from one process to the other (12 s watched). The README's
warning about public Gun relays stands; a classroom wants its own
(`test/gun/relay.sh`).

Regression gates of the two core changes: `bench-packet-loss`,
`bench-corruption-storm`, `bench-late-join` all converged, messages within
run-to-run noise (late join at 3 % loss, 12 samples per cell instead of 3,
because a 3-sample mean looked slower: 289 / 451 / 227 / 201 ms before,
202 / 219 / 226 / 370 ms after - outliers on both builds);
`bench-mesh-join-burst` 233 / 924 / 2,565 -> 215 / 905 / 2,565 messages;
`bench-join-census` awareness 100/2 and 200/2 per late join on both builds;
the round-8 gates unchanged (`bench-presence-after-relink` 79 ms,
`bench-wake-false-timeout` and `bench-resume-roster` 0 lost,
`bench-reconnect-push` 3-4 deliveries). No wire-format change.

What the numbers say about Ably's free tier: a join of 25 within 8 s and
five simultaneous typists are both above 50 messages/s. The room survives it
now, at the price of seconds; a class that types all at once wants a plan
with a higher channel rate.

Still not tested: a real phone, any browser but Chrome, Supabase and Matrix
in this harness, rooms larger than 25, the edrys fork (`dev`).

> Everything from here on describes the code **as found** (`main` @ 209a103,
> before the fixes); line numbers and the quoted repro output refer to that
> state. What changed, and the numbers after, are in the Status table above.

## What a phone does to a WebRTC page

Backgrounded tab or display off: the browser throttles, then freezes the
page's timers (seconds to minutes, depending on browser and OS - not
measured here); the OS closes or starves its sockets. For the other peers the phone simply goes
silent: ICE consent checks (RFC 7675) go unanswered, `iceConnectionState`
turns `disconnected` after ~5 s and `failed` after ~30 s. The phone itself
gets **no event while frozen**; on resume its RTCPeerConnections still read
`connected` and need their own ~30 s of failed consent checks to notice,
its WebSockets report `close` late or at once, and `Date.now()` has jumped
by the length of the sleep. No code in `src/` listens to `visibilitychange`,
`pageshow`, `freeze`/`resume`; only the PeerJS transport listens to `online`.

So every transport has to survive four things: (a) a peer going silent,
(b) its own signaling socket dying, (c) a peer returning **under the id the
room still holds a dead entry for**, (d) a wall-clock jump.

## simple-peer transport (`src/providers/simple-peer/index.ts`)

### S1/S4 — the debug hooks replace simple-peer's failure detection (lines 789-796)

simple-peer 9.11.1 wires the peer connection with property handlers
(`node_modules/simple-peer/index.js:111-119`):

```js
this._pc.oniceconnectionstatechange = () => { this._onIceStateChange() }
this._pc.onicegatheringstatechange  = () => { this._onIceStateChange() }
this._pc.onconnectionstatechange    = () => { this._onConnectionStateChange() }
```

`_onIceStateChange` is what sets `_pcReady` (needed for `'connect'`) and
what destroys the peer on ICE `failed`/`closed`; `_onConnectionStateChange`
destroys it on `connectionState === 'failed'`. The transport then assigns
its own logging functions to `peer._pc.oniceconnectionstatechange` and
`peer._pc.onconnectionstatechange` — unconditionally, not only with
`debug: true`. Assignment replaces. What is left is the gathering handler,
which calls `_onIceStateChange` only when the *gathering* state changes.

Measured (`repro-simple-peer-sleep`, parts 1 and 2):

```
Part 1 - does 'connect' fire?
  ice-first        bare simple-peer: connect=true   transport: onPeerConnect=true connectedPeers=1
  gathering-first  bare simple-peer: connect=true   transport: onPeerConnect=false connectedPeers=0
Part 2 - the remote side goes silent: ICE failed, connection failed
  bare simple-peer: close=true error=ERR_ICE_CONNECTION_FAILURE
  transport:        onPeerDisconnect=false connectedPeers=1 (a dead peer, still counted and sent to)
  the phone re-announces under its id: new peer connections created = 0
```

- **S4**: when candidate gathering completes before ICE connects (one fast
  STUN server, one interface — the usual phone), `'connect'` never fires on
  that side. The `onChannelOpen('data')` workaround in the transport ("data
  before connect on some browsers") is a symptom of this: the link only
  comes up if the *other* side got its `'connect'` and sends first. If both
  sides gather first, the link stays silent forever, entry in `peers`
  included.
- **S1**: when the phone sleeps, the desktop's ICE goes `failed`, nothing
  happens: no `close`, no `removePeer`, no `onPeerDisconnect`. The dead peer
  keeps its awareness state for the 300 s lease and every `send()` still
  writes into its channel. The data channel does not close by itself on an
  ICE failure, so there is no second path.
- **S2**: `peerId` is generated once in the constructor, so the returning
  phone announces under the id the desktop holds a dead entry for:
  `!this.peers.has(msg.from)` is false, `announcedPeers` has it too — the
  announce is ignored. Same on the phone for every desktop. **Both sides
  lock each other out until a page reload.**

### S3 — the signaling socket is one-shot (lines 533-616)

`ws.onclose` removes the socket from `signalingConns`, nothing reconnects
it. The 5 s re-announce timer then skips (`signalingConns.length > 0`).
A phone whose socket the OS closed can neither announce nor receive offers.
Measured (part 3): `reconnect attempts = 0, announces sent = 0,
transport.isConnected = true`. There is also no ping: a half-open socket
(NAT rebinding, WiFi → LTE) is not even noticed.

y-webrtc's `SignalingConn` extends lib0's `WebsocketClient`: reconnect after
`min(log10(n+1) * 1200, 2500)` ms, an application ping every 15 s, a forced
close after 30 s without any message, and on every (re)connect it
re-subscribes and re-announces all rooms.

### Further, by reading

- **Half-open entries never expire.** A peer object enters `peers` before
  it is connected and leaves only on `close`/`error`. An initiator whose
  offer is never answered (the other side's signaling socket was down, or
  it fed the offer to a dead peer object, see next point) stays there
  forever and blocks that id. y-webrtc has the same hole.
- **A fresh offer is fed to the stale peer object.** `handlePeerSignal`
  passes an `offer` from a peer we hold a *connected* entry for to the old
  simple-peer instance; the old RTCPeerConnection rejects it (new DTLS
  fingerprint), the peer errors out, and the offer is lost while the remote
  initiator waits for an answer that never comes. The transport never
  renegotiates, so an offer on a connected entry can only mean "the remote
  restarted": the old entry should be dropped and the offer answered fresh.
- Default signaling server is `wss://signaling.yjs.dev`: a WebSocket to it
  errors out after 155 ms (checked 2026-09-19); y-webrtc's current default
  `wss://y-webrtc-eu.fly.dev` opens. With the default, the transport is
  BroadcastChannel-only and says so only in a console warning.
- Re-discovery after a close waits for the next 5 s announce tick;
  y-webrtc calls `announceSignalingInfo(room)` from the peer's `close` and
  `error` handlers, so the mesh heals within one signaling round trip.

## PeerJS transport (`src/providers/peerjs/index.ts`)

The design — one peer holds the well-known id `yjs-coordinator-<room>` and
introduces everybody — makes one browser a single point of failure, and the
phone that opened the room first is that browser.

### P1 — left-over error handlers destroy the coordinator (lines 208-226, 940-945)

`connect()` attaches `coordinatorAttempt.on('error', …)` to decide between
"id taken" and "claimed"; `transitionToCoordinator()` does the same. Neither
handler is removed after `'open'`. PeerJS reports non-fatal conditions as
`'error'` on the same Peer object for its whole life (peerjs 1.5.5):
`peer-unavailable` for every `connect()` to a peer that is gone (the
server's `EXPIRE`), `network` "Lost connection to server." when the
signaling socket drops — the Peer survives both. The left-over handler
answers with `destroy()`:

```
Part 1 - coordinator, PeerJS emits the non-fatal 'peer-unavailable'
    coordinator Peer destroyed:   true
    Peers constructed afterwards: yjs-r-yreut9
    transport.isConnected:        true
Part 2 - coordinator, the signaling socket drops: 'network' error, then 'disconnected'
    coordinator Peer destroyed:   true
    Peers constructed afterwards: yjs-r-fia1ql
    transport.isConnected:        true
Part 3 - coordinator by re-election, then 'peer-unavailable'
    coordinator Peer destroyed:   true
    Peers constructed afterwards: none
    transport.isConnected:        true
```

Parts 1/2: the coordinator closes every data connection, comes back as a
regular peer and tries to reach a coordinator that no longer exists (it was
the coordinator); `isCoordinator` stays `true`, `roomPeers` stale, and no
path ever retries the coordinator connection — isolated until reload, while
everybody else runs a re-election. Part 3: a zombie — Peer destroyed,
nothing rebuilt, `isConnected` `true`. Commit 209a103 made part 3 likelier:
the election winner now `connectToPeer()`s every known peer, and each one
that is gone yields a `peer-unavailable`.

On a phone, part 2 is the normal case: every app switch that costs the
signaling socket kills a coordinator phone's room.

### By reading (not measured)

- **P2 — nobody retries a lost pair.** `connectToPeer` lets only the lower
  id initiate, and is only called from a coordinator message, a
  BroadcastChannel announce, or the local signaling reconnect. After a
  `close` both sides `removePeer()` and wait. If the pair's link fails while
  both keep their coordinator link (NAT rebinding, one bad path), the pair
  stays apart; documents still converge through third peers' beacons,
  awareness between the two does not.
- **P3 — a sleeping coordinator takes the mesh down.** ~30 s after the
  coordinator phone sleeps, every peer's coordinator link fails and the
  election starts. The PeerJS server holds the id of a socket that was not
  closed cleanly for its `alive_timeout` (60 s), so the winner's claim is
  refused (`unavailable-id`), it falls back to a regular peer with a new id,
  and after 5 attempts (~38 s) *every* peer falls back to
  `transitionToCoordinator()`, which begins with `this.peer.destroy()` —
  healthy mesh links included. One phone asleep = the whole room rebuilt
  under new ids, about a minute of outage.
- **P4 — a returning peer is refused while its dead entry exists.**
  `handleIncomingConnection`: `if (this.peers.has(remotePeerId)) conn.close()`.
  PeerJS keeps the id across `reconnect()`, so a phone back within the
  ~30 s ICE timeout is turned away, retries for ~38 s, then rebuilds itself
  under a new id.
- **P5 — half-open entries never expire.** `setupConnection` registers the
  entry before `'open'`. `peer-unavailable` arrives on the Peer, not on the
  connection, so the entry stays, blocks `connectToPeer` for that id and,
  through P4, refuses that peer's own attempts.
- **P6 — signaling reconnect without backoff.** `_handlePeerServerDisconnect`
  calls `peer.reconnect()` at once on every `'disconnected'`, stacks another
  `once('open')` each time, and returns silently when the Peer is already
  destroyed (then nothing ever reconnects and `isConnected` stays `true`).
- A split-brain ex-coordinator (`isCoordinator` still `true`, see P1) sends
  `peer-left` for every link *it* loses; receivers do not check the sender
  and close their own healthy link to that peer.
- `setupPeerDiscovery()` runs again after every election / re-establish
  without closing the previous BroadcastChannel and interval;
  `becomeCoordinator()` is dead code with its own leaking interval.
- The ~30 s blind window after resume applies here too: the phone's links
  read `connected`, `_handlePeerServerDisconnect` therefore re-dials nobody,
  and recovery starts only when the phone's own ICE gives up.

## Trystero transport (`src/providers/trystero/index.ts`)

A thin wrapper; peer lifecycle, relay reconnection (it listens to
`online`/`offline`) and periodic re-announce are Trystero's. Nothing in the
wrapper breaks a link. Two notes: the playground bundles its own
`trystero-*.min.js` (April 2026), and the npm package `trystero` 0.25.4 is
now a stub re-exporting `@trystero-p2p/*` — whatever Trystero fixes for
mobile arrives only with a re-bundle; and it has no `visibilitychange`
handling either, so the ~30 s blind window after resume applies. Of the
three, this is the transport to recommend for phones today.

## Core (`src/index.ts`)

The document side is in good shape: a re-opened channel gets one unicast
digest beacon per side (`_schedulePeerConnectSync`), and an edit made while
the link was down arrives **102 ms** after the re-open. Two findings on the
presence side:

### C1 — presence does not come back with the link

`_handlePeerLeave` removes the peer's awareness state; y-protocols keeps
its clock in `awareness.meta`. When the link re-opens, the peer's state is
unchanged, so anything it sends carries the clock the receiver still holds,
and `applyAwarenessUpdate` ignores an equal clock unless it is a removal.
The re-open beacon carries no `DIGEST_FLAG_JOIN`, and a JOIN's presence
response would be ignored for the same reason. Presence returns with the
peer's next clock bump: a state change (a cursor move — but a classroom
roster of `{name, color}` never changes), or the renewal at lease/2 — which
`_touchPeer(this.doc.clientID)` in `_encodeSyncStep1`/`_encodeAck` pushes
back with every beacon the peer sends.

`bench-presence-after-relink` (link down 2 s, both providers stay connected):

| Lease | Phone | Edit arrives | Desktop sees phone again | Phone sees desktop again |
|---|---|---|---|---|
| 20 s | typed while down | 102 ms | 29.3 s | 13.4 s |
| 20 s | idle | - | 12.0 s | 20.5 s |
| 40 s | typed while down | 102 ms | 38.2 s | 21.9 s |
| 40 s | idle | - | 24.4 s | 33.3 s |

0.5-1.5 leases, scaling with the lease. The mesh transports default to a
300 s lease (round 5, item 2: departures are reported, renewals are rare);
extrapolated - not measured at 300 s - that puts a returning phone at
**roughly 3 to 7 minutes** missing from everybody's roster, and everybody
missing from the phone's, with the document in sync the whole time. This is
the part of "re-entering the room does not work" that remains after every
transport fix.

### C2 — the wall-clock jump (by reading)

The first sweep tick after a sleep longer than the lease sees every remote
`lastUpdated` as expired and removes them all (`'timeout'`), then queues a
removal broadcast. If a channel is already back, the receivers drop those
states too; live peers notice their own removal and re-announce
(the carve-out in `_setupAwarenessSync`), so it heals, with a burst. The
phone itself then sits in C1. A tick that finds `now - lastTick` far beyond
its own period has slept; that is a transport-independent resume signal the
core already has for free, and the natural trigger for a fix.

## What y-webrtc does differently

| | y-webrtc 10.3.0 | SimplePeerTransport |
|---|---|---|
| ICE / connection failure | simple-peer's handlers intact: `failed` → `close` | handlers overwritten: never (S1) |
| `'connect'` | simple-peer's | order-dependent (S4) |
| Signaling socket | lib0 `WebsocketClient`: auto-reconnect ≤ 2.5 s, ping 15 s, forced close at 30 s silence; re-subscribe + re-announce on connect | one-shot, no ping (S3) |
| After a peer closes / errors | `announceSignalingInfo(room)` at once | next 5 s tick, if a socket is left |
| Who initiates | whoever receives an `announce`; glare resolved by a timestamp token | the higher id |
| Returning peer, same id | blocked until ICE fails (~30 s), then heals | blocked forever (S2) |
| Half-open entry | never expires | never expires |
| Page lifecycle, heartbeat, ICE restart | none | none |
| Presence after re-link | `'connect'` sends the full awareness table; equal clocks ignored all the same, but y-protocols renews every 15 s | renewal at lease/2 = 150 s, deferred by beacons (C1) |
| Default signaling | `wss://y-webrtc-eu.fly.dev` (opens) | `wss://signaling.yjs.dev` (connection error) |

## Items (as proposed; all implemented - results in the Status table)

Ordered by damage per line of change. 1-3 and 5 are bug fixes with no wire
or API change; 4 and 6 change behaviour and want a decision.

1. **simple-peer: stop overwriting the handlers** — log via simple-peer's
   own `iceStateChange` event (or `addEventListener`). Fixes S1, S4, and S2
   down to y-webrtc's ~30 s. Gate: `repro-simple-peer-sleep` parts 1-2.
2. **simple-peer: reconnecting signaling socket** with the WebSocket
   transport's backoff + jitter (round 7, item 4), ping, re-subscribe and
   re-announce on open; announce at once from `removePeer`. Gate: part 3.
3. **peerjs: detach the claim's error handler on `'open'`**, one permanent
   handler that only logs non-fatal types. Gate: `repro-peerjs-coordinator`.
4. **core: presence after re-link (C1).** Cheapest: `_handlePeerLeave`
   also deletes the peer's `awareness.meta` entry, so its unchanged state is
   accepted again, and the re-open beacon asks for presence
   (`DIGEST_FLAG_JOIN`, unicast — one delivery). Risk to check: a late
   message from the old link reviving a peer that really left. Gate:
   `bench-presence-after-relink` → presence within the beacon round trip.
5. **Both mesh transports: expire half-open entries** (no `'connect'` within
   ~30 s → `removePeer`), and treat an `offer` / incoming connection from a
   peer with an existing entry as "the remote restarted": drop the old
   entry, accept the new one (S2, P4, P5).
6. **Resume handling.** On `visibilitychange → visible`, `online`, or a
   timer tick that slept (C2): check the links instead of waiting ~30 s for
   ICE — signaling socket dead or any link not `connected` → drop the peers,
   re-announce under a **new peer id** (no dead entry anywhere matches it),
   let `onPeerConnect` beacons do the rest. Removes the blind window, the
   one thing y-webrtc does not have either.
7. **peerjs coordinator design (P2, P3).** Items 3 and 5 stop the
   self-destruction; the single point of failure stays. Options: keep and
   document "not for rooms opened from a phone", or replace discovery
   (`listAllPeers` where the server allows it, or a signaling room like
   simple-peer's). Decision for André.

Not proposed: a data-channel heartbeat (ICE consent freshness already
detects silence in ~30 s; item 6 covers the resume case for less), ICE
restart (both libraries would need renegotiation plumbing the transports do
not have; a fresh connection costs one digest beacon since round 5).
