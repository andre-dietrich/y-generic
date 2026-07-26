import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { Observable } from 'lib0/observable'
import * as bc from 'lib0/broadcastchannel'

import type { Transport, ConnectionConfig, ConnectionStatus } from './transport'

// Message type identifiers
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_PUBSUB = 2
const MESSAGE_SYNC_VERIFIED = 3 // Sync message with hash verification

/**
 * CRC32 lookup table for fast computation.
 * Generated once and reused for all CRC calculations.
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
    table[i] = crc
  }
  return table
})()

/**
 * Compute CRC32 checksum of data for message integrity verification.
 * Fast, non-cryptographic checksum optimized for corruption detection.
 */
function computeCRC32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Wrap message with CRC32 checksum for integrity verification.
 * Format: [CRC32 (4 bytes)][message data]
 */
function wrapMessageWithChecksum(message: Uint8Array): Uint8Array {
  const crc = computeCRC32(message)
  const wrapped = new Uint8Array(4 + message.length)

  // Write CRC32 as 4 bytes (big-endian)
  wrapped[0] = (crc >>> 24) & 0xff
  wrapped[1] = (crc >>> 16) & 0xff
  wrapped[2] = (crc >>> 8) & 0xff
  wrapped[3] = crc & 0xff

  // Copy message data
  wrapped.set(message, 4)

  return wrapped
}

/**
 * Unwrap and verify message integrity using CRC32 checksum.
 * Returns the message data if valid, null if corrupted.
 */
function unwrapAndVerifyMessage(wrapped: Uint8Array): Uint8Array | null {
  if (wrapped.length < 4) {
    return null // Too short to contain CRC32
  }

  // Read CRC32 (big-endian)
  const expectedCrc =
    ((wrapped[0] << 24) |
      (wrapped[1] << 16) |
      (wrapped[2] << 8) |
      wrapped[3]) >>>
    0

  // Extract message data
  const message = wrapped.subarray(4)

  // Compute actual CRC32
  const actualCrc = computeCRC32(message)

  // Verify integrity
  if (actualCrc !== expectedCrc) {
    return null // Checksum mismatch - message corrupted
  }

  return message
}

/**
 * Compute a cheap hash of document state for verification.
 *
 * Hashes the state VECTOR (each client's clock), not the full document
 * content — O(number of distinct clients) instead of O(document content
 * size). `Y.encodeStateVector()` writes entries sorted by clientID, so the
 * result is deterministic regardless of the internal Map's iteration order.
 * Two peers can only reach the same state vector by having applied the same
 * set of operations, so this still catches real content divergence; it just
 * no longer re-serializes the entire document on every single update.
 * (CRC32 already guards against wire corruption, and sequence tracking
 * guards against reordering/loss — this hash is the last line of defense
 * against logical divergence between peers.)
 */
function computeDocHash(doc: Y.Doc): number {
  const state = Y.encodeStateVector(doc)
  let hash = 0
  for (let i = 0; i < state.length; i++) {
    hash = ((hash << 5) - hash + state[i]) | 0
  }
  return hash
}

/**
 * PubSub channel for real-time messaging alongside Yjs.
 * Allows sending ephemeral messages that don't need CRDT properties.
 */
export class PubSubChannel extends Observable<string> {
  private provider: GenericProvider

  constructor(provider: GenericProvider) {
    super()
    this.provider = provider
  }

  /**
   * Publish a message to a topic.
   *
   * @param topic - Topic name (e.g., 'notifications', 'rpc', 'events')
   * @param message - Any JSON-serializable data
   *
   * @example
   * ```typescript
   * provider.pubsub.publish('chat', { user: 'Alice', text: 'Hello!' })
   * provider.pubsub.publish('cursor', { x: 100, y: 200 })
   * ```
   */
  publish(topic: string, message: any): void {
    this.provider._sendPubSub(topic, message)
  }

  /**
   * Subscribe to messages on a topic.
   *
   * @param topic - Topic name to listen to (use '*' for all topics)
   * @param callback - Function called when message received
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsub = provider.pubsub.subscribe('chat', (msg) => {
   *   console.log('Chat:', msg)
   * })
   *
   * // Later: unsub()
   * ```
   */
  subscribe(
    topic: string,
    callback: (message: any, topic: string) => void,
  ): () => void {
    const handler = (message: any, receivedTopic: string) => {
      if (topic === '*' || topic === receivedTopic) {
        callback(message, receivedTopic)
      }
    }

    this.on('message', handler)
    return () => this.off('message', handler)
  }

  /**
   * Internal: Handle incoming pub/sub message
   */
  _handleMessage(topic: string, message: any): void {
    this.emit('message', [message, topic])
  }
}

/**
 * Generic Yjs provider that works with any transport implementation.
 *
 * This provider handles all Yjs synchronization logic including:
 * - Document updates (automatic sync)
 * - Awareness protocol (presence, cursors, etc.)
 * - State vector synchronization
 * - Optional pub/sub channel for real-time messaging
 *
 * You only need to implement the Transport interface for your backend.
 *
 * @example
 * ```typescript
 * // Create your transport
 * const transport = new MyCustomTransport()
 *
 * // Create provider with Yjs document
 * const doc = new Y.Doc()
 * const provider = new GenericProvider(doc, transport)
 *
 * // Connect
 * await provider.connect({ room: 'my-room' })
 *
 * // Provider automatically syncs all changes
 * const ytext = doc.getText('content')
 * ytext.insert(0, 'Hello') // Automatically synced!
 * ```
 */
export class GenericProvider extends Observable<string> {
  public readonly doc: Y.Doc
  public readonly transport: Transport
  public readonly awareness: awarenessProtocol.Awareness
  public readonly pubsub: PubSubChannel

  private _status: ConnectionStatus = { state: 'disconnected' }
  private _synced: boolean = false
  private _destroying: boolean = false
  private _syncInterval: number // ms between periodic syncs
  private _syncIntervalId?: ReturnType<typeof setTimeout>
  private _verifyUpdates: boolean // whether to send/verify hashes
  private _disableBc: boolean // whether to disable BroadcastChannel

  // BroadcastChannel state for cross-tab sync
  private _bcChannel: string = ''
  private _bcConnected: boolean = false
  private _bcSubscriber?: (data: ArrayBuffer, origin: any) => void

  // Hash verification tracking for exponential backoff
  private _hashMismatchCount: number = 0
  private _lastHashMismatchTime: number = 0

  // Rate limiting for sync requests
  private _syncRequestTimes: number[] = []
  private _maxSyncRequestsPerWindow: number = 20 // max requests per 10 seconds
  private _syncRequestWindowMs: number = 10000 // 10 second window

  // SyncStep2 reply suppression (NACK-suppression style): delay a reply to
  // a SyncStep1 request briefly, and drop it if another peer's reply is
  // overheard first - since every reply is broadcast to the whole room
  // anyway, this avoids every peer answering the same request redundantly.
  // Only engages when there's genuine redundancy (see _handleIncomingMessage's
  // MESSAGE_SYNC case) - with 0-1 other known peers there's no "someone
  // else" to rely on, so replies go out immediately as before.
  private _pendingSyncReply: Uint8Array | null = null
  private _pendingSyncReplyTimeoutId?: ReturnType<typeof setTimeout>
  private readonly _syncReplySuppressionMs = 30

  // Sequence numbers for causal ordering
  private _localSeqNum: number = 0 // Our sequence number counter

  // Per-sender sequence tracking for reordering-tolerant gap detection.
  // Applying a Yjs update is always safe even for duplicates or out-of-order
  // arrivals (Yjs updates are idempotent/commutative) — this state exists
  // only to detect genuine gaps (likely packet loss) without false
  // positives from mere network reordering. See _trackRemoteSeq().
  private _remoteSeqInfo: Map<number, { highest: number; seen: Set<number> }> =
    new Map()
  private _gapCheckTimers: Map<number, ReturnType<typeof setTimeout>> =
    new Map()
  private readonly _seqWindowSize = 64
  private readonly _gapGraceMs = 300

  // Message integrity tracking
  private _corruptedMessageCount: number = 0 // Track rejected corrupted messages
  private _lastCorruptedMessageTime: number = 0

  // Update batching/debouncing
  private _batchUpdates: number = 0 // milliseconds delay (0 = disabled)
  private _pendingUpdate: Uint8Array | null = null
  private _batchTimeoutId?: ReturnType<typeof setTimeout>

  // Awareness throttling - prevents awareness from flooding document sync
  private _awarenessInterval: number = 100 // ms between awareness broadcasts
  private _pendingAwarenessClients: Set<number> = new Set()
  private _awarenessTimeoutId?: ReturnType<typeof setTimeout>
  private _lastAwarenessTime: number = 0

  private _updateHandler?: (update: Uint8Array, origin: any) => void
  private _awarenessUpdateHandler?: (changed: any, origin: any) => void
  private _unsubscribeTransport?: () => void
  private _beforeUnloadHandler?: () => void

  /**
   * Create a new generic provider.
   *
   * @param doc - The Yjs document to sync
   * @param transport - Transport implementation for your backend
   * @param options - Optional configuration
   */
  constructor(
    doc: Y.Doc,
    transport: Transport,
    options: {
      awareness?: awarenessProtocol.Awareness
      /**
       * Interval in milliseconds for periodic sync retries.
       * Helps recover from packet loss. Set to 0 to disable.
       * @default 5000
       */
      syncInterval?: number
      /**
       * Send document hash with each update for immediate desync detection.
       * When enabled, mismatch triggers instant re-sync instead of waiting.
       * @default true
       */
      verifyUpdates?: boolean
      /**
       * Batch (debounce) document updates to reduce network traffic.
       * Updates are collected and sent after this delay in milliseconds.
       * Set to 0 to send updates immediately (no batching).
       * Recommended: 50-200ms for good balance between latency and efficiency.
       * @default the transport's `preferredBatchMs` hint if it declares one,
       * otherwise 0 (disabled - immediate transmission)
       */
      batchUpdates?: number
      /**
       * Disable BroadcastChannel for cross-tab communication.
       * When enabled (default), updates are shared instantly between tabs
       * in the same browser without going through the network transport.
       * Automatically disabled in non-browser environments (e.g., Node.js).
       * @default false (BroadcastChannel enabled)
       */
      disableBc?: boolean
      /**
       * Throttle awareness updates to reduce network traffic.
       * Awareness updates (cursors, presence) are batched and sent at this interval.
       * Set to 0 for immediate transmission (not recommended for high-frequency updates).
       * This prevents awareness from flooding document sync on limited transports.
       * @default 100 (100ms between awareness broadcasts)
       */
      awarenessInterval?: number
    } = {},
  ) {
    super()

    this.doc = doc
    this.transport = transport
    this.pubsub = new PubSubChannel(this)
    this.awareness = options.awareness || new awarenessProtocol.Awareness(doc)
    this._syncInterval = options.syncInterval ?? 5000
    this._verifyUpdates = options.verifyUpdates ?? true
    this._batchUpdates =
      options.batchUpdates ?? transport.preferredBatchMs ?? 0
    this._disableBc = options.disableBc ?? false
    this._awarenessInterval = options.awarenessInterval ?? 100

    this._setupDocumentSync()
    this._setupAwarenessSync()
  }

  /**
   * Connect to the backend and start syncing.
   *
   * @param config - Connection configuration passed to transport
   */
  async connect(config: ConnectionConfig): Promise<void> {
    if (this._destroying) {
      throw new Error('Provider is being destroyed')
    }

    // Prevent double connect race condition
    if (this._status.state === 'connected') {
      console.warn(
        '[GenericProvider] Already connected, ignoring connect() call',
      )
      return
    }

    if (this._status.state === 'connecting') {
      console.warn(
        '[GenericProvider] Connection already in progress, ignoring connect() call',
      )
      return
    }

    this._setStatus({ state: 'connecting' })

    try {
      // Setup BroadcastChannel for cross-tab sync (if enabled and available)
      this._setupBroadcastChannel(config)

      // Connect the transport
      await this.transport.connect(config)

      // Register for incoming messages
      this._unsubscribeTransport = this.transport.onMessage((data) => {
        this._handleIncomingMessage(data)
      })

      // When a new WebRTC peer channel opens, immediately push our full state
      // so peers that reconnected after offline edits receive our changes.
      if (this.transport.onPeerConnect) {
        const unsubPeer = this.transport.onPeerConnect((_peerId: string) => {
          if (!this._destroying) this.syncNow()
        })
        const originalUnsub = this._unsubscribeTransport
        this._unsubscribeTransport = () => {
          originalUnsub?.()
          unsubPeer()
        }
      }

      this._setStatus({ state: 'connected' })

      // Send initial sync pushing our local state plus requesting remote state.
      // syncNow() is used instead of _sendSyncStep1() so that any offline edits
      // made before this connect() call are pushed to currently-connected peers
      // (e.g. same-browser tabs via BroadcastChannel).
      this.syncNow()

      // Broadcast local awareness state
      this._broadcastAwareness([this.doc.clientID])

      // Start periodic sync to handle packet loss
      // Just request sync without sending full state (avoid redundant broadcasts)
      // _sendSyncStep1() already checks the shared rate limiter internally
      // and silently drops the request if it's exceeded.
      if (this._syncInterval > 0) {
        this._syncIntervalId = setInterval(() => {
          if (this.transport.isConnected && !this._destroying) {
            this._sendSyncStep1()
          }
        }, this._syncInterval)
      }
    } catch (error) {
      this._setStatus({
        state: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      })
      throw error
    }
  }

  /**
   * Disconnect from the backend.
   * The provider can be reconnected later with connect().
   */
  disconnect(): void {
    // Stop periodic sync
    if (this._syncIntervalId !== undefined) {
      clearInterval(this._syncIntervalId)
      this._syncIntervalId = undefined
    }

    // Reset corruption tracking
    this._corruptedMessageCount = 0
    this._lastCorruptedMessageTime = 0

    // Flush any pending batched updates before disconnecting
    if (this._batchTimeoutId !== undefined) {
      clearTimeout(this._batchTimeoutId)
      this._batchTimeoutId = undefined

      // Send pending update if transport is still connected
      if (this._pendingUpdate && this.transport.isConnected) {
        this._sendUpdate(this._pendingUpdate)
      }
      this._pendingUpdate = null
    }

    // Flush pending awareness updates before disconnecting
    if (this._awarenessTimeoutId !== undefined) {
      clearTimeout(this._awarenessTimeoutId)
      this._awarenessTimeoutId = undefined

      // Send pending awareness if transport is still connected
      if (
        this._pendingAwarenessClients.size > 0 &&
        this.transport.isConnected
      ) {
        const clientsToSend = Array.from(this._pendingAwarenessClients)
        this._sendAwarenessNow(clientsToSend)
      }
    }
    this._pendingAwarenessClients.clear()

    // Disconnect BroadcastChannel
    this._disconnectBroadcastChannel()

    if (this._unsubscribeTransport) {
      this._unsubscribeTransport()
      this._unsubscribeTransport = undefined
    }

    // Mark local client as offline in awareness
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      'disconnect',
    )

    this.transport.disconnect()
    this._synced = false
    this._setStatus({ state: 'disconnected' })
  }

  /**
   * Destroy the provider permanently.
   * Removes all event listeners and cleans up resources.
   */
  destroy(): void {
    this._destroying = true

    // Stop periodic sync (disconnect() will also do this, but be explicit)
    if (this._syncIntervalId !== undefined) {
      clearInterval(this._syncIntervalId)
      this._syncIntervalId = undefined
    }

    // Stop any pending gap-check timers
    for (const timer of this._gapCheckTimers.values()) {
      clearTimeout(timer)
    }
    this._gapCheckTimers.clear()

    // Flush any pending batched updates before destroying
    if (this._batchTimeoutId !== undefined) {
      clearTimeout(this._batchTimeoutId)
      this._batchTimeoutId = undefined

      // Send pending update if transport is still connected
      if (this._pendingUpdate && this.transport.isConnected) {
        this._sendUpdate(this._pendingUpdate)
      }
      this._pendingUpdate = null
    }

    this.disconnect()

    // Remove document update listener
    if (this._updateHandler) {
      this.doc.off('update', this._updateHandler)
      this._updateHandler = undefined
    }

    // Remove awareness update listener
    if (this._awarenessUpdateHandler) {
      this.awareness.off('update', this._awarenessUpdateHandler)
      this._awarenessUpdateHandler = undefined
    }

    // Remove beforeunload handler
    if (this._beforeUnloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler)
      this._beforeUnloadHandler = undefined
    }

    this.awareness.destroy()
    super.destroy()
  }

  /**
   * Current connection status
   */
  get status(): ConnectionStatus {
    return this._status
  }

  /**
   * Whether the provider is connected to the backend
   */
  get connected(): boolean {
    return this.transport.isConnected
  }

  /**
   * Whether BroadcastChannel is connected for cross-tab sync
   */
  get bcConnected(): boolean {
    return this._bcConnected
  }

  /**
   * Whether the document is synced with remote peers
   */
  get synced(): boolean {
    return this._synced
  }

  /**
   * Force an immediate sync with remote peers.
   * Useful after network interruptions or to manually trigger re-sync.
   */
  syncNow(): void {
    if (!this.transport.isConnected) {
      console.warn('Cannot sync: transport not connected')
      return
    }

    // Push (full document state) and pull (SyncStep1 request) share a
    // single rate-limit reservation. syncNow() is called from several
    // triggers that can all fire in a short window when many peers are
    // converging at once (hash-mismatch resyncs, gap-check confirmations,
    // per-peer connect events on mesh transports) - without this gate the
    // push above had NO limit at all, so each trigger broadcast the full
    // document state to the whole room, and those broadcasts caused more
    // reordering/mismatches elsewhere, causing more triggers. Measured in
    // test/dummy/bench-user-scaling.ts: at 100 simulated users this drove
    // message counts to 20-200x the theoretical linear cost. See
    // docs/superpowers/specs/2026-07-26-dummy-benchmark-scaling-design.md.
    if (this._tryReserveSyncSlot()) {
      // Send our current document state to all peers
      // This ensures any changes made while offline are transmitted
      const update = Y.encodeStateAsUpdate(this.doc)
      if (update.length > 0) {
        this._sendUpdate(update)
      }

      // Send sync request to get updates from others
      this._writeSyncStep1()
    }

    // Broadcast current awareness state - independently throttled and much
    // cheaper than a full document push, so it isn't gated by the sync
    // rate limiter above even when the sync half is skipped.
    this._broadcastAwareness([this.doc.clientID])
  }

  /**
   * Setup automatic document synchronization.
   * Listens to document updates and sends them to the transport.
   * If batchUpdates is enabled, updates are debounced/batched.
   */
  private _setupDocumentSync(): void {
    this._updateHandler = (update: Uint8Array, origin: any) => {
      // Don't send updates that originated from this provider
      // This prevents infinite loops when receiving updates
      if (origin !== this) {
        if (this._batchUpdates > 0) {
          // Batch mode: merge updates and debounce
          this._batchUpdate(update)
        } else {
          // Immediate mode: send right away
          this._sendUpdate(update)
        }
      }
    }

    this.doc.on('update', this._updateHandler)
  }

  /**
   * Batch/debounce updates to reduce network traffic.
   * Merges multiple updates and sends after delay.
   */
  private _batchUpdate(update: Uint8Array): void {
    // Merge with pending update if exists
    if (this._pendingUpdate) {
      try {
        // Yjs automatically merges sequential updates
        this._pendingUpdate = Y.mergeUpdates([this._pendingUpdate, update])
      } catch (error) {
        console.error('[GenericProvider] Failed to merge updates:', error)
        // Send the pending update immediately to avoid data loss
        this._sendUpdate(this._pendingUpdate)
        // Start a new batch with the current update
        this._pendingUpdate = update
      }
    } else {
      this._pendingUpdate = update
    }

    // Clear existing timeout
    if (this._batchTimeoutId !== undefined) {
      clearTimeout(this._batchTimeoutId)
    }

    // Set new timeout to send after delay
    this._batchTimeoutId = setTimeout(() => {
      if (this._pendingUpdate) {
        this._sendUpdate(this._pendingUpdate)
        this._pendingUpdate = null
      }
      this._batchTimeoutId = undefined
    }, this._batchUpdates)
  }

  /**
   * Setup automatic awareness synchronization.
   * Listens to awareness changes and broadcasts them.
   */
  private _setupAwarenessSync(): void {
    this._awarenessUpdateHandler = (
      {
        added,
        updated,
        removed,
      }: {
        added: number[]
        updated: number[]
        removed: number[]
      },
      origin: any,
    ) => {
      // Broadcast awareness changes (unless they came from remote)
      const changedClients = added.concat(updated).concat(removed)
      this._broadcastAwareness(changedClients)
    }

    this.awareness.on('update', this._awarenessUpdateHandler)

    // Cleanup: mark as offline and disconnect BC when page unloads
    if (typeof window !== 'undefined') {
      this._beforeUnloadHandler = () => {
        awarenessProtocol.removeAwarenessStates(
          this.awareness,
          [this.doc.clientID],
          'window unload',
        )
        // Disconnect BroadcastChannel to notify other tabs
        this._disconnectBroadcastChannel()
      }
      window.addEventListener('beforeunload', this._beforeUnloadHandler)
    }
  }

  /**
   * Handle incoming messages from the transport.
   * Verifies message integrity with CRC32 before processing.
   * Corrupt messages are rejected immediately without attempting to decode.
   */
  private _handleIncomingMessage(data: Uint8Array): void {
    // Verify message integrity with CRC32 checksum
    const message = unwrapAndVerifyMessage(data)

    if (message === null) {
      // Message is corrupted - reject it immediately
      this._corruptedMessageCount++
      const now = Date.now()

      // Reset counter if it's been stable for 10 seconds
      if (now - this._lastCorruptedMessageTime > 10000) {
        this._corruptedMessageCount = 1
      }
      this._lastCorruptedMessageTime = now

      console.warn(
        `[GenericProvider] 💥 Corrupted message rejected (#${this._corruptedMessageCount}): CRC32 checksum mismatch. ` +
          `This is expected if data corruption simulation is enabled.`,
      )

      // Request re-sync to recover any lost data
      // Use exponential backoff: 100ms, 500ms, 2.5s, then cap at 5s
      const delay = Math.min(
        5000,
        100 * Math.pow(5, Math.min(this._corruptedMessageCount - 1, 3)),
      )

      setTimeout(() => {
        if (this.transport.isConnected && !this._destroying) {
          this._sendSyncStep1()
        }
      }, delay)

      return // Don't process corrupted message
    }

    // Message integrity verified - safe to decode
    try {
      const decoder = decoding.createDecoder(message)
      const messageType = decoding.readVarUint(decoder)

      switch (messageType) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MESSAGE_SYNC)

          const syncMessageType = syncProtocol.readSyncMessage(
            decoder,
            encoder,
            this.doc,
            this, // transaction origin
          )

          // If we received SyncStep2, we're synced
          if (
            syncMessageType === syncProtocol.messageYjsSyncStep2 &&
            !this._synced
          ) {
            this._synced = true
            this.emit('synced', [true])
          }

          // Someone else's SyncStep2 reply just arrived - our own pending
          // reply (if any) is now most likely redundant.
          if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
            this._cancelPendingSyncReply()
          }

          // Send reply if needed. Suppression only engages with genuine
          // redundancy (>=2 other known peers via awareness) - below that,
          // there's no "someone else" to rely on, so reply immediately.
          if (encoding.length(encoder) > 1) {
            if (this.awareness.getStates().size >= 3) {
              this._scheduleSyncReply(encoding.toUint8Array(encoder))
            } else {
              this._send(encoding.toUint8Array(encoder))
            }
          }
          break
        }

        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            this, // origin
          )
          break
        }

        case MESSAGE_PUBSUB: {
          // Read topic
          const topic = decoding.readVarString(decoder)
          // Read message payload
          const payloadBytes = decoding.readVarUint8Array(decoder)

          try {
            // Decode JSON payload
            const decoder = new TextDecoder()
            const payloadStr = decoder.decode(payloadBytes)
            const message = JSON.parse(payloadStr)

            // Emit to pubsub channel
            this.pubsub._handleMessage(topic, message)
          } catch (error) {
            console.error('Error decoding pub/sub message:', error)
          }
          break
        }

        case MESSAGE_SYNC_VERIFIED: {
          // Sync message with sequence number and hash verification
          // Read sequence number and clientID first
          const seqNum = decoding.readVarUint(decoder)
          const senderClientID = decoding.readVarUint(decoder)

          // Track for gap detection only — does NOT gate whether we apply
          // the update below (see _trackRemoteSeq() for why).
          this._trackRemoteSeq(senderClientID, seqNum)

          // Always apply the update. Yjs updates are idempotent/commutative,
          // so re-applying an already-seen update is a harmless no-op.
          // Under reordering, a merely-late (not actually duplicate) update
          // must still be applied here — the old "skip if seqNum <= last
          // seen" logic silently dropped such updates forever whenever a
          // later-numbered message happened to arrive first.
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MESSAGE_SYNC)

          const syncMessageType = syncProtocol.readSyncMessage(
            decoder,
            encoder,
            this.doc,
            this, // transaction origin
          )

          // Read the expected hash from sender (signed integer)
          const expectedHash = decoding.readVarInt(decoder)

          // Compute our local hash after applying the update
          const localHash = computeDocHash(this.doc)

          // Verify hash match
          if (localHash !== expectedHash) {
            // If we already know this sender has a suspected reordering gap
            // (see _trackRemoteSeq()/_scheduleGapCheck()), a hash mismatch
            // right now is the *expected* transient state — we're missing a
            // piece that's very likely still in flight, not actually
            // diverged. Let the pending gap-check grace period resolve it
            // instead of also escalating the hash-mismatch backoff: under
            // heavy reordering this previously caused a burst of mismatches
            // to rack up the exponential backoff to its 10s cap within a
            // single edit burst, purely from timing, not real divergence.
            // A hash mismatch with NO pending gap (in-order, but still
            // wrong) is not explained by reordering and still escalates
            // normally below.
            const reorderingSuspected = this._gapCheckTimers.has(
              senderClientID,
            )

            if (!reorderingSuspected) {
              this._hashMismatchCount++
              const now = Date.now()

              // Reset counter if it's been stable for 10 seconds
              if (now - this._lastHashMismatchTime > 10000) {
                this._hashMismatchCount = 1
              }
              this._lastHashMismatchTime = now

              // Exponential backoff: 10ms, 50ms, 250ms, 1.25s, 6.25s, then cap at 10s
              const delay = Math.min(
                10000,
                10 * Math.pow(5, this._hashMismatchCount - 1),
              )

              console.warn(
                `[GenericProvider] Hash mismatch #${this._hashMismatchCount} detected! Local: ${localHash}, Expected: ${expectedHash}`,
              )
              console.warn(
                `[GenericProvider] Re-sync scheduled in ${delay}ms...`,
              )

              // Push our full state AND request theirs.
              // A hash mismatch means the two peers have diverged — one side may
              // have edits the other lacks.  Calling only _sendSyncStep1() (pull)
              // never delivers our own surplus edits to the other side.
              setTimeout(() => {
                if (this.transport.isConnected && !this._destroying) {
                  this.syncNow()
                }
              }, delay)
            }
          } else {
            // Hash matched - reset failure counter
            this._hashMismatchCount = 0
          }

          // If we received SyncStep2, we're synced (unless hash mismatched)
          if (
            syncMessageType === syncProtocol.messageYjsSyncStep2 &&
            !this._synced &&
            localHash === expectedHash
          ) {
            this._synced = true
            this.emit('synced', [true])
          }

          // Send reply if needed (as standard MESSAGE_SYNC)
          if (encoding.length(encoder) > 1) {
            this._send(encoding.toUint8Array(encoder))
          }
          break
        }

        default:
          console.warn('Unknown message type:', messageType)
      }
    } catch (error) {
      // This should only happen for logic errors, not corruption
      // (corruption is caught by CRC32 check above)
      console.error('[GenericProvider] Error handling message:', error)
    }
  }

  /**
   * Schedule a SyncStep2 reply after a short random delay instead of
   * sending immediately. If another peer's reply is overheard in the
   * meantime (`_cancelPendingSyncReply`), this reply is dropped as
   * redundant - the requester likely already got what it needed.
   */
  private _scheduleSyncReply(reply: Uint8Array): void {
    this._pendingSyncReply = reply
    if (this._pendingSyncReplyTimeoutId !== undefined) return
    const delay = Math.random() * this._syncReplySuppressionMs
    this._pendingSyncReplyTimeoutId = setTimeout(() => {
      this._pendingSyncReplyTimeoutId = undefined
      if (this._pendingSyncReply) {
        this._send(this._pendingSyncReply)
        this._pendingSyncReply = null
      }
    }, delay)
  }

  /** Cancel a pending suppressed reply, if any. */
  private _cancelPendingSyncReply(): void {
    if (this._pendingSyncReplyTimeoutId !== undefined) {
      clearTimeout(this._pendingSyncReplyTimeoutId)
      this._pendingSyncReplyTimeoutId = undefined
    }
    this._pendingSyncReply = null
  }

  /**
   * Track a received sequence number for reordering-tolerant gap detection.
   * Does not gate whether the update gets applied — only decides whether a
   * gap looks suspicious enough to (eventually) request a resync.
   */
  private _trackRemoteSeq(senderClientID: number, seqNum: number): void {
    let info = this._remoteSeqInfo.get(senderClientID)
    if (!info) {
      info = { highest: -1, seen: new Set() }
      this._remoteSeqInfo.set(senderClientID, info)
    }

    if (info.seen.has(seqNum)) {
      return // genuine duplicate - nothing new to track
    }
    info.seen.add(seqNum)

    if (seqNum > info.highest) {
      if (info.highest >= 0 && seqNum > info.highest + 1) {
        this._scheduleGapCheck(senderClientID, info.highest + 1, seqNum - 1)
      }
      info.highest = seqNum
    }

    // Bound memory: forget seqNums far behind the current high-water mark.
    const floor = info.highest - this._seqWindowSize
    if (floor > 0) {
      for (const s of info.seen) {
        if (s < floor) info.seen.delete(s)
      }
    }
  }

  /**
   * Re-check a suspected sequence gap after a short grace period instead of
   * requesting a resync immediately. Pure network reordering (a message
   * that's merely late, not lost) typically resolves itself within the
   * grace window, so this avoids the resync storms that immediate gap
   * detection caused under jitter. Real packet loss still gets caught —
   * just `_gapGraceMs` later — and the periodic sync interval / hash
   * verification remain as further safety nets regardless.
   */
  private _scheduleGapCheck(
    clientID: number,
    gapStart: number,
    gapEnd: number,
  ): void {
    // Only one pending check per sender; a newly-opened gap while a check
    // is already scheduled will still be caught by periodic sync / hash
    // verification even if not by this specific check.
    if (this._gapCheckTimers.has(clientID)) return

    const timer = setTimeout(() => {
      this._gapCheckTimers.delete(clientID)
      const info = this._remoteSeqInfo.get(clientID)
      if (!info || this._destroying) return

      let stillMissing = 0
      for (let s = gapStart; s <= gapEnd; s++) {
        if (!info.seen.has(s)) stillMissing++
      }

      if (stillMissing > 0 && this.transport.isConnected) {
        console.warn(
          `[GenericProvider] Sequence gap confirmed from client ${clientID}: ` +
            `${stillMissing} message(s) still missing after ${this._gapGraceMs}ms grace period`,
        )
        this._sendSyncStep1()
      }
    }, this._gapGraceMs)

    this._gapCheckTimers.set(clientID, timer)
  }

  /**
   * Reserve a slot in the sync rate limiter (max `_maxSyncRequestsPerWindow`
   * per `_syncRequestWindowMs`), recording the request if there's room.
   * Shared by `_sendSyncStep1()` and `syncNow()` so a burst of triggers from
   * different sources (periodic sync, hash-mismatch resyncs, gap-check
   * confirmations) draws from one combined budget instead of each having
   * its own uncapped or separately-capped allowance.
   */
  private _tryReserveSyncSlot(): boolean {
    const now = Date.now()

    // Clean up old entries outside the rate limit window
    this._syncRequestTimes = this._syncRequestTimes.filter(
      (t) => now - t < this._syncRequestWindowMs,
    )

    if (this._syncRequestTimes.length >= this._maxSyncRequestsPerWindow) {
      return false
    }

    this._syncRequestTimes.push(now)
    return true
  }

  /**
   * Encode and send a SyncStep1 message requesting missing updates.
   * Does not check the rate limiter itself - callers must reserve a slot
   * via `_tryReserveSyncSlot()` first.
   */
  private _writeSyncStep1(): void {
    const encoder = encoding.createEncoder()
    // SyncStep1 is always sent as standard MESSAGE_SYNC (no verification)
    // It's just a request, not an assertion of state
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    this._send(encoding.toUint8Array(encoder))
  }

  /**
   * Send SyncStep1 message to request missing updates.
   * This is sent when first connecting to sync with remote peers.
   * Note: SyncStep1 is just a request and doesn't include hash verification.
   * Rate limited to prevent spam.
   */
  private _sendSyncStep1(): void {
    if (!this._tryReserveSyncSlot()) {
      console.warn(
        `[GenericProvider] Sync rate limit exceeded (${this._maxSyncRequestsPerWindow} requests per ${this._syncRequestWindowMs / 1000}s), throttling...`,
      )
      return // Drop the request
    }

    this._writeSyncStep1()
  }

  /**
   * Send a document update to the transport.
   * If verifyUpdates is enabled, includes sequence number and document hash for ordering and desync detection.
   */
  private _sendUpdate(update: Uint8Array): void {
    const encoder = encoding.createEncoder()

    if (this._verifyUpdates) {
      // Use verified sync protocol with sequence number and hash
      encoding.writeVarUint(encoder, MESSAGE_SYNC_VERIFIED)

      // Include sequence number and clientID for causal ordering
      encoding.writeVarUint(encoder, this._localSeqNum++)
      encoding.writeVarUint(encoder, this.doc.clientID)

      syncProtocol.writeUpdate(encoder, update)

      // Include document hash after applying this update (signed integer)
      const hash = computeDocHash(this.doc)
      encoding.writeVarInt(encoder, hash)
    } else {
      // Standard sync protocol without verification
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
    }

    this._send(encoding.toUint8Array(encoder))
  }

  /**
   * Send awareness update to the transport.
   */
  private _sendAwarenessUpdate(changedClients: number[]): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
    )
    this._send(encoding.toUint8Array(encoder))
  }

  /**
   * Send a pub/sub message.
   * Internal method called by PubSubChannel.
   */
  _sendPubSub(topic: string, message: any): void {
    if (!this.transport.isConnected) {
      console.warn('Cannot send pub/sub message: not connected')
      return
    }

    try {
      const encoder = encoding.createEncoder()

      // Write message type
      encoding.writeVarUint(encoder, MESSAGE_PUBSUB)

      // Write topic
      encoding.writeVarString(encoder, topic)

      // Encode message as JSON
      const messageStr = JSON.stringify(message)
      const textEncoder = new TextEncoder()
      const messageBytes = textEncoder.encode(messageStr)

      // Write message payload
      encoding.writeVarUint8Array(encoder, messageBytes)

      this._send(encoding.toUint8Array(encoder))
    } catch (error) {
      console.error('Error sending pub/sub message:', error)
    }
  }

  /**
   * Broadcast awareness state for the specified clients.
   * Throttled to prevent awareness updates from flooding document sync.
   * Multiple rapid updates are batched together.
   */
  private _broadcastAwareness(clients: number[]): void {
    if (clients.length === 0) return

    // If throttling is disabled, send immediately
    if (this._awarenessInterval <= 0) {
      this._sendAwarenessNow(clients)
      return
    }

    // Add clients to pending set
    for (const client of clients) {
      this._pendingAwarenessClients.add(client)
    }

    // If we already have a scheduled broadcast, let it handle the batched clients
    if (this._awarenessTimeoutId !== undefined) {
      return
    }

    // Calculate delay - respect minimum interval since last broadcast
    const now = Date.now()
    const timeSinceLastBroadcast = now - this._lastAwarenessTime
    const delay = Math.max(0, this._awarenessInterval - timeSinceLastBroadcast)

    // Schedule the batched broadcast
    this._awarenessTimeoutId = setTimeout(() => {
      this._awarenessTimeoutId = undefined
      this._lastAwarenessTime = Date.now()

      // Send all pending clients in one message
      const clientsToSend = Array.from(this._pendingAwarenessClients)
      this._pendingAwarenessClients.clear()

      if (clientsToSend.length > 0) {
        this._sendAwarenessNow(clientsToSend)
      }
    }, delay)
  }

  /**
   * Send awareness update immediately without throttling.
   */
  private _sendAwarenessNow(clients: number[]): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
    )
    this._send(encoding.toUint8Array(encoder))
  }

  /**
   * Setup BroadcastChannel for cross-tab communication.
   * Automatically disabled in non-browser environments.
   */
  private _setupBroadcastChannel(config: ConnectionConfig): void {
    // Check if BroadcastChannel is available and not disabled
    if (
      this._disableBc ||
      typeof BroadcastChannel === 'undefined' ||
      typeof window === 'undefined'
    ) {
      return
    }

    // Create channel name based on room
    this._bcChannel = `yjs-${config.room}`

    // Setup subscriber for incoming messages from other tabs
    this._bcSubscriber = (data: ArrayBuffer, origin: any) => {
      // Ignore messages from this provider instance
      if (origin === this) {
        return
      }

      // Messages from BroadcastChannel are already CRC32-wrapped
      // Pass through to _handleIncomingMessage which will unwrap and verify
      const uint8Data = new Uint8Array(data)
      this._handleIncomingMessage(uint8Data)
    }

    // Subscribe to the channel
    bc.subscribe(this._bcChannel, this._bcSubscriber)
    this._bcConnected = true

    // Send initial sync via BroadcastChannel (wrapped with CRC32)
    // This allows syncing with other tabs immediately
    const encoderSync = encoding.createEncoder()
    encoding.writeVarUint(encoderSync, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoderSync, this.doc)
    bc.publish(
      this._bcChannel,
      wrapMessageWithChecksum(encoding.toUint8Array(encoderSync)),
      this,
    )

    // Broadcast local state via BroadcastChannel (wrapped with CRC32)
    const encoderState = encoding.createEncoder()
    encoding.writeVarUint(encoderState, MESSAGE_SYNC)
    syncProtocol.writeSyncStep2(encoderState, this.doc)
    bc.publish(
      this._bcChannel,
      wrapMessageWithChecksum(encoding.toUint8Array(encoderState)),
      this,
    )

    // Broadcast local awareness state via BroadcastChannel (wrapped with CRC32)
    if (this.awareness.getLocalState() !== null) {
      const encoderAwareness = encoding.createEncoder()
      encoding.writeVarUint(encoderAwareness, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        encoderAwareness,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
          this.doc.clientID,
        ]),
      )
      bc.publish(
        this._bcChannel,
        wrapMessageWithChecksum(encoding.toUint8Array(encoderAwareness)),
        this,
      )
    }
  }

  /**
   * Disconnect from BroadcastChannel and mark local client as offline.
   */
  private _disconnectBroadcastChannel(): void {
    if (!this._bcConnected || !this._bcSubscriber) {
      return
    }

    // Broadcast awareness state with null (indicating disconnect) - wrapped with CRC32
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        this.awareness,
        [this.doc.clientID],
        new Map(),
      ),
    )
    bc.publish(
      this._bcChannel,
      wrapMessageWithChecksum(encoding.toUint8Array(encoder)),
      this,
    )

    // Unsubscribe from channel
    bc.unsubscribe(this._bcChannel, this._bcSubscriber)
    this._bcConnected = false
    this._bcSubscriber = undefined
  }

  /**
   * Send data through both BroadcastChannel (if connected) and transport.
   * All messages are wrapped with CRC32 checksum for integrity verification.
   * This ensures updates reach both local tabs and remote peers with corruption detection.
   */
  private _send(data: Uint8Array): void {
    // Wrap message with CRC32 checksum
    const wrappedData = wrapMessageWithChecksum(data)

    // Send via BroadcastChannel to other tabs first
    if (this._bcConnected) {
      bc.publish(this._bcChannel, wrappedData, this)
    }

    // Send via network transport
    if (!this.transport.isConnected) {
      return
    }

    try {
      const result = this.transport.send(wrappedData)
      // Handle async send
      if (result instanceof Promise) {
        result.catch((error) => {
          console.error('Error sending data:', error)
        })
      }
    } catch (error) {
      console.error('Error sending data:', error)
    }
  }

  /**
   * Update connection status and emit event.
   */
  private _setStatus(status: ConnectionStatus): void {
    this._status = status
    this.emit('status', [status])
  }

  /**
   * TEST HELPER: Set local sequence number to a specific value.
   * Used for testing sequence number overflow scenarios.
   * @internal
   */
  _testSetSequenceNumber(seqNum: number): void {
    this._localSeqNum = seqNum
    console.warn(
      `[GenericProvider TEST] Sequence number set to ${seqNum} (MAX_SAFE_INTEGER: ${Number.MAX_SAFE_INTEGER})`,
    )
  }

  /**
   * TEST HELPER: Get current local sequence number.
   * @internal
   */
  _testGetSequenceNumber(): number {
    return this._localSeqNum
  }
}
