/**
 * Generic Yjs Provider
 *
 * A minimal, backend-agnostic provider for Yjs that lets you implement
 * any transport mechanism (WebSocket, WebRTC, etc.)
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs'
 * import { GenericProvider, type Transport } from '@edryslabs/genericprovider'
 *
 * // Implement your transport
 * class MyTransport implements Transport {
 *   // ... implement 4 methods
 * }
 *
 * // Use the provider
 * const doc = new Y.Doc()
 * const transport = new MyTransport()
 * const provider = new GenericProvider(doc, transport)
 *
 * await provider.connect({ room: 'my-room' })
 *
 * // Use Yjs
 * doc.getText('content').insert(0, 'Hello')
 *
 * // Use pub/sub for real-time messages
 * provider.pubsub.publish('chat', { text: 'Hello!' })
 * provider.pubsub.subscribe('chat', (msg) => console.log(msg))
 * ```
 */
export { GenericProvider, PubSubChannel } from './index';
export type { Transport, ConnectionConfig, ConnectionStatus } from './transport';
//# sourceMappingURL=lib.d.ts.map