/**
 * Complete usage examples for the Generic Provider
 */

import * as Y from 'yjs'
import { GenericProvider } from './index'
import {
  WebSocketTransport,
  PubNubTransport,
  IndexedDBTransport,
} from './examples'

// ============================================================================
// Example 1: WebSocket Provider
// ============================================================================

async function exampleWebSocket() {
  const doc = new Y.Doc()
  const transport = new WebSocketTransport()
  const provider = new GenericProvider(doc, transport)

  // Listen to events
  provider.on('status', (status) => {
    console.log('Status:', status.state)
  })

  provider.on('synced', (synced) => {
    console.log('Synced:', synced)
  })

  // Connect
  await provider.connect({
    room: 'my-room',
    url: 'ws://localhost:1234',
  })

  // Use Yjs - everything syncs automatically!
  const ytext = doc.getText('content')
  ytext.insert(0, 'Hello from WebSocket!')

  // Set awareness (presence)
  provider.awareness.setLocalStateField('user', {
    name: 'Alice',
    color: '#00ff00',
  })

  // Later: disconnect
  // provider.disconnect()
}

// ============================================================================
// Example 2: PubNub Provider
// ============================================================================

async function examplePubNub() {
  const doc = new Y.Doc()
  const transport = new PubNubTransport()
  const provider = new GenericProvider(doc, transport)

  await provider.connect({
    room: 'my-course-room',
    publishKey: 'your-pub-key',
    subscribeKey: 'your-sub-key',
    password: 'optional-encryption-key',
  })

  const yarray = doc.getArray('todos')
  yarray.push(['Buy milk'])

  console.log('Connected clients:', provider.awareness.getStates().size)
}

// ============================================================================
// Example 3: IndexedDB Provider (Local Persistence)
// ============================================================================

async function exampleIndexedDB() {
  const doc = new Y.Doc()
  const transport = new IndexedDBTransport()
  const provider = new GenericProvider(doc, transport)

  // Connect loads existing data from IndexedDB
  await provider.connect({
    room: 'my-local-storage',
  })

  // All changes are automatically persisted
  const ymap = doc.getMap('settings')
  ymap.set('theme', 'dark')
  ymap.set('fontSize', 14)
}

// ============================================================================
// Example 4: Multiple Transports (Hybrid)
// ============================================================================

async function exampleMultipleTransports() {
  const doc = new Y.Doc()

  // Local persistence
  const persistTransport = new IndexedDBTransport()
  const persistProvider = new GenericProvider(doc, persistTransport)
  await persistProvider.connect({ room: 'local' })

  // Network sync
  const networkTransport = new WebSocketTransport()
  const networkProvider = new GenericProvider(doc, networkTransport)
  await networkProvider.connect({
    room: 'network',
    url: 'ws://server.com',
  })

  // Now changes are both persisted locally AND synced over network!
  const ytext = doc.getText('content')
  ytext.insert(0, 'Synced everywhere!')
}

// ============================================================================
// Example 5: Custom Transport Implementation
// ============================================================================

import type { Transport, ConnectionConfig } from './transport'

class CustomTransport implements Transport {
  private socket: any = null
  private callback?: (data: Uint8Array) => void

  get isConnected(): boolean {
    return this.socket !== null
  }

  async connect(config: ConnectionConfig): Promise<void> {
    // Your custom connection logic
    this.socket = {
      send: (data: any) => console.log('Sending:', data),
      onData: (cb: any) => (this.callback = cb),
    }
  }

  disconnect(): void {
    this.socket = null
  }

  send(data: Uint8Array): void {
    this.socket?.send(data)
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.callback = callback
    return () => {
      this.callback = undefined
    }
  }
}

async function exampleCustomTransport() {
  const doc = new Y.Doc()
  const transport = new CustomTransport()
  const provider = new GenericProvider(doc, transport)

  await provider.connect({ room: 'custom' })

  const ytext = doc.getText('content')
  ytext.insert(0, 'Using custom transport!')
}

// ============================================================================
// Example 6: Observing Changes
// ============================================================================

async function exampleObserveChanges() {
  const doc = new Y.Doc()
  const transport = new WebSocketTransport()
  const provider = new GenericProvider(doc, transport)

  // Observe document changes
  const ytext = doc.getText('content')
  ytext.observe((event) => {
    console.log('Text changed:', event.delta)
  })

  // Observe awareness changes (who's online, cursor positions, etc.)
  provider.awareness.on('change', ({ added, updated, removed }) => {
    console.log('Awareness changed:')
    console.log('  Added:', added)
    console.log('  Updated:', updated)
    console.log('  Removed:', removed)

    // Get all current states
    const states = provider.awareness.getStates()
    states.forEach((state, clientID) => {
      console.log(`Client ${clientID}:`, state)
    })
  })

  await provider.connect({
    room: 'observe-example',
    url: 'ws://localhost:1234',
  })
}

// ============================================================================
// Example 7: Error Handling & Reconnection
// ============================================================================

async function exampleErrorHandling() {
  const doc = new Y.Doc()
  const transport = new WebSocketTransport()
  const provider = new GenericProvider(doc, transport)

  let reconnectAttempts = 0
  const maxReconnects = 5

  provider.on('status', async (status) => {
    if (status.state === 'error') {
      console.error('Connection error:', status.error)

      // Implement exponential backoff
      if (reconnectAttempts < maxReconnects) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
        console.log(`Reconnecting in ${delay}ms...`)

        await new Promise((resolve) => setTimeout(resolve, delay))

        try {
          await provider.connect({
            room: 'my-room',
            url: 'ws://localhost:1234',
          })
          reconnectAttempts = 0 // Reset on success

          // Force a sync after reconnection
          setTimeout(() => provider.syncNow(), 100)
        } catch (e) {
          reconnectAttempts++
        }
      } else {
        console.error('Max reconnection attempts reached')
      }
    }

    if (status.state === 'connected') {
      console.log('Successfully connected!')
      reconnectAttempts = 0
    }
  })

  try {
    await provider.connect({
      room: 'my-room',
      url: 'ws://localhost:1234',
    })
  } catch (error) {
    console.error('Initial connection failed:', error)
  }
}

// ============================================================================
// Example 8: Room-based Collaboration
// ============================================================================

async function exampleRoomCollaboration() {
  const doc = new Y.Doc()
  const transport = new WebSocketTransport()
  const provider = new GenericProvider(doc, transport)

  // Connect to specific room
  await provider.connect({
    room: 'course-123-classroom-a',
    course: 'https://example.com/course.md',
    url: 'ws://localhost:1234',
  })

  // Set user information in awareness
  provider.awareness.setLocalState({
    user: {
      name: 'Alice',
      color: '#ff6b6b',
      avatar: 'https://example.com/alice.jpg',
    },
    cursor: null, // Will be updated when editing
  })

  // Create collaborative text editor
  const ytext = doc.getText('document')

  // Simulate cursor position update
  function updateCursor(position: number) {
    const currentState = provider.awareness.getLocalState()
    provider.awareness.setLocalState({
      ...currentState,
      cursor: { position },
    })
  }

  // When user types
  ytext.observe((event) => {
    // Update cursor position
    const length = ytext.length
    updateCursor(length)
  })

  // Display other users' cursors
  provider.awareness.on('change', () => {
    const states = provider.awareness.getStates()
    states.forEach((state, clientID) => {
      if (clientID !== doc.clientID && state.cursor) {
        console.log(`${state.user.name} cursor at:`, state.cursor.position)
      }
    })
  })
}

// ============================================================================
// Example 9: Pub/Sub Channel (Real-time Messaging)
// ============================================================================

/**
 * Use pub/sub for real-time messaging that doesn't need CRDT properties:
 * - Chat messages
 * - Notifications
 * - RPC calls
 * - Ephemeral events
 */
async function examplePubSub() {
  const doc = new Y.Doc()
  const transport = new WebSocketTransport()
  const provider = new GenericProvider(doc, transport)

  await provider.connect({
    room: 'chat-room',
    url: 'ws://localhost:1234',
  })

  // Subscribe to chat messages
  const unsubChat = provider.pubsub.subscribe('chat', (msg: any) => {
    console.log(`[${msg.user}]: ${msg.text}`)
    displayChatMessage(msg)
  })

  // Subscribe to notifications
  const unsubNotif = provider.pubsub.subscribe('notification', (msg: any) => {
    console.log('Notification:', msg)
    showNotification(msg)
  })

  // Subscribe to all topics (wildcard)
  const unsubAll = provider.pubsub.subscribe('*', (msg: any) => {
    console.log('All messages:', msg)
  })

  // Publish a chat message
  function sendChatMessage(text: string) {
    provider.pubsub.publish('chat', {
      user: getCurrentUsername(),
      text: text,
      timestamp: Date.now(),
    })
  }

  // Publish a notification
  function notifyUserJoined(username: string) {
    provider.pubsub.publish('notification', {
      type: 'user-joined',
      user: username,
      timestamp: Date.now(),
    })
  }

  // RPC example: request/response pattern
  function setupRPC() {
    // Subscribe to RPC requests
    provider.pubsub.subscribe('rpc-request', async (req: any) => {
      if (req.method === 'ping') {
        // Respond
        provider.pubsub.publish('rpc-response', {
          id: req.id,
          result: 'pong',
        })
      }
    })

    // Make an RPC call
    const requestId = Math.random().toString(36)
    provider.pubsub.publish('rpc-request', {
      id: requestId,
      method: 'ping',
    })
  }

  // Unsubscribe when done
  // unsubChat()
  // unsubNotif()
  // unsubAll()

  // Helper functions (implement these)
  function displayChatMessage(msg: any) {
    /* display in UI */
  }
  function showNotification(msg: any) {
    /* show notification */
  }
  function getCurrentUsername(): string {
    return 'Alice'
  }
}

// ============================================================================
// Example 10: Handling Network Interruptions
// ============================================================================

/**
 * Handle offline/online scenarios gracefully with automatic re-sync.
 */
async function exampleNetworkInterruption() {
  const doc = new Y.Doc()
  const transport = new WebSocketTransport()
  const provider = new GenericProvider(doc, transport)

  await provider.connect({
    room: 'resilient-room',
    url: 'ws://localhost:1234',
  })

  // Detect when browser goes offline/online
  window.addEventListener('offline', () => {
    console.log('🔴 Network offline - changes will queue locally')
    showBanner('You are offline. Changes will sync when back online.')
  })

  window.addEventListener('online', () => {
    console.log('🟢 Network online - syncing...')

    // Give the network a moment to stabilize, then force sync
    setTimeout(() => {
      // syncNow() does three things:
      // 1. Sends our local changes (made while offline) to peers
      // 2. Requests updates we missed from peers
      // 3. Updates awareness state
      provider.syncNow()
      console.log('✓ Re-sync triggered')
      showBanner('Back online! Syncing changes...')
    }, 500)
  })

  // Also handle transport reconnection
  provider.on('status', (status) => {
    if (status.state === 'connected') {
      // Transport reconnected (e.g., WebSocket reconnected)
      // Force a sync to ensure we have latest state
      setTimeout(() => provider.syncNow(), 100)
    }
  })

  // Monitor sync state
  provider.on('synced', (synced) => {
    if (synced) {
      console.log('✓ Fully synced with peers')
      hideBanner()
    }
  })

  // Helper functions (implement these)
  function showBanner(message: string) {
    /* Show UI banner */
  }
  function hideBanner() {
    /* Hide UI banner */
  }
}

// Export for use
export {
  exampleWebSocket,
  examplePubNub,
  exampleIndexedDB,
  exampleMultipleTransports,
  exampleCustomTransport,
  exampleObserveChanges,
  exampleErrorHandling,
  exampleRoomCollaboration,
  examplePubSub,
  exampleNetworkInterruption,
}
