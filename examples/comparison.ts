/**
 * Simple implementation comparison: Old vs New approach
 */

import * as Y from 'yjs'
import {
  GenericProvider,
  type Transport,
  type ConnectionConfig,
} from './exports'

// ============================================================================
// NEW APPROACH: Minimal Transport Implementation
// ============================================================================

/**
 * Your WebSocket backend - ONLY 4 methods, ~30 lines!
 */
class SimpleWebSocketTransport implements Transport {
  private ws: WebSocket | null = null
  private messageCallback?: (data: Uint8Array) => void

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  async connect(config: ConnectionConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${config.url}/${config.room}`)
      this.ws.binaryType = 'arraybuffer'
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('Connection failed'))
      this.ws.onmessage = (e) => this.messageCallback?.(new Uint8Array(e.data))
    })
  }

  disconnect(): void {
    this.ws?.close()
  }

  send(data: Uint8Array): void {
    this.ws?.send(data)
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback
    return () => {
      this.messageCallback = undefined
    }
  }
}

// ============================================================================
// Usage - Simple and Clean!
// ============================================================================

async function newApproach() {
  // 1. Create Yjs document
  const doc = new Y.Doc()

  // 2. Create your transport
  const transport = new SimpleWebSocketTransport()

  // 3. Create provider - BUILT-IN AWARENESS!
  const provider = new GenericProvider(doc, transport)

  // 4. Connect
  await provider.connect({
    room: 'my-room',
    url: 'ws://localhost:1234',
  })

  // 5. Done! Everything syncs automatically
  const ytext = doc.getText('content')
  ytext.insert(0, 'Hello!')

  // Awareness is built-in
  provider.awareness.setLocalState({ user: 'Alice', color: '#ff0000' })

  console.log('Users online:', provider.awareness.getStates().size)
  console.log('Connected:', provider.connected)
  console.log('Synced:', provider.synced)
}

// ============================================================================
// OLD APPROACH (Your current Base/Sync class) - More Complex
// ============================================================================

// In the old approach, you had to:
// 1. Extend Base.Sync class (~500 lines)
// 2. Implement broadcast(), applyUpdate(), etc.
// 3. Manually handle state encoding/decoding
// 4. Manage CRDT class separately
// 5. Handle gossip protocol
// 6. Manage timestamps
// 7. Handle encryption
// 8. Write ~150+ lines per backend

/*
class OldWebSocketSync extends Base.Sync {
  private ws: any
  
  async connect(data) {
    super.connect(data)
    // Setup websocket
    // Handle messages
    // Decode state
    // Apply updates
    // Broadcast
    // Handle timestamps
    // etc... lots of code
  }
  
  broadcast(state, data) {
    // Encode
    // Add timestamp
    // Convert to base64
    // Send
  }
  
  applyUpdate(data, force) {
    // Decode
    // Check timestamp
    // Apply to CRDT
    // etc...
  }
}
*/

// ============================================================================
// COMPARISON
// ============================================================================

console.log(`
OLD APPROACH:
- ~500 lines in Base.Sync
- ~150 lines per backend implementation
- Manual state management
- Manual encoding/decoding
- Custom CRDT wrapper
- Custom gossip protocol
- Manual timestamp handling

NEW APPROACH:
- ~30 lines per backend implementation
- Just implement Transport interface
- Provider handles ALL Yjs logic
- Standard Yjs protocols
- Built-in awareness
- Automatic sync
- Clean, minimal API

Result: ~5x less code, standard protocols, easier to maintain!
`)

// ============================================================================
// MIGRATION EXAMPLE: Wrap existing backend
// ============================================================================

/**
 * Adapter to wrap your existing PubNub implementation
 */
class PubNubLegacyAdapter implements Transport {
  private oldSync: any // Your existing PubNub Sync class

  constructor() {
    // Create instance of your old sync
    this.oldSync = {} // new PubNubSync(...)
  }

  get isConnected(): boolean {
    return this.oldSync.isConnected
  }

  async connect(config: ConnectionConfig): Promise<void> {
    return this.oldSync.connect(config)
  }

  disconnect(): void {
    this.oldSync.disconnect()
  }

  send(data: Uint8Array): void {
    // Call old broadcast method
    this.oldSync.broadcast(true, data)
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    // Hook into old message handler
    this.oldSync.onUpdate = callback
    return () => {
      this.oldSync.onUpdate = null
    }
  }
}

// Now you can use your old backend with the new API!
async function migrateExistingBackend() {
  const doc = new Y.Doc()
  const transport = new PubNubLegacyAdapter()
  const provider = new GenericProvider(doc, transport)

  await provider.connect({ room: 'migrated' })
  // Works with your existing infrastructure!
}

export { newApproach, migrateExistingBackend }
