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
    connect?(): void;
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
    subscribe(action: string, callback: (member: {
        clientId?: string;
        action?: string;
    }) => void): Promise<void> | void;
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
    /**
     * The longest a change waits for its snapshot while the debounce keeps
     * being restarted - by somebody who types: without it nothing was written
     * for as long as that went on (test/ably/repro-liveobjects-persist.ts, 7).
     * @default 10000
     */
    persistMaxWaitMs?: number;
    /**
     * ably-js's first retry after a lost connection; later ones wait up to
     * twice as long (x 1, 4/3, 5/3, 2). A network that comes back without the
     * browser saying so (a server, a proxy, a router that was gone) is only
     * found by that retry. ably-js's own default, 15 s, kept 25 browsers out
     * for 15.3 s after a 5 s outage and 28.6 s after a 45 s one.
     * @default 5000 (at most 10 s between two tries, the WebSocket transport's cap)
     */
    disconnectedRetryTimeout?: number;
    /** ably-js's retry once a connection has been gone for 2 min. @default 10000 (ably-js: 30000) */
    suspendedRetryTimeout?: number;
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
    private _peerDisconnectCallback?;
    private _peerConnectCallback?;
    private _enterTimer?;
    private _stopPageWatch?;
    private _pageBackAt;
    private messageBuffer;
    private chunkBuffer;
    private persistentMode;
    private persistDoc;
    private persistDebounceMs;
    private persistMaxWaitMs;
    /** When the oldest change the pending snapshot is for was made; 0 = none pending */
    private persistPendingSince;
    /** ConnectionConfig.sealFrame - the encryption of a wrapper above us */
    private sealFrame?;
    /**
     * A snapshot is written for a change made HERE, not for one applied from
     * the room (Y.applyUpdate makes a transaction that is not local) - its
     * author writes that one. Told from the wire frame before, by its type
     * byte: behind an encrypting wrapper that byte is ciphertext, and every
     * presence change wrote a snapshot (test/ably/repro-liveobjects-persist.ts, 5).
     */
    private _onDocUpdate;
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
    /**
     * Presence is what lets the room drop us the moment we leave - not a
     * reason to refuse the room. Ably rejects an enter like any message while
     * the channel is over its rate (42913, "nonfatal"; free tier: 50
     * messages/s): of 25 peers joining within 5 s, one failed to connect for
     * good (test/e2e/room-scenarios.mjs ably, twice in two runs). Never
     * throws; tries again until it holds, 1 s doubling up to 30 s, jittered.
     */
    private _enterPresence;
    /** connect() now if ably-js is waiting out a retry. */
    private _dialIfDown;
    /** A connection lost within PAGE_BACK_WINDOW_MS of the page's return: the socket died while it was away. */
    private _dialSoonAfterPageBack;
    disconnect(): Promise<void>;
    send(data: Uint8Array): void;
    onMessage(callback: (data: Uint8Array, from?: string) => void): () => void;
    /** Get the clientIds of other peers currently present on the channel. */
    getPresence(): Promise<string[]>;
    /** Schedule a debounced snapshot write - never beyond persistMaxWaitMs after the oldest change. */
    private queuePersist;
    /**
     * Transport.flush: the page is unloading. A snapshot still in its
     * debounce is written now - a page that goes runs no further timer, and
     * the last edit before a reload or a closed tab was missing from the room
     * (test/ably/repro-liveobjects-persist.ts, 6).
     */
    flush(): void;
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
    /**
     * Publish, and publish again what Ably REFUSED: over the channel's message
     * rate (free tier: 50/s) it rejects the publish - 42913 "Rate limit
     * exceeded; request rejected (nonfatal)", statusCode 429 - and tells us.
     * That is not a failed send to log: the message is lost for every receiver
     * at once, and only we can send it again. 25 browsers on one channel peak
     * at 56-84 messages/s while joining and 82-103 with five typing at once
     * (30-95 refusals per run): a refused keystroke took the room 2.5-10.6 s
     * to repair, a refused presence up to half a lease (172 s until all
     * rosters of a join were complete). The rate is per second, so the next
     * try is 1-2 s away, further each time, five times at most. Order does not
     * matter to Yjs updates or awareness states. Anything else is logged, as
     * before (a dropped connection: the provider's reconnect sync covers it).
     */
    private _publish;
    private handleChunkedMessage;
    private handleMessage;
    private deliver;
    /**
     * Transport.onPeerConnect: fires when Ably's connection comes BACK
     * (never at the first connect) - see connect().
     */
    onPeerConnect(callback: (peerId: string) => void): () => void;
    /**
     * Transport.onPeerDisconnect: Ably presence 'leave' on the channel. Peer
     * ids are Ably clientIds, the same `from` onMessage passes.
     */
    onPeerDisconnect(callback: (peerId: string) => void): () => void;
    private log;
}
export {};
//# sourceMappingURL=index.d.ts.map