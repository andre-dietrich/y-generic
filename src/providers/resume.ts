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
 * Timer throttling of a hidden tab stays far below a sensible
 * `minSleepMs`: 1 s per tick, and Chrome's once-a-minute throttling
 * exempts pages with an open RTCDataChannel.
 *
 * @param minSleepMs - shortest sleep worth reporting
 * @param onResume - called with the measured sleep (ms)
 * @returns stop function
 */
export function watchResume(
  minSleepMs: number,
  onResume: (sleptMs: number) => void,
): () => void {
  const TICK_MS = 1000
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const slept = now - last - TICK_MS
    last = now
    if (slept >= minSleepMs) onResume(slept)
  }, TICK_MS)
  return () => clearInterval(timer)
}
