/**
 * WebRTC mesh transport over simple-peer; a y-webrtc-compatible signaling
 * server is used only for discovery.
 *
 * @example
 * ```typescript
 * import Peer from 'simple-peer'
 * const transport = new SimplePeerTransport({ peer: Peer, signaling: ['wss://signaling.example.com'] })
 * await new GenericProvider(doc, transport).connect({ room: 'my-room' })
 * ```
 */
import type { Transport, ConnectionConfig } from '../../transport';
export type SimplePeerConstructor = any;
export interface IceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}
export interface SimplePeerTransportOptions {
    /** The simple-peer constructor, passed in so it isn't bundled. */
    peer: SimplePeerConstructor;
    /** @default ['wss://signaling.yjs.dev'] */
    signaling?: string[];
    /** Merged into `peerOpts.config`. @default [{ urls: 'stun:stun.l.google.com:19302' }] */
    iceServers?: IceServer[];
    /** @default 20 + random(0-15) */
    maxConns?: number;
    /** Passed to simple-peer (https://github.com/feross/simple-peer#api). */
    peerOpts?: Record<string, any>;
    debug?: boolean;
    /**
     * Reconnect a signaling socket silent for this long (ms); a ping goes out
     * at half of it. 0 disables. @default 30000
     */
    signalingTimeout?: number;
    /**
     * How long (ms) the initiator waits for a channel to open before offering
     * again; doubles per consecutive failure up to 30s. @default 5000
     */
    connectTimeout?: number;
    /**
     * After this many timed-out attempts to a peer, the initiator retries with
     * `iceTransportPolicy: 'relay'` (TURN only), for stalls a direct retry
     * never clears. Needs a `turn:`/`turns:` server; `false` disables.
     * @default 1
     */
    relayFallbackAfter?: number | false;
    /**
     * Hold each peer's data frames until `trustPeer(peerId)`, e.g. after a
     * handshake over control frames. Held frames are delivered in order on
     * trust, discarded on disconnect; control frames are never held. Every new
     * connection starts untrusted.
     * @default false
     */
    requireTrust?: boolean;
}
export declare class SimplePeerTransport implements Transport {
    private options;
    private _connected;
    private _room;
    private _topic;
    private _callback?;
    private _peerConnectCallbacks;
    private _peerDisconnectCallbacks;
    private _controlCallbacks;
    private peerId;
    private peers;
    private signalingConns;
    private announcedPeers;
    private announceInterval?;
    private _reconnectAttempts;
    private _reconnectTimers;
    private _signalingLiveness;
    private _livenessInterval?;
    private _peerLastSeen;
    private _connectFailures;
    private _hasTurnServer;
    constructor(options: SimplePeerTransportOptions);
    /** Join the room on the signaling servers and start discovering peers. */
    connect(config: ConnectionConfig): Promise<void>;
    disconnect(): void;
    /** Send to every connected peer, chunking large messages. */
    send(data: Uint8Array): void;
    sendTo(peerId: string, data: Uint8Array): void;
    /** Queue a message for one peer (chunked if large) and pump the queue. */
    private sendToPeer;
    /**
     * Send queued frames until the channel buffer is full, then resume when it
     * drains (one wait per peer). Uses addEventListener because simple-peer
     * owns the channel's onbufferedamountlow property.
     */
    private pumpSendQueue;
    onMessage(callback: (data: Uint8Array) => void): () => void;
    onPeerConnect(callback: (peerId: string) => void): () => void;
    /** Fires only for peers whose channel had opened. */
    onPeerDisconnect(callback: (peerId: string) => void): () => void;
    onControlFrame(callback: (peerId: string, payload: Uint8Array) => void): () => void;
    disconnectPeer(peerId: string): void;
    /** Not chunked: the payload must fit one data channel message. */
    sendControl(peerId: string, payload: Uint8Array): void;
    /** Trust the current connection to a peer and deliver its held frames; false if none. */
    trustPeer(peerId: string): boolean;
    isPeerTrusted(peerId: string): boolean;
    /** Our peer id, as remote peers and signaling see it. */
    get localPeerId(): string;
    /**
     * DTLS fingerprints ("sha-256 AB:CD:…") from the local and remote SDP; a
     * field is undefined until that description is set.
     */
    getPeerFingerprints(peerId: string): {
        local?: string;
        remote?: string;
    } | undefined;
    /**
     * True while every peer recently seen in signaling is connected and the
     * room is below FULL_MESH_MAX_PEERS, i.e. a complete mesh.
     */
    get reachesAllPeers(): boolean;
    /**
     * Lifecycle flag (between connect() and disconnect()), not health: it stays
     * true with no signaling server. See `signalingHealth`.
     */
    get isConnected(): boolean;
    get connectedPeers(): number;
    /** Signaling sockets and peers, for diagnostics. */
    get signalingHealth(): {
        open: number;
        configured: number;
        reconnecting: number;
        peers: number;
        connectedPeers: number;
    };
    /**
     * Retry a dropped signaling server after log10(attempts + 1) * 1200ms,
     * capped at 30s (as lib0's WebsocketClient). One timer per URL.
     */
    private scheduleSignalingReconnect;
    /** Forget a signaling socket and schedule its reconnect. */
    private dropSignaling;
    /**
     * Ping quiet signaling sockets and drop those silent past
     * `signalingTimeout` (half-open: OPEN but delivering nothing). Healthy
     * sockets get our own re-announce echoed every 5s.
     */
    private checkSignalingLiveness;
    private connectSignaling;
    private handleSignalingMessage;
    private sendSignaling;
    private broadcastSignaling;
    private createPeerConnection;
    private handlePeerSignal;
    private pruneStalePeer;
    private forgetGonePeers;
    /** Hand a data frame to the provider, or hold it until the peer is trusted. */
    private deliver;
    private removePeer;
    private generatePeerId;
    private log;
}
//# sourceMappingURL=index.d.ts.map