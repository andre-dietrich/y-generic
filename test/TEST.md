# Test Environment for Generic Provider

## Quick Start

Run the test environment with:

```bash
npm run dev
# or
npm test
```

This will start a development server and open `test.html` in your browser.

## What You'll See

The test page provides an interactive environment with:

### 📱 Multiple Clients
- **Alice** and **Bob** are created by default
- Each client has its own:
  - Yjs document
  - GenericProvider instance
  - Dummy transport (simulates network)
  - Independent UI

### ✨ Features to Test

1. **Real-time Sync**
   - Type in any client's textarea
   - Watch the text appear in all other clients instantly
   - All clients share the same Yjs document through the Dummy transport

2. **Awareness Protocol**
   - Each client shows "Users Online" with names and colors
   - Change a client's name or color
   - See the update in all other clients' awareness lists
   - Disconnect a client and watch them disappear from others' lists

3. **Add/Remove Clients**
   - Click "➕ Add Client" to create more test clients
   - Each new client immediately syncs with existing ones
   - Click "❌" button on any client to disconnect and remove them

4. **Per-Client Network Control**
   - Each client has its own "📡 Go Offline" / "🌐 Go Online" button
   - Shows individual network status: 🟢 Online or 🔴 Offline
   - Test scenarios where only some users lose connection
   - When coming back online, the client automatically re-syncs
   - Also: Global offline/online toggle affects all clients at once

5. **Connection Status**
   - Each client shows its connection status
   - "Synced" indicator shows when initial sync is complete
   - Visual feedback with color changes
   - **Global Offline/Online Toggle**: Simulate network problems for all clients

6. **Activity Log**
   - See all events in the log at the bottom
   - Timestamps for each action
   - Useful for debugging

7. **Pub/Sub Channel**
   - 💬 **Chat**: Send messages between clients using pub/sub
   - 📢 **Notifications**: See user activity notifications
   - Type a message and click "Send" or press Enter
   - Messages appear in all connected clients instantly
   - Notifications show when users change their profile

8. **Network Condition Simulation**
   - **Delay Slider**: Adjust network latency (0-500ms)
   - **Packet Loss Slider**: Simulate message loss (0-50%)
   - Test how Yjs handles unreliable networks
   - See if synchronization eventually succeeds despite adverse conditions

## How It Works

### Dummy Transport

The `Dummy` transport simulates network communication in-memory:

```typescript
class Dummy implements Transport {
  // All Dummy instances share a global registry
  // send() broadcasts to all other instances
  // Simulates real network behavior without actual networking
}
```

**Key Features:**
- ✅ In-memory communication (no network required)
- ✅ Simulates async delays (10ms)
- ✅ Perfect for testing sync logic
- ✅ Global and per-client offline simulation
- ✅ Multiple clients can connect/disconnect
- ✅ Acts like a pub/sub system
- ✅ Multiple clients can connect/disconnect
- ✅ Acts like a pub/sub system

### Test Clients

Each `TestClient` instance represents a separate user:

```typescript
class TestClient {
  doc: Y.Doc                    // Own Yjs document
  provider: GenericProvider     // Provider with Dummy transport
  ytext: Y.Text                 // Shared text type
  ui: ClientUI                  // Visual interface
}
```

All clients sync through the shared `dummies` registry, simulating multiple users editing the same document.

## Testing Scenarios

### Scenario 1: Basic Sync
1. Add 2 clients (Alice & Bob)
2. Type "Hello" in Alice's textarea
3. ✅ See "Hello" appear in Bob's textarea

### Scenario 2: Concurrent Edits
1. Add 3+ clients
2. Type in multiple textareas simultaneously
3. ✅ All changes merge correctly

### Scenario 3: Awareness
1. Add 2 clients
2. Change Alice's name to "Alice Smith"
3. ✅ Bob sees "Alice Smith" in his "Users Online" list

### Scenario 4: Disconnect/Reconnect
1. Add 3 clients
2. Disconnect one client
3. ✅ Other clients remove them from awareness
4. ✅ Disconnected client shows status change

### Scenario 5: Late Join
1. Add 2 clients and type some text
2. Add a 3rd client
3. ✅ New client immediately receives existing content

### Scenario 6: Pub/Sub Chat
1. Add 2+ clients
2. Type a message in Alice's chat input and press Enter
3. ✅ Message appears in all clients' chat windows
4. ✅ Alice's messages have a blue background (own messages)
5. ✅ Other clients see the message with normal background

### Scenario 7: Pub/Sub Notifications
1. Add 2 clients
2. Change Alice's name
3. ✅ Notification appears in all clients: "Alice updated their profile"
4. ✅ Notifications are timestamped and limited to last 10

### Scenario 8: Pub/Sub vs CRDT
- **Chat messages** use pub/sub → ephemeral, not persisted
- **Document text** uses Yjs CRDT → persistent, synchronized
- Late joiners get document text but not old chat messages
- This demonstrates when to use each mechanism

### Scenario 9: Network Interruption (Offline/Online)

**Global Network Toggle:**
1. Add 2+ clients and sync some text
2. Click **"Go Offline"** button in the header
3. ✅ Network status shows "🔴 Offline"
4. Type different text in each client - changes are local only
5. ✅ No synchronization happens while offline
6. ✅ Each client shows their own local changes
7. Click **"Go Online"** button in the header
8. ✅ Network status shows "🟢 Online"
9. ✅ Activity log shows "🔄 Triggered re-sync for all clients"
10. ✅ Within ~100ms, all clients synchronize using Yjs CRDT merge
11. ✅ Concurrent edits are automatically resolved by Yjs
12. ✅ All clients converge to the same final state

**Per-Client Network Toggle:**
1. Add 3 clients (Alice, Bob, Charlie)
2. All clients type some text and sync
3. Click **"📡 Go Offline"** button on Alice's client only
4. ✅ Alice's status shows "🔴 Offline"
5. ✅ Bob and Charlie still show "🟢 Online" and can sync with each other
6. Type in Bob's textarea - change syncs to Charlie but not to Alice
7. Type in Alice's textarea - change stays local
8. Click **"🌐 Go Online"** button on Alice's client
9. ✅ Activity log shows "🔄 Alice re-syncing after coming online"
10. ✅ Alice receives all updates from Bob and Charlie
11. ✅ Bob and Charlie receive Alice's offline changes
12. ✅ All three clients are now in sync

**How it works**: When going online, `syncNow()` is called on the provider, which:
- Encodes and sends the full local document state (including offline changes)
- Sends a SyncStep1 message (state vector request) to get updates from peers
- Broadcasts the current awareness state
- Peers respond with their missing updates
- Yjs CRDTs automatically merge concurrent changes, resolving conflicts

**Why this is important**: When a client is offline and makes changes, those changes exist in the local Yjs document but haven't been transmitted. Simply requesting updates from others (SyncStep1) isn't enough—we also need to push our local changes to them. The `syncNow()` method now handles both directions of sync.

**Network Simulation Modes**:
- **Global toggle**: Simulates complete network outage affecting all clients at once
- **Per-client toggle**: Simulates individual client connectivity issues (more realistic)
- Both modes test the same sync recovery mechanism but with different scopes

### Scenario 10: Network Conditions (Delay & Packet Loss)

**Testing Delayed Messages:**
1. Add 2+ clients and ensure they're synced
2. Adjust **Delay slider** to 200ms
3. ✅ Activity log shows "⏱️ Network delay set to 200ms"
4. Type in any client's textarea
5. ✅ Changes appear in other clients with ~200ms delay
6. ✅ Despite the delay, all changes eventually sync correctly
7. Try concurrent edits in multiple clients during the delay
8. ✅ Yjs CRDTs handle out-of-order messages and merge correctly

**Testing Packet Loss:**
1. Add 2+ clients and ensure they're synced
2. Adjust **Packet Loss slider** to 1-5%
3. ✅ Activity log shows "📉 Packet loss set to X%"
4. Type in any client's textarea
5. ⚠️ Some sync messages may be dropped
6. ✅ **Automatic recovery**: Provider retries sync every 2 seconds
7. ✅ All clients converge within a few seconds despite packet loss
8. Try higher packet loss (20-30%) to test resilience limits

**How Automatic Recovery Works:**
- The provider calls `syncNow()` every 2 seconds (configurable via `syncInterval` option)
- This retries the Yjs handshake (SyncStep1 → SyncStep2) automatically
- Even with 1% packet loss, retries ensure eventual consistency
- No manual intervention needed - just wait a few seconds

**Understanding Resilience:**
- **Delayed messages**: ✅ Yjs handles these perfectly with its state vector protocol
- **Lost messages**: ✅ Automatic periodic sync retries handle this (default: every 5 seconds, test env: 2 seconds)
- **Why retries are needed**: Yjs sync requires multi-step handshakes; if any message is lost, sync stalls until retry

**Configuration Options:**
```typescript
// Default: auto-sync every 5 seconds (good for most production use)
const provider = new GenericProvider(doc, transport)

// Faster recovery for unreliable networks (like this test environment)
const provider = new GenericProvider(doc, transport, { syncInterval: 2000 })

// Disable automatic sync (requires manual syncNow() calls)
const provider = new GenericProvider(doc, transport, { syncInterval: 0 })
```

**Best Practices for Production:**
- Keep the default 5-second sync interval (already enabled)
- Use reliable transports when possible (WebSocket with auto-reconnection)
- Call `syncNow()` manually when the network reconnects after an outage
- Monitor awareness to detect if users seem out of sync

## Code Structure

```
test.html           → HTML UI and styles
test.ts             → Test logic and Dummy transport
  ├─ Dummy          → In-memory transport implementation
  ├─ TestClient     → Client with doc, provider, and UI
  └─ init()         → Setup and event handlers
```

## Debugging

Open browser DevTools (F12) to see:
- Console logs for all transport activity
- Network tab (empty - no actual requests!)
- Yjs document structure
- Awareness states

### Common Issues

**Nothing syncs:**
- Check browser console for errors
- Verify all clients show "Status: connected"

**Awareness not updating:**
- Make sure clients are connected
- Check "Users Online" section for updates

**TextArea not updating:**
- Try typing in different clients
- Refresh and try again

**Offline/Online behavior:**
- When offline, changes are stored locally but not transmitted
- When coming back online, `syncNow()` is automatically called on all clients
- This triggers a fresh sync request and awareness broadcast
- Changes made while offline will sync within ~100ms after going online
- If sync seems slow, check the activity log for "🔄 Triggered re-sync" message

## Extending the Test

Want to test more features? Easy!

### Add More Shared Types

```typescript
const ymap = doc.getMap('settings')
ymap.set('theme', 'dark')
```

### Test Custom Awareness Fields

```typescript
provider.awareness.setLocalState({
  user: { name: 'Alice' },
  cursor: { line: 5, column: 10 },
  selection: { start: 0, end: 5 }
})
```

### Simulate Network Issues

```typescript
// In Dummy.send():
setTimeout(() => {
  if (Math.random() > 0.1) { // 10% packet loss
    dummy.messageCallback?.(data)
  }
}, Math.random() * 100) // Random delay
```

## Performance Testing

The test environment can handle many clients:

- **2-5 clients**: Smooth, instant updates
- **10 clients**: Still very responsive
- **20+ clients**: Performance depends on browser

Try adding many clients and typing rapidly to stress-test the sync!

## Next Steps

Once you've verified the Dummy transport works:
1. Implement a real transport (WebSocket, WebRTC, etc.)
2. Use the same pattern as Dummy
3. Test with actual network communication
4. Deploy! 🚀

## Troubleshooting

### Port already in use
If port 1234 is taken, Parcel will automatically use the next available port (1235, 1236, etc.)

### Module not found
Run `npm install` in this directory to install dependencies.

### Browser compatibility
Modern browsers (Chrome, Firefox, Safari, Edge) are supported. IE11 is not supported.

---

Happy testing! 🎉
