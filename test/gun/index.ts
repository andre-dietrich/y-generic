/**
 * GunDB Provider Test
 *
 * This demo shows decentralized peer-to-peer synchronization using GunDB.
 * Open this page in multiple browser tabs/windows to test collaboration.
 */

import * as Y from 'yjs'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import QuillCursors from 'quill-cursors'
import Gun from 'gun'
import { GenericProvider } from '../../src/index'
import { GunTransport } from '../../src/providers/gun/index'
import {
  registerMediaBlots,
  imageHandler as sharedImageHandler,
  videoHandler as sharedVideoHandler,
} from '../shared/quill-media'
import { log, updateStatus, updateSyncStatus } from '../shared/ui-helpers'

// Register custom Quill blots
registerMediaBlots()

// Register QuillCursors module for collaborative cursors
Quill.register('modules/cursors', QuillCursors)

// Configuration
const ROOM_NAME = 'gun-test333'

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

// Initialize
async function init() {
  log('🚀 Initializing GunDB test...', 'info')

  // Create Yjs document
  const doc = new Y.Doc()
  const yText = doc.getText('quill')

  // Create Gun transport
  log('🔗 Creating Gun transport...', 'info')

  // Note: You can add relay peers here for cross-device sync
  // For now, we'll use local P2P only (same-device tabs)
  const transport = new GunTransport({
    gun: Gun,
    peers: [
      'https://gun.o8.is/gun',
      'https://gun.defucc.me/gun',
      'https://shogun-relay.scobrudot.dev/gun',
      'https://relay.peer.ooo/gun',
    ], // Add relay servers here: ['https://gun-relay.herokuapp.com/gun']
    debug: true,
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
  log(`🌐 Connecting to GunDB room: ${ROOM_NAME}...`, 'info')
  try {
    await provider.connect({ room: ROOM_NAME, batchInterval: 2000 })
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

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
