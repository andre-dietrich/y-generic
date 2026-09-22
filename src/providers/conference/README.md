# Conference Transport (WebRTC rooms of 100+ peers)

A wrapper around a mesh transport for rooms that do not fit into a full WebRTC mesh: a
lecture hall, a conference, a classroom where most peers are phones. Pure peer-to-peer - the
only server is the signaling server the inner transport uses anyway.

```typescript
import Peer from 'simple-peer'
import { GenericProvider } from 'genericprovider'
import { SimplePeerTransport } from 'genericprovider/providers/simple-peer'
import { ConferenceTransport } from 'genericprovider/providers/conference'

const transport = new ConferenceTransport(
  new SimplePeerTransport({ peer: Peer, signaling: ['wss://your-signaling-server'] }),
  { expectedPeers: 300 },
)
const provider = new GenericProvider(doc, transport)
await provider.connect({ room: 'lecture-42' })
```

On a phone (or wherever the page may be suspended at any moment): `{ expectedPeers: 300, relay: false }`.

**All peers of a room must use this transport, in the same version** - it has a wire format
of its own. A peer on a bare `SimplePeerTransport` in the same room understands nothing.

## Why

`GenericProvider` needs a broadcast medium: what a peer sends reaches every peer of the
room, and what it receives comes from its author. A full mesh is one - at N-1
`RTCPeerConnection`s per browser. That holds up to about 50 browsers
(`docs/superpowers/specs/2026-09-20-partial-mesh-relay-research.md`): Chrome allows a
renderer 500 peer connections (closed ones included), every link costs ~80 bytes/s of STUN
keep-alive in each direction whether anybody types or not (57 MB per hour on a phone in a
100-peer room), a typist uploads every keystroke N-1 times.

Just capping the number of links does not work: today's core on a partial mesh ends with 0
of 100 rosters complete. Passing on whatever was received, the way y-webrtc does, works and
costs 27 times the frames.

## How

Every peer holds a handful of links (`dial`, see below). The wrapper passes frames on:

- **Broadcast - Plumtree, one tree per origin.** A link is *eager* or *lazy* for an origin,
  separately for each direction. A frame seen for the first time goes on over the links that
  are eager for its origin; a duplicate makes the receiver tell the sender to stop (`PRUNE`).
  What is left is a spanning tree: N-1 frames per broadcast, like the full mesh. The
  receiver alone decides who sends to it, and it prunes only over a duplicate - so it never
  gives up its last source.
- **Repair - digests.** Once a second a peer tells ONE of its links (in turn) how far it has
  heard each origin. A peer that lacks something asks for it (`GRAFT`); the answer comes out
  of a cache of the last 30 s. A link that closes is not waited for: what came over it is
  asked of every other neighbour at once.
- **Unicast** follows the way an origin's broadcasts came. A frame without a way, or one
  that comes back (it went in a circle), travels inside a broadcast of the peer that noticed:
  N-1 frames down its tree, and only the addressee unpacks it.
- **Who is there.** A closed link does not say that a peer is gone. The neighbour says
  `SUSPECT`, the suspect answers `ALIVE` (naming the `SUSPECT` it answers - the two run down
  different trees and may arrive in either order). No answer within `suspectTimeoutMs`:
  every wrapper reports `onPeerDisconnect` to its core, which is what a full mesh's closed
  channel does. A peer that was given up and is heard again is told so (`REVIVE`) and sends
  its presence again. A page that leaves says `LEAVE`.
- **`connect()` resolves with the first link** (or after `firstLinkTimeoutMs` in an empty
  room): the core's JOIN beacon - "send me your presence" - goes out when `connect()`
  resolves, and on a mesh no channel is open at that moment.

The core sees the *origin* of a frame as `from`: an id of the wrapper's own, stable while the
inner transport re-dials under a new peer id (a phone that slept).

## The inner transport

Anything with `sendTo`, `onPeerConnect` and `onPeerDisconnect`. **`SimplePeerTransport`**
knows the two optional hooks the wrapper calls:

- `configureSparse({ expectedPeers, passive })` - before `connect()`. Up to 16 expected peers
  it builds the full mesh it always built; beyond, a partial one with `dial = max(4, ln N)`
  links per joiner (the average peer ends up with about twice that, the oldest with more;
  `maxConns`, default 64, stays the hard cap). Or set the transport's own `dial` option.
- `setRoomSize(peers)` - how many peers the wrapper has heard. The dial rule
  (`src/providers/dial.ts`) answers an announce with probability ~ `dial` / room size, so a
  joiner's links go to peers picked at random from the whole room - a random graph, 3-4 hops
  across up to 400 peers - instead of to the last few that were still "open" (y-webrtc's
  rule builds a chain: 7 hops at 100 peers, 26 at 400). A peer stops announcing once it has
  its links: a settled room is silent on the signaling channel, where a full mesh of 300
  sends 18,000 signaling messages a second.

A transport without these hooks (PeerJS, Trystero) still works under the wrapper, as the full
mesh it builds - which helps with nothing but the typist's upload.

## Options

| option | default | |
|---|---|---|
| `expectedPeers` | - | A hint, handed to the inner transport. It has to be known up front: the first peers of a room cannot see how many will follow, and without it a lecture hall first builds a full mesh of its first 64 peers. Too large costs a small room a second hop, too small costs a large room links; neither breaks it. |
| `relay` | `true` | `false`: a leaf. It never passes on somebody else's frames, never dials a peer that announces itself, and no two leaves are linked. For phones and background tabs: iOS suspends WebRTC when the display locks, and a suspended tree node takes its subtree along until the repair path has healed it. A room needs enough relays to carry its leaves. |
| `feeds` | `1` | Links kept eager *by default*, for origins not heard yet. 1: the defaults form a tree, a new origin's first frame costs N-1 frames plus one duplicate per extra link of its own. |
| `digestIntervalMs` | `1000` | One digest per tick, to one lazy link in turn, naming only what that link has not sent or told us. |
| `digestFanout` | `2` | Lazy links each state is announced to. All of them (Plumtree's IHAVE) is one frame per link of the room per message; an idle room's beacons do not batch, and 100 browsers sent 1 kB/s each for five beacons a minute. A peer that missed a frame is told by one of its k neighbours with 1-(1-2/k)^k (87 % at k=15), by the origin's next state again, and the core's own beacons repair the document either way. |
| `graftDelayMs` | `400` | How long a frame a digest announced may still arrive by itself. |
| `suspectTimeoutMs` | `3000` | |
| `firstLinkTimeoutMs` | `3000` | How long the first peer of a room waits in `connect()`. |
| `expectedRttMs` | `250` | The core's round-trip estimate until it has measured one. |
| `cacheMs` / `cacheBytes` | `30000` / 4 MiB | Frames kept for `GRAFT` answers. |
| `mode` | `'tree'` | `'flood'`: every first-seen frame to every link - for measurements. |

## Numbers

`test/dummy/bench-partial-mesh.ts` - N `GenericProvider`s on the real wrapper over simulated
data channels (20 ms per hop), no oracle anywhere; it fails on an incomplete roster, a
keystroke later than 1 s, a ghost, a lost cursor or pub/sub message, a living peer dropped
after a link cut. `dial` / `dialleaves`: the links come from the real dial rule over a
simulated signaling channel.

| N = 100 | full mesh | conference | 50 % leaves | dial rule | dial rule, 50 % leaves |
|---|---|---|---|---|---|
| links per peer | 99 | 10-39 | 2-58 | 9-30 | 5-45 |
| complete rosters | 100 | 100 | 100 | 100 | 100 |
| frames per keystroke | 132 | 157 | 191 | 148 | 149 |
| frames per broadcast / (N-1) | 1 | 1.15 | 1.10 | 1.14 | 1.09 |
| keystroke latency p50 / p95 | 21 / 25 ms | 39 / 68 | 25 / 63 | 46 / 101 | 39 / 83 |
| a tree node killed while a peer types: keystrokes within 3 s | 100 % | 100 % | 100 % | 100 % | 100 % |
| killed peer gone from every roster | 4.0 s | 4.0 s | 4.0 s | 4.0 s | 4.0 s |
| signaling: announces for 100 joins / in 5 idle seconds | | | | 100 / 0 | 100 / 0 |

N = 150 and N = 300 pass the same checks (300: every roster complete, p95 101 ms, 1.2-1.3 x
(N-1) frames per broadcast). Against the full mesh's frames per keystroke the room costs
1.2x at 100 peers, 1.45x at 150 and 1.7x at 300 - the relay is the smaller part of that: the
core's periodic beacons are suppressed by overhearing an equal one, and with paths of 1-5
hops fewer are equal in time (91 beacons of the listeners while one peer types 30
characters, 55 on the full mesh; each is N-1 frames either way).

`test/providers/repro-simple-peer-sparse.ts` - the real `SimplePeerTransport` and the real
simple-peer library on a loopback `wrtc`: 40 peers with `dial: 4` are one graph at 4-20
links (mean 11, a full mesh: 39), 40 announces for 40 joins and none afterwards; 12 peers
joining in the same millisecond (glare) leave no half-open entry; leaves dial nobody and
never each other; a peer whose neighbours are all killed has links again.

## What it cannot do

- **The network.** A lecture hall is one WiFi. With client isolation (eduroam) no two
  browsers reach each other directly and every link needs TURN - `dial` links per peer of it.
- **Privacy between hops.** The inner transport encrypts per link; a relaying peer sees what
  it passes on, as every peer of the room does anyway.
- **Not measured yet:** a real phone as a leaf, Firefox, PeerJS as the inner transport (its
  coordinator would hold a link to every peer).

Real browsers (`test/e2e/room-scenarios.mjs conference`, headless Chrome): 25 through every
scenario (rosters complete 0.8 s after the last page, 3-14 links per peer, five frozen pages
back in 0.8 s, a reload complete in 0.9 s, a killed tab gone after 24 s - Chrome's ICE
timeout); 100 through five join + reload runs in a row (rosters complete 0.05-1.4 s after the
last page, a reload in 1-2 s), typing, a killed tab, five frozen pages and bandwidth (5-27
links per peer; a typist 30 kB/s up, a listener 19 kB/s up while five people type - the
listeners carry the relay). Details and what each rule was a failure of first:
`docs/superpowers/specs/2026-09-22-conference-transport.md`.
