# Nostr Transport

Serverless sync over Nostr relays: every message of the provider is one
signed Nostr event (kind 27370, tag `r` = room), fanned out by the relays
to every subscriber of the room. No account, no server, no setup.

```typescript
import { GenericProvider } from 'y-generic'
import { NostrTransport } from 'y-generic/providers/nostr'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'

const transport = new NostrTransport({ finalizeEvent, getPublicKey, SimplePool })
const provider = new GenericProvider(doc, transport)
await provider.connect({ room: 'my-doc' })   // default relays below
```

Requires **nostr-tools ≥ 2.11** (`subscribeMany` takes one filter object;
older versions took an array - a relay that validates REQ strictly answers
the array with "provided filter is not an object" and delivers nothing).
The playground (`npm run dev:nostr`) loads the browser bundle
`nostr-tools@2.25.2/lib/nostr.bundle.js` from jsDelivr.

## Relays

Probed on 2026-09-06 with a kind-27370 event of 5 bytes and one of 50,000
base64 chars, from a fresh key (no NIP-05, no web of trust):

| relay | small | 50 KB | note |
|---|---|---|---|
| wss://relay.damus.io | OK 735 ms | OK 725 ms | default |
| wss://nos.lol | OK 191 ms | OK 208 ms | default |
| wss://nostr.mom | OK 299 ms | OK 341 ms | default |
| wss://purplerelay.com | OK 392 ms | OK 536 ms | |
| wss://relay.primal.net | OK 238 ms | OK 299 ms | |
| wss://nostr.oxtr.dev | OK 287 ms | OK 360 ms | |
| wss://relay.snort.social | OK 313 ms | OK 384 ms | "ephemeral: will not be stored" |
| wss://nostr-pub.wellorder.net | OK 818 ms | OK 1,142 ms | |
| wss://offchain.pub, wss://nostr.bitcoiner.social | OK | **rejected** | "not in our web of trust" for the large one |
| wss://relay.nostr.wirednet.jp | rejected | rejected | blocks the ephemeral kind range |
| wss://relay.nostrplebs.com, wss://nostr.wine | rejected | rejected | NIP-05 / paid |
| wss://relay.nostr.band, wss://relay.nostr.bg, wss://nostr.fmt.wiz.biz | timeout | timeout | |

None of them returned a stored event for the room afterwards: kind 27370
is in NIP-01's ephemeral range (20000-29999), relays do not store it. So
`historyWindowSecs` fetches nothing with the default kind - a late joiner
gets the document from a live peer's reply instead (measured: ~1 s
below), unless persistent mode is on (see below). A regular `eventKind`
(1000-9999) makes `historyWindowSecs` work by replaying every update ever
made in the room - only worth it for genuine full-history-replay use
cases, since relay storage then grows without bound for as long as the
room is edited; persistent mode is the recommended path for durable
catch-up instead.

End-to-end over damus + nos.lol + nostr.mom + purplerelay (two peers in
Node, then a third): both synced after 278 ms, small updates 240-340 ms,
a 120,000-character insert (compressed to 90 KB, sent as 3 events of
60,000 base64 chars) 1,010 ms, late joiner with everything after 1,005 ms
and all presence states.

## Persistent mode

```typescript
const doc = new Y.Doc()
const transport = new NostrTransport({ finalizeEvent, getPublicKey, SimplePool })
const provider = new GenericProvider(doc, transport)
await provider.connect({ room: 'my-doc', persistent: true, doc })
```

Publishes the whole document as one or more NIP-01 **addressable events**
(kind 30000-39999, default `persistentKind` 30078) tagged `d` =
`<room>#<chunk index>` - a relay is required by spec to keep only the
*latest* event per `(kind, pubkey, d)`, so this is a bounded, durable "one
snapshot per room" slot rather than an ever-growing update log. A late
joiner fetches it directly from the relay's storage - no live peer, and no
relay restart, needed for catch-up - decoded and applied the same way a
transport's stored full state normally is (a `MESSAGE_SYNC_PUSH` frame, no
hash check, no `synced` flip).

Publishing is debounced (`persistDebounceMs`, default 2000 ms) off
`doc`'s own `update` event, not the outgoing wire frame - `send()`'s frame
can't be peeked reliably here since this transport hints
`preferredCompressMinBytes`, which shifts the message-type byte to an
unpredictable offset once compression is on.

Always published through the chunk envelope, even a single-part snapshot,
so the addressing scheme never changes shape: if a later, larger snapshot
needs 3 chunks after an earlier one only needed 1, every chunk index is
still just overwritten in place rather than an old, differently-addressed
slot being left behind stale. Bounded at `MAX_SNAPSHOT_CHUNKS` (20) chunks
- roughly 900 KB of raw document state after compression; a document
whose snapshot would need more chunks skips that publish (logged as a
warning) rather than publishing an incomplete one - the live update
channel still keeps connected peers in sync regardless. A torn/mid-publish
batch (crash between chunk writes) is never applied either: each publish
gets a fresh chunk-envelope `id`, and reassembly only ever completes once
all chunks share the same `id` - a mix of old and new chunks simply never
completes, exactly like the live channel's own oversized-message chunking.

Assumes `compressionThresholdBytes` is at its default for this transport
(active, since `preferredCompressMinBytes` is - see "Wire format" below) -
GenericProvider expects a leading compression-flag byte on every message
in that case, which the synthetic snapshot frame adds by hand since it
doesn't go through GenericProvider's own send-side encoding. Passing
`compressionThresholdBytes: 0` explicitly to disable compression breaks
persistent-mode delivery (the flag byte would then not be expected) - not
supported together, the same as `supabase`'s `persistent` mode documents
for its own (opposite-default) case.

Not yet measured against public relays for the addressable kind
specifically (the relay probe above only covers the ephemeral default
kind) - NIP-01's addressable-event handling is core to the spec, not an
extension, so it should work anywhere the ephemeral kind does, but treat
this as unverified until probed the same way. The classroom relay image
(`Docker/nostr/`) implements it and persists it to disk.

## Wire format

- The provider's frame goes through untouched (this transport does not
  strip the CRC32 header), so `compressionThresholdBytes` works; the
  transport hints 2048 as its default, a full-document push is
  compressed before it is encoded.
- Content above 60,000 base64 chars is sent as several events (`{chunked,
  id, index, total, data}` JSON in `content`) and reassembled - common
  relays cap an event at 64 KiB.
- Base64 costs 33 % on the wire; the signature and tags a few hundred
  bytes per event.

## Options

Constructor: `finalizeEvent`, `getPublicKey`, `SimplePool` (from
nostr-tools), `secretKey` (persist it for a stable identity, else
ephemeral), `eventKind` (27370), `debug`. Connect: `room`, `relays`,
`password` (hashes into the room tag - discoverability, not encryption),
`historyWindowSecs` (see above), `persistent`, `doc`, `persistentKind`
(30078), `persistDebounceMs` (2000 ms) - see "Persistent mode" above.
