/**
 * SimplePeer Provider Test
 *
 * This demo shows peer-to-peer synchronization using simple-peer (WebRTC).
 * Open this page in multiple browser tabs/windows to test collaboration.
 */

import * as Y from 'yjs'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import QuillCursors from 'quill-cursors'
import { GenericProvider } from '../../src/index'
import {
  SimplePeerTransport,
  type IceServer,
} from '../../src/providers/simple-peer/index'

const BlockEmbed = Quill.import('blots/block/embed') as any

// Register QuillCursors module for collaborative cursors
Quill.register('modules/cursors', QuillCursors)

// Peer is loaded from CDN as a global variable
declare const SimplePeer: any

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

// Configuration
const ROOM_NAME = 'simple-peer-test'
const CONFIG_STORAGE_KEY = 'simplepeer-config'

// Generate random user ID
const userId = Math.random().toString(36).substring(7)

// Default configuration
const defaultConfig: {
  signaling: string[]
  iceServers: IceServer[]
} = {
  // Use official y-webrtc signaling server (most reliable)
  signaling: ['wss://signaling.yjs.dev'],
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
}

// Load configuration from localStorage or use defaults
function loadConfig(): typeof defaultConfig {
  try {
    const stored = localStorage.getItem(CONFIG_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      log('📁 Loaded configuration from localStorage', 'info')
      return parsed
    }
  } catch (error) {
    console.error('Failed to load config from localStorage:', error)
  }
  return defaultConfig
}

// Save configuration to localStorage
function saveConfig(config: typeof defaultConfig): void {
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config))
    log('💾 Configuration saved to localStorage', 'success')
  } catch (error) {
    console.error('Failed to save config to localStorage:', error)
  }
}

// Configuration state
let currentConfig = loadConfig()

// Populate configuration form fields with current config
function populateConfigForm(): void {
  const signalingInput = document.getElementById(
    'signaling-servers',
  ) as HTMLTextAreaElement
  const stunInput = document.getElementById(
    'stun-servers',
  ) as HTMLTextAreaElement
  const turnInput = document.getElementById(
    'turn-servers',
  ) as HTMLTextAreaElement

  if (!signalingInput || !stunInput || !turnInput) {
    return // Form not ready yet
  }

  // Populate signaling servers
  signalingInput.value = currentConfig.signaling.join('\n')

  // Separate STUN and TURN servers
  const stunServers: string[] = []
  const turnServers: string[] = []

  for (const server of currentConfig.iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    for (const url of urls) {
      if (url.startsWith('stun:')) {
        stunServers.push(url)
      } else if (url.startsWith('turn:')) {
        // TURN server - format as JSON
        turnServers.push(JSON.stringify(server))
        break // Only add once per server object
      }
    }
  }

  stunInput.value = stunServers.join('\n')
  turnInput.value = turnServers.join('\n')

  log('📝 Configuration form populated', 'info')
}

// Configuration UI functions
;(window as any).toggleConfig = () => {
  const content = document.getElementById('config-content')!
  const toggle = document.querySelector('.config-toggle')!
  content.classList.toggle('expanded')
  toggle.classList.toggle('collapsed')
}
;(window as any).applyConfig = () => {
  const signalingInput = document.getElementById(
    'signaling-servers',
  ) as HTMLTextAreaElement
  const stunInput = document.getElementById(
    'stun-servers',
  ) as HTMLTextAreaElement
  const turnInput = document.getElementById(
    'turn-servers',
  ) as HTMLTextAreaElement

  try {
    // Parse signaling servers
    const signaling = signalingInput.value
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    if (signaling.length === 0) {
      alert('Please provide at least one signaling server')
      return
    }

    // Parse STUN servers
    const stunServers = stunInput.value
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((url) => ({ urls: url }))

    // Parse TURN servers
    const turnLines = turnInput.value
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    const turnServers = []
    for (const line of turnLines) {
      try {
        const turnConfig = JSON.parse(line)
        if (!turnConfig.urls) {
          throw new Error('TURN config must have "urls" field')
        }
        turnServers.push(turnConfig)
      } catch (error) {
        alert(`Invalid TURN server config: ${line}\n\nError: ${error}`)
        return
      }
    }

    // Combine ICE servers
    const iceServers = [...stunServers, ...turnServers]

    if (iceServers.length === 0) {
      alert('Please provide at least one STUN or TURN server')
      return
    }

    // Update config
    const newConfig = { signaling, iceServers }

    // Save to localStorage
    saveConfig(newConfig)
    currentConfig = newConfig

    log('✅ Configuration updated and saved!', 'success')
    log(`Signaling servers: ${signaling.length}`, 'info')
    log(`STUN servers: ${stunServers.length}`, 'info')
    log(`TURN servers: ${turnServers.length}`, 'info')
    log('⏳ Reloading page to apply changes...', 'info')

    // Reload page after a short delay to show the log messages
    setTimeout(() => {
      window.location.reload()
    }, 1000)
  } catch (error) {
    alert(`Error parsing configuration: ${error}`)
  }
}
;(window as any).resetConfig = () => {
  if (confirm('Reset configuration to defaults?')) {
    const signalingInput = document.getElementById(
      'signaling-servers',
    ) as HTMLTextAreaElement
    const stunInput = document.getElementById(
      'stun-servers',
    ) as HTMLTextAreaElement
    const turnInput = document.getElementById(
      'turn-servers',
    ) as HTMLTextAreaElement

    signalingInput.value = 'wss://signaling.yjs.dev\nwss://0.peerjs.com/peerjs'
    stunInput.value =
      'stun:stun.l.google.com:19302\nstun:stun1.l.google.com:19302'
    turnInput.value = ''

    // Save default config
    saveConfig(defaultConfig)
    currentConfig = defaultConfig

    log('✅ Configuration reset to defaults', 'success')
    log('⏳ Reloading page to apply changes...', 'info')

    // Reload page after a short delay
    setTimeout(() => {
      window.location.reload()
    }, 1000)
  }
}

// Log function
function log(message: string, type: 'info' | 'success' | 'error' = 'info') {
  const logEl = document.getElementById('log')!
  const time = new Date().toLocaleTimeString()
  const colors = {
    info: '#2196f3',
    success: '#4caf50',
    error: '#f44336',
  }

  const entry = document.createElement('div')
  entry.className = 'log-entry'
  entry.innerHTML = `<span class="log-time">[${time}]</span><span style="color: ${colors[type]}">${message}</span>`
  logEl.appendChild(entry)

  // Auto-scroll to bottom
  const logContainer = document.getElementById('log-container')!
  logContainer.scrollTop = logContainer.scrollHeight

  // Keep only last 50 entries
  if (logEl.children.length > 50) {
    logEl.removeChild(logEl.children[0])
  }
}

// Update status indicators
function updateStatus(
  status: 'connected' | 'disconnected' | 'connecting',
  message: string,
) {
  const indicator = document.getElementById('connection-indicator')!
  const statusEl = document.getElementById('connection-status')!

  indicator.className = `status-indicator ${status}`
  statusEl.textContent = message
}

function updatePeerCount(count: number) {
  const peerCountEl = document.getElementById('peer-count')!
  peerCountEl.textContent = count.toString()
}

function updateSyncStatus(synced: boolean) {
  const syncStatusEl = document.getElementById('sync-status')!
  if (synced) {
    syncStatusEl.innerHTML = '✅ Synced'
    syncStatusEl.style.color = '#4caf50'
  } else {
    syncStatusEl.innerHTML = '⏳ Syncing...'
    syncStatusEl.style.color = '#ff9800'
  }
}

// Update awareness user list
function updateUserList(awareness: any) {
  const userListEl = document.getElementById('user-list')!
  const states = Array.from(awareness.getStates().entries())

  if (states.length === 0) {
    userListEl.innerHTML = `
      <div class="user-badge">
        <div class="color-dot" style="background: #999"></div>
        <span style="color: #999">No users yet</span>
      </div>
    `
    return
  }

  userListEl.innerHTML = states
    .map((entry) => {
      const [clientId, state] = entry as [number, any]
      const user = state.user || {}
      const name = user.name || `User ${clientId}`
      const color = user.color || '#999'
      const isMe = clientId === awareness.clientID

      return `
        <div class="user-badge">
          <div class="color-dot" style="background: ${color}"></div>
          <span>${name}${isMe ? ' (You)' : ''}</span>
        </div>
      `
    })
    .join('')
}

// Initialize
async function init() {
  log('🚀 Initializing SimplePeer test...', 'info')

  // Create Yjs document
  const doc = new Y.Doc()
  const yText = doc.getText('quill')

  // Create SimplePeer transport
  log('📡 Creating SimplePeer transport...', 'info')
  log(`📋 Configuration:`, 'info')
  log(`  • Signaling servers: ${currentConfig.signaling.length}`, 'info')
  currentConfig.signaling.forEach((s) => log(`    - ${s}`, 'info'))
  log(`  • ICE servers: ${currentConfig.iceServers.length}`, 'info')
  currentConfig.iceServers.forEach((ice) => {
    const urls = Array.isArray(ice.urls) ? ice.urls : [ice.urls]
    urls.forEach((url) => {
      if (ice.username) {
        log(`    - ${url} (auth: ${ice.username})`, 'info')
      } else {
        log(`    - ${url}`, 'info')
      }
    })
  })

  const transport = new SimplePeerTransport({
    peer: SimplePeer, // Pass the simple-peer constructor
    signaling: currentConfig.signaling,
    iceServers: currentConfig.iceServers,
    debug: false, // Enable debug logging in console
  })

  // Create provider
  const provider = new GenericProvider(doc, transport)

  // Listen to status changes
  provider.on('status', (event: any) => {
    const status = event.state
    log(`Status changed: ${status}`, 'info')

    if (status === 'connected') {
      updateStatus('connected', '✅ Connected')
    } else if (status === 'disconnected') {
      updateStatus('disconnected', '❌ Disconnected')
    } else {
      updateStatus('connecting', '⏳ Connecting...')
    }
  })

  // Listen to sync changes
  provider.on('synced', (event: any) => {
    const synced = event.synced
    updateSyncStatus(synced)

    if (synced) {
      log('✅ Document synchronized!', 'success')
    }
  })

  // Initialize Quill editor
  log('📝 Initializing editor...', 'info')
  const quill = new Quill('#editor', {
    theme: 'snow',
    placeholder: 'Start typing... Your changes will sync with other peers!',
    modules: {
      cursors: true,
      toolbar: {
        container: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          ['blockquote', 'code-block'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          [{ color: [] }, { background: [] }],
          ['link', 'image', 'video'],
          ['clean'],
        ],
        handlers: {
          image: imageHandler,
          video: videoHandler,
        },
      },
    },
  })

  // Bind Quill to Yjs
  const binding = new QuillBinding(yText, quill, provider.awareness)
  log('✅ Editor bound to Yjs', 'success')

  // Setup user controls
  const userNameInput = document.getElementById('user-name') as HTMLInputElement
  const userColorInput = document.getElementById(
    'user-color',
  ) as HTMLInputElement

  // Generate random name and color
  const randomNames = [
    '👨‍💻 Alice',
    '👩‍💻 Bob',
    '🧑‍💻 Charlie',
    '👨‍🔬 David',
    '👩‍🔬 Eve',
    '🧑‍🎨 Frank',
  ]
  const randomColors = [
    '#3498db',
    '#e74c3c',
    '#2ecc71',
    '#f39c12',
    '#9b59b6',
    '#1abc9c',
  ]
  const randomName = randomNames[Math.floor(Math.random() * randomNames.length)]
  const randomColor =
    randomColors[Math.floor(Math.random() * randomColors.length)]

  userNameInput.value = randomName
  userColorInput.value = randomColor

  // Set initial awareness state
  provider.awareness.setLocalStateField('user', {
    name: randomName,
    color: randomColor,
  })

  // Update awareness on user input
  userNameInput.addEventListener('input', () => {
    const currentState = provider.awareness.getLocalState()?.user || {}
    provider.awareness.setLocalStateField('user', {
      ...currentState,
      name: userNameInput.value,
    })
    log(`👤 Changed name to: ${userNameInput.value}`, 'info')
  })

  userColorInput.addEventListener('change', () => {
    const currentState = provider.awareness.getLocalState()?.user || {}
    provider.awareness.setLocalStateField('user', {
      ...currentState,
      color: userColorInput.value,
    })
    log(`🎨 Changed color to: ${userColorInput.value}`, 'info')
  })

  // Update user list when awareness changes
  provider.awareness.on('change', () => {
    updateUserList(provider.awareness)
  })

  // Initial user list update
  updateUserList(provider.awareness)

  // Setup pub/sub chat
  setupPubSubChat(provider)

  // Monitor peer count (check transport periodically)
  setInterval(() => {
    if (transport.isConnected) {
      // Access the transport's peer count if available
      const peerCount = (transport as any).peers?.size || 0
      updatePeerCount(peerCount)
    }
  }, 1000)

  // Connect to room
  log(`🌐 Connecting to room: ${ROOM_NAME}...`, 'info')
  try {
    await provider.connect({ room: ROOM_NAME })
    log('✅ Successfully joined room!', 'success')

    // Check if we actually have WebRTC peers
    setTimeout(() => {
      const peerCount = (transport as any).peers?.size || 0
      const signalingCount = (transport as any).signalingConns?.length || 0

      if (signalingCount === 0) {
        log(
          '⚠️ No signaling servers connected. Running in BroadcastChannel-only mode.',
          'info',
        )
        log(
          '💡 Open this page in multiple TABS (same browser) to test cross-tab sync!',
          'info',
        )
        updateStatus('connected', '🔄 Local tabs only (BroadcastChannel)')
      } else if (peerCount === 0) {
        log(
          '⚠️ No WebRTC peers yet. Waiting for other browsers to join...',
          'info',
        )
        updateStatus('connected', '⏳ Waiting for peers...')
      }
    }, 2000)
  } catch (error) {
    log(`❌ Failed to connect: ${error}`, 'error')
    updateStatus('disconnected', '❌ Connection failed')
  }

  // Handle page unload
  window.addEventListener('beforeunload', () => {
    provider.disconnect()
  })

  // Populate configuration form with current settings
  populateConfigForm()

  log('✅ Setup complete! Ready to collaborate.', 'success')
}

// Image upload handler
function imageHandler(this: any) {
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
        log('📸 Image uploaded', 'success')
      }
      reader.readAsDataURL(file)
    }
  }
}

// Video upload handler
function videoHandler(this: any) {
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
        log(
          `❌ Unsupported video format: ${file.type}. Please use MP4, WebM, or OGG.`,
          'error',
        )
        return
      }

      log(
        `📹 Uploading ${file.type} video (${(file.size / 1024 / 1024).toFixed(2)} MB)...`,
        'info',
      )

      const reader = new FileReader()
      reader.onload = (e) => {
        const range = this.quill.getSelection(true)
        this.quill.insertEmbed(range.index, 'video', e.target?.result)
        this.quill.setSelection(range.index + 1)
        log('🎬 Video uploaded', 'success')
      }
      reader.onerror = () => {
        log('❌ Failed to read video file', 'error')
      }
      reader.readAsDataURL(file)
    }
  }
}

// Setup pub/sub chat functionality
function setupPubSubChat(provider: GenericProvider) {
  const chatInput = document.getElementById('chat-input') as HTMLInputElement
  const chatSend = document.getElementById('chat-send') as HTMLButtonElement
  const chatMessages = document.getElementById('chat-messages')!

  // Get user info from awareness
  const getUserInfo = () => {
    const localState = provider.awareness.getLocalState()?.user
    return {
      userName: localState?.name || 'Anonymous',
      userColor: localState?.color || '#999',
    }
  }

  // Subscribe to chat messages
  provider.pubsub.subscribe('chat', (msg: any) => {
    addChatMessage(msg)
  })

  // Send chat message
  const sendMessage = () => {
    const text = chatInput.value.trim()
    if (text) {
      const { userName, userColor } = getUserInfo()

      // Publish via pub/sub channel
      provider.pubsub.publish('chat', {
        user: userName,
        color: userColor,
        text: text,
        timestamp: Date.now(),
      })
      chatInput.value = ''
      log(`💬 Sent chat message via pub/sub`, 'info')
    }
  }

  // Add chat message to display
  function addChatMessage(msg: any) {
    // Clear placeholder if this is first message
    if (chatMessages.querySelector('div[style*="color: #999"]')) {
      chatMessages.innerHTML = ''
    }

    const messageEl = document.createElement('div')
    messageEl.style.cssText = `
      padding: 8px;
      border-left: 3px solid ${msg.color || '#999'};
      margin-bottom: 8px;
      background: #f8f9fa;
      border-radius: 4px;
    `

    const time = new Date(msg.timestamp).toLocaleTimeString()
    messageEl.innerHTML = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
        <strong style="color: ${msg.color || '#333'};">${msg.user || 'Anonymous'}</strong>
        <span style="color: #999; font-size: 11px;">${time}</span>
      </div>
      <div style="color: #333;">${escapeHtml(msg.text)}</div>
    `

    chatMessages.appendChild(messageEl)
    chatMessages.scrollTop = chatMessages.scrollHeight
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  // Event listeners
  chatSend.addEventListener('click', sendMessage)
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendMessage()
    }
  })

  log('💬 Pub/Sub chat ready!', 'success')
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
