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

Wire compatibility: 3.x frames are 2.x frames (the 1.0.4 format) without the 4-byte CRC32
header, and simple-peer no longer XORs them with a password. So 3.x can't talk to 2.x over
WebRTC or BroadcastChannel; `WIRE_TAG` (`'v3'`, in both `src/index.ts` and
`providers/simple-peer`) is part of the signaling topic and channel name so the two never
meet. Bump it on the next wire change there. On a WebSocket the bytes are unchanged (2.x
already stripped the CRC32 before sending), so 2.x and 3.x clients share the edrys relay,
and 2.0.x clients still send opcode 3 through it. None of this is compatible with upstream
1.5.x (see wire types below). Every peer in a room, and the relay's opcode allow-list, must
match.

## What this is

A backend-agnostic Yjs provider. The core (`src/index.ts`'s `GenericProvider`) implements all
Yjs sync/awareness/pub-sub protocol logic; a `Transport` (`src/transport.ts`) is a small
interface (`connect`, `disconnect`, `send`, `onMessage`, optional `onPeerConnect`,
`onPeerDisconnect`, `sendTo`, `preferredBatchMs`, `reachesAllPeers`) implemented per backend.
The package ships only what edrys-Lite uses: `GenericProvider` (root export) and the
`simple-peer` and `websocket` transports (`@edryslabs/genericprovider/providers/<name>`;
simple-peer is an optional peer dependency). `src/providers/dummy` is an in-memory transport
for tests and benches; it is excluded from the build and not exported. The other upstream
transports (gun, trystero, peerjs, indexeddb, matrix, pubnub, supabase, nostr) and
`sync-monitor` were removed in 3.0.0; don't re-add them here.

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
    captured from 2.0.3: each 3.x provider frame must equal its 2.0.3 counterpart minus the
    CRC32 header. If it fails, the wire changed, which breaks peers on the WebSocket relay
    and other 3.x peers unless it was intended. The fixture is fixed; never edit it to make
    the test pass.
  - Known but unfixed bugs go in `known-bugs.test.ts` as `test.fails` tests that describe the
    correct behaviour (none at the moment, so the file doesn't exist). A fix makes its test
    pass, which vitest reports as an error: remove the `.fails` marker and move the test next
    to the related tests in the same commit as the fix.

When changing sync/awareness/resync logic, add a unit test; for load or scaling behaviour, add
or extend a bench script.

Releases: bump `package.json`, commit, push a tag matching the version (bare numbers, e.g.
`2.0.1`); `.github/workflows/publish-npm.yml` publishes on tag push.

## Architecture

### Wire types (`src/index.ts`)

`MESSAGE_SYNC` (0), `MESSAGE_AWARENESS` (1), `MESSAGE_PUBSUB` (2), `MESSAGE_SYNC_VERIFIED` (3,
sequence number + sync message + state-vector hash), `MESSAGE_PUBSUB_TARGETED` (4). A frame
is `[opcode][payload]` with no checksum (removed in 3.1.0: WebSocket and WebRTC data channels
are reliable and TLS/DTLS-authenticated). A frame that fails to decode is dropped and the
periodic SyncStep1 recovers whatever it carried.

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
- **Sync-request rate limiting** (`_syncRequestTimes`), shared by SyncStep1 pulls,
  `syncNow()` pushes and SyncStep2 replies.
- **SyncStep2 reply suppression** (`_pendingSyncReply`) when ≥3 awareness states are known.
- **Update batching** (`batchUpdates`, defaulting to `transport.preferredBatchMs`) and
  **awareness throttling** are separate debounce paths.
- **Awareness relay** (`_awarenessClientsToSend`): when `transport.reachesAllPeers` is true
  (WebSocket, dummy, a small complete simple-peer mesh) a provider broadcasts only changes made
  locally, filtered by origin, not clientID: edrys applies module cursors into `appAwareness`
  under the module's own clientID, and those must still go out. One exception: a received
  change that touched our own clientID is answered with our state, because y-protocols counters
  a remote removal of our state (keeps it, bumps the clock) with origin = provider, and only
  that broadcast tells the other peers we're still here (edrys Exploit 1). Otherwise it re-broadcasts every remote change once, which is how presence
  crosses a partial WebRTC mesh (room ≥ 20 peers or a pair that can't connect); remote
  states expire after 30s without renewal. Re-broadcasting on a full mesh or relay is pure
  duplication (N² frames, see `bench-awareness-relay.ts`).
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
  provider pipe: never held by the trust gate or decoded as Yjs data.
- **`requireTrust` / `trustPeer`** (simple-peer) — `EdrysSimplePeerTransport` turns on
  `requireTrust` and calls `trustPeer(peerId)` once the handshake verifies. Until then the
  peer's data frames are held (max 256 frames / 16 MB, discarded on disconnect; its partial
  chunked messages are capped at 16 MB too, 64 MB once trusted, since reassembly runs before the
  gate), so an
  unverified peer can't inject doc, awareness or pubsub data. Holding instead of dropping
  keeps the newcomer's initial sync; control frames are never held.
- **`localPeerId` / `getPeerFingerprints(peerId)`** (simple-peer) — the handshake signature
  covers both peer ids and both DTLS fingerprints, so it can't be replayed on another
  connection. Missing fingerprints mean the peer is rejected, so `getPeerFingerprints` must
  keep returning both once the channel is open.
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
