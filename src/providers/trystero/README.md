# Trystero Transport Provider

Serverless peer-to-peer transport using [Trystero](https://github.com/dmotz/trystero) with multiple decentralized strategies.

## Overview

Trystero enables **zero-server P2P connections** by using existing decentralized infrastructure (BitTorrent trackers, Nostr relays, MQTT brokers, etc.) **only for peer discovery**. All data is transmitted **directly peer-to-peer** and **end-to-end encrypted**.

### Key Features

- ✨ **Zero server setup** - No backend or signaling server required
- 🔒 **End-to-end encrypted** - All P2P data is encrypted
- 🌐 **Multiple strategies** - Nostr, BitTorrent, MQTT, Supabase, Firebase, IPFS
- 📦 **Automatic chunking** - Handles large data transfers
- 🎯 **Session encryption** - Optional password protection via AES-GCM
- 🔄 **TURN support** - Optional TURN servers for NAT traversal

### Available Strategies

| Strategy | Setup Required | Bundle Size (minified + Brotli) |
|----------|----------------|----------------------------------|
| 🐦 Nostr | None | 8KB |
| 🌊 BitTorrent | None | 5KB |
| 📡 MQTT | None | 75KB |
| ⚡️ Supabase | Account (~5 mins) | 28KB |
| 🔥 Firebase | Account (~5 mins) | 45KB |
| 🪐 IPFS | None | 119KB |

## Installation

```bash
npm install trystero
```

## Usage

### Basic Example (Nostr Strategy)

```typescript
import * as Y from 'yjs'
import { GenericProvider } from 'y-generic'
import { TrysteroTransport } from 'y-generic/providers/trystero'
import { joinRoom } from 'trystero/nostr'

// Create Yjs document
const doc = new Y.Doc()

// Create Trystero transport
const transport = new TrysteroTransport({
  joinRoom,
  appId: 'my-unique-app-id', // Must be the same for all collaborators
  debug: true
})

// Create provider
const provider = new GenericProvider(doc, transport)

// Connect to room
await provider.connect({ room: 'my-room-name' })
```

### With Password Protection

```typescript
const transport = new TrysteroTransport({
  joinRoom,
  appId: 'my-app-id',
  password: 'shared-secret-password', // All peers must use same password
  debug: true
})
```

### With Custom Nostr Relays

```typescript
const transport = new TrysteroTransport({
  joinRoom,
  appId: 'my-app-id',
  relayUrls: [
    'wss://relay.damus.io',
    'wss://relay.nostr.band',
    'wss://nos.lol',
    'wss://relay.snort.social'
  ],
  debug: true
})
```

### With TURN Servers (for NAT Traversal)

```typescript
const transport = new TrysteroTransport({
  joinRoom,
  appId: 'my-app-id',
  turnConfig: [
    {
      urls: 'turn:my-turn-server.com:3478',
      username: 'username',
      credential: 'password'
    }
  ],
  debug: true
})
```

### Different Strategies

```typescript
// BitTorrent
import { joinRoom } from 'trystero/torrent'

// MQTT
import { joinRoom } from 'trystero/mqtt'

// IPFS
import { joinRoom } from 'trystero/ipfs'

// Supabase (requires supabaseKey)
import { joinRoom } from 'trystero/supabase'
const transport = new TrysteroTransport({
  joinRoom,
  appId: 'https://your-project.supabase.co', // Your Supabase project URL
  supabaseKey: 'your-anon-public-key'
})

// Firebase (requires firebaseApp or appId as databaseURL)
import { joinRoom } from 'trystero/firebase'
const transport = new TrysteroTransport({
  joinRoom,
  appId: 'https://your-project.firebaseio.com' // Your Firebase databaseURL
})
```

## Configuration Options

### Required Options

- **`joinRoom`** - The Trystero `joinRoom` function imported from your chosen strategy
- **`appId`** - Unique app identifier (must match for all peers)
  - For Supabase: Use your project URL
  - For Firebase: Use your `databaseURL`

### Optional Options

- **`password`** `string` - Password for encrypting session descriptions (all peers must match)
- **`relayUrls`** `string[]` - Custom relay URLs (BitTorrent trackers, Nostr relays, MQTT brokers)
- **`relayRedundancy`** `number` - How many relays to connect to simultaneously
- **`rtcConfig`** `RTCConfiguration` - Custom WebRTC configuration
- **`turnConfig`** `RTCIceServer[]` - TURN server configuration for NAT traversal
- **`rtcPolyfill`** `any` - Custom RTCPeerConnection for server-side usage (Node/Deno/Bun)
- **`supabaseKey`** `string` - (Supabase only) Your project's anon public API key
- **`firebaseApp`** `any` - (Firebase only) Firebase app instance
- **`rootPath`** `string` - (Firebase only) Custom root path for matchmaking data
- **`manualRelayReconnection`** `boolean` - (Nostr/BitTorrent only) Disable automatic reconnection
- **`debug`** `boolean` - Enable debug logging (default: `false`)

## Additional Methods

The transport exposes some Trystero-specific methods:

```typescript
// Get connected peer IDs
const peers = transport.getPeers() // Returns Set<string>

// Ping a peer to measure latency
const latency = await transport.ping(peerId) // Returns milliseconds

// Handle join errors
transport.onJoinError((details) => {
  console.error('Join error:', details.error)
})
```

## How It Works

1. **Peer Discovery**: Trystero uses the chosen strategy (e.g., Nostr relays) to announce presence and discover other peers
2. **WebRTC Connection**: Once peers discover each other, they establish direct WebRTC data channels
3. **Data Transmission**: All Yjs updates and awareness data are sent **directly peer-to-peer** (never through relays)
4. **Encryption**: All P2P data is end-to-end encrypted; session descriptions are encrypted via AES-GCM

## NAT Traversal

If peers can't connect directly due to NAT restrictions, configure TURN servers:

```typescript
const transport = new TrysteroTransport({
  joinRoom,
  appId: 'my-app-id',
  turnConfig: [
    {
      urls: 'turn:turn.cloudflare.com:3478',
      username: 'cloudflare',
      credential: 'cloudflare'
    }
  ]
})
```

**Free TURN Services:**
- [Cloudflare Calls](https://developers.cloudflare.com/calls/turn/) - 1TB/month free
- [Open Relay](https://www.metered.ca/stun-turn) - Free tier available

**Self-hosted:**
- [coturn](https://github.com/coturn/coturn)
- [Pion TURN](https://github.com/pion/turn)
- [eturnal](https://github.com/processone/eturnal)

## Server-Side Usage (Node/Deno/Bun)

Trystero works server-side with a WebRTC polyfill:

```typescript
import { joinRoom } from 'trystero/nostr'
import { RTCPeerConnection } from 'node-datachannel/polyfill'

const transport = new TrysteroTransport({
  joinRoom,
  appId: 'my-app-id',
  rtcPolyfill: RTCPeerConnection
})
```

## Comparison with Other Providers

| Feature | Trystero | PeerJS | GunDB |
|---------|----------|---------|-------|
| Setup Required | None | None | None |
| Signaling | Decentralized | Cloud/Custom | P2P Graph DB |
| Backend | None | Optional | Optional relays |
| Strategies | 6 choices | 1 | 1 |
| Bundle Size | 5-119KB | ~28KB | ~180KB |
| NAT Traversal | TURN support | Built-in | Built-in |

## Choosing a Strategy

- **Nostr** (8KB) - Smallest bundle, growing relay network, censorship-resistant
- **BitTorrent** (5KB) - Smallest bundle, massive tracker network, battle-tested
- **MQTT** (75KB) - Many public brokers, IoT-friendly
- **Supabase** (28KB) - Managed, SLA, requires account (~5 min setup)
- **Firebase** (45KB) - Managed, SLA, requires account (~5 min setup)
- **IPFS** (119KB) - Largest bundle, content-addressed, future-proof

For most use cases, **Nostr** or **BitTorrent** are recommended for their small size and zero setup.

## Learn More

- [Trystero Documentation](https://github.com/dmotz/trystero)
- [Awesome Trystero Projects](https://github.com/jeremyckahn/awesome-trystero)
- [Trystero Demo](https://oxism.com/trystero)

## License

MIT
