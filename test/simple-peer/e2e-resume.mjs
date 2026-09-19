/**
 * E2E: the simple-peer playground in a real Chrome - real WebRTC, the real
 * y-webrtc signaling server - through the two things a phone does to it.
 *
 *  1. Two browser contexts (isolated: no shared BroadcastChannel) join the
 *     room; text typed in A must reach B.
 *  2. A's page is FROZEN through the DevTools protocol
 *     (Page.setWebLifecycleState) for FREEZE_MS, as a backgrounded phone
 *     tab is; B types meanwhile. After the unfreeze: how long until A has
 *     B's text, and until both rosters show two users again?
 *  3. The signaling server is killed and restarted; then a third context C
 *     joins. C finds A and B only if they re-subscribed by themselves.
 *  4. C's page is killed without any unload handler. How long until A and
 *     B drop it (link and roster)?
 *
 * Needs (none of it is a dependency of this package):
 *   npm install --no-save puppeteer-core      and a Chrome (CHROME=/path, default /usr/bin/google-chrome)
 *   npx parcel serve --dist-dir .parcel-dev test/simple-peer/index.html --port 3412
 * Run: node test/simple-peer/e2e-resume.mjs
 *      APP_URL=http://localhost:3412/ FREEZE_MS=20000 SIGNALING_PORT=4455 override.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER ?? 'puppeteer-core')

const APP_URL = process.env.APP_URL ?? 'http://localhost:3412/'
const FREEZE_MS = Number(process.env.FREEZE_MS ?? 20000)
const PORT = process.env.SIGNALING_PORT ?? '4455'
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let server
function startSignaling() {
  server = spawn('node', ['node_modules/y-webrtc/bin/server.js'], {
    env: { ...process.env, PORT },
    stdio: 'ignore',
  })
}

async function openPeer(browser, name) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  const logs = []
  page.on('console', (m) => logs.push(m.text()))
  await page.evaluateOnNewDocument((port) => {
    localStorage.setItem(
      'simplepeer-config',
      JSON.stringify({ signaling: [`ws://localhost:${port}`], iceServers: [] }),
    )
  }, PORT)
  await page.goto(APP_URL, { waitUntil: 'load' })
  return { name, page, logs }
}

const peerCount = (p) => p.page.evaluate(() => Number(document.getElementById('peer-count').textContent))
const roster = (p) => p.page.evaluate(() => document.getElementById('user-list').children.length)
const text = (p) => p.page.evaluate(() => document.querySelector('.ql-editor').innerText)

/** ms until cond() holds, or -1 after timeoutMs. */
async function until(cond, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await cond().catch(() => false)) return Date.now() - t0
    await sleep(100)
  }
  return -1
}
const fmt = (ms) => (ms < 0 ? 'NEVER' : `${ms} ms`)

async function main() {
  startSignaling()
  await sleep(500)
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  })
  let failed = false
  const check = (label, ms) => {
    console.log(`  ${label}: ${fmt(ms)}`)
    if (ms < 0) failed = true
  }
  try {
    console.log('1. two peers join')
    const a = await openPeer(browser, 'A')
    const b = await openPeer(browser, 'B')
    check('both see one peer', await until(async () => (await peerCount(a)) === 1 && (await peerCount(b)) === 1, 30000))
    await a.page.click('.ql-editor')
    await a.page.keyboard.type('hello from A. ')
    check("A's text at B", await until(async () => (await text(b)).includes('hello from A'), 15000))
    check('both rosters show 2 users', await until(async () => (await roster(a)) === 2 && (await roster(b)) === 2, 15000))

    console.log(`2. A is frozen for ${FREEZE_MS} ms, B types meanwhile`)
    const cdp = await a.page.createCDPSession()
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
    await b.page.click('.ql-editor')
    await b.page.keyboard.type('typed by B while A slept. ')
    await sleep(FREEZE_MS)
    await cdp.send('Page.setWebLifecycleState', { state: 'active' })
    const t0 = Date.now()
    const gotText = await until(async () => (await text(a)).includes('while A slept'), 60000)
    check("unfreeze -> B's text at A", gotText)
    check(
      'unfreeze -> both rosters show 2 users',
      await until(async () => (await roster(a)) === 2 && (await roster(b)) === 2, 60000 - (Date.now() - t0)) < 0
        ? -1
        : Date.now() - t0,
    )
    console.log(`  A noticed the sleep: ${a.logs.some((l) => l.includes('Page slept'))}`)

    console.log('3. signaling server restarts, then C joins')
    server.kill()
    await sleep(3000)
    startSignaling()
    await sleep(6000) // reconnect backoff of A and B
    const c = await openPeer(browser, 'C')
    check('C sees A and B', await until(async () => (await peerCount(c)) === 2, 40000))
    check("C has the room's text", await until(async () => (await text(c)).includes('hello from A'), 15000))

    console.log('4. C vanishes (page killed, no beforeunload - a tab the OS discarded)')
    await c.page.close()
    check('A and B drop C', await until(async () => (await peerCount(a)) === 1 && (await peerCount(b)) === 1, 90000))
    check('rosters back to 2 users', await until(async () => (await roster(a)) === 2 && (await roster(b)) === 2, 30000))
  } finally {
    await browser.close()
    server.kill()
  }
  console.log(failed ? 'RESULT: FAILED' : 'RESULT: ok')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  server?.kill()
  process.exit(1)
})
