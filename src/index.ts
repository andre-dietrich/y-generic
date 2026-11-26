import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { Observable } from 'lib0/observable'
import * as bc from 'lib0/broadcastchannel'

import type { Transport, ConnectionConfig, ConnectionStatus } from './transport'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_PUBSUB = 2
// Sent only by 2.0.x peers; decoded, never sent.
const MESSAGE_SYNC_VERIFIED = 3
const MESSAGE_PUBSUB_TARGETED = 4

// Channel byte in a MESSAGE_AWARENESS frame: [opcode 1][channel][update].
const AWARENESS_CHANNEL_MAIN = 0
const AWARENESS_CHANNEL_APP = 1

// Part of the BroadcastChannel name so tabs still running 2.x (CRC32-framed)
// never meet 3.x tabs. Keep in step with WIRE_TAG in providers/simple-peer.
const WIRE_TAG = 'v3'

/** One awareness instance and its broadcast throttle. */
interface AwarenessChannel {
  id: number // channel byte on the wire
  awareness: awarenessProtocol.Awareness
  pending: Set<number>
  timeoutId?: ReturnType<typeof setTimeout>
  lastSent: number
  onUpdate?: (changed: any, origin: any) => void
}

/** Ephemeral JSON messages alongside the Yjs document. */
export class PubSubChannel extends Observable<string> {
  private provider: GenericProvider

  constructor(provider: GenericProvider) {
    super()
    this.provider = provider
  }

  /** Broadcast a JSON-serializable message on a topic. */
  publish(topic: string, message: any): void {
    this.provider._sendPubSub(topic, message)
  }

  /**
   * Send a message to one target: direct via `transport.sendTo` where
   * available, otherwise broadcast and dropped by providers whose `localId`
   * differs.
   */
  publishTo(target: string, topic: string, message: any): void {
    this.provider._sendPubSubTo(target, topic, message)
  }

  /** Subscribe to a topic ('*' for all); returns an unsubscribe function. */
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

  /** @internal */
  _handleMessage(topic: string, message: any): void {
    this.emit('message', [message, topic])
  }
}

/**
 * Yjs provider over any `Transport`: document sync, two awareness channels
 * (`awareness`, `appAwareness`), pub/sub and cross-tab BroadcastChannel.
 *
 * @example
 * ```typescript
 * const provider = new GenericProvider(new Y.Doc(), new MyTransport())
 * await provider.connect({ room: 'my-room' })
 * ```
 */
export class GenericProvider extends Observable<string> {
  public readonly doc: Y.Doc
  public readonly transport: Transport
  public readonly awareness: awarenessProtocol.Awareness
  // Second Awareness for app/module use, kept separate from `awareness`.
  public readonly appAwareness: awarenessProtocol.Awareness
  public readonly pubsub: PubSubChannel

  private _status: ConnectionStatus = { state: 'disconnected' }
  private _synced: boolean = false
  private _destroying: boolean = false
  private _syncInterval: number
  private _syncIntervalId?: ReturnType<typeof setTimeout>
  private _disableBc: boolean

  private _bcChannel: string = ''
  private _bcConnected: boolean = false
  private _bcSubscriber?: (data: ArrayBuffer, origin: any) => void

  // Shared budget for SyncStep1 pulls, syncNow() pushes and SyncStep2 replies.
  private _syncRequestTimes: number[] = []
  private _maxSyncRequestsPerWindow: number
  private _syncRequestWindowMs: number

  // A SyncStep2 reply waits a random delay and is dropped if another peer's
  // reply arrives first (see _scheduleSyncReply).
  private _pendingSyncReply: Uint8Array | null = null
  private _pendingSyncReplyTimeoutId?: ReturnType<typeof setTimeout>
  private _syncReplySuppressionMs: number

  private _batchUpdates: number = 0 // ms, 0 = send immediately
  private _pendingUpdate: Uint8Array | null = null
  private _batchTimeoutId?: ReturnType<typeof setTimeout>

  private _awarenessInterval: number = 100
  // Indexed by the channel byte.
  private _channels: AwarenessChannel[]

  private _excludeOrigins: Set<any> = new Set()
  private _localId?: string
  private _syncMode: 'push-pull' | 'pull' = 'push-pull'

  private _updateHandler?: (update: Uint8Array, origin: any) => void
  private _unsubscribeTransport?: () => void
  private _beforeUnloadHandler?: () => void

  constructor(
    doc: Y.Doc,
    transport: Transport,
    options: {
      awareness?: awarenessProtocol.Awareness
      appAwareness?: awarenessProtocol.Awareness
      /** Periodic SyncStep1 interval (ms) that recovers lost updates; 0 disables. @default 5000 */
      syncInterval?: number
      /**
       * Debounce document updates by this many ms (0 = send immediately).
       * @default the transport's `preferredBatchMs`, else 0
       */
      batchUpdates?: number
      /** Disable cross-tab BroadcastChannel sync (always off outside browsers). @default false */
      disableBc?: boolean
      /** Minimum ms between awareness broadcasts per channel; 0 = immediate. @default 100 */
      awarenessInterval?: number
      /** Transaction origins whose updates stay local. @default [] */
      excludeOrigins?: any[]
      /** Identity matched against the target of broadcast `publishTo` messages. */
      localId?: string
      /**
       * On connect, 'push-pull' pushes the full local state then requests the
       * remote one (P2P, no authoritative peer); 'pull' only requests it, so a
       * client adopts a relay server's document instead of pushing a stale copy.
       * @default 'push-pull'
       */
      syncMode?: 'push-pull' | 'pull'
      /** Max sync requests (pulls, pushes, replies) per `syncRequestWindowMs`. @default 20 */
      maxSyncRequestsPerWindow?: number
      /** @default 10000 */
      syncRequestWindowMs?: number
      /**
       * Max random delay (ms) before answering a SyncStep1, so another peer's
       * reply can make ours redundant. Used with ≥2 other known peers.
       * @default 30
       */
      syncReplySuppressionMs?: number
    } = {},
  ) {
    super()

    this.doc = doc
    this.transport = transport
    this.pubsub = new PubSubChannel(this)
    this.awareness = options.awareness || new awarenessProtocol.Awareness(doc)
    this.appAwareness =
      options.appAwareness || new awarenessProtocol.Awareness(doc)
    this._syncInterval = options.syncInterval ?? 5000
    this._batchUpdates =
      options.batchUpdates ?? transport.preferredBatchMs ?? 0
    this._disableBc = options.disableBc ?? false
    this._awarenessInterval = options.awarenessInterval ?? 100
    this._excludeOrigins = new Set(options.excludeOrigins ?? [])
    this._localId = options.localId
    this._syncMode = options.syncMode ?? 'push-pull'
    this._maxSyncRequestsPerWindow = options.maxSyncRequestsPerWindow ?? 20
    this._syncRequestWindowMs = options.syncRequestWindowMs ?? 10000
    this._syncReplySuppressionMs = options.syncReplySuppressionMs ?? 30
    const channel = (id: number, awareness: awarenessProtocol.Awareness) => ({
      id,
      awareness,
      pending: new Set<number>(),
      lastSent: 0,
    })
    this._channels = []
    this._channels[AWARENESS_CHANNEL_MAIN] = channel(AWARENESS_CHANNEL_MAIN, this.awareness)
    this._channels[AWARENESS_CHANNEL_APP] = channel(AWARENESS_CHANNEL_APP, this.appAwareness)

    this._setupDocumentSync()
    this._setupAwarenessSync()
  }

  /** Connect the transport and start syncing. */
  async connect(config: ConnectionConfig): Promise<void> {
    if (this._destroying) {
      throw new Error('Provider is being destroyed')
    }

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
      this._setupBroadcastChannel(config)

      // Register before connecting: a transport that retries on its own
      // (WebSocket autoReconnect) may deliver messages from a later attempt.
      this._unsubscribeTransport = this.transport.onMessage((data) => {
        this._handleIncomingMessage(data)
      })

      // Push full state to each new peer so offline edits reach it.
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

      await this.transport.connect(config)

      // disconnect()/destroy() was called while the transport was connecting.
      if (!this._isConnecting()) {
        this.transport.disconnect()
        return
      }

      this._setStatus({ state: 'connected' })

      if (this._syncMode === 'pull') {
        this._sendSyncStep1()
      } else {
        this.syncNow()
      }

      for (const ch of this._channels) this._broadcastAwareness(ch, [this.doc.clientID])

      // Periodic pull only (no full-state push) to recover lost updates.
      if (this._syncInterval > 0) {
        this._syncIntervalId = setInterval(() => {
          if (this.transport.isConnected && !this._destroying) {
            this._sendSyncStep1()
          }
        }, this._syncInterval)
      }
    } catch (error) {
      // Undo the setup so a retry doesn't subscribe twice.
      this._unsubscribeTransport?.()
      this._unsubscribeTransport = undefined
      this._disconnectBroadcastChannel()

      // disconnect() during connecting already set the final status.
      if (!this._isConnecting()) return
      this._setStatus({
        state: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      })
      throw error
    }
  }

  /** Disconnect; connect() may be called again later. */
  disconnect(): void {
    if (this._syncIntervalId !== undefined) {
      clearInterval(this._syncIntervalId)
      this._syncIntervalId = undefined
    }

    // A fresh budget, so the reconnect push carrying offline edits isn't
    // rate-limited by requests made before the disconnect.
    this._syncRequestTimes = []

    // A suppressed reply is redundant by design; discard rather than flush.
    this._cancelPendingSyncReply()

    // Before the flush below, so the throttled removal goes out with it.
    this._removeLocalAwareness('disconnect')

    // Flush pending batched updates and awareness.
    if (this._batchTimeoutId !== undefined) {
      clearTimeout(this._batchTimeoutId)
      this._batchTimeoutId = undefined
      if (this._pendingUpdate && this.transport.isConnected) {
        this._sendUpdate(this._pendingUpdate)
      }
      this._pendingUpdate = null
    }

    for (const ch of this._channels) {
      if (ch.timeoutId === undefined) continue
      clearTimeout(ch.timeoutId)
      ch.timeoutId = undefined
      if (ch.pending.size > 0 && this.transport.isConnected) {
        this._send(this._awarenessFrame(ch, [...ch.pending]))
      }
      ch.pending.clear()
    }

    this._disconnectBroadcastChannel()

    if (this._unsubscribeTransport) {
      this._unsubscribeTransport()
      this._unsubscribeTransport = undefined
    }

    this.transport.disconnect()
    this._synced = false
    this._setStatus({ state: 'disconnected' })
  }

  /** Disconnect and remove all listeners; the provider can't be reused. */
  destroy(): void {
    this._destroying = true

    this.disconnect()

    if (this._updateHandler) {
      this.doc.off('update', this._updateHandler)
      this._updateHandler = undefined
    }

    for (const ch of this._channels) {
      if (ch.onUpdate) ch.awareness.off('update', ch.onUpdate)
      ch.onUpdate = undefined
    }

    if (this._beforeUnloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler)
      this._beforeUnloadHandler = undefined
    }

    this.awareness.destroy()
    this.appAwareness.destroy()
    super.destroy()
  }

  get status(): ConnectionStatus {
    return this._status
  }

  get connected(): boolean {
    return this.transport.isConnected
  }

  get bcConnected(): boolean {
    return this._bcConnected
  }

  /** True once a SyncStep2 has been received. */
  get synced(): boolean {
    return this._synced
  }

  /** Push the full document state, request missing updates and re-send awareness. */
  syncNow(): void {
    if (!this.transport.isConnected) {
      console.warn('Cannot sync: transport not connected')
      return
    }

    // Rate-limited: many peers joining at once each trigger a full-state
    // broadcast (see test/dummy/bench-user-scaling.ts).
    if (this._tryReserveSyncSlot()) {
      const update = Y.encodeStateAsUpdate(this.doc)
      if (update.length > 0) {
        this._sendUpdate(update)
      }
      this._writeSyncStep1()
    }

    // Awareness has its own throttle and isn't rate-limited.
    for (const ch of this._channels) this._broadcastAwareness(ch, [this.doc.clientID])
  }

  private _setupDocumentSync(): void {
    this._updateHandler = (update: Uint8Array, origin: any) => {
      // Skip updates we applied from the network, and local-only origins.
      if (origin === this) return
      if (this._excludeOrigins.has(origin)) return

      if (this._batchUpdates > 0) {
        this._batchUpdate(update)
      } else {
        this._sendUpdate(update)
      }
    }

    this.doc.on('update', this._updateHandler)
  }

  /** Merge updates and send them once no new one arrived for `batchUpdates` ms. */
  private _batchUpdate(update: Uint8Array): void {
    if (this._pendingUpdate) {
      try {
        this._pendingUpdate = Y.mergeUpdates([this._pendingUpdate, update])
      } catch (error) {
        console.error('[GenericProvider] Failed to merge updates:', error)
        this._sendUpdate(this._pendingUpdate)
        this._pendingUpdate = update
      }
    } else {
      this._pendingUpdate = update
    }

    if (this._batchTimeoutId !== undefined) {
      clearTimeout(this._batchTimeoutId)
    }

    this._batchTimeoutId = setTimeout(() => {
      if (this._pendingUpdate) {
        this._sendUpdate(this._pendingUpdate)
        this._pendingUpdate = null
      }
      this._batchTimeoutId = undefined
    }, this._batchUpdates)
  }

  private _setupAwarenessSync(): void {
    for (const ch of this._channels) {
      ch.onUpdate = (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        _origin: any,
      ) => {
        this._broadcastAwareness(
          ch,
          this._awarenessClientsToSend(added.concat(updated, removed)),
        )
      }
      ch.awareness.on('update', ch.onUpdate)
    }

    // On page unload, go offline and tell other tabs.
    if (typeof window !== 'undefined') {
      this._beforeUnloadHandler = () => {
        this._removeLocalAwareness('window unload')
        this._disconnectBroadcastChannel()
      }
      window.addEventListener('beforeunload', this._beforeUnloadHandler)
    }
  }

  private _removeLocalAwareness(origin: string): void {
    for (const ch of this._channels) {
      awarenessProtocol.removeAwarenessStates(ch.awareness, [this.doc.clientID], origin)
    }
  }

  /**
   * Changed awareness clients to broadcast. If the transport reaches every
   * peer, only our own state (relaying others' is N² duplication). Otherwise
   * all of them, which is how presence crosses a partial mesh.
   */
  private _awarenessClientsToSend(changed: number[]): number[] {
    if (this.transport.reachesAllPeers !== true) return changed
    return changed.filter((client) => client === this.doc.clientID)
  }

  /**
   * Handle a frame [opcode][payload] from the transport or another tab.
   * An undecodable frame is dropped; the periodic SyncStep1 recovers it.
   */
  private _handleIncomingMessage(message: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(message)
      const messageType = decoding.readVarUint(decoder)

      switch (messageType) {
        case MESSAGE_SYNC:
          this._handleSyncMessage(decoder)
          break

        case MESSAGE_SYNC_VERIFIED:
          // 2.0.x: [seqNum][senderClientID][sync message][hash]. The hash
          // mismatched on ordinary concurrent edits, so it's ignored.
          decoding.readVarUint(decoder) // seqNum
          decoding.readVarUint(decoder) // senderClientID
          this._handleSyncMessage(decoder)
          break

        case MESSAGE_AWARENESS: {
          const channel = decoding.readVarUint(decoder)
          awarenessProtocol.applyAwarenessUpdate(
            (this._channels[channel] ?? this._channels[AWARENESS_CHANNEL_MAIN]).awareness,
            decoding.readVarUint8Array(decoder),
            this, // origin
          )
          break
        }

        case MESSAGE_PUBSUB: {
          const topic = decoding.readVarString(decoder)
          const payloadBytes = decoding.readVarUint8Array(decoder)

          try {
            const decoder = new TextDecoder()
            const payloadStr = decoder.decode(payloadBytes)
            const message = JSON.parse(payloadStr)
            this.pubsub._handleMessage(topic, message)
          } catch (error) {
            console.error('Error decoding pub/sub message:', error)
          }
          break
        }

        case MESSAGE_PUBSUB_TARGETED: {
          const target = decoding.readVarString(decoder)
          const topic = decoding.readVarString(decoder)
          const payloadBytes = decoding.readVarUint8Array(decoder)

          // Drop messages aimed at someone else (broadcast-and-filter path).
          if (this._localId !== undefined && target !== this._localId) {
            break
          }

          try {
            const message = JSON.parse(new TextDecoder().decode(payloadBytes))
            this.pubsub._handleMessage(topic, message)
          } catch (error) {
            console.error('Error decoding targeted pub/sub message:', error)
          }
          break
        }

        default:
          console.warn('Unknown message type:', messageType)
      }
    } catch (error) {
      console.error('[GenericProvider] Dropping undecodable message:', error)
    }
  }

  /**
   * Apply a y-protocols sync message (SyncStep1, SyncStep2 or update) and
   * send the reply it calls for, if any.
   */
  private _handleSyncMessage(decoder: decoding.Decoder): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)

    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      this.doc,
      this, // transaction origin
    )

    if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
      if (!this._synced) {
        this._synced = true
        this.emit('synced', [true])
      }
      // Another peer answered; our pending reply is likely redundant.
      this._cancelPendingSyncReply()
    }

    // Delay the reply only if ≥2 other peers could answer too.
    if (encoding.length(encoder) > 1) {
      if (this.awareness.getStates().size >= 3) {
        this._scheduleSyncReply(encoding.toUint8Array(encoder))
      } else {
        this._sendSyncReply(encoding.toUint8Array(encoder))
      }
    }
  }

  /**
   * Send a SyncStep2 reply after a random delay unless another peer's reply
   * arrives first. A reply already pending answers a different request, so
   * it is flushed, not overwritten.
   */
  private _scheduleSyncReply(reply: Uint8Array): void {
    if (this._pendingSyncReplyTimeoutId !== undefined) {
      if (this._pendingSyncReply) {
        this._sendSyncReply(this._pendingSyncReply)
      }
      clearTimeout(this._pendingSyncReplyTimeoutId)
      this._pendingSyncReplyTimeoutId = undefined
    }

    this._pendingSyncReply = reply
    const delay = Math.random() * this._syncReplySuppressionMs
    this._pendingSyncReplyTimeoutId = setTimeout(() => {
      this._pendingSyncReplyTimeoutId = undefined
      if (this._pendingSyncReply) {
        this._sendSyncReply(this._pendingSyncReply)
        this._pendingSyncReply = null
      }
    }, delay)
  }

  private _cancelPendingSyncReply(): void {
    if (this._pendingSyncReplyTimeoutId !== undefined) {
      clearTimeout(this._pendingSyncReplyTimeoutId)
      this._pendingSyncReplyTimeoutId = undefined
    }
    this._pendingSyncReply = null
  }

  /**
   * Send a SyncStep2 reply within the shared sync budget, a backstop for
   * when suppression fails. Dropped silently: logging would spam exactly
   * when the room is already noisy.
   */
  private _sendSyncReply(reply: Uint8Array): void {
    if (!this._tryReserveSyncSlot()) return
    this._send(reply)
  }

  /** Take a slot from the shared sync budget; false if it's used up. */
  private _tryReserveSyncSlot(): boolean {
    const now = Date.now()

    this._syncRequestTimes = this._syncRequestTimes.filter(
      (t) => now - t < this._syncRequestWindowMs,
    )

    if (this._syncRequestTimes.length >= this._maxSyncRequestsPerWindow) {
      return false
    }

    this._syncRequestTimes.push(now)
    return true
  }

  /** Send a SyncStep1; the caller must have reserved a sync slot. */
  private _writeSyncStep1(): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    this._send(encoding.toUint8Array(encoder))
  }

  /** Send a SyncStep1 if the sync budget allows. */
  private _sendSyncStep1(): void {
    if (!this._tryReserveSyncSlot()) {
      console.warn(
        `[GenericProvider] Sync rate limit exceeded (${this._maxSyncRequestsPerWindow} requests per ${this._syncRequestWindowMs / 1000}s), throttling...`,
      )
      return
    }

    this._writeSyncStep1()
  }

  private _sendUpdate(update: Uint8Array): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    this._send(encoding.toUint8Array(encoder))
  }

  /** @internal Frame: [MESSAGE_PUBSUB][topic][JSON bytes]. */
  _sendPubSub(topic: string, message: any): void {
    if (!this.transport.isConnected) {
      console.warn('Cannot send pub/sub message: not connected')
      return
    }

    try {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_PUBSUB)
      encoding.writeVarString(encoder, topic)
      const messageBytes = new TextEncoder().encode(JSON.stringify(message))
      encoding.writeVarUint8Array(encoder, messageBytes)

      this._send(encoding.toUint8Array(encoder))
    } catch (error) {
      console.error('Error sending pub/sub message:', error)
    }
  }

  /** @internal Frame: [MESSAGE_PUBSUB_TARGETED][target][topic][JSON bytes]. */
  _sendPubSubTo(target: string, topic: string, message: any): void {
    if (!this.transport.isConnected) {
      console.warn('Cannot send targeted pub/sub message: not connected')
      return
    }

    try {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_PUBSUB_TARGETED)
      encoding.writeVarString(encoder, target)
      encoding.writeVarString(encoder, topic)

      const messageBytes = new TextEncoder().encode(JSON.stringify(message))
      encoding.writeVarUint8Array(encoder, messageBytes)

      const frame = encoding.toUint8Array(encoder)

      if (this.transport.sendTo) {
        // The target may be another tab, reachable only via BroadcastChannel;
        // other tabs drop it by localId.
        if (this._bcConnected) {
          bc.publish(this._bcChannel, frame, this)
        }
        const result = this.transport.sendTo(target, frame)
        if (result instanceof Promise) {
          result.catch((error) => {
            console.error('Error sending targeted pub/sub message:', error)
          })
        }
      } else {
        this._send(frame)
      }
    } catch (error) {
      console.error('Error sending targeted pub/sub message:', error)
    }
  }

  /** Broadcast these clients' awareness, batched to one frame per `awarenessInterval`. */
  private _broadcastAwareness(ch: AwarenessChannel, clients: number[]): void {
    if (clients.length === 0) return

    if (this._awarenessInterval <= 0) {
      this._send(this._awarenessFrame(ch, clients))
      return
    }

    for (const client of clients) ch.pending.add(client)

    // A broadcast is already scheduled and will include them.
    if (ch.timeoutId !== undefined) return

    const delay = Math.max(0, this._awarenessInterval - (Date.now() - ch.lastSent))
    ch.timeoutId = setTimeout(() => {
      ch.timeoutId = undefined
      ch.lastSent = Date.now()
      const clientsToSend = [...ch.pending]
      ch.pending.clear()
      if (clientsToSend.length > 0) {
        this._send(this._awarenessFrame(ch, clientsToSend))
      }
    }, delay)
  }

  /** [MESSAGE_AWARENESS][channel][update]; `states` overrides the current ones. */
  private _awarenessFrame(
    ch: AwarenessChannel,
    clients: number[],
    states?: Map<number, any>,
  ): Uint8Array {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint(encoder, ch.id)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(ch.awareness, clients, states),
    )
    return encoding.toUint8Array(encoder)
  }

  /** Join the room's BroadcastChannel and send our state to other tabs. */
  private _setupBroadcastChannel(config: ConnectionConfig): void {
    if (
      this._disableBc ||
      typeof BroadcastChannel === 'undefined' ||
      typeof window === 'undefined'
    ) {
      return
    }

    this._bcChannel = `yjs-${WIRE_TAG}-${config.room}`

    this._bcSubscriber = (data: ArrayBuffer, origin: any) => {
      if (origin === this) return
      this._handleIncomingMessage(new Uint8Array(data))
    }

    bc.subscribe(this._bcChannel, this._bcSubscriber)
    this._bcConnected = true

    // SyncStep1 + SyncStep2 + awareness, so other tabs sync immediately.
    const encoderSync = encoding.createEncoder()
    encoding.writeVarUint(encoderSync, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoderSync, this.doc)
    bc.publish(
      this._bcChannel,
      encoding.toUint8Array(encoderSync),
      this,
    )

    const encoderState = encoding.createEncoder()
    encoding.writeVarUint(encoderState, MESSAGE_SYNC)
    syncProtocol.writeSyncStep2(encoderState, this.doc)
    bc.publish(
      this._bcChannel,
      encoding.toUint8Array(encoderState),
      this,
    )

    for (const ch of this._channels) {
      if (ch.awareness.getLocalState() !== null) {
        bc.publish(this._bcChannel, this._awarenessFrame(ch, [this.doc.clientID]), this)
      }
    }
  }

  /** Tell other tabs we're offline (null awareness) and leave the channel. */
  private _disconnectBroadcastChannel(): void {
    if (!this._bcConnected || !this._bcSubscriber) {
      return
    }

    for (const ch of this._channels) {
      const offline = this._awarenessFrame(ch, [this.doc.clientID], new Map())
      bc.publish(this._bcChannel, offline, this)
    }

    bc.unsubscribe(this._bcChannel, this._bcSubscriber)
    this._bcConnected = false
    this._bcSubscriber = undefined
  }

  /** Send a frame to other tabs and through the transport. */
  private _send(data: Uint8Array): void {
    if (this._bcConnected) {
      bc.publish(this._bcChannel, data, this)
    }

    if (!this.transport.isConnected) {
      return
    }

    try {
      const result = this.transport.send(data)
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
   * A method rather than an inline check so TypeScript doesn't narrow
   * `_status` across the await in connect(), where disconnect() may change it.
   */
  private _isConnecting(): boolean {
    return this._status.state === 'connecting'
  }

  private _setStatus(status: ConnectionStatus): void {
    this._status = status
    this.emit('status', [status])
  }
}
