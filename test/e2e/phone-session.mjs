/**
 * E2E with a REAL phone: a room of headless Chrome peers on this machine, and
 * one phone that joins over the LAN by hand. What room-scenarios.mjs cannot do:
 * its "sleep" freezes a page through the DevTools protocol, which stops the
 * page's timers and leaves Chrome's network thread - and so the links - alive.
 * A phone whose browser goes to the background, or whose display goes off,
 * loses them.
 *
 * Nobody presses Enter here (the script runs unattended): it watches, and the
 * phone tells on itself. Opened with `?phone` the playground takes its
 * signaling server from the page's own host, names itself "phone", and writes
 * into its presence state what it sees of itself - the length of its document,
 * and every change of document.visibilityState with how long it was hidden.
 * The desktop peers read that report from their awareness. One of them types a
 * character every TYPE_MS, so there is always something the phone can have
 * missed.
 *
 * Printed as it happens, with seconds since the start:
 *   phone in the roster / gone from the roster / back (as the desktop peers see it)
 *   phone hidden / visible again after N s (as the phone reports it)
 *   phone has caught up: its document as long as the room's, N ms after it came back
 * and at the end, per absence: how long, whether the room dropped the phone,
 * how long until it was back in every roster and had the text.
 *
 * What to do with the phone (same WiFi as this machine), once "READY" shows:
 *   1. open the printed address, wait until it says the phone is in the roster
 *   2. another app in front for ~30 s, come back, wait ~20 s
 *   3. display off for ~60 s, come back, wait ~20 s
 *   4. display off for ~3 min (longer than the 30 s after which a room drops a silent link), come back
 *   5. type a word on the phone
 *
 * Usage: PUPPETEER=/path/to/puppeteer-core node test/e2e/phone-session.mjs [simple-peer]
 *   PEERS=8 MINUTES=12 TYPE_MS=4000 LAN_IP=192.168.x.y APP_PORT=3450 SERVER_PORT=4470 OUT=timeline.json
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER ?? 'puppeteer-core')

const TRANSPORT = process.argv[2] ?? 'simple-peer'
if (TRANSPORT !== 'simple-peer') throw new Error('only simple-peer so far: its playground understands ?phone')
const PEERS = Number(process.env.PEERS ?? 8)
const MINUTES = Number(process.env.MINUTES ?? 12)
const TYPE_MS = Number(process.env.TYPE_MS ?? 4000)
const APP_PORT = Number(process.env.APP_PORT ?? 3450)
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 4470)
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
const LAN_IP =
  process.env.LAN_IP ??
  Object.values(networkInterfaces())
    .flat()
    .find((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('172.'))?.address
if (!LAN_IP) throw new Error('no LAN address found - pass LAN_IP=')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const t0 = Date.now()
const timeline = []
const say = (what, extra = {}) => {
  const s = Math.round((Date.now() - t0) / 100) / 10
  timeline.push({ s, what, ...extra })
  console.log(`  [${String(s).padStart(6)} s] ${what}`)
}

async function main() {
  const signaling = spawn('node', ['node_modules/y-webrtc/bin/server.js'], { env: { ...process.env, PORT: String(SERVER_PORT) }, stdio: 'ignore' })
  const parcel = spawn(
    'node',
    ['node_modules/.bin/parcel', 'serve', 'test/simple-peer/index.html', '--dist-dir', mkdtempSync(join(tmpdir(), 'ygen-phone-')), '--port', String(APP_PORT), '--host', '0.0.0.0', '--no-hmr'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('parcel did not start')), 120000)
    parcel.stdout.on('data', (d) => String(d).includes('Built in') && (clearTimeout(t), resolve()))
  })
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })

  try {
    // The desktop peers use the LAN address too: one room, one signaling server, and
    // host candidates the phone can reach (no loopback, mDNS names left as they are).
    const peers = []
    for (let i = 0; i < PEERS; i++) {
      const page = await (await browser.createBrowserContext()).newPage()
      await page.goto(`http://${LAN_IP}:${APP_PORT}/?desk=d${i}&sig=${SERVER_PORT}`, { waitUntil: 'load' })
      await page.waitForSelector('.ql-editor', { timeout: 60000 })
      peers.push(page)
      await sleep(200)
    }
    const watcher = peers[0]
    const typist = peers[1]
    console.log(`\nREADY - ${PEERS} desktop peers in the room. On the phone (same WiFi) open:\n\n    http://${LAN_IP}:${APP_PORT}/?phone${SERVER_PORT === 4470 ? '' : `&sig=${SERVER_PORT}`}\n`)
    say('watching')

    /** What peer d0 knows of the phone: is it in the awareness, and what does it report of itself? */
    const look = () =>
      watcher.evaluate(() => {
        const pr = window.__provider
        const entry = Array.from(pr.awareness.getStates().entries()).find(([, s]) => s.user?.name === 'phone')
        return { present: !!entry, report: entry?.[1].report ?? null, roomLen: pr.doc.getText('quill').length, links: pr.transport.connectedPeers }
      })
    const everywhere = async () => (await Promise.all(peers.map((p) => p.evaluate(() => Array.from(window.__provider.awareness.getStates().values()).some((s) => s.user?.name === 'phone'))))).every(Boolean)

    let present = false
    let lastReport = null
    let absences = [] // { hiddenForS, droppedAtS, backAtS, caughtUpMs, inEveryRosterMs }
    let open = null // the absence that is being resolved
    let nextType = Date.now() + TYPE_MS
    let typed = 0
    const end = Date.now() + MINUTES * 60000
    while (Date.now() < end) {
      if (Date.now() >= nextType) {
        nextType += TYPE_MS
        await typist.click('.ql-editor')
        await typist.keyboard.type('.')
        typed++
      }
      const now = await look()
      if (now.present !== present) {
        present = now.present
        say(present ? 'phone in the roster' : 'phone GONE from the roster', { links: now.links })
        if (!present && open === null) open = { droppedAtS: (Date.now() - t0) / 1000 }
        else if (!present && open && open.droppedAtS === undefined) open.droppedAtS = (Date.now() - t0) / 1000
      }
      const r = now.report
      if (r && (!lastReport || r.seq !== lastReport.seq)) {
        if (r.event === 'hidden') {
          say('phone reports: hidden')
          open = open ?? {}
        } else if (r.event === 'visible') {
          say(`phone reports: visible again after ${r.hiddenForS} s`)
          open = { ...(open ?? {}), hiddenForS: r.hiddenForS, backAt: Date.now() }
        }
        lastReport = r
      }
      // An absence is over when the phone is in EVERY roster and its document is as long as the room's.
      if (open?.backAt && present && r && r.len >= now.roomLen) {
        if (open.caughtUpMs === undefined) {
          open.caughtUpMs = Date.now() - open.backAt
          say(`phone has caught up (${r.len} characters) ${open.caughtUpMs} ms after it came back`)
        }
        if (await everywhere()) {
          open.inEveryRosterMs = Date.now() - open.backAt
          say(`phone in every roster ${open.inEveryRosterMs} ms after it came back`)
          absences.push(open)
          open = null
        }
      }
      await sleep(500)
    }

    console.log('\nabsences (hidden for / dropped by the room / document caught up / in every roster again):')
    for (const a of absences) {
      console.log(
        `  ${String(a.hiddenForS ?? '?').padStart(5)} s   ${a.droppedAtS !== undefined ? 'dropped' : 'kept   '}   ${String(a.caughtUpMs ?? '-').padStart(6)} ms   ${String(a.inEveryRosterMs ?? '-').padStart(6)} ms`,
      )
    }
    if (open) console.log(`  one absence never resolved: ${JSON.stringify(open)}`)
    const final = await look()
    console.log(`at the end: phone present = ${final.present}, its document ${final.report?.len ?? '?'} of ${final.roomLen} characters, ${typed} characters typed by the room`)
    if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ absences, timeline }, null, 2))
  } finally {
    await browser.close().catch(() => {})
    signaling.kill('SIGKILL')
    parcel.kill('SIGKILL')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
