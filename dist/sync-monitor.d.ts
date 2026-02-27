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
import type { GenericProvider } from '../src/index';
/**
 * Compute hash of entire Yjs document state.
 */
export declare function computeDocumentHash(doc: Y.Doc): string;
/**
 * Sync health monitor that detects divergence using periodic hashing.
 */
export declare class SyncHealthMonitor {
    private options;
    private provider;
    private intervalId?;
    private localHash;
    private peerHashes;
    constructor(provider: GenericProvider, options?: {
        /** How often to check sync health (ms) */
        checkInterval?: number;
        /** Callback when desync detected */
        onDesync?: (details: DesyncDetails) => void;
    });
    /**
     * Start monitoring sync health.
     */
    start(): void;
    /**
     * Stop monitoring.
     */
    stop(): void;
    /**
     * Perform a health check.
     */
    private checkHealth;
    /**
     * Handle hash from peer.
     */
    private handlePeerHash;
    /**
     * Detect if any peer has different hash.
     */
    private detectDivergence;
}
export interface DesyncDetails {
    localHash: string;
    peerHashes: Map<number, string>;
    divergentClients: number[];
    timestamp: number;
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
//# sourceMappingURL=sync-monitor.d.ts.map