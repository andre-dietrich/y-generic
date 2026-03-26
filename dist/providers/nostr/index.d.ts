/**
 * Nostr Transport Provider
 *
 * Serverless, decentralised synchronisation using the Nostr protocol.
 * Binary Yjs updates are base64-encoded and published as signed Nostr events
 * to one or more relays. Every connected client subscribes to the same room tag,
 * so updates fan out through all configured relays automatically.
 *
 * Features:
 * - No server setup required (uses public relays or your own)
 * - Multi-relay fan-out for redundancy
 * - Ephemeral or persistent identity (bring-your-own key pair)
 * - Optional password to obfuscate the room tag (SHA-256)
 * - Configurable history window to catch up on missed updates
 * - Automatic deduplication (events from self are ignored)
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { NostrTransport } from 'y-generic/providers/nostr'
 * import { finalizeEvent, getPublicKey, SimplePool } from 'nostr-tools'
 *
 * const doc = new Y.Doc()
 * const transport = new NostrTransport({ finalizeEvent, getPublicKey, SimplePool })
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   room: 'my-doc',
 *   relays: ['wss://relay.damus.io', 'wss://nos.lol'],
 * })
 * ```
 *
 * @example
 * ```typescript
 * // With a persistent identity and password-protected room
 * import { generateSecretKey } from 'nostr-tools/pure'
 *
 * const secretKey = generateSecretKey()  // persist this to keep identity
 * const transport = new NostrTransport({ finalizeEvent, getPublicKey, SimplePool, secretKey })
 *
 * await provider.connect({
 *   room: 'my-doc',
 *   password: 'secret',
 *   relays: ['wss://relay.damus.io'],
 *   historyWindowSecs: 3600,  // fetch last hour of updates on connect
 * })
 * ```
 */
import type { Transport, ConnectionConfig } from '../../transport';
/** Shape of a signed Nostr event returned by finalizeEvent. */
interface NostrEvent {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
}
/** Shape of an unsigned event template passed to finalizeEvent. */
interface EventTemplate {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
}
/**
 * Constructor options for NostrTransport.
 *
 * The three nostr-tools functions are injected so the transport doesn't bundle
 * them as a hard dependency. Import them from `nostr-tools` or `nostr-tools/pure`.
 */
export interface NostrTransportOptions {
    /**
     * `finalizeEvent` from nostr-tools.
     * Signs an event template with the given secret key.
     * @example import { finalizeEvent } from 'nostr-tools/pure'
     */
    finalizeEvent: (template: EventTemplate, secretKey: Uint8Array) => NostrEvent;
    /**
     * `getPublicKey` from nostr-tools.
     * Derives the hex public key from a secret key.
     * @example import { getPublicKey } from 'nostr-tools/pure'
     */
    getPublicKey: (secretKey: Uint8Array) => string;
    /**
     * `SimplePool` class from nostr-tools.
     * Manages WebSocket connections to multiple Nostr relays.
     * @example import { SimplePool } from 'nostr-tools'
     */
    SimplePool: new () => {
        subscribeMany(relays: string[], filters: object[], handlers: {
            onevent?: (event: NostrEvent) => void;
            oneose?: () => void;
        }): {
            close(): void;
        };
        publish(relays: string[], event: NostrEvent): Promise<string>[];
        close(relays: string[]): void;
    };
    /**
     * Secret key for signing events (32-byte Uint8Array).
     * If omitted a random ephemeral key is generated on first connect — the
     * identity changes on page reload, which is fine for anonymous editing.
     * Persist this value (e.g. in localStorage) to maintain a stable identity.
     * @example import { generateSecretKey } from 'nostr-tools/pure'
     */
    secretKey?: Uint8Array;
    /**
     * Custom Nostr event kind to use for Yjs update events.
     * @default 27370
     */
    eventKind?: number;
    /** Enable debug logging. @default false */
    debug?: boolean;
}
/**
 * Connection configuration for NostrTransport.
 */
export interface NostrConfig extends ConnectionConfig {
    /** Room/document identifier. Mapped to the `r` tag on events. */
    room: string;
    /**
     * Nostr relay WebSocket URLs to connect to.
     * @default ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']
     */
    relays?: string[];
    /**
     * Optional password. When provided, a SHA-256 hash of the password is
     * appended to the room tag so the channel is only discoverable by peers
     * that know the password. This is NOT encryption — use NIP-44 for that.
     */
    password?: string;
    /**
     * How many seconds of stored relay events to fetch on connect.
     * Set to 0 to receive only real-time events (no catch-up).
     * Increase for longer-lived documents that should survive peer restarts.
     * @default 86400 (24 hours)
     */
    historyWindowSecs?: number;
    /** Enable debug logging (overrides constructor option). */
    debug?: boolean;
}
/**
 * Nostr transport for y-generic.
 *
 * Publishes Yjs binary updates as base64-encoded Nostr events and subscribes
 * to matching events from peers. Works in both browser and Node.js environments.
 */
export declare class NostrTransport implements Transport {
    private readonly opts;
    private _connected;
    private _callback?;
    private _buffer;
    private pool;
    private sub;
    private relays;
    private secretKey;
    private pubkey;
    private roomTag;
    private readonly eventKind;
    constructor(opts: NostrTransportOptions);
    get isConnected(): boolean;
    connect(config: NostrConfig): Promise<void>;
    disconnect(): void;
    send(data: Uint8Array): Promise<void>;
    onMessage(callback: (data: Uint8Array) => void): () => void;
    private _deliver;
}
export {};
//# sourceMappingURL=index.d.ts.map