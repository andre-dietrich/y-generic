/**
 * Supabase Provider Test
 *
 * This demo shows real-time synchronization using Supabase Realtime.
 */

import * as Y from 'yjs'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import QuillCursors from 'quill-cursors'
import { GenericProvider } from '../../src/index'
import { SupabaseTransport } from '../../src/providers/supabase/index'
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

// Global state
let provider: GenericProvider | null = null
let quill: Quill | null = null
let binding: QuillBinding | null = null

// Generate random user info
const userColors = [
  '#FF6B6B',
  '#4ECDC4',
  '#45B7D1',
  '#FFA07A',
  '#98D8C8',
  '#F7DC6F',
  '#BB8FCE',
  '#85C1E2',
]
const randomColor = userColors[Math.floor(Math.random() * userColors.length)]
const randomName = `User-${Math.floor(Math.random() * 1000)}`

// Update awareness user list
function updateUserList(awareness: any) {
  const usersList = document.getElementById('users-list')!
  const userCount = document.getElementById('user-count')!
  const states = Array.from(awareness.getStates().entries())

  // Filter out local user
  const otherUsers = states.filter(
    ([clientId]: any) => clientId !== awareness.clientID,
  )

  userCount.textContent = String(otherUsers.length + 1) // +1 for self

  if (otherUsers.length === 0) {
    usersList.innerHTML = '<li>Only you</li>'
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

// Initialize Quill editor
function initEditor() {
  if (quill) return

  quill = new Quill('#editor', {
    theme: 'snow',
    modules: {
      cursors: true,
      toolbar: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ color: [] }, { background: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        [{ align: [] }],
        ['link', 'image', 'video'],
        ['clean'],
      ],
    },
    placeholder: 'Start typing to collaborate...',
  })

  // Setup media handlers
  const toolbar = quill.getModule('toolbar') as any
  toolbar.addHandler('image', imageHandler)
  toolbar.addHandler('video', videoHandler)

  log('Editor initialized')
}

// Connect to Supabase
async function connect() {
  const supabaseUrl = (
    document.getElementById('supabase-url') as HTMLInputElement
  ).value.trim()
  const supabaseKey = (
    document.getElementById('supabase-key') as HTMLInputElement
  ).value.trim()
  const room = (
    document.getElementById('room-name') as HTMLInputElement
  ).value.trim()
  const password = (
    document.getElementById('password') as HTMLInputElement
  ).value.trim()

  if (!supabaseUrl || !supabaseKey || !room) {
    alert('Please fill in Supabase URL, Anon Key, and Room Name')
    return
  }

  try {
    log(`Connecting to room "${room}"...`)
    updateStatus('connecting', 'Connecting...')

    // Initialize editor if not already done
    initEditor()

    // Create Yjs document
    const doc = new Y.Doc()
    const yText = doc.getText('quill')

    // Create transport and provider
    // createClient is loaded from the Supabase CDN script tag in index.html
    const transport = new SupabaseTransport({
      createClient: (globalThis as any).supabase.createClient,
    })
    provider = new GenericProvider(doc, transport)

    // Connect with configuration
    await provider.connect({
      supabaseUrl,
      supabaseKey,
      room,
      password: password || undefined,
      debug: true,
    })

    // Bind Quill to Yjs
    const cursors = quill!.getModule('cursors')
    binding = new QuillBinding(yText, quill!, provider.awareness)

    // Set awareness user info
    provider.awareness.setLocalStateField('user', {
      name: randomName,
      color: randomColor,
    })

    // Setup event listeners
    provider.on('status', ({ status }: any) => {
      log(`Status changed: ${status}`)
      if (status === 'connected') {
        updateStatus('connected', 'Connected')
      } else if (status === 'disconnected') {
        updateStatus('disconnected', 'Disconnected')
      } else if (status === 'connecting') {
        updateStatus('connecting', 'Connecting...')
      }
    })

    provider.on('synced', ({ synced }: any) => {
      log(`Sync status: ${synced ? 'synced' : 'syncing'}`)
      updateSyncStatus(synced)
    })

    provider.awareness.on('change', () => {
      updateUserList(provider!.awareness)
    })

    // Update UI
    updateStatus('connected', 'Connected')
    document.getElementById('room-text')!.textContent = room
    document.getElementById('connect-btn')!.style.display = 'none'
    document.getElementById('disconnect-btn')!.style.display = 'block'

    // Disable config inputs
    ;(document.getElementById('supabase-url') as HTMLInputElement).disabled =
      true
    ;(document.getElementById('supabase-key') as HTMLInputElement).disabled =
      true
    ;(document.getElementById('room-name') as HTMLInputElement).disabled = true
    ;(document.getElementById('password') as HTMLInputElement).disabled = true

    log('Connected successfully!')
  } catch (error: any) {
    log(`Connection failed: ${error.message}`, 'error')
    updateStatus('disconnected', 'Connection failed')
    alert(`Failed to connect: ${error.message}`)
  }
}

// Disconnect from Supabase
async function disconnect() {
  if (!provider) return

  try {
    log('Disconnecting...')
    await provider.disconnect()
    provider = null
    binding = null

    updateStatus('disconnected', 'Disconnected')
    document.getElementById('mode-text')!.textContent = '-'
    document.getElementById('room-text')!.textContent = '-'
    document.getElementById('synced-text')!.textContent = '-'
    document.getElementById('user-count')!.textContent = '0'
    document.getElementById('users-list')!.innerHTML = '<li>Not connected</li>'
    document.getElementById('connect-btn')!.style.display = 'block'
    document.getElementById('disconnect-btn')!.style.display = 'none'

    // Enable config inputs
    ;(document.getElementById('supabase-url') as HTMLInputElement).disabled =
      false
    ;(document.getElementById('supabase-key') as HTMLInputElement).disabled =
      false
    ;(document.getElementById('room-name') as HTMLInputElement).disabled = false
    ;(document.getElementById('password') as HTMLInputElement).disabled = false

    log('Disconnected successfully')
  } catch (error: any) {
    log(`Disconnect failed: ${error.message}`, 'error')
  }
}

// Setup UI event listeners
document.getElementById('connect-btn')!.addEventListener('click', connect)
document.getElementById('disconnect-btn')!.addEventListener('click', disconnect)

// Load saved config from localStorage
const savedUrl = localStorage.getItem('supabase-url')
const savedKey = localStorage.getItem('supabase-key')
if (savedUrl) {
  ;(document.getElementById('supabase-url') as HTMLInputElement).value =
    savedUrl
}
if (savedKey) {
  ;(document.getElementById('supabase-key') as HTMLInputElement).value =
    savedKey
}

// Save config to localStorage on change
document.getElementById('supabase-url')!.addEventListener('input', (e) => {
  localStorage.setItem('supabase-url', (e.target as HTMLInputElement).value)
})
document.getElementById('supabase-key')!.addEventListener('input', (e) => {
  localStorage.setItem('supabase-key', (e.target as HTMLInputElement).value)
})

log('Supabase Provider Test initialized')
log('Enter your Supabase credentials and click Connect to start')
