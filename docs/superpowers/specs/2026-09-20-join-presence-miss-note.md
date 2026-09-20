# Open: a peer misses one presence update of a peer that joined in the same second (note)

## Status

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

Not seen in: 8 joins at N=50 on the fixed core (simple-peer: two full runs, six
join-only), 3 joins on the old core, 3 PeerJS joins (the "nothing" form). 2 of 5
on the old core against 0 of 8 on the fixed one looks like a cure, but the lease
fix touches renewals, not joins, and #3 is on the fixed core: read it as *rare*.

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
A's transport log about B **and B's about A**, and - through `window.__provider`,
which the simple-peer / peerjs / trystero playgrounds expose - B's own clock next
to `{clock, ageMs, hasState, user, address}` as A holds them. It fires 10 s into
the join, so a hunt can stop there:

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
