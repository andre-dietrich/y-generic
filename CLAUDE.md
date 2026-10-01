# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This branch: `edrys`

`edrys` is the long-lived branch for edrys-Lite, published as `@edryslabs/genericprovider`
(2.x). It was cut from `dev-premerge-backup` — the pre-merge `dev`, published as 1.0.4 — and
**is never merged with `main`**. `main` is upstream `genericprovider` (1.5.x, used by
LiaScript) and evolves independently. If an upstream fix is wanted here, port it as a
targeted cherry-pick or re-implementation, never as a merge: the last full merge (v1.5.0 into
`dev`, now history on the `dev` branch and the 1.5.1/1.5.2 releases) silently broke edrys
module cursors and simple-peer discovery.

Wire compatibility: 2.x speaks the same wire format as 1.0.4 and is **not** compatible with
1.5.x (see wire types below). Every peer in a room, and the edrys WebSocket relay's opcode
allow-list, must match.

## What this is

A backend-agnostic Yjs provider. The core (`src/index.ts`'s `GenericProvider`) implements all
Yjs sync/awareness/pub-sub protocol logic; a `Transport` (`src/transport.ts`) is a small
interface (`connect`, `disconnect`, `send`, `onMessage`, optional `onPeerConnect`,
`onPeerDisconnect`, `sendTo`, `preferredBatchMs`) implemented per backend. `src/providers/*`
are reference transports (dummy, websocket, gun, trystero, peerjs, simple-peer, indexeddb,
matrix, pubnub, supabase, nostr), each its own subpath export
(`@edryslabs/genericprovider/providers/<name>`), mostly behind optional peer dependencies.

## Commands

- `npm run build` — `rm -rf dist && tsc`. `dist/` is **tracked and committed**: every commit
  that touches `src/` rebuilds it and includes the result.
- `npm run dev:<provider>` — serves `test/<provider>/index.html` via Parcel for manual browser
  testing (`test/TEST.md` lists the Dummy-transport scenarios).
- Benchmarks/repros in `test/dummy/bench-*.ts` / `repro-*.ts`, compiled with
  `tsconfig.bench.json` and run under plain Node (output in gitignored `bench-dist/`):
  ```
  npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-late-join.js
  ```
  Read each file's header before changing it; it encodes the scenario being measured.

There is no automated test runner. When changing sync/awareness/resync logic, add or extend a
bench script rather than hand-testing.

Releases: bump `package.json`, commit, push a tag matching the version (bare numbers, e.g.
`2.0.1`); `.github/workflows/publish-npm.yml` publishes on tag push.

## Architecture

### Wire types (`src/index.ts`)

`MESSAGE_SYNC` (0), `MESSAGE_AWARENESS` (1), `MESSAGE_PUBSUB` (2), `MESSAGE_SYNC_VERIFIED` (3,
sync + CRC32 + state-vector hash + sequence number), `MESSAGE_PUBSUB_TARGETED` (4).

`MESSAGE_AWARENESS` carries a channel byte after the type: `AWARENESS_CHANNEL_MAIN` (0) for
edrys' own identity/presence, `AWARENESS_CHANNEL_APP` (1) for `appAwareness`. This differs
from upstream 1.5.x, where 4 is `MESSAGE_BATCH`, targeted pubsub is 7 and app awareness is
its own type 8. Don't renumber or "align" these with upstream on this branch — mismatched
peers mis-decode silently instead of failing.

### Core protocol

- **Sync**: `y-protocols/sync` with an optional verified variant (`verifyUpdates`).
- **Unified resync coordinator** (`_requestResync`): hash-mismatch, corruption and gap
  triggers share one timer and one exponential backoff (rationale:
  `docs/superpowers/plans/2026-07-26-sync-storm-ratelimit.md`).
- **Sync-request rate limiting** (`_syncRequestTimes`), shared by SyncStep1 pulls and
  `syncNow()` pushes.
- **SyncStep2 reply suppression** (`_pendingSyncReply`) when ≥3 awareness states are known.
- **Update batching** (`batchUpdates`, defaulting to `transport.preferredBatchMs`) and
  **awareness throttling** are separate debounce paths.
- **Cross-tab sync** via `BroadcastChannel` (`_setupBroadcastChannel`), replaying both
  awareness channels to other tabs.
- **Peer join**: `onPeerConnect` triggers a full-state `syncNow()` broadcast. On mesh
  transports (simple-peer, peerjs, trystero) this is O(N²) when many peers join at once —
  upstream replaced it with a per-peer digest beacon in 1.5.x. Known limitation here; port it
  deliberately if large classrooms need it.

## How edrys-Lite uses this library

edrys-Lite (`src/ts/`: `GenericWebrtcProviderAdapter`, `GenericWebsocketProviderAdapter`,
`EdrysSimplePeerTransport`) depends on all of the following. Each has a failure mode attached.

- **`appAwareness`** — second awareness instance (channel 1 of `MESSAGE_AWARENESS`) handed to
  untrusted classroom modules for cursors; core `awareness` carries edrys identity/presence.
  Keep the two states separate.
- **`sendControl` / `onControlFrame` / `disconnectPeer`** (simple-peer `MSG_TYPE_CONTROL`,
  0x02) — per-peer side-channel for edrys' signed identity handshake. These frames bypass the
  provider pipe: never CRC-verified, decrypted or decoded as Yjs data.
- **Set-based `onPeerConnect`/`onPeerDisconnect` in simple-peer** — `EdrysSimplePeerTransport`
  and the provider both register listeners; single callback slots would drop one of them.
- **simple-peer `scheduleSignalingReconnect` / `signalingHealth` / `pruneStalePeer`** — retry
  dropped signaling sockets (`isConnected` is a lifecycle flag, not health) and forget peers
  with no live connection so they can reconnect. In `disconnect()`, `_connected = false` must
  be set before closing sockets.
- **`localId` + `pubsub.publishTo`** (type 4) — direct messages addressed by edrys userid;
  unicast via `sendTo` where available, broadcast-and-filtered on `localId` otherwise.
- **`excludeOrigins`** — both adapters pass `[REVERT_INVALID_ORIGIN]` so local rollback
  transactions stay off the wire.
- **`syncMode: 'pull'` + `verifyUpdates: false`** — WebSocket adapter only: the edrys relay
  doesn't forward verified sync (3), and a pull-only join adopts the server's document instead
  of pushing a stale local copy.
