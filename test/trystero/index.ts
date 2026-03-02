/**
 * Trystero Provider Test
 *
 * This demo shows serverless peer-to-peer synchronization using Trystero.
 * Supports multiple strategies: Nostr, BitTorrent, MQTT, and IPFS.
 * Configure connection settings and connect to start collaboration.
 */

import * as Y from 'yjs'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import QuillCursors from 'quill-cursors'
import { GenericProvider } from '../../src/index'
import { TrysteroTransport } from '../../src/providers/trystero/index'
import {
  registerMediaBlots,
  imageHandler as sharedImageHandler,
  videoHandler as sharedVideoHandler,
} from '../shared/quill-media.js'
import { log, updateStatus, updateSyncStatus } from '../shared/ui-helpers.js'

// Import all Trystero strategy modules
// @ts-ignore - importing from local minified files
import { joinRoom as joinRoomNostr } from './trystero-nostr.min.js'
// @ts-ignore
import { joinRoom as joinRoomTorrent } from './trystero-torrent.min.js'
// @ts-ignore
import { joinRoom as joinRoomMqtt } from './trystero-mqtt.min.js'
// @ts-ignore
import { joinRoom as joinRoomIpfs } from './trystero-ipfs.min.js'

// Register custom Quill blots
registerMediaBlots()

// Register QuillCursors module for collaborative cursors
Quill.register('modules/cursors', QuillCursors)

// Strategy configuration
type Strategy = 'nostr' | 'torrent' | 'mqtt' | 'ipfs'

// Map strategy names to their joinRoom functions
const STRATEGY_JOIN_ROOM = {
  nostr: joinRoomNostr,
  torrent: joinRoomTorrent,
  mqtt: joinRoomMqtt,
  ipfs: joinRoomIpfs,
}

const STRATEGY_CONFIG = {
  nostr: {
    icon: '🐦',
    name: 'Nostr',
    relayLabel: 'Nostr Relays',
    relayHelp: 'Nostr relay URLs for peer discovery. One URL per line.',
    defaultRelays: `wss://relay.damus.io
wss://relay.nostr.band
wss://nos.lol
wss://relay.snort.social
wss://nostr.wine`,
  },
  torrent: {
    icon: '🌊',
    name: 'BitTorrent',
    relayLabel: 'BitTorrent Trackers',
    relayHelp: 'WebTorrent tracker URLs for peer discovery. One URL per line.',
    defaultRelays: `wss://tracker.webtorrent.dev
wss://tracker.openwebtorrent.com
wss://tracker.files.fm:7073/announce`,
  },
  mqtt: {
    icon: '📡',
    name: 'MQTT',
    relayLabel: 'MQTT Brokers',
    relayHelp: 'MQTT broker URLs for peer discovery. One URL per line.',
    defaultRelays: `wss://test.mosquitto.org:8081`,
  },
  ipfs: {
    icon: '🪐',
    name: 'IPFS',
    relayLabel: 'IPFS Nodes',
    relayHelp: 'IPFS node URLs for peer discovery. One URL per line.',
    defaultRelays: '',
  },
}

// Get joinRoom function for a strategy
function getJoinRoom(strategy: Strategy) {
  return STRATEGY_JOIN_ROOM[strategy]
}

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

// Update peer count
function updatePeerCount(count: number) {
  const peerCountEl = document.getElementById('peer-count')!
  peerCountEl.textContent = count.toString()
}

// Initialize with user configuration
async function initWithConfig(config: {
  appId: string
  room: string
  strategy: Strategy
  joinRoom: any
  password?: string
  relayUrls?: string[]
  turnConfig?: RTCIceServer[]
  debug: boolean
}) {
  const strategyInfo = STRATEGY_CONFIG[config.strategy]
  log(`🚀 Initializing Trystero ${strategyInfo.name} test...`, 'info')
  log(
    `📋 Configuration: App="${config.appId}", Room="${config.room}", Strategy=${strategyInfo.name}, Debug=${config.debug}`,
    'info',
  )

  // Update room badge
  const roomBadge = document.getElementById('room-badge')!
  roomBadge.textContent = `Room: ${config.room}`

  // Create Yjs document
  const doc = new Y.Doc()
  const yText = doc.getText('quill')

  // Create Trystero transport
  log('🔗 Creating Trystero transport...', 'info')

  const transportOptions: any = {
    joinRoom: config.joinRoom,
    appId: config.appId,
    debug: config.debug,
  }

  // Add optional config
  if (config.password) {
    transportOptions.password = config.password
    log('🔐 Password protection enabled', 'info')
  }

  if (config.relayUrls && config.relayUrls.length > 0) {
    transportOptions.relayUrls = config.relayUrls
    log(`📡 Using ${config.relayUrls.length} custom relays`, 'info')
  }

  if (config.turnConfig && config.turnConfig.length > 0) {
    transportOptions.turnConfig = config.turnConfig
    log(`🔄 Using ${config.turnConfig.length} TURN servers`, 'info')
  }

  const transport = new TrysteroTransport(transportOptions)

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
    placeholder: 'Start typing... Your changes sync via Trystero!',
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
    '#6366f1',
    '#8b5cf6',
    '#ec4899',
    '#f59e0b',
    '#10b981',
    '#06b6d4',
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

  // Monitor peer count
  setInterval(() => {
    const peers = (transport as any).getPeers?.() || new Set()
    updatePeerCount(peers.size)
  }, 1000)

  // Connect to room
  log(`🌐 Connecting to Trystero room: ${config.room}...`, 'info')
  try {
    await provider.connect({ room: config.room })
    log('✅ Successfully connected to Trystero!', 'success')
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
    log('👋 Disconnected from Trystero', 'info')
  })

  log('✅ Setup complete! Start typing to test collaboration.', 'success')
}

// Setup connect button handler
function setupConnectionForm() {
  const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement
  const configPanel = document.getElementById('config-panel')!
  const mainContent = document.getElementById('main-content')!

  const configStrategy = document.getElementById(
    'config-strategy',
  ) as HTMLSelectElement
  const configAppId = document.getElementById(
    'config-app-id',
  ) as HTMLInputElement
  const configRoom = document.getElementById('config-room') as HTMLInputElement
  const configPassword = document.getElementById(
    'config-password',
  ) as HTMLInputElement
  const configRelays = document.getElementById(
    'config-relays',
  ) as HTMLTextAreaElement
  const configTurnServers = document.getElementById(
    'config-turn-servers',
  ) as HTMLTextAreaElement
  const configDebug = document.getElementById(
    'config-debug',
  ) as HTMLInputElement

  const relayLabel = document.getElementById('relay-label')!
  const relayHelp = document.getElementById('relay-help')!
  const strategyBadge = document.getElementById('strategy-badge')!

  // Function to update relay config based on strategy
  const updateStrategyUI = () => {
    const strategy = configStrategy.value as Strategy
    const config = STRATEGY_CONFIG[strategy]

    relayLabel.textContent = config.relayLabel
    relayHelp.textContent = config.relayHelp
    configRelays.value = config.defaultRelays
    strategyBadge.textContent = config.name
  }

  // Update relay config when strategy changes
  configStrategy.addEventListener('change', updateStrategyUI)

  // Initialize with default strategy
  updateStrategyUI()

  connectBtn.addEventListener('click', async () => {
    const strategy = configStrategy.value as Strategy

    // Validate app ID
    const appId = configAppId.value.trim()
    if (!appId) {
      alert('Please enter an app ID')
      configAppId.focus()
      return
    }

    // Validate room name
    const room = configRoom.value.trim()
    if (!room) {
      alert('Please enter a room name')
      configRoom.focus()
      return
    }

    // Get password (optional)
    const password = configPassword.value.trim() || undefined

    // Parse relay URLs (one per line, filter empty lines)
    const relaysText = configRelays.value
    const relayUrls = relaysText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    // Parse TURN servers (JSON format, one per line)
    let turnConfig: RTCIceServer[] | undefined
    const turnText = configTurnServers.value.trim()
    if (turnText) {
      try {
        turnConfig = turnText
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line))
      } catch (e) {
        alert('Invalid TURN server JSON format. Please check your input.')
        return
      }
    }

    // Get debug setting
    const debug = configDebug.checked

    // Disable button
    connectBtn.disabled = true
    connectBtn.textContent = '⏳ Connecting...'

    try {
      // Get joinRoom function for selected strategy
      const joinRoom = getJoinRoom(strategy)
      log(`📋 Using ${STRATEGY_CONFIG[strategy].name} strategy...`, 'info')

      // Hide config panel, show main content
      configPanel.classList.add('hidden')
      mainContent.classList.remove('hidden')

      // Initialize with config
      await initWithConfig({
        appId,
        room,
        strategy,
        joinRoom,
        password,
        relayUrls: relayUrls.length > 0 ? relayUrls : undefined,
        turnConfig,
        debug,
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
