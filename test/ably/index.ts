/**
 * Ably Provider Test
 *
 * This demo shows real-time synchronization using Ably's pub/sub infrastructure.
 * Configure your Ably API key (or auth URL) and connect to start collaboration.
 */

import * as Y from 'yjs'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import QuillCursors from 'quill-cursors'
import { GenericProvider } from '../../src/index'
import { AblyTransport } from '../../src/providers/ably/index'
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
  apiKey?: string
  authUrl?: string
  authMethod?: 'GET' | 'POST'
  room: string
  password?: string
  debug: boolean
  persistent: boolean
}) {
  log('🚀 Initializing Ably test...', 'info')
  log(`📋 Configuration: Room="${config.room}", Debug=${config.debug}`, 'info')

  // Update room badge
  const roomBadge = document.getElementById('room-badge')!
  roomBadge.textContent = `Room: ${config.room}`

  // Create Yjs document
  const doc = new Y.Doc()
  const yText = doc.getText('quill')

  // Create Ably transport — Realtime is loaded from the CDN script in index.html
  log('📡 Creating Ably transport...', 'info')

  const transport = new AblyTransport({
    Realtime: (globalThis as any).Ably.Realtime,
    LiveObjects: (globalThis as any).AblyLiveObjectsPlugin?.LiveObjects,
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

  // Connect to Ably via provider
  log('🌐 Connecting to Ably...', 'info')
  try {
    await provider.connect({
      apiKey: config.apiKey,
      authUrl: config.authUrl,
      authMethod: config.authMethod,
      room: config.room,
      password: config.password || undefined,
      debug: config.debug,
      persistent: config.persistent,
      doc: config.persistent ? doc : undefined,
    })
    log('✅ Successfully connected to Ably!', 'success')
  } catch (error) {
    log(`❌ Failed to connect: ${error}`, 'error')
    updateStatus('disconnected', '❌ Connection failed')
    throw error
  }

  // Initialize Quill editor
  log('📝 Initializing editor...', 'info')
  const quill = new Quill('#editor', {
    theme: 'snow',
    placeholder: 'Start typing... Your changes sync via Ably!',
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
    '🐙 Octopus',
    '🦄 Unicorn',
    '🦊 Fox',
    '🐻 Bear',
    '🦁 Lion',
    '🐯 Tiger',
  ]
  const randomColors = [
    '#ff5416',
    '#1a0644',
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
    log('👋 Disconnected from Ably', 'info')
  })

  log('✅ Setup complete! Start typing to test collaboration.', 'success')
}

// Setup connect button handler
function setupConnectionForm() {
  const form = document.getElementById('config-form') as HTMLFormElement
  const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement
  const configPanel = document.getElementById('config-panel')!
  const mainContent = document.getElementById('main-content')!

  const configApiKey = document.getElementById(
    'config-api-key',
  ) as HTMLInputElement
  const configAuthUrl = document.getElementById(
    'config-auth-url',
  ) as HTMLInputElement
  const configAuthMethod = document.getElementById(
    'config-auth-method',
  ) as HTMLSelectElement
  const configRoom = document.getElementById('config-room') as HTMLInputElement
  const configPassword = document.getElementById(
    'config-password',
  ) as HTMLInputElement
  const configDebug = document.getElementById(
    'config-debug',
  ) as HTMLInputElement
  const configPersistent = document.getElementById(
    'config-persistent',
  ) as HTMLInputElement

  form.addEventListener('submit', async (e) => {
    e.preventDefault()

    // Validate that at least one auth method is provided
    const apiKey = configApiKey.value.trim() || undefined
    const authUrl = configAuthUrl.value.trim() || undefined
    if (!apiKey && !authUrl) {
      alert('Please enter an Ably API key or an auth URL')
      configApiKey.focus()
      return
    }

    // Validate room name
    const room = configRoom.value.trim()
    if (!room) {
      alert('Please enter a room name')
      configRoom.focus()
      return
    }

    const authMethod = configAuthMethod.value as 'GET' | 'POST'
    const password = configPassword.value.trim() || undefined
    const debug = configDebug.checked
    const persistent = configPersistent.checked

    // Disable button
    connectBtn.disabled = true
    connectBtn.textContent = '⏳ Connecting...'

    try {
      // Hide config panel, show main content
      configPanel.classList.add('hidden')
      mainContent.classList.remove('hidden')

      // Initialize with config
      await initWithConfig({
        apiKey,
        authUrl,
        authMethod,
        room,
        password,
        debug,
        persistent,
      })
    } catch (error) {
      console.error('Connection failed:', error)
      alert(`Failed to connect: ${error}`)

      // Show config panel again
      configPanel.classList.remove('hidden')
      mainContent.classList.add('hidden')
      connectBtn.disabled = false
      connectBtn.textContent = '🚀 Connect to Ably'
    }
  })
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupConnectionForm)
} else {
  setupConnectionForm()
}
