# Provider review: open points

What the review of `src/providers/*` (branch `provider-review`, from 2026-10-23)
found and did NOT fix - a design decision, not measured, or outside this repo.
What it fixed is in the branch's commits. One entry per finding: what, why it
matters, what a fix would take.

## Cross-provider

- **Duplicated helpers.** CRC32 in websocket, gun, ably, supabase, nostr (and the
  core); base64 in six providers; `hashPassword` in nostr, ably, supabase. One
  `src/providers/codec.ts` next to `chunking.ts` would hold them. Planned for the
  end of the review, once every provider is read.
- **Password rooms need a secure context.** `hashPassword` uses `crypto.subtle`,
  which a plain-http LAN address does not have: `connect()` throws in a password
  room (nostr, ably, likely supabase). Same root cause as Trystero needing https
  (CLAUDE.md). A fix: a small SHA-256 fallback, or a clear error naming https.

## Nostr

- **Relay storage grows per session.** Without a `secretKey` every `connect()`
  makes a new key, so every session gets its own addressable snapshot slot
  `(kind, pubkey, d)` that is never replaced; a joiner fetches all of them (the
  `#d` filter has no `authors`, no `limit`). A semester of sessions = hundreds of
  whole documents per join. Options: `limit` in the filter (and in
  `Docker/nostr/relay.js`, which ignores it), or a key per room.
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
