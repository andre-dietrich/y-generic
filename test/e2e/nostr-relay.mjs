/**
 * A minimal Nostr relay for the E2E scripts (room-scenarios.mjs: trystero and nostr;
 * phone-session.mjs: nostr). Listens on all interfaces - the phone comes over the LAN.
 */
import { createRequire } from 'node:module'

const { WebSocketServer } = createRequire(import.meta.url)('ws')

/** NIP-01, as much of it as Trystero's nostr strategy uses: REQ {kinds, "#x"}, EVENT, CLOSE. */
export function nostrRelay(port) {
  let wss
  let seen // DIAG: what reached this relay since its (re)start
  return {
    start() {
      seen = { connections: 0, REQ: 0, EVENT: 0, CLOSE: 0 }
      wss = new WebSocketServer({ port })
      wss.on('connection', (ws) => {
        seen.connections++
        ws.subs = new Map()
        ws.on('message', (raw) => {
          let msg
          try {
            msg = JSON.parse(raw.toString())
          } catch {
            return
          }
          if (msg[0] in seen) seen[msg[0]]++
          if (msg[0] === 'REQ') {
            ws.subs.set(msg[1], msg[2] ?? {})
            ws.send(JSON.stringify(['EOSE', msg[1]]))
          } else if (msg[0] === 'CLOSE') {
            ws.subs.delete(msg[1])
          } else if (msg[0] === 'EVENT') {
            const ev = msg[1]
            ws.send(JSON.stringify(['OK', ev.id, true, '']))
            // Tag filters: "#x" (Trystero's topic), "#r" (NostrTransport's room) - any "#<tag>".
            const tagsOk = (f) =>
              Object.keys(f)
                .filter((k) => k[0] === '#')
                .every((k) => (ev.tags ?? []).some((t) => t[0] === k.slice(1) && f[k].includes(t[1])))
            for (const client of wss.clients) {
              if (client.readyState !== 1 || !client.subs) continue
              for (const [id, f] of client.subs) {
                const kindOk = !f.kinds || f.kinds.includes(ev.kind)
                const sinceOk = !f.since || ev.created_at >= f.since
                if (kindOk && sinceOk && tagsOk(f)) client.send(JSON.stringify(['EVENT', id, ev]))
              }
            }
          }
        })
      })
    },
    stop() {
      if (process.env.DIAG) console.log(`  [diag relay] since its start: ${JSON.stringify(seen)}`)
      for (const c of wss?.clients ?? []) c.terminate()
      wss?.close()
    },
  }
}
