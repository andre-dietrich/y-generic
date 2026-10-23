import type { Transport, ConnectionConfig } from '../../transport'
import { toBase64, fromBase64 } from '../codec'
import { splitChunks, isChunk, ChunkAssembler } from '../chunking'

/**
 * PubNub transport configuration
 */
export interface PubNubConfig extends ConnectionConfig {
  /** PubNub publish key (required) */
  publishKey: string
  /** PubNub subscribe key (required) */
  subscribeKey: string
  /** Optional cipher key for message encryption */
  cipherKey?: string
  /** Store messages in history (default: false) */
  storeInHistory?: boolean
  /** Enable debug logging */
  debug?: boolean
}

/**
 * PubNub Transport for Yjs
 *
 * Provides real-time synchronization using PubNub's pub/sub infrastructure.
 *
 * Features:
 * - Global cloud infrastructure with low latency
 * - Built-in presence tracking
 * - Optional message encryption
 * - Optional message persistence
 * - Reliable message delivery
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { PubNubTransport } from 'y-generic/providers/pubnub'
 *
 * const doc = new Y.Doc()
 * const transport = new PubNubTransport() // { presence: true } with the Presence add-on
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   publishKey: 'pub-c-xxx',
 *   subscribeKey: 'sub-c-xxx',
 *   room: 'my-room',
 *   cipherKey: 'optional-encryption-key',
 * })
 * ```
 */
/** Constructor options for PubNubTransport. */
export interface PubNubTransportOptions {
  /**
   * Use PubNub Presence for departures: the transport then implements
   * `onPeerDisconnect` (presence `leave`/`timeout` events) and
   * GenericProvider drops a departed peer's awareness at once and lets the
   * awareness lease default to 5 minutes instead of 30 s, which removes
   * the 15 s presence renewal broadcasts. Requires the Presence add-on to
   * be enabled on the keyset (PubNub admin portal) - without it no
   * presence event ever arrives, so departures would only be noticed after
   * the long lease; the transport checks `hereNow` after subscribing and
   * warns if the keyset does not list it. Presence events count as PubNub
   * transactions. @default false
   */
  presence?: boolean
}

export class PubNubTransport implements Transport {
  private pubnub: any = null
  private channel: string = ''
  private readonly presenceEnabled: boolean
  /**
   * Transport.onPeerDisconnect - present only with `presence: true` (see
   * PubNubTransportOptions), so GenericProvider keeps the 30 s awareness
   * lease on a keyset without Presence. Peer ids are publisher uuids, the
   * same `from` onMessage passes.
   */
  readonly onPeerDisconnect?: (callback: (peerId: string) => void) => () => void

  constructor(options: PubNubTransportOptions = {}) {
    this.presenceEnabled = options.presence ?? false
    if (this.presenceEnabled) {
      this.onPeerDisconnect = (callback: (peerId: string) => void) => {
        this._peerDisconnectCallback = callback
        return () => {
          this._peerDisconnectCallback = undefined
        }
      }
    }
  }
  private uuid: string = ''
  private messageCallback?: (data: Uint8Array, from?: string) => void
  private _peerDisconnectCallback?: (peerId: string) => void
  private _peerConnectCallback?: (peerId: string) => void
  private _isConnected: boolean = false
  private config: PubNubConfig | null = null
  private debug: boolean = false
  private messageBuffer: Array<{ data: Uint8Array; from?: string }> = [] // until onMessage()
  private chunks = new ChunkAssembler()
  // Compress a full-document push before it is base64-encoded and chunked
  // (see Transport.preferredCompressMinBytes).
  readonly preferredCompressMinBytes = 2048

  // PubNub has a 32 KiB message limit. We use 30 KB for safety (after base64 encoding)
  private readonly MAX_MESSAGE_SIZE = 30000

  get isConnected(): boolean {
    return this._isConnected
  }

  /**
   * Connect to PubNub channel
   */
  async connect(config: PubNubConfig): Promise<void> {
    this.config = config
    this.debug = config.debug ?? false

    // Validate required keys
    if (!config.publishKey || !config.subscribeKey) {
      throw new Error('PubNub requires publishKey and subscribeKey')
    }

    if (!config.room) {
      throw new Error('Room name is required')
    }

    this.log('Initializing PubNub transport...')

    // Check if PubNub is loaded
    if (typeof (globalThis as any).PubNub === 'undefined') {
      throw new Error(
        'PubNub SDK not loaded. Include the PubNub script from CDN: https://cdn.pubnub.com/sdk/javascript/pubnub.10.2.7.min.js',
      )
    }

    // Generate unique ID for this client
    this.uuid = this.generateUUID()
    // The room name in base64 as the channel. btoa() takes Latin-1 only (it
    // threw for '数学'); other names go as UTF-8, a Latin-1 one keeps its channel.
    this.channel = /^[\x00-\xff]*$/.test(config.room)
      ? btoa(config.room)
      : toBase64(new TextEncoder().encode(config.room))

    this.log(`Connecting as ${this.uuid} to channel ${this.channel}`)

    // Create PubNub instance
    const pubnubConfig: any = {
      publishKey: config.publishKey,
      subscribeKey: config.subscribeKey,
      userId: this.uuid,
      // Without it the SDK DESTROYS the client when the browser says
      // `offline` (a phone's WiFi going, for a second): it unsubscribes from
      // every channel, and `online` restarts a subscribe loop that has none -
      // the page sent on and never heard the room again
      // (test/providers/repro-pubnub-lifecycle.ts, part 2). With it `offline`
      // only disconnects, and `online` resumes at the last timetoken.
      restore: true,
    }

    // Add cipher key if provided
    if (config.cipherKey) {
      pubnubConfig.cipherKey = config.cipherKey
      this.log('Message encryption enabled')
    }

    // @ts-ignore - PubNub global
    this.pubnub = new PubNub(pubnubConfig)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('PubNub connection timeout'))
      }, 10000)

      // The link went (the browser said `offline`, or a subscribe request
      // failed) and has not been reported back yet.
      let lost = false
      let everConnected = false
      const back = () => {
        this._isConnected = true
        if (!lost) return
        lost = false
        // Back after an outage: what we produced meanwhile was not sent, and
        // past the lease we expired the room and the room expired us - on a
        // relay nobody else noticed. The provider asks the room for its
        // presence and pushes what the room has not confirmed
        // (repro-pubnub-lifecycle parts 3 and 4).
        if (everConnected) this._peerConnectCallback?.('pubnub')
      }
      this.pubnub.addListener({
        status: (statusEvent: any) => {
          this.log(`Status: ${statusEvent.category}`, statusEvent)

          if (statusEvent.category === 'PNConnectedCategory') {
            clearTimeout(timeout)
            this.log('✅ Connected to PubNub')
            back()
            if (!everConnected && this.presenceEnabled) this.verifyPresence()
            everConnected = true
            resolve()
          } else if (
            statusEvent.category === 'PNNetworkDownCategory' ||
            // a subscribe request failed: the SDK polls every 3 s until the
            // network answers, then PNReconnectedCategory
            statusEvent.category === 'PNNetworkIssuesCategory' ||
            // the same with `enableEventEngine`, which reports the return as
            // PNConnectedCategory
            statusEvent.category === 'PNDisconnectedUnexpectedlyCategory'
          ) {
            this.log('⚠️ Network is down')
            this._isConnected = false
            lost = true
          } else if (
            statusEvent.category === 'PNNetworkUpCategory' ||
            statusEvent.category === 'PNReconnectedCategory'
          ) {
            this.log('✅ Network is back up')
            back()
          }
        },
        message: (event: any) => {
          // Ignore our own messages
          if (event.publisher === this.uuid || !event.message) return
          try {
            let message = event.message
            if (isChunk(message)) {
              message = this.chunks.push(message)
              if (message === null) return // more to come
            }
            const data =
              typeof message === 'string' ? fromBase64(message) : new Uint8Array(message)
            this.log(`📨 Received ${data.length} bytes from ${event.publisher}`)
            // the publisher uuid is the peer id onPeerDisconnect reports
            if (this.messageCallback) this.messageCallback(data, event.publisher)
            else this.messageBuffer.push({ data, from: event.publisher })
          } catch (error) {
            this.log('❌ Error processing message:', error)
          }
        },
        presence: (event: any) => {
          this.log(`Presence: ${event.action}`, event)
          // PubNub presence (withPresence below): leave = clean unsubscribe,
          // timeout = heartbeat missed. Both mean the peer is gone.
          if (
            (event.action === 'leave' || event.action === 'timeout') &&
            event.uuid &&
            event.uuid !== this.uuid
          ) {
            this._peerDisconnectCallback?.(event.uuid)
          }
        },
      })

      // Subscribe to channel (presence only when asked for - see
      // PubNubTransportOptions.presence; it costs transactions)
      this.pubnub.subscribe({
        channels: [this.channel],
        withPresence: this.presenceEnabled,
      })
    })
  }

  /**
   * Transport.onPeerConnect: fires when the link to PubNub comes BACK - after
   * the browser's `online`, or after the SDK's own reconnect found the
   * network again. Never for the first connect.
   */
  onPeerConnect(callback: (peerId: string) => void): () => void {
    this._peerConnectCallback = callback
    return () => {
      this._peerConnectCallback = undefined
    }
  }

  /**
   * Disconnect from PubNub
   */
  disconnect(): void {
    if (this.pubnub) {
      this.log('Disconnecting from PubNub...')
      this.pubnub.unsubscribeAll()
      this.pubnub = null
    }
    this._isConnected = false
  }

  /**
   * Send data to all peers
   */
  send(data: Uint8Array): void {
    if (!this.pubnub || !this._isConnected) {
      this.log('⚠️ Cannot send: not connected')
      return
    }

    try {
      const base64Data = toBase64(data)
      // Above PubNub's message size: one message per chunk, not stored.
      if (base64Data.length > this.MAX_MESSAGE_SIZE) {
        for (const chunk of splitChunks(base64Data, this.MAX_MESSAGE_SIZE)) this.publish(chunk, false)
        return
      }
      this.remember(base64Data)
      this.publish(base64Data, this.config?.storeInHistory ?? false)
    } catch (error) {
      this.log('❌ Send error:', error)
    }
  }

  private publish(message: unknown, storeInHistory: boolean): void {
    this.pubnub
      .publish({ channel: this.channel, message, storeInHistory })
      .catch((error: any) => this.log('❌ Publish error:', error))
  }

  /**
   * What send() published in the current task - what flush() sends once
   * more if this task turns out to be the page's last.
   */
  private _thisTask: string[] = []
  private _thisTaskClear?: ReturnType<typeof setTimeout>
  private remember(message: string): void {
    this._thisTask.push(message)
    if (this._thisTaskClear === undefined) {
      this._thisTaskClear = setTimeout(() => {
        this._thisTask = []
        this._thisTaskClear = undefined
      }, 0)
    }
  }

  /**
   * Transport.flush: the page is unloading. A publish is a `fetch` of the
   * SDK's, and the SDK sets no `keepalive` (there is no option for it): a
   * page that goes away may take the request with it before it has left.
   * The one message that matters then is the one sent in this very task,
   * our presence removal - lost, and a reloaded page stayed a ghost in every
   * roster for the 30 s lease (2 of 35 reloads, room-scenarios.mjs pubnub,
   * SCENARIOS=join,linger LINGER_GAP_MS=5000). So what went out in this task
   * goes once more as a `keepalive` request straight to the publish REST
   * endpoint, which the browser completes after the page is gone. A copy
   * that arrives twice changes nothing (an awareness state at an equal
   * clock, a Yjs update, a duplicate sequence number are all ignored).
   * Not with a cipher key: the SDK encrypts, this path would not.
   */
  flush(): void {
    const messages = this._thisTask
    this._thisTask = []
    if (messages.length === 0 || !this.config || this.config.cipherKey) return
    if (typeof fetch !== 'function') return
    const { publishKey, subscribeKey } = this.config
    const url =
      `https://ps.pndsn.com/publish/${encodeURIComponent(publishKey)}/${encodeURIComponent(subscribeKey)}/0/` +
      `${encodeURIComponent(this.channel)}/0?uuid=${encodeURIComponent(this.uuid)}` +
      `&store=${this.config.storeInHistory ? 1 : 0}`
    for (const message of messages) {
      const body = JSON.stringify(message)
      if (body.length > 60000) continue // keepalive requests share a 64 KiB budget
      // no headers of our own: a simple request, no CORS preflight to outlive the page
      fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {})
    }
    this.log(`📤 Unloading: ${messages.length} message(s) sent again as keepalive requests`)
  }

  /**
   * Register message callback
   */
  onMessage(callback: (data: Uint8Array, from?: string) => void): () => void {
    this.messageCallback = callback

    // Flush any buffered messages
    if (this.messageBuffer.length > 0) {
      this.log(`📦 Flushing ${this.messageBuffer.length} buffered messages...`)
      for (const { data, from } of this.messageBuffer) {
        callback(data, from)
      }
      this.messageBuffer = []
    }

    return () => {
      this.messageCallback = undefined
    }
  }

  /**
   * With `presence: true`: after subscribing, check that the keyset lists us
   * in hereNow - a keyset without the Presence add-on never emits presence
   * events, and GenericProvider would then trust a leave signal that never
   * comes (departures noticed only after the 5-minute lease).
   */
  private verifyPresence(): void {
    setTimeout(async () => {
      if (!this.pubnub || !this._isConnected) return
      try {
        const response = await this.pubnub.hereNow({
          channels: [this.channel],
          includeUUIDs: true,
        })
        const occupants: Array<{ uuid: string }> =
          response?.channels?.[this.channel]?.occupants ?? []
        if (!occupants.some((o) => o.uuid === this.uuid)) {
          console.warn(
            '[PubNubTransport] presence: true, but the keyset does not list this client in hereNow - ' +
              'enable the Presence add-on for the keyset in the PubNub admin portal, or construct the transport without presence. ' +
              'Until then a departed peer is only removed after the awareness lease.',
          )
        }
      } catch (error) {
        this.log('presence check failed:', error)
      }
    }, 3000)
  }

  /**
   * Get presence information (list of peers)
   */
  async getPresence(): Promise<string[]> {
    if (!this.pubnub || !this._isConnected) {
      return []
    }

    try {
      const response = await this.pubnub.hereNow({
        channels: [this.channel],
        includeUUIDs: true,
      })

      const occupants = response.channels[this.channel]?.occupants || []
      return occupants
        .map((occ: any) => occ.uuid)
        .filter((uuid: string) => uuid !== this.uuid)
    } catch (error) {
      this.log('Error getting presence:', error)
      return []
    }
  }

  /**
   * Generate a unique UUID
   */
  private generateUUID(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID()
    }
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  /**
   * Debug logging
   */
  private log(message: string, ...args: any[]): void {
    if (this.debug) {
      console.log(`[PubNubTransport] ${message}`, ...args)
    }
  }
}
