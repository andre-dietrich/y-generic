/**
 * Shared Quill Media Blots and Handlers
 *
 * Common custom blots and upload handlers for images and videos
 * used across all test pages.
 */

import Quill from 'quill'

const BlockEmbed = Quill.import('blots/block/embed') as any

export type LogType = 'info' | 'success' | 'error'
export type LogFunction = (msg: string, type?: LogType) => void

/**
 * Custom Video Blot for HTML5 video support
 * Embeds videos with controls and proper error handling
 */
export class VideoBlot extends BlockEmbed {
  static blotName = 'video'
  static tagName = 'video'

  static create(value: string) {
    const node = super.create(value) as HTMLVideoElement
    node.setAttribute('src', value)
    node.setAttribute('controls', 'true')
    node.setAttribute('preload', 'metadata')
    node.setAttribute('style', 'max-width: 100%; height: auto;')

    // Add error handler for debugging
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

/**
 * Image upload handler for Quill toolbar
 * Opens file picker and embeds selected image as base64 data URL
 */
export function imageHandler(this: any, logFn?: LogFunction) {
  const input = document.createElement('input')
  input.setAttribute('type', 'file')
  input.setAttribute('accept', 'image/*')
  input.click()

  input.onchange = () => {
    const file = input.files?.[0]
    if (file) {
      logFn?.(
        `📸 Uploading image (${(file.size / 1024).toFixed(2)} KB)...`,
        'info',
      )

      const reader = new FileReader()
      reader.onload = (e) => {
        const range = this.quill.getSelection(true)
        this.quill.insertEmbed(range.index, 'image', e.target?.result)
        this.quill.setSelection(range.index + 1)
        logFn?.('🖼️ Image uploaded', 'success')
      }
      reader.onerror = () => {
        logFn?.('❌ Failed to read image file', 'error')
      }
      reader.readAsDataURL(file)
    }
  }
}

/**
 * Video upload handler for Quill toolbar
 * Opens file picker and embeds selected video as base64 data URL
 * Only accepts MP4, WebM, and OGG formats for browser compatibility
 */
export function videoHandler(this: any, logFn?: LogFunction) {
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
        const msg = `❌ Unsupported video format: ${file.type}. Please use MP4, WebM, or OGG.`
        logFn?.(msg, 'error')
        console.error(msg)
        return
      }

      logFn?.(
        `📹 Uploading ${file.type} video (${(file.size / 1024 / 1024).toFixed(2)} MB)...`,
        'info',
      )

      const reader = new FileReader()
      reader.onload = (e) => {
        const range = this.quill.getSelection(true)
        this.quill.insertEmbed(range.index, 'video', e.target?.result)
        this.quill.setSelection(range.index + 1)
        logFn?.('🎬 Video uploaded', 'success')
      }
      reader.onerror = () => {
        logFn?.('❌ Failed to read video file', 'error')
      }
      reader.readAsDataURL(file)
    }
  }
}

/**
 * Register the VideoBlot with Quill
 * Call this before initializing any Quill instances
 */
export function registerMediaBlots() {
  Quill.register(VideoBlot, true)
}
