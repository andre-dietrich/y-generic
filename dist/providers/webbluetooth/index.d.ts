import type { Transport, ConnectionConfig } from '../../transport';
import './bluetooth.d.ts';
/**
 * WebBluetooth transport configuration
 */
export interface WebBluetoothConfig extends ConnectionConfig {
    /** Enable debug logging */
    debug?: boolean;
    /** Auto-reconnect to lost peers (default: true) */
    autoReconnect?: boolean;
    /** Scan duration in seconds (default: 10) */
    scanDuration?: number;
}
/**
 * WebBluetooth Transport for Yjs
 *
 * Enables device-to-device collaboration via Bluetooth Low Energy.
 * Perfect for offline/local collaboration scenarios.
 *
 * Features:
 * - No internet required
 * - Zero server setup
 * - Works on Android Chrome/Edge
 * - Automatic peer discovery
 * - Multi-peer mesh network
 * - Message chunking for large updates
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { WebBluetoothTransport } from 'y-generic/providers/webbluetooth'
 *
 * const doc = new Y.Doc()
 * const transport = new WebBluetoothTransport()
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   room: 'my-collab-room'
 * })
 * ```
 */
export declare class WebBluetoothTransport implements Transport {
    private config;
    private messageCallback?;
    private _isConnected;
    private debug;
    private peers;
    private scanning;
    private intentionalDisconnect;
    get isConnected(): boolean;
    /**
     * Connect and start discovering Bluetooth peers
     */
    connect(config: WebBluetoothConfig): Promise<void>;
    /**
     * Scan for Bluetooth peers
     */
    private scanForPeers;
    /**
     * Connect to a discovered peer
     */
    private connectToPeer;
    /**
     * Handle incoming data from peer
     */
    private handleIncomingData;
    /**
     * Handle peer disconnection
     */
    private handlePeerDisconnected;
    /**
     * Start periodic scanning for new peers
     */
    private startPeriodicScan;
    /**
     * Disconnect from all peers
     */
    disconnect(): Promise<void>;
    /**
     * Send data to all connected peers
     */
    send(data: Uint8Array): void;
    /**
     * Send data to a specific peer (with chunking)
     */
    private sendToPeer;
    /**
     * Register message callback
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Manually trigger peer discovery
     * (must be called from user gesture due to browser security)
     */
    discoverPeers(): Promise<void>;
    /**
     * Get list of connected peers
     */
    getConnectedPeers(): Array<{
        id: string;
        name: string | undefined;
    }>;
    /**
     * Log debug messages
     */
    private log;
}
//# sourceMappingURL=index.d.ts.map