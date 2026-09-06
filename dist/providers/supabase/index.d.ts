import type { Transport, ConnectionConfig } from '../../transport';
/**
 * Options passed to the SupabaseTransport constructor.
 *
 * The `createClient` function must be supplied by the caller so that the
 * transport works with the Supabase JS library loaded from any source
 * (CDN, ESM import, or otherwise) without bundling it as a hard dependency.
 *
 * @example
 * ```ts
 * // CDN usage — supabase global is exposed by the <script> tag
 * const transport = new SupabaseTransport({
 *   createClient: (globalThis as any).supabase.createClient,
 * })
 * ```
 */
export interface SupabaseTransportOptions {
    /** The `createClient` function from the Supabase JS library. */
    createClient: (url: string, key: string) => any;
}
/**
 * Supabase transport configuration
 */
export interface SupabaseConfig extends ConnectionConfig {
    /** Supabase project URL (required) e.g., 'https://xxxxx.supabase.co' */
    supabaseUrl: string;
    /** Supabase anon/public key (required) */
    supabaseKey: string;
    /** Room/channel name for collaboration (required) */
    room: string;
    /** Optional password to secure the room */
    password?: string;
    /** Enable debug logging */
    debug?: boolean;
}
/**
 * Supabase Transport for Yjs
 *
 * Provides real-time synchronization using Supabase Realtime channels.
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { SupabaseTransport } from 'y-generic/providers/supabase'
 *
 * const doc = new Y.Doc()
 * const transport = new SupabaseTransport({
 *   createClient: (globalThis as any).supabase.createClient,
 * })
 * const provider = new GenericProvider(doc, transport)
 *
 * await provider.connect({
 *   supabaseUrl: 'https://xxxxx.supabase.co',
 *   supabaseKey: 'your-anon-key',
 *   room: 'my-room',
 * })
 * ```
 */
export declare class SupabaseTransport implements Transport {
    private readonly options;
    private supabase;
    private channel;
    private config;
    private messageCallback?;
    private chunks;
    private _isConnected;
    private debug;
    private roomId;
    constructor(options: SupabaseTransportOptions);
    get isConnected(): boolean;
    connect(config: SupabaseConfig): Promise<void>;
    disconnect(): Promise<void>;
    send(data: Uint8Array): void;
    onMessage(callback: (data: Uint8Array) => void): () => void;
    private handleMessage;
    private uint8ArrayToBase64;
    private base64ToUint8Array;
    private log;
}
//# sourceMappingURL=index.d.ts.map