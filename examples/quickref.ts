/**
 * QUICK REFERENCE CARD
 * Generic Yjs Provider - All you need to know in one file
 */

// ============================================================================
// 1. THE INTERFACE (What you implement)
// ============================================================================

interface Transport {
  connect(config: any): Promise<void>       // Connect to backend
  disconnect(): void                         // Disconnect
  send(data: Uint8Array): void              // Send data
  onMessage(callback): () => void           // Receive data
  readonly isConnected: boolean             // Status
}

// ============================================================================
// 2. MINIMAL IMPLEMENTATION (30 lines)
// ============================================================================

class MyTransport implements Transport {
  private connection: any
  private callback?: (data: Uint8Array) => void

  get isConnected() { return !!this.connection }

  async connect(config: any) {
    this.connection = await connectToYourBackend(config)
    this.connection.on('data', (data) => this.callback?.(data))
  }

  disconnect() {
    this.connection?.close()
  }

  send(data: Uint8Array) {
    this.connection?.send(data)
  }

  onMessage(callback: (data: Uint8Array) => void) {
    this.callback = callback
    return () => { this.callback = undefined }
  }
}

// ============================================================================
// 3. USAGE (5 lines)
// ============================================================================

import * as Y from 'yjs'
import { GenericProvider } from './GenericProvider'

const doc = new Y.Doc()
const provider = new GenericProvider(doc, new MyTransport())
await provider.connect({ room: 'my-room' })

// Done! Everything syncs automatically.

// ============================================================================
// 4. WHAT YOU GET FOR FREE
// ============================================================================

// ✅ Automatic document synchronization
doc.getText('content').insert(0, 'Hello')  // Syncs automatically

// ✅ Built-in awareness (presence, cursors, users)
provider.awareness.setLocalState({ user: 'Alice', color: '#f00' })

// ✅ State vector sync (efficient, only missing data)
// ✅ Loop prevention (transaction origins)
// ✅ Reconnection support
// ✅ Event system

provider.on('synced', (synced) => console.log('Synced:', synced))
provider.on('status', (status) => console.log('Status:', status))

// ============================================================================
// 5. REAL-WORLD EXAMPLES
// ============================================================================

// WebSocket
class WS implements Transport {
  private ws: WebSocket | null = null
  private cb?: (d: Uint8Array) => void
  get isConnected() { return this.ws?.readyState === WebSocket.OPEN }
  async connect(c) { 
    this.ws = new WebSocket(c.url)
    this.ws.binaryType = 'arraybuffer'
    this.ws.onmessage = e => this.cb?.(new Uint8Array(e.data))
    return new Promise(r => this.ws!.onopen = r)
  }
  disconnect() { this.ws?.close() }
  send(d) { this.ws?.send(d) }
  onMessage(cb) { this.cb = cb; return () => this.cb = undefined }
}

// PubNub
class PN implements Transport {
  private pn: any
  private cb?: (d: Uint8Array) => void
  get isConnected() { return !!this.pn }
  async connect(c) {
    this.pn = new PubNub({ publishKey: c.pubKey, subscribeKey: c.subKey })
    this.pn.addListener({ message: e => this.cb?.(decode(e.message)) })
    this.pn.subscribe({ channels: [c.room] })
  }
  disconnect() { this.pn?.unsubscribeAll() }
  send(d) { this.pn?.publish({ channel: this.channel, message: encode(d) }) }
  onMessage(cb) { this.cb = cb; return () => this.cb = undefined }
}

// IndexedDB (persistence)
class IDB implements Transport {
  private db: IDBDatabase | null = null
  private cb?: (d: Uint8Array) => void
  get isConnected() { return !!this.db }
  async connect(c) {
    this.db = await openDB(c.room)
    const updates = await this.db.getAll('updates')
    updates.forEach(u => this.cb?.(u))
  }
  disconnect() { this.db?.close() }
  send(d) { this.db?.add('updates', d) }
  onMessage(cb) { this.cb = cb; return () => this.cb = undefined }
}

// ============================================================================
// 6. MULTIPLE TRANSPORTS (Hybrid sync)
// ============================================================================

const doc = new Y.Doc()

// Local persistence
const local = new GenericProvider(doc, new IDB())
await local.connect({ room: 'local' })

// Network sync
const network = new GenericProvider(doc, new WS())
await network.connect({ room: 'net', url: 'ws://server' })

// Changes are now BOTH persisted AND synced over network!

// ============================================================================
// 7. API CHEAT SHEET
// ============================================================================

// Provider
const provider = new GenericProvider(doc, transport, { awareness? })

await provider.connect(config)          // Connect
provider.disconnect()                    // Disconnect
provider.destroy()                       // Destroy permanently

provider.doc                             // Y.Doc
provider.transport                       // Your transport
provider.awareness                       // Awareness instance
provider.connected                       // boolean
provider.synced                          // boolean
provider.status                          // ConnectionStatus

provider.on('status', cb)                // Status events
provider.on('synced', cb)                // Sync events

// Awareness
awareness.setLocalState({ user: 'Alice' })
awareness.getLocalState()
awareness.getStates()                    // Map<clientID, state>
awareness.on('change', cb)               // When users join/leave
awareness.on('update', cb)               // When states update

// Document
doc.getText('name')
doc.getArray('list')
doc.getMap('data')
doc.on('update', cb)

// ============================================================================
// 8. COMPARISON WITH OLD APPROACH
// ============================================================================

/*
OLD: Base.Sync class
- 500+ lines of base code
- 150+ lines per backend
- Manual state management
- Custom protocols
- Manual encoding/decoding
- Complex inheritance

NEW: GenericProvider
- 30 lines per backend
- Just 4 methods to implement
- Standard Yjs protocols
- Automatic everything
- Clean composition
*/

// ============================================================================
// 9. PATTERN SUMMARY
// ============================================================================

/*
┌─────────────────┐
│  Your App       │  Uses Y.Doc, Y.Text, etc.
└────────┬────────┘
         │
         │ Automatic
         ▼
┌─────────────────┐
│ GenericProvider │  Handles all Yjs logic
│  • Sync         │  • Encodes updates
│  • Awareness    │  • Manages state
│  • Events       │  • Handles protocol
└────────┬────────┘
         │
         │ send(bytes) / onMessage(cb)
         ▼
┌─────────────────┐
│ Your Transport  │  Just move data
│  • WebSocket    │  • Whatever you want
│  • WebRTC       │  • However you want
│  • PubNub       │
│  • etc.         │
└─────────────────┘
*/

// ============================================================================
// THAT'S IT! You now have everything you need.
// Just implement Transport and you're done.
// ============================================================================

export { }  // Make this a module
