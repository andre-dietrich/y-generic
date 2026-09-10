# IndexedDB Provider

Local persistence transport for Yjs using browser's IndexedDB.

## Features

- 🔒 **Automatic Persistence** - Every document update is saved as it happens - and only document updates: the provider's presence, beacons and requests never reach the store
- 📦 **One Row per Load** - The stored updates are loaded as one merged update and written back as one row
- 🗜️ **Lossless Compaction** - Rows are merged, never dropped; on by default
- 🌐 **Offline First** - Works completely offline, no network required
- 🧹 **Cleanup Support** - Clear old updates or entire database
- 📊 **Statistics** - Monitor storage usage and update count

## Installation

```bash
npm install genericprovider yjs
```

## Basic Usage

```typescript
import * as Y from 'yjs'
import { GenericProvider } from 'y-generic'
import { IndexedDBTransport } from 'y-generic/providers/indexeddb'

// Create Yjs document
const doc = new Y.Doc()

// Create IndexedDB transport
const transport = new IndexedDBTransport()

// Create provider
const provider = new GenericProvider(doc, transport)

// Connect to database (loads existing data)
await provider.connect({ room: 'my-document' })

// Make changes - automatically persisted!
doc.getText('content').insert(0, 'Hello, World!')

// On next page load, data is automatically restored
```

## Configuration Options

```typescript
const transport = new IndexedDBTransport({
  // Database name prefix (default: 'yjs')
  prefix: 'myapp',
  
  // Database version (default: 1)
  version: 1,
  
  // Compact (merge every row into one) automatically (default: true)
  autoCompact: true,
  
  // ... when this many rows have accumulated (default: 0 = use maxUpdates)
  compactThreshold: 100,
  
  // Row count at which auto-compaction runs when compactThreshold is 0 (default: 500)
  maxUpdates: 500,
  
  // Enable debug logging (default: false)
  debug: true,
  
  // Object store name (default: 'updates')
  storeName: 'updates'
})
```

## Advanced Usage

### Manual Compaction

```typescript
// Merge every stored row into one (lossless)
await transport.compact()
```

### Clear All Data

```typescript
// Clear all updates for current room
await transport.clear()
```

### Get Statistics

```typescript
const stats = await transport.getStats()
console.log('Updates stored:', stats.updateCount)
console.log('Database:', stats.databaseName)
console.log('Store:', stats.storeName)
```

### Delete Database

```typescript
// Delete entire database (static method)
await IndexedDBTransport.deleteDatabase('my-document', 'yjs')
```

## How It Works

1. **Connection**: Opens IndexedDB database for the specified room
2. **Loading**: Merges every stored row into one update, hands it to the
   provider as one SyncStep2 (`synced` fires) and writes it back as one row
3. **Persistence**: Each frame the provider sends is reduced to the Yjs
   update it carries (`extractDocUpdates` from the core) and stored as one
   row; presence, beacons and requests carry none and are skipped
4. **Compaction**: Merges the rows into one when `maxUpdates` (or
   `compactThreshold`) rows have accumulated - lossless

Not for a provider with `compressionThresholdBytes` set: the frame parser
expects the plain CRC-wrapped frame, and this transport sets no
`preferredCompressMinBytes`.

## Storage Structure

Each update is stored as:
```typescript
{
  update: Uint8Array,  // One Yjs update
  timestamp: number,   // When it was stored
  raw: true            // Absent on rows written before round 7, which hold
                       // a whole provider frame; the loader reads both
}
```

The database uses two object stores:
- `updates`: Stores all document updates
- `metadata`: Stores compaction and sync info

## Use Cases

### 1. Offline-First Apps

```typescript
// Works perfectly offline
const doc = new Y.Doc()
const provider = new GenericProvider(
  doc,
  new IndexedDBTransport()
)
await provider.connect({ room: 'offline-doc' })

// All changes saved locally, no server needed
```

### 2. Combined with Network Sync

```typescript
// Use IndexedDB + WebRTC for persistence + sync
const doc = new Y.Doc()

// Local persistence
const localProvider = new GenericProvider(
  doc,
  new IndexedDBTransport()
)

// Network sync - let the local copy load before the first beacon says
// what we have (ConnectionConfig.waitFor), or the room answers with the
// whole document although it is already on disk
const networkProvider = new GenericProvider(
  doc,
  new PeerJSTransport({ peer: Peer })
)
await networkProvider.connect({ room: 'my-doc', waitFor: localProvider.connect({ room: 'my-doc' }) })

// Now you have both local persistence AND real-time sync!
```

### 3. Version Control

```typescript
// Store document versions
const versions: string[] = ['v1', 'v2', 'v3']

for (const version of versions) {
  const doc = new Y.Doc()
  const provider = new GenericProvider(
    doc,
    new IndexedDBTransport({ prefix: 'versions' })
  )
  await provider.connect({ room: version })
  
  // Each version stored separately
  doc.getText().insert(0, `Content for ${version}`)
}
```

## Browser Support

IndexedDB is supported in all modern browsers:
- ✅ Chrome/Edge 24+
- ✅ Firefox 16+
- ✅ Safari 10+
- ✅ Opera 15+

## Size Limits

Browser storage limits vary:
- **Chrome**: ~60% of free disk space
- **Firefox**: ~50% of free disk space
- **Safari**: 1GB (can request more)

Auto-compaction (on by default) keeps the log at one row per 500 updates;
a load trims it to one row.

## Best Practices

### 1. Tune Compaction

```typescript
const transport = new IndexedDBTransport({
  compactThreshold: 100  // Merge the rows into one every 100 updates instead of 500
})
```

### 2. Handle Connection Errors

```typescript
try {
  await provider.connect({ room: 'my-doc' })
} catch (error) {
  console.error('Failed to connect to IndexedDB:', error)
  // Fallback to in-memory only
}
```

### 3. Clean Up on Logout

```typescript
// Clear user's document on logout
await transport.clear()
await IndexedDBTransport.deleteDatabase('user-doc')
```

### 4. Monitor Storage

```typescript
const stats = await transport.getStats()
if (stats.updateCount > 1000) {
  console.warn('Large number of updates, consider compacting')
  await transport.compact()
}
```

## Testing

Run the test page:

```bash
npm run dev:indexeddb
```

This opens a test page where you can:
- Type content and see it persist
- Reload the page to verify restoration
- Compact the database
- Clear all data
- Monitor statistics

## Why IndexedDB?

- **Persistent**: Data survives page reloads and browser restarts
- **Fast**: Asynchronous API, doesn't block main thread
- **Large Storage**: Much larger limits than localStorage
- **Structured**: Can store complex data types efficiently
- **Transactional**: ACID guarantees for data integrity

## Limitations

- **Browser Only**: IndexedDB is not available in Node.js
- **Async API**: All operations are asynchronous
- **No Cross-Domain**: Data is scoped to origin
- **Quota Limits**: Browsers impose storage limits

## Troubleshooting

### Data Not Persisting

Check that the connection is successful:
```typescript
provider.on('status', (event) => {
  console.log('Status:', event.status)
})
```

### Storage Full

Compaction is automatic; to merge the rows right now:
```typescript
await transport.compact()
```

### Database Locked

Ensure only one connection per room:
```typescript
// Disconnect before reconnecting
await provider.disconnect()
await provider.connect({ room: 'my-doc' })
```

## Related

- [GenericProvider](../../README.md) - Core provider documentation
- [DummyTransport](../dummy/) - In-memory transport
- [PeerJSTransport](../peerjs/) - P2P network transport
- [SimplePeerTransport](../simple-peer/) - WebRTC transport
