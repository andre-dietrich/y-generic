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
