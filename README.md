# Generic Yjs Provider

A clean, minimal, backend-agnostic provider for Yjs that lets you implement any transport mechanism.

This is the edrys-Lite build, published as `@edryslabs/genericprovider`. It ships two
transports:

- **SimplePeer** (`@edryslabs/genericprovider/providers/simple-peer`) - WebRTC peer-to-peer
- **WebSocket** (`@edryslabs/genericprovider/providers/websocket`) - client-server (y-websocket compatible)

See [src/providers/README.md](src/providers/README.md). Run `npm run dev:simple-peer`,
`dev:websocket` or `dev:dummy` (in-memory, with simulated latency and loss) for local browser demos.

## Design Philosophy

**You implement**: How data is transmitted (WebSocket, WebRTC, PubNub, IndexedDB, etc.)  
**Provider handles**: All Yjs synchronization logic (updates, awareness, state vectors)

## Quick Start

### 1. Implement the Transport Interface

```typescript
import type { Transport, ConnectionConfig } from './transport'

class MyTransport implements Transport {
  private connection: any
  private messageCallback?: (data: Uint8Array) => void
  
  get isConnected(): boolean {
    return !!this.connection
  }

  async connect(config: ConnectionConfig): Promise<void> {
    // Connect to your backend
    this.connection = await connectToBackend(config.room)
    
    // Listen for incoming data
    this.connection.on('data', (data: Uint8Array) => {
      if (this.messageCallback) {
        this.messageCallback(data)
      }
    })
  }

  disconnect(): void {
    this.connection?.close()
    this.connection = null
  }

  send(data: Uint8Array): void {
    this.connection?.send(data)
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback
    return () => {
      this.messageCallback = undefined
    }
  }
}
```

### 2. Use the Provider

```typescript
import * as Y from 'yjs'
import { GenericProvider } from './GenericProvider'
import { MyTransport } from './MyTransport'

// Create Yjs document
const doc = new Y.Doc()

// Create your transport
const transport = new MyTransport()

// Create provider
const provider = new GenericProvider(doc, transport)

// Connect
await provider.connect({
  room: 'my-room-123',
  url: 'wss://myserver.com'
})

// Use Yjs as normal - everything syncs automatically!
const ytext = doc.getText('content')
ytext.insert(0, 'Hello World')

// Access awareness for presence/cursors
provider.awareness.setLocalStateField('user', {
  name: 'Alice',
  color: '#ff0000'
})

// Listen to events
provider.on('synced', (synced) => {
  console.log('Synced:', synced)
})

provider.on('status', (status) => {
  console.log('Status:', status.state)
})

// Cleanup
provider.disconnect()
provider.destroy()
```

## API Reference

### Transport Interface

The minimal interface your transport must implement:

```typescript
interface Transport {
  // Lifecycle
  connect(config: ConnectionConfig): Promise<void>
  disconnect(): void
  
  // Data transmission
  send(data: Uint8Array): void | Promise<void>
  onMessage(callback: (data: Uint8Array) => void): () => void
  
  // Status
  readonly isConnected: boolean
}
```

**That's it!** Just 4 methods + 1 property.

### GenericProvider Class

```typescript
class GenericProvider extends Observable<string> {
  // Properties
  readonly doc: Y.Doc
  readonly transport: Transport
  readonly awareness: Awareness
  readonly pubsub: PubSubChannel
  readonly status: ConnectionStatus
  readonly connected: boolean
  readonly synced: boolean

  // Methods
  constructor(doc: Y.Doc, transport: Transport, options?: {
    awareness?: Awareness
    syncInterval?: number     // Auto-sync interval in ms (default: 5000, set 0 to disable)
    batchUpdates?: number     // Batch/debounce updates in ms (default: 0 = disabled, recommended: 50-200)
  })
  
  connect(config: ConnectionConfig): Promise<void>
  disconnect(): void
  destroy(): void
  syncNow(): void  // Force immediate sync (useful after network interruptions)
  
  // Events (inherited from Observable)
  on(event: 'status', callback: (status: ConnectionStatus) => void): void
  on(event: 'synced', callback: (synced: boolean) => void): void
  off(event: string, callback: Function): void
  emit(event: string, args: any[]): void
}

class PubSubChannel extends Observable<string> {
  // Subscribe to a topic
  subscribe(topic: string, callback: (message: any) => void): () => void
  
  // Publish to a topic
  publish(topic: string, message: any): void
}
```

### Events

- **`status`**: Emitted when connection status changes
  - `{ state: 'disconnected' }`
  - `{ state: 'connecting' }`
  - `{ state: 'connected' }`
  - `{ state: 'error', error: Error }`

- **`synced`**: Emitted when initial sync completes
  - `true` when synced
  - `false` when connection lost

## Built-in Features

### ✅ Automatic Document Sync
All changes to the Yjs document are automatically sent through your transport.

### ✅ Awareness Protocol
Presence information (cursors, users online, etc.) is handled automatically.

### ✅ State Vector Sync
Efficient synchronization using Yjs state vectors - only missing data is transmitted.

### ✅ Loop Prevention
Transaction origins prevent infinite update loops.

### ✅ Reconnection Ready
Can disconnect and reconnect without recreating the provider.

### ✅ Pub/Sub Channel
Built-in topic-based messaging for real-time communication that doesn't need CRDT properties (chat, notifications, RPC calls, etc).

## Pub/Sub Channel

In addition to CRDT synchronization, the provider includes a pub/sub channel for real-time messaging:

```typescript
// Subscribe to a topic
const unsubscribe = provider.pubsub.subscribe('chat', (message: any) => {
  console.log('Chat message:', message)
})

// Publish to a topic
provider.pubsub.publish('chat', {
  user: 'Alice',
  text: 'Hello!',
  timestamp: Date.now()
})

// Subscribe to all topics (wildcard)
provider.pubsub.subscribe('*', (message: any) => {
  console.log('All messages:', message)
})

// Unsubscribe when done
unsubscribe()
```

### Use Cases for Pub/Sub

- **Chat Messages**: Ephemeral messages that don't need to be stored in CRDT
- **Notifications**: User joined, left, status changes
- **RPC Calls**: Request/response patterns between clients
- **Events**: Button clicks, interactions, temporary states
- **Presence**: Real-time updates that complement awareness

### Pub/Sub vs Awareness

- **Awareness**: For user presence data (cursors, names, colors) - maintained by Yjs
- **Pub/Sub**: For custom real-time messaging - you control the schema

### Example: Chat System

```typescript
// Setup
const doc = new Y.Doc()
const transport = new WebSocketTransport()
const provider = new GenericProvider(doc, transport)

await provider.connect({ room: 'chat-room' })

// Subscribe to chat
provider.pubsub.subscribe('chat', (msg) => {
  displayMessage(msg.user, msg.text)
})

// Send message
function sendMessage(text: string) {
  provider.pubsub.publish('chat', {
    user: getCurrentUser(),
    text: text,
    timestamp: Date.now()
  })
}

// The Yjs doc can still be used for persistent chat history if needed
const yhistory = doc.getArray('chatHistory')
```

## Example Implementations

See [src/providers/](src/providers/) for the WebSocket and SimplePeer transports, and the
in-memory `DummyTransport` used by the tests and benchmarks.

## How It Works

```
┌─────────────────────────────────────────────┐
│           Your Application                  │
│  (Uses Y.Doc, Y.Text, Y.Array, etc.)       │
└──────────────────┬──────────────────────────┘
                   │
                   │ Automatic sync
                   ▼
┌─────────────────────────────────────────────┐
│         GenericProvider                     │
│  • Listens to doc changes                  │
│  • Encodes updates with y-protocols        │
│  • Manages awareness                        │
│  • Handles sync protocol                    │
└──────────────────┬──────────────────────────┘
                   │
                   │ send(Uint8Array)
                   │ onMessage(callback)
                   ▼
┌─────────────────────────────────────────────┐
│         Your Transport                      │
│  • WebSocket.send()                         │
│  • PubNub.publish()                         │
│  • WebRTC.sendData()                        │
│  • IndexedDB.put()                          │
│  • etc.                                     │
└─────────────────────────────────────────────┘
```

## Advanced Usage

### Custom Awareness

```typescript
import { Awareness } from 'y-protocols/awareness'

const awareness = new Awareness(doc)
const provider = new GenericProvider(doc, transport, { awareness })
```

### Connection Configuration

Pass any config your transport needs:

```typescript
await provider.connect({
  room: 'my-room',
  url: 'wss://server.com',
  apiKey: 'secret-key',
  timeout: 5000,
  // ... any custom fields
})
```

### Async Transports

Your `send()` method can return a Promise:

```typescript
async send(data: Uint8Array): Promise<void> {
  await this.backend.publish(data)
}
```

### Error Handling

```typescript
provider.on('status', (status) => {
  if (status.state === 'error') {
    console.error('Connection error:', status.error)
    // Implement retry logic
  }
})
```

### Force Re-Sync

After network interruptions or when you suspect clients are out of sync, trigger an immediate sync:

```typescript
// Manual re-sync
provider.syncNow()

// Re-sync when network comes back online
window.addEventListener('online', () => {
  console.log('Network restored')
  provider.syncNow()
})

// Re-sync after connection issues
provider.on('status', (status) => {
  if (status.state === 'connected') {
    // Give transport a moment to stabilize
    setTimeout(() => provider.syncNow(), 100)
  }
})
```

**What `syncNow()` does:**
1. Sends the full local document state to all peers (ensures offline changes are transmitted)
2. Sends a sync request (SyncStep1) to get missing updates from others
3. Broadcasts the current awareness state

This is especially important after a client has been offline and made local changes, as it ensures those changes are sent to other clients when reconnecting.

### Automatic Periodic Sync

By default, the provider automatically calls `syncNow()` every 5 seconds to recover from packet loss or intermittent network issues:

```typescript
// Default behavior - auto-sync every 5 seconds
const provider = new GenericProvider(doc, transport)

// Faster recovery for unreliable networks
const provider = new GenericProvider(doc, transport, {
  syncInterval: 2000, // Retry every 2 seconds
})

// Disable automatic sync (not recommended)
const provider = new GenericProvider(doc, transport, {
  syncInterval: 0, // Manual sync only
})
```

**Why automatic sync is important:**
- Yjs requires multi-step handshakes (SyncStep1 → SyncStep2 → Updates)
- If any message is lost due to packet loss, sync stalls
- Periodic retries ensure eventual consistency even on unreliable networks
- Performance impact is minimal (only sends if there are changes)

For most production scenarios, the default 5-second interval provides good resilience without excessive traffic. For testing with simulated packet loss, use a shorter interval (e.g., 2 seconds).

### Update Batching (Debouncing)

By default, every document change triggers an immediate network transmission. For performance optimization, you can enable **update batching** (also called **debouncing**):

```typescript
// Default behavior - send updates immediately
const provider = new GenericProvider(doc, transport)

// Batch updates: collect changes and send after 100ms of inactivity
const provider = new GenericProvider(doc, transport, {
  batchUpdates: 100, // milliseconds
})
```

**How it works:**
1. User types "hello" (5 keystrokes)
2. Instead of 5 separate network messages, wait 100ms after last keystroke
3. Send **one combined update** containing all changes
4. Result: 1 message instead of 5

**Benefits:**
- ✅ **Reduces network traffic** by ~70-90% during rapid typing
- ✅ **Lower bandwidth usage** - fewer messages, less overhead per message
- ✅ **Better performance** on slow or metered networks
- ✅ **Still feels instant** - 50-200ms delay is imperceptible to users
- ✅ Yjs automatically merges sequential updates efficiently

**Recommended values:**
- `0` (default): Immediate transmission, no batching - best for slow networks or real-time cursors
- `50-100ms`: Good balance for most collaborative editing (typing, formatting)
- `200ms`: Maximum delay while still feeling responsive
- `500ms+`: Not recommended (users notice lag)

**When to use:**
- ✅ Collaborative text editing (typing)
- ✅ Drawing/whiteboard applications (mouse movements)
- ✅ Metered or slow networks
- ✅ Mobile/battery-conscious applications

**When NOT to use:**
- ❌ Real-time cursor tracking (needs immediate updates)
- ❌ Turn-based interactions (each change is discrete)
- ❌ Ultra-low latency requirements (<50ms)

**Example - Optimized collaborative editor:**
```typescript
const provider = new GenericProvider(doc, transport, {
  batchUpdates: 100,      // Batch updates for efficiency
  syncInterval: 5000,     // Periodic backup sync
})
```

### Recovering Lost Updates

Updates are sent as plain Yjs sync messages. Every message carries a CRC32 checksum; a
corrupted message is dropped and triggers a resync (one at a time, with exponential backoff:
100ms, 500ms, 2.5s, then 5s). Lost messages are recovered by the periodic sync
(`syncInterval`, default 5s), which asks peers for anything this client is missing.

Yjs updates are idempotent and commutative, so duplicates and out-of-order delivery need no
special handling.

> Up to 2.0.3, updates were sent with a document hash and sequence number (message type 3,
> options `verifyUpdates`, `gapGraceMs`, `seqWindowSize`, now removed). The hash differed
> between peers during ordinary concurrent editing, which triggered needless full-document
> resyncs. Type 3 messages from older peers are still accepted.

### Built-in Rate Limiting

The provider includes **automatic rate limiting** on sync requests to prevent spam and protect against malicious or buggy clients:

```typescript
// Default behavior - built-in rate limiting
const provider = new GenericProvider(doc, transport)
// Max 20 sync requests per 10-second window
```

**How it works:**
1. Tracks all sync requests (SyncStep1) sent within a 10-second sliding window
2. If more than 20 requests are attempted in that window, additional requests are dropped
3. Warning logged to console when rate limit is hit
4. Prevents "sync storm" scenarios where buggy code spams sync requests

**Protection against:**
- Buggy code with infinite retry loops
- Malicious clients attempting to flood the network
- Accidental DoS from misconfigured exponential backoff
- Network issues causing excessive retry attempts

**Why this is safe:**
- 20 requests per 10 seconds = 2 per second average (very generous)
- Normal operation uses far fewer requests (typically < 5 per 10 seconds)
- Combined with exponential backoff, prevents most abuse scenarios
- Doesn't affect normal document updates (only sync requests are limited)

The rate limiting is transparent and automatic - no configuration needed!

## Migration from Existing Providers

If you have existing providers (like your PubNub/P2PT implementations), wrap them:

```typescript
class PubNubTransportAdapter implements Transport {
  constructor(private oldProvider: OldPubNubSync) {}
  
  async connect(config) {
    return this.oldProvider.connect(config)
  }
  
  send(data: Uint8Array) {
    this.oldProvider.broadcast(true, data)
  }
  
  onMessage(callback) {
    this.oldProvider.onReceive = callback
    return () => { this.oldProvider.onReceive = undefined }
  }
  
  // ... etc
}
```

## License

Same as LiaScript (BSD-3-Clause)
