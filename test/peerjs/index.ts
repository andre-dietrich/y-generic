/**
 * PeerJS Provider Test
 *
 * This demo shows peer-to-peer synchronization using PeerJS.
 * Open this page in multiple browser tabs/windows to test collaboration.
 */

import * as Y from 'yjs'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import Peer from 'peerjs'
import { GenericProvider } from '../../src/index'
import { PeerJSTransport } from '../../src/providers/peerjs/index'

const BlockEmbed = Quill.import('blots/block/embed') as any

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
const ROOM_NAME = 'peerjs-test'

// Generate random user ID
const userId = Math.random().toString(36).substring(7)

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
    .map(([clientId, state]: [any, any]) => {
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

// Initialize
async function init() {
  log('🚀 Initializing PeerJS test...', 'info')

  // Create Yjs document
  const doc = new Y.Doc()
  const yText = doc.getText('quill')

  // Create PeerJS transport
  log('📡 Creating PeerJS transport...', 'info')
  const transport = new PeerJSTransport({
    peer: Peer, // Pass the PeerJS constructor
    debug: true, // Enable debug logging in console
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
      const peerCount = (transport as any).peers?.size || 0
      updatePeerCount(peerCount)
    }
  }, 1000)

  // Connect to room
  log(`🌐 Connecting to room: ${ROOM_NAME}...`, 'info')
  try {
    await provider.connect({ room: ROOM_NAME })
    log('✅ Successfully joined room!', 'success')

    // Check peer discovery status
    setTimeout(() => {
      const peerCount = (transport as any).peers?.size || 0

      if (peerCount === 0) {
        log(
          '💡 Open this page in multiple TABS to test cross-tab sync!',
          'info',
        )
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

  log('✅ Setup complete! Ready to collaborate.', 'success')
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
