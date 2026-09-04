/**
 * Benchmark: on a transport that chunks oversized payloads into multiple
 * wire messages (like PubNub's ~30KB limit or Ably's own size limit - see
 * src/providers/pubnub/index.ts and src/providers/ably/index.ts), does
 * compressing large sync payloads (compressionThresholdBytes) actually
 * reduce message count, not just byte count?
 *
 * DummyTransport has no size limit by default, so this scenario is
 * unbenchmarkable without the chunkSizeLimit simulation added to
 * DummyTransport/DummyHub specifically for this (see that option's doc
 * comment in src/providers/dummy/index.ts). This script configures a small
 * chunkSizeLimit (small enough that even a compressed large-doc push still
 * needs several chunks, so the comparison isn't just "1 chunk either way")
 * and measures total wire messages to converge two peers on a
 * medium/large synthetic document, with compressionThresholdBytes off vs on.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-chunking-compression.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'
import { sleep, instrumentHub, silenced } from './bench-user-scaling'

const CHUNK_SIZE_LIMIT = 4096 // bytes - small enough to be reachable by both docs below

const WORDS = (
  'the quick brown fox jumps over the lazy dog while collaborative ' +
  'editing tools synchronize document state across many connected peers ' +
  'using conflict free replicated data types for real time consistency'
).split(' ')

function word(i: number): string {
  return WORDS[i % WORDS.length]
}

/** Build a Y.Doc with real edit history (not a single giant insert), matching
 * test/dummy/bench-compression-ratio.ts's synthetic docs. */
function buildDoc(wordCount: number, withChurn: boolean): Y.Doc {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  for (let i = 0; i < wordCount; i++) {
    doc.transact(() => {
      text.insert(text.length, word(i) + ' ')
      if (withChurn && i % 10 === 0) {
        text.insert(text.length, 'xyz')
        text.delete(text.length - 3, 3)
      }
    })
  }
  return doc
}

async function runScenario(
  label: string,
  seedDoc: () => Y.Doc,
  compressionThresholdBytes: number | undefined,
): Promise<{ messages: number; bytes: number; converged: boolean }> {
  return silenced(async () => {
    const room = `bench-chunk-compress-${Math.random().toString(36).slice(2)}`
    const hub = new DummyHub()
    const stats = instrumentHub(hub)

    // Peer A already holds the large document. Peer B joins empty and must
    // pull A's full state via SyncStep1->SyncStep2 - the classic "large
    // full-state reply" scenario this item targets.
    const docA = seedDoc()
    const transportA = new DummyTransport({
      hub,
      latency: 10,
      chunkSizeLimit: CHUNK_SIZE_LIMIT,
    })
    const providerA = new GenericProvider(docA, transportA, {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: 0,
      compressionThresholdBytes,
    })
    providerA.awareness.setLocalStateField('user', { id: 'a' })
    await providerA.connect({ room })

    const pre = { messages: stats.messages, bytes: stats.bytes }

    const docB = new Y.Doc()
    const transportB = new DummyTransport({
      hub,
      latency: 10,
      chunkSizeLimit: CHUNK_SIZE_LIMIT,
    })
    const providerB = new GenericProvider(docB, transportB, {
      batchUpdates: 0,
      verifyUpdates: true,
      syncInterval: 0,
      compressionThresholdBytes,
    })
    providerB.awareness.setLocalStateField('user', { id: 'b' })
    await providerB.connect({ room })

    const timeoutAt = Date.now() + 15000
    while (Date.now() < timeoutAt && !providerB.synced) {
      await sleep(10)
    }
    await sleep(100) // settle window

    const converged = docA.getText('content').toString() === docB.getText('content').toString()
    const messages = stats.messages - pre.messages
    const bytes = stats.bytes - pre.bytes

    providerA.destroy()
    providerB.destroy()
    hub.clear()

    console.log(
      `${label.padEnd(42)} | compression=${String(!!compressionThresholdBytes).padEnd(5)} | messages=${String(messages).padStart(4)} | bytes=${String(bytes).padStart(7)} | converged=${converged}`,
    )

    return { messages, bytes, converged }
  })
}

async function main() {
  console.log(`chunkSizeLimit = ${CHUNK_SIZE_LIMIT} bytes\n`)

  const scenarios: Array<{ label: string; seedDoc: () => Y.Doc }> = [
    { label: 'medium doc (~500 words, clean)', seedDoc: () => buildDoc(500, false) },
    { label: 'large doc (~5000 words + churn)', seedDoc: () => buildDoc(5000, true) },
  ]

  for (const { label, seedDoc } of scenarios) {
    const before = await runScenario(label, seedDoc, undefined)
    const after = await runScenario(label, seedDoc, 2048)
    const reduction = before.messages > 0 ? (before.messages / Math.max(1, after.messages)) : 1
    console.log(
      `  -> message-count reduction: ${before.messages} -> ${after.messages} (${reduction.toFixed(2)}x), ` +
        `bytes: ${before.bytes} -> ${after.bytes}\n`,
    )
    if (!before.converged || !after.converged) {
      console.error('RESULT: at least one run failed to converge')
      process.exit(1)
    }
  }

  console.log('RESULT: all runs converged')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
