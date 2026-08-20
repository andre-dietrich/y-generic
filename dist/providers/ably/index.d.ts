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
    }) => void): Promise<void> | void;
    unsubscribe(callback?: (message: {
        data: any;
    }) => void): void;
    publish(eventName: string, data: any): Promise<void>;
    presence: AblyPresenceLike;
    detach(): Promise<void>;
}
interface AblyClientLike {
    connection: AblyConnectionLike;
    channels: {
        get(name: string): AblyChannelLike;
    };
    close(): void;
}
/** Constructor options for AblyTransport. */
export interface AblyTransportOptions {
    /**
     * The `Realtime` class from the Ably JS SDK.
     * @example import * as Ably from 'ably'; new AblyTransport({ Realtime: Ably.Realtime })
     */
    Realtime: new (options: Record<string, any>) => AblyClientLike;
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
    constructor(options: AblyTransportOptions);
    get isConnected(): boolean;
    connect(config: AblyConfig): Promise<void>;
    disconnect(): Promise<void>;
    send(data: Uint8Array): void;
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /** Get the clientIds of other peers currently present on the channel. */
    getPresence(): Promise<string[]>;
    private sendChunked;
    private handleChunkedMessage;
    private handleMessage;
    private deliver;
    private log;
}
export {};
//# sourceMappingURL=index.d.ts.map