/**
 * Chunk envelope shared by the providers whose backend caps a single
 * message (Matrix 65,536 B canonical JSON per event, Nostr 64 KiB per
 * event, Supabase 256 KB per broadcast). Same shape PubNub and Ably use
 * for theirs. Payloads are the provider's base64 string; the provider
 * decides the limit after its own encoding.
 */
export interface Chunk {
  chunked: true
  id: string
  index: number
  total: number
  data: string
}

export function isChunk(x: unknown): x is Chunk {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as Chunk).chunked === true &&
    typeof (x as Chunk).id === 'string' &&
    typeof (x as Chunk).data === 'string'
  )
}

/** Split `data` into chunks of at most `maxChars`; one chunk when it fits. */
export function splitChunks(data: string, maxChars: number): Chunk[] {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
  const total = Math.max(1, Math.ceil(data.length / maxChars))
  const chunks: Chunk[] = []
  for (let i = 0; i < total; i++) {
    chunks.push({ chunked: true, id, index: i, total, data: data.slice(i * maxChars, (i + 1) * maxChars) })
  }
  return chunks
}

/** Reassembles chunks per id; returns the whole payload once complete. */
export class ChunkAssembler {
  private pending = new Map<string, Map<number, string>>()
  constructor(private readonly maxPending = 32) {}

  push(chunk: Chunk): string | null {
    let parts = this.pending.get(chunk.id)
    if (!parts) {
      // ponytail: oldest-first eviction bounds memory when a sender's
      // chunks never complete (lost event); no per-id timers.
      if (this.pending.size >= this.maxPending) {
        this.pending.delete(this.pending.keys().next().value as string)
      }
      parts = new Map()
      this.pending.set(chunk.id, parts)
    }
    parts.set(chunk.index, chunk.data)
    if (parts.size < chunk.total) return null
    this.pending.delete(chunk.id)
    let out = ''
    for (let i = 0; i < chunk.total; i++) {
      const part = parts.get(i)
      if (part === undefined) return null
      out += part
    }
    return out
  }

  clear(): void {
    this.pending.clear()
  }
}
