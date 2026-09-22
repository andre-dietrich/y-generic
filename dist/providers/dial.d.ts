/**
 * Whom to dial in a room that is too large for a full mesh - the rule for a
 * mesh transport under ConferenceTransport (providers/conference).
 *
 * The signaling of the mesh transports is a broadcast: a peer announces
 * itself, everybody in the room hears it. Today everybody below `maxConns`
 * then dials the announcer - a full mesh, or with a small `maxConns`
 * y-webrtc's topology: the first `maxConns` peers are a clique that is
 * "full" and deaf, the later ones a chain (diameter 7 at 100 peers, 26 at
 * 400: docs/superpowers/specs/2026-09-20-partial-mesh-relay-research.md).
 *
 * Here: a peer that needs links (fewer than `dial`) announces; every peer
 * that hears it answers with probability ~ dial / room size, so the
 * announcer gets about `dial` links to peers picked at random from the WHOLE
 * room - a random graph, diameter 3-4 up to 400 peers. Average degree is
 * 2 x dial (a link has two ends), the oldest peers hold more. A peer stops
 * announcing once it has `dial` links: no announce every 5 s from every peer
 * to every peer, which at 300 peers is 18,000 signaling messages a second.
 *
 * The room size is what this peer has seen - distinct announcers, its own
 * links, or what the layer above counts (ConferenceTransport: origins heard).
 * NOT the expected size: the first peers of a lecture hall would answer each
 * other with probability 5/300 and sit alone for minutes.
 */
export interface SparseDialOptions {
    /** Links a peer asks for; it announces while it has fewer. */
    dial: number;
    /** Hard cap: a peer at it neither dials nor accepts. */
    maxConns: number;
    /**
     * `true`: never dial an announcer (a leaf - a phone: it holds the links it
     * asked for, nobody else's). It still announces and accepts.
     */
    passive?: boolean;
    /** Answer a little more often than needed, so that one announce is usually enough. @default 1.3 */
    oversample?: number;
    /** For tests. */
    random?: () => number;
}
export declare class SparseDial {
    passive: boolean;
    private readonly _dial;
    private readonly _maxConns;
    private readonly _oversample;
    private readonly _random;
    private _heard;
    private _leaves;
    private _roomSize;
    constructor(options: SparseDialOptions);
    /** The room size the layer above has counted (peers, this one included). */
    setRoomSize(peers: number): void;
    /** Announce (again)? `links`: open and pending ones. */
    wantsLinks(links: number): boolean;
    /** May an offer from a peer we did not dial be accepted? */
    accepts(links: number): boolean;
    /** Anything on the signaling channel names its sender: one more peer of the room. */
    heard(peer: string): void;
    /** `peer` announced itself and we have no link to it: dial it? `peerPassive`: what its announce said. */
    answers(peer: string, links: number, peerPassive?: boolean): boolean;
    /** A peer id changed or left: forget it as an announcer. */
    forget(peer: string): void;
}
//# sourceMappingURL=dial.d.ts.map