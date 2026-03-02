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
