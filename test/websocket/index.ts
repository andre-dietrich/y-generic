/**
 * WebSocket Provider Test
 *
 * This demo shows real-time synchronization using WebSocket connections.
 * Configure your WebSocket server and connect to start collaboration.
 */

import * as Y from 'yjs'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import QuillCursors from 'quill-cursors'
import { GenericProvider } from '../../src/index'
import { WebSocketTransport } from '../../src/providers/websocket/index'
import {
  registerMediaBlots,
  imageHandler as sharedImageHandler,
  videoHandler as sharedVideoHandler,
} from '../shared/quill-media.js'
import { log, updateStatus, updateSyncStatus } from '../shared/ui-helpers.js'

// Register custom Quill blots
registerMediaBlots()

// Register QuillCursors module for collaborative cursors
Quill.register('modules/cursors', QuillCursors)

// Update awareness user list
function updateUserList(awareness: any) {
  const usersList = document.getElementById('users-list')!
  const states = Array.from(awareness.getStates().entries())

  // Filter out local user
  const otherUsers = states.filter(
    ([clientId]: any) => clientId !== awareness.clientID,
  )

  if (otherUsers.length === 0) {
    usersList.innerHTML = '<li>No other users online</li>'
    return
  }

  // Escape HTML to prevent XSS
  const escapeHtml = (text: string): string => {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  usersList.innerHTML = otherUsers
    .map(([clientId, state]: any) => {
      const user = state.user || {}
      const name = user.name || `User ${clientId}`
      const color = user.color || '#999'

      return `
        <li>
          <div class="user-color" style="background-color: ${color}"></div>
          <span>${escapeHtml(name)}</span>
        </li>
      `
    })
    .join('')
}

// Image handler
function imageHandler(this: any) {
  sharedImageHandler.call(this, log)
}

// Video handler
function videoHandler(this: any) {
  sharedVideoHandler.call(this, log)
}

// Setup chat functionality
function setupChat(provider: GenericProvider) {
  const chatInput = document.getElementById('chat-input') as HTMLInputElement
  const chatSend = document.getElementById('chat-send') as HTMLButtonElement
  const chatMessages = document.getElementById('chat-messages')!

  // Create pub/sub channel for chat
  const chatChannel = provider.doc.getArray('chat')

  // Listen for chat messages
  chatChannel.observe(() => {
    const messages = chatChannel.toArray()
    chatMessages.innerHTML = messages
      .map((msg: any) => {
        const time = new Date(msg.time).toLocaleTimeString()
        const color = msg.color || '#999'
        return `
          <div class="chat-message">
            <div class="sender" style="color: ${color}">
              ${escapeHtml(msg.name)} <span style="color: #999; font-size: 11px">${time}</span>
            </div>
            <div>${escapeHtml(msg.text)}</div>
          </div>
        `
      })
      .join('')
    chatMessages.scrollTop = chatMessages.scrollHeight
  })

  // Send message
  const sendMessage = () => {
    const text = chatInput.value.trim()
    if (!text) return

    const user = provider.awareness.getLocalState()?.user || {}
    chatChannel.push([
      {
        text,
        name: user.name || 'Anonymous',
        color: user.color || '#999',
        time: Date.now(),
      },
    ])

    chatInput.value = ''
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

// Update peer count
function updatePeerCount(count: number) {
  const peerCountEl = document.getElementById('peer-count')!
  peerCountEl.textContent = count.toString()
}

// Initialize with user configuration
async function initWithConfig(config: {
  serverUrl: string
  room: string
  autoReconnect: boolean
  reconnectDelay: number
  debug: boolean
}) {
  log('🚀 Initializing WebSocket test...', 'info')
  log(
    `📋 Configuration: Server="${config.serverUrl}", Room="${config.room}", AutoReconnect=${config.autoReconnect}`,
    'info',
  )

  // Update room badge
  const roomBadge = document.getElementById('room-badge')!
  roomBadge.textContent = `Room: ${config.room}`

  // Create Yjs document
  const doc = new Y.Doc()
  const yText = doc.getText('quill')

  // Create WebSocket transport
  log('🔌 Creating WebSocket transport...', 'info')

  const transport = new WebSocketTransport()

  // Create provider
  // IMPORTANT: verifyUpdates must be false for y-websocket compatibility
  // y-websocket uses message type 3 for "messageQueryAwareness" but GenericProvider
  // uses type 3 for "MESSAGE_SYNC_VERIFIED" when verifyUpdates=true
  const provider = new GenericProvider(doc, transport, {
    verifyUpdates: false, // Required for y-websocket server compatibility
  })

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

  // Connect to WebSocket via provider
  log('🌐 Connecting to WebSocket server...', 'info')
  try {
    await provider.connect({
      serverUrl: config.serverUrl,
      room: config.room,
      autoReconnect: config.autoReconnect,
      reconnectDelay: config.reconnectDelay,
      debug: config.debug,
    })
    log('✅ Successfully connected to WebSocket server!', 'success')
  } catch (error) {
    log(`❌ Failed to connect: ${error}`, 'error')
    updateStatus('disconnected', '❌ Connection failed')
    throw error
  }

  // Initialize Quill editor
  log('📝 Initializing editor...', 'info')
  const quill = new Quill('#editor', {
    theme: 'snow',
    placeholder: 'Start typing... Your changes sync via WebSocket!',
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
    '⚡ Lightning',
    '🌟 Star',
    '🚀 Rocket',
    '💎 Diamond',
    '🎨 Artist',
    '🎵 Melody',
  ]
  const randomColors = [
    '#667eea',
    '#764ba2',
    '#f093fb',
    '#4facfe',
    '#43e97b',
    '#fa709a',
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
    const peerCount = provider.awareness.getStates().size - 1 // Exclude self
    updatePeerCount(peerCount)
  })

  // Initial user list update
  updateUserList(provider.awareness)

  // Setup chat
  setupChat(provider)

  // Handle page unload
  window.addEventListener('beforeunload', () => {
    provider.disconnect()
    log('👋 Disconnected from WebSocket', 'info')
  })

  log('✅ Setup complete! Start typing to test collaboration.', 'success')
}

// Setup connect button handler
function setupConnectionForm() {
  const form = document.getElementById('config-form') as HTMLFormElement
  const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement
  const configPanel = document.getElementById('config-panel')!
  const mainContent = document.getElementById('main-content')!

  const configServerUrl = document.getElementById(
    'config-server-url',
  ) as HTMLInputElement
  const configRoom = document.getElementById('config-room') as HTMLInputElement
  const configAutoReconnect = document.getElementById(
    'config-auto-reconnect',
  ) as HTMLInputElement
  const configReconnectDelay = document.getElementById(
    'config-reconnect-delay',
  ) as HTMLInputElement
  const configDebug = document.getElementById(
    'config-debug',
  ) as HTMLInputElement

  form.addEventListener('submit', async (e) => {
    e.preventDefault()

    // Validate server URL
    const serverUrl = configServerUrl.value.trim()
    if (!serverUrl) {
      alert('Please enter a WebSocket server URL')
      configServerUrl.focus()
      return
    }

    // Validate room name
    const room = configRoom.value.trim()
    if (!room) {
      alert('Please enter a room name')
      configRoom.focus()
      return
    }

    // Get settings
    const autoReconnect = configAutoReconnect.checked
    const reconnectDelay = parseInt(configReconnectDelay.value) || 2000
    const debug = configDebug.checked

    // Disable button
    connectBtn.disabled = true
    connectBtn.textContent = '⏳ Connecting...'

    try {
      // Hide config panel, show main content
      configPanel.classList.add('hidden')
      mainContent.classList.remove('hidden')

      // Initialize with config
      await initWithConfig({
        serverUrl,
        room,
        autoReconnect,
        reconnectDelay,
        debug,
      })
    } catch (error) {
      console.error('Connection failed:', error)
      alert(`Failed to connect: ${error}`)

      // Show config panel again
      configPanel.classList.remove('hidden')
      mainContent.classList.add('hidden')
      connectBtn.disabled = false
      connectBtn.textContent = '🚀 Connect to WebSocket Server'
    }
  })
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupConnectionForm)
} else {
  setupConnectionForm()
}
