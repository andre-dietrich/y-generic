/**
 * Optional sync monitoring utilities using hash-based detection.
 *
 * ⚠️ NOTE: For most use cases, use the BUILT-IN verification instead:
 *   GenericProvider with verifyUpdates: true (default)
 *
 * When to use SyncHealthMonitor:
 * - You need to monitor sync health across ALL peers simultaneously
 * - You want periodic pub/sub-based hash broadcasting for diagnostics
 * - You need alerting/monitoring separate from the core sync mechanism
 *
 * When to use built-in verification (recommended):
 * - Fast desync detection on every update (no waiting)
 * - Exponential backoff and rate limiting
 * - Sequence numbers for duplicate detection
 * - Zero configuration (enabled by default)
 *
 * This utility is complementary to Yjs's built-in state vector sync.
 * Use for monitoring/alerting, not as primary sync mechanism.
 */

import * as Y from 'yjs'
import type { GenericProvider } from '../src/index'

/**
 * Compute a simple hash of the document content.
 * For production, use a proper hash function (e.g., crypto.subtle.digest).
 */
function simpleHash(data: Uint8Array): string {
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]) | 0
  }
  return hash.toString(36)
}

/**
 * Compute hash of entire Yjs document state.
 */
export function computeDocumentHash(doc: Y.Doc): string {
  const state = Y.encodeStateAsUpdate(doc)
  return simpleHash(state)
}

/**
 * Sync health monitor that detects divergence using periodic hashing.
 */
export class SyncHealthMonitor {
  private provider: GenericProvider
  private intervalId?: NodeJS.Timeout | number
  private localHash: string = ''
  private peerHashes: Map<number, string> = new Map()

  constructor(
    provider: GenericProvider,
    private options: {
      /** How often to check sync health (ms) */
      checkInterval?: number
      /** Callback when desync detected */
      onDesync?: (details: DesyncDetails) => void
    } = {},
  ) {
    this.provider = provider
    this.options.checkInterval = options.checkInterval ?? 10000 // 10 seconds default
  }

  /**
   * Start monitoring sync health.
   */
  start(): void {
    if (this.intervalId) return

    console.log('[SyncMonitor] Starting health checks...')

    this.intervalId = setInterval(() => {
      this.checkHealth()
    }, this.options.checkInterval)

    // Subscribe to peer hashes via pub/sub
    this.provider.pubsub.subscribe('sync-health', (msg: any) => {
      if (msg.type === 'hash-broadcast') {
        this.handlePeerHash(msg.clientId, msg.hash)
      }
    })
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId as number)
      this.intervalId = undefined
    }
  }

  /**
   * Perform a health check.
   */
  private checkHealth(): void {
    if (!this.provider.connected) return

    // Compute local hash
    this.localHash = computeDocumentHash(this.provider.doc)

    // Broadcast to peers
    this.provider.pubsub.publish('sync-health', {
      type: 'hash-broadcast',
      clientId: this.provider.doc.clientID,
      hash: this.localHash,
    })

    // Check for divergence
    this.detectDivergence()
  }

  /**
   * Handle hash from peer.
   */
  private handlePeerHash(clientId: number, hash: string): void {
    this.peerHashes.set(clientId, hash)
  }

  /**
   * Detect if any peer has different hash.
   */
  private detectDivergence(): void {
    const divergent: number[] = []

    this.peerHashes.forEach((peerHash, clientId) => {
      if (peerHash !== this.localHash) {
        divergent.push(clientId)
      }
    })

    if (divergent.length > 0) {
      console.warn('[SyncMonitor] ⚠️ Desync detected with clients:', divergent)
      console.warn(
        '[SyncMonitor] Local hash:',
        this.localHash,
        'Peer hashes:',
        Array.from(this.peerHashes.entries()),
      )

      // Trigger automatic re-sync
      console.log('[SyncMonitor] 🔄 Triggering automatic re-sync...')
      this.provider.syncNow()

      // Notify callback
      if (this.options.onDesync) {
        this.options.onDesync({
          localHash: this.localHash,
          peerHashes: new Map(this.peerHashes),
          divergentClients: divergent,
          timestamp: Date.now(),
        })
      }
    }
  }
}

export interface DesyncDetails {
  localHash: string
  peerHashes: Map<number, string>
  divergentClients: number[]
  timestamp: number
}

/**
 * Example usage:
 *
 * ```typescript
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 *
 * // Start monitoring
 * const monitor = new SyncHealthMonitor(provider, {
 *   checkInterval: 5000, // Check every 5 seconds
 *   onDesync: (details) => {
 *     console.error('Documents out of sync!', details)
 *     // Send to error tracking, show warning to user, etc.
 *   }
 * })
 * monitor.start()
 *
 * // Stop when done
 * monitor.stop()
 * ```
 */
