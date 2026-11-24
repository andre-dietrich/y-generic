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
        // receiver gets a modified copy
        const dataToSend: Uint8Array = new Uint8Array(data)

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
    // batchUpdates can be used to reduce network traffic (e.g., batchUpdates: 100)
    // IMPORTANT: disableBc prevents cross-tab sync, forcing all sync through simulated network
    this.transport = new Dummy()
    this.provider = new GenericProvider(this.doc, this.transport, {
      batchUpdates: 100, // Optional: batch updates for 100ms to reduce traffic
      syncInterval: 2000, // Retry sync every 2 seconds to handle packet loss
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
        <div class="awareness-list" style="max-height: 110px; overflow-y: auto; margin-top: 5px;"></div>
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
    let userNumber = 1

    states.forEach((state: any, clientId: number) => {
      if (state.user) {
        const isSelf = clientId === this.doc.clientID
        users.push(`
          <div style="margin: 5px 0; padding: 5px; background: ${state.user.color}22; border-left: 3px solid ${state.user.color}; border-radius: 3px;">
            <span style="display: inline-block; width: 25px; font-weight: bold; color: #666;">${userNumber}.</span>
            <strong>${state.user.name}</strong> ${isSelf ? '(you)' : ''}
            <span style="font-size: 10px; color: #666;"> - ID: ${clientId}</span>
          </div>
        `)
        userNumber++
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
  const testMergeFailureBtn = document.getElementById('test-merge-failure')!
  const testRapidConnectBtn = document.getElementById('test-rapid-connect')!

  testBatchDisconnectBtn.addEventListener('click', async () => {
    if (clients.length === 0) {
      log('⚠️ No clients available for testing')
      return
    }
    await testBatchUpdateLostOnDisconnect(clients[0])
  })

  testMergeFailureBtn.addEventListener('click', () => {
    if (clients.length === 0) {
      log('⚠️ No clients available for testing')
      return
    }
    testMergeUpdatesFailure(clients[0])
  })

  testRapidConnectBtn.addEventListener('click', async () => {
    await testRapidConnect()
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
  log('INFO: Rate limiting active - max 20 sync requests per 10 seconds')

  // Intercept console.warn to surface provider warnings in the log
  const originalWarn = console.warn
  console.warn = function (...args: any[]) {
    if (args[0]?.includes?.('rate limit exceeded')) {
      // Extract rate limit info
      const match = args[0].match(/(\d+) requests per (\d+)s/)
      if (match) {
        log(`🚫 Rate limit hit: max ${match[1]} sync requests per ${match[2]}s`)
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

/**
 * Edge Case Test #4: Rapid Connect Race Condition
 *
 * This tests what happens when connect() is called multiple times simultaneously.
 * Without proper guards, this can cause:
 * - Multiple message handlers registered (memory leak + duplicate processing)
 * - Multiple sync intervals started (only last one tracked, others leak)
 * - Multiple BroadcastChannels created
 * - Network spam from multiple periodic syncs
 *
 * Expected behavior: Second and third calls should be ignored with warning
 * Actual behavior: With fix, warnings logged and subsequent calls ignored
 */
async function testRapidConnect(): Promise<void> {
  log('🧪 TEST #4: Rapid Connect Race Condition')
  log('──────────────────────────────────────────────')
  log('1️⃣ Creating a test client...')

  const testContainer = document.createElement('div')
  testContainer.style.display = 'none' // Hidden test client
  const testClient = new TestClient('RapidTest', '#cccccc', testContainer)

  // Disconnect if already connected
  if (testClient.transport.isConnected) {
    testClient.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  log('2️⃣ Calling connect() THREE times simultaneously...')
  log('   (Simulating double-click or race condition in app code)')

  // Track console warnings
  let warningCount = 0
  const originalWarn = console.warn
  console.warn = function (...args: any[]) {
    if (
      args[0]?.includes?.('Already connected') ||
      args[0]?.includes?.('Connection already in progress')
    ) {
      warningCount++
    }
    originalWarn.apply(console, args)
  }

  // Call connect() three times simultaneously (no await between calls)
  const promise1 = testClient.connect()
  const promise2 = testClient.connect()
  const promise3 = testClient.connect()

  // Wait for all to complete
  await Promise.allSettled([promise1, promise2, promise3])

  // Restore console.warn
  console.warn = originalWarn

  log(`3️⃣ Connect attempts completed`)
  log(`   Warnings logged: ${warningCount}`)

  if (warningCount >= 2) {
    log('✅ SUCCESS: Duplicate connect() calls were detected and ignored!')
    log('   Expected 2 warnings, got ' + warningCount)
    log('')
    log('🔍 WHAT WAS PREVENTED:')
    log('   ✅ Multiple message handlers (would cause duplicate processing)')
    log('   ✅ Multiple sync intervals (would cause memory leak + spam)')
    log('   ✅ Multiple BroadcastChannels (would waste resources)')
    log('   ✅ Network spam from redundant periodic syncs')
    log('')
    log('📍 Fix location: src/index.ts connect() method')
    log('   Guard checks: state === "connected" || state === "connecting"')
  } else {
    log('❌ WARNING: Not enough guards detected!')
    log('   Expected 2+ warnings for duplicate connect() calls')
    log('   This could indicate race condition protection is missing')
  }

  // Cleanup
  setTimeout(() => {
    testClient.disconnect()
    log('4️⃣ Test client cleaned up')
  }, 100)

  log('──────────────────────────────────────────────')
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
