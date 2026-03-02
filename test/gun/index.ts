/**
 * GunDB Provider Test
 *
 * This demo shows decentralized peer-to-peer synchronization using GunDB.
 * Configure connection settings and connect to start collaboration.
 */

import * as Y from 'yjs'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import QuillCursors from 'quill-cursors'
import { GenericProvider } from '../../src/index'
import { GunTransport } from '../../src/providers/gun/index'
import {
  registerMediaBlots,
  imageHandler as sharedImageHandler,
  videoHandler as sharedVideoHandler,
} from '../shared/quill-media'
import { log, updateStatus, updateSyncStatus } from '../shared/ui-helpers'

// Gun is loaded from CDN as a global variable
declare const Gun: any

// Register custom Quill blots
registerMediaBlots()

// Register QuillCursors module for collaborative cursors
Quill.register('modules/cursors', QuillCursors)

// Update awareness user list
function updateUserList(awareness: any) {
  const userListEl = document.getElementById('user-list')!
  const states = Array.from(awareness.getStates().entries()) as Array<
    [number, any]
  >

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
    .map(([clientId, state]) => {
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

// Wrap shared handlers to pass log function
function imageHandler(this: any) {
  sharedImageHandler.call(this, log)
}

function videoHandler(this: any) {
  sharedVideoHandler.call(this, log)
}

// Initialize with user configuration
async function initWithConfig(config: {
  room: string
  peers: string[]
  debug: boolean
  batchInterval: number
  localStorage: boolean
}) {
  log('🚀 Initializing GunDB test...', 'info')
  log(
    `📋 Configuration: Room="${config.room}", Peers=${config.peers.length}, Debug=${config.debug}`,
    'info',
  )

  // Update room badge
  const roomBadge = document.getElementById('room-badge')!
  roomBadge.textContent = `Room: ${config.room}`

  // Create Yjs document
  const doc = new Y.Doc()
  const yText = doc.getText('quill')

  // Create Gun transport
  log('🔗 Creating Gun transport...', 'info')

  const transport = new GunTransport({
    gun: Gun,
    peers: config.peers,
    debug: config.debug,
    batchInterval: config.batchInterval,
    gunOptions: {
      localStorage: config.localStorage,
      radisk: config.localStorage,
    },
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
    placeholder: 'Start typing... Your changes sync via GunDB!',
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
    '🌊 Wave',
    '🌲 Forest',
    '🔥 Fire',
    '💨 Wind',
    '⚡ Lightning',
    '🌙 Moon',
  ]
  const randomColors = [
    '#11998e',
    '#38ef7d',
    '#06beb6',
    '#48bb78',
    '#38b2ac',
    '#4299e1',
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

  // Connect to room
  log(`🌐 Connecting to GunDB room: ${config.room}...`, 'info')
  try {
    await provider.connect({ room: config.room })
    log('✅ Successfully connected to GunDB!', 'success')
    log('💡 Tip: Open another tab to see real-time sync!', 'info')
  } catch (error) {
    log(`❌ Failed to connect: ${error}`, 'error')
    updateStatus('disconnected', '❌ Connection failed')
  }

  // Setup pub/sub chat
  setupPubSubChat(provider)

  // Handle page unload
  window.addEventListener('beforeunload', () => {
    provider.disconnect()
    log('👋 Disconnected from GunDB', 'info')
  })

  log('✅ Setup complete! Start typing to test collaboration.', 'success')
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
      background: white;
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

// Setup connect button handler
function setupConnectionForm() {
  const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement
  const configPanel = document.getElementById('config-panel')!
  const mainContent = document.getElementById('main-content')!

  const configRoom = document.getElementById('config-room') as HTMLInputElement
  const configPeers = document.getElementById(
    'config-peers',
  ) as HTMLTextAreaElement
  const configBatchInterval = document.getElementById(
    'config-batch-interval',
  ) as HTMLInputElement
  const configDebug = document.getElementById(
    'config-debug',
  ) as HTMLInputElement
  const configLocalStorage = document.getElementById(
    'config-localstorage',
  ) as HTMLInputElement

  connectBtn.addEventListener('click', async () => {
    // Validate room name
    const room = configRoom.value.trim()
    if (!room) {
      alert('Please enter a room name')
      configRoom.focus()
      return
    }

    // Parse peers (one per line, filter empty lines)
    const peersText = configPeers.value
    const peers = peersText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    // Get other config
    const batchInterval = parseInt(configBatchInterval.value) || 100
    const debug = configDebug.checked
    const localStorage = configLocalStorage.checked

    // Disable button
    connectBtn.disabled = true
    connectBtn.textContent = '⏳ Connecting...'

    try {
      // Hide config panel, show main content
      configPanel.classList.add('hidden')
      mainContent.classList.remove('hidden')

      // Initialize with config
      await initWithConfig({
        room,
        peers,
        debug,
        batchInterval,
        localStorage,
      })
    } catch (error) {
      console.error('Connection failed:', error)
      alert(`Failed to connect: ${error}`)

      // Show config panel again
      configPanel.classList.remove('hidden')
      mainContent.classList.add('hidden')
      connectBtn.disabled = false
      connectBtn.textContent = '🚀 Connect'
    }
  })
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupConnectionForm)
} else {
  setupConnectionForm()
}
