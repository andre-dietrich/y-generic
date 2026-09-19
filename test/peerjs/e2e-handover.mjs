/**
 * E2E: the PeerJS playground in a real Chrome against the PeerJS cloud -
 * join, sync, and the one thing no scripted PeerJS can show: what Chrome
 * reports when a peer VANISHES.
 *
 *  1. A opens the room (claims the coordinator id), B joins; text typed in
 *     A must reach B, both rosters show two users.
 *  2. A's page is killed without any unload handler (a tab the OS
 *     discarded, a phone that never came back). Then C joins - the PeerJS
 *     server freed A's id when its socket closed, so C claims the
 *     coordinator role while B still holds a link to the dead A. How long
 *     until B and C see each other, and does C get the room's text?
 *
 * Found with this script: Chrome keeps the dead link in ICE 'disconnected'
 * (no 'failed', no data-channel close, 150 s watched) and PeerJS closes on
 * 'failed' only - B never noticed, the room stayed split for good. Hence
 * the transport's iceDisconnectTimeout.
 *
 * Needs (none of it is a dependency of this package), plus network access
 * to the PeerJS cloud and the cdnjs copy of peerjs the playground loads:
 *   npm install --no-save puppeteer-core      and a Chrome (CHROME=/path, default /usr/bin/google-chrome)
 *   npx parcel serve --dist-dir .parcel-dev test/peerjs/index.html --port 3414
 * Run: node test/peerjs/e2e-handover.mjs
 *      APP_URL=http://localhost:3414/ WAIT_MS=120000 override.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER ?? 'puppeteer-core')

const APP_URL = process.env.APP_URL ?? 'http://localhost:3414/'
const WAIT_MS = Number(process.env.WAIT_MS ?? 120000)
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
const ROOM = 'e2e-' + Math.random().toString(36).slice(2, 10) // the cloud is shared
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(cond, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await cond().catch(() => false)) return Date.now() - t0
    await sleep(200)
  }
  return -1
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  })
  const open = async () => {
    const page = await (await browser.createBrowserContext()).newPage()
    await page.goto(APP_URL, { waitUntil: 'load' })
    await page.$eval('#config-room', (el, room) => (el.value = room), ROOM)
    await page.click('#connect-btn')
    await page.waitForSelector('.ql-editor', { timeout: 30000 })
    return page
  }
  const peers = (p) => p.evaluate(() => Number(document.getElementById('peer-count').textContent))
  const roster = (p) => p.evaluate(() => document.getElementById('user-list').children.length)
  const text = (p) => p.evaluate(() => document.querySelector('.ql-editor').innerText)

  let failed = false
  const check = (label, ms) => {
    console.log(`  ${label}: ${ms < 0 ? 'NEVER' : ms + ' ms'}`)
    if (ms < 0) failed = true
  }
  try {
    console.log('1. A opens the room, B joins')
    const a = await open()
    await sleep(4000) // A's coordinator claim
    const b = await open()
    check('both see one peer', await until(async () => (await peers(a)) >= 1 && (await peers(b)) >= 1, 40000))
    await a.click('.ql-editor')
    await a.keyboard.type('hello via peerjs')
    check("A's text at B", await until(async () => (await text(b)).includes('hello via peerjs'), 20000))
    check('both rosters show 2 users', await until(async () => (await roster(a)) === 2 && (await roster(b)) === 2, 20000))

    console.log('2. the coordinator A vanishes, C joins')
    await a.close()
    const c = await open()
    check('B and C see each other', await until(async () => (await peers(c)) >= 1 && (await peers(b)) >= 1, WAIT_MS))
    check("C has the room's text", await until(async () => (await text(c)).includes('hello via peerjs'), 20000))
  } finally {
    await browser.close()
  }
  console.log(failed ? 'RESULT: FAILED' : 'RESULT: ok')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
