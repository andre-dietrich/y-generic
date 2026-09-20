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
   Each bench file's header comment has its exact run command (a few need extras named
   there: `node --expose-gc`, `npm install --no-save fake-indexeddb`). These exist to reproduce and
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

`peerjs`, `simple-peer` and `trystero` are true mesh P2P transports: `onPeerConnect` fires per
newly-joined remote peer and, since round 5, the provider answers each with one unicast digest
beacon (`_schedulePeerConnectSync`, debounced 50 ms) instead of a full-state `syncNow()`
broadcast — the O(N²) full-state burst the dummy benchmark design doc describes is history;
`test/dummy/bench-mesh-join-burst.ts` is the gate.

What phones do to these transports (a suspended page: silent links dropped by the room after
~30 s, a dead signaling socket, a wall-clock jump on resume) is covered by
`docs/superpowers/specs/2026-09-19-webrtc-mobile-resilience-research.md`. Its gates run the real
transports against scripted backends under plain Node - `test/providers/repro-simple-peer-sleep.ts`
(the real simple-peer on a fake `wrtc` + fake signaling socket), `test/providers/repro-peerjs-coordinator.ts`
(a scripted PeerJS constructor) - plus `test/dummy/bench-presence-after-relink.ts` and
`bench-wake-false-timeout.ts` for the core; run them after touching connection lifecycle code in
`simple-peer/`, `peerjs/` or the awareness sweep. Two real-browser E2E scripts go further than any
fake can (`test/simple-peer/e2e-resume.mjs`, `test/peerjs/e2e-handover.mjs`: headless Chrome via
`puppeteer-core`, real WebRTC; their headers name what they need) - the second one is what found
that Chrome parks a vanished peer's link in ICE `disconnected` forever.
`test/e2e/room-scenarios.mjs <simple-peer|peerjs|trystero|websocket|ably|pubnub|nostr|gun>` runs a
classroom-sized room (25 Chrome contexts) through join / concurrent typing / a killed tab / five
frozen pages / a reload / a server restart with one peer typing meanwhile / (peerjs) a killed
coordinator; `DIAG=1` names who is missing from whose roster, and every frame the room sends is
counted. Local servers, except `ably` and `pubnub` (the real services, keys in the gitignored `.env`:
`node --env-file=.env ...`) and `LIVE=1` (`nostr`, `gun` against the public relays named there) - what
cannot be restarted is reached through a CONNECT proxy that the "restart" cuts. Every failure it
found was invisible with 2-3 peers: `maxConns` cutting the mesh, a resuming peer's removal broadcast
emptying bystanders' rosters, Trystero not re-subscribing, three ways `verifyUpdates:false`
(y-websocket mode) left a hole in the server's copy of the document; on the relays and hosted
backends (third pass of the spec) a Nostr subscription and a Gun relay link that never came back,
Ably's rate limit failing a join, and two core bugs: peers that are ALL incomplete never answered a
sync request, and the last joiner's roster. Two rules they enforce: never assign
`peer._pc.on*statechange` (simple-peer owns those properties), and a connection's `close`/`error`
handler may only remove its own entry, never "whatever is under this peer id now".
What the harness finds gets a fast gate under plain Node before the fix:
`test/nostr/repro-relay-restart.mjs` and `test/gun/repro-relay-restart.mjs` (a relay that went away;
the library's path is an env var, see their headers), `test/providers/repro-ably-lifecycle.ts` (a
scripted Ably `Realtime`: its own reconnect, a channel over its message rate),
`test/dummy/bench-rate-limited-channel.ts` (a backend that REFUSES a publish loses it for every
receiver at once) and `test/dummy/bench-last-joiner-roster.ts` (presence on demand). A relay
transport whose link comes BACK by itself tells the provider through `onPeerConnect` (websocket,
nostr, ably, gun) - never for the first connect.

`src/providers/resume.ts` (`watchResume`) is the shared sleep detector (a timer that finds
`Date.now()` far ahead of its last tick), used by both mesh transports to re-join under a new id.

### Design docs

`docs/superpowers/specs/` and `docs/superpowers/plans/` contain point-in-time design/spec
documents for specific protocol changes (currently: resync-storm rate limiting, dummy
benchmark scaling). They're written *before* the corresponding code change and are useful for
the "why" behind decisions baked into `src/index.ts`, but treat them as historical rationale,
not current-state documentation — the code and its inline comments are authoritative for
current behavior.

## Package structure notes

- `main`/`types` point at `./dist/lib.js` / `./dist/lib.d.ts`. `dist/` is **tracked and
  committed** (not gitignored): every commit that touches `src/` rebuilds it with `npm run build`
  and includes the result, as the git history shows. `bench-dist/` (the `tsconfig.bench.json`
  output) is gitignored.
- Each transport is also its own `exports` subpath (e.g. `./providers/gun`) mapping to its own
  compiled file under `dist/providers/<name>/`, so consumers only pull in the transport they
  actually import.
- `gun`, `simple-peer`, and `peerjs` are `peerDependencies` marked optional — don't add new
  transport dependencies as regular `dependencies`; follow this pattern (peer + optional) so
  the core package stays dependency-free for consumers who don't need that transport.
