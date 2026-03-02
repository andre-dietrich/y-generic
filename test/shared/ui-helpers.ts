/**
 * Shared UI Helper Functions
 *
 * Common utilities for logging, status updates, and UI management
 * used across all test pages.
 */

export type LogType = 'info' | 'success' | 'error'
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting'

/**
 * Log a message to the log panel with timestamp and color coding
 */
export function log(message: string, type: LogType = 'info'): void {
  const logEl = document.getElementById('log')
  if (!logEl) {
    console.log(`[${type}] ${message}`)
    return
  }

  const time = new Date().toLocaleTimeString()
  const colors: Record<LogType, string> = {
    info: '#2196f3',
    success: '#4caf50',
    error: '#f44336',
  }

  const entry = document.createElement('div')
  entry.className = 'log-entry'
  entry.innerHTML = `<span class="log-time">[${time}]</span><span style="color: ${colors[type]}">${message}</span>`
  logEl.appendChild(entry)

  // Auto-scroll to bottom
  const logContainer = document.getElementById('log-container')
  if (logContainer) {
    logContainer.scrollTop = logContainer.scrollHeight
  }

  // Keep only last 50 entries to prevent memory issues
  if (logEl.children.length > 50) {
    logEl.removeChild(logEl.children[0])
  }
}

/**
 * Update connection status indicator
 */
export function updateStatus(status: ConnectionStatus, message: string): void {
  const indicator = document.getElementById('connection-indicator')
  const statusEl = document.getElementById('connection-status')

  if (indicator) {
    indicator.className = `status-indicator ${status}`
  }

  if (statusEl) {
    statusEl.textContent = message
  }
}

/**
 * Update peer count display
 */
export function updatePeerCount(count: number): void {
  const peerCountEl = document.getElementById('peer-count')
  if (peerCountEl) {
    peerCountEl.textContent = count.toString()
  }
}

/**
 * Update sync status indicator
 */
export function updateSyncStatus(synced: boolean): void {
  const syncStatusEl = document.getElementById('sync-status')
  if (syncStatusEl) {
    if (synced) {
      syncStatusEl.innerHTML = '✅ Synced'
      syncStatusEl.style.color = '#4caf50'
    } else {
      syncStatusEl.innerHTML = '⏳ Syncing...'
      syncStatusEl.style.color = '#ff9800'
    }
  }
}

/**
 * Update storage/save status indicator
 */
export function updateStorageStatus(synced: boolean): void {
  const syncStatusEl = document.getElementById('sync-status')
  if (syncStatusEl) {
    if (synced) {
      syncStatusEl.innerHTML = '✅ Saved'
      syncStatusEl.style.color = '#4caf50'
    } else {
      syncStatusEl.innerHTML = '💾 Saving...'
      syncStatusEl.style.color = '#ff9800'
    }
  }
}

/**
 * Clear the log panel
 */
export function clearLog(): void {
  const logEl = document.getElementById('log')
  if (logEl) {
    logEl.innerHTML = ''
  }
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
}

/**
 * Format milliseconds to human readable duration
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  return `${minutes}m ${seconds}s`
}
