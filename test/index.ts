import * as Y from 'yjs'
import { GenericProvider } from '../src/exports'
import type { Transport, ConnectionConfig } from '../src/transport'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'

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

        // Simulate variable network delay (±50% variance)
        const variance = networkDelay * 0.5
        const actualDelay =
          networkDelay + (Math.random() * variance * 2 - variance)

        setTimeout(() => {
          // Check network status again after delay (both global and target client)
          if (globalNetworkOnline && !dummy.clientOffline) {
            dummy.messageCallback?.(data)
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
    this.transport = new Dummy()
    this.provider = new GenericProvider(this.doc, this.transport, {
      batchUpdates: 100, // Optional: batch updates for 100ms to reduce traffic
      syncInterval: 2000, // Retry sync every 2 seconds to handle packet loss
      verifyUpdates: true, // Send hash with each update for immediate desync detection
      // batchUpdates: 100, // Optional: batch updates for 100ms to reduce traffic
    })

    // Create UI
    this.ui = this.createUI(container)

    // Initialize Quill editor
    this.quill = new Quill(this.ui.editorContainer, {
      theme: 'snow',
      placeholder: 'Type here... changes sync automatically!',
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link', 'image', 'code-block'],
          ['clean'],
        ],
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

  log('✅ Test environment ready!')
  log(
    'TIP: Use the rich text editor - format text, add images, see live cursors!',
  )
  log('TIP: Change names/colors and see awareness updates!')
  log('TIP: Toggle offline/online to simulate connection problems!')
  log('TIP: Adjust delay and packet loss to test network conditions!')
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
    }
    originalWarn.apply(console, args)
  }
}

async function addClient(name: string, color: string): Promise<void> {
  const container = document.getElementById('clients-container')!
  const client = new TestClient(name, color, container)
  clients.push(client)

  await client.connect()
  log(`✓ ${name} connected`)
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
