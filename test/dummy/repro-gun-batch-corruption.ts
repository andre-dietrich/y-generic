/**
 * Verification script: does GunTransport's internal send()-batching corrupt
 * multi-update flushes?
 *
 * Hypothesis (from reading src/providers/gun/index.ts):
 *   - GenericProvider._send() wraps EACH message individually as
 *     [4-byte CRC32][payload] before calling transport.send().
 *   - GunTransport.send() pushes each already-CRC-wrapped blob into
 *     `updateBatch` and, on flush, byte-CONCATENATES all queued blobs into
 *     one buffer (flushBatch(), gun/index.ts ~668-718) before writing it to
 *     Gun as a single record.
 *   - The receiving GenericProvider treats that whole concatenated buffer as
 *     ONE message: it reads the first 4 bytes as the CRC and checks them
 *     against a CRC computed over the REST of the buffer (which now contains
 *     multiple independent CRC-wrapped messages glued together).
 *   - That check must fail whenever 2+ updates land in the same flush, so
 *     the merged update is dropped as "corrupted" and never applied.
 *
 * This script exercises the REAL GunTransport class (not a reimplementation)
 * against a minimal in-memory fake of the Gun graph API, so any corruption
 * warnings come from the actual production code path.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/repro-gun-batch-corruption.js
 */

import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { GunTransport } from '../../src/providers/gun/index'

// ---------------------------------------------------------------------------
// Minimal fake Gun graph: just enough of the Gun chainable API for
// GunTransport (get/put/on/once/map) to run against, backed by a single
// shared in-memory node tree so multiple GunTransport instances (peers)
// observe each other's writes - like pointing two clients at the same relay.
// ---------------------------------------------------------------------------
class FakeGunNode {
  key: string
  parent: FakeGunNode | null
  value: any = undefined
  children: Map<string, FakeGunNode> = new Map()
  private onListeners: Array<(value: any, key: string) => void> = []
  private mapListeners: Array<(value: any, key: string) => void> = []

  constructor(parent: FakeGunNode | null, key: string) {
    this.parent = parent
    this.key = key
  }

  get(subkey: string): FakeGunNode {
    if (!this.children.has(subkey)) {
      this.children.set(subkey, new FakeGunNode(this, subkey))
    }
    return this.children.get(subkey)!
  }

  put(value: any): void {
    this.value = value
    for (const fn of this.onListeners) queueMicrotask(() => fn(value, this.key))
    if (this.parent) {
      for (const fn of this.parent.mapListeners) {
        queueMicrotask(() => fn(value, this.key))
      }
    }
  }

  on(cb: (value: any, key: string) => void): void {
    this.onListeners.push(cb)
    if (this.value !== undefined) queueMicrotask(() => cb(this.value, this.key))
  }

  once(cb: (value: any, key: string) => void): void {
    queueMicrotask(() => cb(this.value, this.key))
  }

  map(): { on(cb: (value: any, key: string) => void): void } {
    const self = this
    return {
      on(cb: (value: any, key: string) => void) {
        self.mapListeners.push(cb)
      },
    }
  }
}

// Shared graph root - real Gun instances pointed at the same relay would
// likewise all observe each other's writes.
const sharedRoot = new FakeGunNode(null, 'root')

class FakeGun {
  constructor(_config?: any) {
    return sharedRoot as any
  }
}

// ---------------------------------------------------------------------------
// Repro
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const room = `gun-batch-repro-${Math.random().toString(36).slice(2)}`

  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const transportA = new GunTransport({ gun: FakeGun as any, batchInterval: 50 })
  const transportB = new GunTransport({ gun: FakeGun as any, batchInterval: 50 })

  let corruptionWarnings = 0
  const originalWarn = console.warn
  console.warn = (...args: any[]) => {
    const msg = String(args[0] ?? '')
    if (msg.includes('Corrupted message rejected')) corruptionWarnings++
    originalWarn(...args)
  }

  const providerA = new GenericProvider(docA, transportA, { syncInterval: 0 })
  const providerB = new GenericProvider(docB, transportB, { syncInterval: 0 })

  await providerA.connect({ room })
  await providerB.connect({ room })
  await sleep(200) // let initial sync settle

  console.log('\n--- Sending 2 rapid edits (both within the 50ms batchInterval window) ---')
  const textA = docA.getText('content')
  docA.transact(() => textA.insert(0, 'Hello '))
  docA.transact(() => textA.insert(6, 'World'))

  await sleep(500) // well past the 50ms flush window

  console.warn = originalWarn

  const contentA = textA.toString()
  const contentB = docB.getText('content').toString()

  console.log(`\nDoc A content: "${contentA}"`)
  console.log(`Doc B content: "${contentB}"`)
  console.log(`Corruption warnings logged: ${corruptionWarnings}`)
  console.log(
    contentA === contentB
      ? '\n✅ Converged - no corruption observed for this run.'
      : '\n❌ DID NOT CONVERGE - batched update was lost/corrupted as hypothesized.',
  )

  providerA.destroy()
  providerB.destroy()
  process.exit(contentA === contentB && corruptionWarnings === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
