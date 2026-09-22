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
    private _peerConnectCallback?;
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
     * Transport.onPeerConnect: fires when the link to PubNub comes BACK - after
     * the browser's `online`, or after the SDK's own reconnect found the
     * network again. Never for the first connect.
     */
    onPeerConnect(callback: (peerId: string) => void): () => void;
    /**
     * Disconnect from PubNub
     */
    disconnect(): void;
    /**
     * Send data to all peers
     */
    send(data: Uint8Array): void;
    /**
     * What send() published in the current task - what flush() sends once
     * more if this task turns out to be the page's last.
     */
    private _thisTask;
    private _thisTaskClear?;
    private remember;
    /**
     * Transport.flush: the page is unloading. A publish is a `fetch` of the
     * SDK's, and the SDK sets no `keepalive` (there is no option for it): a
     * page that goes away may take the request with it before it has left.
     * The one message that matters then is the one sent in this very task,
     * our presence removal - lost, and a reloaded page stayed a ghost in every
     * roster for the 30 s lease (2 of 35 reloads, room-scenarios.mjs pubnub,
     * SCENARIOS=join,linger LINGER_GAP_MS=5000). So what went out in this task
     * goes once more as a `keepalive` request straight to the publish REST
     * endpoint, which the browser completes after the page is gone. A copy
     * that arrives twice changes nothing (an awareness state at an equal
     * clock, a Yjs update, a duplicate sequence number are all ignored).
     * Not with a cipher key: the SDK encrypts, this path would not.
     */
    flush(): void;
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