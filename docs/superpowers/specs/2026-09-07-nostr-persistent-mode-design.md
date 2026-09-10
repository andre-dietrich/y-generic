# Nostr persistent mode: durable Yjs snapshots via NIP-01 addressable events

## Problem

`NostrTransport`'s default event kind (27370) is in NIP-01's ephemeral range
(20000-29999): relays are not expected to store it. A late-joining peer
therefore only catches up from a live peer's reply - there is no durable,
relay-side copy of the document, and the self-hosted classroom relay
(`Docker/nostr/relay.js`) kept even that ephemeral traffic in memory only
(lost on restart).

The question this design answers: can Nostr's own protocol give a relay a
durable place to hold a Yjs snapshot, without switching the live channel to
a "stored" kind (which would make relay storage grow forever with edit
history)?

## Why an addressable kind, not a regular (stored) kind

NIP-01 (NIP-33 merged into it) defines **addressable events** (kind
30000-39999): a relay MUST keep only the latest event per `(kind, pubkey,
d-tag value)`, discarding older ones. This gives exactly the shape
persistence needs - one durable, bounded slot per room - as opposed to a
regular/stored kind (1000-9999) plus a wide `historyWindowSecs`, which
would make a relay replay every update ever made in the room and grow
without bound for as long as it's edited (and our own relay's `MAX_EVENTS`
FIFO cap would silently evict old history under load regardless).

An addressable kind also decouples two knobs a relay operator/transport
user might want independently: "keep the live channel ephemeral" (cheap,
high-volume, fine to lose) vs. "keep one durable snapshot per room" (cheap,
bounded) - a single flat `eventKind` cannot express both at once.

Prior art check: `YousefED/nostr-crdt` sends Yjs updates as Nostr events
but has not solved snapshotting - its own README lists periodic snapshots
as unresolved future work. This is a novel application of a mandatory
NIP-01 mechanism, not a known recipe.

## Always chunk-envelope, even a single-part snapshot

The live/ephemeral channel's `send()` only wraps content in the chunk
envelope (`{chunked, id, index, total, data}`) when it doesn't fit in one
event (`base64.length > MAX_CONTENT_CHARS`). Persistent mode does NOT use
that optimization - every snapshot publish goes through the chunk envelope,
even `total === 1`, and every part is always addressed as
`d = ${roomTag}#${index}` (never a bare `d = roomTag`).

Reason: addressable events are **address-stable, replace-on-write** slots.
If an earlier snapshot fit in one part (`d=roomTag`, no suffix) and a later,
larger one needs 3 parts (`roomTag#0..#2`), the old bare-`roomTag` slot is
never cleared - a late joiner's fetch could see a stale, complete-looking
old snapshot alongside a newer, still-being-written chunked one, with no
way to tell which is current. Using exactly one addressing scheme ever
(suffix always present, from index 0) removes that ambiguity entirely.

## Chunking strategy: atomic multi-event batches, not size-based skipping

Two options were on the table for snapshots bigger than one relay-accepted
event (~60,000 base64 chars):

- **(a) Chosen: split across multiple addressable events, one per chunk
  index, and rely on the existing chunk-reassembly invariant for
  atomicity.** Each publish gets a fresh `id` (from `splitChunks`).
  `ChunkAssembler.push()` only ever returns a result once it has seen
  `total` parts sharing the same `id` (`chunking.ts:54`). If a publish is
  interrupted mid-batch (crash between chunk writes), a reader fetching
  that room's chunk range sees a mix of new-`id` and old-`id` parts -
  neither the new batch (missing a part) nor the old one (some slots
  overwritten) ever completes. The assembler simply never resolves; no
  partial or corrupted state is ever applied. This is the exact invariant
  the live channel's own oversized-message chunking already relies on,
  reused here across multiple `REQ`-fetched addressable events instead of
  multiple live-broadcast events - no new relay logic needed to guarantee
  it (verified in `test/nostr/live-relay.mjs`'s torn-batch check).
- **(b) Rejected for now: skip the publish and warn when it's too big to
  chunk, keep the live channel as the only fallback.** Simpler (no
  multi-event write), but the user explicitly asked for the more robust,
  atomic option instead of silently losing snapshot durability for large
  documents.

The one bound (a) does not solve: `MAX_SNAPSHOT_CHUNKS = 20` on the fetch
side (the transport doesn't know a snapshot's real `total` before fetching,
so it requests a fixed candidate range of `d` tags up front) means a
document whose snapshot needs more than 20 chunks (~900 KB of raw,
post-compression state) never finds a complete match - harmless per the
invariant above, but also never durably caught up; the live channel still
keeps connected peers in sync. Documented as a `ponytail:`-marked bound in
code; the upgrade path is a two-phase probe (fetch chunk 0 alone first to
learn the real `total`, then fetch exactly that many) instead of guessing a
fixed range.

## Publish trigger: `doc.on('update')`, not peeking the wire frame

`src/providers/supabase/index.ts`'s `persistent` mode detects local
changes by peeking the outgoing frame's message-type byte inside its own
`send()` (`payload[0] !== MESSAGE_AWARENESS`), and explicitly documents
that this only works because it does **not** set `preferredCompressMinBytes`
- compression inserts a flag byte that shifts the offset.

`NostrTransport` already declares `preferredCompressMinBytes = 2048`, so
that peeking trick is not safe to reuse here (confirmed empirically while
building this: an early version of the fetch path that reused Supabase's
`addCRC32Header` without the compression flag byte failed with
`Z_DATA_ERROR: invalid code lengths set` - GenericProvider read the
snapshot frame's first CRC byte as a compression flag and tried to inflate
garbage). Persistent mode instead watches `config.doc.on('update', ...)`
directly, which is robust regardless of compression/CRC framing, at the
cost of needing the `Y.Doc` reference (same as Supabase's `doc` option).

## The compression-flag-byte wire detail (see `wrapFrame()`)

GenericProvider's wire format, when `compressionThresholdBytes` is active
on the *receiving* provider (which is the default for anything using this
transport, since `preferredCompressMinBytes` becomes that default unless a
caller explicitly overrides it): `[flag:1 byte][CRC32:4 bytes][message
type + payload]` - the flag byte comes **before** the CRC32 header, not
after. A synthetic frame built by hand (the snapshot delivery path, since
it doesn't go through GenericProvider's own send-side encoding) has to add
that flag byte itself; `wrapFrame()` in `src/providers/nostr/index.ts` does
this (always writing `0` = uncompressed, since the snapshot content is
already whatever it is by the time it's decoded from base64).

This means persistent mode is **not** supported together with an
explicit `compressionThresholdBytes: 0` override on the consuming
GenericProvider (the flag byte would then not be expected) - the same
limitation Supabase's `persistent` mode documents for its own,
opposite-default case. Neither transport has visibility into the
receiving provider's actually-resolved threshold (it's a private field,
not exposed), so this can't be resolved generically without a
core-protocol change; out of scope here.

## Relay-side persistence (`Docker/nostr/relay.js`)

Generic NIP-01 replace-on-write for any replaceable (10000-19999) or
addressable (30000-39999) kind - not special-cased to the one persistent
snapshot kind, matching spec. Keyed events live only in a `Map`
(`latestByKey`), never duplicated into the regular `events` FIFO array.
Persisted as a single `/srv/snapshots.json` (one file, not one-per-room -
proportional to a classroom relay's realistic room count), loaded once at
startup and written through a 200 ms debounced coalescer so a burst of
snapshot publishes doesn't fsync once per event. Only the bounded, keyed
set is persisted - the high-volume ephemeral live-update kind stays
memory-only by design, unchanged from before this work.

## Verification

`test/nostr/live-relay.mjs` (mirrors `test/gun/live-relay.mjs`'s
spawn-a-relay-child-process pattern, no Docker required to run it):
1. Peer A writes 150,000 characters (forces a 4-chunk snapshot), waits for
   the debounced publish, disconnects.
2. The relay process is killed and respawned against the same snapshot
   file (simulating a container restart - the in-memory ephemeral event
   list is gone; only the persisted file survives).
3. Peer B connects fresh, with no live peer online, and is asserted to
   converge to A's exact content - proving the snapshot, not a live peer
   reply, was the catch-up source, across an actual process restart.
4. A hand-crafted torn batch (3 of 4 chunks published, one deliberately
   withheld) is asserted to never be applied by a fresh peer C.

Also manually verified against the real Docker image
(`liascript/nostr-relay`) with an actual `docker restart` in between (not
just the script's own child-process restart) - see this doc's commit for
the session's raw output. `test/nostr/relay.sh` (mirrors
`test/gun/relay.sh`) smoke-tested in both `MODE=http` and `MODE=https`.
