/**
 * `?phone` in a mesh playground (test/e2e/phone-session.mjs): the phone tells on itself
 * through its presence - how long its document is, how many links it has, and one entry
 * per absence that STAYS in the report (a later report must not overwrite it: the first
 * session lost every "visible again" to the text report that followed within
 * milliseconds). The phone measures its own recovery, on its own clock: after how long it
 * had its links back, when the first missed text came - and the timeline of it, from the
 * transport's log lines (`timeline`: which lines, and what to call them) and the
 * browser's online / offline events, in ms since the return.
 *
 * What the browser tells a page that goes away cannot travel that way - the page is
 * gone before a report leaves it. Every lifecycle event goes to the session script with
 * `sendBeacon` instead, which is made for a dying page: no timer, no socket of ours
 * (port: the `sig` of the address + 1). Found with it missing: a tab closed with the X
 * of Android Chrome's tab overview stayed in every roster for the whole lease, twice.
 */
import type * as Y from 'yjs'

type Absence = {
  hiddenForS: number
  linksBefore: number
  linksAtReturn: number
  fewestLinks: number
  linksBackMs?: number
  firstTextMs?: number
  /** the phone's OWN roster: before it hid, at the return, and after how long it was whole again */
  rosterBefore: number
  rosterAtReturn: number
  rosterBackMs?: number
  events: [number, string][]
}

export function installPhoneReport(options: {
  awareness: { setLocalStateField(field: string, value: unknown): void; getStates(): Map<number, unknown>; on(event: 'change', fn: () => void): void }
  yText: Y.Text
  /** connected links right now */
  links: () => number
  /** the transport's log tag, e.g. '[SimplePeerTransport]' */
  logTag: string
  /** a log line that contains `match` goes into the timeline as `label(line)`; `count: true` = only the first and the linksBefore-th */
  timeline: { match: string; label: (line: string) => string; count?: boolean }[]
}): void {
  const { awareness, yText, links, logTag, timeline } = options
  const absences: (Absence & { visibleAt: number })[] = []
  let seq = 0
  let hiddenAt = 0
  let linksAtHide = 0
  let rosterAtHide = 0
  let counted = 0
  let current: (Absence & { visibleAt: number }) | null = null
  // The phone's own roster over time, and when the browser lost and found the network: what
  // it cannot report while it is cut off (WiFi off with the page in front - the page runs on
  // behind a dead link and expires the room) arrives with the first report after it.
  const loadedAt = Date.now()
  const life: [number, string][] = []
  const live = (what: string) => {
    if (life.length > 0 && life[life.length - 1][1] === what) return // eight "link open" in a row are one
    life.push([Date.now() - loadedAt, what])
    if (life.length > 100) life.shift()
  }
  // WiFi <-> mobile data: the one thing that tells a page with the display on that its
  // network changed - this phone says `online` 1 s after the WiFi went (mobile data took
  // over, the LAN is gone all the same) and NOTHING when the WiFi comes back.
  const connection = (navigator as any).connection
  const network = () => `network ${connection?.type ?? '?'} ${connection?.effectiveType ?? ''}`.trim()
  if (connection?.addEventListener) {
    live(network())
    connection.addEventListener('change', () => {
      live(network())
      publish()
    })
  }
  let lastRoster = -1
  const publish = () =>
    awareness.setLocalStateField('report', {
      seq: ++seq,
      len: yText.length,
      links: links(),
      hidden: document.visibilityState === 'hidden',
      roster: awareness.getStates().size,
      life,
      absences: absences.map(({ visibleAt, ...rest }) => rest),
    })
  const note = (what: string) => {
    if (current && Date.now() - current.visibleAt < 90000 && current.events.length < 18) current.events.push([Date.now() - current.visibleAt, what])
  }
  const consoleLog = console.log
  console.log = (...args: unknown[]) => {
    consoleLog(...args)
    const line = args.map(String).join(' ')
    if (!line.includes(logTag)) return
    const hit = timeline.find((t) => line.includes(t.match))
    if (!hit) return
    live(hit.label(line)) // the whole life of the page, not only the 90 s after a return
    if (hit.count) {
      counted++
      if (current && (counted === 1 || counted === current.linksBefore)) note(`${hit.label(line)} ${counted}`)
    } else note(hit.label(line))
  }
  const beaconUrl = `http://${location.hostname}:${Number(new URLSearchParams(location.search).get('sig') ?? 4470) + 1}/lifecycle`
  const beacon = (what: string) => navigator.sendBeacon(beaconUrl, `${what} (visibility ${document.visibilityState}, links ${links()})`)
  for (const type of ['beforeunload', 'pagehide', 'pageshow']) window.addEventListener(type, (e) => beacon(`${type}${(e as PageTransitionEvent).persisted ? ' persisted' : ''}`))
  for (const type of ['visibilitychange', 'freeze', 'resume']) document.addEventListener(type, () => beacon(type))
  window.addEventListener('online', () => (note('browser: online'), live('online'), publish()))
  window.addEventListener('offline', () => (note('browser: offline'), live('offline'), publish()))
  awareness.on('change', () => {
    const size = awareness.getStates().size
    if (size === lastRoster) return
    lastRoster = size
    live(`roster ${size}`)
    publish()
  })
  yText.observe(() => {
    if (current && current.firstTextMs === undefined) {
      current.firstTextMs = Date.now() - current.visibleAt
      note('first text')
    }
    publish()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      linksAtHide = links()
      rosterAtHide = awareness.getStates().size
      publish()
      return
    }
    // Unlocking flips the visibility twice within a second: not an absence.
    if (Date.now() - hiddenAt < 3000) return
    counted = 0
    const entry: Absence & { visibleAt: number } = {
      hiddenForS: Math.round((Date.now() - hiddenAt) / 100) / 10,
      linksBefore: linksAtHide,
      linksAtReturn: links(),
      fewestLinks: links(), // below linksBefore = the links were rebuilt, not kept
      rosterBefore: rosterAtHide,
      rosterAtReturn: awareness.getStates().size,
      events: [[0, `online=${navigator.onLine}`]],
      visibleAt: Date.now(),
    }
    current = entry
    absences.push(entry)
    publish()
    // Links back = as many as before it hid; give up after 2 min.
    const watch = setInterval(() => {
      const waited = Date.now() - entry.visibleAt
      entry.fewestLinks = Math.min(entry.fewestLinks, links())
      if (entry.linksBackMs === undefined && entry.linksBefore > 0 && links() >= entry.linksBefore && (entry.fewestLinks < entry.linksBefore || waited > 5000)) entry.linksBackMs = waited
      if (entry.rosterBackMs === undefined && awareness.getStates().size >= entry.rosterBefore) entry.rosterBackMs = waited
      if ((entry.linksBackMs !== undefined && entry.rosterBackMs !== undefined) || waited > 120000) clearInterval(watch)
      publish()
    }, 500)
  })
  publish()
}
