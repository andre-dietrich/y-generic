export function isChunk(x) {
    return (typeof x === 'object' &&
        x !== null &&
        x.chunked === true &&
        typeof x.id === 'string' &&
        typeof x.data === 'string');
}
/** Split `data` into chunks of at most `maxChars`; one chunk when it fits. */
export function splitChunks(data, maxChars) {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const total = Math.max(1, Math.ceil(data.length / maxChars));
    const chunks = [];
    for (let i = 0; i < total; i++) {
        chunks.push({ chunked: true, id, index: i, total, data: data.slice(i * maxChars, (i + 1) * maxChars) });
    }
    return chunks;
}
/** Reassembles chunks per id; returns the whole payload once complete. */
export class ChunkAssembler {
    constructor(maxPending = 32) {
        this.maxPending = maxPending;
        this.pending = new Map();
    }
    push(chunk) {
        let parts = this.pending.get(chunk.id);
        if (!parts) {
            // ponytail: oldest-first eviction bounds memory when a sender's
            // chunks never complete (lost event); no per-id timers.
            if (this.pending.size >= this.maxPending) {
                this.pending.delete(this.pending.keys().next().value);
            }
            parts = new Map();
            this.pending.set(chunk.id, parts);
        }
        parts.set(chunk.index, chunk.data);
        if (parts.size < chunk.total)
            return null;
        this.pending.delete(chunk.id);
        let out = '';
        for (let i = 0; i < chunk.total; i++) {
            const part = parts.get(i);
            if (part === undefined)
                return null;
            out += part;
        }
        return out;
    }
    clear() {
        this.pending.clear();
    }
}
//# sourceMappingURL=chunking.js.map