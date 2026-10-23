/**
 * Repro: ConferenceTransport connected a second time - does the first frame
 * of the new session reach the room?
 *
 * connect() resolves at the first link or after `firstLinkTimeoutMs`; the core
 * sends its JOIN beacon (with our presence) at that moment. With no link open
 * yet the wrapper keeps that frame and sends it over the first link (_onHello,
 * round 11: 100 browsers, a joiner missing from 3-8 rosters for 170 s). But
 * the "no link yet" flag (`_hadLink`) was only ever set: after a disconnect()
 * and a connect() of the same instance - a room switch - the JOIN of the new
 * session went nowhere.
 *
 * The real ConferenceTransport over a scripted mesh transport.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-conference-reconnect.js
 * Exit code 1 unless the new session's first frame goes over its first link.
 */
import { ConferenceTransport } from '../../src/providers/conference/index'

class ScriptedMesh {
  connected = false
  sent: Array<[string, Uint8Array]> = []
  msg?: (data: Uint8Array, from?: string) => void
  up?: (id: string) => void
  down?: (id: string) => void
  get isConnected() {
    return this.connected
  }
  async connect() {
    this.connected = true
  }
  disconnect() {
    this.connected = false
  }
  send() {}
  sendTo(id: string, data: Uint8Array) {
    this.sent.push([id, data])
  }
  onMessage(cb: (data: Uint8Array, from?: string) => void) {
    this.msg = cb
    return () => (this.msg = undefined)
  }
  onPeerConnect(cb: (id: string) => void) {
    this.up = cb
    return () => (this.up = undefined)
  }
  onPeerDisconnect(cb: (id: string) => void) {
    this.down = cb
    return () => (this.down = undefined)
  }
  /** A link opens and the peer behind it says HELLO (F_HELLO, its 6-byte id, flags, version). */
  link(linkId: string, peer: number) {
    this.up!(linkId)
    this.msg!(new Uint8Array([0, peer, peer, peer, peer, peer, peer, 0, 1]), linkId)
  }
}

const payloadOver = (mesh: ScriptedMesh, linkId: string, marker: number) =>
  mesh.sent.some(([id, d]) => id === linkId && d[0] === 1 && d[d.length - 1] === marker) // F_GOSSIP ... payload

async function main() {
  const mesh = new ScriptedMesh()
  const t = new ConferenceTransport(mesh as any, { firstLinkTimeoutMs: 50 })

  // Session 1: no link when connect() resolves, the JOIN waits for the first link.
  await t.connect({ room: 'r' })
  t.send(new Uint8Array([7, 7, 0xa1]))
  mesh.link('L1', 0x11)
  const first = payloadOver(mesh, 'L1', 0xa1)

  // Session 2 on the same instance: the same situation.
  t.disconnect()
  await t.connect({ room: 'r2' })
  t.send(new Uint8Array([7, 7, 0xa2]))
  mesh.link('L2', 0x22)
  const second = payloadOver(mesh, 'L2', 0xa2)

  console.log(`session 1: the frame sent before the first link went over it ${first} (want true)`)
  console.log(`session 2, same instance after disconnect(): ${second} (want true)`)
  t.disconnect()
  process.exit(first && second ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
