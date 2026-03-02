# Transport Providers

This directory contains transport implementations for different backends.

## Available Transports

### Dummy Transport (Built-in, No Dependencies)

Perfect for testing and development without any network setup.

```typescript
import { GenericProvider } from 'y-generic'
import { DummyTransport } from 'y-generic/providers/dummy'

const transport = new DummyTransport()
const provider = new GenericProvider(doc, transport)
```

**Features:**
- ✅ No external dependencies
- ✅ Simulated network latency
- ✅ Simulated packet loss
- ✅ Multiple clients in-memory
- ✅ Perfect for unit tests

**Use cases:**
- Unit testing
- Integration testing
- Local development
- Learning how transports work
- Reference implementation

### SimplePeer Transport (Peer-to-Peer)

Direct peer-to-peer connections using WebRTC data channels via simple-peer library.

```bash
npm install simple-peer
```

```typescript
import { GenericProvider } from 'y-generic'
import { SimplePeerTransport } from 'y-generic/providers/simple-peer'
import Peer from 'simple-peer'

const transport = new SimplePeerTransport({
  peer: Peer, // Pass the simple-peer constructor
  signaling: ['wss://signaling.yjs.dev'],
  password: 'optional-encryption',
  maxConns: 30
})
const provider = new GenericProvider(doc, transport)
await provider.connect({ room: 'my-room' })
```

**Features:**
- ✅ Direct peer-to-peer (no server for data transfer)
- ✅ Mesh network topology
- ✅ Automatic peer discovery
- ✅ Optional encryption
- ✅ Resilient to peer disconnections
- ✅ Uses signaling server only for discovery

**Use cases:**
- Decentralized applications
- Reduced server costs (data doesn't go through server)
- Low-latency peer connections
- Privacy-focused applications

**Options:**
- `signaling`: Array of signaling server URLs (default: `['wss://signaling.yjs.dev']`)
- `password`: Optional encryption password
- `maxConns`: Max peer connections (default: 20-35 random)
- `peerOpts`: Options passed to simple-peer
- `debug`: Enable debug logging

### PeerJS Transport (Peer-to-Peer)

Direct peer-to-peer connections using WebRTC data channels via PeerJS library.
PeerJS provides a simpler API and built-in signaling infrastructure.

```bash
npm install peerjs
```

```typescript
import { GenericProvider } from 'y-generic'
import { PeerJSTransport } from 'y-generic/providers/peerjs'
import Peer from 'peerjs'

const transport = new PeerJSTransport({
  peer: Peer, // Pass the PeerJS constructor
  peerOptions: {
    host: 'your-server.com', // Optional: custom PeerJS server
    port: 9000,
    secure: true
  },
  password: 'optional-encryption',
  maxConns: 30
})
const provider = new GenericProvider(doc, transport)
await provider.connect({ room: 'my-room' })
```

**Features:**
- ✅ Direct peer-to-peer (no server for data transfer)
- ✅ Built-in signaling (PeerJS Cloud - free)
- ✅ Simple API (easier than simple-peer)
- ✅ Automatic peer ID management
- ✅ Optional encryption
- ✅ BroadcastChannel for same-browser tabs

**Use cases:**
- Quick prototyping (no signaling server setup needed)
- Decentralized applications
- Reduced server costs
- Simple peer-to-peer apps

**Options:**
- `peerOptions`: PeerJS server configuration (default: uses PeerJS Cloud)
- `password`: Optional encryption password
- `maxConns`: Max peer connections (default: 20-35 random)
- `debug`: Enable debug logging

## Coming Soon

### WebSocket Transport
```bash
npm install ws
```

```typescript
import { WebSocketTransport } from 'y-generic/providers/websocket'
```

### IndexedDB Transport
```bash
# No dependencies needed (browser-only)
```

```typescript
import { IndexedDBTransport } from 'y-generic/providers/indexeddb'
```

### PubNub Transport
```bash
npm install pubnub
```

```typescript
import { PubNubTransport } from 'y-generic/providers/pubnub'
```

### GunDB Transport
```bash
npm install gun
```

```typescript
import { GunDBTransport } from 'y-generic/providers/gundb'
```

## Creating a Custom Transport

All transports implement the simple `Transport` interface:

```typescript
interface Transport {
  connect(config: ConnectionConfig): Promise<void>
  disconnect(): void
  send(data: Uint8Array): void | Promise<void>
  onMessage(callback: (data: Uint8Array) => void): () => void
  readonly isConnected: boolean
}
```

See [dummy.ts](./dummy.ts) for a complete reference implementation.

## Package Structure

The project uses **optional peer dependencies** pattern:

- Core package has no transport dependencies
- Each transport is in its own file
- Users only install what they need
- Tree-shakeable - unused code is eliminated
- TypeScript types work automatically

### Import Pattern

```typescript
// Core provider (always installed)
import { GenericProvider } from 'y-generic'

// Specific transport (installed separately if needed)
import { WebSocketTransport } from 'y-generic/providers/websocket'

// Dummy transport (built-in, no install needed)
import { DummyTransport } from 'y-generic/providers/dummy'
```
