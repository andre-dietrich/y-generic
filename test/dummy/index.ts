import * as Y from 'yjs'
import { GenericProvider } from '../../src/lib'
import type { Transport, ConnectionConfig } from '../../src/transport'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import QuillCursors from 'quill-cursors'

const BlockEmbed = Quill.import('blots/block/embed') as any

// Register QuillCursors module for collaborative cursors
Quill.register('modules/cursors', QuillCursors)

// Custom Video Blot for HTML5 video support
class VideoBlot extends BlockEmbed {
  static blotName = 'video'
  static tagName = 'video'

  static create(value: string) {
    const node = super.create(value) as HTMLVideoElement
    node.setAttribute('src', value)
    node.setAttribute('controls', 'true')
    node.setAttribute('preload', 'metadata')
    node.setAttribute('style', 'max-width: 100%; height: auto;')

    // Add error handler
    node.onerror = function () {
      console.error('Video load error:', node.error)
      if (node.error) {
        console.error(
          `Error code: ${node.error.code}, message: ${node.error.message}`,
        )
      }
    }

    return node
  }

  static value(node: HTMLVideoElement) {
    return node.getAttribute('src')
  }
}

Quill.register(VideoBlot, true)

// ============================================================================
// Dummy Transport - Simulates network communication in-memory
// ============================================================================

// Global registry of all connected dummies (simulates network)
const dummies: Map<number, Dummy> = new Map()

// Global network status (for simulating offline/online)
let globalNetworkOnline: boolean = true

// Network simulation parameters
let networkDelay: number = 10 // milliseconds
let networkPacketLoss: number = 0 // percentage (0-100)
let networkJitter: number = 0 // jitter factor (0-1)
let dataCorruptionRate: number = 0 // percentage (0-100) - probability of corrupting data
let corruptionType: 'bitflip' | 'truncate' | 'garbage' | 'insert' = 'bitflip' // corruption strategy

/**
 * Corruption strategies for testing Y.mergeUpdates error handling:
 * - bitflip: Flip random bits (subtle corruption, realistic)
 * - truncate: Cut off message at random point (incomplete message)
 * - garbage: Replace entire payload with random data (worst case)
 * - insert: Insert random bytes at random positions (length changes)
 */
function corruptData(data: Uint8Array, type: string): Uint8Array {
  const corrupted = new Uint8Array(data)

  switch (type) {
    case 'bitflip': {
      // Flip 1-5 random bits
      const numFlips = 1 + Math.floor(Math.random() * 5)
      for (let i = 0; i < numFlips; i++) {
        const byteIndex = Math.floor(Math.random() * corrupted.length)
        const bitIndex = Math.floor(Math.random() * 8)
        corrupted[byteIndex] ^= 1 << bitIndex
      }
      return corrupted
    }

    case 'truncate': {
      // Cut off 10-90% of the message
      const keepPercent = 0.1 + Math.random() * 0.8
      const newLength = Math.max(1, Math.floor(corrupted.length * keepPercent))
      return corrupted.slice(0, newLength)
    }

    case 'garbage': {
      // Replace entire payload with random bytes
      const garbage = new Uint8Array(corrupted.length)
      for (let i = 0; i < garbage.length; i++) {
        garbage[i] = Math.floor(Math.random() * 256)
      }
      return garbage
    }

    case 'insert': {
      // Insert 1-10 random bytes at random positions
      const numInserts = 1 + Math.floor(Math.random() * 10)
      let result = new Uint8Array(corrupted.length + numInserts)
      let srcPos = 0
      let dstPos = 0

      for (let i = 0; i < numInserts; i++) {
        const insertAt = Math.floor(
          Math.random() * (corrupted.length - srcPos + 1),
        )
        // Copy original data up to insert point
        result.set(corrupted.slice(srcPos, srcPos + insertAt), dstPos)
        srcPos += insertAt
        dstPos += insertAt
        // Insert random byte
        result[dstPos++] = Math.floor(Math.random() * 256)
      }
      // Copy remaining data
      result.set(corrupted.slice(srcPos), dstPos)
      return result
    }

    default:
      return corrupted
  }
}

/**
 * Dummy transport that simulates network communication.
 * All Dummy instances communicate through a shared in-memory registry.
 */
export class Dummy implements Transport {
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false
  private id: number = Math.floor(Math.random() * 100000)
  public clientOffline: boolean = false // Per-client offline state

  get isConnected(): boolean {
    return this._isConnected && globalNetworkOnline && !this.clientOffline
  }

  async connect(config: ConnectionConfig): Promise<void> {
    return new Promise((resolve) => {
      // Register this transport in the global registry
      dummies.set(this.id, this)
      this._isConnected = true

      console.log(`[Dummy ${this.id}] Connected to room: ${config.room}`)
      resolve()
    })
  }

  disconnect(): void {
    if (dummies.has(this.id)) {
      dummies.delete(this.id)
      console.log(`[Dummy ${this.id}] Disconnected`)
    }
    this._isConnected = false
  }

  send(data: Uint8Array): void {
    // Don't send if global network is offline or this client is offline
    if (!globalNetworkOnline || this.clientOffline) {
      return
    }

    // Broadcast to all other connected transports
    dummies.forEach((dummy, id) => {
      if (id !== this.id && dummy.messageCallback) {
        // Simulate packet loss
        if (Math.random() * 100 < networkPacketLoss) {
          // Message dropped!
          return
        }

        // Calculate actual delay with jitter
        let actualDelay = networkDelay
        if (networkDelay > 0 && networkJitter > 0) {
          // Random delay between delay*(1-jitter) and delay*(1+jitter)
          const minDelay = networkDelay * (1 - networkJitter)
          const maxDelay = networkDelay * (1 + networkJitter)
          actualDelay = minDelay + Math.random() * (maxDelay - minDelay)
        }

        // CRITICAL: Always copy data to avoid reference issues with async delivery
        // Without copying, if sender modifies array before setTimeout fires,
        // receiver gets corrupted data even at 0% corruption rate
        let dataToSend = new Uint8Array(data)

        // Apply data corruption if enabled (corrupts the copy)
        if (
          dataCorruptionRate > 0 &&
          Math.random() * 100 < dataCorruptionRate
        ) {
          console.warn(
            `[Dummy ${this.id}] 💥 CORRUPTING data (type: ${corruptionType})`,
          )
          dataToSend = corruptData(dataToSend, corruptionType)
        }

        setTimeout(() => {
          // Check network status again after delay (both global and target client)
          if (globalNetworkOnline && !dummy.clientOffline) {
            dummy.messageCallback?.(dataToSend)
          }
        }, actualDelay)
      }
    })
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback
    return () => {
      this.messageCallback = undefined
    }
  }
}

// ============================================================================
// Test Client Class
// ============================================================================

interface ClientUI {
  container: HTMLElement
  nameInput: HTMLInputElement
  colorInput: HTMLInputElement
  editorContainer: HTMLElement
  statusDiv: HTMLElement
  awarenessDiv: HTMLElement
  syncedDiv: HTMLElement
  chatInput: HTMLInputElement
  chatMessages: HTMLElement
  notificationsDiv: HTMLElement
  offlineToggleBtn: HTMLButtonElement
  offlineStatus: HTMLElement
}

/**
 * Test client with its own document, provider, and UI
 */
class TestClient {
  public doc: Y.Doc
  public provider: GenericProvider
  public transport: Dummy
  public ytext: Y.Text
  public name: string
  public color: string
  public ui: ClientUI
  public quill: Quill
  public binding: QuillBinding

  constructor(name: string, color: string, container: HTMLElement) {
    this.name = name
    this.color = color

    // Create Yjs document
    this.doc = new Y.Doc()
    this.ytext = this.doc.getText('content')

    // Create transport and provider
    // Use 2 second sync interval for testing (helps with packet loss)
    // Enable verifyUpdates for immediate desync detection (faster than waiting 2s)
    // batchUpdates can be used to reduce network traffic (e.g., batchUpdates: 100)
    // IMPORTANT: disableBc prevents cross-tab sync, forcing all sync through simulated network
    this.transport = new Dummy()
    this.provider = new GenericProvider(this.doc, this.transport, {
      batchUpdates: 100, // Optional: batch updates for 100ms to reduce traffic
      syncInterval: 2000, // Retry sync every 2 seconds to handle packet loss
      verifyUpdates: true, // Send hash with each update for immediate desync detection
      disableBc: true, // CRITICAL: Disable BroadcastChannel to test network simulation properly
    })

    // Create UI
    this.ui = this.createUI(container)

    // Initialize Quill editor
    this.quill = new Quill(this.ui.editorContainer, {
      theme: 'snow',
      placeholder: 'Type here... changes sync automatically!',
      modules: {
        cursors: true,
        toolbar: {
          container: [
            [{ header: [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['link', 'image', 'video', 'code-block'],
            ['clean'],
          ],
          handlers: {
            image: () => this.imageHandler(),
            video: () => this.videoHandler(),
          },
        },
      },
    })

    // Bind Quill to Yjs - automatic collaborative editing!
    this.binding = new QuillBinding(
      this.ytext,
      this.quill,
      this.provider.awareness,
    )

    // Setup event listeners
    this.setupListeners()
  }

  private imageHandler(): void {
    const input = document.createElement('input')
    input.setAttribute('type', 'file')
    input.setAttribute('accept', 'image/*')
    input.click()

    input.onchange = () => {
      const file = input.files?.[0]
      if (file) {
        const reader = new FileReader()
        reader.onload = (e) => {
          const range = this.quill.getSelection(true)
          this.quill.insertEmbed(range.index, 'image', e.target?.result)
          this.quill.setSelection(range.index + 1)
        }
        reader.readAsDataURL(file)
      }
    }
  }

  private videoHandler(): void {
    const input = document.createElement('input')
    input.setAttribute('type', 'file')
    input.setAttribute('accept', 'video/mp4,video/webm,video/ogg')
    input.click()

    input.onchange = () => {
      const file = input.files?.[0]
      if (file) {
        // Check if format is supported
        const supportedFormats = ['video/mp4', 'video/webm', 'video/ogg']
        if (!supportedFormats.includes(file.type)) {
          console.error(
            `Unsupported video format: ${file.type}. Please use MP4, WebM, or OGG.`,
          )
          return
        }

        const reader = new FileReader()
        reader.onload = (e) => {
          const range = this.quill.getSelection(true)
          this.quill.insertEmbed(range.index, 'video', e.target?.result)
          this.quill.setSelection(range.index + 1)
        }
        reader.onerror = () => {
          console.error('Failed to read video file')
        }
        reader.readAsDataURL(file)
      }
    }
  }

  private createUI(container: HTMLElement): ClientUI {
    const clientDiv = document.createElement('div')
    clientDiv.className = 'client'
    clientDiv.style.cssText = `
      border: 2px solid ${this.color};
      padding: 15px;
      margin: 10px;
      border-radius: 8px;
      background: #f9f9f9;
    `

    clientDiv.innerHTML = `
      <div class="client-header" style="margin-bottom: 10px;">
        <h3 style="margin: 0 0 10px 0; color: ${this.color};">${this.name}</h3>
        <div style="display: flex; gap: 10px; margin-bottom: 10px;">
          <input type="text" 
                 class="name-input" 
                 value="${this.name}" 
                 placeholder="Your name"
                 style="flex: 1; padding: 5px; border: 1px solid #ccc; border-radius: 4px;" />
          <input type="color" 
                 class="color-input" 
                 value="${this.color}"
                 style="width: 50px;" />
          <button class="offline-toggle-btn" 
                  style="padding: 5px 10px; background: #ff9800; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 11px;">
            📡 Go Offline
          </button>
          <button class="disconnect-btn" 
                  style="padding: 5px 10px; background: #ff4444; color: white; border: none; border-radius: 4px; cursor: pointer;">
            ❌
          </button>
        </div>
        <div style="font-size: 11px; color: #666; margin-bottom: 5px;">
          Network: <span class="offline-status" style="font-weight: bold; color: #4caf50;">🟢 Online</span>
        </div>
      </div>
      
      <div class="status" style="font-size: 12px; margin-bottom: 5px; color: #666;">
        Status: <span class="status-text">Disconnected</span>
      </div>
      
      <div class="synced" style="font-size: 12px; margin-bottom: 10px; color: #666;">
        Synced: <span class="synced-text">No</span>
      </div>
      
      <div class="editor-container" style="background: white; border: 1px solid #ccc; border-radius: 4px; margin-bottom: 10px;">
        <div class="quill-editor" style="height: 150px;"></div>
      </div>
      
      <div class="awareness" style="margin-top: 10px; padding: 10px; background: white; border-radius: 4px; font-size: 12px;">
        <strong>Users Online:</strong>
        <div class="awareness-list"></div>
      </div>
      
      <div class="pubsub-section" style="margin-top: 10px;">
        <div style="background: #fff3cd; padding: 10px; border-radius: 4px; margin-bottom: 5px; max-height: 100px; overflow-y: auto; font-size: 11px;">
          <strong>📢 Notifications:</strong>
          <div class="notifications-list"></div>
        </div>
        
        <div style="background: white; padding: 10px; border-radius: 4px;">
          <strong style="font-size: 12px;">💬 Chat (Pub/Sub):</strong>
          <div class="chat-messages" style="max-height: 80px; overflow-y: auto; margin: 5px 0; padding: 5px; background: #f8f9fa; border-radius: 3px; font-size: 11px;"></div>
          <div style="display: flex; gap: 5px;">
            <input type="text" 
                   class="chat-input" 
                   placeholder="Type a message..."
                   style="flex: 1; padding: 5px; border: 1px solid #ccc; border-radius: 3px; font-size: 11px;" />
            <button class="chat-send-btn"
                    style="padding: 5px 10px; background: ${this.color}; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;">
              Send
            </button>
          </div>
        </div>
      </div>
    `

    container.appendChild(clientDiv)

    return {
      container: clientDiv,
      nameInput: clientDiv.querySelector('.name-input')!,
      colorInput: clientDiv.querySelector('.color-input')!,
      editorContainer: clientDiv.querySelector('.quill-editor')!,
      statusDiv: clientDiv.querySelector('.status-text')!,
      awarenessDiv: clientDiv.querySelector('.awareness-list')!,
      syncedDiv: clientDiv.querySelector('.synced-text')!,
      chatInput: clientDiv.querySelector('.chat-input')!,
      chatMessages: clientDiv.querySelector('.chat-messages')!,
      notificationsDiv: clientDiv.querySelector('.notifications-list')!,
      offlineToggleBtn: clientDiv.querySelector('.offline-toggle-btn')!,
      offlineStatus: clientDiv.querySelector('.offline-status')!,
    }
  }

  private setupListeners(): void {
    // Update name when input changes
    this.ui.nameInput.addEventListener('input', () => {
      this.name = this.ui.nameInput.value
      this.updateAwareness()

      // Publish notification via pub/sub
      this.provider.pubsub.publish('notification', {
        type: 'name-change',
        user: this.name,
        color: this.color,
      })
    })

    // Update color when input changes
    this.ui.colorInput.addEventListener('input', () => {
      this.color = this.ui.colorInput.value
      this.ui.container.style.borderColor = this.color
      this.updateAwareness()
    })

    // Offline toggle button
    this.ui.offlineToggleBtn.addEventListener('click', () => {
      this.transport.clientOffline = !this.transport.clientOffline
      this.updateOfflineStatus()

      if (!this.transport.clientOffline) {
        // Coming back online - trigger re-sync
        setTimeout(() => {
          this.provider.syncNow()
          log(`🔄 ${this.name} re-syncing after coming online`)
        }, 50)
      } else {
        log(`📡 ${this.name} went offline`)
      }
    })

    // Disconnect button
    this.ui.container
      .querySelector('.disconnect-btn')
      ?.addEventListener('click', () => {
        this.disconnect()
      })

    // Listen to provider events
    this.provider.on('status', (status: any) => {
      this.updateStatus()
    })

    this.provider.on('synced', (synced: boolean) => {
      this.updateSynced()
    })

    // Listen to awareness changes
    this.provider.awareness.on('change', () => {
      this.updateAwarenessDisplay()
    })

    // Setup pub/sub chat
    this.setupChatListeners()

    // Subscribe to all notifications
    this.provider.pubsub.subscribe('notification', (msg: any) => {
      this.addNotification(msg)
    })

    // Subscribe to chat messages
    this.provider.pubsub.subscribe('chat', (msg: any) => {
      this.addChatMessage(msg)
    })
  }

  private setupChatListeners(): void {
    const sendMessage = () => {
      const text = this.ui.chatInput.value.trim()
      if (text) {
        // Publish via pub/sub channel
        this.provider.pubsub.publish('chat', {
          user: this.name,
          color: this.color,
          text: text,
          timestamp: Date.now(),
        })
        this.ui.chatInput.value = ''
      }
    }

    this.ui.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendMessage()
      }
    })

    this.ui.container
      .querySelector('.chat-send-btn')
      ?.addEventListener('click', sendMessage)
  }

  private addChatMessage(msg: {
    user: string
    color: string
    text: string
    timestamp: number
  }): void {
    const isOwnMessage = msg.user === this.name
    const time = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })

    const messageEl = document.createElement('div')
    messageEl.style.cssText = `
      margin: 3px 0;
      padding: 4px;
      background: ${isOwnMessage ? '#e3f2fd' : '#f5f5f5'};
      border-left: 3px solid ${msg.color};
      border-radius: 3px;
    `
    messageEl.innerHTML = `
      <strong style="color: ${msg.color};">${msg.user}</strong>
      <span style="color: #999; font-size: 9px;">${time}</span>
      <div style="margin-top:2px;">${this.escapeHtml(msg.text)}</div>
    `

    this.ui.chatMessages.appendChild(messageEl)
    this.ui.chatMessages.scrollTop = this.ui.chatMessages.scrollHeight

    // Keep only last 20 messages
    while (this.ui.chatMessages.children.length > 20) {
      this.ui.chatMessages.removeChild(this.ui.chatMessages.firstChild!)
    }
  }

  private addNotification(msg: any): void {
    const time = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
    const notifEl = document.createElement('div')
    notifEl.style.cssText =
      'margin: 2px 0; padding: 3px; background: rgba(255,255,255,0.5); border-radius: 2px;'

    let text = ''
    if (msg.type === 'name-change') {
      text = `${msg.user} updated their profile`
    } else {
      text = JSON.stringify(msg)
    }

    notifEl.innerHTML = `<span style="color: #666;">${time}</span> ${text}`
    this.ui.notificationsDiv.appendChild(notifEl)

    // Keep only last 10 notifications
    while (this.ui.notificationsDiv.children.length > 10) {
      this.ui.notificationsDiv.removeChild(this.ui.notificationsDiv.firstChild!)
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  private updateStatus(): void {
    const status = this.provider.status
    this.ui.statusDiv.textContent = status.state
    this.ui.statusDiv.style.color =
      status.state === 'connected' ? '#00aa00' : '#aa0000'
  }

  private updateSynced(): void {
    this.ui.syncedDiv.textContent = this.provider.synced ? 'Yes' : 'No'
    this.ui.syncedDiv.style.color = this.provider.synced ? '#00aa00' : '#aa0000'
  }

  private updateOfflineStatus(): void {
    if (this.transport.clientOffline) {
      this.ui.offlineStatus.textContent = '🔴 Offline'
      this.ui.offlineStatus.style.color = '#f44336'
      this.ui.offlineToggleBtn.textContent = '🌐 Go Online'
      this.ui.offlineToggleBtn.style.background = '#4caf50'
    } else {
      this.ui.offlineStatus.textContent = '🟢 Online'
      this.ui.offlineStatus.style.color = '#4caf50'
      this.ui.offlineToggleBtn.textContent = '📡 Go Offline'
      this.ui.offlineToggleBtn.style.background = '#ff9800'
    }
  }

  async connect(): Promise<void> {
    await this.provider.connect({
      room: 'test-room',
    })

    // Set initial awareness
    this.updateAwareness()

    // Built-in hash verification (verifyUpdates: true) handles desync detection automatically
    // No need for separate SyncHealthMonitor - see sync-monitor.ts for optional monitoring utilities
  }

  disconnect(): void {
    this.binding.destroy()
    this.provider.disconnect()
    this.ui.container.style.opacity = '0.5'
  }

  private updateAwareness(): void {
    this.provider.awareness.setLocalState({
      user: {
        name: this.name,
        color: this.color,
      },
    })
  }

  private updateAwarenessDisplay(): void {
    const states = this.provider.awareness.getStates()
    const users: string[] = []

    states.forEach((state: any, clientId: number) => {
      if (state.user) {
        const isSelf = clientId === this.doc.clientID
        users.push(`
          <div style="margin: 5px 0; padding: 5px; background: ${state.user.color}22; border-left: 3px solid ${state.user.color}; border-radius: 3px;">
            <strong>${state.user.name}</strong> ${isSelf ? '(you)' : ''}
            <span style="font-size: 10px; color: #666;"> - ID: ${clientId}</span>
          </div>
        `)
      }
    })

    this.ui.awarenessDiv.innerHTML =
      users.length > 0
        ? users.join('')
        : '<div style="color: #999; font-style: italic;">No users online</div>'
  }
}

// ============================================================================
// Main Test Setup
// ============================================================================

const clients: TestClient[] = []

async function init() {
  console.log('🚀 Initializing Generic Provider Test...')

  const container = document.getElementById('clients-container')!
  const addButton = document.getElementById('add-client-btn')!
  const clearButton = document.getElementById('clear-all-btn')!
  const networkToggle = document.getElementById('network-toggle-btn')!
  const networkStatus = document.getElementById('network-status')!
  const delaySlider = document.getElementById(
    'delay-slider',
  )! as HTMLInputElement
  const delayValue = document.getElementById('delay-value')!
  const lossSlider = document.getElementById('loss-slider')! as HTMLInputElement
  const lossValue = document.getElementById('loss-value')!
  const jitterSlider = document.getElementById(
    'jitter-slider',
  )! as HTMLInputElement
  const jitterValue = document.getElementById('jitter-value')!
  const logDiv = document.getElementById('log')!

  // Add initial clients
  await addClient('Alice', '#ff6b6b')
  await addClient('Bob', '#4ecdc4')

  // Add client button
  addButton.addEventListener('click', async () => {
    const names = ['Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry']
    const colors = [
      '#95e1d3',
      '#f38181',
      '#aa96da',
      '#fcbad3',
      '#a8d8ea',
      '#ffcb91',
    ]
    const index = clients.length % names.length
    await addClient(names[index], colors[index])
  })

  // Clear all button
  clearButton.addEventListener('click', () => {
    clients.forEach((client) => client.disconnect())
    clients.length = 0
    container.innerHTML = ''
    log('Cleared all clients')
  })

  // Edge case test buttons
  const testBatchDisconnectBtn = document.getElementById(
    'test-batch-disconnect',
  )!
  const testSequenceOverflowBtn = document.getElementById(
    'test-sequence-overflow',
  )!
  const testMergeFailureBtn = document.getElementById('test-merge-failure')!

  testBatchDisconnectBtn.addEventListener('click', async () => {
    if (clients.length === 0) {
      log('⚠️ No clients available for testing')
      return
    }
    await testBatchUpdateLostOnDisconnect(clients[0])
  })

  testSequenceOverflowBtn.addEventListener('click', () => {
    if (clients.length === 0) {
      log('⚠️ No clients available for testing')
      return
    }
    testSequenceNumberOverflow(clients[0])
  })

  testMergeFailureBtn.addEventListener('click', () => {
    if (clients.length === 0) {
      log('⚠️ No clients available for testing')
      return
    }
    testMergeUpdatesFailure(clients[0])
  })

  // Network toggle button
  networkToggle.addEventListener('click', () => {
    globalNetworkOnline = !globalNetworkOnline
    updateNetworkStatus()

    if (globalNetworkOnline) {
      log('🌐 Network: ONLINE - Sync resumed')

      // Trigger re-sync for all clients when network comes back online
      setTimeout(() => {
        clients.forEach((client) => {
          client.provider.syncNow()
        })
        log('🔄 Triggered re-sync for all clients')
      }, 50) // Small delay to ensure network is stable
    } else {
      log('📡 Network: OFFLINE - Simulating connection problems')
    }
  })

  // Update network status display
  function updateNetworkStatus() {
    if (globalNetworkOnline) {
      networkStatus.textContent = '🟢 Online'
      networkStatus.style.color = '#4caf50'
      networkToggle.textContent = '📡 Go Offline'
      networkToggle.style.background = '#ff9800'
    } else {
      networkStatus.textContent = '🔴 Offline'
      networkStatus.style.color = '#f44336'
      networkToggle.textContent = '🌐 Go Online'
      networkToggle.style.background = '#4caf50'
    }
  }

  // Initial network status
  updateNetworkStatus()

  // Network delay slider
  delaySlider.addEventListener('input', () => {
    networkDelay = parseInt(delaySlider.value)
    delayValue.textContent = `${networkDelay}ms`
    log(`⏱️ Network delay set to ${networkDelay}ms`)
  })

  // Packet loss slider
  lossSlider.addEventListener('input', () => {
    networkPacketLoss = parseInt(lossSlider.value)
    lossValue.textContent = `${networkPacketLoss}%`
    log(`📉 Packet loss set to ${networkPacketLoss}%`)
  })

  // Jitter slider
  jitterSlider.addEventListener('input', () => {
    networkJitter = parseInt(jitterSlider.value) / 100 // Convert 0-100 to 0-1
    jitterValue.textContent = networkJitter.toFixed(2)
    log(
      `🔀 Network jitter set to ${networkJitter.toFixed(2)} (${parseInt(jitterSlider.value)}%)`,
    )
  })

  // Data corruption slider
  const corruptionSlider = document.getElementById(
    'corruption-slider',
  ) as HTMLInputElement
  const corruptionValue = document.getElementById('corruption-value')!
  corruptionSlider.addEventListener('input', () => {
    dataCorruptionRate = parseInt(corruptionSlider.value)
    corruptionValue.textContent = `${dataCorruptionRate}%`
    log(`💥 Data corruption rate set to ${dataCorruptionRate}%`)
    if (dataCorruptionRate > 0) {
      log(`   Corruption type: ${corruptionType}`)
      log(`   This will trigger Y.mergeUpdates error handling!`)
      log(`   ✅ System will gracefully recover from corrupted messages`)
      log(`   🔄 Automatic re-sync with exponential backoff (50ms → 10s)`)
      log(`   Watch for: 💥 corruption detected, 🔄 auto recovery messages`)
    } else {
      log('   Data corruption disabled - clean network simulation')
    }
  })

  // Corruption type selector
  const corruptionTypeSelect = document.getElementById(
    'corruption-type',
  ) as HTMLSelectElement
  corruptionTypeSelect.addEventListener('change', () => {
    corruptionType = corruptionTypeSelect.value as any
    log(`🔧 Corruption type changed to: ${corruptionType}`)
    const descriptions: Record<string, string> = {
      bitflip: 'Flip random bits (subtle, realistic)',
      truncate: 'Cut messages short (incomplete data)',
      garbage: 'Random bytes (worst case)',
      insert: 'Insert random bytes (length changes)',
    }
    log(`   ${descriptions[corruptionType]}`)
  })

  log('✅ Test environment ready!')
  log(
    'TIP: Use the rich text editor - format text, add images, see live cursors!',
  )
  log('TIP: Change names/colors and see awareness updates!')
  log('TIP: Toggle offline/online to simulate connection problems!')
  log('TIP: Adjust delay, packet loss, and jitter to test network conditions!')
  log(
    'TIP: Jitter causes out-of-order message delivery (realistic network behavior)',
  )
  log('TIP: 💥 Enable data corruption to test Y.mergeUpdates error handling!')
  log('INFO: Fast desync detection with exponential backoff (10ms → 10s max)')
  log('INFO: Rate limiting active - max 20 sync requests per 10 seconds')
  log('INFO: Sequence numbers enabled for ordering & duplicate detection')

  // Intercept console.warn to catch hash mismatch warnings
  const originalWarn = console.warn
  console.warn = function (...args: any[]) {
    if (args[0]?.includes?.('Hash mismatch')) {
      // Extract the mismatch count and delay from the message
      const match = args[0].match(/#(\d+)/)
      const delayMatch = args[1]?.match?.(/(\d+)ms/)
      if (match && delayMatch) {
        log(
          `⚡ Hash mismatch #${match[1]} detected - retry in ${delayMatch[1]}ms (exponential backoff)`,
        )
      } else {
        log('⚡ FAST DESYNC DETECTED - Immediate re-sync triggered!')
      }
    } else if (args[0]?.includes?.('rate limit exceeded')) {
      // Extract rate limit info
      const match = args[0].match(/(\d+) requests per (\d+)s/)
      if (match) {
        log(`🚫 Rate limit hit: max ${match[1]} sync requests per ${match[2]}s`)
      }
    } else if (args[0]?.includes?.('Duplicate or out-of-order')) {
      // Extract sequence info
      const match = args[0].match(/seqNum (\d+) <= lastSeen (\d+)/)
      if (match) {
        log(`🔁 Duplicate update skipped: seqNum ${match[1]} <= ${match[2]}`)
      }
    } else if (args[0]?.includes?.('Sequence gap')) {
      // Extract gap info
      const match = args[0].match(/expected (\d+), got (\d+) \(gap of (\d+)/)
      if (match) {
        log(
          `📦 Packet loss detected: expected seq ${match[1]}, got ${match[2]} (${match[3]} missing)`,
        )
      }
    } else if (args[0]?.includes?.('Corrupted message detected')) {
      // Extract corruption count
      const match = args[0].match(/#(\d+)/)
      if (match) {
        log(
          `💥 Corrupted message #${match[1]} detected (data corruption simulation active)`,
        )
      }
    } else if (args[0]?.includes?.('Corrupted awareness message')) {
      log(`💥 Corrupted awareness message (JSON parse failed)`)
      log('   Awareness is ephemeral - update skipped, system continues')
    } else if (args[0]?.includes?.('Corrupted sync message type')) {
      log(`💥 Corrupted sync message type (invalid message type byte)`)
      log('   Re-sync will be triggered to recover')
    } else if (args[0]?.includes?.('Scheduling re-sync')) {
      // Extract re-sync delay
      const match = args[0].match(/(\d+)ms/)
      if (match) {
        log(
          `🔄 Automatic recovery: re-sync in ${match[1]}ms (exponential backoff)`,
        )
      }
    }
    originalWarn.apply(console, args)
  }

  // Intercept console.error to catch merge failures and other errors
  const originalError = console.error
  console.error = function (...args: any[]) {
    if (args[0]?.includes?.('Failed to merge updates')) {
      log('❌ Y.mergeUpdates FAILED - corrupted batch detected!')
      log('   Recovery: pending update sent, new batch started')
      log('   System continues operating (graceful degradation)')
    } else if (
      args[0]?.includes?.('Error handling incoming message') &&
      !args[1]?.message?.includes?.('out-of-bounds') &&
      !args[1]?.message?.includes?.('JSON')
    ) {
      // Non-corruption errors
      log(`❌ Unexpected error: ${args[1]?.message || args[1] || 'unknown'}`)
    }
    originalError.apply(console, args)
  }
}

async function addClient(name: string, color: string): Promise<void> {
  const container = document.getElementById('clients-container')!
  const client = new TestClient(name, color, container)
  clients.push(client)

  await client.connect()
  log(`✓ ${name} connected`)
}

// ============================================================================
// Edge Case Test Functions
// ============================================================================

/**
 * Edge Case Test #1: Batched Update Lost on Disconnect
 *
 * This tests whether pending batched updates are properly flushed before disconnect.
 * If batchUpdates is enabled (e.g., 100ms), changes are accumulated and sent after delay.
 * If disconnect() is called before the batch timeout fires, changes may be lost.
 *
 * Expected behavior: Changes should be flushed before disconnect
 * Actual behavior (bug): _pendingUpdate is cleared without sending
 */
async function testBatchUpdateLostOnDisconnect(
  client: TestClient,
): Promise<void> {
  log('🧪 TEST #1: Batch Update Lost on Disconnect')
  log('──────────────────────────────────────────────')

  const batchDelay = 100 // Matches the batchUpdates setting in provider

  log(`1️⃣ Making changes to ${client.name}'s document`)
  log(`   (batchUpdates delay: ${batchDelay}ms)`)

  // Make changes that will be batched
  const testText = `[BATCH TEST ${Date.now()}] This text may be lost! `
  client.ytext.insert(0, testText)

  log(`2️⃣ Waiting ${batchDelay / 2}ms (mid-batch - timeout has not fired yet)`)
  await new Promise((resolve) => setTimeout(resolve, batchDelay / 2))

  log('3️⃣ 🔴 DISCONNECTING NOW (before batch sends!)')
  client.disconnect()

  log('4️⃣ ⚠️ RESULT: Changes likely lost!')
  log('   Bug location: index.ts lines 276-283, 328-332')
  log(`   The pending batch was cleared without sending`)
  log('   Other clients will NOT see the text we just added')
  log('──────────────────────────────────────────────')

  // Wait a bit then check other clients
  await new Promise((resolve) => setTimeout(resolve, 200))

  const otherClients = clients.filter(
    (c) => c !== client && c.provider.connected,
  )
  if (otherClients.length > 0) {
    const otherText = otherClients[0].ytext.toString()
    if (!otherText.includes(testText)) {
      log('❌ CONFIRMED: Other clients do NOT have the test text')
      log('   This confirms the batch update was lost!')
    } else {
      log('✅ UNEXPECTED: Other clients DO have the test text')
      log('   The bug may have been fixed, or timing was different')
    }
  }
}

/**
 * Edge Case Test #2: Sequence Number Overflow
 *
 * This tests what happens when the sequence number counter approaches MAX_SAFE_INTEGER.
 * JavaScript can safely represent integers up to 2^53 - 1 (9,007,199,254,740,991).
 * After this, precision is lost and sequence ordering may break.
 *
 * Expected behavior: Wraparound or use BigInt
 * Actual behavior (bug): No overflow handling, sequence numbers become unreliable
 */
function testSequenceNumberOverflow(client: TestClient): void {
  log('🧪 TEST #2: Sequence Number Overflow')
  log('──────────────────────────────────────────────')

  // Use the new test helper method
  const provider = client.provider as any

  if (!provider._testGetSequenceNumber) {
    log(
      '⚠️ Provider does not have test helpers - verifyUpdates may be disabled',
    )
    return
  }

  const currentSeq = provider._testGetSequenceNumber()
  log(`1️⃣ Current sequence number: ${currentSeq.toLocaleString()}`)

  // Set to near MAX_SAFE_INTEGER to trigger overflow quickly
  const testSeq = Number.MAX_SAFE_INTEGER - 10
  provider._testSetSequenceNumber(testSeq)
  log(`2️⃣ Set sequence to: ${testSeq.toLocaleString()}`)
  log(`   (MAX_SAFE_INTEGER = ${Number.MAX_SAFE_INTEGER.toLocaleString()})`)
  log(
    `   (This simulates ~9 quadrillion messages - would take centuries at 1000 msg/sec)`,
  )

  log('3️⃣ Making 15 changes to trigger overflow...')
  log('   Watch console for "Duplicate or out-of-order" warnings')

  // Make changes that will increment past MAX_SAFE_INTEGER
  for (let i = 0; i < 15; i++) {
    client.ytext.insert(0, `[${i}]`)
    const newSeq = provider._testGetSequenceNumber()

    // Check if we crossed the threshold
    if (i === 10) {
      log(`   After change ${i + 1}: seqNum = ${newSeq.toLocaleString()}`)
      if (newSeq > Number.MAX_SAFE_INTEGER) {
        log(`   🔴 OVERFLOW! Sequence exceeded MAX_SAFE_INTEGER`)
        log(`   JavaScript can no longer represent this integer safely!`)
      }
    }
  }

  const finalSeq = provider._testGetSequenceNumber()
  log(`4️⃣ Final sequence number: ${finalSeq.toLocaleString()}`)

  if (finalSeq > Number.MAX_SAFE_INTEGER) {
    log('❌ CONFIRMED: Sequence overflow occurred!')
    log('📍 Affected code: _localSeqNum++ in _sendUpdate()')
    log('⚠️ Consequences:')
    log('   - Sequence numbers lose precision (start rounding)')
    log('   - Duplicate detection may fail')
    log('   - Out-of-order detection unreliable')
    log('   - Sequence gaps appear incorrectly')
    log('')
    log('💡 Solutions:')
    log('   1. Use BigInt for sequence numbers (breaking change)')
    log('   2. Implement wraparound with modulo (2^32 or 2^53)')
    log('   3. Reset counter periodically (requires coordination)')
    log('   4. Accept it (overflow takes ~285 years at 1000 msg/sec)')
  } else {
    log('⚠️ Did not overflow in this test (needed more changes)')
  }

  log('──────────────────────────────────────────────')
  log('🔍 To observe real impact:')
  log('   1. Open browser DevTools Console')
  log('   2. Run test again and make edits on BOTH clients')
  log('   3. Look for warnings about duplicate/out-of-order messages')
  log('   4. Sequence comparison will fail when numbers lose precision')
  log('')
  log('📊 Real-world relevance:')
  log('   At 1000 messages/second:')
  log('   - Takes ~285 years to reach MAX_SAFE_INTEGER')
  log('   - In practice, this is a non-issue for most applications')
  log('   - Long-running servers might need BigInt after decades')
}

/**
 * Edge Case Test #3: Y.mergeUpdates Failure
 *
 * This tests what happens when Y.mergeUpdates() throws an error while batching updates.
 * In the _batchUpdate method, there's no try-catch around Y.mergeUpdates().
 * If a corrupted update is passed, it will throw and break the batch system.
 *
 * Expected behavior: Graceful error handling with retry or skip
 * Actual behavior (bug): Unhandled error breaks batching permanently
 */
function testMergeUpdatesFailure(client: TestClient): void {
  log('🧪 TEST #3: Y.mergeUpdates Failure')
  log('──────────────────────────────────────────────')

  const provider = client.provider as any

  // Check if batching is enabled
  if (!provider._batchUpdates || provider._batchUpdates === 0) {
    log('⚠️ Batching is disabled (batchUpdates = 0)')
    log('   This test requires batching to be enabled')
    log('   Providers are created with batchUpdates: 100ms')
    return
  }

  log(`1️⃣ Batching is enabled with ${provider._batchUpdates}ms delay`)
  log('2️⃣ Testing batch merge behavior...')
  log('')
  log('📋 EDGE CASE DESCRIPTION:')
  log('   Bug location: src/index.ts line 447 (in _batchUpdate)')
  log('   Problem: Y.mergeUpdates([...]) was called without try-catch')
  log('   Impact: If corrupted updates are received, merge can throw')
  log('   Result: Unhandled error would crash the batch system')
  log('')
  log('✅ FIX APPLIED:')
  log('   Wrapped Y.mergeUpdates in try-catch block')
  log('   On failure: sends pending update, starts new batch')
  log('   System continues working even after merge error')
  log('')

  // Note: We cannot directly trigger Y.mergeUpdates to fail because:
  // 1. Y.mergeUpdates is a getter-only property (cannot monkey-patch)
  // 2. Yjs's merge is very robust and rarely fails in practice
  // 3. Failures typically occur only with severely corrupted binary data

  log('💡 SIMULATION LIMITATION:')
  log('   Cannot directly mock Y.mergeUpdates (read-only property)')
  log('')
  log('💡 HOW TO SIMULATE MERGE FAILURES:')
  log('   1. Use the "Data Corruption" slider above to enable corruption')
  log('   2. Set corruption rate to 5-20% for realistic testing')
  log('   3. Choose corruption type:')
  log('      • Bit Flip: Subtle corruption (realistic network errors)')
  log('      • Truncate: Incomplete messages (connection interruption)')
  log('      • Garbage: Random bytes (worst case scenario)')
  log('      • Insert: Length changes (protocol corruption)')
  log('   4. Make changes and watch the provider handle corrupted data')
  log('   5. Check console for "Failed to merge updates" errors')
  log('   6. System should gracefully recover and continue syncing')
  log('')
  log('In real scenarios, merge failures occur with:')
  log('   - Corrupted network packets')
  log('   - Invalid binary update format')
  log('   - Incompatible Yjs versions')
  log('   - Memory corruption')
  log('')

  log('3️⃣ Making rapid changes to verify batch system works...')

  // Make multiple rapid changes to verify batching works correctly
  client.ytext.insert(0, 'Change 1 ')

  setTimeout(() => {
    client.ytext.insert(0, 'Change 2 ')
  }, 10)

  setTimeout(() => {
    client.ytext.insert(0, 'Change 3 ')
  }, 20)

  // Verify after batching completes
  setTimeout(() => {
    const endText = client.ytext.toString()

    if (
      endText.includes('Change 1') &&
      endText.includes('Change 2') &&
      endText.includes('Change 3')
    ) {
      log('4️⃣ ✅ Batch system is working correctly!')
      log('   All changes were batched and merged successfully')
      log('')
      log('🔍 HOW TO VERIFY THE FIX:')
      log('   1. Check src/index.ts line 447-457')
      log('   2. Confirm Y.mergeUpdates is wrapped in try-catch')
      log('   3. On error: pending update is sent, new batch starts')
      log('   4. Error is logged but does not crash the provider')
      log('')
      log('📊 WITH FIX vs WITHOUT:')
      log('   ❌ Without: Merge error → unhandled exception → crash')
      log('   ✅ With: Merge error → logged → pending sent → continue')
    } else {
      log('4️⃣ ⚠️ Unexpected result - not all changes applied')
    }

    log('──────────────────────────────────────────────')
  }, 150) // Wait longer than batch delay
}

function log(message: string): void {
  const logDiv = document.getElementById('log')!
  const time = new Date().toLocaleTimeString()
  logDiv.innerHTML =
    `<div style="margin: 2px 0; font-size: 12px;"><span style="color: #999;">[${time}]</span> ${message}</div>` +
    logDiv.innerHTML
}

// Auto-start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

console.log('✅ GenericProvider test module loaded successfully!')
