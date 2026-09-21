# GunDB Transport Provider

Decentralized peer-to-peer transport for Yjs using [GunDB](https://gun.eco), a distributed graph database with automatic conflict resolution.

## Features

- 🌐 **Decentralized P2P**: Direct peer-to-peer connections without central server
- 🔄 **Offline-first**: Works offline, automatically syncs when connected
- ⚡ **Real-time sync**: Changes propagate instantly across all peers
- 🔗 **Graph database**: Built on Gun's distributed graph architecture
- 🛡️ **Conflict resolution**: Automatic CRDT-based conflict resolution
- 📡 **Relay support**: Optional relay servers for cross-device sync

## Installation

```bash
npm install gun
```

## Usage

### Basic Setup

```typescript
import * as Y from 'yjs'
import Gun from 'gun'
import { GenericProvider } from 'y-generic'
import { GunTransport } from 'y-generic/providers/gun'

// Create Yjs document
const doc = new Y.Doc()

// Create Gun transport
const transport = new GunTransport({
  gun: Gun, // Pass the Gun constructor
  peers: [], // Optional relay servers
})

// Create provider
const provider = new GenericProvider(doc, transport)

// Connect to room
await provider.connect({ room: 'my-room' })
```

### Local relay for tests

```
npm install --no-save gun
node node_modules/gun/examples/http.js 8767      # a relay from the same gun version, http://localhost:8767/gun
npx tsc -p tsconfig.bench.json
GUN_PEER=http://localhost:8767/gun node test/gun/live-relay.mjs   # or without GUN_PEER: the script starts its own relay
```

Three things decide whether a relay delivers live writes at all - each
measured 2026-09-07 with two Node peers; in every failing case the
subscriber receives what existed before it subscribed and nothing written
afterwards, with no error anywhere:

- **Reach it by an IPv4 address.** `localhost` resolves to the IPv6 `::1`
  on current systems, and over that loopback Gun's live writes are lost;
  `127.0.0.1` and the LAN address work. This also caught the transport's
  own tests until they used the LAN address.
- **No docker port mapping.** Behind `-p 8765:8765` (bridge + docker-proxy)
  live writes are lost too; `--network host` (Linux) or a relay run
  natively works. `test/gun/relay.sh` does the former.
- **One relay per LAN.** Every Gun relay multicasts on 233.255.255.255:8765
  and meshes with the others it finds (they also share peer lists); with
  two relays reachable, propagation became erratic. The script's relay
  runs with multicast and AXE off.

The `gundb/gun` docker image (2021, Gun 0.2020.520) was inconsistent in
these tests, but it was always behind port mapping and reached by
`localhost`, so its version is not established as a cause; pinning the
clients' 0.2020.1241 costs nothing.

`connect()` resolves only after the first relay has said `hi` (3 s
timeout for a local-only instance): a put made before the websocket is up
is stored by the relay but not pushed to peers already subscribed, and
GenericProvider sends its join batch the moment `connect()` resolves.

`test/gun/live-relay.mjs` runs two Node peers through the relay and
reports convergence, the idle cost of a minute (Gun has no leave signal,
so what remains are the presence renewals of the lease - the playground
uses 120 s - and the backed-off beacons), the cost of a reconnect (no
full-state push since round 5), and how long a silently departed peer
lingers (until the lease).

Presence lives in one Gun slot per connection under the room's
`awareness` node, and the relay keeps every slot ever written. A joiner
therefore receives all of them, but ignores any older than five minutes
(a live slot is rewritten every lease/2), and a clean `disconnect()`
nulls its own slot - so a joiner no longer inherits one phantom presence
per connection the room ever had (`test/dummy/bench-gun-awareness-replay.ts`).

### A local relay for a classroom (LAN)

Gun's own relay is one file in the package; it needs Node and nothing
else. On the teacher's machine (or any box in the room):

```
mkdir gun-relay && cd gun-relay
npm init -y && npm install gun            # the same 0.2020.x line as the clients (the CDN gun.js is the latest)
node node_modules/gun/examples/http.js 8765
```

It listens on every interface, answers websocket at `/gun`, restarts
itself after a crash (Node cluster), and stores what it relays in
`./radata/` - delete that folder for a clean slate. Clients use
`http://<LAN address>:8765/gun` (`hostname -I` or `ip addr` shows the
address; open the port in the firewall, e.g. `sudo ufw allow 8765/tcp`).
The scheme and the `/gun` path matter: Gun turns `http://` into `ws://`
itself and a bare `host:8765` never connects; the transport fills in
`http://` and `/gun` when they are missing (`https://` only if the relay
has a certificate). Use the IPv4 address, not `localhost` - see below.
`PORT=8765`, `PEERS=https://other-relay/gun` and `HTTPS_KEY`/`HTTPS_CERT`
are the environment knobs. A page served over **https** cannot open a
plain-http websocket (mixed content): serve the course over http on the
LAN as well, or give the relay a certificate through `HTTPS_KEY`/`HTTPS_CERT`.

The same with docker: the image `liascript/gundb` (built from
`Docker/gun/`: gun pinned to the clients' version, multicast and AXE off,
the container detects its LAN address itself and, with `MODE=https`,
generates a self-signed certificate for it on first start) - run it with
`test/gun/relay.sh` (Linux; `MODE=https`), or directly:

```
docker run -d --name gun-relay --network host -v gun-relay-data:/srv liascript/gundb
docker run -d --name gun-relay --network host -v gun-relay-data:/srv -e MODE=https liascript/gundb
docker logs gun-relay        # prints the address to enter
```

### With Relay Servers

For cross-device synchronization, name one or more relays - your own, or
a public one that works today (see [Public Gun Relays](#public-gun-relays):
most of the ones found in tutorials are gone):

```typescript
const transport = new GunTransport({
  gun: Gun,
  peers: ['https://gun.rig.airfaas.com/gun'],
  debug: true,
})
```

### With Quill Editor

```typescript
import Quill from 'quill'
import { QuillBinding } from 'y-quill'

const yText = doc.getText('content')
const quill = new Quill('#editor', { theme: 'snow' })

// Bind Quill to Yjs with awareness
const binding = new QuillBinding(yText, quill, provider.awareness)
```

## Configuration Options

```typescript
interface GunTransportOptions {
  gun: GunConstructor           // Gun constructor (required)
  peers?: string[]              // Relay server URLs (default: [])
  gunOptions?: {                // Gun configuration
    localStorage?: boolean      // Enable localStorage (default: true)
    radisk?: boolean            // Enable Radisk persistence (default: true)
    [key: string]: any
  }
  debug?: boolean               // Enable debug logging (default: false)
  batchInterval?: number        // Update batch interval in ms (default: 50)
}
```

## How It Works

1. **Initialization**: Creates a Gun instance and connects to relay peers (if specified)
2. **Room Navigation**: Accesses a Gun node: `gun.get('yjs-room-{roomName}')`
3. **Update Storage**: Yjs updates are encoded as base64 and stored in Gun's graph
4. **Real-time Sync**: Gun's `.on()` listens for updates and applies them to Yjs
5. **Batching**: Multiple updates are batched together to reduce network traffic
6. **Deduplication**: Prevents processing the same update multiple times

## Architecture

```
┌─────────────────┐
│  Yjs Document   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ GenericProvider │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────┐
│  GunTransport   │◄────►│   Gun Node   │
└─────────────────┘      └──────┬───────┘
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
              ┌─────────┐ ┌─────────┐ ┌─────────┐
              │ Browser │ │ Browser │ │  Relay  │
              │  Tab 1  │ │  Tab 2  │ │ Server  │
              └─────────┘ └─────────┘ └─────────┘
```

## Data Structure

Gun stores Yjs updates in a graph structure:

```javascript
gun
  .get('yjs-room-my-room')    // Room node
  .get('updates')              // Updates collection
  .get(updateId)               // Individual update
  .put({
    data: 'base64String',      // Yjs update (base64 encoded)
    timestamp: 1234567890,     // Creation timestamp
    size: 1024                 // Update size in bytes
  })
```

## Local vs Remote Sync

### Local Only (Same Device)
```typescript
// No relay peers = local P2P only (same browser tabs)
const transport = new GunTransport({
  gun: Gun,
  peers: [],
})
```

### Cross-Device (With Relays)
```typescript
// Add relay servers for cross-device sync
const transport = new GunTransport({
  gun: Gun,
  peers: ['https://gun.rig.airfaas.com/gun'],
})
```

## Performance Considerations

### Update Batching
Updates are batched to reduce network overhead:
- Multiple updates within 50ms are merged
- Reduces number of Gun writes
- Configurable via `batchInterval` option

### Deduplication
- Each update has a unique ID
- Processed updates are tracked (last 1000)
- Prevents infinite loops and duplicate processing

### Data Encoding
- Yjs updates are binary (Uint8Array)
- Converted to base64 for Gun storage
- Automatically decoded on receipt

## Comparison with Other Providers

| Feature | Gun | PeerJS | Simple-Peer | IndexedDB |
|---------|-----|--------|-------------|-----------|
| Decentralized | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No |
| Offline Support | ✅ Yes | ❌ No | ❌ No | ✅ Yes |
| Cross-Device | ✅ With relays | ✅ Yes | ✅ Yes | ❌ No |
| Persistence | ✅ Built-in | ❌ No | ❌ No | ✅ Yes |
| Setup Complexity | 🟢 Low | 🟡 Medium | 🔴 High | 🟢 Low |

## Known Limitations

1. **No built-in cleanup**: Old updates remain in Gun's graph
   - Consider implementing periodic cleanup
   - Or use short-lived rooms

2. **Large updates**: Base64 encoding increases size by ~33%
   - Gun handles this transparently
   - Consider compression for very large documents

3. **Relay dependency**: Cross-device sync requires relay servers
   - Use public relays or host your own
   - Local-only mode works without relays

4. **Gun gives up on a lost relay after one retry** (gun 0.2020.1241, browser
   websocket adapter: its `bye` handler deletes the peer that `reconnect()`
   then looks for). A relay down for more than ~2 s, or a page frozen for
   20 s, left the peer deaf and mute for good. The transport puts the relay
   back and dials again (3 s, doubling up to 30 s) and tells
   `GenericProvider` when it said hi again (`onPeerConnect`). 25 browsers
   (`test/e2e/room-scenarios.mjs gun`), relay down for 5 s: every roster at
   1 of 25 and different editors before; text typed during the outage
   everywhere 5.8 s after the relay was back now
   (`test/gun/repro-relay-restart.mjs`). And a page whose network is back
   - visible again, `online`, a change of `navigator.connection` - dials
   at once instead of sitting out that backoff (a phone with its display
   off loses the socket again and again, the wait at 12 s by the time it
   comes back): `test/gun/repro-page-back.mjs`, 1.0 s against 8.0 s.

5. **A reloaded page left a ghost for one presence lease** (124 s at the
   playground's 120 s lease, 128.5 s of 25 browsers in round 10). Three
   findings, each with a gate under plain Node that was red first
   (`test/gun/repro-unload-removal.mjs`: the real transport with gun's
   browser websocket adapter, a watcher at the relay, seven departures, a
   late joiner):
   - gun hands every write to its own turn queue, drained by a
     MessageChannel task - and a page that unloads runs no further task,
     so the presence removal of `beforeunload` never left the page (a
     removal sent and the process gone in the same tick: NEVER heard in
     8 s). The transport's `flush()`, which the provider calls from its
     unload handler, runs what gun queued in that same task: the removal
     is heard 5 ms before the process is gone, and so is the last typed
     batch (2 ms - it goes into one update node warmed at connect, a fresh
     node would cost a round trip the page does not have). Not covered:
     with a password the last batch is lost, its encryption is
     asynchronous; the removal itself is not encrypted and makes it.
   - `disconnect()` nulled the presence slot since round 7, and a
     playground's own beforeunload calls `provider.disconnect()` right
     after the provider's handler: gun's queue sent the null two tasks
     later, before pagehide, and erased the removal. Live peers had it;
     the reloaded page itself was replayed an empty slot, and a
     seconds-old presence table in another peer's slot put its old id
     back - it held its own ghost for a lease while every other roster
     was whole (127.9 s of 25 browsers). The slot keeps the removal now.
   - what the relay replays to a joiner is history, not presence: the
     slot of a tab killed two minutes earlier said "here", and the
     reloaded page listed it for a lease of its own (122 s). gun's
     callback tells an answer to the subscriber's own get (`@` set) from
     a live write (`test/gun/probe-replay.mjs`); replayed presence is
     dropped, a joiner's roster comes from the room's answer to its JOIN
     (0.4 s) - and gun re-emits the replayed slots a second time when
     the page writes its own, "converted from old format" with the
     original message under `VIA`, neither `#` nor `@` on the converted
     one: only a message with `#` and no `@`, looked through `VIA`, is a
     peer's live write. 25 browsers, reload: 529 ms.

6. **A joiner in a room whose peers were all gone got no document** from
   the relay (v1.8.8): the update listener loaded the node with `.once()`
   first and skipped every slot that arrived before that had called back -
   all of them, gun's `once` waits 99 ms - and the initial load itself saw
   links, not data. The same skip lost the first update of a fresh room to
   a peer that had subscribed a moment before it. One listener for
   everything now (`test/gun/repro-lone-joiner.mjs`: the lone joiner
   nothing -> all three updates).

7. **Gun's own protocol is chatty**: 25 browsers on one relay sent ~7,500
   WebSocket frames while joining and ~50 frames/s when idle (Ably or
   PubNub: 1-3 frames in 10 idle seconds) - acks and relayed gets, not
   this transport's messages.

## Public Gun Relays

Public relays are run by volunteers and come and go - test before a class
depends on one:

```
GUN=/path/to/node_modules/gun node test/gun/probe-relays.mjs                  # the volunteer list as it is now
GUN=... node test/gun/probe-relays.mjs https://host/gun                        # or relays of your choice
```

It runs Gun's browser adapter in three processes per relay: does the relay
say hi, does a write of one peer reach another (three times, with the
latency), does a late reader get the value. Accepting a socket is not
relaying.

Survey of 2026-09-20 - the 4 relays of
[volunteer.dht](https://github.com/amark/gun/wiki/volunteer.dht) (the list
the `gun-relays` and `shogun-relays` packages read) plus every relay that
page ever named, 40 in all:

| relay | hi | live writes | late reader |
|---|---|---|---|
| `https://gun.rig.airfaas.com/gun` | 0.2-0.4 s | 3 of 3, 30-47 ms | 0.2 s |
| `https://relay.peer.ooo/gun` | 0.4-0.6 s | **0 of 3** | nothing |
| the other 38, among them `gun.o8.is`, `gun.defucc.me`, `shogun-relay.scobrudot.dev` (on the current list) and every `*.herokuapp.com` | never - no WebSocket handshake at all | - | - |

So one public relay worked, and it is not on the current list.
`test/e2e/room-scenarios.mjs gun` with `LIVE=1` against it, 25 browsers:
rosters complete 1.7 s after the join, five typists' 60 characters everywhere
after 3.7 s, frozen pages have the missed text after 3.7 s, text typed during
a 5 s outage everywhere 6.9 s after it, editors identical. One volunteer's
server is a single point of failure: for a classroom, run your own (below,
or `test/gun/relay.sh`).

## Running Your Own Relay

```javascript
// server.js
const Gun = require('gun')
const express = require('express')
const app = express()

const server = app.listen(8765)
Gun({ web: server })

console.log('Gun relay running on port 8765')
```

## Testing

Run the test page:

```bash
npm run dev:gun
```

Open multiple browser tabs to test real-time synchronization!

## Resources

- [GunDB Documentation](https://gun.eco/docs/API)
- [Gun GitHub](https://github.com/amark/gun)
- [Yjs Documentation](https://docs.yjs.dev)

## License

ISC
