/**
 * IndexedDB Provider Test
 *
 * This demo shows local persistence using IndexedDB.
 * All document changes are automatically saved and restored on page reload.
 */

import * as Y from 'yjs'
import Quill from 'quill'
import { QuillBinding } from 'y-quill'
import { GenericProvider } from '../../src/index'
import { IndexedDBTransport } from '../../src/providers/indexeddb/index'

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
const ROOM_NAME = 'indexeddb-test'

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

function updateStorageStatus(synced: boolean) {
  const syncStatusEl = document.getElementById('sync-status')!
  if (synced) {
    syncStatusEl.innerHTML = '✅ Saved'
    syncStatusEl.style.color = '#4caf50'
  } else {
    syncStatusEl.innerHTML = '💾 Saving...'
    syncStatusEl.style.color = '#ff9800'
  }
}

// Update stats display
async function updateStats(transport: IndexedDBTransport) {
  try {
    const stats = await transport.getStats()

    document.getElementById('stat-updates')!.textContent =
      stats.updateCount.toString()
    document.getElementById('stat-db')!.textContent = stats.databaseName
    document.getElementById('stat-store')!.textContent = stats.storeName
    document.getElementById('update-count')!.textContent =
      stats.updateCount.toString()
    document.getElementById('db-name')!.textContent = stats.databaseName

    log(`📊 Stats updated: ${stats.updateCount} updates stored`, 'info')
  } catch (error) {
    log(`❌ Failed to update stats: ${error}`, 'error')
  }
}

// Initialize the application
async function init() {
  log('🚀 Initializing IndexedDB provider...', 'info')

  // Create Yjs document
  const doc = new Y.Doc()
  const yText = doc.getText('content')

  // Create IndexedDB transport with auto-compaction
  const transport = new IndexedDBTransport({
    debug: true,
    autoCompact: true,
    compactThreshold: 100,
    maxUpdates: 500,
  })

  // Create provider
  const provider = new GenericProvider(doc, transport)

  // Setup provider event listeners
  provider.on('status', (event: any) => {
    log(`📡 Status: ${event.status}`, 'info')
    updateStatus(event.status, `📊 ${event.status}`)
  })

  provider.on('synced', (synced: boolean) => {
    updateStorageStatus(synced)
    if (synced) {
      log('✅ Document synced with IndexedDB', 'success')
    }
  })

  // Track document changes
  let changeTimeout: any
  doc.on('update', () => {
    updateStorageStatus(false)

    // Debounce stats update
    clearTimeout(changeTimeout)
    changeTimeout = setTimeout(() => {
      updateStats(transport)
      updateStorageStatus(true)
    }, 500)
  })

  // Setup Quill editor
  const quill = new Quill('#editor', {
    theme: 'snow',
    placeholder:
      'Start typing... Your content is automatically saved to IndexedDB!',
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
  const binding = new QuillBinding(yText, quill)
  log('✅ Editor bound to Yjs', 'success')

  // Setup control buttons
  const btnRefresh = document.getElementById('btn-refresh')!
  const btnCompact = document.getElementById('btn-compact')!
  const btnClear = document.getElementById('btn-clear')!

  btnRefresh.addEventListener('click', async () => {
    log('🔄 Refreshing stats...', 'info')
    await updateStats(transport)
  })

  btnCompact.addEventListener('click', async () => {
    log('🗜️ Compacting database...', 'info')
    try {
      await transport.compact()
      log('✅ Database compacted successfully', 'success')
      await updateStats(transport)
    } catch (error) {
      log(`❌ Compaction failed: ${error}`, 'error')
    }
  })

  btnClear.addEventListener('click', async () => {
    if (
      confirm(
        'Are you sure you want to clear all stored data? This cannot be undone!',
      )
    ) {
      log('🗑️ Clearing database...', 'info')
      try {
        await transport.clear()
        log('✅ Database cleared successfully', 'success')

        // Clear the editor
        doc.getText('content').delete(0, doc.getText('content').length)

        await updateStats(transport)

        // Show success message
        setTimeout(() => {
          log('💡 You can start typing to create new content', 'info')
        }, 500)
      } catch (error) {
        log(`❌ Clear failed: ${error}`, 'error')
      }
    }
  })

  // Update auto-compact display
  const autoCompactEl = document.getElementById('stat-autocompact')!
  autoCompactEl.textContent = 'Enabled (100 updates)'

  // Connect to IndexedDB
  log(`💾 Connecting to IndexedDB room: ${ROOM_NAME}...`, 'info')
  try {
    await provider.connect({ room: ROOM_NAME })
    log('✅ Successfully connected to IndexedDB!', 'success')
    updateStatus('connected', '✅ Connected')

    // Update stats after loading
    setTimeout(async () => {
      await updateStats(transport)

      const stats = await transport.getStats()
      if (stats.updateCount === 0) {
        log(
          '💡 No existing data found. Start typing to create content!',
          'info',
        )
      } else {
        log(`📦 Loaded ${stats.updateCount} updates from IndexedDB`, 'success')
      }
    }, 500)
  } catch (error) {
    log(`❌ Failed to connect: ${error}`, 'error')
    updateStatus('disconnected', '❌ Connection failed')
  }

  // Handle page unload
  window.addEventListener('beforeunload', () => {
    provider.disconnect()
    log('👋 Disconnected from IndexedDB', 'info')
  })

  log('✅ Setup complete! Your work is automatically saved.', 'success')
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
        log('📸 Image uploaded and saved', 'success')
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
        log('🎬 Video uploaded and saved', 'success')
      }
      reader.onerror = () => {
        log('❌ Failed to read video file', 'error')
      }
      reader.readAsDataURL(file)
    }
  }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
