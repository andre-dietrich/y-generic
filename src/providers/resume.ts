/**
 * Detects that the page did not run for a while: a phone browser in the
 * background or with the display off, a suspended laptop. A suspended page
 * gets no event while it sleeps, and the page-lifecycle events around it
 * differ per browser - but a 1 s interval that finds Date.now() far ahead
 * of its previous tick has slept, on every platform, Node included (which
 * is what makes it testable: test/providers/repro-simple-peer-sleep.ts).
 *
 * After such a sleep a mesh transport's links are dead on the other side
 * (ICE consent expired after ~30 s) while they still read 'connected'
 * locally for another ~30 s; the transports use this to rebuild them at
 * once instead (see docs/superpowers/specs/2026-09-19-webrtc-mobile-resilience-research.md).
 *
 * Timer throttling of a hidden tab is NOT far below any `minSleepMs`:
 * Chrome's once-a-minute throttling exempts pages with an open
 * RTCDataChannel, but Firefox delays a hidden tab's timers in a busy room
 * by up to ~15-20 s (its budget throttling caps at 15 s; measured with 25
 * real browsers: ticks 5.6, 9.0, 15.3, 17.6, 20.2 s late, monotonic clock
 * the same, the visible tab none). The transports' default is 30 s - which
 * is also when a silent link starts to die, so nothing shorter needs
 * repairing.
 *
 * So a late tick alone does not say "slept": a throttled page still handles
 * what arrives on its links, a suspended one handles nothing. The transports
 * call `alive()` for every message a link delivers, and the page has slept
 * when ticks AND links were silent for `minSleepMs` - reported by the first
 * sign of life after the silence, whichever it is. (It must not be "a
 * message means awake": what a page handles first when it wakes up is the
 * messages that queued before it fell asleep - its links are dead by then,
 * and such a message would talk it out of rebuilding them. Only links:
 * signaling traffic also reaches a page whose links died meanwhile.)
 *
 * @param minSleepMs - shortest sleep worth reporting
 * @param onResume - called with the measured sleep (ms)
 * @returns stop function, with `alive()` on it
 */
export interface ResumeWatch {
  (): void
  /** A link just delivered a message: the page runs, whatever its timers do. */
  alive(): void
}

export function watchResume(
  minSleepMs: number,
  onResume: (sleptMs: number) => void,
): ResumeWatch {
  const TICK_MS = 1000
  let last = Date.now()
  const signOfLife = () => {
    const now = Date.now()
    const slept = now - last - TICK_MS
    last = now
    // Not from inside a link's message handler: the transports tear their links down on this.
    if (slept >= minSleepMs) queueMicrotask(() => onResume(slept))
  }
  const timer = setInterval(signOfLife, TICK_MS)
  const stop = (() => clearInterval(timer)) as ResumeWatch
  stop.alive = signOfLife
  return stop
}
