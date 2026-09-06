# Phase 1e: presence relay, one-round bootstrap, ranked reply delay, edit-only backoff reset — design

## Goal

Take the remaining peer-count-proportional terms off the join path and
the active-room beacon on *relay* transports (WebSocket, PubNub, Supabase,
Matrix, Nostr, Gun, Ably), where phase 1c's unicast path does not apply.
Builds on phases 1-1d; baseline = `main` @ `20d0541` (end of phase 1d).

## Context (measured on `20d0541`, probe `test/dummy/bench-join-census.ts`)

One late joiner into a settled room with content, relay mode, deliveries:

| profile | N | total | presence | SyncStep2 sends |
|---|---|---|---|---|
| WebSocket | 100 | 12,300 | 10,100 | 10 |
| Gun | 100 | 14,993 | 10,100 | 23 |

Presence is 82 % of a late join: every peer answers the JOIN with its own
state, coalesced per burst (phase 1b) but still N−1 broadcasts of N−1.

A concurrent join burst of N empty peers into an *empty* room, counted
until the room is quiet (not until "all synced", which is what
`bench-user-scaling` counted):

| N | at all-synced | until quiet | of which CONFIRM retries + their acks |
|---|---|---|---|
| 50 | 3,822 | 22,393 | ~10,200 |
| 100 | 19,206 | 91,971 | ~42,600 |

Nobody is SETTLED in a fresh room, so every peer's response wait runs its
three CONFIRM retries (1/2/4 s, on Matrix 2.8/5.6/11.2 s), each a beacon
to N−1 that draws acks. The retries exist for loss; here everyone answered.

Relay-mode reply suppression draws its delay uniformly from
`[0, 1.5 · RTT]`; with one-way latency L about N·L/W repliers fire before
the first reply is overheard — 10-23 SyncStep2 sends per request above,
and the 16-34k spread of the WebRTC join-burst cell in phase 1d's gates.

Idle backoff (on since 1d) resets on *any* activity, remote updates
included: while one peer types, all N beacon at the base interval,
N·(N−1) deliveries per 5 s against N−1 per keystroke.

## Design

### 1. One-round bootstrap in a fresh room

An equal ack or equal beacon from an *unsettled* peer sets
`_equalUnsettledSeen` (it does not end the wait — a settled peer with
content may still answer). When the wait expires with that flag set,
retry once (a CONFIRM, so a slow holder gets a second chance), and if the
retry's wait also expires with only unsettled-equal answers, become
confirmed: two rounds instead of three, and the first joiners' acks then
carry SETTLED for everyone after them. `_responseWaitAttempts >= 3` stays
the fallback when nobody answers at all. Expected: fresh-room CONFIRM
beacons from 3·N to ≤ 2·N... measured below (the burst's acks are deduped
by the equal-beacon rule, so the ack term shrinks more than linearly).

Rejected: confirming on the first unsettled-equal ack with no retry —
saves one more round but a JOIN lost only to the content holder (per-link
loss on a mesh) would then wait for that holder's backed-off beacon.

### 2. Ranked reply delay in relay mode

`_responderRank(requester)` — the rank count `_selectedResponder` already
computes (hash of requester, 2 s bucket and peer id over `_knownPeers`) —
becomes the reply delay: `min(rank, 8) · slot`, `slot = max(0.75 · minRTT,
syncReplySuppressionMs)`; ranks ≥ 8 add a random spread of one window on
top (an avalanche guard if the first eight are all gone). Rank 0 answers
at once; rank r fires only after it could have overheard rank r−1's reply.
Overhearing and cancelling stay as they are. With no RTT sample or no
requester id (legacy SyncStep1) the uniform window remains.
`_selectedResponder` = `_responderRank(requester) < 3`, unchanged.

### 3. Presence relay on JOIN (relay path only)

`_schedulePresenceResponse` keeps its timer. When it fires on the
broadcast path: if `_responderRank(0) === 0` for the current bucket (one
relayer per 2 s bucket, independent of the requester), send the whole
awareness table (`encodeAwarenessUpdate(awareness, all state keys)`) as
one broadcast; else, if an awareness message that carried *our* clientID
at our current clock arrived since the timer was armed (`_presenceCovered`,
set in the MESSAGE_AWARENESS branch by decoding the update's client list),
send nothing; else broadcast our own state as today. The relayer's timer
delay is 0 (same-tick coalescing only); everyone else keeps
`clamp(2 · minRTT, 100, 500)`, which is at least one one-way latency after
the relayer's send wherever an RTT estimate exists. y-websocket's server
relays presence exactly this way; clocks are preserved by the encoding, a
peer's own echoed state at an equal clock is ignored by
`applyAwarenessUpdate`. Bytes are unchanged (the table goes to everyone);
message count per late join drops from (N−1)² to about N. The unicast
path (one unicast per joiner) stays.

### 4. Idle backoff resets on local edits only

`_markActivity()` stays the re-arm point, but is called only from the doc
update handler for *local* edits (`origin !== this`) and from the
corruption branch (evidence we lost something). Remote updates and any
awareness change no longer reset a backed-off timer: a listener has
nothing a beacon would announce, and with design A of phase 1d the
typist's base-interval beacon heals any listener that lost the keystroke.
Also the phase-1d note: the re-arm fires at a random point inside the base
interval instead of a full one.

### Bench changes (Task 0)

- `test/dummy/bench-join-census.ts` (from the probe): (a) one late joiner
  into a settled room with content, (b) a fresh-room join burst counted
  until 3 s of quiet; deliveries per class, N ∈ {50, 100}, WebSocket and
  Gun profiles, `DUMMY_UNICAST` honoured.
- `bench-user-scaling` join burst counts until the room is quiet for 1 s
  (cap 15 s), like its fan-out has since phase 1b; `atConv` keeps the old
  number.

## Gates

Per item: `bench-join-census`, `bench-user-scaling` (join burst both
modes; fan-out fresh), `bench-join-after-burst` (both modes),
`bench-idle-room`, `bench-idle-backoff`, `bench-periodic-awareness`. Final
on the last commit: the phase-1d gate list ×1 in both modes
(`bench-sync-latency`, `bench-late-join`, `bench-packet-loss` default +
fresh, `bench-corruption-storm`, `bench-idle-room` LOSTDELETE); every
convergence gate must pass.

## Results

Appended per step as measured, baseline first.

### Baseline (`main` @ `20d0541` + the Task 0 benches; `bench-dist-base1e`; logs `base-*`, `basegate-*`)

`bench-join-census` (a) late join, relay: WebSocket N=50 3,200 / N=100
12,300 (presence 2,550 / 10,100; SyncStep2 sends 5 / 7); Gun N=50 3,746
/ N=100 13,697 (SyncStep2 sends 14 / 27). Unicast: 403 / 1,303 / 647 /
1,698 (3 SyncStep2 each). (b) fresh burst, relay: WebSocket N=50 21,707
/ N=100 **95,040** (beacon 13,475 = 300 sends / 54,450 = 600 sends; ack
2,156 / 15,939); Gun 28,028 / 112,860. Unicast: 19,188 / 75,992 / 20,480
/ 81,175. `bench-user-scaling` join burst N=100 (1 s quiet window, which
stops at the first retry gap): WebSocket 36,432, WebRTC 40,986, Gun
18,117, Matrix 17,226. `bench-join-after-burst` relay: WebSocket 4,412 /
4,314 (101 / 49 ms), Matrix 7,599 / 4,314 (676 / 645 ms); all PASS.
Baseline gates (relay and unicast): every `bench-late-join` and
`bench-packet-loss` cell 3/3, both corruption RESULT lines, idle-room
LOSTDELETE, sync-latency with 0 hash mismatches.

### After Task 1 — two-round bootstrap (`bench-dist-t1e1`; logs `t1e1-*`)

Fresh burst, relay: WebSocket N=50 21,707 → **16,758**, N=100 95,040 →
**69,003** (beacon 600 → 400 sends: 100 JOIN + 100 CONFIRM + the
periodic ticks of the window; ack 15,939 → 9,702); Gun N=50 28,028 →
14,994, N=100 112,860 → 70,290. Unicast: N=100 WebSocket 75,992 → 55,860,
Gun 81,175 → 60,763. Late join (a) unchanged within noise (relay N=100
WebSocket 12,300, Gun 13,794; unicast 1,603 / 1,597).
`bench-join-after-burst` relay: WebSocket 4,167 / 4,265 (65 / 63 ms),
Matrix 7,491 / 4,314 (564 / 599 ms), all PASS. `bench-user-scaling` join
burst N=100 within noise (37,620 / 40,392 / 18,612 / 18,315; its 1 s
quiet window ends before the retries either way — see Task 0 note below).

### After Task 2 — ranked reply delay (`bench-dist-t1e2`; logs `t1e2-*`), and the ack finding

SyncStep2 sends per late join, relay: WebSocket N=50 / 100: 5 / 7 → **1 /
1**; Gun 14 / 27 → **1 / 1** (Gun N=100 total 13,697 → 11,197; joiner
content at 822 ms, was 687 — rank 0's reply is immediate, but a rank-0
responder with pending structs stays silent and rank 1 answers one window
later). `bench-user-scaling` fan-out N=100, default regime: WebSocket
24,750 → 20,790, Gun 14,355 → 10,989; fresh 990 everywhere.

**Acks got worse.** Fresh burst Gun N=100 acks 6,039 → 15,147 sends 61 →
153; join-after-burst Matrix in-budget acks 147 → 686; `bench-user-scaling`
join burst N=100 Gun 18,612 → 29,799, Matrix 18,315 → 30,789. The ranked
delay put rank 0 at zero delay *per requester*: every JOIN in a burst drew
its own immediate ack, where the uniform window had let one pending ack
(identical bytes) answer every equal JOIN arriving inside it. Acks carry
no data, so their delay is free; commit `63ea9a9` keeps acks on the
uniform window and applies the ranked delay to SyncStep2 replies only.
The Task 2 numbers below are re-measured on that build (`bench-dist-t1e2b`,
logs `t1e2b-*`); Tasks 3 and 4 were re-snapshotted with the fix too.

### Task 2 re-measured with acks on the uniform window (`bench-dist-t1e2b`; logs `t1e2b-*`)

Late join, relay, SyncStep2 sends per join: WebSocket N=50 / 100 **1 / 1**
(baseline 5 / 7), Gun **1 / 1** (14 / 27); totals Gun N=50 3,746 → 3,096,
N=100 13,697 → 11,795; joiner content within one round trip as before
(WebSocket 48-53 ms, Gun 669-830 ms). Fresh burst, relay: WebSocket N=100
63,063 (Task 1: 69,003; acks 9,702 → 3,762), Gun N=100 69,597 (70,290;
acks 6,039 → 5,346) — the ack regression of the first Task 2 build is
gone. `bench-user-scaling` fan-out N=100 default regime: WebSocket 21,879,
WebRTC 21,384, Gun 14,553 (baseline 24,750 / 22,770 / 14,355); join burst
N=100 within noise of Task 1 (38,511 / 38,709 / 17,721 / 18,216).
`bench-join-after-burst` relay: WebSocket 4,118 / 4,118 (103 / 56 ms),
Matrix 6,766 / 3,481 (604 / 699 ms) — baseline 4,412 / 4,314, 7,599 /
4,314; unicast unchanged (1,854 / 1,835 / 4,102 / 1,394), all PASS.
Idle census N=50 24,745 (baseline 24,500), LOSTDELETE 5/5,
periodic-awareness 4/4, `bench-idle-backoff` recovery median 747 ms on /
221 ms off (baseline 727-770 / 122-204).

### After Task 4 — edit-only backoff reset, random re-arm (`bench-dist-t1e3`; logs `t1e3-*`)

`bench-idle-backoff` recovery of the update dropped before the room went
idle: median **546 ms** on (Task 2 build 747, baseline 727-770), 242 ms off
— the random re-arm point inside the base interval. Idle census N=50
24,892 (unchanged; the bench forces backoff off). Fan-out N=100 default
regime WebSocket 24,552, Gun 13,860 — noise around the Task 2 build.

**Price:** `bench-join-after-burst` Matrix converges in 1,503 / 1,669 ms
(Task 2 build 604 / 699; PASS limit 2,000). The joiner that is one
keystroke short is healed by a beacon from a peer ahead of it; before
this task every listener ticked at the base interval (remote updates
counted as activity), so such a beacon came within a fraction of the 2 s
bench interval; now only the typist's beacon is at the base interval,
and the straggler waits up to one interval plus grace. WebSocket 53 / 66
ms, unchanged. This is the design's stated trade (one base interval);
the final gates' loss cells say whether it holds under loss.

**Measurement note.** The join census of this build read 30,500 for the
Gun N=100 late join (baseline 13,697) and 10,400 for WebSocket
(12,300): not the join — the bench's quiet-based window stayed open at
Gun latency until the listeners' backed-off ticks (now at 15 s instead
of 20 s after connect) and the 15 s awareness renewals landed in it. The
bench now counts fixed windows with a 60 s beacon (commit `7207ee6`);
all five builds are re-measured with it below ("Census, fixed windows").

### After Task 3 — presence relay (`bench-dist-t1e4`; logs `t1e4-*`)

Late join, relay, WebSocket (the quiet-window census, which closes fast
on this profile and is therefore clean here): N=50 **250** deliveries
(baseline 3,200), N=100 **500** (12,300) — beacon 100, SyncStep2 100,
push 100, presence 200 = the joiner's own state and one relayed table;
`bench-periodic-awareness`: the joiner sees all 5 remote presence states
after 33 ms (baseline 134 ms), synced after 28 ms. Gun read 20,600 on the
quiet-window census for the reason given under Task 4 (renewals and
backed-off ticks inside the window: 102 awareness sends = 100 renewals +
joiner + table); see the fixed-window census below.
`bench-join-after-burst` relay: WebSocket 2,207 / 2,060 (baseline 4,412 /
4,314; presence 2,891 → 1,029 / 980), Matrix 4,904 / 2,814 (7,599 / 4,314;
presence 4,367 → 2,456, 2,846 → 1,033), all PASS (Matrix fresh 1,329 ms,
the Task 4 straggler price). `bench-user-scaling` join burst (everyone
joins at once, nobody has a table yet: the broadcast fallback by design)
N=100 WebSocket 37,026, WebRTC 46,134, Gun 19,008, Matrix 18,117 —
within the spread of the earlier builds. Fan-out N=100 default regime
21,780 / 21,087 / 14,355 / 990; idle census N=50 24,647; LOSTDELETE 5/5;
`bench-idle-backoff` recovery median 631 ms on. Unicast mode unchanged
(the unicast presence path is untouched).

### Census, fixed windows (`bench-dist-*c`; logs `census-*`) — every build, same bench

Relay mode, N=100, deliveries (SyncStep2 sends; presence deliveries):

| build | late join WebSocket | late join Gun | fresh burst WebSocket | fresh burst Gun |
|---|---|---|---|---|
| baseline `20d0541` | 11,600 (13; 10,100) | 13,400 (31; 10,100) | 80,487 | 75,735 |
| Task 1 two-round bootstrap | 11,400 (11) | 14,200 (39) | 54,054 | 50,193 |
| Task 2 ranked reply delay | 10,500 (2) | 10,400 (1) | 61,677 | 51,876 |
| Task 4 edit-only backoff | 10,400 (1) | 10,400 (1) | 54,846 | 49,995 |
| Task 3 presence relay | **500** (1; 200) | **500** (1; 200) | 53,856 | 50,886 |

N=50: late join 3,050 / 3,550 → 250 / 250; fresh burst 19,159 / 19,796 →
14,112 / 12,593. Unicast mode: late join 405 → 403 (N=100; 3-7 SyncStep2
unicasts), fresh burst 66,054 / 61,291 → 45,897 / 40,973. What remains of
a fresh N=100 burst on a relay: 100 JOIN + 100 CONFIRM beacons (14,850),
presence 299 sends (each peer's JOIN state, its presence response — no
table yet in a fresh room, by design — and its 15 s renewal inside the 20
s window), 100 pushes (4,950), and 45-124 acks; the joiner's content and
`synced` times are unchanged throughout (WebSocket ~50-100 ms, Gun
~650-800 ms). The Task 2 fresh-burst WebSocket figure (61,677, 124 ack
sends) against Task 1 (54,054, 47) and Task 4 (54,846, 55) is ack timing
noise in a burst — the ranked delay does not apply to acks.

### Final gates on the Task 3 build (`bench-dist-t1e4`; logs `t1e4gate-*`) — pass, with a storm

Every gate passes in both modes (late-join and packet-loss every cell
3/3, both corruption RESULT lines, LOSTDELETE, 0 hash mismatches in
sync-latency). But three loss cells carry outliers the baseline never
shows: `bench-packet-loss` fan-out N=50 at 5 % (relay): WebSocket
22,720 mean, 1,764-34,055 (baseline 1,764-2,156); Matrix 25,513,
4,116-36,505 (4,655-4,949); 10 % Matrix 16,987 (4,753-5,292);
`bench-late-join` Matrix 3 % M=40 K=10 during edits 15,894 mean, max
37,229 (6,693-7,037). Convergence stayed inside the gates (899 / 1,915
ms in those cells).

**Timeline** (probe `probe-fanout-loss`, N=50, WebSocket, 5 % loss, 25
samples on the Task 3 build; 4 storms): at t=700 ms all 50 peers send a
CONFIRM beacon in the same millisecond — the room's JOIN waits, armed
together at connect, expire together — and in the following 200 ms
~300 SyncStep2 and ~300 acks go out, with only 129 beacons in the whole
run and no rate-limit hit. Under loss some CONFIRMs find a peer equal
(→ ack) and some behind (→ SyncStep2); `_scheduleSyncReply` kept one
pending reply and *flushed it immediately* whenever a reply of the other
kind had to be scheduled (the rule phase 1c kept "for acks and legacy
SyncStep1s"), so an alternating stream of 49 requests became ~49
unsuppressed broadcasts per peer. The baseline was safe by timing: it
had converged (~480 ms) before the CONFIRMs arrived, so all 49 answers
were identical acks (deduped). Task 4 (listeners' beacons backed off →
stragglers heal later, 1.26 s in half the samples) and Task 2 (ranked
replies pending for whole windows) both made mixed answers at 700 ms
likely; the same storm appears on the Task 2 build alone (1 of 6
samples: 39,543; Matrix: 4 of 10 at 43-45k) and the Task 4 build (2 of
6, 10,878 and 37,779-41,846 on Matrix).

**Fix (commit `3e7ec5c`):** an ack and a SyncStep2 never flush each
other — an ack arriving while any reply is pending is dropped (the
requester's wait retries, or a SETTLED ack from an equal peer confirms
it), a SyncStep2 replaces a pending ack. Only a legacy plain SyncStep1
still flushes. Probe on that build: 25 WebSocket samples, 0 storms, mean
4,700 deliveries, median convergence 772 ms.

**What the flush had been hiding.** With the flush gone, Matrix 5 % loss
fan-out convergence (probe, 10 samples) went from 1.0-1.15 s (baseline,
10.0-11.5k deliveries) to a median of 2.2 s, worst 7.6 s (3.7-9.5k). The
per-item probe: Task 2 alone 1.0-2.4 s (plus storms), Task 4 build 1.0-2.2
s median 1.16 s, so the ranked delay is the cause — a rank-0 responder
with pending structs stays silent (phase 1d B, common while a lossy
burst reorders at 50 receivers) and rank 1 waits one full window (1.05 s
at Matrix); the immediate flushes had been answering in its place.

**Half a window per rank (commit `03d812e`).** Slot = max(30 ms, 0.75 ×
minimum RTT). Probe, Matrix 5 %: median 1.76 s (1.0-3.2 s), WebSocket
median 502 ms, 0 storms in 15; late join N=100 relay: 3 SyncStep2 sends
(full window 1, baseline 13-31), total 900 (500 / 11,600-13,400). The
trade this phase makes: ~30 replies → ~3 per request on a slow relay,
for +0.7 s median convergence in the 5 %-loss fan-out at Matrix latency.
The uniform window (`Math.random() * window` in `_replyDelay`) is the
revert if a deployment wants the other side of it. Final numbers below
are from this build (`bench-dist-t1e6`).

### Final build (`bench-dist-t1e6` = commit `03d812e`; logs `t1e6-*`, `t1e6gate-*`)

Baseline → final, relay mode unless stated:

| bench | cell | baseline | final |
|---|---|---|---|
| join-census late join (6 s window) | WebSocket N=50 / 100 | 3,050 / 11,600 | **350 / 800** |
| join-census late join | Gun N=50 / 100 | 3,550 / 13,400 | **350 / 800** |
| join-census late join, unicast | WebSocket / Gun N=100 | 405 / 405 | 405 / 403 |
| join-census fresh burst (20 s window) | WebSocket N=50 / 100 | 19,159 / 80,487 | 14,014 / 53,262 |
| join-census fresh burst | Gun N=50 / 100 | 19,796 / 75,735 | 12,495 / 52,173 |
| join-census fresh burst, unicast | WebSocket / Gun N=100 | 66,054 / 61,291 | 45,918 / 41,016 |
| join-after-burst | WebSocket in-budget / fresh | 4,412 (101 ms) / 4,314 (49) | 2,207 (83) / 2,305 (91) |
| join-after-burst | Matrix in-budget / fresh | 7,599 (676 ms) / 4,314 (645) | 5,198 (568) / 2,736 (**1,134**) |
| join-after-burst, unicast | WebSocket / Matrix in-budget | 1,853 / 4,106 | 1,849 / 4,093 |
| user-scaling join burst (1 s quiet) | N=100 WebSocket / WebRTC / Gun / Matrix | 36,432 / 40,986 / 18,117 / 17,226 | 36,729 / 45,045 / 19,305 / 17,919 |
| user-scaling fan-out, default regime | N=100 WebSocket / Gun | 24,750 / 14,355 | 21,087 / 14,454 |
| user-scaling fan-out, fresh | N=100 all | 990 | 990 |
| idle census (backoff forced off) | N=50 | 24,500 | 24,843 |
| idle-backoff recovery, median | on / off | 727-770 / 122-204 ms | 631 / ~240 ms |
| periodic-awareness joiner sees all presence | | 134 ms | 34 ms |

Late join at N=100: beacon 100, SyncStep2 200 (2 sends), push 100,
presence 400 (4 sends: the joiner, the relayed table, and two peers whose
window closed before the table reached them). The join-burst bench is
unchanged by design (a fresh room has no table to relay and its 1 s
window ends before the retries). The Matrix fresh-budget
join-after-burst at 1,134 ms is the Task 4 straggler price (one base
interval of the bench's 2 s beacon plus grace, was 645 ms).

**Final gates, both modes (`t1e6gate-*`): every gate passes** —
`bench-late-join` 32/32 cells 3/3, `bench-packet-loss` default and fresh
80/80 cells 3/3, both corruption RESULT lines (50 % cells converge),
LOSTDELETE 5/5, sync-latency with 0 hash mismatches; no storm cell
anywhere (packet-loss fan-out N=50 5 % relay max 1,666, Matrix 6,517;
late-join Matrix 3 % during edits 4,045-4,644 — the Task 3 build had
34,055 / 36,505 / 37,229 there). Baseline → final, relay:

| cell | baseline deliveries (ms) | final deliveries (ms) |
|---|---|---|
| packet-loss fan-out N=50, WebSocket 1 / 5 / 10 % | 1,013 / 1,895 / 2,107 (464-498) | 849 / 1,405 / 2,074 (473-631) |
| packet-loss fan-out N=50, Matrix 1 / 5 / 10 % | 2,907 / 4,802 / 5,080 (1,057-1,179) | 4,116 / 5,325 / 7,236 (**1,645 / 2,494 / 3,382**) |
| late-join during edits M=40 K=10, WebSocket 0 / 3 % | 5,361 / 4,822 (216-219) | 2,241 / 2,944 (252 / 476) |
| late-join during edits M=40 K=10, Matrix 0 / 3 % | 5,902 / 6,922 (1,707-1,719) | 4,592 / 4,278 (1,901 / 1,863) |
| unicast fan-out N=50, WebSocket 1 / 5 / 10 % | 1,553 / 2,620 / 3,253 (569-791) | 740 / 3,130 / 3,325 (466-937) |
| unicast fan-out N=50, Matrix 1 / 5 / 10 % | 3,207 / 4,460 / 5,771 (1,376-2,198) | 3,536 / 4,938 / 5,484 (1,484-2,006) |

The one cell class that got worse is the relay fan-out under heavy loss
at Matrix latency: 2-3x the convergence time and, at 10 %, more
deliveries (the slow recovery draws the 2 s beacons and the requester
retries). That is the ranked delay's silent-rank cost, half a window per
rank, on top of Task 4's straggler interval; on WebSocket-class latency
neither shows. A relay at 350 ms one-way that also drops 5-10 % of its
messages is a combination none of this project's transports actually
presents (HTTP relays lose nothing; WebRTC data channels are reliable
unless configured otherwise), which is why the ranked delay stays the
default; the uniform window is the one-line revert in `_replyDelay` for
a deployment on the other side of that trade.
