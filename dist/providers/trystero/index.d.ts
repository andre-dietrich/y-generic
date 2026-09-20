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
    leave: () => void | Promise<void>;
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
     * The strategy module's `getRelaySockets` (nostr, torrent, mqtt export
     * it next to `joinRoom`). Trystero re-opens a relay socket that closed
     * but does not subscribe again on it: the peer keeps its links and goes
     * deaf to every offer from then on. A phone in the background loses all
     * its relay sockets at once - measured with 25 real browsers
     * (test/e2e/room-scenarios.mjs): a page frozen for 20 s ("WebSocket
     * connection failed: Page entered Back-Forward Cache") never connected
     * to a peer that joined afterwards, and after a relay restart nobody
     * could join the room any more. With this option the transport watches
     * the sockets and, once NONE of those it joined with is left (a single
     * flapping relay out of several does not count), leaves and re-joins the
     * room on the re-opened sockets.
     * @example
     * ```typescript
     * import { joinRoom, getRelaySockets } from 'trystero/nostr'
     * new TrysteroTransport({ joinRoom, getRelaySockets, appId: 'my-app' })
     * ```
     */
    getRelaySockets?: () => Record<string, WebSocket>;
    /**
     * Without `getRelaySockets`: leave and re-join the room when the page did
     * not run for this long (ms), a few seconds after it woke up (Trystero's
     * first socket retry takes 3.3 s). 0 disables.
     * Not below ~30 s: a link survives that much silence, so a shorter sleep
     * has nothing to repair - and Firefox delays the timers of a HIDDEN tab
     * in a busy room by up to ~15-20 s, which the old default of 15000 took
     * for a sleep (see SimplePeerTransport's option of the same name).
     * @default 30000
     */
    resumeAfterMs?: number;
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
    private _peerConnectCallback?;
    private _peerDisconnectCallback?;
    private _joinedSockets;
    private _socketWatch?;
    private _stopResumeWatch?;
    private _rejoining;
    constructor(options: TrysteroTransportOptions);
    private log;
    get isConnected(): boolean;
    connect(config: ConnectionConfig): Promise<void>;
    /** Join the Trystero room and wire it up - at connect() and again at every rejoin(). */
    private joinTrysteroRoom;
    /**
     * Leave and join again: the only way to make Trystero subscribe again on
     * relay sockets it re-opened (see the getRelaySockets option). Our links
     * go with the room; GenericProvider resyncs each one as it comes back.
     */
    private rejoin;
    /** None of the relay sockets we joined with is left open, and a re-opened one is: re-join on it. */
    private checkRelaySockets;
    disconnect(): void;
    send(data: Uint8Array): Promise<void>;
    /**
     * A send to this peer rejected: close its RTCPeerConnection. Trystero
     * calls channel.send() without a net, the rejection was all that happened,
     * and the link stayed - one-way, for good. Chrome can leave an
     * RTCDataChannel object at readyState 'connecting' after its own 'open'
     * event (the answering side of a link, a busy machine, about once per
     * 50-peer join): it receives, and every send() throws. With 35 real
     * browsers one peer held nothing of another - no presence, no address -
     * although both counted the link (test/e2e/room-scenarios.mjs, DIAG=1; the
     * `oneway` scenario makes the condition on purpose;
     * test/providers/repro-trystero-oneway.ts). With the connection closed
     * Trystero reports the peer gone on both sides and dials it again at its
     * next announce. A peer that is leaving anyway loses nothing by it.
     */
    private dropUnsendable;
    /**
     * Transport.sendTo: deliver to one peer (Trystero's action send accepts
     * a target peer id). Used by GenericProvider for replies, acks and
     * presence responses.
     */
    sendTo(peerId: string, data: Uint8Array): Promise<void>;
    onMessage(callback: (data: Uint8Array, from?: string) => void): () => void;
    /**
     * Register callback for new peer data-channel connections. Lets
     * GenericProvider push our current doc/awareness state to a peer as
     * soon as their channel opens, instead of only at our own connect()
     * time (which fires before any mesh connection exists) or the next
     * periodic sync tick.
     */
    onPeerConnect(callback: (peerId: string) => void): () => void;
    /** Transport.onPeerDisconnect: Trystero's onPeerLeave, the same peer id. */
    onPeerDisconnect(callback: (peerId: string) => void): () => void;
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