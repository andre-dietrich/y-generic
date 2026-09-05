# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`y-generic` (npm name `genericprovider`) is a backend-agnostic Yjs provider. The core
(`src/index.ts`'s `GenericProvider`) implements all Yjs sync/awareness/pub-sub protocol
logic; a `Transport` (`src/transport.ts`) is a 4-method interface (`connect`, `disconnect`,
`send`, `onMessage`, plus optional `onPeerConnect`) that callers implement per backend.
`src/providers/*` are reference transport implementations (dummy, websocket, gun, trystero,
peerjs, simple-peer, indexeddb, matrix, pubnub, supabase, nostr) shipped as separate
subpath exports (`genericprovider/providers/<name>`), each independently tree-shakeable and
mostly gated behind optional peer dependencies.

## Commands

- `npm run build` — `rm -rf dist && tsc` (compiles `src/` per `tsconfig.json`; this is what
  `dist/` — the published artifact — is built from).
- `npm run dev:<provider>` — e.g. `npm run dev:dummy`, `npm run dev:gun`, `npm run dev:websocket`
  — serves `test/<provider>/index.html` via Parcel for interactive manual testing in a browser.
  `npm test` / `npm run dev:dummy`-equivalent opens `test.html`, the multi-client Dummy-transport
  playground (see `test/TEST.md` for the manual test scenarios it's designed to exercise).
- `npm run build:demo:<provider>` / `npm run build:demos` — builds the static demo site
  (deployed by `.github/workflows/deploy.yml` to GitHub Pages on push to `main`).

**There is no automated test runner (no jest/mocha/vitest).** Correctness is verified via:
1. The manual browser scenarios in `test/TEST.md`, run through `npm run dev:dummy`.
2. Standalone benchmark/repro scripts in `test/dummy/bench-*.ts` and `repro-*.ts`, compiled
   with the dedicated `tsconfig.bench.json` and run under plain Node — **not** through Parcel:
   ```
   npx tsc -p tsconfig.bench.json && node bench-dist/test/dummy/bench-sync-latency.js
   ```
   Each bench file's header comment has its exact run command. These exist to reproduce and
   quantify specific protocol issues (sync latency across simulated network profiles, message
   count vs. user-count scaling, packet-loss/corruption storms, late-join/asymmetric-join
   behavior) — read the file's own header before changing it, they encode the scenario being
   measured.

When changing sync/awareness/resync logic in `src/index.ts`, prefer adding or extending a
`test/dummy/bench-*.ts` script over hand-testing, since these are what caught prior regressions
(resync storms, hash-mismatch false positives, awareness loss for late joiners) with actual
numbers instead of "seems fine when I tried it."

## Architecture

### Core protocol (`src/index.ts`)

`GenericProvider` owns a `Y.Doc`, a `Transport`, and an `awarenessProtocol.Awareness`
instance, and speaks a small message-type framing over whatever the transport moves as
`Uint8Array`: `MESSAGE_SYNC` (0), `MESSAGE_AWARENESS` (1), `MESSAGE_PUBSUB` (2),
`MESSAGE_SYNC_VERIFIED` (3, sync + CRC32 + doc-hash + sequence number). Everything below is
implemented once here so individual transports stay to the 4-method interface:

- **Sync protocol**: standard `y-protocols/sync` (SyncStep1/SyncStep2/Update), with an
  optional verified variant (`verifyUpdates`, default on) that wraps messages with a CRC32
  checksum, a cheap O(distinct-clients) doc hash (`computeDocHash`, hashes the *state vector*,
  not full content), and a per-sender sequence number for gap/duplicate/reorder detection.
- **Unified resync coordinator** (`_requestResync` / `_pendingResyncTimeoutId` /
  `_resyncAttemptCount`): hash-mismatch, corrupted-message, and confirmed-gap triggers all
  route through one pending timer and one shared exponential-backoff counter, so they can't
  each independently spam resyncs under sustained corruption — this replaced three
  independently-escalating triggers after that was found to cause an ~11x message-volume
  "resync storm" under 5% link corruption (see `docs/superpowers/plans/2026-07-26-sync-storm-ratelimit.md`).
- **Sync-request rate limiting** (`_syncRequestTimes` / `_maxSyncRequestsPerWindow`): caps
  SyncStep1 pulls and `syncNow()` pushes per rolling window; `syncNow()`'s full-state push
  shares the same limiter as resync retries.
- **SyncStep2 reply suppression** (`_pendingSyncReply`): when ≥2 peers are known, a reply to
  a SyncStep1 request is delayed briefly and dropped if another peer's reply is overheard
  first, since replies broadcast to the whole room — avoids redundant identical replies.
- **Update batching** (`_batchUpdate`, `batchUpdates` option) and **awareness throttling**
  (`_awarenessInterval`) are separate debounce paths — batching coalesces doc updates,
  throttling coalesces awareness broadcasts; both exist because awareness churns much faster
  than document content typically does.
- Cross-tab sync via `BroadcastChannel` is wired independently of the transport
  (`_setupBroadcastChannel`) so multiple tabs in the same browser stay in sync without
  round-tripping through the network transport.

`Transport.preferredBatchMs` lets a transport hint its own recommended default
`batchUpdates` value (e.g. HTTP-polling or internally-debounced relays should set this;
low-latency push transports like WebSocket/PubNub/connected WebRTC should leave it undefined).

`src/sync-monitor.ts` (`SyncHealthMonitor`) is a separate, optional, pub/sub-based
peer-to-peer-broadcast health check — distinct from and complementary to the built-in
per-update `verifyUpdates` hash check. See `src/SYNC-MONITORING.md` for when to reach for
which (short version: built-in verification for fast per-update desync detection, the
monitor only for periodic all-peers diagnostics/alerting).

### Providers (`src/providers/*`)

Each provider directory holds one `Transport` implementation, generally with its own
`README.md` covering that backend's setup and options. `dummy` is the in-memory reference
transport with no external dependency, used by both `test/TEST.md`'s manual scenarios and
the `test/dummy/bench-*.ts` benchmarks — read it first when implementing a new transport, or
when a bench script's `DummyHub`/`DummyTransport` behavior itself needs to change (the design
doc `docs/superpowers/specs/2026-07-26-dummy-benchmark-scaling-design.md` explains what's
protocol-under-test vs. what's test-infrastructure-only cost).

`peerjs` and `simple-peer` are true mesh P2P transports and rely on `onPeerConnect` firing
per newly-joined remote peer to push a `syncNow()` to that peer — be aware this can produce
an O(N²) burst of full-state broadcasts when N peers join a mesh in a short window (see the
same design doc).

### Design docs

`docs/superpowers/specs/` and `docs/superpowers/plans/` contain point-in-time design/spec
documents for specific protocol changes (currently: resync-storm rate limiting, dummy
benchmark scaling). They're written *before* the corresponding code change and are useful for
the "why" behind decisions baked into `src/index.ts`, but treat them as historical rationale,
not current-state documentation — the code and its inline comments are authoritative for
current behavior.

## Package structure notes

- `main`/`types` point at `./dist/lib.js` / `./dist/lib.d.ts` (built output only — `dist/` is
  gitignored, always run `npm run build` before relying on it locally).
- Each transport is also its own `exports` subpath (e.g. `./providers/gun`) mapping to its own
  compiled file under `dist/providers/<name>/`, so consumers only pull in the transport they
  actually import.
- `gun`, `simple-peer`, and `peerjs` are `peerDependencies` marked optional — don't add new
  transport dependencies as regular `dependencies`; follow this pattern (peer + optional) so
  the core package stays dependency-free for consumers who don't need that transport.
