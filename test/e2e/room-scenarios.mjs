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
 *  oneway      (opt-in, WebRTC transports) a link that cannot send, made on
 *              purpose: in peer B's page every data channel of its connection
 *              to peer A gets a send() that throws "readyState is not 'open'"
 *              - what Chrome's RTCDataChannel does by itself on the answering
 *              side of a link about once per 50-peer join (its object stays at
 *              'connecting' after its own 'open'). Then B renames itself. Until
 *              A's roster shows the new name: only if somebody notices the
 *              dead direction and the pair dials again.
 *  linger      (opt-in) LINGER_MS (420 s: longer than the 300 s presence lease of
 *              a mesh transport) with one peer reloading every 60 s. Rosters are
 *              checked 55 s after each reload. A run of the other scenarios
 *              that passes is over before a lease is. LINGER_GAP_MS=5000: the
 *              check 5 s after each reload instead - a reload that leaves a
 *              ghost (its removal never left the page) on a transport with a
 *              short lease, while the ghost is still there.
 *  vanish      one tab is killed (no unload handler - a discarded tab, a
 *              phone that never came back). Until every roster dropped it.
 *  sleep       5 peers are frozen through the DevTools protocol for
 *              FREEZE_MS while another peer types. After the unfreeze:
 *              until the five have the text, until all rosters are
 *              complete again. (The freeze stops the page's timers, not
 *              Chrome's network thread: links survive it. It exercises the
 *              transports' resume path - five peers rebuilding all their
 *              links at once - not a link's death.)
 *  offline     (opt-in) one Chrome peer loses its network for OFFLINE_MS (20 s)
 *              through the DevTools protocol - the browser fires `offline`
 *              and `online`, as it does when a phone's WiFi goes and comes
 *              back (the proxy cut of `restart` fires neither: a server that
 *              went away). Another peer types meanwhile. Until the returner
 *              has that text, until a text IT types is everywhere, until a
 *              text typed afterwards reaches it, until every roster is whole.
 *  storm       (opt-in) sustained load, in phases (STORM=typing,cursor,bulk,faults):
 *              typing - STORM_TYPISTS (10) Chrome peers type for STORM_S (60 s), a
 *              character every STORM_KEY_MS (250 ms), each in its own paragraph of
 *              the editor, in unique tokens; every page notes when it first saw
 *              each token: the lag typed -> seen elsewhere, what is missing, when
 *              everything is everywhere. cursor - every peer changes its presence
 *              STORM_CURSOR_HZ (5) times a second for half of STORM_S: the lag
 *              and how many changes arrive. bulk - three STORM_BULK_KB (100 KB)
 *              inserts while the typists type. faults - 90 s of typing with a
 *              reload, three pages frozen for 40 s, one typist offline for 20 s
 *              and the server down for 5 s: every token everywhere afterwards.
 *  rejoin      one peer reloads the page. Until it has the room's text and
 *              every roster is complete.
 *  restart     the server (signaling / PeerJS server / Nostr relay /
 *              WebSocket relay) is killed for OUTAGE_MS (5 s) and restarted;
 *              one peer types while it is down. Until that text is
 *              everywhere, until every roster is complete again (an outage
 *              longer than the presence lease: every page expired the room -
 *              the relay transport must tell the provider that its link is
 *              back), until a text typed afterwards is; then a NEW peer
 *              joins: until it has the text and every roster shows it.
 *  coordinator (peerjs only) the tab of the room's coordinator is killed,
 *              then a new peer joins. Until every roster is complete.
 *
 * Usage: node test/e2e/room-scenarios.mjs <simple-peer|conference|peerjs|trystero|websocket|ably|pubnub|nostr|gun>
 *   N=25 FREEZE_MS=40000 SCENARIOS=join,typing,... OUT=results.json override.
 *   FIREFOX=10: that many of the N peers run in a headless Firefox (FIREFOX_BIN,
 *   default /usr/bin/firefox) - the peers with an odd number, so three of the five
 *   typists, the peer that reloads and the `oneway` peer that cannot send are
 *   Firefox, its counterpart is Chrome. Firefox has no DevTools protocol: its peers
 *   are not frozen (`sleep` takes Chrome peers) and their signaling frames are not
 *   counted. FIREFOX_EACH=1: one Firefox PROCESS per Firefox peer (several hundred MB
 *   each) instead of one Firefox with a tab per peer. Every such page is then the
 *   visible tab of its own window - a user with the tab in front. In the shared
 *   Firefox all tabs but the last are HIDDEN, and Firefox delays a hidden tab's
 *   timers in a busy room by up to ~15-20 s: a user with the tab in the background.
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
import { nostrRelay } from './nostr-relay.mjs'

const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER ?? 'puppeteer-core')

const TRANSPORT = process.argv[2]
const N = Number(process.env.N ?? 25)
const OUTAGE_MS = Number(process.env.OUTAGE_MS ?? 5000) // restart: how long the server / the network is gone
const OFFLINE_MS = Number(process.env.OFFLINE_MS ?? 20000) // offline: how long one page has no network
const FREEZE_MS = Number(process.env.FREEZE_MS ?? 40000) // longer than the transports' resumeAfterMs (30 s), or no resume path runs
const FIREFOX = Number(process.env.FIREFOX ?? 0)
const DIAG_MAX_MISSING = Number(process.env.DIAG_MAX_MISSING ?? 2) // DIAG=1: up to how many missing peers a roster's details are printed for
const DIAG_MAX_VIEWS = Number(process.env.DIAG_MAX_VIEWS ?? 3) // ... and for how many peers with a hole the presence/wrapper details are dumped
const JOIN_GAP_MS = Number(process.env.JOIN_GAP_MS ?? 200) // between two joins; smaller = more pairs that join in the same second
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
  // The simple-peer playground under ConferenceTransport: a partial mesh, frames passed on.
  // CONFERENCE_EXPECTED (default: N, floor 17 - below that the transport builds a full mesh).
  conference: {
    entry: 'test/simple-peer/index.html',
    mesh: true,
    partial: true,
    vanishTimeoutMs: 90000,
    server: () => spawned('node', ['node_modules/y-webrtc/bin/server.js'], { PORT: String(SERVER_PORT) }),
    async prepare(page) {
      await page.evaluateOnNewDocument(
        (port, expectedPeers) => {
          localStorage.setItem(
            'simplepeer-config',
            JSON.stringify({ signaling: [`ws://localhost:${port}`], iceServers: [], conference: { expectedPeers } }),
          )
        },
        SERVER_PORT,
        Number(process.env.CONFERENCE_EXPECTED ?? Math.max(17, N)),
      )
    },
    async join() {},
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
    vanishTimeoutMs: 90000, // the server removes a closed connection's presence at once; its ping finds a silent one within 60 s
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
      await check(page, '#config-debug', true) // the transport's log, for DUMP_LOGS
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
/** `note`: what the DIAG progress line adds - "0 of 24" does not say whether a roster is too long or too short. */
async function untilAll(peers, pred, timeoutMs, note = undefined) {
  const t0 = Date.now()
  let ok = 0
  let said = t0
  while (Date.now() - t0 < timeoutMs) {
    const results = await Promise.all(peers.map((p) => pred(p).catch(() => false)))
    ok = results.filter(Boolean).length
    if (ok === peers.length) return { ms: Date.now() - t0, ok, of: peers.length }
    if (process.env.DIAG && Date.now() - said >= 5000) {
      said = Date.now()
      console.log(`    ... ${ok} of ${peers.length} after ${Math.round((said - t0) / 1000)} s${note ? ` - ${await note()}` : ''}`)
    }
    await sleep(400)
  }
  return { ms: -1, ok, of: peers.length }
}
const fmt = (r) => (r.ms < 0 ? `NEVER (${r.ok} of ${r.of} in time)` : `${r.ms} ms`)

async function type(peer, str, delay = 0) {
  if (peer.firefox) {
    // Not through puppeteer's keyboard: over WebDriver BiDi 13 characters took 11-16 s, and
    // for that long the page's timers did not run - the transports' sleep detector
    // (src/providers/resume.ts) took it for a suspended page and re-joined the room.
    // Paced from here, not by a timer in the page: a background tab's timers tick once a second.
    const insert = (text) =>
      peer.page.evaluate((text) => {
        const editor = document.querySelector('.ql-editor')
        editor.focus()
        getSelection().selectAllChildren(editor)
        getSelection().collapseToEnd()
        for (const ch of text) document.execCommand('insertText', false, ch)
      }, text)
    if (!delay) return insert(str)
    for (const ch of str) {
      await insert(ch)
      await sleep(delay)
    }
    return
  }
  await peer.page.click('.ql-editor')
  await peer.page.keyboard.type(str, { delay })
}

/** Runs in the page before its scripts: keep every RTCPeerConnection it creates, for netStats(). */
const METER = () => {
  // Did this page's timers stand still? A 1 s interval notes every tick that came more than 5 s
  // late - by the wall clock and by the monotonic one (a clock that jumped is not a page that
  // slept) - with what the tab thought of itself, and every change of its visibility.
  window.__gaps = []
  window.__visibility = [`${new Date().toISOString().slice(14, 23)} ${document.visibilityState}`]
  document.addEventListener('visibilitychange', () => window.__visibility.push(`${new Date().toISOString().slice(14, 23)} ${document.visibilityState}`))
  let wall = Date.now()
  let mono = performance.now()
  setInterval(() => {
    const w = Date.now()
    const m = performance.now()
    if (w - wall > 5000) window.__gaps.push(`${new Date(w).toISOString().slice(14, 23)} late by ${w - wall - 1000} ms (monotonic ${Math.round(m - mono - 1000)} ms), ${document.visibilityState}, focus ${document.hasFocus()}`)
    wall = w
    mono = m
  }, 1000)
  const Native = window.RTCPeerConnection
  if (!Native) return
  window.__pcs = []
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args)
    window.__pcs.push(pc)
    // Every data channel of the connection, made here or announced by the other end (see pcView).
    pc.__channels = []
    const create = pc.createDataChannel.bind(pc)
    pc.createDataChannel = (...a) => {
      const ch = create(...a)
      pc.__channels.push(ch)
      return ch
    }
    pc.addEventListener('datachannel', (e) => pc.__channels.push(e.channel))
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
 * Every RTCPeerConnection of a page (see METER): its states, the ICE ufrags of
 * both ends - what pairs it with a connection in ANOTHER page - and what its
 * data channels have carried. For diag(): how many connections does a pair
 * have, and does what one end sent arrive at the other?
 */
const pcView = (p) =>
  p.page.evaluate(async () => {
    const ufrag = (sdp) => /a=ice-ufrag:(\S+)/.exec(sdp ?? '')?.[1]
    const out = []
    for (const [i, pc] of (window.__pcs ?? []).entries()) {
      // Firefox throws on almost anything asked of a closed connection (Chrome answers): skip those.
      try {
        const v = { i, conn: pc.connectionState, ice: pc.iceConnectionState, local: ufrag(pc.localDescription?.sdp), remote: ufrag(pc.remoteDescription?.sdp), dc: [] }
        // What the JS objects say, next to what getStats() says below: `js: <id>:<readyState>` per channel.
        v.js = (pc.__channels ?? []).map((ch) => `${ch.id}:${ch.readyState}`).join(',')
        if (pc.connectionState !== 'closed') {
          ;(await pc.getStats()).forEach((r) => {
            if (r.type === 'data-channel') v.dc.push(`${r.state} sent ${r.messagesSent} rcvd ${r.messagesReceived}`)
          })
        }
        out.push(v)
      } catch {
        out.push({ i, conn: 'closed', dc: [] })
      }
    }
    return out
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

  // FIREFOX=n: a second browser. Host candidates as they are, as for Chrome above (the
  // room is on one machine); background tabs' timers left alone, as for Chrome above.
  const launchFirefox = () =>
      puppeteer.launch({
          browser: 'firefox',
          executablePath: process.env.FIREFOX_BIN ?? '/usr/bin/firefox',
          headless: true,
          protocolTimeout: 240000,
          // FIREFOX_PREFS='{"pref":value}' replaces the two timer prefs ('{}' = Firefox as it ships).
          extraPrefsFirefox: {
            'media.peerconnection.ice.obfuscate_host_addresses': false,
            ...(process.env.FIREFOX_PREFS
              ? JSON.parse(process.env.FIREFOX_PREFS)
              : { 'dom.min_background_timeout_value': 4, 'dom.timeout.enable_budget_timer_throttling': false }),
          },
        })
  const firefoxes = [] // every Firefox launched, for the cleanup
  const newFirefox = async () => {
    const f = await launchFirefox()
    firefoxes.push(f)
    return f
  }
  const firefox = FIREFOX > 0 && !process.env.FIREFOX_EACH ? await newFirefox() : null

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
  let firefoxPeers = 0
  const open = async () => {
    const id = serial++
    const inFirefox = FIREFOX > 0 && id % 2 === 1 && firefoxPeers < FIREFOX
    if (inFirefox) firefoxPeers++
    const context = await (inFirefox ? (firefox ?? (await newFirefox())) : browser).createBrowserContext()
    const page = await context.newPage()
    const peer = { id, page, logs: [], firefox: inFirefox }
    if (!inFirefox) {
      const cdp = await page.createCDPSession()
      await cdp.send('Network.enable')
      cdp.on('Network.webSocketFrameSent', () => sent.push(Date.now()))
      cdp.on('Network.requestWillBeSent', (e) => /\/publish\//.test(e.request.url) && sent.push(Date.now()))
    }
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

  // A transport that finds its page has slept drops its links and joins again under a new id
  // (src/providers/resume.ts). Right for a frozen page; for one that was merely starved of
  // timers it is a false alarm that costs the room a whole re-join.
  const resumed = () => peers.filter((p) => p.logs.some((l) => l.includes('Page slept'))).map((p) => `p${p.id}${p.firefox ? '(ff)' : ''}`)

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
    // A partial mesh: who each peer is (the wrapper's own address, the inner transport's peer id)
    // and how many DIRECT links it holds - the topology every other number here is read against.
    // A roster LONGER than the room: a ghost - a page that reloaded and whose removal never
    // reached this peer (or was never believed). `missing` below says nothing about those, so
    // name them here: who is listed that is nobody's live name, what this peer's core holds for
    // it, and - under a partial mesh - what its wrapper thinks of that origin.
    // A reloaded page comes back under its OWN name (p14 is p14 again), so a ghost is not a
    // name nobody carries - it is the same name TWICE: the old clientID beside the new one.
    const live = new Set(peers.map((p) => `p${p.id}`))
    const ghostViews = peers
      .map((p, i) => ({
        p,
        ghosts: [...new Set(rosters[i].filter((n, j) => !live.has(n) || rosters[i].indexOf(n) !== j))],
      }))
      .filter((x) => x.ghosts.length > 0)
    if (ghostViews.length > 0) {
      const suspectTotal = await Promise.all(peers.map((p) => p.page.evaluate(() => window.__conference?.stats.suspects ?? null).catch(() => null)))
      console.log(
        `  [diag ${label}] rosters longer than the room: ${ghostViews.map((x) => `p${x.p.id}(+${x.ghosts.length})`).join(' ')}` +
          (suspectTotal.some((x) => x !== null) ? ` - SUSPECTs sent by the room so far: ${suspectTotal.reduce((a, b) => a + (b ?? 0), 0)}` : ''),
      )
      for (const { p, ghosts } of ghostViews.slice(0, DIAG_MAX_VIEWS)) {
        const held = await p.page
          .evaluate((names) => {
            const pr = window.__provider
            const w = window.__conference
            const out = []
            for (const [id, s] of pr.awareness.getStates().entries()) {
              if (!names.includes(s.user?.name)) continue
              const meta = pr.awareness.meta.get(id)
              const address = pr._peerAddress?.get(id)
              const o = address && w ? w._origins.get(address) : undefined
              out.push({
                name: s.user?.name,
                clientID: id,
                clock: meta?.clock,
                ageMs: meta ? Date.now() - meta.lastUpdated : undefined,
                address: address ?? null,
                origin: o ? { gone: o.gone, goneAt: o.goneAt, hw: o.hw, route: o.route?.slice(0, 8), direct: w._byPeer.has(address) } : address ? 'no origin' : null,
                // Did anybody suspect it? This page's own count, and whether it ever had a
                // SUSPECT pending for that address: nobody sent one vs. the one that was
                // sent never got here are different bugs.
                suspects: w ? w.stats.suspects : null,
                pending: w && address ? w._pendingSuspects.has(address) : null,
              })
            }
            return out
          }, ghosts)
          .catch((e) => String(e).slice(0, 120))
        console.log(`    p${p.id} holds: ${JSON.stringify(held)}`)
      }
    }
    if (adapter.partial && (ghostViews.length > 0 || rosters.some((r) => r.length < peers.length))) {
      const who = await Promise.all(
        peers.slice(0, DIAG_MAX_VIEWS).map((p) =>
          p.page
            .evaluate(() => {
              const t = window.__provider?.transport
              const w = window.__conference
              return { wrapper: w?.id ?? null, inner: t?.peerId ?? t?.inner?.peerId ?? null, direct: w ? w._byPeer.size : null }
            })
            .catch((e) => ({ error: String(e).slice(0, 80) })),
        ),
      )
      console.log(`  [diag ${label}] partial mesh, first ${who.length}: ${who.map((x, i) => `p${peers[i].id} ${JSON.stringify(x)}`).join('  ')}`)
    }
    console.log(`  [diag ${label}] peer: links / roster size / maxConns / missing`)
    peers.forEach((p, i) => {
      const missing = peers.map((q) => `p${q.id}`).filter((n) => !rosters[i].includes(n))
      const maxConns = p.logs.map((l) => /maxConns: (\d+)/.exec(l)?.[1]).find(Boolean) ?? '-'
      if (missing.length > 0 || (adapter.mesh && !adapter.partial && linkCounts[i] < peers.length - 1))
        console.log(`    p${p.id}: ${linkCounts[i]} / ${rosters[i].length} / ${maxConns} / ${missing.join(' ') || '-'}`)
      // One or two missing on a mesh: what this peer's transport logged about THEM (by transport id).
      if (!adapter.partial && missing.length > 0 && missing.length <= DIAG_MAX_MISSING) presenceViews.push({ p, missing }) // relays too: what the core holds is the same question
      // A partial mesh: EVERY hole, its first two peers. One or two missing is the shape of a
      // linger / storm failure there (a ghost, a lost removal) - the old rule, "more than
      // DIAG_MAX_MISSING", printed nothing for exactly the case those runs produce.
      else if (adapter.partial && missing.length > 0) presenceViews.push({ p, missing: missing.slice(0, 2) })
      if (adapter.mesh && missing.length > 0 && missing.length <= DIAG_MAX_MISSING) {
        // Every id a page ever logged, not the first: a peer that slept or whose network changed
        // re-joined under a new one, and its old id says nothing about what happened afterwards.
        const loggedIds = (x) => [...new Set(x.logs.flatMap((l) => { const m = /peerId: ([\w-]+)/.exec(l); return m ? [m[1]] : [] }))]
        for (const name of missing) {
          const theirIds = loggedIds(peers.find((q) => `p${q.id}` === name) ?? { logs: [] })
          const id = theirIds[theirIds.length - 1]
          if (!id) continue
          console.log(`      p${p.id}'s log about ${name} (${theirIds.join(', ')}):`)
          // Lines with the other's full id, and the signaling lines between the two
          // (those carry the first 8 characters of both ids, and of nobody else's).
          const myIds = loggedIds(p)
          const q = peers.find((x) => `p${x.id}` === name)
          if (myIds.length === 0 || !q) continue
          const about = (others, selves) => (l) =>
            !/signal=candidate/.test(l) &&
            others.some((o) => l.includes(o) || (l.includes(o.slice(0, 8)) && selves.some((s) => l.includes(s.slice(0, 8)))))
          for (const l of p.logs.filter(about(theirIds, myIds)).slice(0, 60)) console.log('        ' + l.slice(0, 200))
          // ... and the other side: did THEIR link to this peer get replaced, open twice, fail to send?
          console.log(`      ${name}'s log about p${p.id} (${myIds.join(', ')}):`)
          for (const l of q.logs.filter(about(myIds, theirIds)).slice(0, 60)) console.log('        ' + l.slice(0, 200))
        }
      }
    })
    // ... and what its core holds for them, next to their own clock (playgrounds that expose __provider):
    // no meta = their presence never arrived; a clock >= theirs without a state = it arrived and lost.
    // A whole room short of the same peer would print the same story 25 times (and every entry
    // costs several evaluates in two pages): the first DIAG_MAX_VIEWS of them say it.
    if (presenceViews.length > DIAG_MAX_VIEWS)
      console.log(`    (${presenceViews.length} peers with a hole; details for the first ${DIAG_MAX_VIEWS})`)
    for (const { p, missing } of presenceViews.slice(0, DIAG_MAX_VIEWS)) {
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
        // Under ConferenceTransport (window.__conference): what the wrapper of each knows of the other's origin.
        const wrapperView = (page, otherPage) =>
          otherPage.evaluate(() => window.__conference?.id).then((otherId) =>
            page.evaluate((otherId) => {
              const w = window.__conference
              if (!w || !otherId) return null
              const o = w._origins.get(otherId)
              const links = Array.from(w._links.values()).map((l) => `${l.peer?.slice(0, 4) ?? '?'}:${l.lazy ? 'l' : 'e'}${l.eagerIn.has(otherId) ? (l.eagerIn.get(otherId) ? 'I' : 'i') : ''}${l.eagerOut.has(otherId) ? (l.eagerOut.get(otherId) ? 'O' : 'o') : ''}${l.leaf ? '(leaf)' : ''}`)
              return {
                origin: o ? { hw: o.hw, top: o.top, first: o.first, gone: o.gone, route: o.route?.slice(0, 8), unicasts: o.unicastSeen.length, firstSeen: o.firstSeen, fresh: o.freshUntil > Date.now() } : 'never heard',
                direct: w._byPeer.has(otherId),
                roomSize: w.roomSize,
                links,
                stats: w.stats,
                sent: w._seq,
                cached: w._cache.length,
              }
            }, otherId),
          )
        if (await p.page.evaluate(() => !!window.__conference)) {
          console.log(`      wrapper p${p.id} about ${name}: ${JSON.stringify(await wrapperView(p.page, q.page))}`)
          console.log(`      wrapper ${name} about p${p.id}: ${JSON.stringify(await wrapperView(q.page, p.page))}`)
        }
        // What each transport's table holds for the other (simple-peer's internals where there are any).
        // The LIVE id, from the page: `peerId:` is logged once, in the constructor, and a peer that
        // slept / changed its network re-joined under a new one - the logged id would look up nothing.
        // Under ConferenceTransport `transport` is the wrapper; its table is the inner transport's.
        const transportId = (x) =>
          x.page
            .evaluate(() => {
              const t = window.__provider?.transport
              return t?.peerId ?? t?.inner?.peerId ?? null
            })
            .catch(() => null)
        const entry = (page, remote) =>
          page.evaluate((remote) => {
            const t0 = window.__provider?.transport
            const t = t0?.peers ? t0 : t0?.inner
            const e = t?.peers?.get?.(remote)
            if (!e) return { entry: false, tableSize: t?.peers?.size }
            const sp = e.peer
            return {
              connected: e.connected,
              pc: window.__pcs?.indexOf(sp?._pc),
              channel: sp?._channel?.readyState,
              sp: sp && { initiator: sp.initiator, destroyed: sp.destroyed, destroying: sp.destroying, _connected: sp._connected, _connecting: sp._connecting, _pcReady: sp._pcReady, _channelReady: sp._channelReady },
            }
          }, remote)
        const [pTransportId, qTransportId] = await Promise.all([transportId(p), transportId(q)])
        if (pTransportId && qTransportId) {
          console.log(`      table entry p${p.id} (${pTransportId}) -> ${name} (${qTransportId}): ${JSON.stringify(await entry(p.page, qTransportId))}`)
          console.log(`      table entry ${name} -> p${p.id}: ${JSON.stringify(await entry(q.page, pTransportId))}`)
        }
        // The WebRTC connections between the two, paired by ICE ufrag: one or more? what was sent, what arrived?
        const [mine, theirPcs] = await Promise.all([pcView(p), pcView(q)])
        const pairs = mine.filter((a) => a.remote && theirPcs.some((b) => b.local === a.remote))
        console.log(`      connections p${p.id} <-> ${name}: ${pairs.length} (of ${mine.length} / ${theirPcs.length} RTCPeerConnections in the two pages)`)
        for (const a of pairs) {
          const b = theirPcs.find((x) => x.local === a.remote)
          console.log(`        p${p.id}#${a.i} ${a.conn}/${a.ice} [${a.dc.join('; ')}] js ${a.js}  <->  ${name}#${b.i} ${b.conn}/${b.ice} [${b.dc.join('; ')}] js ${b.js}`)
        }
      }
    }
    const seenBy = peers.map((q) => rosters.filter((r) => r.includes(`p${q.id}`)).length)
    const short = peers.filter((_, i) => seenBy[i] < peers.length)
    console.log(`    listed in fewer than ${peers.length} rosters: ${short.map((q) => `p${q.id}(${seenBy[peers.indexOf(q)]})`).join(' ') || 'nobody'}`)
  }

  let peers = []
  const others = (...gone) => peers.filter((p) => !gone.includes(p))
  // DIAG, for a wait on the rosters: how long they are right now, and which peers have the shortest.
  const rosterNote = async () => {
    const sizes = await Promise.all(peers.map((p) => roster(p).catch(() => NaN)))
    const min = Math.min(...sizes)
    const shortest = peers.filter((_, i) => sizes[i] === min).map((p) => `p${p.id}${p.firefox ? '(ff)' : ''}`)
    let note = `rosters ${JSON.stringify(stats(sizes))}, want ${peers.length}; shortest: ${shortest.slice(0, 8).join(' ')}${shortest.length > 8 ? ' ...' : ''}`
    // A roster LONGER than the room: who is the extra (by name - a reloaded or killed
    // tab's old entry says so), in the first such roster.
    const max = Math.max(...sizes)
    if (process.env.DIAG && max > peers.length) {
      const i = sizes.indexOf(max)
      const names = await peers[i].page
        .evaluate(() => Array.from(document.querySelectorAll('#user-list .user-badge span')).map((el) => el.textContent.replace(' (You)', '').trim()))
        .catch(() => [])
      const live = new Set(peers.map((q) => `p${q.id}`))
      const extra = names.filter((n) => !live.has(n))
      note += `; longest p${peers[i].id}${peers[i].firefox ? '(ff)' : ''} (${max}) has extra: ${extra.join(' ') || '(a live name twice)'}`
    }
    return note
  }
  try {
    console.log(`${TRANSPORT}: ${N} peers, room ${ROOM}`)

    // ---- join
    console.log('join')
    const tJoin = Date.now()
    const opening = []
    for (let i = 0; i < N; i++) {
      opening.push(open())
      await sleep(i === 0 ? 3000 : JOIN_GAP_MS) // the first peer opens the room (PeerJS: claims the coordinator id)
    }
    // A peer that could not join (the service refused it) is a result, not a crash.
    const opened = await Promise.allSettled(opening)
    peers = opened.filter((o) => o.status === 'fulfilled').map((o) => o.value)
    if (peers.length < N) record('join', 'peers that FAILED to join', `${N - peers.length} of ${N}`)
    record('join', 'all pages loaded and connected after', { ms: Date.now() - tJoin, ok: peers.length, of: N })
    if (FIREFOX > 0) record('join', process.env.FIREFOX_EACH ? 'peers in a Firefox of their own' : 'peers in Firefox (tabs of one)', peers.filter((p) => p.firefox).map((p) => `p${p.id}`).join(' '))
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
    // A data channel that opened and cannot send (simple-peer: repro-simple-peer-sleep part 7) - and was the link rebuilt?
    if (adapter.mesh) {
      // simple-peer transport / PeerJS itself (its DataConnection closes on it) / our peerjs transport /
      // the core, for a transport whose send() rejects (trystero)
      const threw = peers.filter((p) => p.logs.some((l) => /sendTo failed|Send failed|Error when sending|Error sending to peer|Error sending data/.test(l)))
      record('join', 'peers with a send that threw on an open link (console)', threw.length === 0 ? 0 : threw.map((p) => `p${p.id}`).join(' '))
    }
    await type(peers[0], 'hello-from-0 ')
    record('join', 'text of one peer in every editor', await untilAll(peers, async (p) => (await text(p)).includes('hello-from-0'), 60000))
    const tIdle = Date.now()
    await sleep(10000)
    record('join', 'frames sent by the whole room in 10 idle seconds', wire(tIdle))
    // IDLE_MS: leave the room entirely alone for that long - no evaluate(), nothing (the console is heard passively).
    if (process.env.IDLE_MS) await sleep(Number(process.env.IDLE_MS))

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

    // ---- oneway (opt-in, WebRTC transports): a link that cannot send, made on purpose
    if (wanted.includes('oneway') && adapter.mesh) {
      console.log('oneway (one peer cannot send to one other, then renames itself)')
      // How this page's DIRECT neighbours address it: under conference the wrapper's own id
      // (what a HELLO carries, and what `_byPeer` is keyed by - NOT the inner transport's peer
      // id, which is the key of `_links`), the transport's peer id otherwise.
      const addr = (p) =>
        p.page
          .evaluate(() => {
            const t = window.__provider?.transport
            return window.__conference?.id ?? t?.peerId ?? t?.inner?.peerId ?? null
          })
          .catch(() => null)
      // Does this page hold a direct link to that transport id? The wrapper's own table under
      // conference, the transport's peer table otherwise. null/false: not observable here.
      const holdsLink = (p, remoteId) =>
        p.page
          .evaluate((id) => {
            const w = window.__conference
            if (w) return w._byPeer.has(id)
            const t0 = window.__provider?.transport
            const t = t0?.peers ? t0 : t0?.inner
            const e = t?.peers?.get?.(id)
            return e ? e.connected !== false : false
          }, remoteId)
          .catch(() => null)
      // A partial mesh: the fixed pair p2/p3 usually has NO direct link at all - nothing would be
      // patched below, the rename would travel over the tree, and this scenario would record a
      // pass having tested nothing. Take a pair that is actually linked.
      let [a, b] = [peers[2], peers[3]]
      if (adapter.partial) {
        const addresses = await Promise.all(peers.map(addr))
        const byAddr = new Map(addresses.flatMap((id, i) => (id ? [[id, peers[i]]] : [])))
        let found = false
        for (const cand of peers.slice(2)) {
          const linked = await cand.page.evaluate(() => (window.__conference ? Array.from(window.__conference._byPeer.keys()) : [])).catch(() => [])
          const other = linked.map((id) => byAddr.get(id)).find((x) => x && x !== cand)
          if (other) {
            ;[a, b] = [other, cand]
            found = true
            break
          }
        }
        record('oneway', `a pair with a direct link: p${b.id} -> p${a.id}`, found ? 'chosen' : 'NONE FOUND - the fixed pair, which may have no direct link')
      }
      const observer = peers.find((p) => p !== a && p !== b) ?? peers[4]
      const aAddr = await addr(a)
      // Only worth polling for its return if we can see it at all right now.
      const linkObservable = aAddr ? (await holdsLink(b, aAddr)) === true : false
      const [aPcs, bPcs] = await Promise.all([pcView(a), pcView(b)])
      const mine = bPcs.filter((x) => x.remote && x.conn === 'connected' && aPcs.some((y) => y.local === x.remote))
      record('oneway', `connections between p${a.id} and p${b.id}`, mine.length)
      await b.page.evaluate((indexes) => {
        for (const i of indexes) {
          for (const ch of window.__pcs[i].__channels) {
            ch.send = () => {
              throw new DOMException("Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'", 'InvalidStateError')
            }
          }
        }
      }, mine.map((x) => x.i))
      const renamed = `p${b.id}-renamed`
      const t0 = Date.now()
      await fill(b.page, '#user-name', renamed)
      const sees = (p) =>
        p.page.evaluate((name) => Array.from(document.querySelectorAll('#user-list .user-badge span, #users-list li span')).some((el) => el.textContent.includes(name)), renamed)
      record('oneway', 'a third peer sees the new name', await untilAll([observer], sees, 30000))
      const seen = await untilAll([a], sees, 60000)
      record('oneway', `p${a.id} - the one it cannot send to - sees the new name`, seen.ms < 0 ? seen : { ...seen, ms: Date.now() - t0 })
      // The rule is "a transport must rebuild a link whose send() throws, never just log it" -
      // and on a FULL mesh the rename above proves it, because there is no other way round.
      // On a partial mesh there is: the name arrives over a tree path within half a second
      // whether or not anybody noticed the dead direction. So ask the sharp question directly.
      const dropped = b.logs.some((l) => /cannot send — dropping it|sendTo failed|Send failed|Error when sending|Error sending/.test(l))
      record('oneway', `p${b.id} noticed the dead direction and dropped the link (console)`, dropped)
      if (!dropped) for (const l of b.logs.slice(-15)) console.log('        ' + l.slice(0, 200))
      // Whether the two then dial EACH OTHER again is not required of a partial mesh: the dial
      // rule replaces a link only while the peer is under its target (p2 held 11 links after the
      // drop and wanted none). A number, not a verdict - on a full mesh it must come back.
      if (linkObservable) {
        const back = await untilAll([b], (p) => holdsLink(p, aAddr), adapter.partial ? 15000 : 60000)
        record('oneway', `p${b.id} holds a direct link to p${a.id} again${adapter.partial ? ' (a partial mesh need not)' : ''}`, back.ms < 0 ? back : { ...back, ms: Date.now() - t0 })
      }
      record('oneway', 'links per peer afterwards', stats(await Promise.all(peers.map(links))))
      record('oneway', 'peers whose transport said the page had slept, so far', resumed().join(' ') || 'nobody')
      await fill(b.page, '#user-name', `p${b.id}`) // the roster diagnosis goes by name
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
      // How long the ROOM takes to drop it splits into two very different halves: how long
      // the browser needs to admit that a link of a killed tab is dead (ICE: ~15 s in
      // Chrome, 25-30 s in Firefox, round 12), and what the transport does once it knows.
      // Measure the first half, so the second is not blamed for it.
      const linkDowns = () =>
        Promise.all(peers.map((p) => p.page.evaluate(() => window.__conference?.stats.linkDowns ?? null).catch(() => null))).then((xs) =>
          xs.some((x) => x !== null) ? xs.reduce((a, b) => a + (b ?? 0), 0) : null,
        )
      const downsBefore = await linkDowns()
      const killedAt = Date.now()
      await gone.page.close()
      peers = others(gone)
      if (downsBefore !== null) {
        const noticed = await untilAll([peers[0]], async () => (await linkDowns()) > downsBefore, adapter.vanishTimeoutMs)
        record('vanish', 'the first neighbour saw a link die (the browser admitting it, not the transport)', noticed.ms < 0 ? noticed : { ...noticed, ms: Date.now() - killedAt })
      }
      record('vanish', `every roster dropped the killed tab (${peers.length} users)`, await untilAll(peers, async (p) => (await roster(p)) === peers.length, adapter.vanishTimeoutMs, rosterNote))
    }

    // ---- sleep
    if (wanted.includes('sleep')) {
      console.log(`sleep (5 peers frozen for ${FREEZE_MS} ms)`)
      // Chrome peers only: the freeze goes through the DevTools protocol.
      const chrome = peers.filter((p) => !p.firefox)
      const sleepers = peers.length > 11 ? chrome.filter((p) => p.id >= 6).slice(0, 5) : chrome.slice(1, 2) // small N: one sleeper
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

    // ---- offline (opt-in): one page's network goes and comes back - the browser says so
    if (wanted.includes('offline')) {
      console.log(`offline (one peer without network for ${OFFLINE_MS / 1000} s)`)
      const p = peers.filter((q) => !q.firefox && q !== peers[0])[4] // Chrome only: through the DevTools protocol
      const cdp = await p.page.createCDPSession()
      await cdp.send('Network.enable')
      const net = (offline) => cdp.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
      await net(true)
      record('offline', `p${p.id}: navigator.onLine while cut off`, await p.page.evaluate(() => navigator.onLine))
      await sleep(1000)
      await type(peers[0], 'typed-while-offline ')
      await sleep(OFFLINE_MS - 1000)
      await net(false)
      const t0 = Date.now()
      record('offline', 'the returner has the text typed while it was offline (since online)', await untilAll([p], async (q) => (await text(q)).includes('typed-while-offline'), 90000))
      await type(p, 'typed-by-the-returner ')
      record('offline', 'a text the returner types in every editor', await untilAll(peers, async (q) => (await text(q)).includes('typed-by-the-returner'), 60000))
      await type(peers[0], 'typed-after-offline ')
      record('offline', 'a text typed afterwards reaches the returner', await untilAll([p], async (q) => (await text(q)).includes('typed-after-offline'), 60000))
      const full = await untilAll(peers, async (q) => (await roster(q)) === peers.length, 90000)
      record('offline', 'every roster complete (since online)', full.ms < 0 ? full : { ...full, ms: Date.now() - t0 })
      console.log(`    returner: p${p.id}`)
      await diag('after offline')
    }

    // ---- rejoin
    if (wanted.includes('rejoin')) {
      console.log('rejoin (one peer reloads)')
      const p = peers[Math.min(11, peers.length - 1)]
      const t0 = Date.now()
      await reload(p)
      record('rejoin', 'the reloaded peer has the room text', await untilAll([p], async (x) => (await text(x)).includes('hello-from-0'), 60000))
      const full = await untilAll(peers, async (x) => (await roster(x)) === peers.length, 150000, rosterNote)
      record('rejoin', 'every roster complete (since the reload)', full.ms < 0 ? full : { ...full, ms: Date.now() - t0 })
      if (full.ms < 0) await diag('after rejoin')
    }

    // ---- linger (opt-in): outlive a presence lease while peers keep coming and going
    if (wanted.includes('linger')) {
      const LINGER_MS = Number(process.env.LINGER_MS ?? 420000)
      const GAP_MS = Number(process.env.LINGER_GAP_MS ?? 55000)
      console.log(`linger (${LINGER_MS / 1000} s, one peer reloads, rosters checked ${GAP_MS / 1000} s later, then the next)`)
      const t0 = Date.now()
      const short = []
      let checks = 0
      for (let k = 0; Date.now() - t0 < LINGER_MS; k++, checks++) {
        await reload(peers[(12 + k) % peers.length])
        await sleep(GAP_MS)
        // Just before the next reload every roster has had GAP_MS to settle.
        const sizes = await Promise.all(peers.map(roster))
        const incomplete = sizes.filter((n) => n !== peers.length).length
        if (incomplete > 0) {
          short.push(`${Math.round((Date.now() - t0) / 1000)} s: ${incomplete} rosters, smallest ${Math.min(...sizes)}, largest ${Math.max(...sizes)}`)
          await diag(`linger, ${Math.round((Date.now() - t0) / 1000)} s, after reloading p${peers[(12 + k) % peers.length].id}`) // now, not once it healed
        }
      }
      record('linger', `moments with an incomplete roster (${GAP_MS / 1000} s after each reload, of ${checks})`, short.length === 0 ? 'none' : short)
    }

    // ---- storm (opt-in): sustained load - many typists, a presence storm, bulk inserts, faults under load
    if (wanted.includes('storm')) {
      const PHASES = (process.env.STORM ?? 'typing,cursor,bulk,faults').split(',')
      const TYPISTS = Number(process.env.STORM_TYPISTS ?? 10)
      const KEY_MS = Number(process.env.STORM_KEY_MS ?? 250)
      const STORM_MS = Number(process.env.STORM_S ?? 60) * 1000
      const CURSOR_HZ = Number(process.env.STORM_CURSOR_HZ ?? 5)
      const BULK_KB = Number(process.env.STORM_BULK_KB ?? 100)
      const q = (xs, f) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * f))])
      const pct = (xs) => ({ samples: xs.length, p50: q(xs, 0.5), p95: q(xs, 0.95), max: q(xs, 1) })
      // Typists: Chrome peers (a hidden Firefox tab clamps its timers), never peers[0], never the
      // ones the fault phase freezes or reloads.
      const chrome = peers.filter((p) => !p.firefox && p !== peers[0])
      const typists = chrome.slice(0, TYPISTS)
      const listeners = peers.filter((p) => !typists.includes(p))

      // In every page: which token it saw first when (tokens ⟦typist.n⟧ in the editor's Y.Text,
      // scanned at most every 100 ms), and the awareness states of the presence storm.
      const install = (p) =>
        p.page.evaluate(() => {
          if (window.__storm) return
          const pr = window.__provider
          const yt = pr.doc.getText('quill')
          const st = (window.__storm = { seen: {}, aw: [], awSeq: {} })
          let pending = false
          const scan = () => {
            pending = false
            const now = Date.now()
            for (const m of yt.toString().matchAll(/⟦([\w.]+)⟧/g)) if (st.seen[m[1]] === undefined) st.seen[m[1]] = now
          }
          yt.observe(() => {
            if (!pending) (pending = true), setTimeout(scan, 100)
          })
          scan()
          pr.awareness.on('change', ({ added, updated }) => {
            const now = Date.now()
            for (const id of [...added, ...updated]) {
              if (id === pr.doc.clientID) continue
              const s = pr.awareness.getStates().get(id)?.storm
              if (!s || st.awSeq[id] === s.seq) continue
              st.awSeq[id] = s.seq
              st.aw.push(now - s.t)
            }
          })
        })
      // One typist: its own paragraph, one character every keyMs, a token = ⟦id.n⟧ (a relative
      // position keeps it contiguous while nine others type elsewhere). Resolves with when each
      // token was complete.
      const typeFor = (p, ms, prefix) =>
        p.page.evaluate(
          (id, keyMs, ms) =>
            new Promise((done) => {
              const pr = window.__provider
              const Y = window.__Y
              const yt = pr.doc.getText('quill')
              yt.insert(yt.length, '\n')
              let rel = Y.createRelativePositionFromTypeIndex(yt, yt.length, -1)
              const typed = {}
              let n = 0
              let i = 0
              const end = Date.now() + ms
              const timer = setInterval(() => {
                if (i === 0 && Date.now() >= end) return clearInterval(timer), done(typed)
                const token = `⟦${id}.${n}⟧`
                const at = Y.createAbsolutePositionFromRelativePosition(rel, pr.doc)?.index ?? yt.length
                yt.insert(at, token[i])
                rel = Y.createRelativePositionFromTypeIndex(yt, at + 1, -1)
                if (++i === token.length) (typed[`${id}.${n}`] = Date.now()), n++, (i = 0)
              }, keyMs)
            }),
          `${prefix}${p.id}`, // tokens unique across phases: t3.17, b3.17, f3.17
          KEY_MS,
          ms,
        )
      /** every token typed reached every page? lag = first seen - typed, over (token, other page) */
      const collect = async (typedBy, among) => {
        const seen = await Promise.all(among.map((p) => p.page.evaluate(() => window.__storm?.seen ?? {}).catch(() => ({}))))
        const lags = []
        let missing = 0
        let pairs = 0
        typedBy.forEach(({ p, typed }) =>
          among.forEach((o, j) => {
            if (o === p) return
            for (const [k, t] of Object.entries(typed)) {
              pairs++
              if (seen[j][k] === undefined) missing++
              else lags.push(Math.max(0, seen[j][k] - t))
            }
          }),
        )
        return { lags, missing, pairs }
      }
      const allHave = (typedBy) => {
        const keys = typedBy.flatMap(({ typed }) => Object.keys(typed))
        return untilAll(peers, (p) => p.page.evaluate((keys) => keys.every((k) => window.__storm?.seen[k] !== undefined), keys), 120000)
      }
      const typing = async (label, ms, prefix, during = async () => {}) => {
        await Promise.all(peers.map(install))
        const t0 = Date.now()
        const [typed] = await Promise.all([Promise.all(typists.map((p) => typeFor(p, ms, prefix).then((typed) => ({ p, typed })))), during(t0)])
        const tEnd = Date.now()
        const total = typed.reduce((n, { typed }) => n + Object.keys(typed).length, 0)
        record(label, `tokens typed (${typists.length} typists, a character every ${KEY_MS} ms, ${ms / 1000} s)`, total)
        record(label, 'frames sent by the whole room while typing', wire(t0, tEnd))
        const done = await allHave(typed)
        record(label, 'every token in every editor (since the typing ended)', done.ms < 0 ? done : { ...done, ms: Date.now() - tEnd })
        const { lags, missing, pairs } = await collect(typed, peers)
        record(label, 'lag typed -> seen elsewhere, ms (100 ms resolution)', pct(lags))
        record(label, 'tokens missing somewhere at the end (of token x page pairs)', `${missing} of ${pairs}`)
        const ids = await Promise.all(peers.map((p) => p.page.evaluate(() => window.__provider.doc.getText('quill').toString())))
        record(label, 'documents identical (Y.Text)', new Set(ids).size === 1)
        return { typed, tEnd }
      }

      if (PHASES.includes('typing')) {
        console.log(`storm: typing (${typists.length} typists for ${STORM_MS / 1000} s)`)
        await typing('storm typing', STORM_MS, 't')
      }

      if (PHASES.includes('cursor')) {
        console.log(`storm: cursor (every peer changes its presence ${CURSOR_HZ} times a second for ${STORM_MS / 2000} s)`)
        await Promise.all(peers.map(install))
        await Promise.all(peers.map((p) => p.page.evaluate(() => (window.__storm.aw = []))))
        const t0 = Date.now()
        await Promise.all(
          peers.map((p) =>
            p.page.evaluate(
              (hz, ms) =>
                new Promise((done) => {
                  const aw = window.__provider.awareness
                  let seq = 0
                  const end = Date.now() + ms
                  const timer = setInterval(() => {
                    if (Date.now() >= end) return clearInterval(timer), done()
                    aw.setLocalStateField('storm', { seq: ++seq, t: Date.now() })
                  }, 1000 / hz)
                }),
              CURSOR_HZ,
              STORM_MS / 2,
            ),
          ),
        )
        const tEnd = Date.now()
        await sleep(3000)
        const got = await Promise.all(peers.map((p) => p.page.evaluate(() => window.__storm.aw)))
        const lags = got.flat()
        const sent = peers.length * CURSOR_HZ * (STORM_MS / 2000)
        record('storm cursor', 'frames sent by the whole room', wire(t0, tEnd))
        record('storm cursor', 'presence changes made (all peers)', Math.round(sent))
        record('storm cursor', 'presence changes seen per peer and second (of other peers)', Math.round((lags.length / peers.length / (STORM_MS / 2000)) * 10) / 10)
        record('storm cursor', 'lag changed -> seen elsewhere, ms', pct(lags))
        const full = await untilAll(peers, async (p) => (await roster(p)) === peers.length, 30000)
        record('storm cursor', 'every roster complete afterwards', full)
      }

      if (PHASES.includes('bulk')) {
        const blocks = 3
        console.log(`storm: bulk (${blocks} inserts of ${BULK_KB} KB while ${typists.length} peers type for ${STORM_MS / 2000} s)`)
        const inserter = peers[0]
        const marks = []
        await typing('storm bulk', STORM_MS / 2, 'b', async (t0) => {
          for (let b = 0; b < blocks; b++) {
            await sleep(STORM_MS / 2 / (blocks + 1))
            const at = await inserter.page.evaluate(
              (kb, b) => {
                const yt = window.__provider.doc.getText('quill')
                const line = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
                // At the very start, far from every typist: appended at the end (after the last
                // character the inserter knew of) a block could land inside a token the last
                // typist was typing there at the same moment - Yjs orders the two concurrent
                // inserts by client id; right for a CRDT, invisible to the token scan.
                yt.insert(0, line.repeat(Math.ceil((kb * 1024) / line.length)) + `⟦bulk.${b}⟧\n`)
                return Date.now()
              },
              BULK_KB,
              b,
            )
            marks.push({ b, at })
          }
        })
        const seen = await Promise.all(peers.map((p) => p.page.evaluate(() => window.__storm.seen)))
        const arrive = marks.map(({ b, at }) => {
          const ms = seen.filter((s, j) => peers[j] !== inserter).map((s) => (s[`bulk.${b}`] === undefined ? Infinity : s[`bulk.${b}`] - at))
          return Math.max(...ms)
        })
        record('storm bulk', `each ${BULK_KB} KB insert in every editor after, ms (100 ms resolution)`, arrive.map((ms) => (ms === Infinity ? 'NEVER' : ms)))
      }

      if (PHASES.includes('faults')) {
        const FAULT_MS = Math.max(STORM_MS, 90000)
        console.log(`storm: faults (${typists.length} peers type for ${FAULT_MS / 1000} s; meanwhile a reload, three frozen pages, one typist offline, the server restarted)`)
        const spare = listeners.filter((p) => !p.firefox && p !== peers[0])
        const reloaded = spare[0]
        const frozen = spare.slice(1, 4)
        const offline = typists[typists.length - 1]
        await typing('storm faults', FAULT_MS, 'f', async (t0) => {
          const at = (s) => sleep(Math.max(0, t0 + s * 1000 - Date.now()))
          await at(10)
          console.log(`    ${Math.round((Date.now() - t0) / 1000)} s: p${reloaded?.id} reloads`)
          if (reloaded) await reload(reloaded).then(() => install(reloaded))
          await at(20)
          console.log(`    ${Math.round((Date.now() - t0) / 1000)} s: ${frozen.map((p) => 'p' + p.id).join(' ')} frozen for 40 s`)
          const sessions = await Promise.all(frozen.map((p) => p.page.createCDPSession()))
          await Promise.all(sessions.map((s) => s.send('Page.setWebLifecycleState', { state: 'frozen' })))
          await at(30)
          console.log(`    ${Math.round((Date.now() - t0) / 1000)} s: p${offline.id} (a typist) offline for 20 s`)
          const cdp = await offline.page.createCDPSession()
          await cdp.send('Network.enable')
          const net = (o) => cdp.send('Network.emulateNetworkConditions', { offline: o, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
          await net(true)
          await at(50)
          await net(false)
          console.log(`    ${Math.round((Date.now() - t0) / 1000)} s: p${offline.id} online again`)
          await at(60)
          await Promise.all(sessions.map((s) => s.send('Page.setWebLifecycleState', { state: 'active' })))
          console.log(`    ${Math.round((Date.now() - t0) / 1000)} s: unfrozen; the server is down for 5 s`)
          server.stop()
          await at(65)
          server.start()
          console.log(`    ${Math.round((Date.now() - t0) / 1000)} s: the server is back`)
        })
        const full = await untilAll(peers, async (p) => (await roster(p)) === peers.length, 150000)
        record('storm faults', 'every roster complete afterwards', full)
        if (full.ms < 0) await diag('after storm faults')
      }
    }

    // ---- restart
    if (wanted.includes('restart')) {
      console.log(`restart (server down for ${OUTAGE_MS / 1000} s)`)
      server.stop()
      await sleep(1000)
      await type(peers[3], 'typed-during-outage ') // unsent: no transport queues for a dead link
      await sleep(OUTAGE_MS - 1000)
      server.start()
      const tBack = Date.now()
      record('restart', 'text typed DURING the outage in every editor (since the restart)', await untilAll(peers, async (p) => (await text(p)).includes('typed-during-outage'), 90000))
      // Not polled from the restart on: right after it every roster is still whole (nobody
      // has noticed anything yet); what the return costs comes after - Ably's presence
      // reports the leave of every dropped connection ~15 s later.
      const backRosters = await untilAll(peers, async (p) => (await roster(p)) === peers.length, 150000)
      record('restart', `every roster complete again (${peers.length} users, since the restart)`, backRosters.ms < 0 ? backRosters : { ...backRosters, ms: Date.now() - tBack })
      if (process.env.DIAG) await diag('after the restart')
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
    if (adapter.mesh) {
      record('final', 'peers whose transport said the page had slept (the frozen ones should, nobody else)', resumed().join(' ') || 'nobody')
      // When, and by how much: every such line of the peers that were never frozen (DIAG=1).
      if (process.env.DIAG) {
        for (const p of peers.filter((q) => q.firefox)) {
          for (const l of p.logs.filter((l) => l.includes('Page slept'))) console.log(`    p${p.id}(ff) ${l.slice(0, 150)}`)
          // ... and what the page's own probe saw (see METER)
          const probe = await p.page.evaluate(() => ({ gaps: window.__gaps, visibility: window.__visibility })).catch(() => null)
          if (probe) console.log(`    p${p.id}(ff) timer gaps > 5 s: ${probe.gaps.join(' | ') || 'none'}   visibility: ${probe.visibility.join(' -> ')}`)
        }
      }
    }
    // DUMP_LOGS=p6,p11: the last console lines of those peers (warnings, errors, transport debug).
    for (const name of (process.env.DUMP_LOGS ?? '').split(',').filter(Boolean)) {
      const p = peers.find((q) => `p${q.id}` === name)
      console.log(`  [logs ${name}]`)
      // DUMP_GREP=regex: only the lines that match (a flood of one warning hides the rest)
      const only = process.env.DUMP_GREP ? new RegExp(process.env.DUMP_GREP) : null
      for (const l of (p?.logs ?? []).filter((l) => (only ? only.test(l) : process.env.DUMP_ALL || !/Sync|awareness|Awareness|📥|📤/.test(l))).slice(-Number(process.env.DUMP_N ?? 25))) console.log('    ' + l.slice(0, 220))
    }
    await diag('final')
    const texts = await Promise.all(peers.map(text))
    record('final', 'editors identical', new Set(texts).size === 1)
    // The editors are what a user sees, but innerText is the browser's rendering (a Firefox
    // editor typed into here ends three newlines short of the same document in Chrome):
    // where the playground exposes its provider, compare the shared text itself.
    const docs = await Promise.all(peers.map((p) => p.page.evaluate(() => window.__provider?.doc.getText('quill').toString() ?? null)))
    if (docs.every((d) => d !== null)) record('final', 'documents identical (Y.Text)', new Set(docs).size === 1)
    if (new Set(texts).size > 1) {
      // Who holds which text: length, and the first place where it differs from the most common one.
      const groups = new Map()
      texts.forEach((t, i) => groups.set(t, [...(groups.get(t) ?? []), `p${peers[i].id}${peers[i].firefox ? '(ff)' : ''}`]))
      const [common] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0]
      for (const [t, who] of groups) {
        let at = 0
        while (at < t.length && at < common.length && t[at] === common[at]) at++
        console.log(`    ${who.length} peer(s), ${t.length} characters${t === common ? '' : `, differs at ${at}: ${JSON.stringify(t.slice(at, at + 24))} vs ${JSON.stringify(common.slice(at, at + 24))}`}: ${who.join(' ')}`)
      }
    }
    record('final', 'sends the backend refused (console, whole run)', peers.reduce((n, p) => n + refused(p), 0))
    // ... and what they were: one line per kind (timestamps and numbers stripped), with its count.
    const kinds = new Map()
    for (const p of peers)
      for (const l of p.logs.filter((l) => /Protocol\.onNack|\[PubNubTransport\] ❌/.test(l))) {
        const k = l.slice(10, 170).replace(/\d+/g, '#')
        kinds.set(k, (kinds.get(k) ?? 0) + 1)
      }
    for (const [k, n] of kinds) console.log(`    ${n} x ${k}`)
    if (adapter.partial) {
      // Did the wrapper's departure machinery run at all? A link that died, a SUSPECT planned,
      // a SUSPECT sent - three numbers that say which step is missing when a ghost survives.
      const st = await Promise.all(peers.map((p) => p.page.evaluate(() => window.__conference?.stats ?? null).catch(() => null)))
      const sum = (k) => st.reduce((a, s) => a + (s?.[k] ?? 0), 0)
      record('final', 'wrapper: links died / SUSPECTs planned / SUSPECTs sent (whole room)', `${sum('linkDowns')} / ${sum('suspectsScheduled')} / ${sum('suspects')}`)
      // ... and where the ones that never became a broadcast went (see ConferenceTransport.stats)
      record(
        'final',
        'wrapper: a dead link that did NOT end in a SUSPECT, by reason',
        `noPeer ${sum('skipNoPeer')}, relinked ${sum('skipRelinked')}, lastLink ${sum('skipLastLink')}, alreadyGone ${sum('skipGone')}, NEVER-KNEW-IT ${sum('skipNoOrigin')}, pending ${sum('skipPending')}, othersFirst ${sum('skipOthersFirst')} - departures learned from a C_LEAVE: ${sum('goneByLeave')}`,
      )
    }
    record('final', 'rosters', stats(await Promise.all(peers.map(roster))))
    if (adapter.mesh) record('final', 'links per peer', stats(await Promise.all(peers.map(links))))
  } finally {
    if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(results, null, 2))
    await browser.close().catch(() => {})
    await Promise.all(firefoxes.map((f) => f.close().catch(() => {})))
    server.stop()
    parcel.kill('SIGKILL')
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
