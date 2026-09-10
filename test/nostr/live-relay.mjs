// Live test of the Nostr transport's persistent mode against a real relay
// (Docker/nostr/relay.js), across a simulated relay restart.
//
//   npm install --no-save nostr-tools ws   (once; neither is a default dependency)
//   npx tsc -p tsconfig.bench.json
//   node test/nostr/live-relay.mjs                       # starts its own relay on port 8766
//   NOSTR_RELAY=ws://host:port node test/nostr/live-relay.mjs   # or against a relay of your own
//
// Persistent mode's actual claim to check: a late joiner with NO live peer
// online converges from the relay's durably-stored snapshot alone, even
// after the relay process has restarted (the in-memory ephemeral event
// list is gone; only the persisted snapshots.json file survives). Also
// checks that a torn/mid-publish chunk batch (a crash between chunk
// writes) is never partially applied - each publish gets a fresh
// chunk-envelope id, and reassembly only completes once every chunk
// shares it (see src/providers/nostr/README.md's "Persistent mode").
//
// Everything here runs in one Node process: unlike test/gun/live-relay.mjs
// (which forks two processes because two Gun instances sharing a process
// see each other's writes directly, bypassing the relay), separate Y.Doc/
// NostrTransport instances have no such shared state, so a fork isn't
// needed to make sure the relay path is what's actually being measured.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'

const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const RELAY_PORT = Number(process.env.NOSTR_RELAY_PORT ?? 8766)
const relayUrl = process.env.NOSTR_RELAY ?? `ws://localhost:${RELAY_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let nostrPure, nostrPool
try {
  nostrPure = req('nostr-tools/pure')
  nostrPool = req('nostr-tools/pool')
} catch {
  console.error('run: npm install --no-save nostr-tools ws')
  process.exit(2)
}
const { finalizeEvent, getPublicKey, generateSecretKey } = nostrPure
const { SimplePool } = nostrPool

const Y = req('yjs')
const { GenericProvider } = req(join(root, 'bench-dist/src/index.js'))
const { NostrTransport } = req(join(root, 'bench-dist/src/providers/nostr/index.js'))

const snapshotFile = join(os.tmpdir(), `nostr-relay-test-${process.pid}.json`)
let relayChild = null

function startRelay() {
  relayChild = fork(join(root, 'Docker/nostr/relay.js'), [], {
    env: { ...process.env, PORT: String(RELAY_PORT), SNAPSHOT_FILE: snapshotFile },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  relayChild.stderr.on('data', (d) => process.stderr.write(String(d)))
}

async function waitReady() {
  for (let i = 0; i < 90; i++) {
    const ok = await new Promise((resolve) => {
      http
        .get(`http://localhost:${RELAY_PORT}/`, (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        })
        .on('error', () => resolve(false))
    })
    if (ok) return
    await sleep(200)
  }
  throw new Error('relay did not come up')
}

async function stopRelay() {
  if (!relayChild) return
  const child = relayChild
  relayChild = null
  child.kill()
  await new Promise((resolve) => child.once('exit', resolve))
}

const ownRelay = !process.env.NOSTR_RELAY
if (ownRelay) {
  startRelay()
  await waitReady()
}

const room = 'persist-test-' + Math.random().toString(36).slice(2, 8)
console.log('room', room, '| relay', relayUrl, ownRelay ? `(own, snapshot file ${snapshotFile})` : '')

// --- A: connect, write a doc large enough to force a multi-chunk snapshot, let it publish ---
const docA = new Y.Doc()
const transportA = new NostrTransport({ finalizeEvent, getPublicKey, SimplePool, secretKey: generateSecretKey() })
const providerA = new GenericProvider(docA, transportA, { disableBc: true })
await providerA.connect({ room, relays: [relayUrl], persistent: true, doc: docA, persistDebounceMs: 300 })
const textA = docA.getText('t')
textA.insert(0, 'x'.repeat(150000)) // base64 > 60,000 chars per chunk - forces >1 snapshot chunk
console.log('A wrote', textA.length, 'chars; waiting for the debounced multi-chunk snapshot publish ...')
await sleep(2000)
const expectedLength = textA.length
providerA.disconnect() // also disconnects transportA
console.log('A disconnected')

// --- Restart the relay: in-memory events gone, only the persisted snapshot file survives ---
if (ownRelay) {
  await stopRelay()
  await startRelay()
  await waitReady()
  console.log('relay restarted (simulating a container restart)')
}

// --- B: fresh connect, no live peer online - must converge from the persisted snapshot alone ---
const docB = new Y.Doc()
const transportB = new NostrTransport({ finalizeEvent, getPublicKey, SimplePool, secretKey: generateSecretKey() })
const providerB = new GenericProvider(docB, transportB, { disableBc: true })
await providerB.connect({ room, relays: [relayUrl], persistent: true, doc: docB, persistDebounceMs: 300 })
const textB = docB.getText('t')
let converged = false
for (let i = 0; i < 50; i++) {
  if (textB.length === expectedLength) {
    converged = true
    break
  }
  await sleep(200)
}
console.log(
  converged
    ? `PASS: B converged to ${textB.length} chars from the persisted snapshot alone (no live peer, relay restarted)`
    : `FAIL: B has ${textB.length} chars, expected ${expectedLength}`,
)
providerB.destroy()

// --- A torn (incomplete) chunk batch, published by hand, must never be applied ---
const tornRoom = 'torn-test-' + Math.random().toString(36).slice(2, 8)
const tornSecretKey = generateSecretKey()
const bigBase64 = Buffer.from('y'.repeat(200000)).toString('base64')
const maxChars = 60000
const total = Math.ceil(bigBase64.length / maxChars)
const batchId = 'torn-' + Math.random().toString(36).slice(2)
const pool2 = new SimplePool()
for (let i = 0; i < total - 1; i++) {
  // Deliberately stop one short of `total` - a crash mid-publish.
  const chunk = { chunked: true, id: batchId, index: i, total, data: bigBase64.slice(i * maxChars, (i + 1) * maxChars) }
  const event = finalizeEvent(
    { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', `${tornRoom}#${i}`]], content: JSON.stringify(chunk) },
    tornSecretKey,
  )
  await Promise.allSettled(pool2.publish([relayUrl], event))
}
pool2.close([relayUrl])

const docC = new Y.Doc()
const transportC = new NostrTransport({ finalizeEvent, getPublicKey, SimplePool, secretKey: generateSecretKey() })
const providerC = new GenericProvider(docC, transportC, { disableBc: true })
await providerC.connect({ room: tornRoom, relays: [relayUrl], persistent: true, doc: docC, persistDebounceMs: 300 })
await sleep(2000)
const tornLength = docC.getText('t').length
console.log(
  tornLength === 0
    ? 'PASS: a torn chunk batch was never applied (doc stays empty)'
    : `FAIL: doc has ${tornLength} chars from an incomplete batch`,
)
providerC.destroy()

if (ownRelay) await stopRelay()
process.exit(converged && tornLength === 0 ? 0 : 1)
