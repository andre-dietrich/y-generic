# Nostr Persistent Mode Implementation Plan

**Goal:** Let `NostrTransport` publish durable, bounded Yjs snapshots via NIP-01 addressable events, so a late joiner catches up from a relay's own storage - no live peer, and no relay restart, required. The self-hosted classroom relay (`Docker/nostr/relay.js`) gains generic NIP-01 replaceable/addressable replace-on-write semantics, persisted to disk.

**Spec:** `docs/superpowers/specs/2026-09-07-nostr-persistent-mode-design.md`

Implemented directly in one session (not via subagent-driven-development - the change is self-contained to the Nostr provider and its relay, does not touch `src/index.ts`, and needed no task-by-task delegation). Recorded here per this repo's convention for point-in-time protocol/wire-format change records.

## What changed, in order

1. **`Docker/nostr/relay.js`**: `replaceKey()` computes a NIP-01 replace-on-write key for replaceable (10000-19999, `pubkey:kind`) and addressable (30000-39999, `pubkey:kind:d-tag`) events; such events go into a `latestByKey` Map instead of the regular `events` FIFO, replacing on a newer `created_at` (tie-break: larger `id`). Persisted to `/srv/snapshots.json` (env override `SNAPSHOT_FILE`, used by the test script), loaded at startup, written through a 200 ms debounced coalescer. `REQ` handling and the broadcast-on-`EVENT` loop both now also scan `latestByKey.values()`.
2. **`Docker/nostr/Dockerfile`, `entrypoint.sh`**: header comments updated to describe the new persisted keyed-event file (previously: "no disk persistence").
3. **`src/providers/nostr/index.ts`**: `NostrConfig` gains `persistent`, `doc`, `persistentKind` (default 30078), `persistDebounceMs` (default 2000). On `connect()` with `persistent: true`: a second `subscribeMany` fetches `{kinds: [persistentKind], '#d': [roomTag#0 .. roomTag#(MAX_SNAPSHOT_CHUNKS-1)]}` into a dedicated `ChunkAssembler`, and `doc.on('update', ...)` debounces into `_publishSnapshot()`, which always chunk-envelopes `Y.encodeStateAsUpdate(doc)` (even a single part) and publishes one addressable event per chunk index. A reassembled snapshot is wrapped via `wrapFrame()` (CRC32 header + the leading compression-flag byte GenericProvider expects by default for this transport - see the spec doc for why this bit us during implementation) and delivered as `MESSAGE_SYNC_PUSH`.
4. **`src/providers/nostr/README.md`**: new "Persistent mode" section; updated the old "use a regular eventKind (1000-9999)" recommendation to point at persistent mode first.
5. **`test/nostr/relay.sh`** (new): classroom Docker launcher, mirrors `test/gun/relay.sh`.
6. **`test/nostr/live-relay.mjs`** (new): spawns the relay as a child process, proves cross-restart snapshot durability and torn-batch safety (see spec doc's Verification section).

## Verification performed

- `npm run build` (core + all providers compile).
- `npx tsc -p tsconfig.bench.json && node test/nostr/live-relay.mjs`: both PASS lines (cross-restart convergence, torn-batch rejection).
- `docker build -t liascript/nostr-relay:test Docker/nostr` + a real `docker restart` mid-test (not just the script's own child-process restart) + `docker exec ... cat /srv/snapshots.json`: snapshot survives, a fresh client converges.
- `test/nostr/relay.sh` smoke-tested in both `MODE=http` and `MODE=https` (self-signed cert generated, relay reachable).

## Known gaps, left as-is

- Not measured against public relays for the addressable kind specifically (only our own relay was tested) - flagged in the README as unverified, not asserted as working.
- `MAX_SNAPSHOT_CHUNKS = 20` bound is a fixed guess, not a two-phase probe - documented upgrade path, not built (see spec doc).
- `compressionThresholdBytes: 0` explicitly set on the consuming GenericProvider is incompatible with persistent mode - documented, not solved (would need a public way for a transport to read the provider's resolved threshold).
