# Transport Providers

This directory contains the transports used by edrys-Lite, plus an in-memory transport for
tests.

## SimplePeer Transport (Peer-to-Peer)

Direct peer-to-peer connections using WebRTC data channels via the simple-peer library.

```bash
npm install simple-peer
```

```typescript
import { GenericProvider } from '@edryslabs/genericprovider'
import { SimplePeerTransport } from '@edryslabs/genericprovider/providers/simple-peer'
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

**Options:**
- `signaling`: Array of signaling server URLs (default: `['wss://signaling.yjs.dev']`)
- `password`: Optional encryption password
- `maxConns`: Max peer connections (default: 20-35 random)
- `peerOpts`: Options passed to simple-peer
- `debug`: Enable debug logging

See [simple-peer/index.ts](./simple-peer/index.ts) for the full option list (signaling
retry, TURN fallback, control frames).

## WebSocket Transport (Client-Server)

See [websocket/README.md](./websocket/README.md).

## Dummy Transport (tests only)

[dummy/index.ts](./dummy/index.ts) is an in-memory transport with simulated latency and packet
loss, used by the unit tests and the benchmarks in `test/dummy/`. It is not exported from the
package.

## Creating a Custom Transport

All transports implement the `Transport` interface from [../transport.ts](../transport.ts):

```typescript
interface Transport {
  connect(config: ConnectionConfig): Promise<void>
  disconnect(): void
  send(data: Uint8Array): void | Promise<void>
  onMessage(callback: (data: Uint8Array) => void): () => void
  readonly isConnected: boolean
  // optional: onPeerConnect, onPeerDisconnect, sendTo, preferredBatchMs
}
```
