/**
 * E2E: a classroom-sized room in a real Chrome - N browser contexts
 * (isolated: no shared BroadcastChannel, one renderer each) run a
 * transport's playground against LOCAL servers, through the scenarios a
 * classroom produces:
 *
 *  join        N peers join within a few seconds. Until every roster shows
 *              N users; links per peer (mesh transports: N-1 = full mesh);
 *              until a text typed by one peer is in every editor.
 *  typing      5 peers type at the same time, 12 characters each. Until all N
 *              editors hold all 60 characters and are identical.
 *  bandwidth   (opt-in: SCENARIOS=join,bandwidth; WebRTC transports) what a
 *              peer's links carry, from RTCPeerConnection.getStats(): BW_SECONDS
 *              (20) idle, then TYPISTS (5) peers typing a character every
 *              KEY_MS (200). Per typist / listener: data-channel payload and an
 *              estimate of the bytes on an IPv4 wire (see netRate), kB/s.
 *  linger      (opt-in) LINGER_MS (420 s: longer than the 300 s presence lease of
 *              a mesh transport) with one peer reloading every 60 s. Rosters are
 *              checked 55 s after each reload. A run of the other scenarios
 *              that passes is over before a lease is.
 *  vanish      one tab is killed (no unload handler - a discarded tab, a
 *              phone that never came back). Until every roster dropped it.
 *  sleep       5 peers are frozen through the DevTools protocol for
 *              FREEZE_MS while another peer types. After the unfreeze:
 *              until the five have the text, until all rosters are
 *              complete again. (The freeze stops the page's timers, not
 *              Chrome's network thread: links survive it. It exercises the
 *              transports' resume path - five peers rebuilding all their
 *              links at once - not a link's death.)
 *  rejoin      one peer reloads the page. Until it has the room's text and
 *              every roster is complete.
 *  restart     the server (signaling / PeerJS server / Nostr relay /
 *              WebSocket relay) is killed for 5 s and restarted; one peer
 *              types while it is down. Until that text is everywhere, until
 *              a text typed afterwards is; then a NEW peer joins: until it
 *              has the text and every roster shows it.
 *  coordinator (peerjs only) the tab of the room's coordinator is killed,
 *              then a new peer joins. Until every roster is complete.
 *
 * Usage: node test/e2e/room-scenarios.mjs <simple-peer|peerjs|trystero|websocket|ably|pubnub|nostr|gun>
 *   N=25 FREEZE_MS=20000 SCENARIOS=join,typing,... OUT=results.json override.
 *
 * ably and pubnub run against the real service with the keys of .env
 * (node --env-file=.env test/e2e/room-scenarios.mjs ably); nostr and gun
 * against a local relay, or with LIVE=1 against the public relays named in
 * .env (nostrRelayURLs, gunDB_ServerURL). Whatever cannot be restarted is
 * reached through a CONNECT proxy of this script, and "restart" cuts that
 * proxy for 5 s: every socket of every peer dies at once - a network outage.
 *
 * Needs (none of it is a dependency of this package):
 *   puppeteer-core + a Chrome     PUPPETEER=/path/to/puppeteer-core  CHROME=/usr/bin/google-chrome
 *   simple-peer: nothing else (y-webrtc's bin/server.js is a devDependency)
 *   peerjs:      a PeerJS server binary     PEERJS_BIN=/path/to/node_modules/.bin/peerjs   (npm install peer)
 *   trystero:    nothing else (a minimal NIP-01 relay runs in this process; strategy nostr)
 *   websocket:   a y-websocket style server  WS_SERVER_JS=/path/to/edrys-websocket-server/src/server.js
 *                (git clone https://github.com/edrys-labs/edrys-websocket-server && npm install --omit=dev)
 *   ably/pubnub: ABLY_KEY / PUBNUB_PUBLISH_KEY + PUBNUB_SUBSCRIBE_KEY (.env); the SDKs come from their CDNs
 *   nostr:       nothing else (the NIP-01 relay of this process)
 *   gun:         the gun package where Node finds it for Docker/gun/relay.js   NODE_PATH=/path/to/node_modules
 *                (npm install gun somewhere - inside this repo npm skips it, an optional peer dependency)
 * The playground itself is served by this script (parcel serve, own dist dir).
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER ?? 'puppeteer-core')
const { WebSocketServer } = require('ws')

const TRANSPORT = process.argv[2]
const N = Number(process.env.N ?? 25)
const FREEZE_MS = Number(process.env.FREEZE_MS ?? 20000)
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
const APP_PORT = Number(process.env.APP_PORT ?? 3450)
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 4470)
const ROOM = 'e2e-' + Math.random().toString(36).slice(2, 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- servers

function spawned(cmd, args, env = {}, cwd = undefined) {
  let child
  return {
    start() {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore', cwd })
    },
    stop() {
      child?.kill('SIGKILL')
    },
  }
}

/** NIP-01, as much of it as Trystero's nostr strategy uses: REQ {kinds, "#x"}, EVENT, CLOSE. */
function nostrRelay(port) {
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

/**
 * "The network" between Chrome and a backend nobody here can restart (Ably,
 * PubNub, public relays): an HTTP CONNECT proxy every page tunnels through.
 * stop() cuts all tunnels and refuses new ones - for the clients the same
 * thing as a server restart: every socket dies at once, then comes back.
 * (Chrome never sends localhost through a proxy: the playground is not affected.)
 */
function connectProxy(port) {
  let server
  const sockets = new Set()
  return {
    start() {
      server = http.createServer((_, res) => res.writeHead(405).end())
      server.on('connect', (req, client, head) => {
        const [host, p] = req.url.split(':')
        const upstream = net.connect(Number(p) || 443, host, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.write(head)
          upstream.pipe(client)
          client.pipe(upstream)
        })
        for (const [s, other] of [[client, upstream], [upstream, client]]) {
          sockets.add(s)
          s.on('error', () => {})
          s.on('close', () => {
            sockets.delete(s)
            other.destroy()
          })
        }
      })
      server.listen(port, '127.0.0.1')
    },
    stop() {
      server?.close()
      for (const s of sockets) s.destroy()
    },
  }
}

const envList = (name) =>
  (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
const need = (name) => {
  if (!process.env[name]) throw new Error(`${name} is not set - run with node --env-file=.env`)
  return process.env[name]
}
/** LIVE=1: nostr and gun against the public relays of .env instead of a local one. */
const LIVE = !!process.env.LIVE

const fill = (page, sel, value) =>
  page.$eval(
    sel,
    (el, v) => {
      el.value = v
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    value,
  )
const check = (page, sel, on) =>
  page.$eval(
    sel,
    (el, v) => {
      if (el.checked !== v) el.click()
    },
    on,
  )

const ADAPTERS = {
  'simple-peer': {
    entry: 'test/simple-peer/index.html',
    mesh: true,
    vanishTimeoutMs: 90000,
    server: () => spawned('node', ['node_modules/y-webrtc/bin/server.js'], { PORT: String(SERVER_PORT) }),
    async prepare(page) {
      await page.evaluateOnNewDocument((port) => {
        localStorage.setItem(
          'simplepeer-config',
          JSON.stringify({ signaling: [`ws://localhost:${port}`], iceServers: [] }),
        )
      }, SERVER_PORT)
    },
    async join() {}, // connects on load; room name is fixed in the playground
  },
  peerjs: {
    entry: 'test/peerjs/index.html',
    mesh: true,
    vanishTimeoutMs: 90000,
    server: () =>
      spawned(process.env.PEERJS_BIN ?? 'peerjs', ['--port', String(SERVER_PORT), '--host', '127.0.0.1']),
    async prepare() {},
    async join(page) {
      await fill(page, '#config-room', ROOM)
      await fill(page, '#config-peerjs-host', 'localhost')
      await fill(page, '#config-peerjs-port', String(SERVER_PORT))
      await fill(page, '#config-ice-servers', '')
      await check(page, '#config-secure', false)
      await check(page, '#config-debug', true)
      await page.click('#connect-btn')
    },
  },
  trystero: {
    entry: 'test/trystero/index.html',
    mesh: true,
    vanishTimeoutMs: 90000,
    server: () => nostrRelay(SERVER_PORT),
    async prepare() {},
    async join(page) {
      await page.select('#config-strategy', 'nostr')
      await fill(page, '#config-app-id', 'y-generic-e2e')
      await fill(page, '#config-room', ROOM)
      await fill(page, '#config-relays', `ws://localhost:${SERVER_PORT}`)
      await fill(page, '#config-turn-servers', '')
      await page.click('#connect-btn')
    },
  },
  websocket: {
    entry: 'test/websocket/index.html',
    mesh: false,
    vanishTimeoutMs: 150000, // the playground's 120 s presence lease - this transport cannot report departures
    server: () =>
      spawned('node', [process.env.WS_SERVER_JS ?? 'server.js'], {
        PORT: String(SERVER_PORT),
        HOST: '127.0.0.1',
      }),
    async prepare() {},
    async join(page) {
      await fill(page, '#config-server-url', `ws://localhost:${SERVER_PORT}`)
      await fill(page, '#config-room', ROOM)
      await page.click('#connect-btn')
    },
  },
  ably: {
    entry: 'test/ably/index.html',
    mesh: false,
    proxy: true,
    vanishTimeoutMs: 90000, // Ably presence reports the leave of a connection that went silent
    server: () => connectProxy(SERVER_PORT),
    async prepare() {},
    async join(page) {
      await fill(page, '#config-api-key', need('ABLY_KEY'))
      await fill(page, '#config-room', ROOM)
      await page.click('#connect-btn')
    },
  },
  pubnub: {
    entry: 'test/pubnub/index.html',
    mesh: false,
    proxy: true,
    vanishTimeoutMs: 90000, // no presence in the playground: the 30 s lease
    server: () => connectProxy(SERVER_PORT),
    async prepare() {},
    async join(page) {
      await fill(page, '#config-publish-key', need('PUBNUB_PUBLISH_KEY'))
      await fill(page, '#config-subscribe-key', need('PUBNUB_SUBSCRIBE_KEY'))
      await fill(page, '#config-room', ROOM)
      await page.click('#connect-btn')
    },
  },
  nostr: {
    entry: 'test/nostr/index.html',
    mesh: false,
    proxy: LIVE,
    vanishTimeoutMs: 150000, // the playground's 120 s presence lease
    server: () => (LIVE ? connectProxy(SERVER_PORT) : nostrRelay(SERVER_PORT)),
    async prepare() {},
    async join(page) {
      await fill(page, '#relays', LIVE ? envList('nostrRelayURLs').join('\n') : `ws://localhost:${SERVER_PORT}`)
      await fill(page, '#room-name', ROOM)
      await page.click('#connect-btn')
    },
  },
  gun: {
    entry: 'test/gun/index.html',
    mesh: false,
    proxy: LIVE,
    vanishTimeoutMs: 150000, // the playground's 120 s presence lease
    // 127.0.0.1, not localhost: over ::1 a Gun relay delivers no live writes (test/gun/relay.sh)
    server: () =>
      LIVE
        ? connectProxy(SERVER_PORT)
        : spawned('node', [join(process.cwd(), 'Docker/gun/relay.js')], { PORT: String(SERVER_PORT) }, mkdtempSync(join(tmpdir(), 'ygen-gun-'))),
    async prepare() {},
    async join(page) {
      await fill(page, '#config-room', ROOM)
      await fill(page, '#config-peers', LIVE ? envList('gunDB_ServerURL').join('\n') : `http://127.0.0.1:${SERVER_PORT}/gun`)
      await page.click('#connect-btn')
    },
  },
}

// ---------------------------------------------------------------- helpers

// The mesh playgrounds list every user (self included) as #user-list .user-badge;
// the websocket playground lists the OTHERS as #users-list li (one placeholder li when alone).
const roster = (p) =>
  p.page.evaluate(() => {
    const mesh = document.getElementById('user-list')
    if (mesh) return mesh.children.length
    return document.querySelectorAll('#users-list li .user-color').length + 1
  })
const links = (p) => p.page.evaluate(() => Number(document.getElementById('peer-count')?.textContent ?? NaN)) // no such badge: nostr
const text = (p) => p.page.evaluate(() => document.querySelector('.ql-editor').innerText)

/** ms until pred holds for every peer; -1 on timeout (and how many were short of it). */
async function untilAll(peers, pred, timeoutMs) {
  const t0 = Date.now()
  let ok = 0
  let said = t0
  while (Date.now() - t0 < timeoutMs) {
    const results = await Promise.all(peers.map((p) => pred(p).catch(() => false)))
    ok = results.filter(Boolean).length
    if (ok === peers.length) return { ms: Date.now() - t0, ok, of: peers.length }
    if (process.env.DIAG && Date.now() - said >= 5000) {
      said = Date.now()
      console.log(`    ... ${ok} of ${peers.length} after ${Math.round((said - t0) / 1000)} s`)
    }
    await sleep(400)
  }
  return { ms: -1, ok, of: peers.length }
}
const fmt = (r) => (r.ms < 0 ? `NEVER (${r.ok} of ${r.of} in time)` : `${r.ms} ms`)

async function type(peer, str, delay = 0) {
  await peer.page.click('.ql-editor')
  await peer.page.keyboard.type(str, { delay })
}

/** Runs in the page before its scripts: keep every RTCPeerConnection it creates, for netStats(). */
const METER = () => {
  const Native = window.RTCPeerConnection
  if (!Native) return
  window.__pcs = []
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args)
    window.__pcs.push(pc)
    return pc
  }
  window.RTCPeerConnection.prototype = Native.prototype
  Object.setPrototypeOf(window.RTCPeerConnection, Native)
}

/**
 * What a page's WebRTC links have carried so far, summed over its open
 * connections: data-channel payload, what the ICE transport moved (payload +
 * SCTP + DTLS, no IP/UDP headers, no connectivity checks - the spec's
 * definition), its packets, and the STUN checks of the nominated pairs.
 */
const netStats = (p) =>
  p.page.evaluate(async () => {
    const s = { t: Date.now(), links: 0, payloadOut: 0, payloadIn: 0, msgsOut: 0, msgsIn: 0, dtlsOut: 0, dtlsIn: 0, pktsOut: 0, pktsIn: 0, stunReqOut: 0, stunRespOut: 0, stunReqIn: 0, stunRespIn: 0 }
    for (const pc of window.__pcs ?? []) {
      if (pc.connectionState !== 'connected') continue
      s.links++
      ;(await pc.getStats()).forEach((r) => {
        if (r.type === 'data-channel') {
          s.payloadOut += r.bytesSent
          s.payloadIn += r.bytesReceived
          s.msgsOut += r.messagesSent
          s.msgsIn += r.messagesReceived
        } else if (r.type === 'transport') {
          s.dtlsOut += r.bytesSent
          s.dtlsIn += r.bytesReceived
          s.pktsOut += r.packetsSent
          s.pktsIn += r.packetsReceived
        } else if (r.type === 'candidate-pair' && r.nominated) {
          s.stunReqOut += r.requestsSent
          s.stunRespOut += r.responsesSent
          s.stunReqIn += r.requestsReceived
          s.stunRespIn += r.responsesReceived
        }
      })
    }
    return s
  })

/**
 * Per-second rates between two netStats() samples. "wire" is an ESTIMATE of
 * what an IPv4 network carries: + 28 bytes IP/UDP per packet, + the STUN
 * checks at 128 bytes per request (100 of STUN with libwebrtc's ICE
 * attributes) and 92 per response (64), IP/UDP included.
 */
function netRate(a, b) {
  const secs = (b.t - a.t) / 1000
  const d = (k) => (b[k] - a[k]) / secs
  const stunOut = 128 * d('stunReqOut') + 92 * d('stunRespOut')
  const stunIn = 128 * d('stunReqIn') + 92 * d('stunRespIn')
  return {
    links: b.links,
    payloadOut: d('payloadOut'),
    payloadIn: d('payloadIn'),
    msgsOut: d('msgsOut'),
    msgsIn: d('msgsIn'),
    wireOut: d('dtlsOut') + 28 * d('pktsOut') + stunOut,
    wireIn: d('dtlsIn') + 28 * d('pktsIn') + stunIn,
    stunOut,
  }
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] }
}

// ---------------------------------------------------------------- main

async function main() {
  const adapter = ADAPTERS[TRANSPORT]
  if (!adapter) throw new Error(`usage: room-scenarios.mjs <${Object.keys(ADAPTERS).join('|')}>`)
  const wanted = (process.env.SCENARIOS ?? 'join,typing,vanish,sleep,rejoin,restart,coordinator').split(',')
  const results = { transport: TRANSPORT, n: N, scenarios: {} }
  const record = (scenario, label, value) => {
    ;(results.scenarios[scenario] ??= {})[label] = value
    console.log(`  ${label}: ${typeof value === 'object' && value.ms !== undefined ? fmt(value) : JSON.stringify(value)}`)
  }

  const server = adapter.server()
  server.start()
  const parcel = spawn(
    'node',
    ['node_modules/.bin/parcel', 'serve', adapter.entry, '--dist-dir', mkdtempSync(join(tmpdir(), 'ygen-e2e-')), '--port', String(APP_PORT), '--no-hmr'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('parcel did not start')), 120000)
    parcel.stdout.on('data', (d) => {
      if (String(d).includes('Built in')) {
        clearTimeout(t)
        resolve()
      }
    })
  })

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 240000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      // N tabs of one headless browser are all "background": keep their timers honest.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...(adapter.proxy ? [`--proxy-server=http://127.0.0.1:${SERVER_PORT}`] : []),
    ],
  })

  // What the room puts on the wire: every WebSocket frame a page sends (and
  // PubNub's publish requests), timestamped. A hosted backend meters exactly
  // this - Ably's free tier rejects what exceeds 50 messages/s on a channel.
  const sent = []
  const wire = (from, to = Date.now()) => {
    const perSecond = new Map()
    for (const t of sent) if (t >= from && t < to) perSecond.set(Math.floor(t / 1000), (perSecond.get(Math.floor(t / 1000)) ?? 0) + 1)
    const total = [...perSecond.values()].reduce((a, b) => a + b, 0)
    return { total, 'per second, mean': Math.round(total / Math.max(1, (to - from) / 1000)), 'per second, peak': Math.max(0, ...perSecond.values()) }
  }

  // One console line per refused send: ably-js reports each as Protocol.onNack, the
  // PubNub transport logs its failed publishes itself.
  const refused = (p) => p.logs.filter((l) => /Protocol\.onNack|\[PubNubTransport\] ❌/.test(l)).length

  let serial = 0
  const open = async () => {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    const peer = { id: serial++, page, logs: [] }
    const cdp = await page.createCDPSession()
    await cdp.send('Network.enable')
    cdp.on('Network.webSocketFrameSent', () => sent.push(Date.now()))
    cdp.on('Network.requestWillBeSent', (e) => /\/publish\//.test(e.request.url) && sent.push(Date.now()))
    page.on('console', (m) => peer.logs.push(`${new Date().toISOString().slice(14, 23)} [${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => peer.logs.push(`${new Date().toISOString().slice(14, 23)} [pageerror] ${e.message}`))
    // The playgrounds alert() a failed connect - an open dialog blocks every evaluate().
    page.on('dialog', (d) => {
      peer.logs.push(`${new Date().toISOString().slice(14, 23)} [dialog] ${d.message()}`)
      console.log(`    p${peer.id} dialog: ${d.message().slice(0, 400)}`)
      d.dismiss().catch(() => {})
    })
    await adapter.prepare(page)
    await page.evaluateOnNewDocument(METER)
    await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'load' })
    await adapter.join(page)
    await page.waitForSelector('.ql-editor', { timeout: 60000 })
    // A name per peer, so a roster says WHO is missing (see diag()).
    await fill(page, '#user-name', `p${peer.id}`).catch(() => {})
    return peer
  }

  const reload = async (p) => {
    await p.page.reload({ waitUntil: 'load' })
    await adapter.join(p.page)
    await p.page.waitForSelector('.ql-editor', { timeout: 60000 })
    await fill(p.page, '#user-name', `p${p.id}`).catch(() => {})
  }

  /** DIAG=1: who is missing from whose roster, links and (simple-peer) maxConns per peer. */
  const diag = async (label) => {
    if (!process.env.DIAG || peers.length === 0) return
    // No name field (nostr): rosters cannot say WHO is missing, only how many.
    if (!(await peers[0].page.$('#user-name'))) {
      console.log(`  [diag ${label}] roster sizes: ${(await Promise.all(peers.map(roster))).join(' ')}`)
      return
    }
    const names = (p) =>
      p.page.evaluate((self) => {
        const mesh = Array.from(document.querySelectorAll('#user-list .user-badge span'))
        if (mesh.length > 0) return mesh.map((el) => el.textContent.replace(' (You)', '').trim())
        return [self, ...Array.from(document.querySelectorAll('#users-list li span')).map((el) => el.textContent.trim())]
      }, `p${p.id}`)
    const rosters = await Promise.all(peers.map(names))
    const linkCounts = await Promise.all(peers.map(links))
    const presenceViews = []
    console.log(`  [diag ${label}] peer: links / roster size / maxConns / missing`)
    peers.forEach((p, i) => {
      const missing = peers.map((q) => `p${q.id}`).filter((n) => !rosters[i].includes(n))
      const maxConns = p.logs.map((l) => /maxConns: (\d+)/.exec(l)?.[1]).find(Boolean) ?? '-'
      if (missing.length > 0 || (adapter.mesh && linkCounts[i] < peers.length - 1))
        console.log(`    p${p.id}: ${linkCounts[i]} / ${rosters[i].length} / ${maxConns} / ${missing.join(' ') || '-'}`)
      // One or two missing on a mesh: what this peer's transport logged about THEM (by transport id).
      if (adapter.mesh && missing.length > 0 && missing.length <= 2) presenceViews.push({ p, missing })
      if (adapter.mesh && missing.length > 0 && missing.length <= 2) {
        for (const name of missing) {
          const id = peers.find((q) => `p${q.id}` === name)?.logs.map((l) => /peerId: ([\w-]+)/.exec(l)?.[1]).find(Boolean)
          if (!id) continue
          console.log(`      p${p.id}'s log about ${name} (${id}):`)
          // (signaling lines carry the first 8 characters of an id only)
          for (const l of p.logs.filter((l) => l.includes(id.slice(0, 8)) && !/signal=candidate/.test(l)).slice(0, 40)) console.log('        ' + l.slice(0, 200))
          // ... and the other side: did THEIR link to this peer get replaced, or open twice?
          const mine = p.logs.map((l) => /peerId: ([\w-]+)/.exec(l)?.[1]).find(Boolean)
          const q = peers.find((x) => `p${x.id}` === name)
          if (!mine || !q) continue
          console.log(`      ${name}'s log about p${p.id} (${mine}):`)
          for (const l of q.logs.filter((l) => l.includes(mine.slice(0, 8)) && !/signal=candidate/.test(l)).slice(0, 40)) console.log('        ' + l.slice(0, 200))
        }
      }
    })
    // ... and what its core holds for them, next to their own clock (playgrounds that expose __provider):
    // no meta = their presence never arrived; a clock >= theirs without a state = it arrived and lost.
    for (const { p, missing } of presenceViews) {
      for (const name of missing) {
        const q = peers.find((x) => `p${x.id}` === name)
        const theirs = await q?.page.evaluate(() => {
          const pr = window.__provider
          return pr ? { id: pr.doc.clientID, clock: pr.awareness.meta.get(pr.doc.clientID)?.clock, user: pr.awareness.getLocalState()?.user?.name } : null
        })
        if (!theirs) continue
        const held = await p.page.evaluate((id) => {
          const pr = window.__provider
          const meta = pr.awareness.meta.get(id)
          return { clock: meta?.clock, ageMs: meta ? Date.now() - meta.lastUpdated : undefined, hasState: pr.awareness.getStates().has(id), user: pr.awareness.getStates().get(id)?.user?.name, address: pr._peerAddress.get(id) }
        }, theirs.id)
        console.log(`      ${name} itself: ${JSON.stringify(theirs)} - p${p.id} holds: ${JSON.stringify(held)}`)
      }
    }
    const seenBy = peers.map((q) => rosters.filter((r) => r.includes(`p${q.id}`)).length)
    const short = peers.filter((_, i) => seenBy[i] < peers.length)
    console.log(`    listed in fewer than ${peers.length} rosters: ${short.map((q) => `p${q.id}(${seenBy[peers.indexOf(q)]})`).join(' ') || 'nobody'}`)
  }

  let peers = []
  const others = (...gone) => peers.filter((p) => !gone.includes(p))
  try {
    console.log(`${TRANSPORT}: ${N} peers, room ${ROOM}`)

    // ---- join
    console.log('join')
    const tJoin = Date.now()
    const opening = []
    for (let i = 0; i < N; i++) {
      opening.push(open())
      await sleep(i === 0 ? 3000 : 200) // the first peer opens the room (PeerJS: claims the coordinator id)
    }
    // A peer that could not join (the service refused it) is a result, not a crash.
    const opened = await Promise.allSettled(opening)
    peers = opened.filter((o) => o.status === 'fulfilled').map((o) => o.value)
    if (peers.length < N) record('join', 'peers that FAILED to join', `${N - peers.length} of ${N}`)
    record('join', 'all pages loaded and connected after', { ms: Date.now() - tJoin, ok: peers.length, of: N })
    // Rosters that are not complete within 10 s wait for a presence renewal (half a lease): say who is missing.
    const complete = async (p) => (await roster(p)) === peers.length
    let rosters = await untilAll(peers, complete, 10000)
    if (rosters.ms < 0) {
      await diag('join, 10 s in')
      const rest = await untilAll(peers, complete, 170000)
      rosters = rest.ms < 0 ? rest : { ...rest, ms: rest.ms + 10000 }
    }
    record('join', `every roster shows ${peers.length} users`, rosters)
    await sleep(3000)
    if (adapter.mesh) record('join', 'links per peer (peer-count)', stats(await Promise.all(peers.map(links))))
    await diag('after join')
    record('join', 'frames sent by the whole room during the join', wire(tJoin))
    record('join', 'sends the backend refused (console)', peers.reduce((n, p) => n + refused(p), 0))
    await type(peers[0], 'hello-from-0 ')
    record('join', 'text of one peer in every editor', await untilAll(peers, async (p) => (await text(p)).includes('hello-from-0'), 60000))
    const tIdle = Date.now()
    await sleep(10000)
    record('join', 'frames sent by the whole room in 10 idle seconds', wire(tIdle))

    // ---- typing
    if (wanted.includes('typing')) {
      console.log('typing')
      // One letter per typist, 12 times: five cursors at the same spot interleave
      // their runs (that is the editor, not a loss) - count letters instead.
      const typists = peers.slice(1, 6)
      const letters = ['Q', 'X', 'Z', 'J', 'K']
      const t0 = Date.now()
      await Promise.all(typists.map((p, i) => type(p, letters[i].repeat(12) + ' ')))
      const typedAfter = Date.now() - t0
      const count = (str, ch) => str.split(ch).length - 1
      const all = await untilAll(
        peers,
        async (p) => {
          const t = await text(p)
          return typists.every((_, i) => count(t, letters[i]) === 12)
        },
        60000,
      )
      record('typing', 'all 60 characters of five concurrent typists in every editor (after the typing ended)', all)
      record('typing', 'typing itself took (ms)', typedAfter)
      record('typing', 'frames sent by the whole room', wire(t0))
      const same = await untilAll([peers[0]], async () => new Set(await Promise.all(peers.map(text))).size === 1, 30000)
      record('typing', 'editors identical', same.ms >= 0)
    }

    // ---- bandwidth (opt-in, WebRTC transports): bytes per peer and second, from getStats()
    if (wanted.includes('bandwidth') && adapter.mesh) {
      const TYPISTS = Number(process.env.TYPISTS ?? 5)
      const SECONDS = Number(process.env.BW_SECONDS ?? 20)
      const KEY_MS = Number(process.env.KEY_MS ?? 200) // 5 characters per second, a fast typist
      console.log(`bandwidth (${SECONDS} s idle, then ${TYPISTS} peers typing a character every ${KEY_MS} ms for ${SECONDS} s)`)
      const typists = peers.slice(1, 1 + TYPISTS)
      const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
      const kB = (x) => Math.round(x / 10.24) / 100
      const phase = async (label, work) => {
        const before = await Promise.all(peers.map(netStats))
        await work()
        const after = await Promise.all(peers.map(netStats))
        const rates = peers.map((_, i) => netRate(before[i], after[i]))
        for (const [who, group] of [['typist', rates.filter((_, i) => typists.includes(peers[i]))], ['listener', rates.filter((_, i) => !typists.includes(peers[i]))]]) {
          if (label === 'idle' && who === 'typist') continue
          record('bandwidth', `${label}, per ${label === 'idle' ? 'peer' : who} (${group.length}), kB/s`, {
            links: Math.round(mean(group.map((r) => r.links))),
            'payload up': kB(mean(group.map((r) => r.payloadOut))),
            'payload down': kB(mean(group.map((r) => r.payloadIn))),
            'wire up (est.)': kB(mean(group.map((r) => r.wireOut))),
            'wire down (est.)': kB(mean(group.map((r) => r.wireIn))),
            'wire up, worst peer': kB(Math.max(...group.map((r) => r.wireOut))),
            'of wire up: STUN keep-alive': kB(mean(group.map((r) => r.stunOut))),
            'messages up /s': Math.round(mean(group.map((r) => r.msgsOut))),
            'messages down /s': Math.round(mean(group.map((r) => r.msgsIn))),
          })
        }
      }
      await phase('idle', () => sleep(SECONDS * 1000))
      const line = 'the quick brown fox jumps over the lazy dog '.repeat(Math.ceil((SECONDS * 1000) / KEY_MS / 44)).slice(0, Math.round((SECONDS * 1000) / KEY_MS))
      let typedMs = 0
      await phase('typing', async () => {
        const t0 = Date.now()
        await Promise.all(typists.map((p) => type(p, line, KEY_MS)))
        typedMs = Date.now() - t0
      })
      record('bandwidth', 'characters per typist and second, as typed', Math.round((line.length / (typedMs / 1000)) * 10) / 10)
    }

    // ---- vanish
    if (wanted.includes('vanish')) {
      console.log('vanish')
      const gone = peers[peers.length - 1]
      await gone.page.close()
      peers = others(gone)
      record('vanish', `every roster dropped the killed tab (${peers.length} users)`, await untilAll(peers, async (p) => (await roster(p)) === peers.length, adapter.vanishTimeoutMs))
    }

    // ---- sleep
    if (wanted.includes('sleep')) {
      console.log(`sleep (5 peers frozen for ${FREEZE_MS} ms)`)
      const sleepers = peers.length > 11 ? peers.slice(6, 11) : peers.slice(1, 2) // small N: one sleeper
      const sessions = await Promise.all(sleepers.map((p) => p.page.createCDPSession()))
      await Promise.all(sessions.map((s) => s.send('Page.setWebLifecycleState', { state: 'frozen' })))
      await type(peers[0], 'typed-while-five-slept ')
      await sleep(FREEZE_MS)
      await Promise.all(sessions.map((s) => s.send('Page.setWebLifecycleState', { state: 'active' })))
      const t0 = Date.now()
      record('sleep', 'the five have the missed text', await untilAll(sleepers, async (p) => (await text(p)).includes('typed-while-five-slept'), 90000))
      const full = await untilAll(peers, async (p) => (await roster(p)) === peers.length, 120000)
      record('sleep', 'every roster complete again (since the unfreeze)', full.ms < 0 ? full : { ...full, ms: Date.now() - t0 })
      record('sleep', 'sleepers that logged a resume', sleepers.filter((p) => p.logs.some((l) => l.includes('Page slept'))).length)
      await sleep(3000)
      if (adapter.mesh) record('sleep', 'links per peer afterwards', stats(await Promise.all(peers.map(links))))
      console.log(`    sleepers: ${sleepers.map((p) => 'p' + p.id).join(' ')}`)
      await diag('after sleep')
    }

    // ---- rejoin
    if (wanted.includes('rejoin')) {
      console.log('rejoin (one peer reloads)')
      const p = peers[Math.min(11, peers.length - 1)]
      const t0 = Date.now()
      await reload(p)
      record('rejoin', 'the reloaded peer has the room text', await untilAll([p], async (x) => (await text(x)).includes('hello-from-0'), 60000))
      const full = await untilAll(peers, async (x) => (await roster(x)) === peers.length, 150000)
      record('rejoin', 'every roster complete (since the reload)', full.ms < 0 ? full : { ...full, ms: Date.now() - t0 })
      if (full.ms < 0) await diag('after rejoin')
    }

    // ---- linger (opt-in): outlive a presence lease while peers keep coming and going
    if (wanted.includes('linger')) {
      const LINGER_MS = Number(process.env.LINGER_MS ?? 420000)
      console.log(`linger (${LINGER_MS / 1000} s, one peer reloads every 60 s)`)
      const t0 = Date.now()
      const short = []
      for (let k = 0; Date.now() - t0 < LINGER_MS; k++) {
        await reload(peers[(12 + k) % peers.length])
        await sleep(55000)
        // Just before the next reload every roster has had 55 s to settle.
        const sizes = await Promise.all(peers.map(roster))
        const incomplete = sizes.filter((n) => n !== peers.length).length
        if (incomplete > 0) short.push(`${Math.round((Date.now() - t0) / 1000)} s: ${incomplete} rosters, smallest ${Math.min(...sizes)}`)
      }
      record('linger', 'moments with an incomplete roster (55 s after each reload)', short.length === 0 ? 'none' : short)
      if (short.length > 0) await diag('after linger')
    }

    // ---- restart
    if (wanted.includes('restart')) {
      console.log('restart (server down for 5 s)')
      server.stop()
      await sleep(1000)
      await type(peers[3], 'typed-during-outage ') // unsent: no transport queues for a dead link
      await sleep(4000)
      server.start()
      const tBack = Date.now()
      record('restart', 'text typed DURING the outage in every editor (since the restart)', await untilAll(peers, async (p) => (await text(p)).includes('typed-during-outage'), 90000))
      await sleep(Math.max(0, 12000 - (Date.now() - tBack))) // the clients' reconnect backoff
      await type(peers[2], 'typed-after-restart ')
      record('restart', 'text typed after the restart in every editor', await untilAll(peers, async (p) => (await text(p)).includes('typed-after-restart'), 90000))
      const t0 = Date.now()
      const late = await open()
      peers.push(late)
      record('restart', 'a new peer has the room text', await untilAll([late], async (p) => (await text(p)).includes('typed-after-restart'), 90000))
      const full = await untilAll(peers, async (p) => (await roster(p)) === peers.length, 150000)
      record('restart', `every roster shows the new peer (${peers.length} users, since it opened)`, full.ms < 0 ? full : { ...full, ms: Date.now() - t0 })
    }

    // ---- coordinator (peerjs)
    if (wanted.includes('coordinator') && TRANSPORT === 'peerjs') {
      console.log('coordinator (its tab is killed, then a new peer joins)')
      const coordinator = peers[0]
      await coordinator.page.close()
      peers = others(coordinator)
      const t0 = Date.now()
      record('coordinator', `every roster dropped the coordinator (${peers.length} users)`, await untilAll(peers, async (p) => (await roster(p)) === peers.length, 150000))
      const late = await open()
      peers.push(late)
      record('coordinator', 'a new peer has the room text', await untilAll([late], async (p) => (await text(p)).includes('hello-from-0'), 150000))
      const full = await untilAll(peers, async (p) => (await roster(p)) === peers.length, 180000)
      record('coordinator', `every roster complete (${peers.length} users, since the kill)`, full.ms < 0 ? full : { ...full, ms: Date.now() - t0 })
    }

    // ---- final state
    console.log('final')
    await sleep(3000)
    // DUMP_LOGS=p6,p11: the last console lines of those peers (warnings, errors, transport debug).
    for (const name of (process.env.DUMP_LOGS ?? '').split(',').filter(Boolean)) {
      const p = peers.find((q) => `p${q.id}` === name)
      console.log(`  [logs ${name}]`)
      for (const l of (p?.logs ?? []).filter((l) => process.env.DUMP_ALL || !/Sync|awareness|Awareness|📥|📤/.test(l)).slice(-Number(process.env.DUMP_N ?? 25))) console.log('    ' + l.slice(0, 220))
    }
    await diag('final')
    const texts = await Promise.all(peers.map(text))
    record('final', 'editors identical', new Set(texts).size === 1)
    record('final', 'sends the backend refused (console, whole run)', peers.reduce((n, p) => n + refused(p), 0))
    record('final', 'rosters', stats(await Promise.all(peers.map(roster))))
    if (adapter.mesh) record('final', 'links per peer', stats(await Promise.all(peers.map(links))))
  } finally {
    if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(results, null, 2))
    await browser.close().catch(() => {})
    server.stop()
    parcel.kill('SIGKILL')
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
