// Minimal Nostr relay for the classroom image (liascript/nostr-relay): just
// enough NIP-01 for src/providers/nostr's NostrTransport - EVENT, REQ
// (kinds / #-tag / since / until filtering), CLOSE, EOSE, plus NIP-01's
// replaceable (kind 10000-19999) and addressable (kind 30000-39999)
// replace-on-write semantics, persisted to disk - see NostrTransport's
// `persistent` mode, which publishes Yjs snapshots as addressable events so
// a late joiner can catch up from this relay even after it has restarted.
// The high-volume live-update kind (27370, NIP-01's ephemeral range) is
// NOT persisted - only the bounded, replaced-on-write set is, so storage
// stays small regardless of how long a room has been edited.
// ponytail: no signature verification; add nostr-tools/pure's verifyEvent
// if this relay is ever exposed beyond a trusted classroom LAN.
const fs = require("fs")
const path = require("path")
const { WebSocketServer } = require("ws")

const port = process.env.PORT || 8766
const isHttps = !!process.env.HTTPS_KEY
const server = isHttps
  ? require("https").createServer({
      key: fs.readFileSync(process.env.HTTPS_KEY),
      cert: fs.readFileSync(process.env.HTTPS_CERT),
    })
  : require("http").createServer()

// A plain HTTP response so opening the relay's URL in a browser works -
// to accept the self-signed certificate in https mode, and as a sanity
// check in either mode. Real NIP-11 relay info is not implemented.
server.on("request", (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" })
  res.end("Nostr relay (NIP-01: EVENT/REQ/CLOSE, replaceable/addressable persisted)\n")
})

const MAX_EVENTS = 10000
const events = [] // in-memory only, oldest first - regular/ephemeral kinds

// NIP-01 replaceable (10000-19999) and addressable (30000-39999) kinds:
// only the latest event per key survives. Kept out of `events` entirely -
// one copy of the data, not two - and persisted to SNAPSHOT_FILE so it
// survives a restart (unlike `events`, which is memory-only by design:
// the live-update kind is high-volume and meant to be cheap to lose).
const ADDRESSABLE_MIN = 30000, ADDRESSABLE_MAX = 40000
const REPLACEABLE_MIN = 10000, REPLACEABLE_MAX = 20000
const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE || "/srv/snapshots.json"

function replaceKey(event) {
  const { kind, pubkey } = event
  if (kind >= ADDRESSABLE_MIN && kind < ADDRESSABLE_MAX) {
    const d = event.tags.find((t) => t[0] === "d")?.[1] ?? ""
    return `${pubkey}:${kind}:${d}`
  }
  if (kind >= REPLACEABLE_MIN && kind < REPLACEABLE_MAX) return `${pubkey}:${kind}`
  return null
}

let latestByKey = new Map()
try {
  const saved = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"))
  latestByKey = new Map(Object.entries(saved))
} catch {
  // no file yet (first run) or unreadable - start empty
}

// Debounced write: a burst of snapshot publishes (several peers connecting
// at once) shouldn't fsync once per event.
let saveTimer = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const obj = Object.fromEntries(latestByKey)
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true })
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(obj))
  }, 200)
  saveTimer.unref()
}

function matchesFilter(event, filter) {
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.since && event.created_at < filter.since) return false
  if (filter.until && event.created_at > filter.until) return false
  for (const key of Object.keys(filter)) {
    if (!key.startsWith("#")) continue
    const tagName = key.slice(1)
    const wanted = filter[key]
    if (!event.tags.some((t) => t[0] === tagName && wanted.includes(t[1]))) return false
  }
  return true
}

const matchesAny = (event, filters) => filters.some((f) => matchesFilter(event, f))

const wss = new WebSocketServer({ server })
const subsByClient = new Map() // ws -> Map(subId -> filters[])

wss.on("connection", (ws) => {
  subsByClient.set(ws, new Map())
  ws.on("close", () => subsByClient.delete(ws))
  ws.on("message", (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    const [type] = msg

    if (type === "EVENT") {
      const event = msg[1]
      const key = replaceKey(event)
      if (key !== null) {
        const existing = latestByKey.get(key)
        if (!existing || event.created_at > existing.created_at ||
            (event.created_at === existing.created_at && event.id > existing.id)) {
          latestByKey.set(key, event)
          scheduleSave()
        }
      } else {
        events.push(event)
        if (events.length > MAX_EVENTS) events.shift()
      }
      for (const [peer, subs] of subsByClient) {
        for (const [subId, filters] of subs) {
          if (matchesAny(event, filters)) peer.send(JSON.stringify(["EVENT", subId, event]))
        }
      }
      ws.send(JSON.stringify(["OK", event.id, true, ""]))
    } else if (type === "REQ") {
      const [, subId, ...filters] = msg
      subsByClient.get(ws).set(subId, filters)
      for (const event of events) {
        if (matchesAny(event, filters)) ws.send(JSON.stringify(["EVENT", subId, event]))
      }
      for (const event of latestByKey.values()) {
        if (matchesAny(event, filters)) ws.send(JSON.stringify(["EVENT", subId, event]))
      }
      ws.send(JSON.stringify(["EOSE", subId]))
    } else if (type === "CLOSE") {
      const [, subId] = msg
      subsByClient.get(ws)?.delete(subId)
    }
  })
})

server.listen(port)

// `docker stop` sends SIGTERM and kills after 10 s (exit 137) if nobody
// listens; end cleanly instead.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`\n${signal}: stopping`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}

const ip = process.env.RELAY_IP || "127.0.0.1"
const wsHost = `${isHttps ? "wss" : "ws"}://${ip}:${port}`

console.log()
console.log("Nostr relay running on\n")
console.log(`    ${wsHost}\n`)

if (isHttps) {
  console.log(`Self-signed certificate: open https://${ip}:${port}/ once in a browser on this and every`)
  console.log("other device and accept the warning, before using the wss:// address above as a relay in")
  console.log("NostrTransport - otherwise the connection fails silently.\n")
}
