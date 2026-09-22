/**
 * Conference transport for GenericProvider: rooms that do not fit into a full
 * WebRTC mesh (100+ peers).
 *
 * GenericProvider needs a broadcast medium - "what I send reaches every peer
 * of the room, what I receive comes from its author". Reply suppression,
 * responder self-selection, presence on demand, the removal veto and pub/sub
 * all rest on that (docs/superpowers/specs/2026-09-20-partial-mesh-relay-research.md:
 * today's core on a partial mesh ends with 0 of 100 rosters complete). A
 * full mesh is such a medium, at N-1 RTCPeerConnections per browser.
 *
 * This wrapper sits UNDER the core and makes a PARTIAL mesh look like one.
 * The inner transport (simple-peer, peerjs - anything with `sendTo`,
 * `onPeerConnect`, `onPeerDisconnect`) holds a handful of links; the wrapper
 * passes frames on:
 *
 * - **Broadcast: Plumtree** (Leitao 2007), one tree PER ORIGIN. A link is
 *   EAGER or LAZY for an origin. A frame seen for the first time goes on over
 *   the links that are eager for its origin; a duplicate turns the link it
 *   came over lazy for that origin (PRUNE), so they settle into a spanning
 *   tree: N-1 frames per broadcast, like the full mesh. Lazy links only hear
 *   a DIGEST now and then ("I have origin X up to seq S"); a peer that misses
 *   something asks for it (GRAFT), which also makes that link eager again -
 *   the repair path when a tree link dies. Flooding the way y-webrtc does it
 *   costs 27x the frames (same research doc).
 *   Why per origin: with ONE tree for the room, two origins' frames going
 *   round the same cycle in opposite directions each prune a different link
 *   of it, and the tree falls apart - in a joining room all the time (the
 *   gate, first run: 40 of 49 tree links, 26 of 50 rosters complete).
 *   What a link is for an origin nobody has heard yet is the link's DEFAULT:
 *   every peer keeps FEEDS links eager by default and asks for the rest to
 *   be lazy (PRUNE-ALL, which the other end refuses when it would be left
 *   with fewer) - a new origin's first frame floods 2 links per peer, not k.
 * - **Unicast: a learning bridge.** The link a peer's frames arrive on first
 *   is the route back to it.
 * - **Membership.** A closed link does not say that the peer is gone - it
 *   may be reachable over others. The neighbour says SUSPECT to the room;
 *   the suspect, if it hears that, says ALIVE. No ALIVE within
 *   `suspectTimeoutMs`: every peer reports `onPeerDisconnect` to its core -
 *   what a full mesh's closed channel does. A page that leaves says LEAVE.
 * - **connect() resolves at the first link**, not before: the core sends its
 *   JOIN beacon ("send me your presence") when connect() resolves, and on a
 *   mesh no channel is open yet at that point. A full mesh does not care
 *   (every channel that opens brings that peer's presence); here most of the
 *   room never opens a channel to the joiner (21 of 100 rosters complete).
 *
 * The core sees the ORIGIN of a frame as `from` - an id of this wrapper's
 * own (12 hex chars), stable over a re-dial of the inner transport.
 *
 * Wire format: an envelope of its own. All peers of a room must use this
 * transport, in the same version.
 *
 * @example
 * ```typescript
 * import Peer from 'simple-peer'
 * import { SimplePeerTransport } from 'genericprovider/providers/simple-peer'
 * import { ConferenceTransport } from 'genericprovider/providers/conference'
 *
 * const transport = new ConferenceTransport(
 *   new SimplePeerTransport({ peer: Peer, signaling: ['wss://...'] }),
 *   { expectedPeers: 300 },
 * )
 * const provider = new GenericProvider(doc, transport)
 * ```
 */
import type { Transport, ConnectionConfig } from '../../transport';
/** What the wrapper needs from the transport below it. */
export type MeshTransport = Transport & Required<Pick<Transport, 'sendTo' | 'onPeerConnect' | 'onPeerDisconnect'>> & {
    /**
     * Optional, once before connect(): the room is expected to hold
     * `expectedPeers` - build a partial mesh if that is too many for a full
     * one; `passive`: this peer is a leaf. See ../dial.ts.
     */
    configureSparse?(options: {
        expectedPeers?: number;
        passive?: boolean;
    }): void;
    /**
     * Optional: the peers this wrapper has heard (itself included), for a
     * dial rule that answers an announce with probability ~ dial / N. The
     * peers that ARE there, not the expected ones: the first peers of a
     * lecture hall would answer each other with probability 5/300.
     */
    setRoomSize?(peers: number): void;
};
export interface ConferenceTransportOptions {
    /**
     * Estimated room size - a HINT, handed to the inner transport before it
     * connects (`configureSparse`): up to 16 peers it builds the full mesh it
     * always built, beyond that a partial one with ln(N) links per joiner. It
     * has to be known up front because the first peers of a room cannot see
     * how many will follow: without it a lecture hall first builds a full
     * mesh of its first 64 peers. Too large costs a small room a second hop,
     * too small costs a large room links; neither breaks it. Not needed when
     * the inner transport's own `dial` option is set.
     */
    expectedPeers?: number;
    /**
     * `false`: a leaf - this peer never passes on somebody else's frames.
     * For phones and background tabs: iOS suspends
     * WebRTC when the display locks, and a suspended tree node takes its
     * whole subtree along until the repair path has healed it.
     * @default true
     */
    relay?: boolean;
    /**
     * 'tree' (Plumtree) or 'flood' (every first-seen frame goes to every
     * link but the one it came over - y-webrtc's cost, for measurements).
     * @default 'tree'
     */
    mode?: 'tree' | 'flood';
    /**
     * Links this peer keeps eager BY DEFAULT (for origins it has not heard
     * yet); it asks for the others to be lazy. 1: the defaults form a tree.
     * @default 1
     */
    feeds?: number;
    /**
     * One DIGEST goes out per tick, to the lazy links in turn. With
     * `graftDelayMs` this is how long a peer outside an origin's tree waits
     * for that origin's frame: a tree covers the peers that were there when
     * the origin last sent, a peer that joined since has only its default
     * feeds - the first keystroke after a long silence reaches it this way.
     * @default 500
     */
    digestIntervalMs?: number;
    /** Lazy links each state is announced to. @default 2 */
    digestFanout?: number;
    /** How long a frame a DIGEST announced may still arrive by itself before it is GRAFTed. @default 250 */
    graftDelayMs?: number;
    /**
     * A SUSPECT without an ALIVE for this long: the peer is gone. The ALIVE
     * travels the suspect's tree, which may not reach a peer that joined
     * since the suspect last sent (see digestIntervalMs): at 3 s one peer in
     * 100 dropped a living one now and then.
     * @default 6000
     */
    suspectTimeoutMs?: number;
    /** connect() resolves at the first link, or after this when the room is empty. @default 3000 */
    firstLinkTimeoutMs?: number;
    /**
     * The round trip the core should expect before it has measured one: a
     * frame and its answer cross 3-4 links each way. Without it the core
     * starts from a single link's timing, takes what is still on its way for
     * missing, and asks for it: at 300 peers the OTHER peers' cores sent 93
     * broadcasts and 196 unicasts while one peer typed 30 characters, against
     * 55 and 2 on a full mesh (bench-partial-mesh).
     * @default 250
     */
    expectedRttMs?: number;
    /** Frames kept for GRAFT replies. @default 30000 ms / 4 MiB */
    cacheMs?: number;
    cacheBytes?: number;
    debug?: boolean;
}
export declare class ConferenceTransport implements Transport {
    private readonly inner;
    /** This peer's address in the room: what the core gets as `from` on the other side. */
    readonly id: string;
    /** Counters for benchmarks and the playground. */
    readonly stats: {
        duplicates: number;
        prunes: number;
        grafts: number;
        digests: number;
        suspects: number;
        unroutable: number;
        connectWaitMs: number;
        linksAtConnect: number;
    };
    private readonly _idBytes;
    private readonly _opts;
    private _seq;
    private _connectedAt;
    private _hadLink;
    private _unsent;
    private _agedOwn;
    private _useq;
    private _refuted;
    private _ownTunnelled;
    private _connected;
    private _links;
    private _byPeer;
    private _origins;
    private _cache;
    private _cacheIndex;
    private _cacheSize;
    private _digestTimer?;
    private _announced;
    private _announcedRounds;
    private _digestTurn;
    private _firstLink?;
    private _unsubscribe;
    private _pendingSuspects;
    private _lastRoomSize;
    private _onMessage?;
    private _onConnect?;
    private _onDisconnect?;
    constructor(inner: MeshTransport, options?: ConferenceTransportOptions);
    get isConnected(): boolean;
    get preferredBatchMs(): number | undefined;
    get expectedRttMs(): number;
    /** Peers of the room this wrapper has heard and not given up, itself included. */
    get roomSize(): number;
    /** Open links, how many are eager by default, and how many are eager for `origin` (its tree). */
    linkCount(origin?: string): {
        links: number;
        feeds: number;
        tree: number;
    };
    connect(config: ConnectionConfig): Promise<void>;
    disconnect(): void;
    flush(): void;
    send(data: Uint8Array): void;
    sendTo(peerId: string, data: Uint8Array): void;
    private _sendUnicast;
    onMessage(callback: (data: Uint8Array, from?: string) => void): () => void;
    onPeerConnect(callback: (peerId: string) => void): () => void;
    onPeerDisconnect(callback: (peerId: string) => void): () => void;
    private _linkUp;
    /**
     * 'out': do we pass `origin`'s frames on over this link; 'in': do we expect
     * them over it. One flag for both looked simpler and cut peers off: a feed
     * that got a duplicate FROM us pruned the link, and with it what it sent
     * TO us - while our other source had just lost against it (the gate, a
     * link cut at N=100: five peers without any eager link for one origin,
     * its ALIVE never reached them). So the receiver alone says who sends to
     * it, and it prunes a link only over a duplicate - when another link has
     * just delivered.
     */
    private _eager;
    private _setEager;
    private _hasFeed;
    private _anyRelayLink;
    /** Links that are eager by default and lead to a peer that passes frames on. */
    private _feeds;
    private _setDefault;
    private _linkDown;
    /**
     * A link went. Do not wait for a DIGEST to find out what it was good for:
     * keep FEEDS links eager by default, and ask every remaining neighbour for
     * the origins whose frames came over the lost link (`orphans`) - one of
     * them has a path, the duplicates prune the others again.
     */
    private _regraft;
    private _graft;
    private _sendLink;
    private _onFrame;
    private _onHello;
    private _origin;
    /** true when (origin, seq) is new. */
    private _markSeen;
    private _onGossip;
    /** This link has `origin` up to `seq`: nothing to tell it about that, nothing to ask it beyond. */
    private _linkHas;
    private _duplicate;
    private _onPrune;
    /**
     * Unicast follows the routes the origin's broadcasts left behind. They are
     * loop-free as long as they come from frames that ran through the room one
     * after the other; a route that is missing or points the wrong way shows
     * as a frame that comes BACK (to a peer that passed it on, or to its
     * origin). That peer sends it as a broadcast of its own with the
     * destination inside (a TUNNEL): N-1 frames down its tree, where sending
     * it over every link was 7,500 at 300 peers - instead of losing a peer's
     * answer to a JOIN.
     */
    private _onUnicast;
    /** true when (origin, key) was seen before; remembers it. */
    private _unicastSeen;
    /** One delivery, whether it came along the routes or through a tunnel. */
    private _deliverUnicast;
    /** false: no way known. */
    private _routeUnicast;
    private _tunnel;
    private _onTunnel;
    private _originate;
    private _remember;
    /**
     * One DIGEST per tick, to the lazy links in turn: what it costs does not
     * grow with the number of links, and a peer that lacks something has
     * several lazy neighbours taking turns. It announces the state of one
     * tick AGO - what is still on its way over the tree is not "missing".
     *
     * Only what changed since that link last heard from us, and only what
     * this link has not seen for itself: every frame that came over it moved
     * `told` too. And each state to `digestFanout` lazy links only, not to
     * all of them: Plumtree's IHAVE to every lazy link costs one frame per
     * LINK of the room per message (E, ~10x N-1) unless many messages share
     * a frame - an idle room's beacons, one every 15 s, do not: 100 idle
     * browsers sent 68 digests a second, 1 kB/s each, for 5 beacons a
     * minute. A peer that missed a frame is told by one of its k neighbours
     * with 1-(1-f/k)^k (k=15, f=2: 87 %), by the origin's next state again,
     * and the core's own beacons repair the document either way. (A full
     * DIGEST to every new link was tried: it cost an idle room 5x and bought
     * nothing - a joiner's roster comes from the answers to its JOIN, and an
     * origin it has not heard yet is created by that origin's next frame.)
     */
    private _digestTick;
    private _onDigest;
    private _onGraft;
    /** SUSPECT names its target; ALIVE names the SUSPECT it answers (that frame's origin and seq). */
    private _broadcastControl;
    /**
     * Our link to `peer` closed. Every neighbour of a dead peer notices that
     * at about the same time: wait a random moment, and say nothing if
     * somebody else's SUSPECT came by meanwhile.
     */
    private _scheduleSuspect;
    private _suspect;
    private _gone;
    private _alive;
    private _onControl;
    private _publishRoomSize;
}
//# sourceMappingURL=index.d.ts.map