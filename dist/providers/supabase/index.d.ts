import * as Y from 'yjs';
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
    /**
     * Persist the document in a table so a room survives its last peer
     * leaving: the full state is loaded on connect and written (debounced)
     * after every document update. Needs a table with columns `id TEXT
     * PRIMARY KEY`, `content TEXT` (see the README for the SQL and the RLS
     * policy the anon key needs). Not usable together with
     * `compressionThresholdBytes` (this transport reads the frame's type
     * byte at a fixed offset). @default false
     */
    persistent?: boolean;
    /** The Y.Doc to persist. Required when persistent is true. */
    doc?: Y.Doc;
    /** Table name. @default 'yjs_documents' */
    tableName?: string;
    /** Debounce delay in ms before a database write. @default 2000 */
    persistDebounceMs?: number;
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
    private persistentMode;
    private doc;
    private tableName;
    private persistDebounceMs;
    private persistTimer?;
    private isWritingToDb;
    private savePending;
    private pendingLoad;
    constructor(options: SupabaseTransportOptions);
    get isConnected(): boolean;
    connect(config: SupabaseConfig): Promise<void>;
    disconnect(): Promise<void>;
    send(data: Uint8Array): void;
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Deliver the stored state as a MESSAGE_SYNC_PUSH frame - the provider
     * applies it like a peer's full-state push: no hash check, no `synced`
     * flip (a stored copy says nothing about who is online).
     */
    private loadFromDatabase;
    private queuePersist;
    /** Upsert the full current state; a write that overlaps a change re-runs once. */
    private saveToDatabase;
    private handleMessage;
    private uint8ArrayToBase64;
    private base64ToUint8Array;
    private log;
}
//# sourceMappingURL=index.d.ts.map