# A partial WebRTC mesh with relaying, like y-webrtc — is it possible here? (research)

## Status

Research, 2026-09-20, on branch `round-8` @ ed9ef27. The partial-mesh question
itself changed nothing in `src/`: `test/dummy/probe-partial-mesh.ts` (+ its line
in `tsconfig.bench.json`) produced its numbers. The follow-up — "then test the
full mesh with 50" — found a presence bug of the core that has nothing to do with
room size; that one **is fixed** (`src/index.ts`, `dist/` rebuilt, gate
`test/dummy/bench-renewal-under-churn.ts`), see "The full mesh with 50 browsers".
`test/e2e/room-scenarios.mjs` gained the opt-in scenarios `bandwidth` and `linger`
and a roster diagnosis. Commits: b0b681a (harness), d94be58 (core), then this document;
later the same day de11ced / 5a30380 (diagnosis), dc17849 (simple-peer) and 6dbfe5a
(trystero, the `oneway` scenario) for the link that delivers one way. **Version 1.8.1** -
three fixes, no new API, no wire-format change: v1.5.0 to v1.8.1 share a room.
**Version 1.8.2** the same evening: what Firefox and a real phone found (the
sections "Firefox in the room" and "A real phone in the room") - again no new
API (`resumeAfterMs` was and is an option, its default went from 15 s to 30 s)
and no wire-format change.
**Version 1.8.3**, later that night: what the same two tests found on a relay
transport ("Firefox and the relay transports: Nostr") - two fixes in the core,
one in the Nostr transport, no new API, no wire-format change.
**Version 1.8.4**, the next morning: the same test on WebSocket ("Firefox and the
relay transports: WebSocket") - one more fix in the core, again no new API and no
wire-format change.
**Version 1.8.5**, the same day: what the real phone found on WebSocket ("The real
phone on WebSocket") - the presence renewal that starved while somebody typed
(core), and the reconnect backoff that was sat out although the network was back
(the WebSocket transport, and a third sign for simple-peer, PeerJS and Nostr). No
new API, no wire-format change.
**Version 1.8.6**, the same afternoon: the one number the third pass had left open,
a reloaded Gun page a ghost for a lease ("Firefox and the relay transports: Gun") -
three findings in the Gun transport, measured one after the other, and one new
optional hook, `Transport.flush()`, that the provider calls when the page unloads.
No wire-format change.
**Version 1.8.7**, the same evening: the real phone on Gun ("The real phone on Gun")
found nothing wrong and one gap - Gun was the one relay transport that sat out its
reconnect backoff when the page's network came back. No new API, no wire-format
change.
**Version 1.8.8**, the same evening: the two Gun findings left open above, one
cause - the update listener's initial load - and one fix; a joiner in a room whose
peers are all gone has the document again. No new API, no wire-format change.

André's question: the WebRTC transports here need a full mesh, y-webrtc holds at
most 20-30 connections per peer and passes messages on, which scales better in
large groups — could y-generic do the same?

**Short answer: yes, but not the way y-webrtc does it, and not in the core.**
A relay layer *under* the core (a `Transport` wrapper around peerjs / simple-peer
/ trystero) ran a 100-peer room at 14-34 links per peer with the core untouched:
every document, cursor, pub/sub message and roster complete, at the frame count
of today's full mesh. y-webrtc's own mechanism, copied literally, costs 24-28x
the traffic — also in rooms that would have fitted into a full mesh.

## What y-webrtc really does (10.3.0, read in `node_modules/y-webrtc/src/y-webrtc.js`)

- `maxConns = 20 + floor(rand * 15)` (l. 604). The cap is checked only by the side
  that **initiates**: on an `announce` (l. 517) and before announcing itself
  (l. 274). An incoming offer is always accepted (l. 541-544) — a joiner can end
  up above its cap.
- `_docUpdateHandler = (update, _origin)` and `_awarenessUpdateHandler` (l. 347,
  359) **ignore the origin**: whatever changed a peer's document or awareness is
  sent to all of its links again. That is the whole relay. It ends because a
  duplicate changes nothing and fires no event.
- **No timer in the file** — no periodic SyncStep1, no resync. (Round 4, item 8
  said "every peer runs periodic SyncStep1"; that was wrong. Round 8's F1 had it
  right.)
- Its README is candid: *"The clients will still sync if every client is connected
  at least indirectly to every other client. Theoretically, y-webrtc allows an
  unlimited number of users, but at some point it can't be guaranteed anymore that
  the clients sync any longer"*; the default *"was used to connect at least 100
  clients at a conference meeting"*. dmonad in [#22][yw22]: *"relies on
  more-than-once delivery"*. No analysis, one anecdote; no public report of a
  partition either ([#3][yw3], "does not sync with clients that are indirectly
  connected", is open since 2020 without a comment).

What its join rule builds (`TOPOLOGY=1`, 200 seeds per N, sequential joins, no
churn) — always connected, but joiners only reach whoever still has free slots,
i.e. the peers that joined just before them, so the room becomes a **chain**:

| N | links (full mesh) | links/peer | diameter, y-webrtc rule | diameter, 10 random links per joiner |
|---|---|---|---|---|
| 25 | 286 (300) | 13-24 | 2 | 2 |
| 50 | 614 (1,225) | 10-34 | 4 | 3 |
| 100 | 1,294 (4,950) | 8-34 | **7** | 3 |
| 200 | 2,645 (19,900) | 10-34 | **13** | 4 |
| 400 | 5,344 (79,800) | 9-34 | **26** | 4 |

## Why the core cannot simply do the same

`GenericProvider` deliberately does **not** re-send what it received
(`_setupDocumentSync`: `origin !== this`; `_setupAwarenessSync`'s comment: a
single awareness change cost N·(N-1) deliveries before that check, N=20: 380 → 19).
And everything that made the protocol cheap since round 3 assumes that **a
broadcast reaches every peer of the room**:

- SyncStep2 reply suppression and removal suppression ("drop mine if I overhear
  someone else's") — the requester may not be linked to the peer I overheard;
- responder self-selection (`_selectedResponder`: the three lowest-ranked of the
  *known* peers answer) — the three may have no link to the requester, everybody
  else stays silent;
- presence on demand ("a relayed table that carries my state has answered the
  joiner");
- per-sender sequence numbers, the doc-hash check, Trickle.

Re-broadcasting in the core would reopen each of those. A relay *below* the core
restores the assumption instead, and all of it keeps working.

## Measured: `test/dummy/probe-partial-mesh.ts`

100 `GenericProvider`s (defaults, `disableBc`) on simulated data channels: FIFO
and reliable per link, 20 ms ±25 % per hop, every frame on every link counted.
Topology = y-webrtc's join rule, seed 1. Peer 0 (the oldest, farthest from the
last joiners) types 30 characters, moves its cursor 30 times, publishes once; then
peer 50's tab is killed.

- **full** — everyone linked to everyone, no relay: today.
- **partial** — y-webrtc's topology, no relay: today with `maxConns` too small.
- **flood** — relay wrapper; a frame seen for the first time goes to every link but
  the one it came on. y-webrtc's cost model, moved under the core.
- **tree** — relay wrapper; a peer forwards only to its children in the
  shortest-path tree of the frame's origin. The tree comes from the simulator
  (an **oracle**): the lower bound for a link-state or Plumtree design, control
  traffic not counted.

The wrapper (≈120 lines in the probe): envelope `origin, seq, dest, payload`;
per-origin duplicate filter; the core gets the **origin** as `from`; `sendTo()`
to a peer without a link follows the link that peer's frames arrive on (a
learning bridge), else floods.

| N=100 | full | partial | flood | tree (oracle) |
|---|---|---|---|---|
| links per peer / longest path | 99 / 1 | 14-34 / 6 | 14-34 / 6 | 14-34 / 6 |
| join: frames / KB | 33,704 / 1,151 | 9,883 / 322 | **477,614 / 15,561** | 35,710 / 1,389 |
| complete rosters | 100/100 | **0/100** (smallest: 15) | 100/100 | 100/100 |
| per keystroke: frames / bytes | 139 / 4,385 | 59 / 1,531 | **3,809 / 143,657** | 143 / 5,471 |
| keystrokes that arrived within 1 s | 100 % | **31.5 %** | 100 % | 100 % |
| keystroke latency p50 / p95 / max | 21 / 34 / 48 ms | 21 / 409 / 994 ms | 51 / 100 / 112 ms | 59 / 112 / 138 ms |
| documents equal 10 s later | 100/100 | **61/100** | 100/100 | 100/100 |
| per cursor move: frames | 99 | 29 | **2,566** | 99 |
| peers that see the cursor / heard pub/sub | 99 / 99 | **29 / 29** | 99 / 99 | 99 / 99 |
| killed peer gone from all rosters | 51 ms | — | 153 ms, or 4-8 ghosts | 102-253 ms, or 7-8 ghosts |

(Frames per keystroke include the window's beacons and acks. The kill row is the
range over ten relay runs - seeds 1-3, both join rules - see finding 3.)

A room that **fits under the cap** (N=25, full mesh) — what a relay costs when
nothing needs relaying:

| N=25 | no relay | flood | tree |
|---|---|---|---|
| per keystroke: frames / bytes | 26 / 895 | **614 / 25,171** | 27 / 1,094 |
| join: frames | 2,325 | 29,541 | 2,339 |

With 10 random links per joiner instead of y-webrtc's rule (`RULE=random`, N=100,
945 links, longest path 3): flood 2,627 frames per keystroke, 36 / 48 / 63 ms;
tree 139 frames, 38 / 47 / 57 ms — but see finding 4.

## Findings

1. **Today's core on a partial mesh does not work** (confirms round 8's F1 with
   numbers): nobody has a complete roster, two thirds of the keystrokes miss the
   second, cursors and pub/sub reach direct neighbours only, and the periodic
   beacons had healed the document for 61-82 of 100 peers after 10 s.
   `maxConns` must stay "everybody fits".
2. **Flooding is the wrong trade.** 27x the frames and 33x the bytes per keystroke
   at N=100 — and 24x in a 25-peer room where every frame had already arrived
   directly. That is what y-webrtc pays in *every* room (N·(N-1) sends per update
   in a full mesh). It buys fewer connections per browser, not less traffic.
3. **Three things the relay has to do that y-webrtc does not** — each found as a
   failure first:
   - *The JOIN beacon goes nowhere.* The core sends it when `connect()` resolves;
     on a mesh no channel is open yet (the comment in `_schedulePeerConnectSync`
     says so). A full mesh does not care: every channel that opens brings that
     peer's presence. Behind a relay most of the room never opens a channel to the
     joiner: **21 of 100 rosters complete, smallest 15**. With the wrapper's
     `connect()` resolving at the first open link: 100/100, join cost like the
     full mesh's (`JOIN_AT_FIRST_LINK=0` reproduces the failure).
   - *Departures must come from the relay.* A killed peer stayed in **35-76 of 99
     rosters**. Two reasons, both in the `MESSAGE_AWARENESS` case: the core vetoes
     a third party's removal of any peer it has an **address** for (an address
     means a live link on a full mesh — behind a relay it has one for everybody);
     and a removal carries the *remover's* clock for that peer, which is behind
     the receiver's whenever a later link-open bumped it
     (`_schedulePeerConnectSync` bumps per link, unicast). Limiting the veto to
     direct links (tried as a temporary patch, reverted) only got it down to 41.
     With the relay reporting "no path to that peer any more" as
     `onPeerDisconnect` — what a full mesh does — the core needs no change
     (`MEMBERSHIP=0` reproduces).
   - *…and the core must know whose address that is.* It learns `clientID →
     address` from sync frames only. A peer that joined after X got X's presence
     as a unicast awareness frame and, with Trickle keeping settled peers quiet,
     never heard a beacon of X: in 7 of 8 runs **7-10 of 99 peers had no address
     for the victim** and could not act on the relay's report; whether they kept a
     ghost was then a clock race against the neighbours' removal broadcast (ghosts
     in 6 of 10 runs, none in the run where all 99 knew the address). Cannot happen
     on a full mesh (a link's first frame is a beacon). **The one core change this needs** — e.g. learn the address
     from a unicast awareness frame with a single non-null entry, or let the
     presence response ride with a beacon as the link-open frame already does.
4. **A tree needs a repair path.** With the random join rule the oracle tree left
   **16 of 100 rosters one or two entries short**: for one hop's time the tree and
   the links that are really open disagree, the frame is dropped, and presence —
   unlike the document — has no anti-entropy. Any real link-state view is *less*
   consistent than this oracle. This is exactly what Plumtree's lazy links are for
   (announce ids on the non-tree links, fetch what is missing).
5. **Do not copy y-webrtc's join rule.** It builds a chain (7 hops at N=100, 26
   at N=400); 10 random links per joiner give 3-4 hops with fewer links, and
   halve the latency (p95 112 → 47 ms).

## Options

| | what | cost | verdict |
|---|---|---|---|
| A | y-webrtc's way: re-broadcast in the core | reopens reply/removal suppression, responder selection, presence on demand; 24-28x traffic in every mesh room | **no** |
| B | relay wrapper, flooding | ≈150 lines + findings 3; 27x frames beyond the cap, and 24x below it unless it stays off while the mesh is full | only as the bootstrap/repair channel of C |
| C | relay wrapper, Plumtree (eager tree links + lazy `IHAVE` links, `GRAFT`/`PRUNE`) on a HyParView-style random partial view | ≈400-500 lines, timers per link, a wire-format change (envelope) → opt-in, all peers of a room on the same version | **the one to build, if it is built** |
| D | nothing: full mesh up to `maxConns` 64, a relay transport (websocket) beyond | 0 | **default recommendation** |

Known parameters for C, from the literature: Plumtree's relative message
redundancy is ~0 against fanout-1 for eager gossip and recovers in a couple of
cycles after failures ([Leitão 2007][plumtree]); HyParView's active view is
log(n)+1 — 5 for 10,000 nodes ([HyParView][hyparview]); GossipSub uses D=6
(4-12). No maintained JS implementation of either for WebRTC data channels was
found; Trystero, PeerJS and webrtc-swarm are full meshes without relaying, and
Trystero's README advises splitting users into groups.

## When it would pay off

- **Up to ~35 peers: never.** A full mesh is optimal — one hop, N-1 frames.
- **35-64:** today's `maxConns` default (64) keeps the mesh full. Verified with
  real browsers at 25 only. Chrome's hard limit is 500 `RTCPeerConnection`s per
  renderer ([source][chrome500]; closed ones keep counting, [bug][chromegc]), the
  practical limit is CPU — Feross 2018: more than a dozen connections *at once*
  pins the process ([webrtc-pc#230][feross]) — and keep-alive: libwebrtc pings a
  stable pair every 2.5 s, so 99 links are ~40 STUN requests/s against ~14 at 34
  links (arithmetic from [p2p_constants.h][stun], not measured).
- **Beyond 64, or phones in a 25-peer room:** the only case for C. A phone that
  holds 6 links instead of 24 is the more likely first user than a 100-peer room.

## Bandwidth per user — measured in real browsers

`test/e2e/room-scenarios.mjs simple-peer` with the new opt-in scenario
`bandwidth` (`SCENARIOS=join,bandwidth`): every `RTCPeerConnection` of every page
is read through `getStats()` before and after 20 s idle and 20 s of five peers
typing. *Payload* is what the data channels carried; *wire* adds what the ICE
transport moved (SCTP + DTLS), 28 bytes IP/UDP per packet and the STUN keep-alive
(128 / 92 bytes per request / response) — an estimate for an IPv4 network
without TURN, not a capture. Full mesh, local signaling, headless Chrome 151.

| kB/s per peer (up / down) | N=25, 24 links | N=50, 49 links |
|---|---|---|
| idle — wire | 2.0 / 2.0 | 4.2 / 4.2 |
| … of which STUN keep-alive | 2.0 | 3.8 |
| typist — payload | 5.7 / 1.2 | 9.6 / 1.5 |
| typist — wire | **18.2** / 11.5 | **32.9** / 24.3 |
| listener (5 typists) — payload | 0.3 / 1.4 | 0.8 / 1.7 |
| listener — wire | 4.7 / 6.4 | 8.6 / 9.6 |
| typed, characters per second and typist | 4.8 | 3.8 |

PeerJS (same scenario, its own server locally) is the same within the run-to-run
noise — it is the same WebRTC underneath: idle 2.1 / 2.1 and 4.0 / 4.1, a typist
18.3 / 11.3 and 35.7 / 25.5 (3.4 characters/s), a listener 4.3 / 6.1 and 9.6 / 10.7.

Trystero (nostr strategy, relay in the harness) at 25 and **40** peers: idle 2.1 /
2.1 and 3.4 / 3.4, a typist 20.0 / 11.9 and 31.3 / 17.8 (4.5 characters/s), a
listener 4.6 / 6.7 and 7.0 / 8.9. Its messages are larger - ~59 bytes of payload
against ~46: Trystero's own header on every frame.

So: **tens of kilobytes per second, not megabytes** — a typist in a 50-peer room
uploads ~33 kB/s (0.26 Mbit/s), a listener moves < 10 kB/s each way.

What the numbers are made of (both sizes agree within ~10 %):

- **Keep-alive: ~80 bytes/s per link and direction**, whether anybody types or
  not — libwebrtc's STUN check every 2.5 s. Idle cost is *only* this, the
  protocol sends nothing (0 messages/s). It is what a phone pays for the mesh:
  14 MB per hour at 25 peers, 30 MB at 50, ~57 MB at 100 — and ~5 MB with 8 links.
- **A keystroke is ~1.1 messages per link** (update and cursor travel in one
  frame) of **~46 bytes payload, ~135 bytes on the wire**, plus ~50 bytes of SCTP
  acknowledgement coming back. Overhead, not content, is the cost: 3x.
- Per peer, with L = N-1 links, T typists at r characters/s:
  idle ≈ 80·L; typist up ≈ 80·L + L·r·1.1·135; listener down ≈ 80·L + T·r·1.1·135
  (bytes/s).

| full mesh, r = 5/s, T = 5 | idle | typist up | listener down |
|---|---|---|---|
| N=25 | 1.9 kB/s | 20 kB/s | 5.6 kB/s |
| N=50 | 3.9 kB/s | 40 kB/s | 7.6 kB/s |
| N=100 (extrapolated) | 7.9 kB/s | **80 kB/s** (0.65 Mbit/s) | 11.5 kB/s |

What a relay would change at N=100 (frame counts of the probe × the measured
bytes; not measured in browsers): with a **tree** and ~27 links, idle drops to
~2.1 kB/s and a typist's upload to ~22 kB/s, the other ~52 kB/s being spread over
the forwarding peers (the room's total stays the same). With **flooding** every
peer — every phone — uploads 26 links × 27.5 messages/s × 135 bytes ≈ **94 kB/s
for as long as five people type**, against 8.6 kB/s for a listener in today's
full mesh at N=50.

## The full mesh with 50 browsers

`N=50 DIAG=1 node test/e2e/room-scenarios.mjs simple-peer`, all scenarios (12 GB
free RAM, 12 cores; 43 s until all pages were loaded).

- **The mesh and the document hold**: 49 links on every peer after every
  scenario; a text in all 50 editors after 98-620 ms; five concurrent typists
  identical everywhere after 1.2 s; text typed during a 5 s signaling outage
  everywhere 14 ms after it; five frozen pages have the missed text 0.4 s after
  the unfreeze; a reloaded peer's roster is complete everywhere after 2.3 s.
- **Presence did not — a core bug, not a matter of size.** Eight minutes into the
  run 43 of 49 rosters were incomplete and most peers were listed in exactly two
  rosters, their own and the newest peer's. The run simply outlived a presence
  lease (300 s on transports that report departures); the 25-peer runs of round
  8 ended before one did. A peer renews to the room when its own state is half a
  lease old, and two things reset that age although nothing had gone to the
  room: the clock bump a new link gets (`awareness.setLocalState()` stamps
  `lastUpdated`), and `_encodeSyncStep1` / `_encodeAck` / `_encodeUpdate`
  refreshing our own lease at *encode* time — also for the unicast beacon to a
  new link, the unicast ack to a joiner, and replies that were then suppressed.
  With a join, a reload or a resume more often than every half lease a settled
  peer never renewed, and everybody but the newcomers expired it.
  Gate: `test/dummy/bench-renewal-under-churn.ts` — 6 settled peers, a visitor
  every 1.2 s, lease 4 s: a roster **down to 1 of 6 after 5.1 s** → all 6 for
  three leases. Fix in `src/index.ts`: the bump keeps `lastUpdated`, and the own
  lease is refreshed in `_send()` — for what really goes to the room — instead of
  in the encoders (either change alone stays red).
  In real browsers, new opt-in scenario `linger` (420 s, one peer reloads every
  60 s, rosters checked 55 s after each reload): **unfixed @ ed9ef27, 25 peers**
  — from 334 s on 20 of 25 rosters incomplete, the smallest showing 6, most peers
  listed in 6 rosters, 24 links everywhere, editors identical; **fixed, 50 peers**
  — no incomplete roster at any check, 50 of 50 at the end. With the fix the
  standard scenarios pass at 50 as well (killed tab gone after 18 s, rosters
  complete 9 s after five frozen pages resume, 2.4 s after a new peer joins).
  Regression gates unchanged: `bench-presence-after-relink` 75 ms both ways,
  `bench-last-joiner-roster` 0 of 12, `bench-wake-false-timeout`,
  `bench-resume-roster`, `bench-idle-room`, `bench-periodic-awareness`,
  `bench-mesh-join-burst`, `bench-reload-phantoms` all pass.
- **PeerJS with 50 browsers** (on the fixed core, `peer` 1.x server locally): all
  scenarios pass - 49 links on every peer, rosters complete 10.2 s after the join
  (simple-peer: 0.1 s; the single coordinator hands out the room), text everywhere
  after 628 ms, five concurrent typists identical everywhere after 8.3 s
  (simple-peer 1.2-3.1 s), killed tab gone after 20.5 s, rosters complete 5.1 s
  after five frozen pages resume (up to 51 links on a peer for a while: the
  sleepers' old ids until `iceDisconnectTimeout`), 2.0 s after a reload, 2.2 s
  after a join that follows a 5 s server restart; **coordinator killed**: gone
  from every roster after 23.7 s, a new peer has the text after 1.9 s, every
  roster complete 26.2 s after the kill. `linger` (420 s, a reload every 60 s):
  no incomplete roster, 50 of 50 at the end.
- **Trystero does not reach 50 on this machine - it holds to 45** (fixed core,
  nostr strategy, the harness' own NIP-01 relay; 12 cores):
  - **50 peers, twice**: the join never completes. After 190 s: 1 of 50 rosters
    complete, links per peer 4-49 (median 45), the text of one peer in 48 of 50
    editors; the first time one peer had 0 links and never got the text. It is
    the LAST joiners that stay outside. 1-minute load 12-13.7 on 12 cores, against
    ~6 for simple-peer with 50 - the machine is saturated, so this says "Trystero
    costs far more per peer", not yet "a classroom of 50 real machines fails".
  - **45**: complete, but slowly - every roster after 66.6 s (10 s in, the last
    two joiners were in nobody's roster), 44 links, text after 551 ms, load 8.
  - **40**: rosters complete 38-886 ms after the join (four runs), 39 links. All
    scenarios pass: five typists identical after 3.8 s, killed tab gone after
    7.5 s, five frozen pages have the text after 128 ms, a reload complete after
    8.0 s, text typed during a 5 s relay outage everywhere 16 ms after it; a peer
    that joins after the restart has the text after 15 s and is in every roster
    only after **88.5 s**. `linger` (420 s): no incomplete roster, 40 of 40.
  - Why it is heavier, from the bundled Trystero: a **pool of 20 pre-made offers**
    per peer - 20 `RTCPeerConnection`s on top of the links, recycled every 57 s -
    and an announce every 5.3 s that every other peer answers to. 50 contexts are
    ~3,500 peer connections on one machine.
  - Test-bed lesson: two runs failed as a whole while the machine's WiFi was down
    - zero links on every peer (without a network interface Chrome gathers no
    host candidates; loopback does not count), and nobody joined at all (Trystero
    follows the browser's `online`/`offline` events and opens no relay socket
    while offline). Repeated with the network back: fine.
- **Found and fixed for simple-peer: a link that delivers one way** (the whole
  story: `2026-09-20-join-presence-miss-note.md`). On the answering side of a
  link Chrome's `RTCDataChannel` object can stay at `readyState: 'connecting'`
  after its own `open` event - for minutes - while `getStats()` calls it open and
  messages arrive; every `send()` throws. The transport logged that and kept the
  entry, so the peer's first frame - its presence - never went out, and the other
  side never learned it. `SimplePeerTransport` now drops such an entry: the link
  is reported gone, announced and dialled again
  (`repro-simple-peer-sleep`, part 7: reported gone false -> true). Real browsers,
  25-50 peers: before, 6 of 56 joins left one roster a peer short for good;
  after (50 peers, joins 60 ms apart), **the condition was hit in 4 of 9 joins and every
  roster was complete within 69-255 ms in all 9**, 49 links everywhere. It was
  NOT the network (caught on cable only, no interface change in `ip monitor`)
  and not the core. **PeerJS** needs nothing - its `DataConnection` closes
  itself on a send error and our transport re-dials (2 hits in 9 joins, both
  healed). **Trystero** calls `channel.send()` without a net and kept the dead
  direction for good; its transport now sends per peer and closes the
  connection of a peer it cannot send to (`repro-trystero-oneway`). The new
  opt-in scenario `oneway` makes the condition on purpose: until the peer that
  cannot be reached sees a rename - simple-peer never -> 0.4 s, Trystero never
  -> 2.0 s, PeerJS 3.3 s.
- **As first written - one roster short of one peer right after the join**, in 2 of 7 runs
  (once at 50, once at 25; both on the unfixed code, which proves nothing - the
  fix does not touch the join): peer A never shows peer B although their link is up;
  B is in everybody else's roster. A's transport log about B is clean — one
  outbound connection, ICE connected, channel open, no second link, no close —
  so it is not the transport. Both joined within the same second. Not found yet;
  it did not heal within the 180 s the harness waits (unfixed code, where B's
  renewal was being postponed — with the fix B's renewal at half a lease should
  bring it, not verified). The milder form showed once on PeerJS, on the fixed
  core: at the end of the 50-peer run one peer held a STALE state of two others
  (their state from before the name was set) - so it is one presence update that
  one peer of a pair misses, and the pairs had always joined within the same
  second. Six more 50-peer joins on the fixed core did not show it (0 of 8 there
  against 2 of 5 before - no mechanism by which the lease fix would touch a
  join, so: rare, not fixed). `DIAG=1` now prints, when it happens, A's transport
  log about B and - through `window.__provider`, which the three mesh playgrounds
  expose - B's own presence clock next to the clock, state and address A holds
  for B: no `meta` = B's presence never arrived, a clock >= B's without a state
  = it arrived and lost. **Caught that way on Trystero (35 peers): A holds
  nothing at all for B - no state, no clock, no address - while B's clock stood
  at 12 and both count the link: a link that delivers one way, below the core.**
  Details and what to look at next: the note.

## Firefox in the room (same day, after v1.8.1)

`FIREFOX=10` puts ten of the 25 peers into a headless Firefox 153 (puppeteer 25
over WebDriver BiDi) - the odd-numbered ones, so three of the five typists, the
peer that reloads and the `oneway` peer that cannot send are Firefox. Chrome and
Firefox find each other at once: full mesh, rosters after 0.9 s (simple-peer) /
2.4 s (PeerJS), five mixed typists identical everywhere.

**Found: a HIDDEN Firefox tab was taken for a sleeping page.** Firefox delays
the timers of a hidden tab in a busy room - measured with a probe in the page
(`window.__gaps`): ticks 5.6, 9.0, 15.3, 17.6 ... up to 24.2 s late, monotonic
clock the same, `visibilityState: hidden`; the one visible Firefox tab: none. An
idle room does not show it (100 s and 180 s untouched: nothing), nor a room that
only types; its budget throttling caps at 15 s - exactly the transports' old
`resumeAfterMs`. So every such tick was "the page slept": all links dropped, the
room joined again under a new id, about once a minute, for every Firefox user
with the tab in the background - 9 of 10 Firefox peers, links per peer up to 32
(stale ids), a rename visible after 20-34 s, a joiner in every roster after
22-26 s. Control: the same room with one Firefox PROCESS per peer
(`FIREFOX_EACH=1`, every tab visible) on the old threshold - no gap above 5 s, no
false sleep, the joiner in every roster after 1.3 s.

Fix (`src/providers/resume.ts`, the three mesh transports):
- default `resumeAfterMs` 15 s -> **30 s**: a link survives that much silence, so
  a shorter sleep has nothing to repair;
- and, because 24 s against 30 s is a margin and not a design: the page has slept
  when ticks **and links** were silent that long - the transports call `alive()`
  for every message a link delivers, and the first sign of life after the silence
  reports the sleep. (A first cut said "a message means awake" - wrong: what a
  page handles first when it wakes up is what queued before it fell asleep, its
  links are dead by then, and that message talked it out of rebuilding them.
  Frozen Chrome pages showed the order; `repro-simple-peer-sleep` part 10 holds it.)

Gates: `repro-simple-peer-sleep` parts 8-10 (timers 17 s late: links dropped
true -> false; no tick for 40 s while the link delivers: left alone; slept 40 s
and a queued message comes first: still a sleep), parts 1-7 and
`repro-peerjs-coordinator` unchanged. Real browsers, 15 Chrome + 10 hidden Firefox
tabs, all scenarios (the freeze now 40 s, longer than the threshold):

| | simple-peer | PeerJS |
|---|---|---|
| Firefox tabs that reported a sleep (before: 9 of 10) | 0 | 0 |
| their largest timer gap | 21.7 s | 17.0 s |
| frozen Chrome peers that rebuilt their links | 5 of 5 | 5 of 5 |
| `oneway`: a third peer / the unreachable one sees the rename | 1.2 / 3.3 s | 1.2 / 5.3 s |
| rosters complete after the unfreeze / a reload | 2.7 / 3.9 s | 2.7 / 3.8 s |
| at the end | 25 of 25, 24 links, documents identical | the same |

What Firefox costs a HIDDEN tab stays: every timer of the core (awareness
throttle, batching, reply delays) can come seconds late there - a hidden tab is
a slow answerer, which the room tolerates (others answer).

Three things that were the test bed, not the library - each looked like a finding
first: puppeteer's BiDi keyboard takes 11-16 s for 13 characters and blocks the
page's timers meanwhile (Firefox typists now get `insertText`, paced from the
harness); `innerText` of a Firefox editor typed into that way ends three newlines
short of the same document in Chrome (the final check now also compares the
`Y.Text`); Firefox throws on almost anything asked of a closed `RTCPeerConnection`.

Open: **Trystero with hidden Firefox tabs is slow, and that is Trystero's own
timers** (its announce cycle and offer pool run on timers Firefox delays by 15-25 s
in those tabs): rosters complete only 60 s after the join, and after a relay
restart a new peer was in 21 of 25 rosters when the harness gave up after 3 min
(15 of 25 before the fix above), links 23-24. Everything else in that run passes
(`oneway` 1.2 / 6.5 s, killed tab gone after 11 s, documents identical). Nothing
the transport can do about cheaply; not seen with Chrome-only rooms.

## A real phone in the room

`test/e2e/phone-session.mjs`: André's Android phone joins 8 headless Chrome peers
over the LAN (simple-peer, `http://<lan-ip>:3450/?phone`) and tells on itself
through its presence - one entry per absence that stays in the report, measured on
the phone's own clock: hidden for N s, links before / at the return / fewest after
it, all links back after N ms, first missed text after N ms. A desktop peer types a
character every 4 s. Three absences per session: another app in front (~30 s),
display off (~60-90 s), display off (~3 min).

**Firefox for Android** (first session; its report format still lost the phone's
own times): the room dropped the phone every time, ~30 s after it fell silent, and
it came back by itself every time - out of the roster at 110 / 189 / 315 s, back at
128 / 259 / 477 s; what was typed on the phone afterwards arrived (28 of 207
characters); after a 10.6 s absence it was up to date and in every roster 2.6 s
after the return.

**Chrome on Android** (second session) - recovers by itself every time, the links
always rebuilt (8 before, 0 at the return):

| hidden for | all 8 links back | first missed text |
|---|---|---|
| 42 s (another app) | **1.5 s** | 0.9 s |
| 87 s (display off) | **9.5 s** | 9.2 s |
| 206 s (display off) | **11.0 s** | 10.7 s |

The jump is the signaling socket. After a short absence it is still alive; after a
long one it is dead, and `handleResume()` closed it and left the reconnect to its
`onclose` - which a browser reports only seconds later for a connection that no
longer answers the closing handshake. Now the transport gives the old sockets up and
dials at once (`repro-simple-peer-sleep`, part 11: announced under the new id after
9.9 s -> 0.7 s with an `onclose` that comes 8 s late). Desktop check, 12 browsers,
five frozen 40 s: rosters complete 0.5 s after the unfreeze (2.7-5.7 s before).

On the phone itself (Chrome, the fix loaded; the phone now also records its own
timeline of a recovery - the transport's log lines and the browser's online /
offline events, in ms since the return):

| hidden for | its own timeline | all 8 links back |
|---|---|---|
| 97 s | signaling connected 239 - link 1 open 588 - first text 647 - link 8 open 718 | **0.7 s** (9.5 s before the fix, after 87 s) |
| 203 s | signaling error 155 - retry 5 in 5841 ms - slept 142293 ms noticed at 156 - signaling connected 6051 - link 8 open 6360 | **6.4 s** |

The second row is a second cause: with the display off that long the socket had
died in the background and four reconnects had failed; the page woke up BETWEEN
two retries, noticed the sleep after 0.16 s, found no open socket to replace - and
sat out the backoff. `dialSignalingNow()`: on a resume (and when the browser says
`online`, and when the tab becomes visible again) pending retries and attempts
still in flight are given up and every signaling server without an open socket is
dialled at once (`repro-simple-peer-sleep`, part 12: announced after 1.0-2.8 s ->
0.2 s). Desktop check unchanged: 0.5 s after an unfreeze, 0.2 s after a reload, a
signaling restart passes.

On the phone, with both fixes, **269 s with the display off**: `signaling error 5 -
signaling connected 166 - link 1 open 530 - first text 592 - link 8 open 903` -
all 8 links back after **0.9 s** (6.4 s and 11.0 s before). This time Chrome had
not slept through (its timers ran now and then, no sleep was reported, the links
had gone one by one in the background): it was the `visibilitychange` path that
dialled. Which of the two a phone takes depends on the device's mood; both dial
at once now.

**PeerJS on the phone** (after v1.8.2; Chrome on Android, 8 desktop peers, the
playground's `?phone` mode connects by itself) - comes back every time:

| hidden for | all 8 links back | first missed text | its own timeline |
|---|---|---|---|
| 67 s | 4.5 s | 2.3 s | no sleep reported (the tab kept running): server link lost 16 - reconnect 3 at 1948 - first text 2296 - connected to coordinator 3974 |
| 111 s | **1.5 s** | 1.1 s | slept 50830 ms noticed at 90 - connected to coordinator 994 |
| 238 s | **1.5 s** | 1.2 s | slept 177615 ms noticed at 173 - connected to coordinator 926 |

The resume path (a new `Peer`, a new socket) is the fast one. The 4.5 s case is
the pattern simple-peer had: the page came back while PeerJS's reconnect sat in
its backoff ("reconnect 3" only 1.9 s after the return). What was typed on the
phone arrived (16 of 180 characters); the phone's last report said 177 of 180 -
taken for report lag at the end of the session, not checked.

`PeerJSTransport.reconnectNow()`: when the tab becomes visible again, or the
browser says `online`, a reconnect that is waiting in its backoff is done at once
(`repro-peerjs-coordinator`, part 13: next `reconnect()` after 1.0-2.1 s -> 20 ms;
part 8, a server that stays down, still 4 attempts in 10 s; desktop check with 12
browsers incl. server restart and killed coordinator passes). On the phone the
case did not come up again - both returns of that session went other ways and were
fast (158 s hidden: all links back after 1.5 s; 133 s: 2.0 s) - so there it is
neither confirmed nor refuted. And once more a forgotten tab (the previous PeerJS
session's) came back into the new room by itself, across a restart of the PeerJS
server, and its 177 characters merged into the new document.

Also seen by accident: a tab forgotten in Chrome for 2,907 s (48 min), on the OLD
code, across a restart of the signaling server, came back into the new room by
itself and had the first text after 0.65 s.

## Firefox and the relay transports: Nostr (same day, evening)

The Firefox and phone rounds above ran on the two mesh transports. The same room
on Nostr (`room-scenarios.mjs nostr`, the NIP-01 relay of the script, `FIREFOX=10`
as hidden tabs of one Firefox) - join 0.9 s, five mixed typists 1.4 s, a killed
tab gone after 121 s (the playground's 120 s lease), five Chrome pages frozen
40 s: missed text after 1.2 s, the outage: text typed during it everywhere 6.3 s
after it ended. No false sleep here: a relay transport has no `watchResume`.

**Found: a HIDDEN Firefox tab that reloads leaves its old entry in every roster
until the lease runs out.** "reload: rosters complete", 25 peers, `join,rejoin`:

| room | before | after |
|---|---|---|
| Chrome only | 613 ms | |
| ten Firefox peers, a process and a visible window each (`FIREFOX_EACH=1`) | 598 ms | |
| ten Firefox peers as hidden tabs | 111,343 ms (25,549 ms late in a full run) | 3,602 / 2,255 ms |

It is the core, not Nostr. The `beforeunload` handler removes the local presence
state, and that removal went to the room through the awareness throttle - a
timer, `setTimeout(0)` at best. A page that is being unloaded still runs it in
Chrome and in a visible Firefox tab; a hidden Firefox tab clamps its timers to
1 s and more and is gone before. The update batch (`batchUpdates`, 150 ms by
Nostr's `preferredBatchMs`) had the same fault with a worse outcome: what was
typed within that window before the page went away never reached the room.
Gate: `test/dummy/bench-unload-removal.ts` - B's unload handlers run, and from
the moment they return nothing B sends leaves the page. Before: still in the
roster in all three parts (idle before / a presence change just before / typed
just before: its last words lost); with `TIMERS_ALIVE_MS=50`, Chrome's case, the
same build passed. Fix: the unload handler flushes the update batch, and a
removal of origin `'window unload'` goes past the throttle. Every transport has
it, a relay without a leave signal shows it longest.

Not explained: the 2-4 s that remain against 0.6 s (two runs). A guess, not
measured: the NEW presence of the reloaded tab still leaves through the throttle
timer of a hidden tab. A user with the tab in the background does not see it.

Test-bed notes: the playground's source was edited during the first full run
(parcel rebuilt it under the run; the reloaded peer and the late joiner loaded
the new bundle) - the three controls and both "after" runs were clean. That run
also ended with "editors identical: false" for one Firefox typist (three trailing
newlines, the known `innerText` difference); its Y.Text comparison did not run,
the pages of that build did not expose their provider. All five clean runs:
editors and Y.Text identical.

### The real phone on Nostr

`phone-session.mjs nostr` (the relay moved into `test/e2e/nostr-relay.mjs`,
`?phone` / `?desk` in the Nostr playground; "links" are the relays that hold the
subscription - one). Nostr needs no secure context without a room password, so
the plain LAN address works. Chrome on Android, 8 headless peers, one of them
types every 4 s; measured by the phone on its own clock.

What had been expected by reading - a socket that died without a `close` and is
never noticed, the pool is built without `enablePing` - did not happen: "links 1
before / 0 at return" every time, the transport knew. **Found: the backoff.**
With the display off every attempt to subscribe again fails and the wait climbs
1, 2, 4 ... 30 s; the phone wakes somewhere in it.

| hidden for | first missed text | the phone's own timeline |
|---|---|---|
| 46.9 s | 5.7 s | subscribed 5640 |
| 106.7 s | **30.3 s** | 185 subscription closed, again in 30000 ms - subscribed 30207 |
| 278.3 s | 0.4 s | subscribed 317 (a retry happened to be due) |
| 14.5 s | 0.5 s | subscribed 476 |

Fix (`NostrTransport._resubscribeNow`, on `visibilitychange` visible and on
`online`, as `PeerJSTransport.reconnectNow`): a subscription that waits in its
backoff is made at once, and the attempt counters start over - so an attempt
that is in the air at that moment and fails is repeated after 1 s. Gate:
`test/nostr/repro-relay-restart.mjs` part 4, 13.2 s -> 1.0 s (its floor). On the
phone, second session, all three returns in the bad pattern:

| hidden for | first missed text | the phone's own timeline |
|---|---|---|
| 67.7 s | 1.2 s | 97 subscription closed, again in 1000 ms - subscribed 1118 |
| 128.7 s | 1.2 s | 130 subscription closed, again in 1000 ms - subscribed 1136 |
| 102.6 s | 1.3 s | 188 subscription closed, again in 1000 ms - subscribed 1208 |

It was the counters every time, never a waiting timer ("page back: subscribing
now" is in no timeline): the overdue retry had fired at the wake, before the
`visibilitychange`. The room was right throughout: the phone out of the rosters
after the lease (129 s hidden: gone 2 s before its return), in every roster again
at the return; what was typed on the phone arrived.

**Found, left to the lease: a tab closed on the phone tells nobody.** Closed with the X of
Android Chrome's tab overview, the phone stayed in every roster for the whole
lease - three times (closed ~750 / 591 / 78 s, gone 875 / 711 / 207 s). The page
now reports every lifecycle event with `sendBeacon` (`phone-report.ts`, printed
by the session script). Desktop Chrome, tab closed: `beforeunload`, `pagehide`,
`visibilitychange hidden` - gone from every roster 0.1 s later. The phone:
`visibilitychange hidden` when the overview opened, and after that NOTHING - no
`pagehide`, no `beforeunload`, no `freeze`. The last thing such a page is told is
the same thing it is told when the user looks at another app for a minute. So
this is not the unload fix above (a handler whose timer never ran): here no
handler runs. Decided (André, the same evening): the core stays as it is and the
lease covers it - 30 s by default, the 120 s are the playgrounds' choice for
relays without a leave signal. The alternative was a hidden page saying so
(removal at `hidden`, presence again at `visible`): every user who switches tabs
or apps then leaves the roster for that time. An app that wants that can set an
`away` field in its presence at `hidden` today.

**Found: back from a dead link, a relay peer's roster stays short.** André saw
it on the phone: "only two users" after a long time with the display off. Not
every absence does it - a page that SLEPT is covered since round 8 (a late sweep
tick: one more lease, and a JOIN beacon), and in one session the roster was 9
before and 9 at the return after 173 s and 94 s. It takes a page that RUNS ON
behind a dead link for more than half a lease: it hears no renewal and expires
the room entry by entry, rightly. Made on purpose - display on, WiFi off for
2.5 min - and written down by the phone itself (`life` in its report, delivered
after the return): roster 9, WiFi off at 28 s, 3 at 127 s, 1 at 154 s.

Two causes, both in the core's answer to a relay link that came back
(`_schedulePeerConnectSync`, the branch without unicast), gate
`test/dummy/bench-relay-return-roster.ts` (a relay hub, lease 10 s, the phone's
link away for 15 s while its timers run):

1. It announced itself and synced the document with a beacon that does not ask
   for presence. Right on a mesh, where the far end of a new link sends its own;
   on a relay nobody noticed that we were away. The others came back with their
   renewals, up to half a lease later. Roster whole again: 5.3-5.6 s -> 0.1 s
   (N=9), 6.0 s -> 0.1 s (N=25). Now it asks (JOIN). The price, when nobody
   needed to ask - a relay restart, every link away for 1 s and back at once,
   the 3 s after: 96 -> 208-256 deliveries and 5 -> 10-12 kB at N=9, 696 ->
   1,272 and 35 -> 62 kB at N=25. About twice, once per restart, ~2.5 kB per peer.
2. With that fix the phone had 8 of 9 in the same millisecond and the ninth
   55.5 s later. y-protocols keeps the clock of a peer it expired and ignores a
   state at an equal clock; a peer that writes or beacons keeps its lease alive
   with that and never renews its presence, so its clock stands still - and the
   table that answers the JOIN carries it at the clock the phone remembers. With
   a writer in the gate's room: 8 of 9, the ninth NEVER (a lease watched);
   without: 9 of 9. Now a peer that asks as a joiner forgets, as one, the clocks
   of whoever is not in its roster. 9 of 9 after 0.1 s, three runs of three.

On the phone, the same WiFi test once more with both fixes: roster 2 at 125.5 s,
1 at 137.3 s, 8 at 154.5 s, **9 at 155.0 s** - the ninth 0.5 s after the others
instead of 55.5 s. Neighbouring gates on the final core: `bench-last-joiner-roster`
0 of 12 incomplete, `bench-rate-limited-channel` 5 of 5 converged,
`bench-renewal-under-churn`, `bench-wake-false-timeout`, `bench-resume-roster`,
`bench-unload-removal` pass. 25 Chrome peers on the final core
(`join,typing,sleep,rejoin,restart`), against the third pass of the mobile
research: rosters after the join 417 ms (412-817), join frames 192 (194), 10 idle
seconds 3 frames (2), five typists 696 ms (607), reload 596 ms (588), text typed
during the outage everywhere 2,268 ms after it (2,172), a new peer in every roster
847 ms (880), editors and Y.Text identical, 0 refused sends. The relay counted 88
EVENTs from its restart to the end of the run, a new peer's join included.

## Firefox and the relay transports: WebSocket (2026-09-21)

The same room on the WebSocket playground against the edrys relay (a y-websocket
fork), `FIREFOX=10` as hidden tabs. First run: "killed tab dropped from every
roster" 42,616 ms against 454 ms in round 8 - and it was not the killed tab.

**Found: a peer that is told it is gone does not hear it.** "0 of 24" in the
harness's wait line only says that a roster is not 24 long; with the roster sizes
printed (`DIAG=1`, new) it read 6-7 of 24, back to 24 over 40 s. The server's own
trace (a scratch copy that logs who brings which entry): the killed tab's
connection held one entry, its own - but 9 s BEFORE the kill the server had
expired nineteen idle entries by itself. A y-websocket server runs y-protocols'
awareness with its fixed 30 s timeout; the playground renewed every 60 s (the
120 s lease of the relays without a leave signal). Firefox is not needed: 25
Chrome peers left alone for 45 s (`IDLE_MS`) had rosters of 2-3 of 24. It had
stayed invisible because every roster check of the harness fell within 30 s of
some activity; the Firefox run waited 27 s longer in `typing`.

The core has a path for a wrong removal: y-protocols never deletes the local
state on a remote removal, it raises the clock and reports it, and the provider
re-announces itself. Looked at from inside a peer (a scratch script on the
playground): in a room where nobody had typed it works, also in the browser - own
removal heard at 30.7 s, 97 bytes sent in the same millisecond. After somebody
typed twelve characters the idle peers' presence clock stood at 13 instead of 2:
y-quill re-sets the cursor with every remote edit, an equal state, which the
provider rightly does not broadcast since round 5 (item 8) - so the local clock
runs ahead of the room's. The removal at the room's clock is older than the local
one, y-protocols ignores it, the peer is never told, and everybody else drops it
until its next renewal. Every transport, every app whose binding re-sets its
cursor.

Gate `test/dummy/bench-removed-at-old-clock.ts`: B re-sets its unchanged state
12 times, A tells the room that B is gone at the clock the room knows. Back in
every roster: 10,997 ms (the renewal, lease 20 s) -> 203 ms; the control without
re-sets 204 -> 202 ms. Fix: the wire-level scan of every presence message already
names who is removed - our own id there, at whatever clock, and we say that we are
here. Browser, six peers, one typed first: rosters after 40 s `[1,2,2,2,2,2]` ->
six times 6. `bench-awareness-echo` still N-1 messages.

And the playground is back at the default lease: a y-websocket server is a peer of
the room with a lease nobody can set, and it needs no long one - it removes a
closed connection's entries at once (`src/providers/websocket/README.md`).
edrys-Lite passes no lease, so it has the default; check 6 of
`test/dummy/e2e-edrys-ws.ts` (the room left alone for 40 s, `EXTRA=22` for 25
clients) holds there - without an editor binding, so it does not show the clock
running ahead.

On the final code, 25 peers with ten hidden Firefox tabs (round 8, Chrome only):
killed tab 501 ms (454), five pages frozen 40 s 2,857 / 2,906 ms (2,834 / 2,841),
reload 2,220 ms (548 - the hidden-tab remainder seen on Nostr), a new peer in
every roster after the restart 886 ms (775), editors and Y.Text identical, 25/25.
"editors identical: false" right after `typing` is the `innerText` difference of
the three Firefox typists (three trailing newlines), now with the Y.Text
comparison next to it. Not looked into: text typed DURING the 5 s outage is
everywhere only ~10 s after the restart (both runs; no reference).

### The real phone on WebSocket

`phone-session.mjs websocket` (`?phone` / `?desk` in the playground, the edrys
relay on all interfaces; the one "link" is the socket). Chrome on Android, eight
desktop peers, one types every 4 s; the phone now stamps its own network changes
(`navigator.connection`) and logs the transport's lines over its whole life.

| page time | the phone's own log - display on, WiFi off and on again |
|---|---|
| 15.5 s | socket closed 1006, retry 1 in 1289 ms - `network wifi` -> `none` -> `cellular` (and `online`) |
| 16.8 / 28.8 / 48.0 s | reconnect FAILED, retry 2 in 2072, 3 in 9191, 4 in 14551 ms |
| 32.6 - 44.6 s | roster 4, 3, 2, 1 (the 30 s lease) |
| **68.3 s** | **`network wifi 4g`** - the WiFi is back. No `online`: the page never was offline |
| 72.6 s | reconnect FAILED (the attempt had started over mobile data), retry 5 in 8567 ms |
| **81.2 s** | socket connected - **12.9 s** after the network was there |
| 81.5 s | roster 9 of 9, 0.3 s after the socket (the two core fixes of v1.8.3) |

**Found: the WebSocket transport sits out its backoff** (2 s doubling to
10 s, x0.5-1.5) - it has no "do it now" as simple-peer, PeerJS and Nostr have, and
those three would not have helped here either: with the display on there is no
`visibilitychange`, and a phone that falls back to mobile data says `online` when
the WiFi GOES, not when it comes back. `navigator.connection`'s `change` does say
it, on this Chrome. By André's eye ~30 s from the switch, the WiFi's own start
included.

Fix: `watchPageBack()` in `src/providers/resume.ts` - `visibilitychange` to
visible, `online`, and `change` on `navigator.connection` - replaces the three
identical blocks of simple-peer, PeerJS and Nostr, which so gain the third sign,
and gives the WebSocket transport its `reconnectNow()`: a retry that waits is made
at once, an attempt that is in the air over a network that is gone is given up (its
handlers first, and its 10 s timeout can no longer close the socket that replaced
it), the backoff starts over. Gate `test/providers/repro-websocket-wake.ts` (the
real transport on a stub socket and a stub page): waiting in the backoff 2,346 ms
-> 6 ms, an attempt that hangs 10,119 ms -> 6 ms, nothing dialled while connected
or after disconnect(). The three transports' own gates as before (simple-peer
parts 11/12: 707 / 202 ms, PeerJS part 13: 20 ms, Nostr part 4: 1,024 ms). On the
phone, the same test again: `network wifi 4g` at 66.2 s, `socket connected` at
66.2 s, roster 9 at 66.2 s - the same tenth of a second, against 12.9 s; by
André's eye "at once, 2 s after the WiFi was there". (While the WiFi was away each
network change - wifi, none, cellular - started the backoff over: "retry 1" three
times. Intended.)

Display off for 113 s: the socket survived, the text went on, roster 9 ->
9, first missed text after 2.1 s. The tab closed with the X: gone from the rosters
40.5 s later (the 30 s lease).

**Found: the presence renewal starves while somebody types.** After its return
the phone's roster fell to 3-6 of 9 every 30 s and was whole again 0.1-0.2 s
later - the server's timeout again, now with the DEFAULT lease. The sweep renewed
by `awareness.meta`'s `lastUpdated` of the own entry, and y-protocols stamps that
with EVERY setLocalState(), also an equal one that is never broadcast: y-quill
re-sets the cursor with every remote edit, so while somebody typed every reader
believed it had just renewed and the room heard nothing of it. Towards a
y-websocket server a digest or an update counted as a renewal as well, which such
a server does not read. Not y-websocket alone: in part 2 of
`bench-removed-at-old-clock.ts` (B re-sets its unchanged state once a second for
three leases and does nothing else) A dropped B in BOTH modes. Fix: the sweep
renews by when the ROOM last heard us (`_presenceHeardAt`, stamped in `_send`: our
own presence entry, or - not with a y-websocket server - a digest / verified
update). The 0.1 s healing was this morning's fix at work; before it, those peers
had stayed out until their next real change.

| | v1.8.4 | fixed |
|---|---|---|
| gate, y-websocket mode: longest silence of B at A (lease 6 s) | 6,356 ms, B dropped | 3,608 ms, listed throughout |
| gate, verified mode | B dropped | listed throughout |
| the real relay, 9 Node clients, one types, 70 s: entries the server expired | 2 (the typist, every 30 s) | 0 |
| 6 Chrome peers with y-quill, one types, 70 s | 2 (3 and 4 of the 6 peers) | 0 |

An idle room's volume is unchanged (`bench-idle-room`, N=20: 247 deliveries in
both, no presence among them). 25 peers with ten hidden Firefox tabs again: killed
tab 500 ms, reload 2,198 ms, editors and Y.Text identical, 25/25.
On the phone with this fix: no change of its roster at all in the 280 s after its
return, with the same typist in the room - against a fall to 3-6 of 9 every 30 s.

Seen on the phone and not the library: the playground said "Disconnected / Not
Synced" throughout. The shared `updateStatus()` / `updateSyncStatus()` wrote to ids
that the pages of websocket, ably, pubnub and matrix do not have - their badges had
never been updated. The provider said `connected`, `synced: true`, also after a
dropped socket.

## Firefox and the relay transports: Gun (2026-09-21, afternoon)

The same room on the Gun playground against `Docker/gun/relay.js`, `FIREFOX=10` as
hidden tabs, and the one number the third pass had left open: a reloaded page
was a ghost in every roster for a lease - 124.3 s in round 8, 128.5 s of 25
Chrome peers on v1.8.5. Round 8 had read the cause ("Gun writes through several
timers, the removal of `beforeunload` does not reach the wire") and not measured
it. It took three findings, each with a gate under plain Node that was red first
(`test/gun/repro-unload-removal.mjs`: the real GunTransport with gun's browser
websocket adapter, a watcher at the relay, seven departures with a marker each,
and a late joiner).

**1. The removal never left the page.** gun 0.2020.1241 hands every write to
its own turn queue (`setTimeout.turn`, gun's shim), drained by a MessageChannel
task in the browser and synchronously only while the last drain is under 9 ms
old. The provider's unload handler sends the removal without a timer since
v1.8.3, and that is where the core's part ends: a page that unloads runs no
further task of gun's. Measured: a removal sent and the process gone in the
same tick - NEVER heard, 8 s watched; gone one macrotask later, heard 4 ms
before the process was gone. Fix: `Transport.flush?()`, optional, called by the
provider's unload handler after the batch and the removal - "put whatever is
queued on the wire NOW, in the calling task". Gun's runs its own queued
functions, in rounds (each layer queues the next: chain, `root.on('out')`,
`mesh.say`, `wire.send`), capped at 50. The last typed batch goes first, into
one update node warmed with `data: null` at connect: gun asks the relay about
a node it has never written and puts only when the answer is in, a round trip
the page does not have (a wire trace of a put to a fresh slot: a `get` and
nothing else). With `flush()`: removal 5 ms, typed batch 2 ms before the
process was gone. With a password the batch is lost either way, its encryption
is asynchronous; the removal is not encrypted. Transports that send straight
into an open socket leave `flush` undefined.

25 Chrome peers with that: reload 127,944 ms. `DIAG=1` prints the roster sizes:
`{"min":24,"median":24,"max":25}` from the first second - 24 rosters whole the
moment the page reloaded, ONE at 25 for the lease. The removal had reached
the room. A trace of 25 playground pages (a scratch script: the reloaded page
decodes every presence it receives, the transport's log names the slot and
the age of each) said who: the reloaded page itself, holding its OLD id at
presence clock 2 - the presence, not the removal at clock 3 - added by a
message of three clients out of ANOTHER peer's slot, written 3 s before the
reload: a relayed presence table (round 5, presence on demand), the last thing
that peer had written, replayed to the joiner as every slot's last value is.
And the reloaded page's own old slot brought no removal, because:

**2. `disconnect()` erased it.** A wire trace of the unloading page (every
`wire.send` reported through `navigator.sendBeacon`, which survives a
navigation): the provider's handler puts the removal on the wire in its own
task; the playground's own `beforeunload` then calls `provider.disconnect()`,
and `GunTransport.disconnect()` nulled the own slot since round 7 ("take our
presence slot with us") - gun's queue sent that null 2 ms after the handler
and 6 ms before `pagehide`: a browser still runs a task or two in between.
Live peers had the removal by then; the page that joined next was replayed an
empty slot. Gate, the disconnect part with the process gone in `setTimeout(0)`
(the task a browser still runs), and a late joiner C: C's replay had no
removal -> the removal. Fix: the slot stays, with the removal in it.

25 Chrome peers with that: reload 122,042 ms; with ten Firefox tabs 123,722 ms.
Still one roster at 25 - a different ghost, the tab killed in `vanish` two
minutes earlier: its slot held its last presence, replayed to the reloaded page
as fresh, listed for a lease of the reloaded page's own while the room had
long expired it. Round 7's five-minute bound on a slot's age (a wall clock;
the writer's) cuts the hours-old slots, not this one, and a bound the size of
the lease would make a peer whose clock runs a minute off invisible.

**3. The replay is history, not presence.** gun's `.map().on()` callback gets
the wire message as its third argument, and it tells the two apart without a
clock (`test/gun/probe-replay.mjs`): a slot replayed at subscribe comes as the
answer to the subscriber's own get, with `@` set to that get's id; a peer's
live write comes with its own id (`#`) and no `@` (a NEW slot comes both ways,
live first). Since v1.8.6 the transport hands no replayed presence up. Who is
here now, a joiner learns from the room's answer to its JOIN (a live presence
table): the reloaded page's roster was whole in 0.4 s from that in every run.
A re-subscribe after a relay restart gets answers the same way, and the
provider asks the room for its presence then anyway (`onPeerConnect`). Gate:
C joins after every leaver is gone - a tab that vanished without a word among
them - and is replayed nothing of presence, and hears the presence A sends
live once C is subscribed. `bench-gun-awareness-replay` (the round 7 bench,
its fake gun now passes the message): 55 phantoms of 60 slots in round 7, 5
recent ones after it, 0 now, the 5 live peers through the room's answer.

With the `@` test alone, 25 Chrome peers: reload 127,265 ms, and the harness
now names the extra (`DIAG=1`, the longest roster and the entries in it that
are no live peer's): p24, the killed tab, held by the reloaded p11 - while ten
Firefox tabs gave 6,459 ms, the reloaded page a Firefox one. p11's transport
log, dumped (the Gun adapter ticks the playground's debug box now): the 25
answers to its own get, all dropped; then, 60 ms later, as the page wrote its
own slot, the same 25 slots once more with the message keys `$,put,VIA,seen,get`
- neither `#` nor `@` - p24's 180 s old presence among them, taken for live.
gun's chain `input` converts a whole node "from old format" key by key and
hands the callback a converted message with the original under `VIA`; the Node
probe with two slots never takes that path, Chrome with 25 pages does. The
listener looks through `VIA` and takes only a message with `#` and no `@` as a
peer's word. The fake gun of the bench re-emits every sibling under VIA when a
slot is put, as seen: 0 phantoms still.

On the final code, 25 peers (round 8 / v1.8.5 in brackets): reload 529 ms
(124,338 / 128,555) - the number this pass was about; with ten hidden Firefox
tabs 6,185 ms (the reloaded page a hidden tab, "the reloaded peer has the room
text" 4,920 ms of it). Killed tab dropped from every roster 119,909 / 93,445 ms
(the 120 s lease), five pages frozen 40 s 3,623 / 3,624 ms, text typed during
the 5 s outage 4,846 / 6,713 ms, a new peer in every roster after the restart
780 / 740 ms, editors and Y.Text identical, 25/25. Join 405 ms; one Firefox run
of five had the first four hidden tabs missing from 13 rosters for 72 s (the
others 0.8-2.8 s, and 1.3 s in the run after it with the receivers' logs dumped:
every dropped presence an answer) - three more runs 931 / 1,380 / 932 ms, every
roster whole: a one-off, and the converted messages seen in those logs wrapped a
chain object (`via`: gun's own `at`), no wire message at all - the slots had
come live before, with `#`.

Seen on the way, the same on v1.8.5 (a worktree, the same probe), and fixed
after the phone (v1.8.8): a room whose peers are ALL gone gave a joiner no
document from the relay's replay - the update listener skipped every `.map()`
answer that arrived before its `.once()` initial load called back (gun's
`once` waits 99 ms, the slots' answers are in by then), and the initial load
itself saw the node's links, not the slots' data; with a peer in the room the
core's sync had covered it (the reloaded peer had the room text in 0.4-0.8 s),
alone there was nothing. The same skip lost the FIRST update of a fresh room to
a peer that had subscribed a moment before: a witness 50 ms in the room heard
the second and third of three updates, one 3 s in the room all three (v1.8.5,
both). One listener for what the relay holds and what comes later, deduped;
gate `test/gun/repro-lone-joiner.mjs`: the lone joiner NOTHING -> all three.
25 peers with that, Chrome / ten Firefox tabs: text of one peer in every
editor 462 / 547 ms, reload 539 / 2,882 ms, a new peer after the restart with
the room text 402 / 809 ms, editors and Y.Text identical, 25/25 - the
document path changed and nothing moved.

### The real phone on Gun

`phone-session.mjs gun` (`?phone` / `?desk` in the playground, `Docker/gun/relay.js`
on all interfaces; the one "link" is the socket to the relay). Chrome on Android,
eight desktop peers, one types every 4 s. The phone reached the room only at
260 s of the run: `ufw` on this machine had no rule for the playground's and the
relay's ports - nothing of the library, and the address answered from the
machine itself; the phone then had 8.5 of the 12 minutes.

| absence | socket at return | roster whole after | first missed text after |
|---|---|---|---|
| another app in front, 48 s | gone; back after 1.0 s | 0.5 s | 1.4 s |
| display off, 84 s | there | 0.5 s | 1.3 s |
| display off, 200 s | there | 0.5 s | 0.8 s |

The room dropped the phone after the 120 s lease of the long absence (GONE at
618 s) and had it back in every roster the moment it returned (693 s); at the
end its document was the room's, 183 of 183 characters. Nothing wrong with the
library this time.

One thing to read in the phone's own timeline: while the display was off the
relay socket died again and again ("relay gone, dialing again" at 33 s and 72 s
of the 84 s absence, at 28 s and 67 s of the 200 s one), and the transport's
backoff doubled, 3 s, 6 s, 12 s. That the relay was back 0.2 s after the display
came on was the pending timer firing on wake. Gun was the one relay transport
without `watchPageBack`: a backoff set right before the WiFi goes, display on,
would have been waited out in full - the case the WebSocket phone found the day
before (12.9 s). Fixed the same way (v1.8.7); gate `test/gun/repro-page-back.mjs`:
relay killed, back 13 s later with the transport in a 12 s wait, the page visible
1 s after that - relay back at the transport 1,009 ms after its return, the
control with nobody saying anything 8,022 ms. The playground's "links" (relays
with an open `wire`) said 5 s for the two display-off absences where the
transport's own "relay back" said 0.2 s: the getter, not the library.

## If it is built — order of work

1. Turn the probe into a gate: `bench-partial-mesh.ts` that fails on an incomplete
   roster, a missed keystroke, a ghost, or more than ~1.5x the full mesh's frames.
2. The one core change of finding 3 (address from presence), with
   `bench-last-joiner-roster` and `bench-presence-after-relink` as regression gates.
3. `src/providers/relay/` — a wrapper over any transport that has `sendTo` /
   `onPeerConnect` / `onPeerDisconnect`: envelope, duplicate window, learning-bridge
   unicast, `connect()` at the first link, membership. Flooding first (it is the
   repair channel anyway), **off while every known peer is a direct link**.
4. Plumtree on top; random dial rule in simple-peer / peerjs (`maxConns` becomes a
   real cap again).
5. `test/e2e/room-scenarios.mjs` with the cap lowered to ~8, so 25 browsers
   exercise relaying; the sleep/resume and killed-coordinator scenarios are where
   a relay will hurt first.

Open: encryption (the transports encrypt per link today — a relay re-encrypts per
hop, fine, but it reads the envelope); what a resuming phone's new peer id does to
routes and duplicate windows; PeerJS's single coordinator as the membership source.

## Run

```
npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/probe-partial-mesh.js
  N=100 CAP_MIN=20 CAP_SPREAD=15 HOP_MS=20 KEYS=30 SEED=1 VARIANTS=full,partial,flood,tree
  N=25 VARIANTS=full,fullflood,fulltree      a room under the cap
  TOPOLOGY=1 [RULE=random DIAL=10]           join rules only, 200 seeds per N
  JOIN_AT_FIRST_LINK=0 / MEMBERSHIP=0        the relay without the measures of finding 3
```

~40 s per variant.

[yw22]: https://github.com/yjs/y-webrtc/issues/22
[yw3]: https://github.com/yjs/y-webrtc/issues/3
[plumtree]: https://www.dpss.inesc-id.pt/~ler/reports/srds07.pdf
[hyparview]: https://asc.di.fct.unl.pt/~jleitao/pdf/dsn07-leitao.pdf
[chrome500]: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/peerconnection/rtc_peer_connection.cc
[chromegc]: https://issues.chromium.org/issues/41378764
[feross]: https://github.com/w3c/webrtc-pc/issues/230#issuecomment-391181990
[stun]: https://webrtc.googlesource.com/src/+/refs/heads/main/p2p/base/p2p_constants.h
