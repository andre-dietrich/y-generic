# Sync Monitoring: Hash-Based Detection

## Overview

This document explains when and why to use hash-based sync detection alongside Yjs's built-in state vector synchronization.

## TL;DR

**Yjs's state vectors are better for sync** - but hashing is useful for **monitoring/alerting**.

## How Yjs Sync Works (Built-in)

Yjs uses **state vectors** to efficiently sync:

```typescript
// State vector = compact representation of what each client has seen
{ 
  clientID_1: 42,  // "I have updates 0-41 from client 1"
  clientID_2: 17,  // "I have updates 0-16 from client 2"
  clientID_3: 8    // "I have updates 0-7 from client 3"
}
```

### Advantages of State Vectors

✅ **Precise**: Tells you exactly what's missing, not just "something is wrong"  
✅ **Compact**: Just a few numbers per client (typically <100 bytes)  
✅ **Dual-purpose**: Used for both detecting AND resolving differences  
✅ **Efficient**: No need to hash large documents  
✅ **Incremental**: Works on updates, not full state

### How Sync Protocol Works

1. Client A sends state vector: `{ A: 42, B: 17 }`
2. Client B compares and sees it's missing updates 18-20 from itself
3. Client B sends those specific updates
4. Documents converge

**This is already optimal** - you don't need to improve it!

## When Hash-Based Detection Makes Sense

Use hashing as a **complementary monitoring tool** for:

### 1. **Detecting Silent Failures**

If there's a bug in the sync logic or corruption:

```typescript
const monitor = new SyncHealthMonitor(provider, {
  checkInterval: 5000,
  onDesync: (details) => {
    // Alert monitoring system
    console.error('Sync health check failed!', details)
    sendToErrorTracking(details)
    
    // Automatically trigger recovery
    provider.syncNow()
  }
})
```

### 2. **Production Health Monitoring**

Track sync health metrics:

```typescript
monitor.on('desync', (details) => {
  metrics.increment('sync.desync_detected')
  metrics.gauge('sync.peer_divergence', details.divergentClients.length)
})
```

### 3. **Debugging/Development**

Catch issues during testing:

```typescript
// In test environment
if (process.env.NODE_ENV === 'development') {
  const monitor = new SyncHealthMonitor(provider, {
    checkInterval: 2000, // Check frequently
    onDesync: () => {
      debugger // Stop and investigate
    }
  })
}
```

## Trade-offs

### Hash-Based Detection

**Pros:**
- Simple to understand
- Detects any divergence (including corruption)
- Good for monitoring/alerting

**Cons:**
- ❌ Only detects problems, doesn't fix them
- ❌ Requires bandwidth for periodic hash broadcasts
- ❌ Expensive for large documents (must hash entire state)
- ❌ Still needs state vector sync to actually fix issues
- ❌ False positives during active edits (race conditions)

### State Vector Sync (Yjs Built-in)

**Pros:**
- ✅ Detects AND resolves differences
- ✅ Compact (few KB even for large docs)
- ✅ Incremental (only sends what's needed)
- ✅ Fast (no hashing needed)
- ✅ Already implemented and battle-tested

**Cons:**
- None (it's optimal for CRDT sync)

## Implementation Example

See [sync-monitor.ts](./sync-monitor.ts) for a complete implementation.

### Basic Usage

```typescript
import { GenericProvider } from './GenericProvider'
import { SyncHealthMonitor } from './sync-monitor'

const provider = new GenericProvider(doc, transport)
await provider.connect({ room: 'my-room' })

// Optional: Add health monitoring
const monitor = new SyncHealthMonitor(provider, {
  checkInterval: 10000, // Check every 10 seconds
  onDesync: (details) => {
    console.warn('Documents diverged:', details)
    // Provider automatically calls syncNow() to recover
  }
})
monitor.start()
```

### How It Works

1. Every N seconds, each client computes hash of its document
2. Broadcasts hash via pub/sub to peers
3. Compares received hashes with its own
4. If mismatch detected → calls `syncNow()` to trigger state vector sync
5. State vector sync does the actual work of resolving differences

## Recommendations

### For Most Applications

**Don't use hash-based monitoring** - the built-in sync is sufficient:

```typescript
// This is enough:
const provider = new GenericProvider(doc, transport, {
  syncInterval: 5000 // Periodic state vector sync (default)
})
```

### For Production Systems with High Reliability Requirements

Add hash monitoring for **alerting only**:

```typescript
const provider = new GenericProvider(doc, transport, {
  syncInterval: 5000 // Keep periodic sync
})

// Add monitoring (doesn't replace sync!)
const monitor = new SyncHealthMonitor(provider, {
  checkInterval: 30000, // Check every 30s
  onDesync: (details) => {
    // Send to monitoring service
    Sentry.captureException(new Error('Sync divergence detected'), {
      extra: details
    })
  }
})
```

### For Unreliable Networks

Increase sync frequency instead of adding hashing:

```typescript
const provider = new GenericProvider(doc, transport, {
  syncInterval: 2000 // Sync more frequently (2s instead of 5s)
})
```

This is more efficient than periodic hashing because state vectors are much smaller than document hashes.

## Performance Considerations

### Hashing Cost

For a 1MB document:
- State vector: ~100 bytes
- Document hash: Must process entire 1MB + broadcast ~32 bytes

**Ratio: ~10,000x more efficient to use state vectors**

### Recommended Intervals

If you do use hash monitoring:
- **Development**: 5-10 seconds
- **Production**: 30-60 seconds
- **Never**: <5 seconds (too much overhead)

Compare to state vector sync:
- **Default**: 5 seconds
- **Unreliable networks**: 2 seconds
- **Stable networks**: 10 seconds

## Conclusion

**Use hash-based monitoring when:**
- You need reliability metrics/alerting
- You're debugging sync issues
- You want to detect corruption/bugs

**Don't use it to replace state vector sync** - Yjs's built-in mechanism is already optimal for CRDT synchronization.

The monitoring tool is in the test environment - try it by setting high packet loss (30%+) and watching for desync warnings in the activity log!
