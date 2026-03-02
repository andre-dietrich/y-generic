/**
 * Shared Quill Awareness Utilities
 *
 * Common utilities for setting up collaborative awareness features
 * including colored cursors and user presence.
 */

import Quill from 'quill'
import QuillCursors from 'quill-cursors'

/**
 * User color palette for collaborative cursors
 */
const USER_COLORS = [
  '#30bced',
  '#6eeb83',
  '#ffbc42',
  '#ecd444',
  '#ee6352',
  '#9ac2c9',
  '#8acb88',
  '#1be7ff',
  '#ff006e',
  '#8338ec',
  '#fb5607',
  '#ffbe0b',
  '#3a86ff',
  '#06ffa5',
  '#f15bb5',
]

/**
 * User name generator for anonymous users
 */
const USER_NAMES = [
  'Red Panda',
  'Blue Jay',
  'Green Turtle',
  'Yellow Canary',
  'Purple Owl',
  'Orange Fox',
  'Pink Flamingo',
  'Teal Dolphin',
  'Cyan Whale',
  'Magenta Butterfly',
  'Lime Frog',
  'Coral Fish',
  'Indigo Raven',
  'Amber Bee',
  'Crimson Cardinal',
]

/**
 * Register the QuillCursors module with Quill
 * Call this before creating any Quill instances
 */
export function registerCursorsModule() {
  Quill.register('modules/cursors', QuillCursors)
}

/**
 * Generate a random user color from the palette
 */
export function generateUserColor(): string {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]
}

/**
 * Generate a random user name
 */
export function generateUserName(): string {
  return USER_NAMES[Math.floor(Math.random() * USER_NAMES.length)]
}

/**
 * Initialize awareness with user information
 * Sets up a random user with name and color
 */
export function initializeAwareness(awareness: any): void {
  const userName = generateUserName()
  const userColor = generateUserColor()

  awareness.setLocalStateField('user', {
    name: userName,
    color: userColor,
  })
}

/**
 * Update user list display from awareness states
 */
export function updateUserList(
  awareness: any,
  elementId: string = 'user-list',
): void {
  const userListEl = document.getElementById(elementId)
  if (!userListEl) return

  const states = Array.from(awareness.getStates().entries())

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
    .map(([clientId, state]: [any, any]) => {
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

/**
 * Setup awareness change listeners
 */
export function setupAwarenessListeners(
  awareness: any,
  callbacks?: {
    onChange?: () => void
    onUserJoin?: (clientId: number) => void
    onUserLeave?: (clientId: number) => void
  },
): () => void {
  const changeHandler = (changes: any) => {
    // Call general onChange handler
    callbacks?.onChange?.()

    // Handle user joins/leaves
    if (changes.added) {
      changes.added.forEach((clientId: number) => {
        callbacks?.onUserJoin?.(clientId)
      })
    }
    if (changes.removed) {
      changes.removed.forEach((clientId: number) => {
        callbacks?.onUserLeave?.(clientId)
      })
    }
  }

  awareness.on('change', changeHandler)

  // Return cleanup function
  return () => {
    awareness.off('change', changeHandler)
  }
}
