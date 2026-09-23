# A WebRTC room of 100+ peers: the conference transport (round 11)

Status: built 2026-09-22 on branch `round-11-conference`. Follows
`2026-09-20-partial-mesh-relay-research.md`, whose answer to "can the WebRTC
transports hold more than a full mesh allows" was *yes, as a relay under the
core* (option C there) and whose recommendation was *not to build it yet*.
André's question on 2026-09-21: can a special WebRTC provider, or a better
PeerJS / simple-peer one, connect more than 100 peers - decided: build it,
pure peer-to-peer, aim at 300, test with 100-150, call it `conference`; and
check whether handing it the expected number of users helps.

## Short answer

`src/providers/conference` (`ConferenceTransport`) wraps a mesh transport
that holds a handful of links per peer and passes frames on. With the gate
`test/dummy/bench-partial-mesh.ts` - the real wrapper, the real dial rule,
simulated data channels and signaling, no oracle - a room of 100, 150 and 300
`GenericProvider`s behaves like one room: every roster complete, every
keystroke within a second, cursors and pub/sub everywhere, a killed tree node
gone from every roster after 4 s while typing goes on, a cut link between two
living peers costs nobody a roster entry. The relay needs 1.1-1.2 x (N-1)
frames per broadcast of the core; a full mesh needs 1.0, flooding 27.

Real browsers: 25 through every scenario of `room-scenarios.mjs`, 100 through
join / typing / a killed tab / a reload / bandwidth - see "Real browsers".

## What the literature search added (2026-09-21)

- **An existence proof:** Spray / CRATE (Nédelec et al., WWW'16) - a
  collaborative editor over WebRTC with a partial view of ~ln N links per
  browser, "up till 600 browsers" in the lab, existing links acting as the
  signaling mediators for new ones. The code (`spray-wrtc`, `n2n-overlay-wrtc`,
  `foglet-core`) has not been published since 2018: the algorithm is the
  reusable part.
- No maintained Plumtree / HyParView for browsers. js-libp2p's gossipsub is
  maintained but "a large dependency making it suboptimal for browser
  bundles" (libp2p's own docs), and browser-to-browser needs a circuit relay
  that stays up.
- WebTransport is Baseline since Safari 26.4 and needs a server; P2P
  WebTransport and the Local Peer-to-Peer API are unimplemented; Iroh's
  browser peers are relay-only.
- **The network is the larger risk than the algorithm:** a lecture hall is one
  WiFi; with client isolation (eduroam) every pair needs TURN, and TURN
  allocations scale with links, not peers. iOS suspends WebRTC when the
  display locks - hence leaves (`relay: false`).

## What the gate found, in the order it found it

Every rule in the wrapper was a failure of the gate first.

1. **One tree for the room falls apart.** Plumtree as published keeps one
   eager/lazy flag per link. Two origins' frames going round the same cycle in
   opposite directions each prune a different link of it; in a joining room
   that happens all the time: 40 of 49 tree links, 26 of 50 rosters complete.
   → one tree **per origin**. What a link is for an origin nobody has heard
   yet is the link's *default*; every peer keeps `feeds` (1) links eager by
   default and asks for the rest to be lazy, which the other end refuses when
   it would be left without one. With 2 default feeds the default graph has
   ~N extra edges and every origin pays a duplicate and a PRUNE for each once:
   240 frames per keystroke at N=100 against 158 with 1.
2. **Two frames sent back to back** (a joiner's beacon and its presence) reach
   a peer over two links in opposite order; the first frame's duplicate pruned
   link B, the second comes over B first and its duplicate prunes A.
   → the link that brought the latest first copy stays eager (GRAFT at once).
3. **A change of a link's default wiped what was routed over it.** A fresh
   joiner's links are all eager until its HELLOs are through; it hands its
   neighbours first copies meanwhile, then both ends call the link lazy and
   each takes the other for its feed. → a link that turns lazy by default
   stays eager for the origins that arrive over it.
4. **One flag for both directions cuts a peer off.** Its feed gets a duplicate
   FROM it, prunes the link, and with that stops sending TO it - while the
   peer's other source has just lost against that feed. Five peers without
   any eager link for one origin. → a state per direction; the receiver
   alone says who sends to it, and only over a duplicate.
5. **"Before my time" was not.** A joiner's second frame reached a peer over a
   shortcut (a fresh joiner, 3 hops) 8 ms before its first, the JOIN beacon,
   came down the tree (8 hops); dropped as history, and that peer never
   answered the JOIN. → for 3 s after first contact a lower seq counts.
6. **...and must not move a route.** With routes taken from such stragglers a
   peer's answer to a JOIN went p33 > p25 > p39 > p97 > p35 > p33 (15 of 30
   joins failed). → a route comes only from a frame that advances the front;
   a unicast without a way, or one that comes back, travels inside a
   broadcast of the peer that noticed (N-1 frames down its tree; over every
   link it was 7,500 at 300 peers, and a joiner whose JOIN was retried made
   58,000 frames in five idle seconds out of it).
7. **The core could not tell whom a departure meant** - the one core change
   the research doc predicted: `clientID -> address` was learned from sync
   frames only, a joiner gets a settled peer's presence as a unicast awareness
   frame and, Trickle keeping settled peers quiet, never a beacon. 23 of 99
   peers kept the killed peer. → `src/index.ts`: an awareness frame with
   exactly one state names its sender's address, while nothing better is known.
8. **An ALIVE arrived 25 ms before its SUSPECT** (two origins, two trees),
   stopped no timer, and 3 s later a living peer was gone from five rosters -
   for half a lease, because the core had dropped its presence. → ALIVE names
   the SUSPECT it answers; a peer that was given up and is heard again is told
   so (REVIVE) and its core sends its presence again, as for a re-opened link.
   (Flooding SUSPECT/ALIVE over every link also worked and cost 12,000 frames
   per cut link at N=150 instead of 1,200.)

## Real browsers

`test/e2e/room-scenarios.mjs conference` - the simple-peer playground under the
wrapper (`conference` in the playground's config or `?conference=N` in its URL),
headless Chrome, y-webrtc's signaling server, `expectedPeers` = N.

**25 browsers, every scenario:** rosters complete 807 ms after the last page
loaded at 4-15 links per peer (a full mesh: 24); five typists' 60 characters
everywhere 807 ms after the typing; five frozen pages back with the missed
text in 824 ms; a reload, a 5 s signaling outage with a peer typing meanwhile,
a new peer after the restart - all as on the full mesh. A killed tab is gone
from every roster after 18.6 s (the full mesh: 17 s; Chrome's ICE timeout).

**100 browsers** (join, typing, vanish, reload, bandwidth): 6-27 links per
peer, five typists everywhere in 8 s, reload complete in 1 s, documents
identical - and two things the simulator had not shown:

9. **An idle room at 1 kB/s per browser.** Plumtree's IHAVE goes to every
   lazy link per message; batched into one DIGEST per tick that is one frame
   per LINK of the room per message (E, ~10x N-1) unless many messages share
   a frame - an idle room's beacons, one every 15 s, do not: 68 digests a
   second room-wide, 10 messages a second up and 15 down per browser.
   → a DIGEST names only what the link has not sent or told us, and each
   state goes to `digestFanout` (2) lazy links, not all: 72 → 20 frames a
   second in the simulator (browsers: not re-measured yet).
10. **A joiner missing from 8-12 rosters for good** (about every second
    run; with the first fix below: complete only after 170 s, the room's
    presence renewals). Its JOIN beacon (seq 1) went over its one open link
    into the forest of default feeds; its presence (seq 2) went out a moment
    later over more links. Half the room saw seq 2 first and took seq 1 for
    "before my time" - the rule that keeps a settled peer's history out of
    a joiner's way. → a joiner's first frames carry a flag (`G_FRESH`: sent
    within 3 s of its connect() - counted from when connect() resolved, not
    from before the wait for the first link, which ran into its 3 s timeout
    with 100 browsers on one machine; and not "its first four", a reloaded
    page sends seven in a second); a peer that first sees such a frame at
    seq > 1 asks the link that brought it for what is below, once, and keeps
    seq 1 wanted for the DIGESTs of its other links (each asked once per
    state). A DIGEST entry carries the flag as well, for the cache window
    (30 s - a DIGEST reaches a given link within ~links x the tick), so a
    peer that hears of a joiner from a DIGEST first asks for its frames, and
    of a settled peer does not. Three things that did not work first:
    "seq ≤ 4 means a joiner" without the flag (a settled peer that Trickle
    keeps quiet is at seq 3 for minutes, its seq 1 out of every cache - a
    GRAFT storm, 4x the frames); flooding a joiner's first frames over every
    link (E frames each, 4 per join, plus every idle peer's 4th frame - 6x);
    a full DIGEST to every new link (5x the idle traffic, and nothing gained:
    a joiner's roster comes from the JOIN's answers).
11. **Per-origin link states relative to a default** broke under a
    GRAFT-ALL crossing a PRUNE(X) on the wire: one end "cleared, so eager",
    the other "pruned, so lazy" - 5-7 such links per 100 peers, and a peer
    with one of them as its only feed got its keystrokes a second late.
    → the per-origin states are absolute; PRUNE-ALL and GRAFT-ALL move only
    the default for origins without one.
12. **The last feed pruned.** A straggler (seq below the front) whose first
    copy came over a lazy link made that link no feed, and its duplicate
    over the feed pruned the feed: one peer in 100 without a feed for the
    typist. → never prune the last link that is eager-in for an origin.
13. **A living peer dropped after a link cut** (1 in 100, now and then).
    Its ALIVE comes down its tree, which covers the peers that were there
    when it last sent; a peer that joined since has only default feeds and
    waited for a DIGEST (fanout 2: one in eight never got one before the
    3 s timeout). → a peer that suspects X and has no feed for X GRAFTs one
    at once; `suspectTimeoutMs` 6 s; the DIGEST tick 500 ms and the GRAFT
    delay 250 ms (the first keystroke after a silence reaches a peer outside
    the typist's tree this way: ~1 s, then it is in the tree - the gate
    allows 1.5 s for it).

14. **connect() resolved with no link** (its 3 s wait ran out - 100
    browsers on one machine take longer than that to open a link), and the
    core's JOIN, with the presence folded into it, went over nothing. The
    next frame anybody saw was the first periodic beacon, 5 s later and
    outside the fresh window: history. → what a peer sends before its first
    link is kept and goes over that link when it opens, and the fresh
    window starts there.

15. **A page back from a freeze suspected everybody.** Its mesh transport
    rebuilds every link under a new id; the wrapper saw 25 links close and
    said SUSPECT for each. The ALIVEs come down the suspects' trees, which
    the waker's brand-new links do not carry yet; whoever's did not arrive
    in 6 s was dropped, and a fellow sleeper (quiet, its beacons
    Trickle-suppressed) stayed out of three rosters for good - after 60 s
    the waker had even forgotten its origin, and a DIGEST naming it created
    it again as history. → a peer whose LAST link went suspects nobody (the
    core's rule for `_handlePeerLeave`, one layer down); a DIGEST with newer
    frames of a peer given up revives it; departed origins are kept for
    5 min, not 60 s.

After 10-15: the gate passes three seeds at N=100 and all five variants at
N=150 and N=300. Real browsers, headless Chrome: 25 through every scenario
(rosters complete 0.8 s after the last page, five frozen pages back in 0.8 s,
a reload complete in 0.9 s, a new peer after a signaling restart in 1.2 s);
100 through every scenario in one run (rosters complete 99 ms after the last
page, five typists' text everywhere in 7.6 s, a killed tab gone in 24 s, five
frozen pages back in 1.7 s, a reload complete in 2.5 s, a 5 s signaling
outage with text typed meanwhile everywhere 7 ms after, a new peer in 2.5 s,
documents identical, every roster 100), five join + reload runs before it
(rosters complete 0.05-1.4 s, a reload in 1.0-2.0 s), and the bandwidth
scenario: idle 5.8 kB/s per
peer on the wire (15 messages a second - the core's beacons at their 5 s
cadence after typing, each N-1 tree frames plus ~2N digests; STUN 1.1 kB/s),
a typist 30 kB/s up, a listener 19 kB/s up and 16 down while five people
type - the listeners carry the relay; a full mesh of 100 would put 80 kB/s
on each typist.

## Does the expected number of users help?

Not for correctness, and not where first assumed. The dial rule answers an
announce with probability ~ dial / room size - and that has to be the peers
that ARE there: with the expected 300 the first peers of a lecture hall would
answer each other with probability 5/300 and sit alone. What the estimate is
good for is the one decision that cannot wait for the room to fill: full mesh
or partial, and how many links. Without it the first 64 peers build a full
mesh (2,016 links) that has to be thinned out again - closed
`RTCPeerConnection`s count against Chrome's 500 per renderer. So
`expectedPeers` goes to the inner transport once, before it connects: up to 16
a full mesh as always, beyond that `dial = max(4, ln N)`. A wrong estimate
costs a small room a second hop or a large room links; neither breaks it.

The signaling channel gains more than the links: a peer stops announcing once
it has its links. 100 announces for 100 joins and none afterwards, where every
peer of a full mesh announces every 5 s to every peer - 18,000 signaling
messages a second at 300.

## What it costs

N = 100, `bench-partial-mesh` (20 ms per hop, 10 links per joiner / the dial
rule with ln N = 5):

| | full mesh | conference | 50 % leaves | dial rule | dial rule, 50 % leaves |
|---|---|---|---|---|---|
| links per peer | 99 | 10-39 | 2-58 | 9-30 | 5-45 |
| join: frames / KB | 33,838 / 1,156 | 57,944 / 2,243 | 51,180 / 1,922 | 63,382 / 2,348 | 54,218 / 1,993 |
| frames per keystroke | 132 | 157 | 191 | 148 | 149 |
| frames per broadcast / (N-1) | 1 | 1.15 | 1.10 | 1.14 | 1.09 |
| keystroke latency p50 / p95 / max | 21 / 25 / 27 ms | 39 / 68 / 94 | 25 / 63 / 94 | 46 / 101 / 138 | 39 / 83 / 136 |
| idle: frames per second | 0 | 101 | 50 | 109 | 54 |
| a cut link: frames | | 1,052 | 737 | 1,060 | 858 |

- **Idle** is the repair path: one digest per peer and second while the core
  sends anything at all (its own beacons do). One small frame a second against
  the STUN keep-alive of 10 links instead of 99.
- **A join costs about twice the full mesh's frames** (every peer answers a
  JOIN with a unicast that now crosses 3-4 links) - spread over the room, not
  on the joiner.
- **Against the full mesh's frames per keystroke:** 1.2x at 100 peers, 1.45x
  at 150, 1.7x at 300. The relay is the smaller part of it. The rest is the
  core: a listener's periodic beacon is suppressed by overhearing an equal
  one, and with paths of 1-5 hops fewer are equal in time - 91 beacons while
  one peer types 30 characters at N=300, 55 on the full mesh, each N-1 frames
  either way; and 42 unicast answers to beacons that were "behind" by a
  keystroke still on its way (2 on the full mesh). Both are tuning of
  `src/index.ts` for paths of different length, not done here.

## Open

- PeerJS as the inner transport: its coordinator holds a link to every peer,
  and its peer list would have to become a sample.
- Signaling over the overlay itself (Spray), for rooms where even one announce
  per joiner to everybody is too much.
- The core's beacons behind a relay (above).
- A real phone as a leaf; Firefox; TURN.

## Run

```
npx tsc -p tsconfig.bench.json
node bench-dist/test/dummy/bench-partial-mesh.js                 N=100, all variants, ~6 min
N=150 node bench-dist/test/dummy/bench-partial-mesh.js
N=300 node --max-old-space-size=8192 bench-dist/test/dummy/bench-partial-mesh.js     ~25 min
DIAG=1 TRACE_FILE=/tmp/trace.tsv PHASES=join ...                 a roster's holes and the frames around them
node bench-dist/test/providers/repro-simple-peer-sparse.js       the real simple-peer, loopback wrtc
N=25 node test/e2e/room-scenarios.mjs conference                 real browsers
```

## Round 13: the scenarios the transport had never been through (2026-09-22)

Round 11 shipped the wrapper on the standard scenarios (25 and 100 browsers). It had
never been through `linger`, `offline`, `storm`, a meaningful `oneway`, or Firefox.
All of them below on v1.9.5, 25 peers, local signaling, `DIAG=1`.

Three of them found nothing, and one of those is a measurement worth keeping:

| scenario | result |
|---|---|
| `offline` (one page loses its network for 20 s) | the returner has the text typed meanwhile after **24 ms**, its own text is everywhere after 474 ms, every roster whole 1,560 ms after `online`. The inner simple-peer's `watchNetworkChange` tears every link down and re-joins under a new inner id; the wrapper's own id survives, and the "our last link went, do not suspect the whole room" branch holds. The `G_FRESH` worry (a woken peer meets an origin at a high seq and takes it for history) did not materialise. |
| `storm` (10 typists 60 s, a presence storm, 3 x 100 KB, then `faults`) | **0 of 12,576 token x page pairs missing**, documents identical, rosters whole 3 ms after the fault phase. Typing lag p50/p95 **107 / 119 ms** - the same as the full mesh (simple-peer 108/120, peerjs 111/121), so the multi-hop tree costs the typist nothing. And it is the quietest transport measured: **2 frames/s** for the whole room while ten type, against 7 (simple-peer), 44 (websocket), 598 (gun). Cursor: all 119.2 presence changes per peer and second arrive, p50 34 ms. Bulk: 319-472 ms per 100 KB (simple-peer 241-248). |
| `oneway` | the scenario as written **tested nothing here**: it patched the data channels of a fixed pair (p2/p3) which on a partial mesh usually has no direct link at all, and the rename then travelled over the tree in 400 ms either way. The harness now picks a pair that actually holds a direct link (`window.__conference._byPeer`) and asks the sharp question - did the SENDING side notice the dead direction? It does: `❌ sendTo failed` -> `♻️ Link ... dropping it so the pair dials again`, as the rule demands. Whether the two then dial EACH OTHER again is not required of a partial mesh (the peer held 11 links after the drop and wanted no replacement), so that is recorded as a number, not a verdict. |

### Found: a reloaded page can stay in a roster for the whole lease

`SCENARIOS=join,linger LINGER_MS=420000 LINGER_GAP_MS=5000` (one page reloads every
5 s, rosters checked 5 s later): **48 of 81 checks held a roster that was too LONG** -
never one that was short. Up to three ghosts at once, and one of them was still there
420 s later. A 180 s run of the same thing is clean: it takes enough churn for routes
to die while somebody is leaving.

The ghost is the same name twice, the old clientID beside the new one:

```
p0 holds: [{"name":"p16","clientID":2887087969,"clock":7,"ageMs":87443,
            "address":"ef68771e7547",
            "origin":{"gone":false,"hw":-1,"route":"mud3e7bz","direct":false}}, ...]
```

Three things in that line, and they are the whole mechanism:

- **`hw: -1`** - p0's wrapper never saw a single frame from that origin. It knows it by
  hearsay, from a DIGEST (`_origin(id)` without a first seq, line 1023).
- **`direct: false`** - p0 never had a link to p16, so when p16 reloaded no link of p0's
  died, and `_scheduleSuspect` is reached **only** from `_linkDown` (line 559).
- **`gone: false`**, 87 s on. Everybody else's route to the departure ran through the one
  broadcast `C_SUSPECT`: whoever already has a `suspectTimer` stays silent by design, so
  exactly one peer sends it. p0 did not get it.

And the presence removal an unloading page sends is its **last** message: whoever knew
it only over a route that was dying at that moment misses it, and nobody ever repeats it.
The core then holds the entry for the full 300 s lease.

**The room sent 0 SUSPECTs in the whole 420 s run** (`stats.suspects`, summed over all 25
pages, new counters `linkDowns` / `suspectsScheduled` / `suspects`). A control run with a
killed tab shows the path does work - 21 links died, 6 suspects planned, 2 sent (the other
4 stayed silent because somebody else's arrived first, which is the design).

Not fixed in this round, on André's call: **measure first**. What has been measured:

| | ghosts |
|---|---|
| `bench-partial-mesh` N=100, 25 reloads 1 s apart, 6 s to settle | 0 |
| ... 250 ms apart, 6 s to settle | 6, with the browser's exact signature (`hw -1 gone false direct false`) |
| ... 250 ms apart, 20 s to settle | 0 |
| ... N=20, **60 reloads so every peer reloads three times**, 1 s apart | 0 |

So Node reproduces the **signature** but not the **permanence**: there the SUSPECT does
arrive, only late. The hypothesis that repeated reloads of the same page are what makes it
permanent is refuted. Whatever keeps it alive in a browser is not in the model yet.

#### The cause, measured to the end

Counters in the wrapper (`linkDowns`, `suspectsScheduled`, `suspects`, and one per reason a
planned suspicion was dropped) over the same 420 s browser run:

```
links died / SUSPECTs planned / SUSPECTs sent:  69 / 0 / 0
by reason: noPeer 0, relinked 0, lastLink 0, alreadyGone 69, NEVER-KNEW-IT 0,
           pending 0, othersFirst 0  -  departures learned from a C_LEAVE: 290
```

Read from the bottom up, that is the whole mechanism:

1. A page that reloads **says goodbye**: the playground's own `beforeunload` calls
   `provider.disconnect()` (`test/simple-peer/index.ts:606`), which broadcasts `C_LEAVE`.
2. That frame is a gossip frame **of the leaver**, so it travels the leaver's paths and
   reaches only whoever was listening on one that still worked - 290 departures learned over
   ~80 reloads, about **3.6 of 24 peers** each time.
3. Those few mark the origin `gone` and report it to their own core - **silently**.
4. A moment later the link dies. The suspicion that would have told the room is planned and
   dropped, because the peer already counts as gone: **69 of 69** (`alreadyGone`, and
   `NEVER-KNEW-IT 0` rules out the alternative, that the neighbour no longer knew it).
5. So nobody ever says it out loud. The peers that missed the goodbye also missed the
   leaver's presence removal - it took the same dying path - and nothing follows for them.

This refutes what the first measurement suggested. "Nobody declares a departure" was wrong:
**every neighbour does, 290 times over. It is simply never spoken aloud.**

#### Fixed: a goodbye that is heard is passed on in one's own voice

`_relayLeave`, called from the `C_LEAVE` handler before `_gone`: schedule a `C_SUSPECT` for
that origin with the same scatter and the same suppression a real suspicion uses, so one
neighbour speaks and not all of them. Our paths are not the leaver's, which is the entire
point. Two details:

- **No `_byPeer` check** before sending, unlike a suspicion. A goodbye is the peer's own
  word, not a guess - our link to it is about to close because it said so.
- The `C_SUSPECT` handler cancels our own pending relay when somebody else's arrives
  (`skipOthersFirst`), which is what keeps the cost at one broadcast per departure.

25 browsers, `linger` 420 s, a reload every 5 s, checked 5 s after each:

| | before | after |
|---|---|---|
| checks with a roster that was not 25 (of 81) | **48** | **5** |
| ... ghosts at once | up to 3, one for the whole run | one at a time |
| SUSPECTs sent by the room | **0** | 17 (of 300 goodbyes heard, 283 suppressed) |
| final: documents identical, rosters | yes, max 26 | yes, **25/25/25** |

And it is free where it matters - the relay answers an event that does not happen in a quiet
room:

| N=300, idle 300 s | frames/s of the whole room |
|---|---|
| untouched | 524 |
| with the relay | **533** |

Five checks still show a single ghost: the relay is a broadcast too and can miss somebody -
only far less often, because its sender is alive and its tree works. Regression: 35 of 35
`bench-*` gates and `repro-simple-peer-sparse` pass.

**Gate**: the "deaf to goodbye" phase - a peer disconnects properly while one observer, one
that holds no direct link to it, drops every C_LEAVE. 6.5 s before, 2.1 s after, with 6
relays for 35 goodbyes heard. (An attempt to sharpen it further by keeping the leaver's
links open, so that no dead link could trigger a suspicion, was dropped: with its links up
the leaver still counts as directly connected everywhere, which changes how frames spread.
The browser run is the measurement that decides here.)

#### Also tried: `idleSuspectMs` - suspecting what has gone quiet. Shipped off.

Before the cause was known, the same symptom was treated with a periodic sweep: suspect an
origin not heard from in `idleSuspectMs` that this peer holds no link to. It works - the
gate below proves an observer that misses every SUSPECT still lets a vanished peer go - and
it cost far too much, which is why it ships at **0**:

| idle room, 300 s, frames/s | N=40 | N=300 |
|---|---|---|
| off | 15 | **524** |
| 200 s | 32 | **19,611** |
| 90 s | 39 | - |

A living peer is far quieter than it looks - the core suppresses a periodic beacon whenever
it overhears an equal one, so 40 peers sent 47 broadcasts between them in 300 s - and a
false departure is not one frame: `_gone` reaches the core, the entry goes, the REVIVE
brings it back, the core resyncs. At N=300 the core's own sends went from 336 broadcasts /
234 unicasts to 3,347 / 43,025. Narrowing it to origins whose route had died does not work
either: the observer carrying the ghost reaches it over a link to a peer that is still
there.

It stays in the code with its gate ("deaf observer": a peer vanishes without a word and one
observer drops every C_SUSPECT - `NEVER` before, `<= 2.9 s` after), useful in a small room
that values a quick roster over frames, off above ~50 peers.

#### And one that cannot work: `C_LEAVE` from the unloading page

`Transport.leave` in `src/transport.ts`, a call in the core's `beforeunload`, a `leave()` on
the wrapper - built, gated, reverted. A control run says why: a deaf observer heard an
unloading peer's departure in 50 ms without it and 76 ms with it. `C_LEAVE` is a gossip
frame of the leaver and travels the path its presence removal travels; whoever misses one
misses both. Nothing the leaver says can reach them - which is exactly why the repair had to
be somebody else's voice.

### Found: a vanished peer takes 23-33 s to leave every roster

`suspectTimeoutMs` is 6 s, so a killed tab should be gone from everybody in ~6-7 s. It is
not: **23.0 s** with 25 Chrome peers, **32.7 s** with ten of them hidden Firefox tabs.
With Firefox in the room the counters read `108 links died / 92 suspects planned / 7 sent`.

### Firefox (`FIREFOX=10`, hidden tabs of one Firefox)

Nothing fails: rosters 25/25 throughout, documents identical, the five frozen Chrome pages
have the missed text 1,248 ms after the unfreeze and every roster is whole 1,254 ms after
it, and text typed during a 5 s signaling outage is everywhere 4 ms after it comes back.
The wrapper's own timers (digest 500 ms, graft 250 ms) survive Firefox's hidden-tab
clamping, which was 4-7 s here (round 9 saw up to 24 s in a busier room) - the peers
*behind* a hidden Firefox relay were the worry and they are fine.

What is slower than Chrome-only: a reload is in every roster after 4.9 s (0.97 s), a new
peer after a server restart after 6.2 s, the killed tab above. `editors identical: false`
with `documents identical (Y.Text): true` is the known Firefox `innerText` artefact of
round 9, not a finding.

### Harness and gate changes this round

- `room-scenarios.mjs`: DIAG dumps a partial mesh's holes at **any** size (it printed
  nothing for a roster short by one or two - the shape `linger` and `storm` produce);
  names **ghosts** (a roster longer than the room: the same name twice, with both
  clientIDs, clocks, ages, addresses, the wrapper's origin state and the room's SUSPECT
  count); reads a transport's id **live from the page** instead of the one `peerId:` line
  its constructor logged (a peer that slept or changed its network re-joined under a new
  one, so every table lookup after such a scenario was silently looking up nothing), and
  reaches through the wrapper to the inner transport's table; picks the `oneway` pair by
  an actual direct link.
- `bench-partial-mesh.ts`: two new departure phases, both at the very end of a variant (they
  change who is in the room, so nothing else may run after them - put before the kill phase
  they made it red, which is a property of the test order, not of the transport):
  - **unload** - the core's `beforeunload` in order (flush the pending update, remove the
    awareness state, `transport.flush()`), then the channels close.
  - **reload** - RELOADS pages go and come back under a new address, RELOAD_GAP_MS apart.
    Quiet at the default 1 s; `RELOAD_GAP_MS=250` is the storm.

  Both are **measurements, not verdicts** (`GATE_DEPARTURE=1` makes them fail the run): the
  numbers below are what the transport does today, and gating them would make this file red
  on every run and hide the regressions it does gate. Flip the switch when a fix lands.

  | N=100, 25 reloads | full | conference | leaves | dial | dialleaves |
  |---|---|---|---|---|---|
  | the removal has emptied every roster | 25 ms | ghost in 2/98 | 1,425 ms | 1,269 ms | ghost in 9/98 |
  | rosters too long after the reloads | - | 0/99 | 0/99 | 0/99 | 0/99 |

  The ghost under Node carries the browser's signature (`wrapper there hw -1, direct false`).
  What the spread says: the removal of an unloading page reaches a **leaf-heavy** room far
  too slowly - `leaves` and `dialleaves` are the rooms with phones in them.

  And a correction to the test bed itself: `MeshNet.deliver` tested the SENDER's connection
  at ARRIVAL, so every frame of a page that closed in the same task was silently dropped -
  which no browser does, and which made the first unload gate red for the wrong reason.

Regression after all of it: 35 of 35 `bench-*` gates pass (plus `bench-persist-log`, which
needs `fake-indexeddb`), and `repro-simple-peer-sparse` passes.
