# Unicast Replies (Phase 1c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed the RTT estimate from a transport hint, send replies/acks/presence to the requester only where the transport can address a peer (with deterministic responder self-selection instead of overhearing), and produce the idle-backoff decision numbers.

**Architecture:** `Transport` gains two optional members (`expectedRttMs`, `sendTo`) and `onMessage`'s callback an optional `from`. `GenericProvider` maps clientID → address from decoded senders and routes per-requester messages through `sendTo` when possible. `DummyTransport`/`DummyHub` gain a `unicast` mode so benches measure both paths.

**Tech Stack:** TypeScript 5, yjs 13.6, lib0; benches via `tsconfig.bench.json`.

**Spec:** `docs/superpowers/specs/2026-09-05-unicast-replies-design.md`

## Global Constraints

- No new dependencies. Wire format unchanged (unicast is a routing choice, not a message type).
- Transports without `sendTo`/`from` behave byte-for-byte as before.
- Verification: `npm run build`, `npx tsc -p tsconfig.bench.json`, benches per task with numbers into the design doc; final gate list 3 × 3 in both dummy modes for late-join/packet-loss.
- Branch `round-4-phase-1c`; one commit per task; `dist/` rebuilt with every `src/` change; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `expectedRttMs` hint (design A)

**Files:** `src/transport.ts` (field), `src/index.ts` (seed in `connect()` after `transport.connect`), `src/providers/matrix/index.ts` (700), `src/providers/nostr/index.ts` (600), `src/providers/gun/index.ts` (500), `src/providers/dummy/index.ts` (`2 · latency` when latency > 0), README transport section.

- [ ] Implement: `readonly expectedRttMs?: number` with doc comment; in `connect()`, after the transport connected and before `syncNow()`: `if (this.transport.expectedRttMs) this._rttSamples = [this.transport.expectedRttMs]`.
- [ ] Build both configs; run `bench-user-scaling` both regimes (join-burst Matrix/Gun N=100 is the headline), `bench-join-after-burst`, `bench-idle-room`, `bench-periodic-awareness`, `bench-corruption-storm`; record; commit `Seed the RTT estimate from a transport hint (expectedRttMs)`.

### Task 2: unicast core + dummy (design B, part 1)

**Files:** `src/transport.ts`, `src/index.ts`, `src/providers/dummy/index.ts`, `test/dummy/bench-user-scaling.ts` (`makeProviders` passes `unicast: process.env.DUMMY_UNICAST === '1'`; `instrumentHub` shadows `unicast` too), `test/dummy/bench-idle-room.ts`, `bench-join-after-burst.ts`, `bench-periodic-awareness.ts` (same option + shadow).

- [ ] Interface: `onMessage(callback: (data: Uint8Array, from?: string) => void)`, `sendTo?(peerId: string, data: Uint8Array): void | Promise<void>`.
- [ ] Core: `_peerAddress = new Map<number, string>()` (clear on disconnect); `_handleIncomingMessage(data, from?)` → `_processWrappedMessage(data, from)` → `_dispatchMessage(message, from)`; record in `_handleDigest` (senderClientID) and the `MESSAGE_SYNC_VERIFIED` case. `_sendDirect(clientID, data): boolean` — wraps like `_send` (CRC32, compression flag) and calls `transport.sendTo(address, ...)`; false if no `sendTo`/address. `_replyToSyncRequest(reply, isAck, targetSv, toClientID)`: if `_canUnicast(toClientID)` → `if (this._selectedResponder(toClientID)) { reserve reply slot; _sendDirect }` else today's path. `_selectedResponder(req)`: `peerCount < 4 || (((req * 2654435761) ^ this.doc.clientID) >>> 0) % Math.max(1, Math.floor((peerCount - 1) / 3)) === 0`. Presence: `_presencePending: Set<number>` of requester clientIDs; on fire, if every pending id has an address and `sendTo` exists → `_sendDirect` per id, else one broadcast.
- [ ] Dummy: option `unicast?: boolean`; `DummyHub.unicast(room, targetId, data, sender, options)` (same latency/drop model, one recipient); `broadcast`/`unicast` deliver `client.callback(data, sender.id)`; `sendTo` defined only when `unicast` is on (feature detection); `onMessage` passes `from` through the chunk reassembly wrapper.
- [ ] Benches: `DUMMY_UNICAST` env in `makeProviders` and the three direct-construction benches; `instrumentHub` and the census shadows count `unicast` as one delivery.
- [ ] Build; run the per-task set in relay mode (must equal Task 1 within noise) and in `DUMMY_UNICAST=1`; record; commit `Unicast replies, acks and presence where the transport can address a peer`.

### Task 3: mesh transports (design B, part 2)

**Files:** `src/providers/peerjs/index.ts`, `src/providers/simple-peer/index.ts`, `src/providers/trystero/index.ts`.

- [ ] peerjs: `sendTo(peerId, data)` → encrypt like `send`, `this.peers.get(peerId)?.conn.send(...)` if connected; both `conn.on('data')` handlers call `this._callback(decryptedData, conn.peer)`. simple-peer: `sendTo` → `sendToPeer(peerConn, dataToSend)`; the `peer.on('data')` handler passes `peerConn.peerId` (it is in scope as `remotePeerId`/`peerConn`). trystero: `sendTo(peerId, data)` → `this.sendUpdate(data, peerId)`; `receive` callback passes `peerId`.
- [ ] `npm run build`; commit `peerjs, simple-peer, trystero: sendTo and sender ids for unicast replies`.

### Task 4: idle-backoff numbers (design C)

- [ ] Run `bench-idle-backoff.js` on the Task 3 build; run `bench-idle-room` with `IDLE_BACKOFF=1` (add the env switch to the bench: `idleBackoffEnabled: process.env.IDLE_BACKOFF === '1'`) and `OBSERVE_MS=60000` at N=50 vs the default; write both into the design doc's Results as a decision table; commit `Idle-backoff decision numbers`.

### Task 5: final gates, results, README

- [ ] Full gate list on the final build in both dummy modes; Results section; README transport-author notes (`from`, `sendTo`, `expectedRttMs`); commit `Phase 1c results and README`.
