/**
 * Gate: does `batchUpdates` still send while someone edits WITHOUT a pause?
 *
 * Found by LiaScript's stress test (20 pages drawing on Nostr, whose
 * preferredBatchMs is 150): the batch was a debounce, every update restarted
 * its timer, and at more than ~7 updates/s nothing left a page until it
 * stopped - the lag of a value was the time left until the end of the drawing
 * (9.4 s at the start of a 10 s stroke). Now a batch leaves at most
 * `batchUpdates` ms after its FIRST update.
 *
 * A types one character every 50 ms for 2 s with batchUpdates 150. Gate: B
 * sees most of it while A is still typing, and no character takes much more
 * than one batch interval (plus the dummy hub's delivery) to reach B.
 * Debounce: B saw 0 after 1 s, max lag 2126 ms.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-batch-maxwait.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { DummyHub, DummyTransport } from '../../src/providers/dummy/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const BATCH_MS = 150
const CHARS = 40
const EVERY_MS = 50

async function main() {
  const hub = new DummyHub()
  const room = `bench-maxwait-${Math.random().toString(36).slice(2)}`
  const make = async () => {
    const provider = new GenericProvider(new Y.Doc(), new DummyTransport({ hub }), {
      disableBc: true,
      batchUpdates: BATCH_MS,
    })
    await provider.connect({ room })
    return provider
  }
  const a = await make()
  const b = await make()
  await sleep(1000)

  const typedAt: number[] = []
  const lags: number[] = []
  const bText = b.doc.getText('t')
  bText.observe(() => {
    while (lags.length < bText.length) lags.push(Date.now() - typedAt[lags.length])
  })
  let seenMidway = -1
  for (let i = 0; i < CHARS; i++) {
    typedAt.push(Date.now())
    a.doc.getText('t').insert(i, 'x')
    if (i === CHARS / 2) seenMidway = bText.length
    await sleep(EVERY_MS)
  }
  await sleep(500)
  const maxLag = Math.max(...lags)

  console.log(`A types ${CHARS} chars, one every ${EVERY_MS} ms, batchUpdates ${BATCH_MS}`)
  console.log(`  B saw ${seenMidway} of ${CHARS / 2} midway, ${bText.length} of ${CHARS} at the end, max lag ${maxLag} ms`)
  const failures: string[] = []
  if (seenMidway < CHARS / 4) failures.push('B saw almost nothing while A was typing')
  if (bText.length !== CHARS) failures.push('B is missing characters at the end')
  if (maxLag > BATCH_MS * 3) failures.push(`max lag ${maxLag} ms > ${BATCH_MS * 3} ms`)

  a.destroy()
  b.destroy()
  console.log(failures.length ? `FAIL: ${failures.join('; ')}` : 'PASS')
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
