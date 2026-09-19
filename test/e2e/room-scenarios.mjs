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
 *              WebSocket relay) is killed for 5 s and restarted. Until a
 *              text typed afterwards is everywhere; then a NEW peer joins:
 *              until it has the text and every roster shows it.
 *  coordinator (peerjs only) the tab of the room's coordinator is killed,
 *              then a new peer joins. Until every roster is complete.
 *
 * Usage: node test/e2e/room-scenarios.mjs <simple-peer|peerjs|trystero|websocket>
 *   N=25 FREEZE_MS=20000 SCENARIOS=join,typing,... OUT=results.json override.
 *
 * Needs (none of it is a dependency of this package):
 *   puppeteer-core + a Chrome     PUPPETEER=/path/to/puppeteer-core  CHROME=/usr/bin/google-chrome
 *   simple-peer: nothing else (y-webrtc's bin/server.js is a devDependency)
 *   peerjs:      a PeerJS server binary     PEERJS_BIN=/path/to/node_modules/.bin/peerjs   (npm install peer)
 *   trystero:    nothing else (a minimal NIP-01 relay runs in this process; strategy nostr)
 *   websocket:   a y-websocket style server  WS_SERVER_JS=/path/to/edrys-websocket-server/src/server.js
 *                (git clone https://github.com/edrys-labs/edrys-websocket-server && npm install --omit=dev)
 * The playground itself is served by this script (parcel serve, own dist dir).
 */

import { spawn } from 'node:child_process'
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

function spawned(cmd, args, env = {}) {
  let child
  return {
    start() {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore' })
    },
    stop() {
      child?.kill('SIGKILL')
    },
  }
}

/** NIP-01, as much of it as Trystero's nostr strategy uses: REQ {kinds, "#x"}, EVENT, CLOSE. */
function nostrRelay(port) {
  let wss
  return {
    start() {
      wss = new WebSocketServer({ port })
      wss.on('connection', (ws) => {
        ws.subs = new Map()
        ws.on('message', (raw) => {
          let msg
          try {
            msg = JSON.parse(raw.toString())
          } catch {
            return
          }
          if (msg[0] === 'REQ') {
            ws.subs.set(msg[1], msg[2] ?? {})
            ws.send(JSON.stringify(['EOSE', msg[1]]))
          } else if (msg[0] === 'CLOSE') {
            ws.subs.delete(msg[1])
          } else if (msg[0] === 'EVENT') {
            const ev = msg[1]
            ws.send(JSON.stringify(['OK', ev.id, true, '']))
            const topics = (ev.tags ?? []).filter((t) => t[0] === 'x').map((t) => t[1])
            for (const client of wss.clients) {
              if (client.readyState !== 1 || !client.subs) continue
              for (const [id, f] of client.subs) {
                const kindOk = !f.kinds || f.kinds.includes(ev.kind)
                const topicOk = !f['#x'] || f['#x'].some((x) => topics.includes(x))
                if (kindOk && topicOk) client.send(JSON.stringify(['EVENT', id, ev]))
              }
            }
          }
        })
      })
    },
    stop() {
      for (const c of wss?.clients ?? []) c.terminate()
      wss?.close()
    },
  }
}

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
const links = (p) => p.page.evaluate(() => Number(document.getElementById('peer-count').textContent))
const text = (p) => p.page.evaluate(() => document.querySelector('.ql-editor').innerText)

/** ms until pred holds for every peer; -1 on timeout (and how many were short of it). */
async function untilAll(peers, pred, timeoutMs) {
  const t0 = Date.now()
  let ok = 0
  while (Date.now() - t0 < timeoutMs) {
    const results = await Promise.all(peers.map((p) => pred(p).catch(() => false)))
    ok = results.filter(Boolean).length
    if (ok === peers.length) return { ms: Date.now() - t0, ok, of: peers.length }
    await sleep(400)
  }
  return { ms: -1, ok, of: peers.length }
}
const fmt = (r) => (r.ms < 0 ? `NEVER (${r.ok} of ${r.of} in time)` : `${r.ms} ms`)

async function type(peer, str) {
  await peer.page.click('.ql-editor')
  await peer.page.keyboard.type(str)
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
    ],
  })

  let serial = 0
  const open = async () => {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    const peer = { id: serial++, page, logs: [] }
    page.on('console', (m) => peer.logs.push(`${new Date().toISOString().slice(14, 23)} [${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => peer.logs.push(`${new Date().toISOString().slice(14, 23)} [pageerror] ${e.message}`))
    await adapter.prepare(page)
    await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'load' })
    await adapter.join(page)
    await page.waitForSelector('.ql-editor', { timeout: 60000 })
    // A name per peer, so a roster says WHO is missing (see diag()).
    await fill(page, '#user-name', `p${peer.id}`).catch(() => {})
    return peer
  }

  /** DIAG=1: who is missing from whose roster, links and (simple-peer) maxConns per peer. */
  const diag = async (label) => {
    if (!process.env.DIAG) return
    const names = (p) =>
      p.page.evaluate((self) => {
        const mesh = Array.from(document.querySelectorAll('#user-list .user-badge span'))
        if (mesh.length > 0) return mesh.map((el) => el.textContent.replace(' (You)', '').trim())
        return [self, ...Array.from(document.querySelectorAll('#users-list li span')).map((el) => el.textContent.trim())]
      }, `p${p.id}`)
    const rosters = await Promise.all(peers.map(names))
    const linkCounts = await Promise.all(peers.map(links))
    console.log(`  [diag ${label}] peer: links / roster size / maxConns / missing`)
    peers.forEach((p, i) => {
      const missing = peers.map((q) => `p${q.id}`).filter((n) => !rosters[i].includes(n))
      const maxConns = p.logs.map((l) => /maxConns: (\d+)/.exec(l)?.[1]).find(Boolean) ?? '-'
      if (missing.length > 0 || linkCounts[i] < peers.length - 1)
        console.log(`    p${p.id}: ${linkCounts[i]} / ${rosters[i].length} / ${maxConns} / ${missing.join(' ') || '-'}`)
    })
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
    peers = await Promise.all(opening)
    record('join', 'all pages loaded and connected after', { ms: Date.now() - tJoin, ok: N, of: N })
    record('join', `every roster shows ${N} users`, await untilAll(peers, async (p) => (await roster(p)) === N, 180000))
    await sleep(3000)
    record('join', 'links per peer (peer-count)', stats(await Promise.all(peers.map(links))))
    await diag('after join')
    await type(peers[0], 'hello-from-0 ')
    record('join', 'text of one peer in every editor', await untilAll(peers, async (p) => (await text(p)).includes('hello-from-0'), 60000))

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
      const texts = await Promise.all(peers.map(text))
      record('typing', 'editors identical', new Set(texts).size === 1)
    }

    // ---- vanish
    if (wanted.includes('vanish')) {
      console.log('vanish')
      const gone = peers[N - 1]
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
      await p.page.reload({ waitUntil: 'load' })
      await adapter.join(p.page)
      await p.page.waitForSelector('.ql-editor', { timeout: 60000 })
      await fill(p.page, '#user-name', `p${p.id}`).catch(() => {})
      record('rejoin', 'the reloaded peer has the room text', await untilAll([p], async (x) => (await text(x)).includes('hello-from-0'), 60000))
      const full = await untilAll(peers, async (x) => (await roster(x)) === peers.length, 150000)
      record('rejoin', 'every roster complete (since the reload)', full.ms < 0 ? full : { ...full, ms: Date.now() - t0 })
    }

    // ---- restart
    if (wanted.includes('restart')) {
      console.log('restart (server down for 5 s)')
      server.stop()
      await sleep(5000)
      server.start()
      await sleep(12000) // the clients' reconnect backoff
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
