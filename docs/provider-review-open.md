# Provider review: open points

What the review of `src/providers/*` (branch `provider-review`, from 2026-10-23)
found and did NOT fix - a design decision, not measured, or outside this repo.
What it fixed is in the branch's commits. One entry per finding: what, why it
matters, what a fix would take.

## Cross-provider

- **Duplicated helpers: done, except Matrix.** CRC32, base64 and
  `hashPassword` live in `src/providers/codec.ts` now (websocket, gun, ably,
  supabase, nostr, pubnub). Matrix keeps its own base64 (skipped in this
  review); the core keeps its own CRC32 (not touched).
- **Password rooms need a secure context.** `hashPassword` uses `crypto.subtle`,
  which a plain-http LAN address does not have: `connect()` throws in a password
  room (nostr, ably, likely supabase). Same root cause as Trystero needing https
  (CLAUDE.md). A fix: a small SHA-256 fallback, or a clear error naming https.

## Nostr

- **Relay storage per device: fixed for new sessions.** Snapshots are signed
  with a key per browser and room (localStorage) since this review; before,
  every page load left a slot. Left as it was: the slots older versions wrote
  stay on the relay and every joiner still fetches them (the filter has no
  `authors`, so old snapshots keep loading - dropping them would lose a room
  stored by an older version). A private window or cleared storage still
  starts a new slot. Two tabs of one browser that edit one room at once write
  the same slot and could tear a multi-chunk snapshot.
- **Every peer publishes a snapshot after every change, also a remote one.**
  Redundancy against a writer killed before its flush, at the cost of N uploads
  of the whole document per edit burst. Linear, not N² (that one is fixed).

## WebSocket

- **Send queue unbounded while offline.** Every frame sent while the socket is
  down is queued and flushed on reopen, before onPeerConnect's own push. Not
  touched: in y-websocket mode (`verifyUpdates: false`) it may be what keeps the
  server's copy of the document whole.
- **edrys-websocket-server sends the edrys awareness format to plain clients.**
  `origin/main` sends a new connection `[1][channel][update]` before it knows the
  client speaks plain `[1][update]`; y-generic drops it ("Unexpected end of
  array", 11 per `e2e-edrys-ws` run). Rosters still fill through the relayed
  beacons. Fix belongs in the server (default to plain until told otherwise).
- **Local edrys checkout is stale.** `~/Workspace/Projects/edrys-labs/edrys-websocket-server`
  is on `server-executable`, local `main` is behind `origin/main`; neither relays
  unknown types. `e2e-edrys-ws` against them: 17 s instead of 1.2 s to relist a peer.

## Ably

- **Persistent snapshots can tear.** Every editing peer writes `snapshot-0..n`
  then `snapshot-count` under the same keys. Two multi-chunk writes that
  interleave at the server leave a mix that does not decode - until the next
  write. Most likely when several typists close their pages together (the
  unload flush). Not measured: the fake cannot reproduce server ordering. Fix: a
  fresh key prefix per snapshot plus one pointer key `{id, count}`, deleting the
  previous prefix.
- **`echoMessages` on in persistent mode.** Every peer receives its own
  publishes back and Ably bills each delivery. Needed for LiveObjects writes
  according to the comment; only a live run can tell whether it still is.
- **Disconnect during a snapshot write.** `disconnect()` awaits `saveSnapshot()`,
  which returns at once while a write is in flight (sets `savePending`, retried
  1 s later - after the client is closed): a change made during that write is
  not stored.
- **Not run live.** The gates use a scripted Ably; `room-scenarios.mjs ably`
  against the real service (keys in `.env`) was not run for this review.

## PubNub

- **`disconnect()` keeps the SDK instance.** It calls `unsubscribeAll()` and
  drops the reference, but not `destroy()`: the SDK's own `online`/`offline`
  listeners and timers stay with every connect/disconnect cycle. Not measured;
  check what `destroy()` sends before using it (a second leave?).
- **`base64ToUint8` via `split('').map()`.** One string per byte; slow for a
  large frame. Goes away with the shared `codec.ts` (see Cross-provider).
- **`flush()` skips chunked frames.** Only single messages are remembered for
  the unload keepalive copy. The one that matters there - the presence
  removal - is small, so nothing lost today.
- **Not run live.** The gate uses a scripted PubNub; `room-scenarios.mjs
  pubnub` against the real service was not run for this review.

## Supabase

- **No `sealFrame`.** Behind an encrypting wrapper (LiaScript's password rooms)
  the stored row is the document in the clear, and the frame delivered on
  load is one the wrapper cannot open - the bug Nostr and Ably had (their part
  4/scenario 4). No user of Supabase behind such a wrapper was found locally;
  fix as in Ably if one appears (store the sealed frame, marked in `content`).
- **Concurrent writers.** One row per room, every editing peer upserts its
  whole document: last write wins, so a concurrent edit the last writer had
  not received yet is missing until the next write. Not torn (one row, one
  write), unlike Ably's chunks.
- **The unload write is a plain fetch.** flush() starts the upsert in the
  unloading task, but supabase-js sets no `keepalive`; a browser may cancel it
  with the page (PubNub needed a keepalive copy for that). Nostr and Ably
  have the same open question.
- **Not run live.** The new gate (test/supabase/repro-persistent.ts) uses a
  scripted supabase-js; test/supabase/live-presence.mjs was not rerun.

## Gun

- **A lone joiner gets nothing once a writer's ring has wrapped.** Without
  `persistent` there is no snapshot; the relay holds a writer's last 10 update
  batches only, and Yjs keeps updates whose predecessors are missing pending -
  a joiner whose peers are all gone sees 0 characters of a long session, not
  just its end (repro-writes part 3 showed 0 chars before the persistence
  fix). By design of the ring; persistent mode is the answer.
- **A non-persistent connect clears the room's snapshot.** Intended ("new
  sessions start from a blank state"), but in a room where some peers are
  persistent and some are not, every non-persistent visitor resets the stored
  copy until the next persistent write. Part 5's fix makes that write count
  again; the clearing itself is unchanged.
- **Receive throttle of 300 ms.** setupUpdateListener() processes slots at
  most every 300 ms: part 1's lag of ~400 ms is mostly that. Not a starvation
  (leading edge + one trailing timer), so left alone.
- **Snapshot write with a password is async.** saveSnapshot() awaits SEA's
  encrypt before its put, so flush() cannot get it out of an unloading page
  (the same holds for the update batch, documented at flush()).
- **No sealFrame.** Gun encrypts with its own `password`/SEA option; a
  wrapper's sealFrame is not used. Behind an encrypting wrapper the snapshot
  would have Nostr's and Ably's old bug; not checked whether LiaScript wraps
  Gun that way.

## Trystero

- **rejoin() racing a new connect().** rejoin() awaits `old.leave()`; a
  disconnect() and connect() in that window find `_connected` true again, so
  both connect() and the rejoin join a room - the first is overwritten in
  `this.room` but stays joined, links and all (its events are ignored by the
  `joined !== this.room` guards). Needs a room switch within a rejoin; not
  measured.
- **The sleep rejoin's 5 s timer outlives disconnect().** It checks
  `_connected` when it fires, so after a disconnect() and a new connect()
  within those 5 s it rejoins the NEW session once - one needless rejoin.
- **A falsy option now reaches Trystero.** The config is the caller's options
  minus the transport's own; before, `password: ''` or `relayRedundancy: 0`
  were dropped. Trystero treats an empty password as none; a redundancy of 0
  was never meaningful.
- **Not run against the real library.** The gate scripts Trystero's room; the
  library is not installed here.

## simple-peer

- **`password` is XOR with the password's bytes.** Repeating-key XOR, no
  nonce: anyone who knows one plaintext frame reads the key. The option says
  "obfuscation" in its doc comment, the file header and README call it
  encryption. Either say so plainly or use AES-GCM via `crypto.subtle` (which
  needs a secure context - see Cross-provider).
- **The receive copy.** Every complete frame is copied once (`slice(1)`); a
  `subarray` would do. Small, not measured.
- **Node's EventTarget differs from the browser's.** A listener added during
  a dispatch runs in that same dispatch when the target has two or more
  listeners (spec: it does not). Anything in this repo that re-arms a `once`
  listener from inside it needs a microtask under Node (wrtc, node-datachannel).

## PeerJS

Reviewed: the data path (send, sendTo, setupConnection, the coordination
decoder). Not reviewed line by line: the coordinator and rendezvous logic
(feat/peerjs-rendezvous, fresh and gated by repro-peerjs-coordinator's 15 parts
and repro-peerjs-sparse's 10).

- **repro-peerjs-sparse failed once.** 1 of 12 runs with the decoder change,
  0 of 5 without; the failing run's log was not kept, so the part is unknown.
  The change only skips decoding frames that do not start with `{`, and every
  call site passes a Uint8Array of what sendCoordinationMessage() sent. Run it
  in a loop (`for i in $(seq 20)`) and keep the logs to find the part.
- **A send() that throws is only logged.** CLAUDE.md's rule is to rebuild such
  a link (simple-peer, Trystero do). PeerJS's own DataConnection may already
  close itself when its channel's send throws - the library is not installed
  here, so unchecked. If it does not, the `oneway` scenario of
  room-scenarios.mjs peerjs is what would show it.
- **`password` is XOR with the password's bytes,** as in simple-peer.

## Conference

Reviewed: the hot paths (_onFrame, _onGossip, _markSeen, _remember, the digest
tick) and the lifecycle (connect, disconnect, _linkUp/_linkDown). Every rule in
the protocol is a gate failure first (CLAUDE.md); nothing there was changed
without a measurement.

- **Reload ghosts in bench-partial-mesh.** The N=100 run for this review
  printed "lists pX twice" and 1-4 rosters too short after the reloads phase -
  the round-13 departure findings, a measurement until GATE_DEPARTURE=1.
- **_remember's cache is an array with shift().** O(1) amortized in V8 for a
  packed array; not measured at N=300 for this review.

## Dummy

- **Chunk buffers are never evicted.** With `chunkSizeLimit` and `dropRate`
  together, a chunk set that lost a part stays in `_chunkBuffers` until
  disconnect(). Test memory only.
- **`autoConnect` does not connect.** It only warns when a send is dropped;
  the doc says so now. Removing the option would break callers that pass it.

## IndexedDB

- **Nothing to flush on unload.** send() starts its IndexedDB transaction in
  the calling task, which a browser normally commits after the page is gone;
  not checked against a real unloading page.
- **Compaction reads the whole store.** One getAll and mergeUpdates over every
  row per compaction; with the guard that is once per threshold, fine for
  documents of a few MB, not measured beyond.
