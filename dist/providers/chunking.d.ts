/**
 * Chunk envelope shared by the providers whose backend caps a single
 * message (Matrix 65,536 B canonical JSON per event, Nostr 64 KiB per
 * event, Supabase 256 KB per broadcast). Same shape PubNub and Ably use
 * for theirs. Payloads are the provider's base64 string; the provider
 * decides the limit after its own encoding.
 */
export interface Chunk {
    chunked: true;
    id: string;
    index: number;
    total: number;
    data: string;
}
export declare function isChunk(x: unknown): x is Chunk;
/** Split `data` into chunks of at most `maxChars`; one chunk when it fits. */
export declare function splitChunks(data: string, maxChars: number): Chunk[];
/** Reassembles chunks per id; returns the whole payload once complete. */
export declare class ChunkAssembler {
    private readonly maxPending;
    private pending;
    constructor(maxPending?: number);
    push(chunk: Chunk): string | null;
    clear(): void;
}
//# sourceMappingURL=chunking.d.ts.map