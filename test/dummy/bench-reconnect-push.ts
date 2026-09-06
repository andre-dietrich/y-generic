/**
 * Benchmark: what does a reconnect cost once the room already holds our
 * document? Peer A and B share a document of DOC_KB kilobytes and are
 * settled; A then disconnects and reconnects CYCLES times (A's provider
 * keeps its doc - a network blip, not a fresh tab). Every delivery in the
 * 2 s after each reconnect is counted per class and in bytes, plus the
 * number of transport sends (with CHUNK_KB the dummy splits large frames
 * like PubNub/Matrix/Nostr/Supabase do, so a full-state push is several
 * sends).
 *
 * Before round 5 item 5 every connect() pushed Y.encodeStateAsUpdate(doc)
 * - the whole document - to the room; afterwards only what we produced
 * since the room last confirmed our state (nothing, here), so the
 * reconnect is a beacon and an awareness update.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-reconnect-push.js
 *      DOC_KB=50 CYCLES=5 CHUNK_KB=16 override (CHUNK_KB=0: no chunking).
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, silenced } from './bench-user-scaling'
import { shadowHub, CLASSES } from './bench-idle-room'

const DOC_KB = Number(process.env.DOC_KB ?? 50)
const CYCLES = Number(process.env.CYCLES ?? 5)
const CHUNK_KB = Number(process.env.CHUNK_KB ?? 16)
const LATENCY = 20

async function main() {
  await silenced(async () => {
    const room = `bench-reconnect-push-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const shadow = shadowHub(hub)
    const make = () => {
      const doc = new Y.Doc()
      const transport = new DummyTransport({
        hub,
        latency: LATENCY,
        jitter: 0.1,
        chunkSizeLimit: CHUNK_KB > 0 ? CHUNK_KB * 1024 : undefined,
      })
      const provider = new GenericProvider(doc, transport, {
        batchUpdates: 0,
        verifyUpdates: true,
        syncInterval: 5000,
        disableBc: true,
      })
      provider.awareness.setLocalStateField('user', { name: 'x' })
      return { doc, provider }
    }
    const a = make()
    const b = make()
    await a.provider.connect({ room })
    await b.provider.connect({ room })
    // DOC_KB of prose in ~200-byte paragraphs (compressible like real text,
    // but this bench counts messages, not bytes after compression).
    const text = a.doc.getText('t')
    const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip. '
    while (text.length < DOC_KB * 1024) text.insert(text.length, para)
    await sleep(3000)
    const settled = b.doc.getText('t').length === text.length
    console.log(
      `doc ${(Y.encodeStateAsUpdate(a.doc).length / 1024).toFixed(1)} KB, chunk ${CHUNK_KB} KB, settled=${settled}, ${CYCLES} reconnects of A:\n`,
    )
    for (let i = 1; i <= CYCLES; i++) {
      a.provider.disconnect()
      await sleep(500)
      shadow.counting = true
      await a.provider.connect({ room })
      await sleep(2000)
      shadow.counting = false
      const parts = CLASSES.filter((k) => shadow.census[k].count > 0)
        .map((k) => `${k} ${shadow.census[k].count} (${(shadow.census[k].bytes / 1024).toFixed(1)} KB)`)
        .join(', ')
      console.log(
        `reconnect ${i}: deliveries=${shadow.deliveries} sends=${shadow.sends} synced=${a.provider.synced} | ${parts}`,
      )
      shadow.deliveries = 0
      shadow.sends = 0
      for (const k of CLASSES) shadow.census[k] = { count: 0, bytes: 0 }
    }
    a.provider.destroy()
    b.provider.destroy()
    hub.clear()
  })
  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
