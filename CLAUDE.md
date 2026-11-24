# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This branch: `edrys`

`edrys` is the long-lived branch for edrys-Lite, published as `@edryslabs/genericprovider`
(2.x, 3.x). It was cut from `dev-premerge-backup` — the pre-merge `dev`, published as 1.0.4 — and
**is never merged with `main`**. `main` is upstream `genericprovider` (1.5.x, used by
LiaScript) and evolves independently. If an upstream fix is wanted here, port it as a
targeted cherry-pick or re-implementation, never as a merge: the last full merge (v1.5.0 into
`dev`, now history on the `dev` branch and the 1.5.1/1.5.2 releases) silently broke edrys
module cursors and simple-peer discovery.

Wire compatibility: 2.x and 3.x speak the same wire format as 1.0.4 and are **not** compatible with
1.5.x (see wire types below). Every peer in a room, and the edrys WebSocket relay's opcode
allow-list, must match.

## What this is

A backend-agnostic Yjs provider. The core (`src/index.ts`'s `GenericProvider`) implements all
Yjs sync/awareness/pub-sub protocol logic; a `Transport` (`src/transport.ts`) is a small
interface (`connect`, `disconnect`, `send`, `onMessage`, optional `onPeerConnect`,
`onPeerDisconnect`, `sendTo`, `preferredBatchMs`) implemented per backend. The package ships
only what edrys-Lite uses: `GenericProvider` (root export) and the `simple-peer` and `websocket`
transports (`@edryslabs/genericprovider/providers/<name>`; simple-peer is an optional peer
dependency). `src/providers/dummy` is an in-memory transport for tests and benches; it is
excluded from the build and not exported. The other upstream transports (gun, trystero,
peerjs, indexeddb, matrix, pubnub, supabase, nostr) and `sync-monitor` were removed in 3.0.0;
don't re-add them here.

## Commands

- `npm run build` — `rm -rf dist && tsc`. `dist/` is **tracked and committed**: every commit
  that touches `src/` rebuilds it and includes the result.
- `npm run dev:dummy` / `dev:simple-peer` / `dev:websocket` — serves `test/<name>/index.html`
  via Parcel for manual browser testing (`test/TEST.md` lists the Dummy-transport scenarios).
- Benchmarks/repros in `test/dummy/bench-*.ts` / `repro-*.ts`, compiled with
  `tsconfig.bench.json` and run under plain Node (output in gitignored `bench-dist/`):
  ```
  npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-late-join.js
  ```
  Read each file's header before changing it; it encodes the scenario being measured.

- `npm test` — vitest unit tests in `test/unit/` (Node, no browser; the publish workflow runs
  them before `npm publish`). Fakes for the transport, WebSocket and simple-peer live in
  `test/unit/helpers.ts`.
  - `wire-format.test.ts` checks encode and decode against `fixtures/wire-2.0.3.json`, frames
    captured from 2.0.3. If it fails, the wire changed: that breaks 2.0.x peers unless it was
    intended. Never re-capture the fixture (`WIRE_CAPTURE=1`) to make it pass.
  - `known-bugs.test.ts` holds `test.fails` tests that describe the correct behaviour of
    known bugs. A fix makes its test pass, which vitest reports as an error: remove the
    `.fails` marker in the same commit as the fix.

When changing sync/awareness/resync logic, add a unit test; for load or scaling behaviour, add
or extend a bench script.

Releases: bump `package.json`, commit, push a tag matching the version (bare numbers, e.g.
`2.0.1`); `.github/workflows/publish-npm.yml` publishes on tag push.

## Architecture

### Wire types (`src/index.ts`)

`MESSAGE_SYNC` (0), `MESSAGE_AWARENESS` (1), `MESSAGE_PUBSUB` (2), `MESSAGE_SYNC_VERIFIED` (3,
sequence number + sync message + state-vector hash), `MESSAGE_PUBSUB_TARGETED` (4). Every
frame is prefixed with a 4-byte CRC32 (`wrapMessageWithChecksum`).

Opcode 3 is receive-only: updates are always sent as opcode 0, but 2.0.x peers still send 3,
so it is decoded with its sequence number and hash skipped. Its hash mismatched on ordinary
concurrent edits and caused needless full-document resyncs. The `verifyUpdates`, `gapGraceMs`
and `seqWindowSize` options that controlled it were removed in 3.0.0.

`MESSAGE_AWARENESS` carries a channel byte after the type: `AWARENESS_CHANNEL_MAIN` (0) for
edrys' own identity/presence, `AWARENESS_CHANNEL_APP` (1) for `appAwareness`. This differs
from upstream 1.5.x, where 4 is `MESSAGE_BATCH`, targeted pubsub is 7 and app awareness is
its own type 8. Don't renumber or "align" these with upstream on this branch — mismatched
peers mis-decode silently instead of failing.

### Core protocol

- **Sync**: `y-protocols/sync` (`_handleSyncMessage`). Lost updates are recovered by the
  periodic SyncStep1 (`syncInterval`, default 5s).
- **Resync coordinator** (`_requestResync`): a CRC-failed message schedules one resync with
  exponential backoff; bursts coalesce into it (rationale:
  `docs/superpowers/plans/2026-07-26-sync-storm-ratelimit.md`, written when hash-mismatch and
  sequence-gap triggers still existed).
- **Sync-request rate limiting** (`_syncRequestTimes`), shared by SyncStep1 pulls,
  `syncNow()` pushes and SyncStep2 replies.
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
- **`syncMode: 'pull'`** — WebSocket adapter only: a pull-only join adopts the server's
  document instead of pushing a stale local copy. (Up to 2.0.3 it also needed
  `verifyUpdates: false`: the edrys relay passes opcode 3 on to other clients but doesn't
  apply it to its stored document, so late joiners pulling from it missed those edits.)
- **WebSocket `connect()` stays pending while the server is unreachable** and resolves once a
  retry opens (with `autoReconnect`, the default). The adapter doesn't await it; it sends its
  first heartbeat in `.then()`.
