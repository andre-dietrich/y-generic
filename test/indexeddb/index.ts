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
import {
  registerMediaBlots,
  imageHandler as sharedImageHandler,
  videoHandler as sharedVideoHandler,
} from '../shared/quill-media'
import { log, updateStatus, updateStorageStatus } from '../shared/ui-helpers'

// Register custom Quill blots
registerMediaBlots()

// Configuration
const ROOM_NAME = 'indexeddb-test'

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

// Wrap shared handlers to pass log function
function imageHandler(this: any) {
  sharedImageHandler.call(this, log)
}

function videoHandler(this: any) {
  sharedVideoHandler.call(this, log)
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
