// Regression test: when a regular peer is elected the new room coordinator
// (see handleCoordinatorDisconnect() -> transitionToCoordinator()), it tears
// down and recreates its own PeerJS Peer object, which drops every
// DataConnection it already had open. transitionToCoordinator() re-adds
// those peer ids to knownPeers/roomPeers but must also actively reconnect to
// them - otherwise the peers it used to talk to directly are silently
// stranded until *they* notice and reconnect on their own (which, in the
// classroom-sync bug this guards against, could take a long time or never
// happen at all - the whole room shows "connected" but stops syncing).
//
// Run: node test/peerjs/coordinator-reelection.test.mjs
// (requires `npm run build` to have produced dist/ from the current src/)

import assert from 'node:assert/strict'
import { PeerJSTransport } from '../../dist/providers/peerjs/index.js'

class FakeConn {
  constructor(peer) {
    this.peer = peer
    this._listeners = {}
  }
  on(event, cb) {
    ;(this._listeners[event] ??= []).push(cb)
  }
  emit(event, ...args) {
    for (const cb of this._listeners[event] ?? []) cb(...args)
  }
  send() {}
  close() {}
}

class FakePeer {
  constructor(id) {
    this.id = id
    this._listeners = {}
    this.connectedTo = []
    FakePeer.instances.push(this)
  }
  on(event, cb) {
    ;(this._listeners[event] ??= []).push(cb)
  }
  emit(event, ...args) {
    for (const cb of this._listeners[event] ?? []) cb(...args)
  }
  connect(remoteId) {
    this.connectedTo.push(remoteId)
    return new FakeConn(remoteId)
  }
  destroy() {
    this.destroyed = true
  }
}
FakePeer.instances = []

const transport = new PeerJSTransport({ peer: FakePeer })

// Simulate: already running as a regular peer, already connected to bob.
transport._room = 'room1'
transport.coordinatorPeerId = 'yjs-coordinator-room1'
transport.peerId = 'yjs-room1-alice'
transport.peer = new FakePeer(transport.peerId)
transport.peers.set('yjs-room1-bob', {
  conn: new FakeConn('yjs-room1-bob'),
  connected: true,
  peerId: 'yjs-room1-bob',
})
transport.knownPeers.add('yjs-room1-bob')

// This is what handleCoordinatorDisconnect() calls once this peer wins the
// election for the (now-dead) coordinator's role.
transport.transitionToCoordinator()

// The transport constructs a NEW Peer to claim the coordinator id - grab it
// and simulate PeerJS confirming the claim.
const coordinatorPeer = FakePeer.instances.at(-1)
assert.equal(coordinatorPeer.id, transport.coordinatorPeerId)
coordinatorPeer.emit('open', transport.coordinatorPeerId)

// Let the transitionToCoordinator() promise chain settle.
await Promise.resolve()
await Promise.resolve()
await Promise.resolve()

assert.ok(
  coordinatorPeer.connectedTo.includes('yjs-room1-bob'),
  'the newly-elected coordinator must reconnect to peers it was already ' +
    'talking to before the hand-off, not just remember their ids',
)

console.log('PASS: coordinator reconnects to previously known peers after election')

// setupPeerDiscovery() (invoked by the real transitionToCoordinator() code
// path above) opens a BroadcastChannel and a setInterval that would
// otherwise keep this one-off script's event loop alive forever.
process.exit(0)
