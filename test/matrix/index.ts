/**
 * Matrix Provider Test
 *
 * This demo shows real-time synchronization using Matrix protocol.
 * No login required - uses guest access for seamless collaboration.
 */

import * as Y from 'yjs'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import QuillCursors from 'quill-cursors'
import { GenericProvider } from '../../src/index'
import { MatrixTransport } from '../../src/providers/matrix/index'
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
  const usersList = document.getElementById('users-list')
  if (!usersList) return

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
    if (messages.length === 0) {
      chatMessages.innerHTML = '<em style="color: #999">No messages yet...</em>'
      return
    }

    chatMessages.innerHTML = messages
      .map((msg: any) => {
        const time = new Date(msg.time).toLocaleTimeString()
        const color = msg.color || '#999'
        return `
          <div class="chat-message">
            <strong style="color: ${color}">${escapeHtml(msg.name)}:</strong>
            ${escapeHtml(msg.text)}
            <small style="color: #999; margin-left: 10px">${time}</small>
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

  log('💬 Chat ready!', 'success')
}

// Update peer count
function updatePeerCount(count: number) {
  const peerCountEl = document.getElementById('peer-count')!
  peerCountEl.textContent = count.toString()
}

// Initialize with user configuration
async function initWithConfig(config: {
  homeserverUrl: string
  room: string
  accessToken?: string
  userId?: string
  debug: boolean
}) {
  log('🚀 Initializing Matrix test...', 'info')

  if (config.accessToken && config.userId) {
    log(`📋 Using provided account: ${config.userId}`, 'info')
  } else {
    log(`📋 Attempting guest registration on ${config.homeserverUrl}`, 'info')
  }

  log(`📋 Room: ${config.room}`, 'info')

  // Update room badge
  const roomBadge = document.getElementById('room-badge')!
  roomBadge.textContent = config.room

  // Create Yjs document
  const doc = new Y.Doc()
  const yText = doc.getText('quill')

  // Create Matrix transport
  log('🔌 Creating Matrix transport...', 'info')

  const transport = new MatrixTransport()

  // Create provider
  // Note: verifyUpdates should be false for better compatibility
  const provider = new GenericProvider(doc, transport, {
    verifyUpdates: false,
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

  // Connect to Matrix via provider
  log('🌐 Connecting to Matrix homeserver...', 'info')
  try {
    await provider.connect({
      homeserverUrl: config.homeserverUrl,
      room: config.room,
      accessToken: config.accessToken,
      userId: config.userId,
      debug: config.debug,
    })
    log('✅ Successfully connected to Matrix!', 'success')
  } catch (error) {
    log(`❌ Failed to connect: ${error}`, 'error')
    updateStatus('disconnected', '❌ Connection failed')
    throw error
  }

  // Initialize Quill editor
  log('📝 Initializing editor...', 'info')
  const quill = new Quill('#editor', {
    theme: 'snow',
    placeholder: 'Start typing... Your changes sync via Matrix!',
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

  // Bind Yjs to Quill
  const binding = new QuillBinding(yText, quill, provider.awareness)
  log('✅ Editor bound to Yjs', 'success')

  // Set random user info
  const userColor =
    '#' +
    Math.floor(Math.random() * 16777215)
      .toString(16)
      .padStart(6, '0')
  const userName = 'User ' + Math.floor(Math.random() * 1000)

  provider.awareness.setLocalStateField('user', {
    name: userName,
    color: userColor,
  })

  // Setup chat
  setupChat(provider)

  // Update peer count when awareness changes
  provider.awareness.on('change', () => {
    const count = provider.awareness.getStates().size - 1 // Exclude self
    updatePeerCount(Math.max(0, count))
  })

  log('✅ Setup complete! Start typing to test collaboration.', 'success')
}

// Handle form submission
const form = document.getElementById('config-form') as HTMLFormElement

form.addEventListener('submit', async (e) => {
  e.preventDefault()

  const homeserverUrl = (
    document.getElementById('homeserver') as HTMLInputElement
  ).value.trim()
  const room = (
    document.getElementById('room') as HTMLInputElement
  ).value.trim()
  const accessToken = (
    document.getElementById('accessToken') as HTMLInputElement
  ).value.trim()
  const userId = (
    document.getElementById('userId') as HTMLInputElement
  ).value.trim()
  const debug = (document.getElementById('debug') as HTMLInputElement).checked

  // Validate inputs
  if (!homeserverUrl) {
    log('❌ Please enter a homeserver URL', 'error')
    return
  }

  if (!room) {
    log('❌ Please enter a room identifier', 'error')
    return
  }

  // If accessToken provided, userId is required
  if (accessToken && !userId) {
    log('❌ User ID is required when using an access token', 'error')
    return
  }

  // Hide config panel, show main content
  const configPanel = document.getElementById('config-panel')!
  const mainContent = document.getElementById('main-content')!

  try {
    await initWithConfig({
      homeserverUrl,
      room,
      accessToken: accessToken || undefined,
      userId: userId || undefined,
      debug,
    })

    configPanel.classList.add('hidden')
    mainContent.classList.remove('hidden')
  } catch (error) {
    log(`❌ Initialization failed: ${error}`, 'error')
    // Keep config panel visible on error
  }
})
