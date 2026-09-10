# Resync Cascade (Phase 1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the full-document resync cascade (push as unhashed message, mismatch → beacon, RTT-aware suppression), give replies and requests separate rate-limit budgets, and fix the join-path peer-count gate and presence coalescing.

**Architecture:** All in `GenericProvider` (`src/index.ts`) on top of the digest beacon. A new private type `MESSAGE_SYNC_PUSH` (6) carries the connect-time full state without hash/seq; `_requestResync()`'s action becomes a beacon plus response wait; an RTT EWMA feeds the suppression window and the wait; `_tryReserveSyncSlot()` splits into request/reply budgets; a `_knownPeers` set backs the peer-count gate; JOIN presence responses go through one coalescing timer.

**Tech Stack:** TypeScript 5, yjs 13.6, y-protocols, lib0; benches compiled with `tsconfig.bench.json`.

**Spec:** `docs/superpowers/specs/2026-09-05-resync-cascade-design.md`

## Global Constraints

- No new dependencies; `Transport` unchanged; plain `MESSAGE_SYNC` SyncStep1 still accepted.
- Verification = `npm run build`, `npx tsc -p tsconfig.bench.json`, the named benches; numbers into the design doc's `## Results` per task, baseline first (`bench-dist-baseline/` snapshot of `main` @ `55d36f7`).
- Per task: `bench-user-scaling` (default and `SETTLE_MS=12000`), `bench-join-after-burst`, `bench-idle-room` (default and `SETTLE_MS=15000`), `bench-periodic-awareness`, `bench-corruption-storm`, `bench-late-join` ×1, `bench-packet-loss` ×1 (default and `SETTLE_MS=12000`). Final task: the phase-1 gate list 3 × 3, zero timeouts.
- Branch `round-4-phase-1b`; one commit per task; `dist/` rebuilt and committed with every `src/` change; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `MESSAGE_SYNC_PUSH` (design 1a) + baseline

**Files:** Modify `src/index.ts` (constants ~line 16-40; `_trySyncPushPull` push branch; `_dispatchMessage` new case); `test/dummy/bench-idle-room.ts`, `bench-join-after-burst.ts`, `bench-corruption-storm.ts`, `bench-periodic-awareness.ts` classifiers (type 6 = `push`); design doc Results.

**Interfaces:** Produces `const MESSAGE_SYNC_PUSH = 6`; `private _encodePush(update: Uint8Array): Uint8Array`.

- [ ] **Step 1: Record the baseline** — the phase-1 `after3c` logs are the default-timing baseline; run `SETTLE_MS=12000` for `bench-user-scaling` and `bench-packet-loss` from `bench-dist-baseline/`; write the baseline section of `## Results` (idle census default/15 s, join-after-burst, user-scaling fan-out + join-burst both regimes, packet-loss N=50 both regimes, corruption-storm N=10, late-join M=40 cells).
- [ ] **Step 2: Implement.** Constant after `DIGEST_FLAG_CONFIRM`:

```ts
// Full-state push (connect()/syncNow()): the whole document as one update,
// no hash, no sequence number, applied and nothing else. Before this type a
// push was a MESSAGE_SYNC_VERIFIED update whose hash was the PUSHER's state
// - every peer holding more data read that as divergence and scheduled a
// resync of its own (research doc item 12), the seed of the cascade in item
// 13. Not a SyncStep2 either: receiving one must not flip `synced` (an
// empty joiner's push says nothing about the room's content).
const MESSAGE_SYNC_PUSH = 6
```

`_trySyncPushPull`: replace `messages.push(this._encodeUpdate(update))` with `messages.push(this._encodePush(update))`. New method next to `_encodeUpdate`:

```ts
  private _encodePush(update: Uint8Array): Uint8Array {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC_PUSH)
    encoding.writeVarUint8Array(encoder, update)
    return encoding.toUint8Array(encoder)
  }
```

`_dispatchMessage`, new case before `MESSAGE_SYNC`:

```ts
      case MESSAGE_SYNC_PUSH: {
        Y.applyUpdate(this.doc, decoding.readVarUint8Array(decoder), this)
        break
      }
```

Bench classifiers: type 6 → `push` (`bench-join-after-burst`), `update`/`push` class in `bench-idle-room` (`cls = 'update'`), `counts.update++` in `bench-corruption-storm`, ignored in `bench-periodic-awareness`.

- [ ] **Step 3: Build both configs; run the per-task bench set; record.** Expect: `bench-late-join` mismatch column and `bench-sync-latency` `Hash mismatch` warnings drop to ~0 in the join scenarios; idle census default-settle requests move toward the floor (no post-join retry storm).
- [ ] **Step 4: Commit** — `Send the connect-time full-state push as MESSAGE_SYNC_PUSH: no hash, no seq, no synced flip`.

### Task 2: resync → beacon + response wait (design 1b)

**Files:** `src/index.ts` (`_requestResync` timer body; `_armResponseWait` signature; `_trySyncPushPull` doc).

- [ ] **Step 1: Implement.** `_armResponseWait(retryFlags: number)` stores `_responseWaitFlags`; the timer's retry sends `_sendSyncStep1(this._responseWaitFlags)`. `_trySyncPushPull` passes `DIGEST_FLAG_CONFIRM` when arming for a JOIN. `_requestResync()`'s timer callback becomes:

```ts
      if (!this.transport.isConnected || this._destroying) return
      // A resync trigger means "I may be missing something": ask with a
      // 12-byte beacon; peers ahead of us reply with exactly the diff. The
      // document itself is never pushed here any more (design 1b) - that
      // was the cascade's fuel. If the request or its reply is lost, the
      // response wait re-beacons (1s/2s/4s, RTT-scaled), then the periodic
      // beacon takes over.
      if (this._sendSyncStep1(0)) {
        this._armResponseWait(0)
      } else {
        this._requestResync()
      }
```

Remove the now-unused `push` parameter path? No — `_trySyncPushPull(push=true)` stays for `syncNow()`; delete only the comment claiming the retry pushes.

- [ ] **Step 2: Build; run the per-task set; hard checks:** `bench-corruption-storm` both RESULT lines; `bench-packet-loss` converged (both regimes); `bench-idle-room` (b) 5/5. Headline: `bench-user-scaling` fan-out N=100 Gun/Matrix with `SETTLE_MS=12000`.
- [ ] **Step 3: Commit** — `Resync triggers send a beacon instead of pushing the document; re-beacon if unanswered`.

### Task 3: RTT estimate (design 1c)

**Files:** `src/index.ts` (fields; `_armResponseWait`; `_noteResponse`; `_replySuppressionMaxDelay`; `_trySyncPushPull`/`_requestResync` stamp the send time).

- [ ] **Step 1: Implement.** Fields `_rttEstimateMs: number | null = null`, `_requestSentAt: number = 0`. Stamp `_requestSentAt = Date.now()` where `_armResponseWait` is armed (JOIN send, resync send). In `_noteResponse()`: if `_requestSentAt > 0`, `sample = Date.now() - _requestSentAt`; `_rttEstimateMs = _rttEstimateMs === null ? sample : 0.7 * _rttEstimateMs + 0.3 * sample`; `_requestSentAt = 0`. `_replySuppressionMaxDelay()` returns `Math.min(2000, Math.max(formula, 1.5 * (this._rttEstimateMs ?? 0)))`. `_armResponseWait` first delay `Math.max(1000, 4 * (this._rttEstimateMs ?? 0))`, doubling as before. Reset both on disconnect.
- [ ] **Step 2: Build; per-task set. Headline:** `bench-join-after-burst` Matrix SyncStep2 count; `bench-user-scaling` join-burst Matrix N=100 (premature retries); late-join Matrix "during edit burst" rows.
- [ ] **Step 3: Commit** — `Scale reply suppression and response wait with a measured RTT`.

### Task 4: two budgets (design item 2)

- [ ] **Step 1: Implement.** Rename `_syncRequestTimes` → keep for requests; add `_syncReplyTimes: number[]`. `_tryReserveSyncSlot()` → `_tryReserveSlot(times: number[])`; `_tryReserveRequestSlot()` / `_tryReserveReplySlot()` wrappers. `_sendSyncStep1`, `_trySyncPushPull` → request; `_sendSyncReply` → reply. Reset both in `disconnect()`. Update the option doc comment of `maxSyncRequestsPerWindow` ("per class: requests and replies each").
- [ ] **Step 2: Build; per-task set. Headline:** `bench-join-after-burst` in-budget rows; `bench-idle-room` default settle requests.
- [ ] **Step 3: Commit** — `Separate rate-limit budgets for sync requests and sync replies`.

### Task 5: peer count from beacon/update senders (design item 3)

- [ ] **Step 1: Implement.** `_knownPeers = new Set<number>()`; add in `_handleDigest` (read `senderClientID` instead of skipping) and in the `MESSAGE_SYNC_VERIFIED` case (`senderClientID` already read); `_peerCount()` as in the design; replace the two `awareness.getStates().size` uses; clear on disconnect.
- [ ] **Step 2: Build; per-task set. Headline:** `bench-late-join` idle rows (SyncStep2 into a room with content), `bench-user-scaling` join-burst.
- [ ] **Step 3: Commit** — `Count peers from beacon and update senders, not only awareness, for reply suppression`.

### Task 6: presence coalescing (design item 4)

- [ ] **Step 1: Implement.** `_presenceResponseTimer?: ReturnType<typeof setTimeout>`; in `_handleDigest`'s JOIN branch replace `_broadcastAwareness([clientID])` with `_schedulePresenceResponse()`: if timer set → return; delay `Math.min(500, Math.max(100, 2 * (this._rttEstimateMs ?? 0)))`; callback clears the timer and calls `_broadcastAwareness([this.doc.clientID])` if local state non-null. Clear on disconnect/destroy.
- [ ] **Step 2: Build; per-task set. Headline:** `bench-join-after-burst` Matrix awareness class; `bench-user-scaling` join-burst Matrix bytes; `bench-periodic-awareness` Part 2 must still PASS (bound 330 ms — the delay is ≤ 100 ms at WebSocket RTT).
- [ ] **Step 3: Commit** — `Coalesce JOIN presence responses on one RTT-scaled timer`.

### Task 7: final gates, results, README

- [ ] Run the phase-1 gate list 3 × 3 (`bench-packet-loss`, `bench-late-join`, `bench-sync-latency`) plus the single-run benches, both regimes where applicable; write the final Results table (baseline → after per headline); README: add type 6 to the wire-compatibility note; commit `Phase 1b results and README note`.
