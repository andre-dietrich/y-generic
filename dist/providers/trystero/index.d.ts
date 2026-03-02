/**
 * Trystero Transport Provider
 *
 * Serverless peer-to-peer transport using Trystero with multiple strategies.
 * Trystero uses decentralized infrastructure for peer discovery while keeping
 * all data transmission direct and end-to-end encrypted.
 *
 * Features:
 * - Zero server setup required
 * - Multiple strategies: Nostr, BitTorrent, MQTT, Supabase, Firebase, IPFS
 * - End-to-end encrypted P2P connections
 * - Automatic chunking and serialization
 * - Session encryption via AES-GCM
 * - Optional TURN server support
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { TrysteroTransport } from 'y-generic/providers/trystero'
 * import { joinRoom } from 'trystero/nostr' // or other strategy
 *
 * const doc = new Y.Doc()
 * const transport = new TrysteroTransport({
 *   joinRoom,
 *   appId: 'my-unique-app-id'
 * })
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 * ```
 */
import type { Transport, ConnectionConfig } from '../../transport';
/**
 * Trystero room instance type.
 */
export interface TrysteroRoom {
    leave: () => void;
    getPeers: () => Record<string, any>;
    onPeerJoin: (callback: (peerId: string) => void) => void;
    onPeerLeave: (callback: (peerId: string) => void) => void;
    makeAction: (actionId: string) => [
        (data: any, targetPeers?: string | string[] | null, metadata?: any, onProgress?: (percent: number, peerId: string) => void) => Promise<void>,
        (callback: (data: any, peerId: string, metadata?: any) => void) => void,
        (callback: (percent: number, peerId: string, metadata?: any) => void) => void
    ];
    ping: (peerId: string) => Promise<number>;
}
/**
 * Trystero joinRoom function type.
 */
export type JoinRoomFunction = (config: TrysteroConfig, roomId: string, onJoinError?: (details: any) => void) => TrysteroRoom;
/**
 * Trystero configuration object.
 */
export interface TrysteroConfig {
    appId: string;
    password?: string;
    relayUrls?: string[];
    relayRedundancy?: number;
    rtcConfig?: RTCConfiguration;
    turnConfig?: RTCIceServer[];
    rtcPolyfill?: any;
    supabaseKey?: string;
    firebaseApp?: any;
    rootPath?: string;
    manualRelayReconnection?: boolean;
}
/**
 * Configuration options for Trystero transport.
 */
export interface TrysteroTransportOptions {
    /**
     * The Trystero joinRoom function.
     * Import from specific strategy: trystero/nostr, trystero/torrent, etc.
     * @example
     * ```typescript
     * import { joinRoom } from 'trystero/nostr'
     * const transport = new TrysteroTransport({ joinRoom, appId: 'my-app' })
     * ```
     */
    joinRoom: JoinRoomFunction;
    /**
     * Unique app identifier (required).
     * For Supabase: use project URL
     * For Firebase: use databaseURL
     * @example 'my-app-unique-id-123'
     */
    appId: string;
    /**
     * Optional password for encrypting session descriptions.
     * Must match between all peers to connect.
     * @default undefined
     */
    password?: string;
    /**
     * Custom relay URLs for the strategy.
     * For BitTorrent: tracker URLs
     * For Nostr: relay URLs
     * For MQTT: broker URLs
     * @default undefined (uses strategy defaults)
     */
    relayUrls?: string[];
    /**
     * Number of relays to connect to simultaneously.
     * Ignored if relayUrls is provided.
     * @default undefined
     */
    relayRedundancy?: number;
    /**
     * Custom RTCConfiguration for peer connections.
     * @see https://developer.mozilla.org/en-US/docs/Web/API/RTCConfiguration
     */
    rtcConfig?: RTCConfiguration;
    /**
     * TURN server configuration for NAT traversal.
     * Each item should be an RTCIceServer config.
     * @example [{urls: 'turn:my-turn.server:3478', username: 'user', credential: 'pass'}]
     */
    turnConfig?: RTCIceServer[];
    /**
     * Custom RTCPeerConnection polyfill for server-side usage.
     * @example import { RTCPeerConnection } from 'node-datachannel/polyfill'
     */
    rtcPolyfill?: any;
    /**
     * (Supabase only) Supabase project's anon public API key.
     */
    supabaseKey?: string;
    /**
     * (Firebase only) Firebase app instance.
     */
    firebaseApp?: any;
    /**
     * (Firebase only) Custom root path for matchmaking data.
     * @default '__trystero__'
     */
    rootPath?: string;
    /**
     * (Nostr/BitTorrent only) Disable automatic relay reconnection.
     * @default false
     */
    manualRelayReconnection?: boolean;
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
}
/**
 * Trystero transport implementation.
 * Creates serverless P2P connections using Trystero library.
 */
export declare class TrysteroTransport implements Transport {
    private options;
    private _connected;
    private _room;
    private _callback?;
    private room;
    private sendUpdate;
    private peers;
    private onJoinErrorCallback?;
    constructor(options: TrysteroTransportOptions);
    private log;
    get isConnected(): boolean;
    connect(config: ConnectionConfig): Promise<void>;
    disconnect(): void;
    send(data: Uint8Array): Promise<void>;
    onMessage(callback: (data: Uint8Array) => void): () => void;
    /**
     * Set a callback for join errors (optional).
     */
    onJoinError(callback: (details: any) => void): void;
    /**
     * Get the set of connected peer IDs.
     */
    getPeers(): Set<string>;
    /**
     * Ping a peer and get round-trip time in ms.
     */
    ping(peerId: string): Promise<number>;
}
//# sourceMappingURL=index.d.ts.map