/**
 * GunDB Transport Provider
 *
 * Decentralized peer-to-peer transport using GunDB graph database.
 * GunDB provides automatic conflict resolution and offline-first sync.
 *
 * Features:
 * - Decentralized P2P architecture
 * - Automatic conflict resolution (CRDT)
 * - Offline-first with auto-sync
 * - Real-time updates via .on()
 * - Optional relay servers
 * - Graph-based data structure
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { GunTransport } from 'y-generic/providers/gun'
 * import Gun from 'gun'
 *
 * const doc = new Y.Doc()
 * const transport = new GunTransport({
 *   gun: Gun, // Pass the Gun constructor
 *   peers: ['https://gun-relay.herokuapp.com/gun']
 * })
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 * ```
 */

import type { Transport, ConnectionConfig } from '../../transport'

/**
 * Gun constructor type (from gun library).
 */
export type GunConstructor = any

/**
 * Configuration options for Gun transport.
 */
export interface GunTransportOptions {
  /**
   * The Gun library constructor.
   * Users must provide this to avoid bundling the library.
   * @example
   * ```typescript
   * import Gun from 'gun'
   * const transport = new GunTransport({ gun: Gun })
   * ```
   */
  gun: GunConstructor

  /**
   * Array of peer relay servers to connect to.
   * Gun will attempt to sync with these peers and any peers they know about.
   * @default [] (local only)
   * @example ['https://gun-relay.herokuapp.com/gun']
   */
  peers?: string[]

  /**
   * Gun configuration options.
   * @see https://gun.eco/docs/API
   */
  gunOptions?: {
    localStorage?: boolean
    radisk?: boolean
    axe?: boolean
    [key: string]: any
  }

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean

  /**
   * Update batch interval in milliseconds.
   * Gun will batch multiple updates within this window.
   * @default 50
   */
  batchInterval?: number
}

/**
 * GunDB transport implementation.
 * Creates decentralized P2P connections using Gun graph database.
 */
export class GunTransport implements Transport {
  private options: Required<GunTransportOptions>
  private _connected: boolean = false
  private _room: string = ''
  private _callback?: (data: Uint8Array) => void
  private gun: any = null
  private roomNode: any = null
  private updateListener: any = null
  private lastUpdateTime: number = 0
  private updateBatch: Uint8Array[] = []
  private batchTimeout?: ReturnType<typeof setTimeout>
  private processedUpdates: Set<string> = new Set()
  private connectionTime: number = 0
  private throttleTimeout?: ReturnType<typeof setTimeout>
  private pendingUpdates: Map<string, any> = new Map()
  private updateSlot: number = 0
  private readonly BUFFER_SIZE = 10 // Circular buffer size

  /**
   * Create a new Gun transport.
   *
   * @param options - Configuration options (must include gun constructor)
   */
  constructor(options: GunTransportOptions) {
    if (!options.gun) {
      throw new Error(
        'GunTransport requires the "gun" option. ' +
          'Please provide the Gun constructor: ' +
          'import Gun from "gun"; new GunTransport({ gun: Gun, ... })',
      )
    }

    this.options = {
      gun: options.gun,
      peers: options.peers ?? [],
      gunOptions: options.gunOptions ?? {},
      debug: options.debug ?? false,
      batchInterval: options.batchInterval ?? 50,
    }
  }

  /**
   * Connect to the room and start syncing.
   */
  async connect(config: ConnectionConfig): Promise<void> {
    if (this._connected) {
      throw new Error('Already connected')
    }

    this._room = config.room
    this.connectionTime = Date.now()

    this.log('🔗 Initializing Gun...')

    // Initialize Gun
    const gunConfig: any = {
      localStorage: false, // Disable localStorage to prevent quota errors
      radisk: false, // Disable radisk
      ...this.options.gunOptions,
    }

    // Add peers if specified
    if (this.options.peers.length > 0) {
      gunConfig.peers = this.options.peers
      this.log('📡 Connecting to peers:', this.options.peers)
    }

    this.gun = new this.options.gun(gunConfig)

    // Navigate to room node
    this.roomNode = this.gun.get(`yjs-room-${this._room}`)

    this.log('✅ Gun initialized for room:', this._room)

    // Note: We use a circular buffer (10 slots) to prevent infinite accumulation
    // of update nodes in Gun's graph. This prevents the "1K+ records" warning.
    // Each update overwrites one of the slots (slot-0 through slot-9).

    // Subscribe to updates from Gun
    this.setupUpdateListener()

    this._connected = true
  }

  /**
   * Setup listener for Gun updates.
   */
  private setupUpdateListener(): void {
    let lastProcessTime = 0
    const THROTTLE_MS = 300 // Process updates at most every 300ms

    // Listen to the 'updates' collection in the room
    // Using throttled processing to prevent "1K+ records" warning
    this.updateListener = this.roomNode
      .get('updates')
      .map()
      .on((update: any, updateId: string) => {
        if (!update || !update.data) return

        // Skip updates from before we connected (avoid initial flood)
        if (update.timestamp && update.timestamp < this.connectionTime - 5000) {
          return
        }

        // Use sequence number for deduplication (more stable than timestamp)
        const sequence = update.sequence || Math.floor(update.timestamp / 100)
        const updateKey = `${updateId}-${sequence}`
        if (this.processedUpdates.has(updateKey)) {
          return
        }

        // Store update for throttled processing
        this.pendingUpdates.set(updateKey, update)

        // Throttle processing
        const now = Date.now()
        if (now - lastProcessTime < THROTTLE_MS) {
          // Schedule processing if not already scheduled
          if (!this.throttleTimeout) {
            this.throttleTimeout = setTimeout(() => {
              this.processPendingUpdates()
              lastProcessTime = Date.now()
              this.throttleTimeout = undefined
            }, THROTTLE_MS)
          }
          return
        }

        // Process immediately if enough time has passed
        lastProcessTime = now
        this.processPendingUpdates()
      })

    this.log('👂 Listening for updates...')
  }

  /**
   * Process all pending updates at once.
   */
  private processPendingUpdates(): void {
    if (this.pendingUpdates.size === 0) return

    const updates = Array.from(this.pendingUpdates.entries())
    this.pendingUpdates.clear()

    for (const [updateKey, update] of updates) {
      // Mark as processed
      this.processedUpdates.add(updateKey)

      // Clean old entries from processed set (keep last 200)
      if (this.processedUpdates.size > 200) {
        const entries = Array.from(this.processedUpdates)
        entries.slice(0, entries.length - 200).forEach((key) => {
          this.processedUpdates.delete(key)
        })
      }

      try {
        // Decode base64 back to Uint8Array
        const decoded = this.base64ToUint8Array(update.data)

        // Pass to Yjs
        if (this._callback) {
          this._callback(decoded)
        }

        if (updates.length === 1) {
          this.log('📥 Received update:', decoded.length, 'bytes')
        }
      } catch (error) {
        this.log('❌ Error processing update:', error)
      }
    }

    if (updates.length > 1) {
      this.log(`📥 Processed ${updates.length} batched updates`)
    }
  }

  /**
   * Disconnect from Gun and cleanup.
   */
  disconnect(): void {
    if (!this._connected) return

    this.log('👋 Disconnecting...')

    // Clear batch timeout
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout)
      this.batchTimeout = undefined
    }

    // Clear throttle timeout
    if (this.throttleTimeout) {
      clearTimeout(this.throttleTimeout)
      this.throttleTimeout = undefined
    }

    // Process any pending updates before disconnect
    this.processPendingUpdates()

    // Flush any pending updates
    this.flushBatch()

    // Remove listener
    if (this.updateListener) {
      // Gun doesn't have a clear off() method for map listeners
      // The listener will be garbage collected
      this.updateListener = null
    }

    this.roomNode = null
    this.gun = null
    this._connected = false
    this.processedUpdates.clear()
    this.pendingUpdates.clear()

    this.log('✅ Disconnected')
  }

  /**
   * Send data to all peers via Gun.
   */
  send(data: Uint8Array): void {
    if (!this._connected || !this.roomNode) {
      this.log('⚠️ Not connected, cannot send')
      return
    }

    // Add to batch
    this.updateBatch.push(data)

    // Clear existing timeout
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout)
    }

    // Set new timeout to flush batch
    this.batchTimeout = setTimeout(() => {
      this.flushBatch()
    }, this.options.batchInterval)
  }

  /**
   * Flush batched updates to Gun.
   */
  private flushBatch(): void {
    if (this.updateBatch.length === 0) return

    // Merge all batched updates into one
    const totalLength = this.updateBatch.reduce(
      (sum, arr) => sum + arr.length,
      0,
    )
    const merged = new Uint8Array(totalLength)
    let offset = 0
    for (const update of this.updateBatch) {
      merged.set(update, offset)
      offset += update.length
    }

    // Clear batch
    this.updateBatch = []

    // Convert to base64 for Gun storage
    const base64Data = this.uint8ArrayToBase64(merged)

    // Create update object with circular buffer slot
    const updateId = this.generateUpdateId()
    const timestamp = Date.now()
    const sequence = Math.floor(timestamp / 100) // Sequence number per 100ms

    // Mark as processed so we don't receive our own update
    this.processedUpdates.add(`${updateId}-${sequence}`)

    // Store in Gun using circular buffer slot
    const updates = this.roomNode.get('updates')
    updates.get(updateId).put({
      data: base64Data,
      timestamp: timestamp,
      sequence: sequence,
      size: merged.length,
    })

    this.log('📤 Sent update:', merged.length, 'bytes')
  }

  /**
   * Register callback for incoming messages.
   */
  onMessage(callback: (data: Uint8Array) => void): () => void {
    this._callback = callback
    return () => {
      this._callback = undefined
    }
  }

  /**
   * Check if connected.
   */
  get isConnected(): boolean {
    return this._connected
  }

  /**
   * Generate a circular buffer slot ID.
   * Uses only BUFFER_SIZE slots to prevent infinite accumulation.
   */
  private generateUpdateId(): string {
    const slotId = `slot-${this.updateSlot}`
    this.updateSlot = (this.updateSlot + 1) % this.BUFFER_SIZE
    return slotId
  }

  /**
   * Convert Uint8Array to base64 string.
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  /**
   * Convert base64 string to Uint8Array.
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  /**
   * Log debug messages if enabled.
   */
  private log(...args: any[]): void {
    if (this.options.debug) {
      console.log('[GunTransport]', ...args)
    }
  }
}
