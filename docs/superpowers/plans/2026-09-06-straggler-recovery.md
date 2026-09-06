# Straggler Recovery (Phase 1d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A peer that a beacon shows to be behind asks for the difference after a grace; peers with pending structs do not answer requests; the corruption bench runs with a realistic beacon and prints diagnostics on a stall; idle backoff is on by default.

**Architecture:** All in `GenericProvider` (`src/index.ts`): a `_behindCheckTimer` + `_behindSv` pair armed from `_handleDigest`, feeding the existing `_requestResync()` coordinator; a two-line guard at the top of `_replyToSyncRequest`; option defaults. Bench changes in `test/dummy/bench-corruption-storm.ts` and `bench-join-after-burst.ts`.

**Tech Stack:** TypeScript 5, yjs 13.6, lib0; benches via `tsconfig.bench.json`.

**Spec:** `docs/superpowers/specs/2026-09-06-straggler-recovery-design.md`

## Global Constraints

- No new dependencies; wire format unchanged.
- Verification: `npm run build`, `npx tsc -p tsconfig.bench.json`, benches per task with numbers into the design doc; final gate list 3 × 3 in both dummy modes.
- Branch `round-4-phase-1d`; one commit per task; `dist/` rebuilt and committed with every `src/` change; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: corruption bench beacon + diagnostics (design C) + baseline

**Files:** `test/dummy/bench-corruption-storm.ts` and `test/dummy/bench-join-after-burst.ts` (`SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 2000)` passed as `syncInterval`; STALL dump of every non-converged peer after the convergence loop).

- [ ] Implement both; `npx tsc -p tsconfig.bench.json`; snapshot `bench-dist-base1d/`; run the corruption bench ×3 in both modes on the current code; record the baseline in the design doc's Results.
- [ ] Commit `bench-corruption-storm, bench-join-after-burst: peers run a 2 s periodic beacon; both dump peer state on a stall`.

### Task 2: no partial responders (design B)

**Files:** `src/index.ts` (`_replyToSyncRequest`, first statement).

- [ ] Guard: `if (this.doc.store.pendingStructs !== null || this.doc.store.pendingDs !== null) return` with the design's comment.
- [ ] `npm run build`; bench build to `bench-dist-t1d2/`; corruption ×3 both modes, join-after-burst both modes, fan-out probe (Matrix fresh), user-scaling both regimes; record; commit `Peers with pending structs do not answer sync requests`.

### Task 3: behind check (design A)

**Files:** `src/index.ts` (fields `_behindCheckTimer?`, `_behindSv: Uint8Array | null`; `_handleDigest` after `weBehind`; new `_scheduleBehindCheck(remoteSv)`; clear both in `disconnect()`/`destroy()`).

- [ ] Implement per design: delay `Math.max(this._gapGraceMs, 2 * (this._rttMinMs() ?? 0))`; at fire: skip if disconnected/destroying or `_responseWaitTimer !== undefined`; recompute behind against `_behindSv`; `_requestResync()` if still behind.
- [ ] `npm run build`; bench build to `bench-dist-t1d3/`; corruption ×3 both modes (headline), `bench-idle-backoff` (recovery latency with backoff on), fan-out probe both regimes, user-scaling both regimes, idle-room, periodic-awareness, join-after-burst both modes; record; commit `Ask for the difference when a beacon shows us behind (after a grace)`.

### Task 4: idle backoff on by default (design D)

**Files:** `src/index.ts` (option doc + default), `README.md` (option table / periodic-sync paragraph).

- [ ] `idleBackoffEnabled` default `true`; doc comments updated; README.
- [ ] `npm run build`; bench build `bench-dist-t1d4/`; `bench-idle-backoff`, `bench-idle-room` with `OBSERVE_MS=60000 SETTLE_MS=15000` at N=50 (default now on; compare with `IDLE_BACKOFF=0`... the bench's switch becomes an explicit override), `bench-periodic-awareness`, `bench-user-scaling`; record; commit `Idle backoff on by default`.

### Task 5: final gates, results

- [ ] Phase-1c gate list 3 × 3 in both dummy modes on the Task 4 build; Results; research-doc status; commit `Phase 1d results`.
