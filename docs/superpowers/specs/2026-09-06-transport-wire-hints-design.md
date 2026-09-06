# Transport wire hints: compression floor, awareness cadence, chunking where it was missing, Supabase binary — design

## Goal

Research item 7 of `2026-09-05-sync-optimization-round-4-research.md`:
give the core the two per-transport numbers it can act on without a new
abstraction, and close the size gaps in the providers that had none.
Bytes and hard limits, not message counts — the first item of this round
on that axis.

## Context (checked 2026-09-06)

| transport | hard size | rate / billing | today |
|---|---|---|---|
| PubNub | 32 KiB | — | chunks base64 at 30,000 chars |
| Ably | 64 KiB | billed per 5 KiB unit × subscribers | chunks base64 at 55,000 chars |
| Matrix (Synapse) | 65,536 B canonical JSON per event | `rc_message` default 0.2/s, burst 10 ([config manual][synapse]) | **no chunking**; `preferredBatchMs` 150; awareness at the 100 ms default → a typing peer with a cursor exceeds the burst within seconds |
| Nostr (strfry) | 64 KiB event | — | **no chunking** |
| Supabase Realtime | 256 KB (free) / 3 MB | per-project msg/s cap, one broadcast = N events | **no chunking**; base64 in JSON; binary payloads supported from supabase-js 2.91.0, older receivers drop them silently ([docs][supa-bc]) |
| Gun | unclear (~30 KB `opt.pack`?) | — | base64 in graph nodes; left alone (no evidence of a hard limit) |
| WebRTC (peerjs / simple-peer / trystero) | 16 KiB interop | — | chunked by the libraries / the provider already |
| WebSocket | server-defined | — | left alone |

A full-state push of a large document (a LiaScript course runs to
hundreds of KB) on Matrix, Nostr or Supabase is dropped by the backend
today, silently: the sender logs success or nothing, the receiver never
sees it, and the room heals only through incremental replies that fit.

## Design

### 1. Two hints on `Transport`, read as option defaults

Exactly the `preferredBatchMs` pattern:

- `preferredCompressMinBytes?: number` — default for `compressionThresholdBytes`
  when the caller passes nothing. Set to 2048 on Ably (5 KiB billing
  units), PubNub, Matrix, Nostr (chunking transports: fewer chunks) and
  Supabase (count-limited). An explicit `compressionThresholdBytes: 0`
  still disables it. This changes those transports' default wire format
  (the 1-byte compression flag) — within the same-version-room rule the
  README already states, every peer on such a transport gets the same
  default; the compatibility cliff documented on the option is unchanged
  in kind, and now applies per transport class rather than per caller.
- `preferredAwarenessMs?: number` — default for `awarenessInterval`.
  Matrix sets 2000 and raises `preferredBatchMs` from 150 to 2000: at
  Synapse's default 0.2 msg/s with a burst of 10, a peer that types and
  moves its cursor at the old defaults (150 ms batches, 100 ms awareness)
  is rate-limited after ~10 messages; at 2 s each it sustains a minute of
  activity on the burst and stays close to the sustained rate. Operators
  who raise `rc_message` override both per call as before.

Rejected: `maxMessageBytes` on `Transport` for core-side chunking. The
size that matters is after the transport's own encoding (base64 +33 %,
JSON envelope), which only the transport knows; and a core chunk envelope
would be a new wire type, which the capability-byte decision (research
decision 2) should precede. Chunking stays in the providers.

### 2. One chunk helper for the providers that lacked one

`src/providers/chunking.ts`: `splitChunks(data, maxChars)` → `{chunked:
true, id, index, total, data}[]`, `isChunk(x)`, `ChunkAssembler.push(chunk)
→ string | null` (bounded: 32 pending ids, oldest evicted). The same
envelope shape PubNub and Ably already use; those two keep their code.

- Matrix: body > 60,000 base64 chars → one event per chunk (`msgtype`
  `y.update` unchanged, chunk object as JSON in `body`); receiver
  reassembles. Rate limit applies per chunk, which is the only option.
- Nostr: content > 60,000 chars → one event per chunk.
- Supabase: see 3.

### 3. Supabase: binary payload, base64 chunks above the limit

`send()` broadcasts the raw bytes (`payload: bytes.buffer`) when ≤ 200,000
bytes; above that, base64 chunks of 200,000 chars in the JSON path (rare:
full-state pushes of large docs; the 33 % tax only there). `handleMessage`
accepts `ArrayBuffer` / `ArrayBufferView` (binary), a string (base64, an
older sender) and a chunk object. **Requires supabase-js ≥ 2.91.0 on every
peer**: an older client silently drops binary broadcasts. The playground
loads `@supabase/supabase-js@2` (latest), README says so.

## Verification

- `test/providers/check-chunking.ts`: split / shuffle / reassemble round
  trip, two interleaved ids, eviction — assert-based, run under Node.
- `bench-chunking-compression.ts` (existing, `DummyTransport` with a 4 KiB
  chunk limit): wire messages to converge two peers on a medium and a
  large document, compression off vs on — the number behind the
  `preferredCompressMinBytes` default.
- `npm run build`; the manual `dev:matrix` / `dev:nostr` / `dev:supabase`
  playgrounds against real backends are the only end-to-end check for the
  chunk paths and for Supabase binary, and are **not run here** (no
  credentials in this session) — listed as the open verification.

[synapse]: https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html
[supa-bc]: https://supabase.com/docs/guides/realtime/broadcast

## Results

Appended as measured.

### Measured (this build)

`check-chunking`: OK (5 chunks of 60,000 for a 250,001-char payload,
shuffled reassembly of two interleaved ids, eviction of a stale id).

`bench-chunking-compression` (two peers, `DummyTransport` chunk limit 4,096
bytes, wire messages to converge), the number behind the
`preferredCompressMinBytes = 2048` default:

| document | compression off | compression on |
|---|---|---|
| medium (~500 words, clean) | 4 messages, 3,498 bytes | 4 messages, 321 bytes |
| large (~5,000 words + churn) | 14 messages, 45,027 bytes | **5 messages, 5,510 bytes** |

On a transport with a 64 KiB cap that is the difference between one and
several events per full-state push; on Ably it is 9 vs 2 billing units
for the large document's push. Typing traffic (tens of bytes) never
crosses the 2 KB floor and is unchanged.

`npm run build` clean. **Not verified here:** the chunk paths on a real
Matrix homeserver, Nostr relay and Supabase project, and Supabase binary
receipt across two browsers — `npm run dev:matrix` / `dev:nostr` /
`dev:supabase` with a document above 64 KB (Matrix, Nostr) / 200 KB
(Supabase) are the checks to run.
