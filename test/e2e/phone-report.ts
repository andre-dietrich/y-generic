/**
 * `?phone` in a mesh playground (test/e2e/phone-session.mjs): the phone tells on itself
 * through its presence - how long its document is, how many links it has, and one entry
 * per absence that STAYS in the report (a later report must not overwrite it: the first
 * session lost every "visible again" to the text report that followed within
 * milliseconds). The phone measures its own recovery, on its own clock: after how long it
 * had its links back, when the first missed text came - and the timeline of it, from the
 * transport's log lines (`timeline`: which lines, and what to call them) and the
 * browser's online / offline events, in ms since the return.
 */
import type * as Y from 'yjs'

type Absence = {
  hiddenForS: number
  linksBefore: number
  linksAtReturn: number
  fewestLinks: number
  linksBackMs?: number
  firstTextMs?: number
  events: [number, string][]
}

export function installPhoneReport(options: {
  awareness: { setLocalStateField(field: string, value: unknown): void }
  yText: Y.Text
  /** connected links right now */
  links: () => number
  /** the transport's log tag, e.g. '[SimplePeerTransport]' */
  logTag: string
  /** a log line that contains `match` goes into the timeline as `label(line)`; `count: true` = only the first and the linksBefore-th */
  timeline: { match: string; label: (line: string) => string; count?: boolean }[]
}): void {
  const { awareness, yText, links, logTag, timeline } = options
  const absences: Absence[] = []
  let seq = 0
  let hiddenAt = 0
  let linksAtHide = 0
  let counted = 0
  let current: (Absence & { visibleAt: number }) | null = null
  const publish = () =>
    awareness.setLocalStateField('report', {
      seq: ++seq,
      len: yText.length,
      links: links(),
      hidden: document.visibilityState === 'hidden',
      absences: absences.map(({ hiddenForS, linksBefore, linksAtReturn, fewestLinks, linksBackMs, firstTextMs, events }) => ({ hiddenForS, linksBefore, linksAtReturn, fewestLinks, linksBackMs, firstTextMs, events })),
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
    if (hit.count) {
      counted++
      if (current && (counted === 1 || counted === current.linksBefore)) note(`${hit.label(line)} ${counted}`)
    } else note(hit.label(line))
  }
  window.addEventListener('online', () => note('browser: online'))
  window.addEventListener('offline', () => note('browser: offline'))
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
      if (entry.linksBefore > 0 && links() >= entry.linksBefore && (entry.fewestLinks < entry.linksBefore || waited > 5000)) entry.linksBackMs = waited
      if (entry.linksBackMs !== undefined || waited > 120000) clearInterval(watch)
      publish()
    }, 500)
  })
  publish()
}
