/**
 * What a backend implements for GenericProvider: moving binary frames.
 * The optional members are for transports with a per-peer concept (WebRTC).
 */
export interface Transport {
  /** Resolves once connected; `config` may carry backend-specific options. */
  connect(config: ConnectionConfig): Promise<void>

  /** Close connections; connect() may be called again. */
  disconnect(): void

  /** Send a frame to every peer. */
  send(data: Uint8Array): void | Promise<void>

  /** Send a frame to one peer. Without it, targeted pubsub is broadcast and filtered. */
  sendTo?(peerId: string, data: Uint8Array): void | Promise<void>

  /** Register a handler for incoming frames; returns an unsubscribe function. */
  onMessage(callback: (data: Uint8Array) => void): () => void

  /** Fires when a peer's channel opens; the provider pushes its full state to it. */
  onPeerConnect?(callback: (peerId: string) => void): () => void

  /** Fires when a peer's channel closes or errors. */
  onPeerDisconnect?(callback: (peerId: string) => void): () => void

  /**
   * Per-peer side channel for consumer handshakes. Never passed to the
   * provider or decoded as Yjs data; not chunked by the transport.
   */
  sendControl?(peerId: string, payload: Uint8Array): void

  /** Tear down one peer connection, e.g. after a failed handshake. */
  disconnectPeer?(peerId: string): void

  /** Register a handler for incoming control frames. */
  onControlFrame?(callback: (peerId: string, payload: Uint8Array) => void): () => void

  readonly isConnected: boolean

  /**
   * Default for the provider's `batchUpdates` (ms). Only for transports with
   * a costly round trip per message; low-latency transports leave it unset.
   */
  readonly preferredBatchMs?: number

  /**
   * True while every `send()` reaches every peer (relay server or complete
   * mesh): the provider then broadcasts only awareness changes made locally
   * instead of relaying received ones. May be a getter whose value changes.
   */
  readonly reachesAllPeers?: boolean
}

export interface ConnectionConfig {
  room: string
  [key: string]: any
}

export type ConnectionStatus =
  | { state: 'disconnected' }
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'error'; error: Error }
