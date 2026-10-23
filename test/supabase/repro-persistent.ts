/**
 * Repro: SupabaseTransport's `persistent` mode - when does it write the
 * document to its table, and what is in the table when a page goes?
 *
 * The real SupabaseTransport and GenericProvider on a scripted supabase-js
 * (createClient: broadcast channels shared by room name, one table that
 * counts its upserts). No project or key needed; the live test of the
 * presence path is test/supabase/live-presence.mjs.
 *
 *  1 idle      A and B in a room, A edits once and the room goes quiet: no
 *              write while nobody changes anything. A write was scheduled by
 *              every frame send() saw that was not presence - the periodic
 *              digest beacons too: one upsert of the whole document per
 *              beacon and peer, for as long as the room is open.
 *  2 remote    B never edits: its document changes only by A's updates, A's
 *              own write stores them - B writes nothing.
 *  3 unload    A edits and its page unloads 100 ms later, inside the
 *              debounce: the provider's `beforeunload` calls flush() - the
 *              table must have the edit (Nostr's and Ably's part 2/6).
 *  4 typing    an edit every 100 ms for 1.5 s, debounce 300 ms, max wait
 *              600 ms: a debounce every edit restarts never fires while
 *              somebody types (persistMaxWaitMs).
 * Exit code 1 unless all four hold.
 *
 * Run: npx tsc -p tsconfig.bench.json && node bench-dist/test/supabase/repro-persistent.js
 */
import * as Y from 'yjs'
import { GenericProvider } from '../../src/index'
import { SupabaseTransport } from '../../src/providers/supabase/index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The page: the provider registers its `beforeunload` where there is a window.
const unloadHandlers: Array<() => void> = []
;(globalThis as any).window = {
  addEventListener: (type: string, fn: () => void) => type === 'beforeunload' && unloadHandlers.push(fn),
  removeEventListener: () => {},
}

// ---- scripted supabase-js
const rooms = new Map<string, Set<FakeChannel>>()
const table = new Map<string, string>()
let upserts = 0
class FakeChannel {
  private handlers: Array<(msg: any) => void> = []
  constructor(private readonly name: string) {}
  on(type: string, _filter: unknown, cb: (msg: any) => void) {
    if (type === 'broadcast') this.handlers.push(cb)
    return this
  }
  subscribe(cb: (status: string) => void) {
    if (!rooms.has(this.name)) rooms.set(this.name, new Set())
    rooms.get(this.name)!.add(this)
    setTimeout(() => cb('SUBSCRIBED'), 1)
    return this
  }
  track() {
    return Promise.resolve('ok')
  }
  send(msg: any) {
    for (const ch of rooms.get(this.name) ?? []) {
      if (ch !== this) setTimeout(() => ch.handlers.forEach((h) => h(msg)), 1)
    }
  }
  unsubscribe() {
    rooms.get(this.name)?.delete(this)
    return Promise.resolve('ok')
  }
}
function createClient() {
  return {
    channel: (name: string) => new FakeChannel(name),
    from: () => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => ({ data: table.has(id) ? { content: table.get(id) } : null, error: null }),
        }),
      }),
      upsert: async (row: { id: string; content: string }) => {
        upserts++
        table.set(row.id, row.content)
        return { error: null }
      },
    }),
  }
}

/** What the table holds for `room`, as text. */
function stored(room: string): string {
  const content = table.get(room)
  if (!content) return ''
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Uint8Array.from(atob(content), (c) => c.charCodeAt(0)))
  return doc.getText('t').toString()
}

async function peer(room: string) {
  const doc = new Y.Doc()
  const transport = new SupabaseTransport({ createClient })
  const before = unloadHandlers.length
  const provider = new GenericProvider(doc, transport, { disableBc: true } as any)
  const onUnload = unloadHandlers[before]
  await provider.connect({
    supabaseUrl: 'https://x.supabase.co',
    supabaseKey: 'anon',
    room,
    persistent: true,
    doc,
    persistDebounceMs: 300,
    persistMaxWaitMs: 600,
  } as any)
  return { doc, transport, provider, onUnload, text: () => doc.getText('t').toString() }
}

async function main() {
  const results: boolean[] = []

  {
    const a = await peer('idle')
    const b = await peer('idle')
    a.doc.getText('t').insert(0, 'token-idle')
    await sleep(1500) // A's write is done
    const after = upserts
    await sleep(12000) // two beacon periods and more
    const idle = upserts - after
    const has = b.text() === 'token-idle' && stored('idle') === 'token-idle'
    results.push(idle === 0 && has)
    console.log(`1 idle: ${idle} write(s) in 12 s of a quiet room (want 0); B and the table have the edit ${has}`)
    a.provider.destroy()
    b.provider.destroy()
  }
  {
    const a = await peer('remote')
    const b = await peer('remote')
    const before = upserts
    let bWrites = 0
    const upsert = (b.transport as any).supabase.from
    ;(b.transport as any).supabase.from = () => {
      const q = upsert()
      const u = q.upsert
      q.upsert = (row: any) => (bWrites++, u(row))
      return q
    }
    a.doc.getText('t').insert(0, 'token-remote')
    await sleep(1500)
    results.push(bWrites === 0 && stored('remote') === 'token-remote')
    console.log(`2 remote: B wrote ${bWrites} time(s) for A's edit (want 0); writes in all ${upserts - before}; the table has it ${stored('remote') === 'token-remote'}`)
    a.provider.destroy()
    b.provider.destroy()
  }
  {
    const a = await peer('unload')
    await sleep(200)
    a.doc.getText('t').insert(0, 'token-unload')
    await sleep(100)
    a.onUnload?.()
    await sleep(50) // the upsert's own microtasks; no timer of the page runs after this
    const has = stored('unload') === 'token-unload'
    results.push(has)
    console.log(`3 unload: the table has the edit made 100 ms before the unload ${has} (want true)`)
    a.provider.destroy()
  }
  {
    const a = await peer('typing')
    const t0 = Date.now()
    for (let i = 0; Date.now() - t0 < 1500; i++) {
      a.doc.getText('t').insert(a.text().length, ` t${i}`)
      await sleep(100)
    }
    const during = stored('typing')
    results.push(during.includes('t0'))
    console.log(`4 typing: after 1.5 s of an edit every 100 ms the table holds ${during.length} chars (want the first edit, " t0")`)
    a.provider.destroy()
  }

  process.exit(results.every(Boolean) ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
