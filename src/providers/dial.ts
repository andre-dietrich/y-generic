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
  dial: number
  /** Hard cap: a peer at it neither dials nor accepts. */
  maxConns: number
  /**
   * `true`: never dial an announcer (a leaf - a phone: it holds the links it
   * asked for, nobody else's). It still announces and accepts.
   */
  passive?: boolean
  /** Answer a little more often than needed, so that one announce is usually enough. @default 1.3 */
  oversample?: number
  /** For tests. */
  random?: () => number
}

export class SparseDial {
  passive: boolean
  private readonly _dial: number
  private readonly _maxConns: number
  private readonly _oversample: number
  private readonly _random: () => number
  private _heard = new Set<string>()
  private _leaves = new Set<string>()
  private _roomSize = 0

  constructor(options: SparseDialOptions) {
    this._dial = options.dial
    this._maxConns = options.maxConns
    this.passive = options.passive ?? false
    this._oversample = options.oversample ?? 1.3
    this._random = options.random ?? Math.random
  }

  /** The room size the layer above has counted (peers, this one included). */
  setRoomSize(peers: number): void {
    this._roomSize = peers
  }

  /** Announce (again)? `links`: open and pending ones. */
  wantsLinks(links: number): boolean {
    return links < this._dial
  }

  /** May an offer from a peer we did not dial be accepted? */
  accepts(links: number): boolean {
    return links < this._maxConns
  }

  /** Anything on the signaling channel names its sender: one more peer of the room. */
  heard(peer: string): void {
    this._heard.add(peer)
  }

  /** `peer` announced itself and we have no link to it: dial it? `peerPassive`: what its announce said. */
  answers(peer: string, links: number, peerPassive = false): boolean {
    this._heard.add(peer)
    if (peerPassive) this._leaves.add(peer)
    if (links >= this._maxConns) return false
    // Two leaves have nothing to say to each other that a relay would not pass on.
    if (this.passive && peerPassive) return false
    // Those who may answer: leaves do not. Their share is what we have seen of it.
    const relays = 1 - this._leaves.size / Math.max(1, this._heard.size)
    const others = Math.max(1, (Math.max(this._roomSize, this._heard.size + 1, links + 1) - 1) * Math.max(0.1, relays))
    // A room that starts: take whoever is there. Later, being short of links
    // is no reason - our own announce gets us ours, and in a join burst the
    // last few joiners are all short and would all dial the next one.
    if (links < this._dial && others <= 2 * this._dial && (this.passive || !peerPassive)) return true
    if (this.passive) return false
    return this._random() < (this._oversample * this._dial) / others
  }

  /** A peer id changed or left: forget it as an announcer. */
  forget(peer: string): void {
    this._heard.delete(peer)
    this._leaves.delete(peer)
  }
}
