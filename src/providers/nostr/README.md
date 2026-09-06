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
below). Use a regular `eventKind` (1000-9999) if relay-side history
matters more than not filling relays with document history.

End-to-end over damus + nos.lol + nostr.mom + purplerelay (two peers in
Node, then a third): both synced after 278 ms, small updates 240-340 ms,
a 120,000-character insert (compressed to 90 KB, sent as 3 events of
60,000 base64 chars) 1,010 ms, late joiner with everything after 1,005 ms
and all presence states.

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
`historyWindowSecs` (see above).
