import type { Transport, ConnectionConfig } from '../../transport';
/**
 * WebSocket transport configuration
 */
export interface WebSocketConfig extends ConnectionConfig {
    /** WebSocket server URL (required) e.g., 'ws://localhost:1234' or 'wss://example.com' */
    serverUrl: string;
    /** Enable automatic reconnection on disconnect (default: true) */
    autoReconnect?: boolean;
    /** Reconnection delay in milliseconds (default: 2000) */
    reconnectDelay?: number;
    /** Maximum reconnection attempts (0 = infinite, default: 0) */
    maxReconnectAttempts?: number;
    /** WebSocket protocols (optional) */
    protocols?: string | string[];
    /** Enable debug logging */
    debug?: boolean;
    /**
     * Password for end-to-end encryption.
     * When set, all messages are encrypted with AES-GCM before sending.
     * All peers in the room must use the same password.
     * @default undefined (no encryption)
     */
    password?: string;
}
/**
 * WebSocket Transport for Yjs
 *
 * Provides real-time synchronization using WebSocket connections.
 *
 * Features:
 * - Direct WebSocket connection to server
 * - Room-based collaboration
 * - Automatic reconnection
 * - Binary message support
 * - Low latency real-time sync
 * - Optional password encryption (AES-GCM)
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { WebSocketTransport } from 'y-generic/providers/websocket'
 *
 * const doc = new Y.Doc()
 * const transport = new WebSocketTransport()
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   serverUrl: 'ws://localhost:1234',
 *   room: 'my-room'
 * })
 * ```
 *
 * @example Password-protected room
 * ```ts
 * await provider.connect({
 *   serverUrl: 'wss://example.com',
 *   room: 'secure-room',
 *   password: 'my-secret-password'  // E2E encrypted
 * })
 * ```
 */
export declare class WebSocketTransport implements Transport {
    private ws;
    private config;
    private messageCallback?;
    private _isConnected;
    private debug;
    private reconnectAttempts;
    private reconnectTimer?;
    private intentionalDisconnect;
    private messageQueue;
    private receivedBuffer;
    private cryptoKey;
    private encryptionEnabled;
    get isConnected(): boolean;
    /**
     * Connect to WebSocket server
     */
    connect(config: WebSocketConfig): Promise<void>;
    /**
     * Disconnect from WebSocket server
     */
    disconnect(): void;
    /**
     * Send data to server
     */
    send(data: Uint8Array): void;
    /**
     * Encrypt and send data
     */
    private encryptAndSend;
    /**
     * Send raw data without encryption
     */
    private sendRaw;
    /**
     * Register message callback
     */
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Handle incoming WebSocket message
     */
    private handleMessage;
    /**
     * Flush queued messages
     */
    private flushMessageQueue;
    /**
     * Attempt to reconnect
     */
    private attemptReconnect;
    /**
     * Debug logging
     */
    private log;
    /**
     * Initialize encryption with password using PBKDF2 key derivation.
     */
    private initEncryption;
    /**
     * Encrypt data using AES-GCM.
     * Format: [IV (12 bytes)][ciphertext][auth tag (16 bytes)]
     */
    private encrypt;
    /**
     * Decrypt data using AES-GCM.
     */
    private decrypt;
}
//# sourceMappingURL=index.d.ts.map