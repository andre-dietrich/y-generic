/**
 * Repro: what does TrysteroTransport do with a peer it cannot send to?
 *
 * Chrome can leave an RTCDataChannel object at readyState 'connecting' after
 * its own 'open' event (the answering side of a link, a busy machine, about
 * once per 50-peer join - see test/providers/repro-simple-peer-sleep.ts, part
 * 7, and docs/superpowers/specs/2026-09-20-join-presence-miss-note.md): the
 * channel receives, and every send() throws. Trystero calls channel.send()
 * without a net, so the promise of its action's send() rejects - and that is
 * all that happens. The link stays, one-way, for good; with 35 real browsers
 * one peer held NOTHING of another (no presence, no address) although both
 * counted the link, and test/e2e/room-scenarios.mjs' `oneway` scenario (the
 * condition made on purpose) never healed.
 *
 * A scripted Trystero room with three peers; the send to 'b' rejects the way
 * Trystero's does (a broadcast is a Promise.all over the peers: it rejects as a
 * whole and does not say for whom). Reported for send() and sendTo(): was the
 * RTCPeerConnection of 'b' closed (Trystero then drops the peer and dials it
 * again at its next announce), were the healthy peers left alone, and did 'a'
 * and 'c' get the frame exactly once? Exit code 1 if not.
 *
 * Part 3 - the page's network changed under it (the WiFi off, mobile data on):
 * every link runs over an address that is gone. Waiting for ICE to say so cost a
 * real phone 15 s on Chrome and 25-30 s on Firefox (phone-session.mjs
 * simple-peer, 2026-09-22; the same wait here). Does the transport leave the
 * room and join it again at once? And does it stay put for a `change` of the
 * connection that is no change of the network (Android fires one for every
 * effectiveType estimate)?
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/providers/repro-trystero-oneway.js
 */

import { TrysteroTransport } from '../../src/providers/trystero/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A page for watchNetworkChange (src/providers/resume.ts).
class FakeConnection extends EventTarget {
  type = 'wifi'
  effectiveType = '4g'
  switchTo(type: string): void {
    this.type = type
    this.dispatchEvent(new Event('change'))
  }
}
const page = new EventTarget()
const connection = new FakeConnection()
;(globalThis as any).window = page
;(globalThis as any).document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
Object.defineProperty(globalThis.navigator, 'connection', { value: connection, configurable: true, writable: true })

function scriptedRoom() {
  const closed: string[] = []
  const delivered: Record<string, number> = { a: 0, b: 0, c: 0 }
  const pcs: Record<string, { close: () => void }> = {}
  for (const id of ['a', 'b', 'c']) pcs[id] = { close: () => closed.push(id) }
  let join: (id: string) => void = () => {}
  const sendOne = async (id: string) => {
    if (id === 'b') throw new Error("Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'")
    delivered[id]++
  }
  const room = {
    getPeers: () => pcs,
    onPeerJoin: (cb: (id: string) => void) => (join = cb),
    onPeerLeave: () => {},
    leave: () => {},
    makeAction: () => [
      // Trystero: no target = everybody, and one rejection rejects the lot
      (_data: Uint8Array, target?: string | string[] | null) =>
        Promise.all((target == null ? Object.keys(pcs) : ([] as string[]).concat(target)).map(sendOne)).then(() => {}),
      () => {},
    ],
  }
  return { room, closed, delivered, joinAll: () => Object.keys(pcs).forEach((id) => join(id)) }
}

async function run(how: 'send' | 'sendTo') {
  const s = scriptedRoom()
  const transport = new TrysteroTransport({ joinRoom: (() => s.room) as any, appId: 'repro', resumeAfterMs: 0 } as any)
  await transport.connect({ room: 'repro-room' })
  s.joinAll()
  const warn = console.error
  console.error = () => {}
  try {
    if (how === 'send') await Promise.resolve(transport.send(new Uint8Array([1, 2, 3]))).catch(() => {})
    else await Promise.resolve(transport.sendTo('b', new Uint8Array([1, 2, 3]))).catch(() => {})
  } finally {
    console.error = warn
  }
  await sleep(20)
  transport.disconnect()
  const healthy = how === 'send' ? s.delivered.a === 1 && s.delivered.c === 1 : s.delivered.a === 0 && s.delivered.c === 0
  console.log(
    `  ${how.padEnd(7)} connection of the unsendable peer closed = ${s.closed.includes('b')}, others closed = ${s.closed.filter((id) => id !== 'b').length}, ` +
      `delivered a/c = ${s.delivered.a}/${s.delivered.c}`,
  )
  return s.closed.includes('b') && s.closed.length === 1 && healthy
}

/** Part 3: how often did the transport join a room, and did it leave the old one? */
async function networkChange(): Promise<boolean> {
  const rooms: { left: boolean }[] = []
  const joinRoom = () => {
    const s = scriptedRoom()
    const entry = { left: false }
    rooms.push(entry)
    return { ...s.room, leave: () => (entry.left = true) }
  }
  const transport = new TrysteroTransport({ joinRoom: joinRoom as any, appId: 'repro', resumeAfterMs: 0 } as any)
  await transport.connect({ room: 'repro-room' })
  connection.type = 'wifi'

  connection.effectiveType = '3g' // no change of the network: nothing must happen
  connection.dispatchEvent(new Event('change'))
  await sleep(1200)
  const afterNoise = rooms.length

  connection.switchTo('cellular')
  await sleep(1500)
  const ok = rooms.length === 2 && rooms[0].left && afterNoise === 1
  console.log(
    `  rooms joined: ${rooms.length} (want 2), the first one left = ${rooms[0]?.left} (want true), after an effectiveType change only: ${afterNoise} (want 1)`,
  )
  transport.disconnect()
  return ok
}

async function main() {
  console.log("a peer whose channel's send() throws, in a scripted Trystero room of three:")
  const ok = [await run('send'), await run('sendTo')]
  console.log('\nthe network changed under the page:')
  ok.push(await networkChange())
  process.exit(ok.every(Boolean) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
