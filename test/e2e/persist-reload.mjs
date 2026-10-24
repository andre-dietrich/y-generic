/**
 * E2E: does a `persistent` room keep a document nobody is there to hold? One page,
 * alone in the room, types a token and closes; a fresh page (its own browser
 * context: no shared IndexedDB or BroadcastChannel) joins the same room alone.
 * Until its editor holds the token.
 *
 *   settled      the page closes 4 s after typing - every debounce is over
 *   in debounce  the page closes 30 ms after typing - only the unload path can save it
 *   control      persistent off, settled - must NOT come back (else the check measures
 *                something else, e.g. a relay that replays its history anyway)
 *
 * Usage: node --env-file=.env test/e2e/persist-reload.mjs <gun|nostr|supabase>
 *   gun: a local relay (NODE_PATH with gun, as room-scenarios.mjs); nostr: the local
 *   relay Docker/nostr/relay.js (it stores snapshots); supabase: the real project of .env (SUPABASE_URL,
 *   SUPABASE_KEY; table yjs_documents, see test/supabase/README.md).
 *   PUPPETEER=/path/to/puppeteer-core CHROME=/usr/bin/chromium APP_PORT=3470 SERVER_PORT=4490
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER ?? 'puppeteer-core')
const TRANSPORT = process.argv[2]
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
const APP_PORT = Number(process.env.APP_PORT ?? 3470)
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 4490)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fill = (page, sel, value) =>
  page.$eval(sel, (el, v) => {
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
const check = (page, sel, on) => page.$eval(sel, (el, v) => el.checked !== v && el.click(), on)

const ADAPTERS = {
  gun: {
    entry: 'test/gun/index.html',
    server() {
      const child = spawn('node', [join(process.cwd(), 'Docker/gun/relay.js')], {
        env: { ...process.env, PORT: String(SERVER_PORT) },
        stdio: 'ignore',
        cwd: mkdtempSync(join(tmpdir(), 'ygen-gun-')),
      })
      return { stop: () => child.kill('SIGKILL') }
    },
    async join(page, room, persistent) {
      await fill(page, '#config-room', room)
      await fill(page, '#config-peers', `http://127.0.0.1:${SERVER_PORT}/gun`) // not localhost: see test/gun/relay.sh
      await check(page, '#config-persistent', persistent)
      await page.click('#connect-btn')
    },
  },
  nostr: {
    entry: 'test/nostr/index.html',
    query: (persistent) => (persistent ? '?persistent' : ''),
    // Docker/nostr/relay.js, not nostr-relay.mjs: that one only forwards, it stores no snapshot
    server() {
      const dir = mkdtempSync(join(tmpdir(), 'ygen-nostr-'))
      const child = spawn('node', [join(process.cwd(), 'Docker/nostr/relay.js')], {
        env: { ...process.env, PORT: String(SERVER_PORT), SNAPSHOT_FILE: join(dir, 'snapshots.json') },
        stdio: 'ignore',
      })
      return { stop: () => child.kill('SIGKILL') }
    },
    async join(page, room) {
      await fill(page, '#relays', `ws://127.0.0.1:${SERVER_PORT}`)
      await fill(page, '#room-name', room)
      await page.click('#connect-btn')
    },
  },
  supabase: {
    entry: 'test/supabase/index.html',
    server: () => ({ stop() {} }),
    async join(page, room, persistent) {
      await fill(page, '#supabase-url', process.env.SUPABASE_URL)
      await fill(page, '#supabase-key', process.env.SUPABASE_KEY)
      await fill(page, '#room-name', room)
      await check(page, '#persistent', persistent)
      await page.click('#connect-btn')
    },
  },
}

async function visit(browser, adapter, room, persistent) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  const logs = []
  page.on('console', (m) => logs.push(m.text()))
  // A playground's alert() blocks the page, and every evaluate() after it times out.
  page.on('dialog', (d) => (console.log(`      dialog: ${d.message()}`), d.dismiss()))
  await page.goto(`http://localhost:${APP_PORT}/${adapter.query?.(persistent) ?? ''}`)
  await adapter.join(page, room, persistent)
  await sleep(5000) // alone in the room: connected to the backend long before this
  return { context, page, logs }
}

async function main() {
  const adapter = ADAPTERS[TRANSPORT]
  if (!adapter) throw new Error(`usage: persist-reload.mjs <${Object.keys(ADAPTERS).join('|')}>`)
  const server = adapter.server()
  const parcel = spawn('node', ['node_modules/.bin/parcel', 'serve', adapter.entry, '--dist-dir', mkdtempSync(join(tmpdir(), 'ygen-persist-')), '--port', String(APP_PORT), '--no-hmr'], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('parcel did not start')), 120000)
    parcel.stdout.on('data', (d) => String(d).includes('Built in') && (clearTimeout(t), resolve()))
  })
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  let failed = false
  try {
    for (const c of [
      { name: 'settled', closeAfterMs: 4000, persistent: true, want: true },
      { name: 'in debounce', closeAfterMs: 30, persistent: true, want: true },
      { name: 'control: persistent off', closeAfterMs: 4000, persistent: false, want: false },
    ]) {
      const room = 'persist-' + Math.random().toString(36).slice(2, 10)
      const token = 'TOKEN' + Math.random().toString(36).slice(2, 8).toUpperCase()
      const a = await visit(browser, adapter, room, c.persistent)
      await a.page.click('.ql-editor')
      await a.page.keyboard.type(token)
      await sleep(c.closeAfterMs)
      await a.page.close({ runBeforeUnload: true })
      await sleep(2000) // what a closing tab gets to put on the wire before its process goes
      await a.context.close()

      const b = await visit(browser, adapter, room, c.persistent)
      const t0 = Date.now()
      let ms = -1
      while (Date.now() - t0 < 30000) {
        const text = await b.page.evaluate(() => document.querySelector('.ql-editor').innerText)
        if (text.includes(token)) {
          ms = Date.now() - t0
          break
        }
        await sleep(250)
      }
      const ok = (ms >= 0) === c.want
      if (!ok) failed = true
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${ms >= 0 ? `back after ${ms + 5000} ms` : 'not back in 35 s'} (want ${c.want ? 'back' : 'not back'})`)
      if (!ok) for (const l of b.logs.filter((l) => /persist|snapshot|error|❌/i.test(l)).slice(-8)) console.log('      ' + l.slice(0, 200))
      await b.context.close()
    }
  } finally {
    await browser.close().catch(() => {})
    server.stop()
    parcel.kill('SIGKILL')
  }
  console.log(failed ? 'FAILED' : 'all ok')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
