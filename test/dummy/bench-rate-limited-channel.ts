/**
 * Benchmark: a room on a backend that REFUSES what exceeds a message rate.
 *
 * Ably's free tier permits 50 messages/s on a channel and rejects the rest
 * ("Rate limit exceeded; request rejected (nonfatal); metric =
 * channel.maxRate", code 42913). test/e2e/room-scenarios.mjs ably, 25 real
 * browsers: the join peaks at 56-84 frames/s, five peers typing at once at
 * 82-103 - 30 to 95 refused sends per run, and the 60 typed characters were
 * everywhere after 2.5 s, 6.6 s, or not within 80 s (17 resync attempts on
 * every peer, healed by the next edit), depending on which messages were
 * refused.
 *
 * What makes this loss different from bench-packet-loss: a refused publish is
 * lost for EVERY receiver at once (nobody can serve it but the sender), and
 * it is correlated with load - the repair traffic of N peers that all saw
 * the same gap competes for the same 50 slots.
 *
 * Part 1 - the deadlock this found, in isolation: 4 peers, A and B type one
 * character each and the backend refuses both publishes, then both type a
 * second one that arrives. Everybody now holds a struct it cannot integrate
 * (Yjs pendingStructs) - A waits for B's first character, B for A's - and
 * the only copies of the missing ones are A's and B's own. A peer that is
 * incomplete used to answer no sync request at all ("let a complete peer
 * answer"): with nobody complete, nobody answered, for ever, `synced` true
 * everywhere. Reported: ms until all 4 documents hold 4 characters.
 *
 * Part 2 - N peers, settled. TYPISTS peers type KEYS characters, one every GAP_MS,
 * with a cursor update per keystroke. The hub refuses every broadcast beyond
 * LIMIT in a wall-clock second. Reported per run: ms after the last keystroke
 * until all N documents hold all characters, sends and refusals while typing
 * and while repairing. LIMIT=0 turns the limit off (the control).
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-rate-limited-channel.js
 *      N=25 TYPISTS=5 KEYS=12 GAP_MS=60 LIMIT=50 RUNS=5 WATCH_MS=90000 override.
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'
import { classifyOne, newCensus } from './bench-idle-room'

const N = Number(process.env.N ?? 25)
const TYPISTS = Number(process.env.TYPISTS ?? 5)
const KEYS = Number(process.env.KEYS ?? 12)
const GAP_MS = Number(process.env.GAP_MS ?? 60)
const LIMIT = Number(process.env.LIMIT ?? 50)
const RUNS = Number(process.env.RUNS ?? 5)
const WATCH_MS = Number(process.env.WATCH_MS ?? 90000)
const LATENCY = 40
const JITTER = 0.25

/** Refuse every broadcast beyond LIMIT per wall-clock second - for all receivers, as the service does. */
function rateLimit(hub: DummyHub) {
  const state = { sends: 0, refused: 0, second: 0, inSecond: 0, peak: 0 }
  const original = hub.broadcast.bind(hub)
  ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (room, data, sender, options) => {
    const second = Math.floor(Date.now() / 1000)
    if (second !== state.second) {
      state.second = second
      state.inSecond = 0
    }
    state.inSecond++
    state.sends++
    state.peak = Math.max(state.peak, state.inSecond)
    if (LIMIT > 0 && state.inSecond > LIMIT) {
      state.refused++
      return
    }
    return original(room, data, sender, options)
  }
  return state
}

async function deadlock(): Promise<void> {
  let result = -1
  await silenced(async () => {
    const room = `bench-deadlock-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    // Refuse the next document update of each sender in `refuse` - for every receiver.
    const refuse = new Set<DummyTransport>()
    const original = hub.broadcast.bind(hub)
    ;(hub as unknown as { broadcast: typeof hub.broadcast }).broadcast = (rm, data, sender, options) => {
      if (refuse.has(sender) && data.length >= 5) {
        const census = newCensus()
        classifyOne(data.subarray(4), census, 1)
        if (census.update.count > 0) {
          refuse.delete(sender)
          return
        }
      }
      return original(rm, data, sender, options)
    }
    const docs: Y.Doc[] = []
    const transports: DummyTransport[] = []
    const providers: GenericProvider[] = []
    for (let i = 0; i < 4; i++) {
      const doc = new Y.Doc()
      const transport = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
      const provider = new GenericProvider(doc, transport, { disableBc: true, awarenessTimeoutMs: 300000 })
      docs.push(doc)
      transports.push(transport)
      providers.push(provider)
      await provider.connect({ room })
      provider.awareness.setLocalState({ user: { name: 'u' + i } })
    }
    await sleep(3000)
    refuse.add(transports[0]).add(transports[1])
    for (const round of [0, 1]) {
      for (const t of [0, 1]) docs[t].getText('t').insert(round, String.fromCharCode(65 + t))
      await sleep(300)
    }
    const t0 = Date.now()
    while (Date.now() - t0 < 30000) {
      if (docs.every((d) => d.getText('t').length === 4)) {
        result = Date.now() - t0
        break
      }
      await sleep(25)
    }
    for (const p of providers) p.destroy()
    hub.clear()
  })
  console.log(`part 1, two typists, one refused publish each: all 4 characters in all 4 documents after ${result < 0 ? 'NEVER (30 s watched)' : result + ' ms'}`)
}

async function run(): Promise<number> {
  let result = -1
  let line = ''
  await silenced(async () => {
    const room = `bench-rate-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const wire = rateLimit(hub)
    const docs: Y.Doc[] = []
    const providers: GenericProvider[] = []
    for (let i = 0; i < N; i++) {
      const doc = new Y.Doc()
      // As the Ably playground: provider defaults, and the 5 min presence
      // lease of a transport that reports departures.
      const transport = new DummyTransport({ hub, latency: LATENCY, jitter: JITTER })
      const provider = new GenericProvider(doc, transport, { disableBc: true, awarenessTimeoutMs: 300000 })
      docs.push(doc)
      providers.push(provider)
      await provider.connect({ room })
      provider.awareness.setLocalState({ user: { name: 'u' + i, color: '#abc' }, cursor: null })
      await sleep(200) // the e2e harness opens a page every 200 ms
    }
    const join = { sends: wire.sends, refused: wire.refused, peak: wire.peak }
    await sleep(10000)

    wire.sends = wire.refused = wire.peak = 0
    for (let k = 0; k < KEYS; k++) {
      for (let t = 0; t < TYPISTS; t++) {
        const text = docs[t].getText('t')
        text.insert(text.length, String.fromCharCode(65 + t))
        providers[t].awareness.setLocalStateField('cursor', { anchor: text.length, head: text.length })
      }
      await sleep(GAP_MS)
    }
    const typing = { sends: wire.sends, refused: wire.refused, peak: wire.peak }

    const t0 = Date.now()
    const want = KEYS * TYPISTS
    while (Date.now() - t0 < WATCH_MS) {
      if (docs.every((d) => d.getText('t').length === want)) {
        result = Date.now() - t0
        break
      }
      await sleep(50)
    }
    const behind = docs.filter((d) => d.getText('t').length !== want).length
    line =
      `join: ${join.sends} sends, ${join.refused} refused, peak ${join.peak}/s | ` +
      `typing: ${typing.sends} sends, ${typing.refused} refused, peak ${typing.peak}/s | ` +
      `all ${want} characters everywhere: ${result < 0 ? `NEVER (${behind} of ${N} behind after ${WATCH_MS / 1000} s)` : result + ' ms'}, ` +
      `${wire.sends - typing.sends} sends and ${wire.refused - typing.refused} refused while repairing`
    for (const p of providers) p.destroy()
    hub.clear()
  })
  console.log(line)
  return result
}

async function main() {
  console.log(`rate-limited channel: N=${N} typists=${TYPISTS} keys=${KEYS} gap=${GAP_MS}ms limit=${LIMIT || 'off'}/s latency=${LATENCY}ms±${JITTER * 100}%`)
  await deadlock()
  const results: number[] = []
  for (let r = 0; r < RUNS; r++) results.push(await run())
  const never = results.filter((ms) => ms < 0).length
  const ok = results.filter((ms) => ms >= 0).sort((a, b) => a - b)
  console.log(`=> converged in ${ok.length} of ${RUNS} runs${ok.length ? `, ${ok[0]}-${ok[ok.length - 1]} ms` : ''}${never ? `, NEVER in ${never}` : ''}`)
  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
