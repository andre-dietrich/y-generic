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
/**
 * The page's NETWORK changed - not "the page is back", but "everything this
 * page had an address for is gone": a phone whose WiFi goes and whose mobile
 * data takes over, and the way back. Every WebRTC link of the old address is
 * dead, and the browser knows it seconds before ICE does: a real phone
 * (Chrome on Android, 8 peers) had `connection.type` "cellular" 0.6 s after
 * the switch, ICE 'disconnected' after 5 s and its links closed after 15 s
 * (test/e2e/phone-session.mjs simple-peer, 2026-09-22).
 *  - `navigator.connection` (Chrome on Android): a `change` whose `type`
 *    differs from the last one, and is not "none" - Android fires a change
 *    for every `effectiveType` estimate too, and rebuilding every link for
 *    one of those would be a room-wide cost for nothing.
 *  - without it (Firefox, Safari): `online` after an `offline`.
 * Calls within a second are one change (a switch is `offline`, "none",
 * `online`, "cellular" within half a second). Returns the function that
 * stops watching; does nothing outside a browser.
 */
export function watchNetworkChange(onChange) {
    if (typeof window === 'undefined' || typeof navigator === 'undefined')
        return () => { };
    let last = 0;
    const fire = (why) => {
        const now = Date.now();
        if (now - last < 1000)
            return;
        last = now;
        onChange(why);
    };
    const connection = navigator.connection;
    let wasOffline = false;
    const offline = () => {
        wasOffline = true;
    };
    const online = () => {
        if (!wasOffline)
            return;
        wasOffline = false;
        if (!connection?.type)
            fire('the network is back'); // with a type, `change` says it
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    let type = connection?.type;
    const changed = () => {
        const now = connection?.type;
        if (!now || now === 'none' || now === type)
            return;
        const from = type;
        type = now;
        wasOffline = false;
        if (from !== undefined)
            fire(`the network changed from ${from} to ${now}`);
    };
    connection?.addEventListener?.('change', changed);
    return () => {
        window.removeEventListener('offline', offline);
        window.removeEventListener('online', online);
        connection?.removeEventListener?.('change', changed);
    };
}
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