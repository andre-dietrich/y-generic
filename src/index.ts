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
const MESSAGE_BATCH = 4 // Envelope for N independently-typed sub-messages sent as one wire message
// Digest beacon: replaces SyncStep1 on the wire. [version][flags][sender
// clientID][state vector][delete-set hash]. Receivers reply only when the
// sender is behind them or the delete-set hashes differ (SyncStep2, as
// before), or - on a JOIN-flagged beacon with equal state - with their own
// beacon as an ack; otherwise not at all. See
// docs/superpowers/specs/2026-09-05-digest-beacon-design.md and
// _handleDigest(). Versions are append-only: receivers read the fields
// they know and ignore trailing bytes.
const MESSAGE_SYNC_DIGEST = 5
const DIGEST_VERSION = 1
const DIGEST_FLAG_JOIN = 1 // bit 0: "I just joined - send me your presence and confirm my state"
// bit 1: this message is an ACK, not a request. It echoes the state vector
// and delete-set hash of the JOIN beacon it answers ("I hold exactly this
// state too"), never the sender's own state - so it is never read as a
// request and never collects a SyncStep2 from anyone. Receivers whose state
// equals the echoed digest mark themselves synced (the joiner it was for,
// and everyone else in that state); receivers holding a pending ack for the
// same digest drop it. See _handleDigest(). Before this flag existed the ack
// was the acker's own beacon; an acker that was itself behind the room (a
// joiner acking another joiner) made every peer ahead of it reply with a
// SyncStep2, and acks landing after an edit burst had started did the same
// (Task 3c in the design doc).
const DIGEST_FLAG_ACK = 2
// bit 2: "ack me if our states are equal" WITHOUT the presence request of
// DIGEST_FLAG_JOIN. Sent only by the response-wait retry
// (_armResponseWait): a joiner that gets neither a SyncStep2 nor an ack
// within the wait has lost one message or the other and asks again - reply
// suppression deliberately leaves ~1 reply per request, so a single lost
// reply would otherwise strand the joiner's `synced` until the next
// periodic beacon (never, with syncInterval 0). Measured: the last joiner
// of a simultaneous 5-peer burst at 10% loss failed to reach `synced` in 1
// of 600 runs before this existed. Resync beacons do NOT request acks: in
// an equal room every peer would answer, and at high latency the
// suppression window cannot thin those replies (measured 4-5x more acks).
const DIGEST_FLAG_CONFIRM = 4
// Full-state push (connect()/syncNow()): the whole document as one update,
// no hash, no sequence number, applied and nothing else. Before this type a
// push was a MESSAGE_SYNC_VERIFIED update whose hash was the PUSHER's state
// - every peer holding more data read that as divergence and scheduled a
// resync of its own (research doc item 12), the seed of the cascade in item
// 13. Not a SyncStep2 either: receiving one must not flip `synced` (an
// empty joiner's push says nothing about the room's content). See
// docs/superpowers/specs/2026-09-05-resync-cascade-design.md.
const MESSAGE_SYNC_PUSH = 6

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

/** Byte-wise equality of two Uint8Arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Whether this runtime has the Compression Streams API (Node 18+, all
 * evergreen browsers). Checked once at module load; compressionThresholdBytes
 * falls back to sending uncompressed (still flag-byte-prefixed, flag=0) if
 * this is false, rather than throwing.
 */
const COMPRESSION_AVAILABLE =
  typeof CompressionStream !== 'undefined' &&
  typeof DecompressionStream !== 'undefined'

/** Drain a ReadableStream<Uint8Array> into a single concatenated Uint8Array. */
async function _readAllChunks(
  readable: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Compress with deflate-raw (no gzip header/trailer - see
 * compressionThresholdBytes's doc comment for why deflate-raw over gzip).
 */
async function compressDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw')
  const writer = cs.writable.getWriter()
  writer.write(data as unknown as BufferSource)
  writer.close()
  return _readAllChunks(cs.readable)
}

/** Inverse of compressDeflateRaw(). */
async function decompressDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const writer = ds.writable.getWriter()
  writer.write(data as unknown as BufferSource)
  writer.close()
  return _readAllChunks(ds.readable)
}

/**
 * Prepend a 1-byte compressed(1)/uncompressed(0) flag. Only used when
 * compressionThresholdBytes is configured - see that option's doc comment
 * for why this is a deliberate, opt-in wire-format change.
 */
function prefixCompressionFlag(flag: 0 | 1, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + data.length)
  out[0] = flag
  out.set(data, 1)
  return out
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
 * Cheap, peer-deterministic hash of the document's delete set - the half of
 * a Yjs document's identity that the state vector does NOT cover (yjs
 * INTERNALS.md: "deletions are tracked in the DeleteSet, and do not update
 * the state vector"). Two docs that differ only by a lost delete-only
 * update have identical state vectors, so `computeDocHash` can never
 * detect that divergence; this hash can, at heartbeat granularity (see
 * `_encodeSyncStep1()` / `_handleDigest()`).
 *
 * Cost: `Y.createDeleteSetFromStructStore` walks every struct (Yjs keeps no
 * incremental delete set), so this is O(items) - fine once per heartbeat
 * (every empty SyncStep2 already did this exact walk inside
 * `encodeStateAsUpdate`), NOT fine per update; hence the cache in
 * `_deleteSetHash()`. Per-client runs come out already sorted and merged;
 * the only per-peer non-determinism is `Map` insertion order, fixed by
 * sorting client IDs before hashing.
 *
 * Exported for the property check in test/dummy/bench-idle-room.ts.
 * @internal
 */
export function computeDeleteSetHash(doc: Y.Doc): number {
  const ds = Y.createDeleteSetFromStructStore(doc.store)
  const encoder = encoding.createEncoder()
  const clients = Array.from(ds.clients.keys()).sort((x, y) => x - y)
  for (const client of clients) {
    encoding.writeVarUint(encoder, client)
    for (const item of ds.clients.get(client)!) {
      encoding.writeVarUint(encoder, item.clock)
      encoding.writeVarUint(encoder, item.len)
    }
  }
  return computeCRC32(encoding.toUint8Array(encoder))
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
  private _syncInterval: number // ms between periodic syncs (base, unbacked-off)
  private _syncIntervalId?: ReturnType<typeof setTimeout>
  private _verifyUpdates: boolean // whether to send/verify hashes
  private _disableBc: boolean // whether to disable BroadcastChannel

  // Idle backoff for the periodic-sync interval - see idleBackoffEnabled's
  // doc comment. `_currentSyncIntervalMs` is what `_jitteredSyncInterval()`
  // actually jitters; it equals `_syncInterval` for the entire connected
  // lifetime unless `_idleBackoffEnabled` is true, which is the mechanism
  // that makes this option provably invisible when off (same field, same
  // value, same jitter formula as before this option existed).
  private _idleBackoffEnabled: boolean
  private _idleBackoffMaxMs: number
  private _currentSyncIntervalMs: number
  private _lastActivityTime: number = Date.now()
  private _lastPeriodicTickTime: number = Date.now()

  // BroadcastChannel state for cross-tab sync
  private _bcChannel: string = ''
  private _bcConnected: boolean = false
  private _bcSubscriber?: (data: ArrayBuffer, origin: any) => void

  // Unified resync-request coordinator. Previously hash-mismatch,
  // corrupted-message, and gap-confirmed triggers each coalesced only
  // against themselves (three separate pending-timer fields, three
  // separate escalation counters), so under sustained wire corruption they
  // could each independently burn through the shared _tryReserveSyncSlot()
  // budget in the same window - a resync storm that grew combinatorially
  // with peer count (see test/dummy/bench-corruption-storm.ts: at 10
  // simulated peers, 5% per-link corruption drove message volume to ~11x
  // the corruption-free baseline). Now there is exactly ONE pending timer
  // and ONE shared escalation counter for all three triggers - only one
  // resync is ever in flight at a time, and any trigger that fires while
  // one is already pending is absorbed into it instead of scheduling its
  // own. See _requestResync().
  private _resyncAttemptCount: number = 0
  private _lastResyncAttemptTime: number = 0
  private _pendingResyncTimeoutId?: ReturnType<typeof setTimeout>

  // Rate limiting for sync traffic - two budgets since phase 1b: one for
  // what we ask for (beacons, pushes, syncNow), one for what we owe
  // (SyncStep2 replies, acks). With a single shared budget a join burst's
  // replies spent the slots a peer needed for its own recovery (measured:
  // joiners arriving within 10 s of a burst converged in 13 s once, and a
  // 50-peer room's periodic beacons ran at a third of their rate for 10 s
  // after every join burst). Same size, same window, independent.
  private _syncRequestTimes: number[] = []
  private _syncReplyTimes: number[] = []
  private _maxSyncRequestsPerWindow: number // max requests per window (per budget)
  private _syncRequestWindowMs: number // rate-limit window, ms

  // SyncStep2 reply suppression (NACK-suppression style): delay a reply to
  // a SyncStep1 request briefly, and drop it if another peer's reply is
  // overheard first - since every reply is broadcast to the whole room
  // anyway, this avoids every peer answering the same request redundantly.
  // Only engages when there's genuine redundancy (see _handleIncomingMessage's
  // MESSAGE_SYNC and MESSAGE_SYNC_VERIFIED cases) - with 0-1 other known
  // peers there's no "someone else" to rely on, so replies go out
  // immediately as before.
  private _pendingSyncReply: Uint8Array | null = null
  private _pendingSyncReplyTimeoutId?: ReturnType<typeof setTimeout>
  private _syncReplySuppressionMs: number
  // Whether _pendingSyncReply is a digest-beacon ack (see _handleDigest())
  // rather than a SyncStep2. An overheard beacon with a digest equal to ours
  // makes a pending ACK redundant (the joiner it was for has received that
  // same beacon and is synced by it) but says nothing about a pending
  // SyncStep2, which carries data - so only acks are cancelled on that
  // signal. Measured in test/dummy/bench-user-scaling.ts: without this, acks
  // were ~94% of a 50-peer join burst's messages (Task 3b in the design doc).
  private _pendingSyncReplyIsAck: boolean = false
  // The requester's state vector the pending SyncStep2 answers (null for
  // acks and for replies to plain SyncStep1s). A later request with the
  // same state vector is the same question: the pending reply's bytes are
  // refreshed to the current document and the timer kept, instead of the
  // old reply being flushed as "a different request" - measured: with one
  // peer typing while K empty peers join, keystroke and JOIN-beacon
  // arrivals interleave at random, every keystroke in between changed the
  // reply bytes, and each settled peer flushed up to K replies (Task 7 in
  // the phase-1b design doc).
  private _pendingSyncReplyTargetSv: Uint8Array | null = null

  // Response-wait for our own JOIN/CONFIRM/resync beacons - see
  // DIGEST_FLAG_CONFIRM and _armResponseWait(). A SyncStep2 or an equal
  // ack/beacon counts as a response.
  private _responseWaitTimer?: ReturnType<typeof setTimeout>
  private _responseWaitAttempts: number = 0
  private _responseSeen: boolean = false
  private _responseWaitFlags: number = 0 // flags for the retry beacon: CONFIRM after a JOIN, 0 after a resync
  private _pendingCheckTimer?: ReturnType<typeof setTimeout> // see _schedulePendingCheck()

  // Round-trip estimate from our own requests (JOIN/resync beacon -> first
  // SyncStep2 or ack): the minimum of the last 8 samples, because a sample
  // includes the responder's random suppression delay and the fastest
  // reply had the least of it. Drives _replySuppressionMaxDelay() (a
  // suppression window shorter than the one-way latency suppresses
  // nothing: at 250-350 ms latency every peer ahead of a requester replied
  // before any reply could be overheard, ~20 replies per request at N=100)
  // and _armResponseWait()'s first delay (a fixed 1 s fired premature
  // retries on the Matrix profile). See the phase-1b design doc, 1c.
  private _rttSamples: number[] = []
  private _requestSentAt: number = 0

  // ClientIDs we have heard from directly (beacon and verified-update
  // senders). The reply-suppression gate ("is there someone else who could
  // answer?") used awareness alone, and in a join burst the awareness
  // messages trail the beacons - so the gate was still closed exactly when
  // 49 requests arrived at once, and every one got an immediate reply
  // (phase-1b design, item 3). Cleared on disconnect.
  private _knownPeers: Set<number> = new Set()

  // One timer that answers every JOIN beacon arriving within its window
  // with a single presence broadcast (phase-1b design, item 4). The 100 ms
  // cursor throttle is the wrong coalescing window for this: at 350 ms
  // latency a 50-peer join burst's beacons spread over several of them and
  // each peer re-announced presence 2-3 times per burst.
  private _presenceResponseTimer?: ReturnType<typeof setTimeout>

  // Same NACK-style suppression as _pendingSyncReply above, applied to
  // awareness updates that are a pure timeout-triggered removal (see
  // _scheduleAwarenessRemoval()) - every OTHER connected peer runs its own
  // independent 30s outdatedTimeout sweep (y-protocols/awareness.js), so
  // one peer going silent (crash/dirty drop, not a clean disconnect())
  // causes an O(N) simultaneous "peer X is gone" broadcast burst without
  // this. See docs/superpowers/specs/2026-09-04-sync-optimization-round-3-ideas.md
  // item 7 and test/dummy/bench-awareness-removal-burst.ts.
  private _pendingAwarenessRemoval: number[] | null = null
  private _pendingAwarenessRemovalTimeoutId?: ReturnType<typeof setTimeout>

  // onPeerConnect debounce: coalesces a burst of near-simultaneous
  // onPeerConnect events (e.g. many mesh peers joining within a short
  // window) into a single syncNow() call instead of one per event. See
  // connect()'s onPeerConnect handler and _schedulePeerConnectSync().
  private _peerConnectDebounceMs: number
  private _pendingPeerConnectSyncTimeoutId?: ReturnType<typeof setTimeout>

  // Outgoing-payload compression, gated by size. See
  // compressionThresholdBytes's doc comment for the wire-format
  // compatibility tradeoff of enabling this at all.
  private _compressionThresholdBytes?: number

  // Cached computeDeleteSetHash(doc); null = stale. Invalidated on every
  // doc 'update' (deletes are content changes, so this is exact; inserts
  // invalidate needlessly but cheaply). See computeDeleteSetHash's doc for
  // why this must not be recomputed per update.
  private _dsHashCache: number | null = null

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
  private _seqWindowSize: number
  private _gapGraceMs: number

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
      /**
       * Max number of sync requests (digest beacons and syncNow() pushes
       * combined) this provider will send within `syncRequestWindowMs` -
       * and, as a separate budget of the same size, max number of sync
       * replies (SyncStep2, acks) it will send in that window.
       * Protects against self-inflicted resync storms (e.g. many hash
       * mismatches firing in a short window under packet loss). Raise this
       * if legitimate resyncs are being throttled under heavy loss; lower
       * it to bound worst-case traffic more aggressively per peer.
       * @default 20
       */
      maxSyncRequestsPerWindow?: number
      /**
       * Rolling time window (ms) over which `maxSyncRequestsPerWindow` is
       * enforced.
       * @default 10000
       */
      syncRequestWindowMs?: number
      /**
       * Base max random delay (ms) before replying to a SyncStep1 request,
       * used to let other peers' replies pre-empt a redundant one
       * (NACK-style suppression). Only engages once at least 2 other peers
       * are known via awareness. The actual max delay scales up from this
       * base with room size (see `_replySuppressionMaxDelay()`) - a larger
       * room has more repliers racing within the same window, so it's given
       * more time for the "someone already answered" signal to be overheard
       * before more repliers commit. This option is the small-room baseline
       * and the growth-rate multiplier's unit, not a hard cap (see the
       * `200`ms cap in `_replySuppressionMaxDelay()`).
       * @default 30
       */
      syncReplySuppressionMs?: number
      /**
       * Debounce window (ms) for coalescing onPeerConnect-triggered
       * syncNow() calls. Mesh transports (peerjs, simple-peer) fire
       * onPeerConnect once per newly-connected remote peer; without
       * coalescing, N peers joining within a short window each
       * independently trigger a full-state broadcast to everyone already
       * connected - an O(N^2) burst. A burst of onPeerConnect events within
       * this window collapses into a single syncNow() call.
       * @default 50
       */
      peerConnectDebounceMs?: number
      /**
       * Grace period (ms) after detecting a suspected sequence-number gap
       * before requesting a resync. Tolerates mere network reordering
       * without treating it as loss; lower it to detect genuine packet loss
       * faster at the risk of more false-positive resyncs under jitter.
       * @default 300
       */
      gapGraceMs?: number
      /**
       * Number of recent sequence numbers retained per remote peer for
       * duplicate/gap detection. Raise if a transport can deliver messages
       * extremely out of order across a wide window; the default is ample
       * for typical reordering/jitter.
       * @default 64
       */
      seqWindowSize?: number
      /**
       * Minimum payload size (bytes, measured on the CRC32-wrapped bytes
       * about to be sent) above which a message is compressed
       * (`deflate-raw`, via the standard CompressionStream/
       * DecompressionStream Web API) before being handed to the network
       * transport. Below this size, messages are sent byte-for-byte as they
       * are today.
       *
       * Measured on synthetic Yjs docs (test/dummy/bench-compression-ratio.ts):
       * a single-keystroke update (~20 bytes) actually gets BIGGER under
       * gzip (fixed ~18-byte header/trailer) and is break-even at best under
       * deflate-raw - not worth the async round trip through the
       * Compression Streams API for a handful of bytes saved. A clean
       * ~3.3KB doc compresses ~17x; a ~45KB doc with heavy edit-history
       * churn (tombstones from insert/delete cycles) still compresses ~8x.
       * 2048 is chosen so ordinary typing traffic (tens to a few hundred
       * bytes per update - the majority of real-world traffic per this
       * project's prior benchmark rounds) NEVER crosses it and is completely
       * unaffected, while a full-document push/reply large enough to matter
       * (and, on chunking transports like PubNub/Ably, large enough to
       * multiply into several wire messages) reliably compresses down well
       * below its own pre-compression size.
       *
       * `deflate-raw` (not `gzip`) is used deliberately: gzip's fixed
       * header/trailer overhead makes it a net loss for anything under
       * roughly 200 bytes (measured), while deflate-raw has ~0 fixed
       * overhead and compresses at least as well for every size measured.
       *
       * IMPORTANT - wire-format compatibility: this project has no
       * versioned wire-protocol negotiation. Enabling this (any truthy
       * value) changes the wire format for EVERY message this instance
       * sends: a 1-byte compressed/uncompressed flag is prepended ahead of
       * the existing CRC32 wrapper on every message, compressed or not, so
       * the receiving side can unambiguously tell them apart. A peer NOT
       * running this option (or running an older version of this library)
       * will misinterpret that leading flag byte as the start of the CRC32
       * wrapper and reject every message as corrupted. All peers in a room
       * must set this the same way (all enabled, or all disabled) for the
       * room to function. This is a real, deliberate tradeoff - not a
       * detail - which is why this defaults to fully disabled rather than
       * auto-enabling above some size unconditionally.
       *
       * `0` or `undefined` disables compression entirely and keeps the wire
       * format byte-for-byte identical to before this option existed.
       * @default undefined (compression disabled, wire format unchanged)
       */
      compressionThresholdBytes?: number
      /**
       * Back off the periodic-sync interval (see `syncInterval`) when the
       * room is idle, instead of ticking at a fixed cadence forever. After
       * each periodic tick that saw no activity since the previous tick -
       * no local or remote document change, no local or remote awareness
       * change, no corrupted/rejected wire message - the interval DOUBLES
       * (capped at `idleBackoffMaxMs`) for the next tick. Any activity
       * resets it immediately back to `syncInterval`. Deliberately does NOT
       * count the periodic tick's own routine SyncStep1/SyncStep2 exchange
       * as activity (see `_markActivity()`'s doc comment for why treating
       * that as activity would make this option a no-op - an earlier draft
       * of this feature made exactly that mistake, caught by this option's
       * own bench script). Still composes with the existing +/-20% jitter
       * (`_jitteredSyncInterval()`) at whatever the current backed-off value
       * is.
       *
       * TRADEOFF - read before enabling: periodic sync exists as a
       * loss-recovery backstop (catch a message that was silently dropped).
       * Backing it off during idle periods directly trades away worst-case
       * recovery latency for exactly the scenario it exists to cover: a
       * message dropped right after the room goes quiet won't be caught by
       * periodic sync until the NEXT tick, which by then may be up to
       * `idleBackoffMaxMs` away instead of `syncInterval` away. Measured in
       * test/dummy/bench-idle-backoff.ts: with default settings (5s base,
       * 60s cap), a loss injected early in an idle stretch can take on the
       * order of the current backed-off interval (up to ~60s) to recover,
       * vs. one `syncInterval` (~5s) with this off - see that bench's own
       * output/header for the exact run's numbers. This is a real
       * bandwidth-vs-recovery-latency tradeoff, not a free win, which is why
       * this defaults to OFF.
       * @default false (no backoff - identical behavior to before this
       * option existed)
       */
      idleBackoffEnabled?: boolean
      /**
       * Ceiling (ms) for the backed-off periodic-sync interval when
       * `idleBackoffEnabled` is true. Doubling from a 5000ms base reaches
       * this in 4 idle ticks (5s/10s/20s/40s/60s). 60000 is chosen so the
       * worst-case loss-recovery latency this trades away stays the same
       * order of magnitude as `y-protocols/awareness`'s own built-in
       * peer-removal timeout (30s, halved from its 60s+ `_checkInterval`
       * sweep window) rather than growing unbounded - a room silent long
       * enough to be fully backed off is, on this timescale, already close
       * to "everyone's gone idle/timed out" territory anyway. Ignored when
       * `idleBackoffEnabled` is false.
       * @default 60000
       */
      idleBackoffMaxMs?: number
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
    this._maxSyncRequestsPerWindow = options.maxSyncRequestsPerWindow ?? 20
    this._syncRequestWindowMs = options.syncRequestWindowMs ?? 10000
    this._syncReplySuppressionMs = options.syncReplySuppressionMs ?? 30
    this._peerConnectDebounceMs = options.peerConnectDebounceMs ?? 50
    this._gapGraceMs = options.gapGraceMs ?? 300
    this._seqWindowSize = options.seqWindowSize ?? 64
    this._compressionThresholdBytes = options.compressionThresholdBytes || undefined
    this._idleBackoffEnabled = options.idleBackoffEnabled ?? false
    this._idleBackoffMaxMs = options.idleBackoffMaxMs ?? 60000
    this._currentSyncIntervalMs = this._syncInterval

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

      // Register for incoming messages and new-peer notifications BEFORE
      // connecting the transport. Some transports (e.g. PeerJS for a
      // joining, non-coordinator peer) establish and fully open their first
      // connection *inside* transport.connect() itself — so a peer-connect
      // notification or an immediate reply from the other side can arrive
      // before that promise resolves. Registering after the await left
      // exactly that window uncovered: whatever arrived during it was
      // silently dropped since neither callback was wired up yet.
      this._unsubscribeTransport = this.transport.onMessage((data) => {
        this._handleIncomingMessage(data)
      })

      if (this.transport.onPeerConnect) {
        const unsubPeer = this.transport.onPeerConnect((_peerId: string) => {
          if (!this._destroying) this._schedulePeerConnectSync()
        })
        const originalUnsub = this._unsubscribeTransport
        this._unsubscribeTransport = () => {
          originalUnsub?.()
          unsubPeer()
        }
      }

      // Connect the transport
      await this.transport.connect(config)

      this._setStatus({ state: 'connected' })

      // Send initial sync pushing our local state plus requesting remote state.
      // syncNow() is used instead of _sendSyncStep1() so that any offline edits
      // made before this connect() call are pushed to currently-connected peers
      // (e.g. same-browser tabs via BroadcastChannel).
      this.syncNow()
      // (Local awareness goes out inside syncNow()'s batch, or via its
      // throttled fallback - a second broadcast here was a duplicate 100ms
      // later.)

      // Start periodic sync to handle packet loss
      // Just request sync without sending full state (avoid redundant broadcasts)
      // _sendSyncStep1() already checks the shared rate limiter internally
      // and silently drops the request if it's exceeded.
      //
      // Uses a recursive setTimeout (re-jittered by ~20% each tick) rather
      // than a plain setInterval so peers that connect() within a short
      // window of each other - the common case: everyone joining a room
      // near session start, or reconnecting together after a shared network
      // blip - don't end up with near-synchronized periodic timers that all
      // fire in the same few milliseconds every syncInterval. This doesn't
      // reduce total periodic-sync traffic, only spreads it out so a room's
      // background traffic is smooth instead of bursty.
      if (this._syncInterval > 0) {
        // Reset idle-backoff state on every (re)connect so a reconnect
        // always starts its first tick at the base interval, never
        // inheriting a backed-off value left over from a previous session.
        this._currentSyncIntervalMs = this._syncInterval
        this._lastActivityTime = Date.now()
        this._lastPeriodicTickTime = Date.now()
        const scheduleNextPeriodicSync = () => {
          this._syncIntervalId = setTimeout(() => {
            const tickTime = Date.now()
            if (this._idleBackoffEnabled) {
              // "Activity" = anything _markActivity() call sites observed
              // (incoming message via transport or BroadcastChannel, local
              // or remote doc change, local or remote awareness change)
              // since the LAST tick fired - not since backoff started, so a
              // single quiet tick after a burst of activity still resets to
              // base rather than needing a full quiet cycle to catch up.
              const hadActivitySinceLastTick =
                this._lastActivityTime > this._lastPeriodicTickTime
              this._currentSyncIntervalMs = hadActivitySinceLastTick
                ? this._syncInterval
                : Math.min(
                    this._idleBackoffMaxMs,
                    this._currentSyncIntervalMs * 2,
                  )
            }
            this._lastPeriodicTickTime = tickTime
            if (this.transport.isConnected && !this._destroying) {
              // Beacon only. Presence is no longer re-announced per tick on
              // any transport: a joiner requests it via DIGEST_FLAG_JOIN
              // (see _handleDigest()), and y-protocols/awareness renews the
              // local state itself every outdatedTimeout/2 = 15s
              // (awareness.js _checkInterval), which the awareness update
              // handler broadcasts. Measured in
              // test/dummy/bench-idle-room.ts: the per-tick re-announce was
              // ~40% of an idle room's deliveries.
              this._sendSyncStep1()
            }
            if (!this._destroying) scheduleNextPeriodicSync()
          }, this._jitteredSyncInterval())
        }
        scheduleNextPeriodicSync()
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
      clearTimeout(this._syncIntervalId)
      this._syncIntervalId = undefined
    }

    // Reset resync escalation tracking
    this._resyncAttemptCount = 0
    this._lastResyncAttemptTime = 0

    // Cancel any pending unified resync - it would otherwise still fire
    // syncNow() after disconnect/reconnect against a transport that may be
    // in a completely different state by then.
    if (this._pendingResyncTimeoutId !== undefined) {
      clearTimeout(this._pendingResyncTimeoutId)
      this._pendingResyncTimeoutId = undefined
    }

    // Stop any pending gap-check timers and forget per-sender sequence
    // tracking. Without this, a gap-check timer armed before this
    // disconnect() keeps running in the background and can fire
    // _requestResync() after reconnect using sequence-number bookkeeping
    // from the PREVIOUS connection - a spurious resync race disconnected
    // from anything actually missing in the new session. Mirrors the
    // equivalent cleanup in destroy().
    for (const timer of this._gapCheckTimers.values()) {
      clearTimeout(timer)
    }
    this._gapCheckTimers.clear()
    this._remoteSeqInfo.clear()

    // Cancel any pending debounced onPeerConnect sync - a reconnect gets a
    // fresh burst of onPeerConnect events (if the transport supports it) and
    // shouldn't fire a stale one left over from before this disconnect.
    if (this._pendingPeerConnectSyncTimeoutId !== undefined) {
      clearTimeout(this._pendingPeerConnectSyncTimeoutId)
      this._pendingPeerConnectSyncTimeoutId = undefined
    }

    // Reset the sync rate-limit budget. Without this, a reconnect inherits
    // whatever budget was left over from before the disconnect - and since
    // syncNow()'s full-state push now shares this same limiter (see
    // _tryReserveSyncSlot()), a rate-limited reconnect could silently skip
    // the very push that delivers edits made while offline.
    this._syncRequestTimes = []
    this._syncReplyTimes = []
    this._knownPeers.clear()

    // A pending response-wait belongs to a request on the old connection.
    if (this._responseWaitTimer !== undefined) {
      clearTimeout(this._responseWaitTimer)
      this._responseWaitTimer = undefined
    }
    if (this._pendingCheckTimer !== undefined) {
      clearTimeout(this._pendingCheckTimer)
      this._pendingCheckTimer = undefined
    }
    if (this._presenceResponseTimer !== undefined) {
      clearTimeout(this._presenceResponseTimer)
      this._presenceResponseTimer = undefined
    }
    this._responseWaitAttempts = 0
    this._responseSeen = false
    this._rttSamples = []
    this._requestSentAt = 0

    // Drop any pending suppressed sync reply - safe to simply discard (not
    // flush/send like batched updates/awareness below), since a suppressed
    // reply is by design redundant with whatever the room already has.
    this._cancelPendingSyncReply()

    // Same reasoning for a pending suppressed awareness-removal broadcast -
    // every other surviving peer is independently running the same
    // suppression for the same departure, so dropping ours on disconnect
    // (rather than flushing it through a transport that's about to go
    // down) is safe.
    this._cancelPendingAwarenessRemoval()

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
      clearTimeout(this._syncIntervalId)
      this._syncIntervalId = undefined
    }

    // Stop any pending gap-check timers
    for (const timer of this._gapCheckTimers.values()) {
      clearTimeout(timer)
    }
    this._gapCheckTimers.clear()

    // Drop any pending suppressed sync reply (disconnect() will also do
    // this, but be explicit)
    this._cancelPendingSyncReply()

    // Same, for a pending suppressed awareness-removal broadcast
    // (disconnect() will also do this, but be explicit)
    this._cancelPendingAwarenessRemoval()

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
   * Push local state + request remote state, gated by the shared rate
   * limiter. Returns whether it actually reserved a slot and sent anything
   * - `false` means the caller was rate-limited right now. Extracted out of
   * `syncNow()` so `_requestResync()`'s scheduled retry (see below) can tell
   * the difference between "sent" and "silently skipped" and react to it,
   * instead of assuming a resync always succeeds once it fires.
   *
   * @param push - whether to also broadcast full local document state.
   * `_requestResync()`'s retry passes `false` (pull-only is enough for a
   * resync trigger - see its call site).
   * @param buildExtra - optional callback, invoked ONLY once a rate-limit
   * slot is actually reserved (so it never runs, and never mutates
   * whatever state it touches, on a call that ends up rate-limited),
   * returning additional already-encoded sub-messages to fold into the SAME
   * batched wire send as the push/pull messages below - e.g. an awareness
   * update that's ready to go out "now" anyway (see
   * `_tryImmediateAwarenessMessage()`). Pure wire-framing: whether a caller
   * passes this never changes whether/when the push+pull half itself sends,
   * only how many separate `transport.send()`/`bc.publish()` calls it costs.
   * @param flags - digest beacon flags: DIGEST_FLAG_JOIN from syncNow(), 0
   * from the peer-connect debounce and the resync retry (see _syncNow()).
   */
  private _trySyncPushPull(
    push: boolean = true,
    buildExtra?: () => Uint8Array[],
    flags: number = 0,
  ): boolean {
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
    if (!this._tryReserveSyncSlot()) return false

    const messages: Uint8Array[] = []

    // Send our current document state to all peers
    // This ensures any changes made while offline are transmitted
    if (push) {
      const update = Y.encodeStateAsUpdate(this.doc)
      if (update.length > 0) {
        messages.push(this._encodePush(update))
      }
    }

    // Send sync request to get updates from others
    messages.push(this._encodeSyncStep1(flags))

    if (buildExtra) {
      messages.push(...buildExtra())
    }

    // Batched into one wire message (MESSAGE_BATCH) instead of one
    // transport.send()/bc.publish() call per sub-message - see _sendBatch().
    this._sendBatch(messages)
    if (flags & DIGEST_FLAG_JOIN) this._armResponseWait(DIGEST_FLAG_CONFIRM)
    return true
  }

  /**
   * Force an immediate sync with remote peers.
   * Useful after network interruptions or to manually trigger re-sync.
   * Sends the beacon with DIGEST_FLAG_JOIN: peers answer with their
   * presence and, if our state already matches theirs, with an ack beacon
   * so `synced` flips without a data round trip.
   */
  syncNow(): void {
    this._syncNow(DIGEST_FLAG_JOIN)
  }

  /**
   * syncNow() body. `flags` = 0 for callers that must NOT request presence:
   * `_schedulePeerConnectSync()` (mesh transports already re-broadcast
   * presence to a newcomer via their own onPeerConnect -> syncNow()).
   */
  private _syncNow(flags: number): void {
    if (!this.transport.isConnected) {
      console.warn('Cannot sync: transport not connected')
      return
    }

    // Try to fold the awareness broadcast into the same wire send as the
    // sync push+pull below. _tryImmediateAwarenessMessage() only returns
    // non-null (and only mutates awareness-throttle state) when the
    // throttle would have let an immediate send through anyway - so this
    // never changes awareness throttle semantics, only whether it travels
    // as its own message or bundled with the sync message going out "now"
    // too. Built inside buildExtra so it's only even attempted once a sync
    // rate-limit slot is confirmed reserved (see _trySyncPushPull's doc).
    let awarenessBatched = false
    const sent = this._trySyncPushPull(
      true,
      () => {
        const msg = this._tryImmediateAwarenessMessage([this.doc.clientID])
        if (msg) {
          awarenessBatched = true
          return [msg]
        }
        return []
      },
      flags,
    )

    // Awareness broadcasting is independently throttled and explicitly NOT
    // gated by the sync rate limiter above - preserve that exactly: it
    // always ends up broadcast one way or another (batched above, or via
    // its own throttled path here), regardless of whether the sync half
    // above was rate-limited.
    if (!sent || !awarenessBatched) {
      this._broadcastAwareness([this.doc.clientID])
    }
  }

  /**
   * Compute the next periodic-sync delay, jittered by ~+/-20% around
   * `_currentSyncIntervalMs` (== `_syncInterval` unless `idleBackoffEnabled`
   * has backed it off - see that option's doc comment). Re-jittered fresh
   * each tick (not computed once per connect()) so a room's peers - which
   * commonly all connect() within a short window of each other - drift
   * apart over time instead of staying loosely synchronized. Extracted to
   * its own method purely so benchmarks can shadow it to compare against
   * the unjittered baseline.
   */
  private _jitteredSyncInterval(): number {
    const jitter = 1 + (Math.random() * 2 - 1) * 0.2 // +/-20%
    return this._currentSyncIntervalMs * jitter
  }

  /**
   * Record that "activity" happened right now, for `idleBackoffEnabled`'s
   * benefit. Cheap (one timestamp write) and called unconditionally
   * regardless of whether idle backoff is enabled, so there's no behavioral
   * branch to keep in sync - the backoff decision in connect()'s periodic
   * tick is the only place that actually reads this.
   *
   * Call sites are deliberately NOT "any inbound wire message" - an earlier
   * version of this hooked `_handleIncomingMessage()` unconditionally, which
   * made the periodic tick's OWN SyncStep1 request and the SyncStep2 reply
   * answering it (empty payload - nothing to sync) each count as "activity",
   * permanently resetting the backoff on every single tick and making the
   * whole feature a no-op (caught by this bench script's own first run: ON
   * and OFF produced statistically indistinguishable message counts). Both
   * Yjs's `doc.emit('update', ...)` and y-protocols' `awareness.emit('update', ...)`
   * already only fire when something with actual content changed
   * (`hasContent`/non-empty added+updated+removed - confirmed by reading
   * yjs's `Transaction.js` and y-protocols' `awareness.js` directly), so
   * hooking THOSE instead is exactly "local or remote document/awareness
   * change" with no extra filtering needed - a no-op SyncStep2 reply, a
   * digest beacon, or a duplicate/no-change awareness re-announce (e.g. a
   * JOIN-triggered presence response that changed nothing) never reaches
   * these handlers. A corrupted (CRC32
   * mismatch) message is real evidence of wire activity that neither
   * handler would ever see (it's rejected before decoding) - see the
   * explicit call in `_processWrappedMessage()`'s corruption branch.
   *
   * Call sites: `_setupDocumentSync()`'s update handler (local or remote
   * document content change), `_setupAwarenessSync()`'s update handler
   * (local or remote awareness content change), and
   * `_processWrappedMessage()`'s corrupted-message branch (wire noise, not
   * silence).
   */
  private _markActivity(): void {
    this._lastActivityTime = Date.now()
  }

  /** Cached delete-set hash - see computeDeleteSetHash(). */
  private _deleteSetHash(): number {
    if (this._dsHashCache === null) {
      this._dsHashCache = computeDeleteSetHash(this.doc)
    }
    return this._dsHashCache
  }

  /**
   * Debounce onPeerConnect-triggered syncNow() calls. A burst of connect
   * events within `_peerConnectDebounceMs` collapses into one call instead
   * of one per event - without this, N peers joining a mesh in a short
   * window each independently broadcast full state to everyone already
   * connected (O(N^2) traffic), since onPeerConnect fires once per
   * newly-opened peer connection with no coalescing of its own.
   */
  private _schedulePeerConnectSync(): void {
    if (this._pendingPeerConnectSyncTimeoutId !== undefined) return
    this._pendingPeerConnectSyncTimeoutId = setTimeout(() => {
      this._pendingPeerConnectSyncTimeoutId = undefined
      if (!this.transport.isConnected || this._destroying) return
      this._syncNow(0)
    }, this._peerConnectDebounceMs)
  }

  /**
   * Setup automatic document synchronization.
   * Listens to document updates and sends them to the transport.
   * If batchUpdates is enabled, updates are debounced/batched.
   */
  private _setupDocumentSync(): void {
    this._updateHandler = (update: Uint8Array, origin: any) => {
      this._dsHashCache = null
      // Fires for BOTH local edits and remotely-applied updates (the latter
      // go through doc.transact with origin=this) - see _markActivity()'s
      // doc comment for why this single hook covers "local or remote
      // document change" for idleBackoffEnabled.
      this._markActivity()

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
      // Fires for both local and remote-applied awareness changes - see
      // _markActivity()'s doc comment.
      this._markActivity()

      // Broadcast awareness changes, UNLESS they came from remote (this
      // comment described the intent since the very first commit, but the
      // actual origin check was never implemented until now - confirmed by
      // `git log -p` on this handler). `origin === this` is exactly the
      // signature the MESSAGE_AWARENESS handler stamps on an update applied
      // from an incoming wire message (`applyAwarenessUpdate(this.awareness,
      // ..., this)`, below). Every transport this project targets is a
      // full-room relay (websocket/pubnub/gun/matrix/ably/supabase) or a
      // full mesh (peerjs/simple-peer/trystero - see CLAUDE.md), so the
      // sender's own broadcast already reached every other peer directly;
      // re-broadcasting it here on receipt is pure redundant traffic that
      // compounds across every OTHER receiver doing the same thing.
      // Verified with a throwaway probe: a single awareness field change in
      // an N-peer room cost N*(N-1) wire deliveries before this check (one
      // echo per receiver, each reaching N-1 peers) vs. N-1 after - e.g.
      // N=20: 380 -> 19.
      //
      // Carve-out: `applyAwarenessUpdate` has its own defense against a
      // remote peer incorrectly removing OUR OWN state (a stale/racy
      // timeout-removal from someone else's clock) - it bumps our clock
      // instead of deleting our state, but (a quirk of that function) still
      // reports it via `removed` including our own clientID. That specific
      // case must still be broadcast so the room's stale belief that we're
      // gone gets corrected promptly, instead of only self-healing on our
      // next unrelated state change/renewal (up to ~15s later).
      if (origin === this) {
        // An incoming removal might be the SAME departure we have a
        // suppressed broadcast queued for (see _scheduleAwarenessRemoval())
        // - someone else already told the room, drop ours.
        if (removed.length > 0) {
          this._cancelPendingAwarenessRemovalIfOverlaps(removed)
        }
        if (!removed.includes(this.awareness.clientID)) {
          return
        }
      }

      const changedClients = added.concat(updated).concat(removed)

      // A pure timeout-triggered removal ('timeout' is the exact origin
      // string y-protocols/awareness.js's own _checkInterval passes to
      // removeAwarenessStates()) is redundant across the whole room: every
      // OTHER connected peer runs the identical 30s-timeout sweep
      // independently, so all of them detect and would broadcast the SAME
      // departure within the same ~3s tick - measured as O(N-1) broadcasts
      // / O((N-1)(N-2)) deliveries for ONE departure in
      // test/dummy/bench-awareness-removal-burst.ts (e.g. N=50: 2352
      // deliveries). Delay + drop-if-overheard, exactly mirroring
      // _scheduleSyncReply()/_cancelPendingSyncReply()'s suppression of
      // redundant SyncStep2 replies. Deliberately NOT applied to
      // 'disconnect'/'window unload' removals (a single broadcaster, not
      // redundant) or to added/updated clients (every sender's
      // cursor/presence data is meaningfully different and must never be
      // suppressed).
      if (origin === 'timeout') {
        this._scheduleAwarenessRemoval(changedClients)
        return
      }

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
   * Handle incoming messages from the transport (or BroadcastChannel).
   *
   * When compressionThresholdBytes is disabled (the default), this is a
   * fully synchronous fast path, byte-for-byte the same behavior as before
   * that option existed: straight into _processWrappedMessage().
   *
   * When enabled, every message - from the network transport AND from
   * BroadcastChannel (see _send()) - carries a leading compressed(1)/
   * uncompressed(0) flag byte ahead of the usual CRC32 wrapper. Reading
   * that flag and, if set, decompressing is inherently async (the
   * Compression Streams API has no synchronous form), so this method
   * dispatches to a promise chain instead of processing inline in that
   * case. This means a large (compressed) message and a small (uncompressed
   * or below-threshold) message that arrive back-to-back can finish
   * processing out of arrival order - acceptable here because Yjs updates
   * are idempotent/commutative (see MESSAGE_SYNC_VERIFIED's handling below)
   * and because the compression threshold keeps this path almost entirely
   * to large, full-state syncs, not the per-keystroke incremental updates
   * that per-sender gap detection actually relies on ordering-sensitive
   * heuristics for.
   */
  private _handleIncomingMessage(data: Uint8Array): void {
    if (!this._compressionThresholdBytes) {
      this._processWrappedMessage(data)
      return
    }

    if (data.length < 1) {
      console.warn(
        '[GenericProvider] Dropping empty message (missing compression flag byte)',
      )
      return
    }

    const flag = data[0]
    const rest = data.subarray(1)

    if (flag === 0) {
      this._processWrappedMessage(rest)
      return
    }

    if (!COMPRESSION_AVAILABLE) {
      console.warn(
        '[GenericProvider] Received a compressed message but this runtime has no DecompressionStream - dropping it.',
      )
      return
    }

    decompressDeflateRaw(rest)
      .then((wrapped) => this._processWrappedMessage(wrapped))
      .catch((error) => {
        // Treat decompression failure the same as a CRC32 mismatch on the
        // uncompressed path: request a resync rather than silently dropping.
        console.warn(
          '[GenericProvider] Failed to decompress incoming message, treating as corrupted:',
          error,
        )
        this._requestResync()
      })
  }

  /**
   * Verify message integrity with CRC32 and decode. Corrupt messages are
   * rejected immediately without attempting to decode. Operates on bytes
   * that have already had any compression flag/decompression handled by
   * _handleIncomingMessage() - this is the pre-compression-feature
   * implementation, unchanged.
   */
  private _processWrappedMessage(data: Uint8Array): void {
    // Verify message integrity with CRC32 checksum
    const message = unwrapAndVerifyMessage(data)

    if (message === null) {
      // Message is corrupted - reject it immediately. Note: if this was a
      // MESSAGE_BATCH envelope, the CRC32 wrap covers the WHOLE batch, so a
      // single corrupted bit here loses every sub-message it contained, not
      // just one - a deliberate tradeoff of batching multiple logical
      // messages behind one wire message/one checksum. See _sendBatch()'s
      // doc comment for why this was chosen over per-sub-message checksums,
      // and this project's benchmark suite (bench-corruption-storm.ts,
      // bench-packet-loss.ts) for how that tradeoff was measured.
      console.warn(
        `[GenericProvider] 💥 Corrupted message rejected: CRC32 checksum mismatch. ` +
          `This is expected if data corruption simulation is enabled.`,
      )

      // Wire noise, not silence - counts as activity for idleBackoffEnabled
      // even though nothing here reaches the doc/awareness update handlers
      // (the message is rejected before decoding). See _markActivity()'s
      // doc comment.
      this._markActivity()

      // Request re-sync to recover any lost data - routed through the
      // shared coordinator so this doesn't stack an independent timer on
      // top of any hash-mismatch/gap-confirmed resync already pending.
      this._requestResync()

      return // Don't process corrupted message
    }

    // Message integrity verified - safe to decode
    try {
      this._dispatchMessage(message)
    } catch (error) {
      // This should only happen for logic errors, not corruption
      // (corruption is caught by CRC32 check above)
      console.error('[GenericProvider] Error handling message:', error)
    }
  }

  /**
   * Decode and act on one already-integrity-verified, already-decompressed
   * message. Split out of `_processWrappedMessage()` so `MESSAGE_BATCH`
   * (see `_sendBatch()`) can recurse into this for each sub-message it
   * unwraps, running the EXACT SAME per-message-type logic used for a
   * top-level message rather than a parallel reimplementation. A thrown
   * error partway through a batch's sub-messages aborts the REST of that
   * batch (propagates up to `_processWrappedMessage()`'s catch) - same as
   * a logic error aborting a single top-level message today, just now
   * scoped to "the rest of this batch" instead of "this one message".
   */
  private _dispatchMessage(message: Uint8Array): void {
    const decoder = decoding.createDecoder(message)
    const messageType = decoding.readVarUint(decoder)

    switch (messageType) {
      case MESSAGE_BATCH: {
        // Payload is N length-prefixed sub-messages (writeVarUint8Array
        // per sub-message, mirroring MESSAGE_AWARENESS's own framing).
        // Each was NOT individually CRC32-wrapped - see _sendBatch()'s doc
        // comment - so just decode and dispatch each one directly.
        while (decoding.hasContent(decoder)) {
          const subMessage = decoding.readVarUint8Array(decoder)
          this._dispatchMessage(subMessage)
        }
        break
      }

      case MESSAGE_SYNC_DIGEST: {
        this._handleDigest(decoder)
        break
      }

      case MESSAGE_SYNC_PUSH: {
        // Somebody's whole document: apply it, nothing else (see the
        // constant's comment for why no hash check and no synced flip).
        Y.applyUpdate(this.doc, decoding.readVarUint8Array(decoder), this)
        break
      }

      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)

        const syncMessageType = syncProtocol.readSyncMessage(
          decoder,
          encoder,
          this.doc,
          this, // transaction origin
        )

        if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
          // If we received SyncStep2, we're synced
          this._noteResponse(true)
          this._markSynced()

          // Someone else's SyncStep2 reply just arrived - our own pending
          // reply (if any) is now most likely redundant.
          this._cancelPendingSyncReply()
        }

        // Send reply if needed. Suppression only engages with genuine
        // redundancy (>=2 other known peers via awareness) - below that,
        // there's no "someone else" to rely on, so reply immediately
        // (still rate-limited via _sendSyncReply() as a hard backstop).
        if (encoding.length(encoder) > 1) {
          this._replyToSyncRequest(encoding.toUint8Array(encoder))
        }
        break
      }

      case MESSAGE_AWARENESS: {
        const payload = decoding.readVarUint8Array(decoder)

        // Someone else's removal broadcast just arrived - cancel our own
        // suppressed removal for the same clientID(s), if pending (see
        // _scheduleAwarenessRemoval()). This MUST be checked here, at the
        // wire-message level, before calling applyAwarenessUpdate() below -
        // by the time this arrives we've very likely already independently
        // detected and applied the SAME removal ourselves (every peer's
        // 30s outdatedTimeout sweep fires near-simultaneously, well before
        // this message's network delay elapses - see
        // test/dummy/bench-awareness-removal-burst.ts), so
        // applyAwarenessUpdate() below will see a clock it already knows
        // and emit no 'update' event at all - mirrors exactly how the
        // MESSAGE_SYNC/MESSAGE_SYNC_VERIFIED case above cancels
        // _pendingSyncReply on seeing a SyncStep2 message TYPE arrive, not
        // on whether it changed anything locally.
        const removedIds = this._extractRemovedClientIds(payload)
        if (removedIds.length > 0) {
          this._cancelPendingAwarenessRemovalIfOverlaps(removedIds)
        }

        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          payload,
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
        this._knownPeers.add(senderClientID)

        // Always apply the update. Yjs updates are idempotent/commutative,
        // so re-applying an already-seen update is a harmless no-op.
        // Under reordering, a merely-late (not actually duplicate) update
        // must still be applied here — the old "skip if seqNum <= last
        // seen" logic silently dropped such updates forever whenever a
        // later-numbered message happened to arrive first.
        // Peek at the sync sub-message's payload (SyncStep2/Update carry
        // an update as a varUint8Array right after the sub-type) without
        // consuming the decoder - _isLateUpdate() needs the bytes after
        // readSyncMessage() has applied them.
        const updateBytes = this._peekSyncUpdate(decoder)

        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)

        const syncMessageType = syncProtocol.readSyncMessage(
          decoder,
          encoder,
          this.doc,
          this, // transaction origin
        )

        // Someone else's SyncStep2 reply just arrived - our own pending
        // reply (if any) is now most likely redundant. Mirrors the
        // MESSAGE_SYNC case: the reply encoded above is always a plain
        // MESSAGE_SYNC-typed message regardless of which message type
        // triggered it, so the same suppression scheme applies here too.
        if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
          this._cancelPendingSyncReply()
          this._noteResponse(true)
        }

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

          // A late update - one whose content we had already been past
          // when it arrived (its sender's clock in the update is below
          // ours, because a SyncStep2 or a reordered later update got here
          // first) - carries a hash of a state we have legitimately moved
          // beyond. Its mismatch says nothing about anything we lack; it
          // was the other half of the item-13 cascade (a resync's reply
          // fast-forwards a peer, then every in-flight keystroke behind it
          // mismatches). Cheap to detect from the update's own metadata.
          const lateUpdate = this._isLateUpdate(updateBytes)

          // Yjs's own verdict: if the update could not be fully integrated
          // because a causal dependency is missing, the struct store holds
          // it as pending. That is the ONE mismatch that is evidence of a
          // gap - and under jitter it is usually a reordering that the
          // next few ms resolve, so it gets the same grace a sequence gap
          // gets before a beacon goes out (_schedulePendingCheck). It also
          // covers the case the sequence anchor no longer does: since the
          // connect push carries no sequence number (MESSAGE_SYNC_PUSH), a
          // peer's first keystroke can be the first numbered message we see
          // from it, and a reordered first burst has no earlier number to
          // open a gap against.
          const pending =
            this.doc.store.pendingStructs !== null ||
            this.doc.store.pendingDs !== null

          if (pending) {
            this._schedulePendingCheck()
          } else if (!reorderingSuspected && !lateUpdate) {
            // Push our full state AND request theirs (syncNow() does
            // both). A hash mismatch means the two peers have diverged -
            // one side may have edits the other lacks. Routed through the
            // shared coordinator so this doesn't stack an independent
            // timer on top of any corrupted-message/gap-confirmed resync
            // already pending.
            this._requestResync()

            // Logged with the shared attempt counter (kept as "#N" for
            // compatibility with existing tooling/benchmarks that grep
            // for this exact "Hash mismatch #" pattern) - it now reflects
            // the unified resync-attempt count rather than a
            // hash-mismatch-specific one, since the two escalation
            // counters were merged.
            console.warn(
              `[GenericProvider] Hash mismatch #${this._resyncAttemptCount} detected! Local: ${localHash}, Expected: ${expectedHash}`,
            )
          }
        }

        // If we received SyncStep2, we're synced (unless hash mismatched)
        if (
          syncMessageType === syncProtocol.messageYjsSyncStep2 &&
          localHash === expectedHash
        ) {
          this._markSynced()
        }

        // Send reply if needed (as standard MESSAGE_SYNC). Suppression
        // only engages with genuine redundancy (>=2 other known peers via
        // awareness) - below that, reply immediately (still rate-limited
        // via _sendSyncReply() as a hard backstop). Matches the
        // MESSAGE_SYNC case's gate exactly; without this, a hash-mismatch
        // resync burst under packet loss bypassed suppression entirely,
        // since every peer answering a post-mismatch SyncStep1 replied
        // immediately via this path.
        if (encoding.length(encoder) > 1) {
          this._replyToSyncRequest(encoding.toUint8Array(encoder))
        }
        break
      }

      default:
        console.warn('Unknown message type:', messageType)
    }
  }

  /**
   * Handle a digest beacon (MESSAGE_SYNC_DIGEST). Reply rule (design doc
   * §3): SyncStep2 if the sender is behind us or its delete-set hash
   * differs from ours (the SyncStep2 always carries our full delete set, so
   * it also heals a lost delete on their side - and their beacon does the
   * same for us, symmetrically, within one interval); our own beacon as an
   * ack if the beacon is JOIN-flagged and states are equal; nothing
   * otherwise - which is what removes the ~5-12 empty replies per heartbeat
   * measured at N=50 in test/dummy/bench-idle-room.ts. "Sender is ahead of
   * us" triggers no reply: our own next beacon fetches it. Nothing here
   * removes a recovery path (the round-2 lesson in
   * 2026-09-04-resync-message-reduction-design.md's addendum), only
   * replies that carry no information.
   *
   * `synced`: a beacon we are not behind, with equal delete-set hash, is a
   * stronger statement than the empty SyncStep2 it replaces ("you lack
   * nothing I have"), so it marks us synced too - this is what keeps two
   * fresh peers, or a whole concurrent join burst, converging to `synced`
   * with no acks needing to survive the rate limiter.
   */
  private _handleDigest(decoder: decoding.Decoder): void {
    decoding.readVarUint(decoder) // DIGEST_VERSION - append-only, nothing to branch on yet
    const flags = decoding.readVarUint(decoder)
    this._knownPeers.add(decoding.readVarUint(decoder)) // sender clientID
    const remoteSv = decoding.readVarUint8Array(decoder)
    const remoteDsHash = decoding.readVarUint(decoder)
    // Any trailing bytes belong to a newer version; ignored by design.

    const remote = Y.decodeStateVector(remoteSv)
    const local = Y.decodeStateVector(Y.encodeStateVector(this.doc))
    let senderBehind = false
    for (const [client, clock] of local) {
      if ((remote.get(client) ?? 0) < clock) {
        senderBehind = true
        break
      }
    }
    let weBehind = false
    for (const [client, clock] of remote) {
      if ((local.get(client) ?? 0) < clock) {
        weBehind = true
        break
      }
    }
    const dsEqual = remoteDsHash === this._deleteSetHash()
    const equal = !senderBehind && !weBehind && dsEqual

    if (flags & DIGEST_FLAG_ACK) {
      // Somebody confirmed the echoed state (see DIGEST_FLAG_ACK). If it is
      // ours, we're synced; if we were about to confirm the same state, we
      // no longer need to. Never a request: no reply, no presence.
      if (equal) {
        this._noteResponse(true)
        this._markSynced()
        this._cancelPendingAck()
      }
      return
    }

    // An equal-digest beacon from a settled peer's periodic tick has just
    // told the room (including whoever our pending ack was for) that this
    // state is confirmed. Our ack would say the same thing again. Task 3b
    // in the design doc: without this, acks were ~94% of a 50-peer join
    // burst's messages, throttled only by the rate limiter. An equal JOIN
    // beacon (another joiner in the same burst) asks for an ack too; our
    // pending ack - identical bytes, since it echoes that same state -
    // answers it as well, and _scheduleSyncReply() dedupes it below.
    if (equal && !(flags & (DIGEST_FLAG_JOIN | DIGEST_FLAG_CONFIRM))) {
      // A settled peer's periodic beacon in our state: it confirms us (and
      // whoever we were about to ack) as well as any ack would.
      this._noteResponse(false)
      this._cancelPendingAck()
    }

    if (senderBehind || !dsEqual) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeSyncStep2(encoder, this.doc, remoteSv)
      this._replyToSyncRequest(encoding.toUint8Array(encoder), false, remoteSv)
    } else if (flags & (DIGEST_FLAG_JOIN | DIGEST_FLAG_CONFIRM)) {
      this._replyToSyncRequest(this._encodeAck(remoteSv, remoteDsHash), true)
    }

    if (!weBehind && dsEqual) {
      this._markSynced()
    }

    if (flags & DIGEST_FLAG_JOIN && this.awareness.getLocalState() !== null) {
      // Presence on demand: the joiner asked. One broadcast per burst of
      // joiners (see _schedulePresenceResponse), never suppressed (each
      // responder's state is distinct). Skipped when we have no state to
      // announce.
      this._schedulePresenceResponse()
    }
  }

  /**
   * Answer a JOIN beacon's presence request once for all JOIN beacons that
   * arrive within `clamp(2 * minRTT, 100, 500)` ms of the first - long
   * enough to cover a join burst spread by latency, short enough that a
   * lone joiner sees the room's presence within a few round trips.
   */
  private _schedulePresenceResponse(): void {
    if (this._presenceResponseTimer !== undefined) return
    const rtt = this._rttMinMs()
    const delay = Math.min(500, Math.max(100, rtt === null ? 0 : 2 * rtt))
    this._presenceResponseTimer = setTimeout(() => {
      this._presenceResponseTimer = undefined
      if (this._destroying || !this.transport.isConnected) return
      if (this.awareness.getLocalState() !== null) {
        this._broadcastAwareness([this.doc.clientID])
      }
    }, delay)
  }

  /**
   * Max random delay (ms) before replying to a SyncStep1 request, scaled by
   * a room-size signal already available (`this.awareness.getStates().size`
   * - the same signal read at the `>= 3` suppression gate). A fixed window
   * (the pre-fix behavior: always `_syncReplySuppressionMs`) doesn't scale
   * with room size, so a larger room has more independent repliers racing
   * to answer the same request within the same window - more of them lose
   * the race and get silently dropped by the `_sendSyncReply()` rate-limit
   * backstop instead of never sending in the first place. Measured in
   * test/dummy/bench-corruption-storm.ts: the SyncStep2/SyncStep1 ratio (
   * ideally ~1 if suppression alone were sufficient) grew from ~1.1-1.3 at
   * N=2 to ~4.5-5.9 at N=10 with the fixed 30ms window.
   *
   * `min(cap, base * log2(peerCount))` - log2 growth spreads replies over a
   * wider window as the room grows without the delay exploding at very high
   * N. Capped at 200ms: the slowest-profile round trip this project
   * benchmarks against (Matrix, ~350ms one-way) already tolerates hundreds
   * of ms of latency, so 200ms of extra requester-perceived delay stays
   * well inside that budget while still giving a 100-peer room roughly
   * 6-7x the base window instead of an unbounded one.
   */
  /**
   * How many peers we believe are in the room: awareness states (includes
   * ourselves) or, if larger, the distinct beacon/update senders we have
   * heard plus ourselves. See `_knownPeers`.
   */
  private _peerCount(): number {
    return Math.max(this.awareness.getStates().size, this._knownPeers.size + 1)
  }

  private _replySuppressionMaxDelay(): number {
    const peerCount = this._peerCount()
    const byRoomSize = Math.min(
      200,
      this._syncReplySuppressionMs * Math.log2(Math.max(2, peerCount)),
    )
    // Phase 1b: the window must exceed the one-way latency or nobody
    // overhears anybody in time (see _rttSamples). 1.5x the smallest
    // observed round trip, capped at 2 s - on a 350 ms profile that is
    // ~1 s of extra requester-perceived delay in exchange for ~1 reply
    // instead of ~20.
    const rtt = this._rttMinMs()
    return rtt === null ? byRoomSize : Math.min(2000, Math.max(byRoomSize, 1.5 * rtt))
  }

  /**
   * Schedule a SyncStep2 reply after a short random delay instead of
   * sending immediately. If another peer's reply is overheard in the
   * meantime (`_cancelPendingSyncReply`), this reply is dropped as
   * redundant - the requester likely already got what it needed.
   *
   * A reply that is already pending when this is called answers a
   * *different* request (e.g. peer A's request, followed 5ms later by
   * peer B's) - it must not be silently overwritten by the new one. Flush
   * it immediately, then schedule the new reply fresh. The only sanctioned
   * ways a reply gets dropped are `_cancelPendingSyncReply()` (we overheard
   * someone else's SyncStep2 for the SAME request), `_cancelPendingAck()`,
   * and the identical-bytes case below.
   *
   * Identical-bytes case (Task 3c in the design doc): K peers with the same
   * state asking at once (K empty joiners in a burst) get K byte-identical
   * SyncStep2s from us - the same full document K times, one flushed
   * immediately per arriving request, each burning a rate-limit slot. If
   * the new reply's bytes equal the pending reply's bytes, the pending one
   * already answers this request too: keep it (same delay, same
   * suppression) and drop the new one. Measured in
   * test/dummy/bench-join-after-burst.ts.
   */
  private _scheduleSyncReply(
    reply: Uint8Array,
    isAck: boolean = false,
    targetSv: Uint8Array | null = null,
  ): void {
    if (this._pendingSyncReplyTimeoutId !== undefined && this._pendingSyncReply !== null) {
      if (bytesEqual(this._pendingSyncReply, reply)) {
        return // identical answer already scheduled
      }
      if (
        targetSv !== null &&
        this._pendingSyncReplyTargetSv !== null &&
        bytesEqual(this._pendingSyncReplyTargetSv, targetSv)
      ) {
        // Same question (same requester state), newer document: refresh
        // the answer, keep the timer. See _pendingSyncReplyTargetSv.
        this._pendingSyncReply = reply
        return
      }
    }

    if (this._pendingSyncReplyTimeoutId !== undefined) {
      if (this._pendingSyncReply) {
        this._sendSyncReply(this._pendingSyncReply)
      }
      clearTimeout(this._pendingSyncReplyTimeoutId)
      this._pendingSyncReplyTimeoutId = undefined
    }

    this._pendingSyncReply = reply
    this._pendingSyncReplyIsAck = isAck
    this._pendingSyncReplyTargetSv = targetSv
    const delay = Math.random() * this._replySuppressionMaxDelay()
    this._pendingSyncReplyTimeoutId = setTimeout(() => {
      this._pendingSyncReplyTimeoutId = undefined
      if (this._pendingSyncReply) {
        this._sendSyncReply(this._pendingSyncReply)
        this._pendingSyncReply = null
        this._pendingSyncReplyTargetSv = null
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
    this._pendingSyncReplyIsAck = false
    this._pendingSyncReplyTargetSv = null
  }

  /**
   * Cancel a pending reply only if it is a digest ack - see
   * `_pendingSyncReplyIsAck`. Called from `_handleDigest()` on every
   * overheard beacon whose digest equals ours.
   */
  private _cancelPendingAck(): void {
    if (this._pendingSyncReplyIsAck) {
      this._cancelPendingSyncReply()
    }
  }

  /**
   * Route a SyncStep2 (or digest-ack) reply through the redundancy
   * suppression when there's genuine redundancy (>= 2 other known peers via
   * awareness - below that there's no "someone else" to rely on), else send
   * immediately. Both paths are rate-limited by `_sendSyncReply()`. Shared
   * by the MESSAGE_SYNC, MESSAGE_SYNC_VERIFIED and MESSAGE_SYNC_DIGEST cases.
   */
  private _replyToSyncRequest(
    reply: Uint8Array,
    isAck: boolean = false,
    targetSv: Uint8Array | null = null,
  ): void {
    // Acks ALWAYS take the delayed/suppressible path: they carry no data,
    // so the only cost of delaying one is a few ms on the joiner's `synced`
    // flip (measured before this rule: 37,240 of a 50-peer join burst's
    // 40,915 deliveries were immediate acks). Everything else goes through
    // suppression once there is someone else who could answer - counted
    // from beacon/update senders as well as awareness, see _peerCount().
    if (isAck || this._peerCount() >= 3) {
      this._scheduleSyncReply(reply, isAck, targetSv)
    } else {
      this._sendSyncReply(reply)
    }
  }

  /**
   * Re-check Yjs's pending-struct store after the gap grace period and
   * request a resync (a beacon, see _requestResync) only if something is
   * still missing. One timer; a check scheduled while one is pending is
   * absorbed. Cleared on disconnect/destroy.
   */
  private _schedulePendingCheck(): void {
    if (this._pendingCheckTimer !== undefined) return
    this._pendingCheckTimer = setTimeout(() => {
      this._pendingCheckTimer = undefined
      if (this._destroying || !this.transport.isConnected) return
      // A request of ours is already outstanding (JOIN or resync beacon
      // with its response wait running): whatever is pending is what that
      // request is fetching, and the response wait retries if it is lost.
      // Asking again here just raced the responders' suppression window
      // (measured: a joiner's keystrokes-before-content check fired at
      // 300 ms while the settled peers' replies were still delayed by a
      // window of up to ~300 ms, and every such re-beacon collected
      // another round of replies).
      if (this._responseWaitTimer !== undefined) return
      if (
        this.doc.store.pendingStructs !== null ||
        this.doc.store.pendingDs !== null
      ) {
        this._requestResync()
      }
    }, this._gapGraceMs)
  }

  /**
   * Return the update payload of a SyncStep2/Update sync sub-message
   * without advancing `decoder` (null for SyncStep1 or malformed input).
   * y-protocols frames both as [subType varUint][update varUint8Array].
   */
  private _peekSyncUpdate(decoder: decoding.Decoder): Uint8Array | null {
    const peek = decoding.clone(decoder)
    try {
      const subType = decoding.readVarUint(peek)
      if (subType === syncProtocol.messageYjsSyncStep1) return null
      return decoding.readVarUint8Array(peek)
    } catch {
      return null
    }
  }

  /**
   * Whether an update we just applied was already superseded here: every
   * client it touches ends at a clock we were at or beyond BEFORE this
   * update (i.e. it added nothing). Uses the update's own metadata
   * (`Y.parseUpdateMeta`), O(clients in the update).
   */
  private _isLateUpdate(updateBytes: Uint8Array | null): boolean {
    if (!updateBytes) return false
    try {
      const { to } = Y.parseUpdateMeta(updateBytes)
      if (to.size === 0) return false
      const local = Y.decodeStateVector(Y.encodeStateVector(this.doc))
      for (const [client, clock] of to) {
        // `to` is the exclusive end clock of the update's range for that
        // client; our state vector is exclusive too. Equal means the update
        // brought us exactly here (not late); greater means we were past it.
        if ((local.get(client) ?? 0) <= clock) return false
      }
      return true
    } catch {
      return false
    }
  }

  /** Flip `synced` once and emit; idempotent. */
  private _markSynced(): void {
    if (!this._synced) {
      this._synced = true
      this.emit('synced', [true])
    }
  }

  /**
   * Wait for a response to the JOIN or resync beacon we just sent. If
   * neither a SyncStep2 nor an equal ack/beacon arrives within 1s (then
   * 2s, 4s), ask again - with a CONFIRM beacon after a JOIN (so an equal
   * room acks), with a plain beacon after a resync (only peers ahead of us
   * need to answer; an equal room's silence is the correct answer and its
   * periodic beacons end the wait) - three times at most; after that the
   * periodic beacon is the fallback, as before. Requester-side retry is how the protocol
   * stays loss-tolerant now that reply suppression leaves ~1 reply per
   * request; N-fold redundant replies were the old (accidental) way.
   */
  private _armResponseWait(retryFlags: number): void {
    if (this._responseWaitTimer !== undefined) return
    this._responseSeen = false
    this._responseWaitFlags = retryFlags
    this._requestSentAt = Date.now()
    const rtt = this._rttMinMs()
    const delay =
      Math.max(1000, rtt === null ? 0 : 4 * rtt) *
      Math.pow(2, this._responseWaitAttempts)
    this._responseWaitTimer = setTimeout(() => {
      this._responseWaitTimer = undefined
      if (
        this._responseSeen ||
        this._responseWaitAttempts >= 3 ||
        !this.transport.isConnected ||
        this._destroying
      ) {
        this._responseWaitAttempts = 0
        return
      }
      this._responseWaitAttempts++
      this._sendSyncStep1(this._responseWaitFlags) // rate-limited; a dropped attempt is simply retried next round
      this._armResponseWait(this._responseWaitFlags)
    }, delay)
  }

  /**
   * A SyncStep2 or an equal ack/beacon arrived - whatever we asked for is
   * answered. `sample` = it was a direct reply (SyncStep2/ack), so its
   * timing is a round-trip sample; an equal periodic beacon from a settled
   * peer also ends the wait but says nothing about latency.
   */
  private _noteResponse(sample: boolean): void {
    if (sample && this._requestSentAt > 0) {
      this._rttSamples.push(Date.now() - this._requestSentAt)
      if (this._rttSamples.length > 8) this._rttSamples.shift()
    }
    this._requestSentAt = 0
    this._responseSeen = true
    this._responseWaitAttempts = 0
    if (this._responseWaitTimer !== undefined) {
      clearTimeout(this._responseWaitTimer)
      this._responseWaitTimer = undefined
    }
  }

  /** Minimum of the recent round-trip samples, or null before the first reply. */
  private _rttMinMs(): number | null {
    return this._rttSamples.length === 0 ? null : Math.min(...this._rttSamples)
  }

  /**
   * Delay a pure timeout-removal awareness broadcast and drop it if
   * another peer's broadcast of the SAME removal is overheard first (see
   * the `origin === this` branch in `_setupAwarenessSync()`'s handler,
   * which calls `_cancelPendingAwarenessRemovalIfOverlaps()`) - the exact
   * same NACK-style suppression `_scheduleSyncReply()` already applies to
   * SyncStep2 replies, reusing the same room-size-scaled delay
   * (`_replySuppressionMaxDelay()`).
   *
   * A pending removal already queued when this is called is for a
   * DIFFERENT departure (two peers timing out within the same suppression
   * window) - flush it immediately rather than silently overwrite it, then
   * queue the new one fresh. If it turns out to cover more than one
   * clientID and only some overlap with a later-overheard broadcast,
   * `_cancelPendingAwarenessRemovalIfOverlaps()` drops the whole pending
   * set on ANY overlap rather than partially trimming it - simpler, and
   * the dropped-but-not-actually-covered client(s) are still safe: every
   * OTHER surviving peer is independently running this same suppression
   * for them too.
   */
  private _scheduleAwarenessRemoval(clients: number[]): void {
    if (this._pendingAwarenessRemovalTimeoutId !== undefined) {
      if (this._pendingAwarenessRemoval) {
        this._broadcastAwareness(this._pendingAwarenessRemoval)
      }
      clearTimeout(this._pendingAwarenessRemovalTimeoutId)
      this._pendingAwarenessRemovalTimeoutId = undefined
    }

    this._pendingAwarenessRemoval = clients
    const delay = Math.random() * this._replySuppressionMaxDelay()
    this._pendingAwarenessRemovalTimeoutId = setTimeout(() => {
      this._pendingAwarenessRemovalTimeoutId = undefined
      if (this._pendingAwarenessRemoval) {
        this._broadcastAwareness(this._pendingAwarenessRemoval)
        this._pendingAwarenessRemoval = null
      }
    }, delay)
  }

  /**
   * Peek at an awareness-update payload (still in
   * `awarenessProtocol.encodeAwarenessUpdate()`'s wire encoding) for
   * clientIDs whose state is `null` (a removal), without applying it.
   * y-protocols/awareness.js doesn't export a standalone decoder for this,
   * only `applyAwarenessUpdate()` (which also mutates state) and
   * `modifyAwarenessUpdate()` (which re-encodes) - so this mirrors the
   * format by hand: varUint length, then per entry
   * [varUint clientID][varUint clock][varString JSON state]. Used to cancel
   * a pending suppressed removal (see `_scheduleAwarenessRemoval()`) at the
   * wire-message level, before `applyAwarenessUpdate()` runs - see the
   * `MESSAGE_AWARENESS` case's comment for why timing matters here.
   */
  private _extractRemovedClientIds(payload: Uint8Array): number[] {
    try {
      const d = decoding.createDecoder(payload)
      const len = decoding.readVarUint(d)
      const removed: number[] = []
      for (let i = 0; i < len; i++) {
        const clientID = decoding.readVarUint(d)
        decoding.readVarUint(d) // clock, unused here
        const state = JSON.parse(decoding.readVarString(d))
        if (state === null) removed.push(clientID)
      }
      return removed
    } catch {
      // Malformed payload - let applyAwarenessUpdate() below be the one
      // that deals with it (or throws); suppression is a pure optimization,
      // never worth failing the actual message handling over.
      return []
    }
  }

  /**
   * Drop a pending suppressed removal broadcast if it overlaps
   * `removedClientIds` - someone else already broadcast (at least part of)
   * the same departure, so ours is redundant.
   */
  private _cancelPendingAwarenessRemovalIfOverlaps(
    removedClientIds: number[],
  ): void {
    if (!this._pendingAwarenessRemoval) return
    if (
      !this._pendingAwarenessRemoval.some((id) => removedClientIds.includes(id))
    ) {
      return
    }
    if (this._pendingAwarenessRemovalTimeoutId !== undefined) {
      clearTimeout(this._pendingAwarenessRemovalTimeoutId)
      this._pendingAwarenessRemovalTimeoutId = undefined
    }
    this._pendingAwarenessRemoval = null
  }

  /** Cancel a pending suppressed awareness-removal broadcast, if any. */
  private _cancelPendingAwarenessRemoval(): void {
    if (this._pendingAwarenessRemovalTimeoutId !== undefined) {
      clearTimeout(this._pendingAwarenessRemovalTimeoutId)
      this._pendingAwarenessRemovalTimeoutId = undefined
    }
    this._pendingAwarenessRemoval = null
  }

  /**
   * Send a SyncStep2 reply, gated by the same shared per-peer budget as
   * SyncStep1 requests/syncNow() pushes (`_tryReserveSyncSlot()`).
   *
   * Previously SyncStep2 replies were completely unrated - the only
   * defense against redundant replies was the best-effort NACK-style
   * suppression in `_scheduleSyncReply()`/`_cancelPendingSyncReply()`,
   * which itself is just an ordinary broadcast message subject to the same
   * wire corruption as everything else. Under sustained corruption, more
   * competing repliers independently miss the "someone already answered"
   * signal as peer count grows, and none of that traffic was bounded.
   * Measured in test/dummy/bench-corruption-storm.ts: SyncStep2/SyncStep1
   * ratio grew from ~1.1-1.3 at N=2 to ~4.5-5.9 at N=10 (should stay near
   * 1 if suppression alone were sufficient). This is a hard backstop on
   * top of that suppression, not a replacement for it - a rate-limited
   * reply is dropped silently (no warn) since under normal, uncorrupted
   * operation this path is rarely exercised and logging every drop here
   * would itself become log spam exactly when things are already noisy.
   */
  private _sendSyncReply(reply: Uint8Array): void {
    if (!this._tryReserveReplySlot()) {
      return // Rate limited - drop the reply silently
    }
    this._send(reply)
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
        // Routed through the shared coordinator (previously called
        // _sendSyncStep1() directly with NO coalescing at all - the one
        // remaining gap that let this trigger steal rate-limit slots
        // independently of the hash-mismatch/corrupted-message triggers).
        this._requestResync()
      }
    }, this._gapGraceMs)

    this._gapCheckTimers.set(clientID, timer)
  }

  /**
   * Unified entry point for ALL resync triggers (hash mismatch, corrupted
   * message, confirmed sequence gap). Coalesces them behind a single
   * pending timer and a single shared escalation counter, so a burst of
   * triggers from different causes in a short window schedules exactly one
   * resync instead of three independent ones each able to draw on the
   * shared `_tryReserveSyncSlot()` budget on their own.
   *
   * Always resolves to `syncNow()` (push + pull) rather than distinguishing
   * a push-only/pull-only variant per trigger. `syncNow()`'s push half is
   * already a no-op when there's nothing to send (it only calls
   * `_sendUpdate()` when `update.length > 0`), so unifying on push+pull is
   * strictly simpler than threading a `push` flag through a *shared*
   * coordinator (where the "right" answer for an absorbed trigger is
   * ambiguous anyway - was it push-worthy or not?). It also closes a latent
   * gap where the corrupted-message and gap-confirmed triggers previously
   * called pull-only `_sendSyncStep1()` and could never deliver this peer's
   * own surplus edits made during a divergence window.
   */
  private _requestResync(): void {
    // Coalesced: if a resync is already pending (regardless of which
    // trigger scheduled it), this trigger is absorbed into it instead of
    // stacking another independent timer/broadcast. Escalation only
    // advances when we actually schedule a NEW timer below - incrementing
    // unconditionally here (once per absorbed trigger too) would let a
    // burst of many corrupted/mismatched messages while one resync is
    // already pending ratchet the counter straight to its cap, so the
    // *next* resync (after this one fires) always schedules at the max
    // backoff instead of escalating gradually.
    if (this._pendingResyncTimeoutId !== undefined) {
      return
    }

    this._resyncAttemptCount++
    const now = Date.now()

    // Reset the escalation counter if it's been stable for 10 seconds -
    // same quiet-period reset the old per-trigger counters used.
    if (now - this._lastResyncAttemptTime > 10000) {
      this._resyncAttemptCount = 1
    }
    this._lastResyncAttemptTime = now

    // Exponential backoff: 100ms, 500ms, 2.5s, then cap at 5s.
    const delay = Math.min(
      5000,
      100 * Math.pow(5, Math.min(this._resyncAttemptCount - 1, 3)),
    )

    console.warn(
      `[GenericProvider] Resync scheduled in ${delay}ms (attempt #${this._resyncAttemptCount})...`,
    )
    this._pendingResyncTimeoutId = setTimeout(() => {
      this._pendingResyncTimeoutId = undefined
      if (!this.transport.isConnected || this._destroying) return

      // A resync trigger means "I may be missing something" - never "the
      // room is missing my data" (my updates travel on their own, and the
      // connect-time push covers offline edits). So: ask with a 12-byte
      // beacon; the peers ahead of me reply with exactly the diff (a
      // SyncStep2 against my state vector, suppressed as any reply), the
      // rest stay silent. Until phase 1b this pushed the WHOLE document to
      // the room on every trigger, and that push - a hashed update of my
      // state - failed the hash check at every peer ahead of me, which
      // scheduled a resync of its own: the cascade of research doc item 13
      // (198,990 deliveries for 10 keystrokes at N=100 on the Gun profile,
      // the rate limiter's ceiling). If the beacon or its reply is lost,
      // _armResponseWait() re-beacons (1s/2s/4s); the periodic beacon is
      // the fallback after that. A rate-limited attempt re-arms through
      // this same coordinator so a stranded peer keeps retrying.
      if (this._sendSyncStep1(0)) {
        this._armResponseWait(0)
      } else {
        this._requestResync()
      }
    }, delay)
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
    return this._tryReserveSlot(this._syncRequestTimes)
  }

  /** Same limiter, separate budget, for SyncStep2 replies and acks. */
  private _tryReserveReplySlot(): boolean {
    return this._tryReserveSlot(this._syncReplyTimes)
  }

  private _tryReserveSlot(times: number[]): boolean {
    const now = Date.now()

    // Drop entries outside the rolling window (in place: the arrays are
    // referenced from two fields)
    let keep = 0
    for (const t of times) {
      if (now - t < this._syncRequestWindowMs) times[keep++] = t
    }
    times.length = keep

    if (times.length >= this._maxSyncRequestsPerWindow) {
      return false
    }

    times.push(now)
    return true
  }

  /**
   * Encode the digest beacon that replaces SyncStep1 (see
   * MESSAGE_SYNC_DIGEST). Still the one place every "request sync" path
   * goes through (connect()'s syncNow(), the periodic tick,
   * _requestResync()'s retry), so they all switched together.
   */
  private _encodeSyncStep1(flags: number = 0): Uint8Array {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC_DIGEST)
    encoding.writeVarUint(encoder, DIGEST_VERSION)
    encoding.writeVarUint(encoder, flags)
    encoding.writeVarUint(encoder, this.doc.clientID)
    encoding.writeVarUint8Array(encoder, Y.encodeStateVector(this.doc))
    encoding.writeVarUint(encoder, this._deleteSetHash())
    return encoding.toUint8Array(encoder)
  }

  /**
   * Encode an ack for a JOIN beacon: same framing as a beacon, DIGEST_FLAG_ACK
   * set, and the JOINER's state vector + delete-set hash echoed back instead
   * of ours (see DIGEST_FLAG_ACK for why it must never carry our own state).
   */
  private _encodeAck(ackedSv: Uint8Array, ackedDsHash: number): Uint8Array {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC_DIGEST)
    encoding.writeVarUint(encoder, DIGEST_VERSION)
    encoding.writeVarUint(encoder, DIGEST_FLAG_ACK)
    encoding.writeVarUint(encoder, this.doc.clientID)
    encoding.writeVarUint8Array(encoder, ackedSv)
    encoding.writeVarUint(encoder, ackedDsHash)
    return encoding.toUint8Array(encoder)
  }

  /**
   * Send the periodic digest beacon. Rate limited to prevent spam. Returns
   * whether it actually sent (false means rate-limited).
   */
  private _sendSyncStep1(flags: number = 0): boolean {
    if (!this._tryReserveSyncSlot()) {
      console.warn(
        `[GenericProvider] Sync rate limit exceeded (${this._maxSyncRequestsPerWindow} requests per ${this._syncRequestWindowMs / 1000}s), throttling...`,
      )
      return false // Drop the request
    }
    this._send(this._encodeSyncStep1(flags))
    return true
  }

  /**
   * Encode a document update, without sending it. Extracted from the old
   * `_sendUpdate()` so `_trySyncPushPull()` can fold the push half into a
   * batched wire send (see `_sendBatch()`); `_sendUpdate()` below is the
   * send-immediately form still used by every other update-emitting path
   * (the doc-update handler, batch-flush, disconnect/destroy flush) since
   * those aren't part of this batching effort's scope.
   *
   * NOTE: has a side effect (`_localSeqNum++`) - call exactly once per
   * logical update, same as before.
   */
  private _encodeUpdate(update: Uint8Array): Uint8Array {
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

    return encoding.toUint8Array(encoder)
  }

  /**
   * Encode a full-state push (see MESSAGE_SYNC_PUSH): the document as one
   * update, deliberately without the hash and sequence number that
   * `_encodeUpdate()` adds to incremental updates.
   */
  private _encodePush(update: Uint8Array): Uint8Array {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC_PUSH)
    encoding.writeVarUint8Array(encoder, update)
    return encoding.toUint8Array(encoder)
  }

  /**
   * Send a document update to the transport.
   * If verifyUpdates is enabled, includes sequence number and document hash for ordering and desync detection.
   */
  private _sendUpdate(update: Uint8Array): void {
    this._send(this._encodeUpdate(update))
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
   * Encode an awareness update, without sending it. Extracted from the old
   * `_sendAwarenessNow()` so `_tryImmediateAwarenessMessage()` can fold it
   * into a batched wire send instead of always sending it as its own
   * message.
   */
  private _encodeAwareness(clients: number[]): Uint8Array {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
    )
    return encoding.toUint8Array(encoder)
  }

  /**
   * Send awareness update immediately without throttling.
   */
  private _sendAwarenessNow(clients: number[]): void {
    this._send(this._encodeAwareness(clients))
  }

  /**
   * Attempt to build an awareness broadcast message for immediate
   * inclusion in the same wire send as a sync message a caller is about to
   * send anyway (see `_trySyncPushPull`'s `buildExtra` parameter), instead
   * of going through
   * `_broadcastAwareness()`'s independent debounce.
   *
   * Only returns non-null when the throttle would have let an immediate
   * send through anyway - i.e. no debounced broadcast is already pending
   * AND (throttling is disabled, or at least `_awarenessInterval` ms have
   * passed since the last broadcast) - so this never changes awareness
   * throttle semantics, only whether the resulting message travels as its
   * own wire send or bundled with a sync message that happens to be going
   * out "now" too.
   *
   * Mutates the same state `_broadcastAwareness()`'s own immediate-send
   * branches mutate (`_pendingAwarenessClients`, `_lastAwarenessTime`) -
   * once this returns non-null, the state is already committed as "sent
   * now", so the caller MUST actually send the returned message (bundled
   * or standalone) rather than discarding it.
   */
  private _tryImmediateAwarenessMessage(clients: number[]): Uint8Array | null {
    if (clients.length === 0) return null

    // A debounced broadcast is already scheduled - let it handle these
    // clients via the normal pending-set path below, don't race it with an
    // immediate send here.
    if (this._awarenessTimeoutId !== undefined) return null

    if (this._awarenessInterval > 0) {
      const timeSinceLastBroadcast = Date.now() - this._lastAwarenessTime
      if (timeSinceLastBroadcast < this._awarenessInterval) return null
    }

    // Merge with anything already pending (normally empty here since no
    // timer is scheduled, but merge for safety) and commit to sending now -
    // mirrors exactly what _broadcastAwareness()'s own immediate
    // (_awarenessInterval <= 0) and debounced-timer-fired branches do.
    for (const c of clients) this._pendingAwarenessClients.add(c)
    const clientsToSend = Array.from(this._pendingAwarenessClients)
    this._pendingAwarenessClients.clear()
    if (clientsToSend.length === 0) return null
    this._lastAwarenessTime = Date.now()

    return this._encodeAwareness(clientsToSend)
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
   * Send N already-encoded, already-typed sub-messages as ONE wire message
   * instead of N separate `transport.send()`/`bc.publish()` calls, when
   * there's more than one to send. Used at trigger points that
   * conceptually produce a single event but historically sent multiple
   * independent messages for it (sync push, sync pull, awareness) - see
   * `_trySyncPushPull()` (connect-time push + digest beacon + awareness in
   * one wire message).
   *
   * Design (see the task's framing requirements):
   * - Each sub-message is length-prefixed with `writeVarUint8Array`,
   *   consistent with how this codebase already frames variable-length
   *   payloads elsewhere (e.g. MESSAGE_AWARENESS). On receipt,
   *   `_dispatchMessage()`'s `MESSAGE_BATCH` case unwraps and re-dispatches
   *   each one through the EXACT SAME per-message-type logic used for a
   *   top-level message - no parallel reimplementation.
   * - Sub-messages are NOT individually CRC32-wrapped here - the whole
   *   batch envelope goes through the normal, single `_send()` pipeline
   *   below, which wraps the WHOLE envelope in exactly one CRC32 checksum
   *   (and, if `compressionThresholdBytes` is configured, one compression
   *   pass) - built and computed exactly like any other outgoing message,
   *   so this composes with the existing compression pipeline for free
   *   rather than fighting it with a second, nested wrap/compress step.
   *   The tradeoff: a single corrupted bit anywhere in a batched wire
   *   message now invalidates every sub-message it carried, not just one -
   *   per-sub-message CRC32s would avoid that, at the cost of ~4 extra
   *   bytes per sub-message for a benefit that only matters under active
   *   corruption. This tradeoff is exactly what
   *   test/dummy/bench-corruption-storm.ts and bench-packet-loss.ts exist
   *   to measure empirically, per this task's validation requirements,
   *   rather than deciding it by design argument alone.
   * - BroadcastChannel (cross-tab) traffic is NOT specially batched beyond
   *   whatever `_send()` already does per call - same-tab-group cross-tab
   *   traffic is local/cheap, and `_send()` already only issues one
   *   `bc.publish()` per call regardless, so a batch of N sub-messages
   *   already becomes exactly one `bc.publish()` call for free once routed
   *   through here - no separate BC-specific batching logic needed.
   */
  private _sendBatch(messages: Uint8Array[]): void {
    if (messages.length === 0) return
    if (messages.length === 1) {
      this._send(messages[0])
      return
    }

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_BATCH)
    for (const message of messages) {
      encoding.writeVarUint8Array(encoder, message)
    }
    this._send(encoding.toUint8Array(encoder))
  }

  /**
   * Send data through both BroadcastChannel (if connected) and transport.
   * All messages are wrapped with CRC32 checksum for integrity verification.
   * This ensures updates reach both local tabs and remote peers with corruption detection.
   */
  private _send(data: Uint8Array): void {
    // Wrap message with CRC32 checksum
    const wrappedData = wrapMessageWithChecksum(data)

    // Send via BroadcastChannel to other tabs first. BroadcastChannel is
    // same-process (other tabs in this browser) - never worth compressing.
    // When compressionThresholdBytes is enabled, every message still needs
    // the same leading flag byte _handleIncomingMessage() expects
    // regardless of source, so this always sends flag=0 (uncompressed) in
    // that case rather than skipping the flag - see that option's doc
    // comment.
    if (this._bcConnected) {
      bc.publish(
        this._bcChannel,
        this._compressionThresholdBytes
          ? prefixCompressionFlag(0, wrappedData)
          : wrappedData,
        this,
      )
    }

    // Send via network transport
    if (!this.transport.isConnected) {
      return
    }

    this._sendToTransport(wrappedData)
  }

  /**
   * Send already-CRC32-wrapped bytes to the network transport, compressing
   * first if compressionThresholdBytes is configured and this payload
   * clears it. See that option's doc comment for the size threshold
   * reasoning and the wire-format compatibility tradeoff of enabling it.
   */
  private _sendToTransport(wrappedData: Uint8Array): void {
    const threshold = this._compressionThresholdBytes
    if (!threshold) {
      this._dispatchToTransport(wrappedData)
      return
    }

    if (!COMPRESSION_AVAILABLE || wrappedData.length < threshold) {
      this._dispatchToTransport(prefixCompressionFlag(0, wrappedData))
      return
    }

    compressDeflateRaw(wrappedData)
      .then((compressed) => {
        this._dispatchToTransport(prefixCompressionFlag(1, compressed))
      })
      .catch((error) => {
        console.error(
          '[GenericProvider] Compression failed, sending uncompressed:',
          error,
        )
        this._dispatchToTransport(prefixCompressionFlag(0, wrappedData))
      })
  }

  /** Hand fully-framed bytes to transport.send(), tolerating a sync or async send(). */
  private _dispatchToTransport(data: Uint8Array): void {
    try {
      const result = this.transport.send(data)
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
