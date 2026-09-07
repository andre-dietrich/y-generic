import type { Transport, ConnectionConfig } from '../../transport';
/**
 * PubNub transport configuration
 */
export interface PubNubConfig extends ConnectionConfig {
    /** PubNub publish key (required) */
    publishKey: string;
    /** PubNub subscribe key (required) */
    subscribeKey: string;
    /** Optional cipher key for message encryption */
    cipherKey?: string;
    /** Store messages in history (default: false) */
    storeInHistory?: boolean;
    /** Enable debug logging */
    debug?: boolean;
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
 * const transport = new PubNubTransport({
 *   publishKey: 'pub-c-xxx',
 *   subscribeKey: 'sub-c-xxx',
 *   room: 'my-room',
 *   password: 'optional-encryption-key'
 * })
 *
 * const provider = new GenericProvider(doc, transport)
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
    presence?: boolean;
}
export declare class PubNubTransport implements Transport {
    private pubnub;
    private channel;
    private readonly presenceEnabled;
    /**
     * Transport.onPeerDisconnect - present only with `presence: true` (see
     * PubNubTransportOptions), so GenericProvider keeps the 30 s awareness
     * lease on a keyset without Presence. Peer ids are publisher uuids, the
     * same `from` onMessage passes.
     */
    readonly onPeerDisconnect?: (callback: (peerId: string) => void) => () => void;
    constructor(options?: PubNubTransportOptions);
    private uuid;
    private messageCallback?;
    private _peerDisconnectCallback?;
    private _isConnected;
    private config;
    private debug;
    private messageBuffer;
    private chunkBuffer;
    readonly preferredCompressMinBytes = 2048;
    private readonly MAX_MESSAGE_SIZE;
    get isConnected(): boolean;
    /**
     * Connect to PubNub channel
     */
    connect(config: PubNubConfig): Promise<void>;
    /**
     * Disconnect from PubNub
     */
    disconnect(): void;
    /**
     * Send data to all peers
     */
    send(data: Uint8Array): void;
    /**
     * Send large message in chunks
     */
    private sendChunked;
    /**
     * Handle incoming chunked message
     */
    private handleChunkedMessage;
    /**
     * Register message callback
     */
    onMessage(callback: (data: Uint8Array, from?: string) => void): () => void;
    /**
     * With `presence: true`: after subscribing, check that the keyset lists us
     * in hereNow - a keyset without the Presence add-on never emits presence
     * events, and GenericProvider would then trust a leave signal that never
     * comes (departures noticed only after the 5-minute lease).
     */
    private verifyPresence;
    /**
     * Get presence information (list of peers)
     */
    getPresence(): Promise<string[]>;
    /**
     * Convert Uint8Array to base64 string
     *
     * Handles large arrays by processing in chunks to avoid
     * "too many function arguments" error with String.fromCharCode
     */
    private uint8ToBase64;
    /**
     * Convert base64 string to Uint8Array
     */
    private base64ToUint8;
    /**
     * Generate a unique UUID
     */
    private generateUUID;
    /**
     * Debug logging
     */
    private log;
}
//# sourceMappingURL=index.d.ts.map