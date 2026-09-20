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
//# sourceMappingURL=resume.js.map