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
/** What the coordinator holds per peer. A lease, not a connection. */
export interface RosterEntry {
    /** When the lease runs out, on the `Date.now()` scale. Renewed by the peer's next join, by nothing else. */
    expires: number;
    /** The peer announced itself a leaf: it is never handed out, and never a successor. */
    leaf: boolean;
}
export interface SampleOptions {
    /** The asker - never in its own sample. */
    self?: string;
    /** What the asker says it already holds: handing those back wastes the sample. */
    have?: readonly string[];
    /** A sample holds this many times `want`. NOT dial.ts's 1.3, which covers a dice roll - this covers GHOSTS: the roster is leases, and an entry outlives a killed tab by up to one of them. @default 2 */
    oversample?: number;
    /** @default Date.now() */
    now?: number;
    /** For tests. */
    random?: () => number;
}
/**
 * `want` ids for a peer that asked, drawn UNIFORMLY from the live roster.
 *
 * Uniform is load-bearing. Handing out the freshest entries, or the first of a Set,
 * would make the room's oldest or newest peers hubs and destroy the random graph the
 * dial rule is built on (dial.ts:14-16) - a partial mesh whose links all point at the
 * same dozen peers has a diameter no better than y-webrtc's chain.
 */
export declare function sampleRoster(roster: ReadonlyMap<string, RosterEntry>, want: number, options?: SampleOptions): string[];
/** The three lowest live non-leaf ids: who claims the name if the coordinator stops answering. */
export declare function successorsOf(roster: ReadonlyMap<string, RosterEntry>, now?: number): string[];
export interface HeartbeatOptions {
    /** The renewal interval, the longer of our own and what the coordinator asked for. */
    renewMs: number;
    /** Dials that failed in a row. */
    attempt?: number;
    random?: () => number;
}
/**
 * When to open the next signaling session.
 *
 * A fixed interval is wrong in both directions. At rest a peer that has its links needs
 * the coordinator for one thing only - renewing its lease - so a minute is generous. But
 * a peer with NO links needs an id right now, and waiting out a 60 s heartbeat there is
 * what would have turned test/peerjs/e2e-handover.mjs's 15 s reunion into a 60 s one.
 */
export declare function nextHeartbeatMs(links: number, dial: number, options: HeartbeatOptions): number;
export interface ClaimOptions {
    /** A page that sleeps must not be the room's coordinator. */
    passive?: boolean;
    /** The room as the layer above counts it. 0 or 1: nobody to collide with. */
    roomSize?: number;
    random?: () => number;
}
/**
 * How long to wait before claiming the coordinator name, given the successor chain of
 * the last sample. The claim is its own probe - the server hands the name to exactly one
 * and answers everybody else `unavailable-id` - so this only has to keep N peers from
 * claiming at the same instant. A chain that is stale (all three gone) costs the room
 * the last tier, not correctness.
 */
export declare function claimDelayMs(self: string, successors: readonly string[], options?: ClaimOptions): number;
//# sourceMappingURL=rendezvous.d.ts.map