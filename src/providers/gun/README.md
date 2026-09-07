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

Use a relay of the current Gun version. The docker image `gundb/gun`
(built 2021, Gun 0.2020.520) works when freshly started, but after a few
client sessions it stops pushing live writes to new subscribers: they
receive what existed before they subscribed and nothing written after,
and a second read still shows the old value (measured 2026-09-07 with a
0.2020.520 and a 0.2020.1241 client alike; a relay from the installed
0.2020.1241 kept working through the same connect/disconnect churn). A
restart clears it until the next churn - in a classroom, that is every
page reload. Gun relays also share their peer lists, so a stale relay in
the mesh poisons every path through it.

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
`PORT=8765`, `PEERS=https://other-relay/gun` and `HTTPS_KEY`/`HTTPS_CERT`
are the environment knobs. A page served over **https** cannot open a
plain-http websocket (mixed content): serve the course over http on the
LAN as well, or give the relay a certificate through `HTTPS_KEY`/`HTTPS_CERT`.

The same with docker, pinned to the client's version (the `gundb/gun`
image is Gun 0.2020.520 and stops delivering live writes after a few
client sessions - see below):

```
docker run -d --name gun-relay -p 8765:8765 -v gun-data:/srv -w /srv node:22-alpine \
  sh -c "npm install gun@0.2020.1241 >/dev/null && node node_modules/gun/examples/http.js 8765"
```

### With Relay Servers

For cross-device synchronization, use public Gun relays:

```typescript
const transport = new GunTransport({
  gun: Gun,
  peers: [
    'https://gun-relay.herokuapp.com/gun',
    'https://gun-us.herokuapp.com/gun',
  ],
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
  peers: ['https://gun-relay.herokuapp.com/gun'],
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

## Public Gun Relays

```typescript
const PUBLIC_RELAYS = [
  'https://gun-relay.herokuapp.com/gun',
  'https://gun-us.herokuapp.com/gun',
  'https://gun-eu.herokuapp.com/gun',
]
```

> **Note**: Public relays may have rate limits or availability issues. For production, consider hosting your own Gun relay server.

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
