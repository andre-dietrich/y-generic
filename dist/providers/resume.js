export function watchResume(minSleepMs, onResume) {
    const TICK_MS = 1000;
    let last = Date.now();
    const signOfLife = () => {
        const now = Date.now();
        const slept = now - last - TICK_MS;
        last = now;
        // Not from inside a link's message handler: the transports tear their links down on this.
        if (slept >= minSleepMs)
            queueMicrotask(() => onResume(slept));
    };
    const timer = setInterval(signOfLife, TICK_MS);
    const stop = (() => clearInterval(timer));
    stop.alive = signOfLife;
    return stop;
}
/**
 * The page has the network again, as far as a page can tell - not the moment
 * to sit out a reconnect backoff. Three signs, because a phone gives each of
 * them in a different situation and none in all:
 *  - `visibilitychange` to visible: back from another app, the display on again;
 *  - `online`: the browser had NO network and has one again;
 *  - `change` on `navigator.connection` (Chrome, Android): the network is a
 *    different one. With the display on and the WiFi switched off, a phone that
 *    falls back to mobile data says `online` a second later - the LAN is gone
 *    all the same - and nothing at all when the WiFi is back; this says "wifi".
 *    A WebSocket transport then sat out 12.9 s of backoff
 *    (test/providers/repro-websocket-wake.ts).
 * Returns the function that stops watching; does nothing outside a browser.
 */
export function watchPageBack(onBack) {
    if (typeof window === 'undefined' || typeof document === 'undefined')
        return () => { };
    const visible = () => {
        if (document.visibilityState === 'visible')
            onBack();
    };
    const connection = typeof navigator !== 'undefined' ? navigator.connection : undefined;
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', onBack);
    connection?.addEventListener?.('change', onBack);
    return () => {
        document.removeEventListener('visibilitychange', visible);
        window.removeEventListener('online', onBack);
        connection?.removeEventListener?.('change', onBack);
    };
}
//# sourceMappingURL=resume.js.map