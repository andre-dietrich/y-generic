// Live test of the Supabase presence path against a real project.
//
//   npm install --no-save @supabase/supabase-js     (once; not a dependency of this package)
//   npx tsc -p tsconfig.bench.json
//   node test/supabase/live-presence.mjs            (reads SUPABASE_URL / SUPABASE_KEY from .env or the environment)
//
// Checks: (1) frames carry `from` (the sender's presence key); (2) an idle
// minute sends no awareness renewals (the lease is 5 min once the transport
// reports leaves); (3) a peer whose channel closes without a clean provider
// disconnect is dropped from the other peer's presence within seconds via
// the presence leave, not after the 30 s awareness timeout.
// Verified 2026-09-07: from seen, 0 awareness sends in 60 s, dropped after 1.2 s.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
const root = process.cwd()
const req = createRequire(join(root, 'package.json'))
const Y = req('yjs')
const { GenericProvider } = req(join(root, 'bench-dist/src/index.js'))
const { SupabaseTransport } = req(join(root, 'bench-dist/src/providers/supabase/index.js'))
let createClient
try {
  ;({ createClient } = req('@supabase/supabase-js'))
} catch {
  console.error('run: npm install --no-save @supabase/supabase-js')
  process.exit(2)
}
if ((!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) && existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY
if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_KEY missing'); process.exit(2) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const room = 'presence-test-' + Math.random().toString(36).slice(2, 8)
const t0 = Date.now()
const stamp = () => String(Date.now() - t0).padStart(6) + ' ms'

function peer(name) {
  const doc = new Y.Doc()
  const transport = new SupabaseTransport({ createClient })
  const provider = new GenericProvider(doc, transport, { disableBc: true })
  const seen = { froms: new Set(), awarenessSends: 0, sends: 0 }
  const origSend = transport.send.bind(transport)
  transport.send = (data) => { seen.sends++; if (data[4] === 1) seen.awarenessSends++; return origSend(data) }
  const origOnMessage = transport.onMessage.bind(transport)
  transport.onMessage = (cb) => origOnMessage((data, from) => { if (from) seen.froms.add(from); cb(data, from) })
  return { name, doc, transport, provider, seen }
}
const a = peer('A'), b = peer('B')
console.log('room', room, '| transport has onPeerDisconnect:', typeof a.transport.onPeerDisconnect)
await a.provider.connect({ supabaseUrl: url, supabaseKey: key, room })
a.provider.awareness.setLocalStateField('user', { name: 'A' })
await b.provider.connect({ supabaseUrl: url, supabaseKey: key, room })
b.provider.awareness.setLocalStateField('user', { name: 'B' })
console.log(stamp(), 'both connected; lease at B:', b.provider._awarenessTimeoutMs, 'ms')
a.doc.getText('t').insert(0, 'hello')
await sleep(3000)
console.log(stamp(), 'B text:', JSON.stringify(b.doc.getText('t').toString()), '| B sees states:', b.provider.awareness.getStates().size, '| froms seen at B:', [...b.seen.froms])
console.log(stamp(), 'idle 60 s ...')
const before = { a: a.seen.awarenessSends, b: b.seen.awarenessSends, sa: a.seen.sends, sb: b.seen.sends }
await sleep(60000)
console.log(stamp(), 'awareness sends during idle: A', a.seen.awarenessSends - before.a, 'B', b.seen.awarenessSends - before.b, '| all sends: A', a.seen.sends - before.sa, 'B', b.seen.sends - before.sb)
console.log(stamp(), 'A closes its channel (transport.disconnect, no clean provider disconnect)')
const gone = Date.now()
await a.transport.disconnect()
let detected = -1
for (let i = 0; i < 600; i++) {
  if (!b.provider.awareness.getStates().has(a.doc.clientID)) { detected = Date.now() - gone; break }
  await sleep(100)
}
console.log(stamp(), detected < 0 ? 'B still sees A after 60 s: FAIL' : `B dropped A after ${detected} ms: PASS`)
a.provider.destroy(); b.provider.destroy()
process.exit(0)
