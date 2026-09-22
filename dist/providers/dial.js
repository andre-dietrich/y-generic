export class SparseDial {
    constructor(options) {
        this._heard = new Set();
        this._leaves = new Set();
        this._roomSize = 0;
        this._dial = options.dial;
        this._maxConns = options.maxConns;
        this.passive = options.passive ?? false;
        this._oversample = options.oversample ?? 1.3;
        this._random = options.random ?? Math.random;
    }
    /** The room size the layer above has counted (peers, this one included). */
    setRoomSize(peers) {
        this._roomSize = peers;
    }
    /** Announce (again)? `links`: open and pending ones. */
    wantsLinks(links) {
        return links < this._dial;
    }
    /** May an offer from a peer we did not dial be accepted? */
    accepts(links) {
        return links < this._maxConns;
    }
    /** Anything on the signaling channel names its sender: one more peer of the room. */
    heard(peer) {
        this._heard.add(peer);
    }
    /** `peer` announced itself and we have no link to it: dial it? `peerPassive`: what its announce said. */
    answers(peer, links, peerPassive = false) {
        this._heard.add(peer);
        if (peerPassive)
            this._leaves.add(peer);
        if (links >= this._maxConns)
            return false;
        // Two leaves have nothing to say to each other that a relay would not pass on.
        if (this.passive && peerPassive)
            return false;
        // Those who may answer: leaves do not. Their share is what we have seen of it.
        const relays = 1 - this._leaves.size / Math.max(1, this._heard.size);
        const others = Math.max(1, (Math.max(this._roomSize, this._heard.size + 1, links + 1) - 1) * Math.max(0.1, relays));
        // A room that starts: take whoever is there. Later, being short of links
        // is no reason - our own announce gets us ours, and in a join burst the
        // last few joiners are all short and would all dial the next one.
        if (links < this._dial && others <= 2 * this._dial && (this.passive || !peerPassive))
            return true;
        if (this.passive)
            return false;
        return this._random() < (this._oversample * this._dial) / others;
    }
    /** A peer id changed or left: forget it as an announcer. */
    forget(peer) {
        this._heard.delete(peer);
        this._leaves.delete(peer);
    }
}
//# sourceMappingURL=dial.js.map