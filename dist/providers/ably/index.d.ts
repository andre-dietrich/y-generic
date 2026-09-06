/**
 * Ably Transport Provider
 *
 * Real-time synchronization using Ably's managed pub/sub messaging platform.
 *
 * Features:
 * - Global edge network with low latency
 * - Built-in presence tracking
 * - API-key or token-based authentication
 * - Optional password-protected rooms (channel name obfuscation)
 * - Automatic chunking for messages above Ably's size limit
 *
 * The Ably SDK class is injected via the constructor (not imported directly)
 * so this file compiles without the `ably` package installed, and consumers
 * only pull in Ably if they actually use this provider.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { AblyTransport } from 'y-generic/providers/ably'
 * import * as Ably from 'ably'
 *
 * const doc = new Y.Doc()
 * const transport = new AblyTransport({ Realtime: Ably.Realtime })
 * const provider = new GenericProvider(doc, transport)
 *
 * await provider.connect({
 *   apiKey: 'your-ably-api-key',
 *   room: 'my-collab-room',
 * })
 * ```
 *
 * @example Token auth (recommended for browser clients)
 * ```typescript
 * await provider.connect({
 *   authUrl: '/api/ably-token',
 *   room: 'my-collab-room',
 * })
 * ```
 */
import * as Y from 'yjs';
import type { Transport, ConnectionConfig } from '../../transport';
interface AblyConnectionLike {
    state: string;
    once(event: string, cb: (stateChange?: any) => void): void;
    on(event: string, cb: (stateChange?: any) => void): void;
    off(event?: string, cb?: (...args: any[]) => void): void;
}
interface AblyPresenceLike {
    enter(data?: any): Promise<void>;
    leave(data?: any): Promise<void>;
    get(): Promise<Array<{
        clientId: string;
    }>>;
}
interface AblyChannelLike {
    subscribe(callback: (message: {
        data: any;
        clientId?: string;
    }) => void): Promise<void> | void;
    unsubscribe(callback?: (message: {
        data: any;
        clientId?: string;
    }) => void): void;
    publish(eventName: string, data: any): Promise<void>;
    presence: AblyPresenceLike;
    detach(): Promise<void>;
    /** LiveObjects root accessor — only present when the channel was attached with OBJECT_* modes. */
    object?: {
        get(): Promise<LiveMapPathObjectLike>;
    };
}
interface AblyClientLike {
    connection: AblyConnectionLike;
    channels: {
        get(name: string, options?: any): AblyChannelLike;
    };
    close(): void;
}
/**
 * Structural type for the LiveObjects root `PathObject` — only the subset of
 * the real SDK's surface this file actually uses (see `ably/liveobjects`'s
 * `LiveMapPathObject`/`PrimitivePathObject` for the full API).
 */
interface LiveMapPathObjectLike {
    get(key: string): {
        value(): any;
    };
    set(key: string, value: any): Promise<void>;
}
/** Constructor options for AblyTransport. */
export interface AblyTransportOptions {
    /**
     * The `Realtime` class from the Ably JS SDK.
     * @example import * as Ably from 'ably'; new AblyTransport({ Realtime: Ably.Realtime })
     */
    Realtime: new (options: Record<string, any>) => AblyClientLike;
    /**
     * The `LiveObjects` plugin class from `ably/liveobjects`. Required only
     * when a config passed to `connect()` sets `persistent: true`.
     * @example import { LiveObjects } from 'ably/liveobjects'; new AblyTransport({ Realtime: Ably.Realtime, LiveObjects })
     */
    LiveObjects?: any;
    /** Enable debug logging. @default false */
    debug?: boolean;
}
/** Connection configuration for AblyTransport. */
export interface AblyConfig extends ConnectionConfig {
    /** Ably API key (quick setup/testing). Avoid exposing this in production browser code. */
    apiKey?: string;
    /** Token-auth endpoint — recommended for browser clients instead of `apiKey`. */
    authUrl?: string;
    /** HTTP method used for `authUrl`. @default 'GET' */
    authMethod?: 'GET' | 'POST';
    /** Room/channel name for collaboration (required) */
    room: string;
    /** Optional password to obfuscate the channel name */
    password?: string;
    /** Enable debug logging (overrides constructor option) */
    debug?: boolean;
    /**
     * When true, the full Y.Doc state is saved to Ably LiveObjects and loaded
     * back when peers reconnect after all going offline.
     * @default false
     */
    persistent?: boolean;
    /** The Y.Doc to snapshot. Required when persistent is true. */
    doc?: Y.Doc;
    /** Debounce delay in ms before writing the snapshot. @default 2000 */
    persistDebounceMs?: number;
}
/**
 * Ably transport for y-generic.
 *
 * Publishes Yjs binary updates as base64-encoded messages on an Ably channel
 * and subscribes to matching messages from peers.
 */
export declare class AblyTransport implements Transport {
    private readonly opts;
    private client;
    private channel;
    private clientId;
    private channelName;
    private _isConnected;
    private debug;
    private messageCallback?;
    private messageBuffer;
    private chunkBuffer;
    readonly preferredCompressMinBytes = 2048;
    private persistentMode;
    private persistDoc;
    private persistDebounceMs;
    private persistTimer?;
    private isWritingSnapshot;
    private savePending;
    /** True once loadSnapshot()'s initial read has completed */
    private snapshotLoaded;
    /** Cached LiveObjects root, resolved once per connect() */
    private liveRoot;
    constructor(options: AblyTransportOptions);
    get isConnected(): boolean;
    connect(config: AblyConfig): Promise<void>;
    disconnect(): Promise<void>;
    send(data: Uint8Array): void;
    /** Peek the message type byte from CRC32-wrapped data (byte 4, after the 4-byte CRC32 header). */
    private peekMessageType;
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /** Get the clientIds of other peers currently present on the channel. */
    getPresence(): Promise<string[]>;
    /** Schedule a debounced snapshot write. Called on every non-awareness send(). */
    private queuePersist;
    /**
     * Encode the full Y.Doc state as a SYNC_STEP_2 message and write it across
     * one or more LiveMap keys (each `set()` is capped at Ably's 64 KiB message
     * size, so a real snapshot needs chunking — see `snapshot-count`/`snapshot-N`
     * below). Chunk keys are written first, `snapshot-count` last, so a reader
     * can treat its presence as "this snapshot is complete."
     */
    private saveSnapshot;
    /**
     * Load the snapshot from LiveObjects and deliver it to the message
     * callback. Aborts without delivering anything if a chunk is missing —
     * partial data is worse than none.
     */
    private loadSnapshot;
    private sendChunked;
    private handleChunkedMessage;
    private handleMessage;
    private deliver;
    private log;
}
export {};
//# sourceMappingURL=index.d.ts.map