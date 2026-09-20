# A link that delivers one way: a peer never gets anything from one other peer (note)

## Root cause (found 2026-09-20, simple-peer fixed; the rest of this note is the way there)

**Chrome. On the ANSWERING side of a link the `RTCDataChannel` object can stay at
`readyState: 'connecting'` after its own `open` event has fired** - minutes later
still - while `getStats()` calls the channel open and messages arrive on it.
`send()` checks the object's state and throws *"RTCDataChannel.readyState is not
'open'"* every time. Such a peer receives and can never send on that link.
Chrome 151 headless, a busy machine (50 contexts on 12 cores), about one 50-peer
join in six; cable only, no interface change during the run (`ip monitor`) - the
network theory below is refuted. The symptom has an entry in simple-peer's tracker
([#480][sp480], title only - not read), and Firefox 148 has a [report][ff148] of
`send()` failing right after `onopen`.

What the diagnosis printed for the pair (B = the answering side):

```
B's log:  ✅ Peer channel open (connect): A
          ❌ sendTo failed for A: Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'
          ❌ Send failed to A: ...        (again 5 s and 2 min 40 s later)
table entry B -> A: {"connected":true,"channel":"connecting","sp":{"initiator":false,"_connected":true,"_channelReady":true}}
connections A <-> B: 1
  A#23 connected/connected [open sent 2 rcvd 0] js 1:open  <->  B#41 connected/connected [open sent 0 rcvd 2] js 1:connecting
```

One connection, one channel; simple-peer's `_channelReady` is only ever set by the
channel's `onopen`; the JS object says `connecting`, the stats say `open`.

**What the library did wrong: it logged the exception and kept the entry.** The
first frame lost that way is the one that carries B's presence to the new link
(`_schedulePeerConnectSync`), and in an idle room B sends nothing else - so A never
learned B. Fixed in `SimplePeerTransport`: a send that throws on a connected entry
drops that entry (`dropUnsendable`) - the link is reported gone and announced, the
pair dials again. Gate: `test/providers/repro-simple-peer-sleep.ts`, part 7 (link
reported gone false -> true, re-announced false -> true, for `sendTo` and `send`).
Real browsers: before the transport fix 6 of 56 simple-peer joins (25-50 peers) left
a roster one short for good; after it the condition was hit in 4 of 9 joins and
every roster was complete within 69-255 ms in all 9.

**Still open:** Trystero showed the same picture (catch #4) and manages its
channels itself - its transport never sees the exception; a broadcast that rejects
does not say for whom. PeerJS (#3, the stale form) was not caught with the
diagnosis and not examined.

[sp480]: https://github.com/feross/simple-peer/issues/480
[ff148]: https://connect.mozilla.org/t5/discussions/firefox-148-datachannel-send-fails-with-invalidstateerror-after/td-p/119543

## Status (as first written)

**Not root-caused, not reproducible on demand - but narrowed down: it is a link
that delivers in ONE direction only, below the core** (catch #4). Seen four times on 2026-09-20
while running `test/e2e/room-scenarios.mjs` with 25-50 real browsers on the mesh
transports (round 9, see `2026-09-20-partial-mesh-relay-research.md`). Written
down so it can be picked up without that session. Nothing in `src/` was changed
for it.

**Impact.** One peer's roster lacks one other peer - or shows it without its name
- although their link is up and everybody else has it. In #1/#2 it outlasted the
180 s the harness waits. **If the link really delivers nothing from B to A (#4),
a renewal does not heal it either, and it is not only presence**: B's cursor never
shows at A, and B's keystrokes reach A only indirectly - A's next beacon finds it
behind a third peer and asks (seconds instead of milliseconds; up to 60 s with
idle backoff). NOT measured: in every run the text was typed by p0-p5, never by
an affected B, so "text everywhere in milliseconds" says nothing about this pair.

## What was seen

| # | transport, N | core | A | B | what A held for B | B elsewhere | healed |
|---|---|---|---|---|---|---|---|
| 1 | simple-peer, 50 | ed9ef27 | p37 | p36 | nothing | in 49 of 50 rosters | not in 180 s; still missing ~7 min later |
| 2 | simple-peer, 25 | ed9ef27 | p21 | p12 | nothing | in 24 of 25 rosters | not in 180 s |
| 3 | peerjs, 50 | d94be58 | p39 | p38, p42 | a STALE state: roster size 50, but both without the name the harness sets right after the join | named in the 49 others | seen at the end of the run, ~5 min after the join |
| 4 | trystero, 35 | d94be58 | p24 | p29 | **nothing at all - no state, no `meta` clock, no address** - while p29's own clock stood at 12 | in 34 of 35 rosters | not in 180 s |

**#4 is the one caught with the presence-clock diagnosis, and it settles what kind
of failure this is.** A has no `meta` entry and no address for B: not one frame of
B - no link-open beacon (it would have taught the address), none of the dozen
presence updates behind clock 12 - ever reached A's core. Yet both count the link
(34 links on all 35 peers), and the other direction works (B has A). A frame that
reached the core and failed its CRC would have warned and asked for a resync. So:
**B's sends do not arrive at A - a link that delivers one way - and that is below
the core**, in the transport or under it. It has now shown on all three mesh
transports, which share no code but the pattern "a map of peer id -> connection
object, `send()` iterates it".

Common to all: A had all its links (49 / 24), the miss is one-directional (B had
A), and the pairs had **joined within the same second** - in #2 A's log shows B's
announce arriving when A itself had 11 of 24 links.

A's transport log about B in #2: discovered via publish 20:37.017, role
initiator, offer 37.044, ICE connected 38.939, channel open 39.022, no close.
**That log does not rule out a second connection**: the diagnosis matched the full
peer id, and the transport's signaling lines carry its first 8 characters only -
an inbound offer from B would not have been printed (fixed since; it now also
prints B's log about A). In simple-peer roles are deterministic (`this.peerId >
msg.from` initiates), so glare is not expected there - but "signal from unknown
peer -> creating non-initiator connection" and "a fresh offer replaces a connected
entry" are paths that create a second object for the same id.

(Correction, same day: the counts in this paragraph were read too early - the
12th run of the 60 ms series DID show it, so there never was a "0 of 35 on the
fixed core", and the build made no difference. Over the whole day: 6 of 56.)

**Hunted afterwards, not caught again: 45 joins in a row without it.** simple-peer
on the fixed core: 0 of 35 (8 at N=50 with joins 200 ms apart; 12 at N=50 and 10
at N=30 with joins 60 ms apart, the last 21 with both rooms running at once,
1-minute load 16-29 on 12 cores) - against 2 of 5 on the old core. Trystero at
N=35, the setup of catch #4: 0 of 10. That is too lopsided for chance, and yet
the lease fix sends the same bytes at a join as the old code did - so the
difference is more likely in the CONDITIONS of those runs than in the build.
One candidate: **the test machine's network.** It is multi-homed (eth0 and WiFi
in the same subnet, so Chrome offers host candidates on both), and its WiFi went
down some minutes after catch #4 (10:12; by ~10:20 whole runs failed for lack of
an interface). A flapping interface under links whose candidate pair uses its
address would explain a link that is up on paper and dead in one direction -
and would make this a property of the test bed, not of the library. Not
verified: nobody watched the interface during #1-#3.

What would settle it: `ip monitor address` (or a 1 s `ip -br addr` log) running
next to the hunt, and the connection comparison below on the next catch.

## What is known about the mechanics

- On a mesh the joiner's JOIN beacon reaches nobody (no channel is open when
  `connect()` resolves); presence is exchanged **per link**: every link that
  opens gets one unicast frame `[digest beacon, own presence]`, debounced 50 ms
  over all links that opened meanwhile (`_schedulePeerConnectSync`). Later state
  changes (the name) are broadcasts to the links open at that moment.
- That frame carries a **bumped clock**, and only the new links get it. So what a
  peer holds for B is normally *behind* B's own clock - the diagnosis' self-test
  on a healthy 3-peer room printed `p0 itself: clock 4 - p1 holds: clock 3`.
- y-protocols applies an entry only if `held < clock` (or `held == clock`, the
  entry is a removal and a state exists). **An equal clock with a state is
  dropped**, and a removal for a client A has never seen still stores its clock
  in `awareness.meta` - a clock without a state.
- The core's veto against third-party removals needs an *address* for B, which A
  learns from B's first digest - i.e. not before B's link-open frame.

So a miss needs one of: B's frame never reached A's core; or A already held a
clock >= the one B's frame carried.

## Hypotheses - re-ranked after catch #4

**Refuted for #4: hypothesis 1** (A would hold a clock; it holds nothing) **and
4** (no state in the page either). What is left is 2 and 3, and of those 2 fits
best: a frame lost before a handler was wired (3) would cost the first frame, not
every later broadcast up to clock 12. So the prime suspect is **B sending on a
connection object A does not listen to** - two objects for one pair, each side
keeping a different one, B still *receiving* on the one it no longer sends on
(handlers stay attached to an object that left the map), and the dead one never
closing (Chrome parks a link whose other end is gone in ICE `disconnected`, round
8) so that nothing ever reports it. Next step: in a caught run compare, in both
pages, which connection object each side's map holds for the other
(`RTCPeerConnection` count per remote id - `window.__pcs` from the bandwidth
meter is already there - against the transport's `peers` map).

As first written (kept for the reasoning):

1. **A clock without a state, planted before B's own frame.** Some third peer X
   sends an awareness entry for B (a removal after X's link to B flapped during
   the join burst - X and A can be in the *same* 50 ms batch of B and then hold
   the *same* clock) while A has no address for B yet, so no veto; A stores the
   clock; B's link-open frame arrives with an equal clock and is dropped.
   -> A holds `clock` == B's clock at that time, `hasState: false`.
   Explains #1/#2. For #3 the same with the name broadcast instead of the frame.
2. **The link-open frame or the name broadcast was never sent to A.** Both
   transports' `sendTo`/`send` skip an entry that is not `connected` *silently*;
   if the entry under A's id was replaced between `onPeerConnect` and the debounce
   timer 50 ms later (simple-peer: "a fresh offer replaces a connected entry";
   peerjs: re-dial of a pair, claim handling) and the replacement's open does not
   fire `onPeerConnect` again, B never greets A. #2's clean log is A's side only.
   -> A holds **no `meta`** for B at all (or, #3, the old clock), and B's
   transport log about A shows two connection objects.
3. **The frame arrived before A's transport had wired the data handler** (PeerJS
   `DataConnection`: `open` on B's side can precede A's). -> as 2, single link.
4. Playground only (the roster is rendered on awareness `change`).
   -> `hasState: true` in the page although the DOM lacks it.

## How to catch it

`DIAG=1` prints, for a roster that lacks one or two peers on a mesh transport:
A's transport log about B **and B's about A**; through `window.__provider`, which
the simple-peer / peerjs / trystero playgrounds expose, B's own clock next to
`{clock, ageMs, hasState, user, address}` as A holds them; and - transport
independent - **the WebRTC connections between the two pages, paired by ICE
ufrag, with what each end's data channel sent and received**:

```
connections p1 <-> p0: 1 (of 2 / 2 RTCPeerConnections in the two pages)
  p1#0 connected/connected [open sent 3 rcvd 17]  <->  p0#0 connected/connected [open sent 17 rcvd 3]
```

(a healthy pair). Two lines = two connection objects for one pair; `sent 17` on
one side against `rcvd 0` on the other = lost below the transport; `sent 0` =
the transport never sends to that peer. `JOIN_GAP_MS` (200) sets the time between
two joins; smaller puts more pairs into the same second. It fires 10 s into the
join, so a hunt can stop there:

```
for run in 1 2 3 4 5 6 7 8; do
  N=50 DIAG=1 SCENARIOS=join PUPPETEER=... node test/e2e/room-scenarios.mjs simple-peer > hunt-$run.log 2>&1
  grep -q ' itself: ' hunt-$run.log && break
done
```

(~70 s per clean run; a machine under more load than 12 cores / 50 contexts
should hit it sooner - the join burst has to be slow enough for pairs to overlap.)
The stale form (#3) only shows where a diagnosis by NAME runs: `[diag final]`.

Once the mechanism is known it wants a fast gate under plain Node first, as usual:
two peers joining a settled `DummyHub` room (`simulatePeerConnect`, `unicast`)
inside one debounce window, with whatever interleaving the diagnosis names.
