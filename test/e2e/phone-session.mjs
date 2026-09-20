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
 *   the phone's own log, one entry per absence (it stays in the report - the first
 *   session lost every "visible again" to the text report that followed it): hidden
 *   for N s, links before / at the return / fewest after it (fewer than before = the
 *   links were rebuilt), all links back after N ms, first missed text after N ms -
 *   measured by the phone on its own clock
 * and both once more at the end.
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
    let said = [] // what was last printed per absence of the phone's own log
    let phoneLog = []
    const roster = [] // { s, present } as the desktop peers see it
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
        const all = present ? await everywhere() : false
        say(present ? `phone in the roster${all ? ' (every roster)' : ''}` : 'phone GONE from the roster', { links: now.links })
        roster.push({ s: Math.round((Date.now() - t0) / 100) / 10, present })
      }
      // The phone's own log of its absences: printed whenever an entry appears or gains a number.
      if (now.report?.absences) {
        phoneLog = now.report.absences
        phoneLog.forEach((a, i) => {
          const line =
            `phone, absence ${i + 1}: hidden for ${a.hiddenForS} s, links ${a.linksBefore} before / ${a.linksAtReturn} at return / fewest ${a.fewestLinks}` +
            `${a.linksBackMs !== undefined ? `, all links back after ${a.linksBackMs} ms` : ''}${a.firstTextMs !== undefined ? `, first missed text after ${a.firstTextMs} ms` : ''}` +
            `\n             its own timeline: ${(a.events ?? []).map(([ms, what]) => `${ms} ${what}`).join(' | ')}`
          if (said[i] !== line) {
            said[i] = line
            say(line)
          }
        })
      }
      await sleep(500)
    }

    console.log('\nthe phone about itself - per absence: hidden for / links before, at return, fewest / all links back / first missed text:')
    for (const a of phoneLog) {
      console.log(
        `  ${String(a.hiddenForS).padStart(6)} s   ${a.linksBefore} / ${a.linksAtReturn} / ${a.fewestLinks}   ${String(a.linksBackMs ?? '-').padStart(6)} ms   ${String(a.firstTextMs ?? '-').padStart(6)} ms` +
          `   ${a.fewestLinks < a.linksBefore ? 'links REBUILT' : 'links kept'}`,
      )
      console.log(`           ${(a.events ?? []).map(([ms, what]) => `${ms} ${what}`).join(' | ')}`)
    }
    console.log('the room about the phone (seconds since the start): ' + roster.map((r) => `${r.present ? 'in' : 'GONE'} ${r.s}`).join(' -> '))
    const final = await look()
    const absences = phoneLog
    console.log(`at the end: phone present = ${final.present}, its document ${final.report?.len ?? '?'} of ${final.roomLen} characters, ${typed} of them typed by the room`)
    if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ absences, roster, timeline }, null, 2))
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
