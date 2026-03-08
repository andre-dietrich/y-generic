import type { Transport, ConnectionConfig } from '../../transport';
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
    /** Enable persistent mode (stores state in database) (default: false) */
    persistent?: boolean;
    /** Database table name for persistent storage (default: 'yjs_documents') */
    tableName?: string;
    /** Database column name for document data (default: 'content') */
    columnName?: string;
    /** Database column name for document ID (default: 'id') */
    idColumnName?: string;
    /** Debounce delay for database updates in ms (default: 2000) */
    persistDebounceMs?: number;
    /** Enable debug logging */
    debug?: boolean;
}
/**
 * Supabase Transport for Yjs
 *
 * Provides real-time synchronization using Supabase Realtime channels.
 *
 * Features:
 * - Ephemeral mode: Peer-to-peer sync via Supabase Realtime (no database)
 * - Persistent mode: Database-backed sync with automatic persistence
 * - Optional password protection
 * - Room-based collaboration
 * - Debounced database updates
 * - Automatic retry on database errors
 *
 * @example
 * ```ts
 * // Ephemeral mode (states lost when all peers disconnect)
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { SupabaseTransport } from 'y-generic/providers/supabase'
 *
 * const doc = new Y.Doc()
 * const transport = new SupabaseTransport()
 *
 * await provider.connect({
 *   supabaseUrl: 'https://xxxxx.supabase.co',
 *   supabaseKey: 'your-anon-key',
 *   room: 'my-room',
 *   persistent: false
 * })
 *
 * // Persistent mode (states stored in database)
 * await provider.connect({
 *   supabaseUrl: 'https://xxxxx.supabase.co',
 *   supabaseKey: 'your-anon-key',
 *   room: 'my-room',
 *   persistent: true,
 *   password: 'optional-password'
 * })
 * ```
 */
export declare class SupabaseTransport implements Transport {
    private supabase;
    private channel;
    private config;
    private messageCallback?;
    private _isConnected;
    private debug;
    private persistentMode;
    private tableName;
    private columnName;
    private idColumnName;
    private roomId;
    private persistDebounceMs;
    private persistTimer?;
    private pendingUpdate?;
    private updateQueue;
    private isWritingToDb;
    get isConnected(): boolean;
    connect(config: SupabaseConfig): Promise<void>;
    disconnect(): Promise<void>;
    send(data: Uint8Array): void;
    onMessage(callback: (data: Uint8Array) => void): () => void;
    private handleMessage;
    private loadFromDatabase;
    private queuePersist;
    private saveToDatabase;
    private uint8ArrayToBase64;
    private base64ToUint8Array;
    private log;
}
//# sourceMappingURL=index.d.ts.map