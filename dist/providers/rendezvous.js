/**
 * The rendezvous policy of a mesh transport whose signaling is a SINGLE WELL-KNOWN
 * NAME instead of a broadcast channel - PeerJS, whose only primitive is "dial an id
 * somebody claimed" (providers/peerjs). The dial rule next to this (providers/dial.ts)
 * is the other half and is unchanged: it decides whom to answer once an id is in hand.
 *
 * simple-peer announces to a topic everybody hears, so the dice are rolled by the
 * HEARERS - nobody has a census, and `dial / room size` is the best each of them can
 * do (dial.ts:12-18). PeerJS has a census-holder: the coordinator. So the dice move to
 * it. It answers a join with a SAMPLE of the room instead of the roster, and nobody
 * keeps a link to it - a peer opens a signaling session, takes its sample, and closes.
 *
 * That is the whole reason this file exists apart from the transport: the sampling and
 * the heartbeat are the protocol under test, so test/dummy/bench-partial-mesh.ts has to
 * run THESE functions rather than a model of them. The same move that produced dial.ts.
 */
/**
 * `want` ids for a peer that asked, drawn UNIFORMLY from the live roster.
 *
 * Uniform is load-bearing. Handing out the freshest entries, or the first of a Set,
 * would make the room's oldest or newest peers hubs and destroy the random graph the
 * dial rule is built on (dial.ts:14-16) - a partial mesh whose links all point at the
 * same dozen peers has a diameter no better than y-webrtc's chain.
 */
export function sampleRoster(roster, want, options = {}) {
    if (want <= 0)
        return [];
    const now = options.now ?? Date.now();
    const random = options.random ?? Math.random;
    const have = options.have ? new Set(options.have) : undefined;
    const candidates = [];
    for (const [id, entry] of roster) {
        if (entry.expires <= now)
            continue; // a lease that ran out: the peer stopped renewing
        if (entry.leaf)
            continue; // a leaf holds the links it asked for and nobody else's
        if (id === options.self)
            continue;
        if (have?.has(id))
            continue;
        candidates.push(id);
    }
    const size = Math.min(candidates.length, Math.ceil(want * (options.oversample ?? 2)));
    // Partial Fisher-Yates: the first `size` of a shuffle, without shuffling the rest.
    for (let i = 0; i < size; i++) {
        const j = i + Math.floor(random() * (candidates.length - i));
        const tmp = candidates[i];
        candidates[i] = candidates[j];
        candidates[j] = tmp;
    }
    return candidates.slice(0, size);
}
/** The three lowest live non-leaf ids: who claims the name if the coordinator stops answering. */
export function successorsOf(roster, now = Date.now()) {
    const live = [];
    for (const [id, entry] of roster)
        if (entry.expires > now && !entry.leaf)
            live.push(id);
    return live.sort().slice(0, 3);
}
/**
 * When to open the next signaling session.
 *
 * A fixed interval is wrong in both directions. At rest a peer that has its links needs
 * the coordinator for one thing only - renewing its lease - so a minute is generous. But
 * a peer with NO links needs an id right now, and waiting out a 60 s heartbeat there is
 * what would have turned test/peerjs/e2e-handover.mjs's 15 s reunion into a 60 s one.
 */
export function nextHeartbeatMs(links, dial, options) {
    const random = options.random ?? Math.random;
    const jitter = 0.75 + random() * 0.5;
    const attempt = options.attempt ?? 0;
    // A dial that failed: the coordinator may be mid-handover, and the server holds a dead
    // registration for its alive_timeout. Back off, but never past a few seconds.
    if (attempt > 0)
        return Math.min(5000, 1000 * Math.pow(2, attempt - 1)) * jitter;
    if (links === 0)
        return 0; // alone: an id, now
    if (links < dial)
        return 2000 * jitter;
    return options.renewMs * jitter;
}
/**
 * How long to wait before claiming the coordinator name, given the successor chain of
 * the last sample. The claim is its own probe - the server hands the name to exactly one
 * and answers everybody else `unavailable-id` - so this only has to keep N peers from
 * claiming at the same instant. A chain that is stale (all three gone) costs the room
 * the last tier, not correctness.
 */
export function claimDelayMs(self, successors, options = {}) {
    const random = options.random ?? Math.random;
    if (options.passive)
        return 12000 + random() * 10000;
    const rank = successors.indexOf(self);
    if (rank === 0)
        return random() * 250;
    if (rank > 0)
        return rank * 1500 + random() * 250;
    // No chain and no room: we are the first peer of it, or the last one left. Waiting out
    // the tier below would leave the room without a rendezvous for seconds for no reason -
    // nobody is there to collide with.
    if (successors.length === 0 && (options.roomSize ?? 0) <= 1)
        return random() * 250;
    return 4500 + random() * 5000;
}
//# sourceMappingURL=rendezvous.js.map