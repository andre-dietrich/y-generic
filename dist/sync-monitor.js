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
import * as Y from 'yjs';
/**
 * Compute a simple hash of the document content.
 * For production, use a proper hash function (e.g., crypto.subtle.digest).
 */
function simpleHash(data) {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash + data[i]) | 0;
    }
    return hash.toString(36);
}
/**
 * Compute hash of entire Yjs document state.
 */
export function computeDocumentHash(doc) {
    const state = Y.encodeStateAsUpdate(doc);
    return simpleHash(state);
}
/**
 * Sync health monitor that detects divergence using periodic hashing.
 */
export class SyncHealthMonitor {
    constructor(provider, options = {}) {
        this.options = options;
        this.localHash = '';
        this.peerHashes = new Map();
        this.provider = provider;
        this.options.checkInterval = options.checkInterval ?? 10000; // 10 seconds default
    }
    /**
     * Start monitoring sync health.
     */
    start() {
        if (this.intervalId)
            return;
        console.log('[SyncMonitor] Starting health checks...');
        this.intervalId = setInterval(() => {
            this.checkHealth();
        }, this.options.checkInterval);
        // Subscribe to peer hashes via pub/sub
        this.provider.pubsub.subscribe('sync-health', (msg) => {
            if (msg.type === 'hash-broadcast') {
                this.handlePeerHash(msg.clientId, msg.hash);
            }
        });
    }
    /**
     * Stop monitoring.
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }
    /**
     * Perform a health check.
     */
    checkHealth() {
        if (!this.provider.connected)
            return;
        // Compute local hash
        this.localHash = computeDocumentHash(this.provider.doc);
        // Broadcast to peers
        this.provider.pubsub.publish('sync-health', {
            type: 'hash-broadcast',
            clientId: this.provider.doc.clientID,
            hash: this.localHash,
        });
        // Check for divergence
        this.detectDivergence();
    }
    /**
     * Handle hash from peer.
     */
    handlePeerHash(clientId, hash) {
        this.peerHashes.set(clientId, hash);
    }
    /**
     * Detect if any peer has different hash.
     */
    detectDivergence() {
        const divergent = [];
        this.peerHashes.forEach((peerHash, clientId) => {
            if (peerHash !== this.localHash) {
                divergent.push(clientId);
            }
        });
        if (divergent.length > 0) {
            console.warn('[SyncMonitor] ⚠️ Desync detected with clients:', divergent);
            console.warn('[SyncMonitor] Local hash:', this.localHash, 'Peer hashes:', Array.from(this.peerHashes.entries()));
            // Trigger automatic re-sync
            console.log('[SyncMonitor] 🔄 Triggering automatic re-sync...');
            this.provider.syncNow();
            // Notify callback
            if (this.options.onDesync) {
                this.options.onDesync({
                    localHash: this.localHash,
                    peerHashes: new Map(this.peerHashes),
                    divergentClients: divergent,
                    timestamp: Date.now(),
                });
            }
        }
    }
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
//# sourceMappingURL=sync-monitor.js.map