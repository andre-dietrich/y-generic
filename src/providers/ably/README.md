# Ably Provider

Real-time synchronization transport using Ably's global pub/sub messaging platform.

## Features

- ✅ **Global Edge Network**: Ably's infrastructure provides low-latency messaging worldwide
- ✅ **Easy Setup**: Simple configuration with an API key or token auth
- ✅ **Presence Tracking**: Built-in awareness of connected users
- ✅ **Token Auth Support**: Avoid exposing API keys in client-side code
- ✅ **Password-Protected Rooms**: Optional channel name obfuscation
- ✅ **Reliable Delivery**: Managed message delivery with automatic reconnection

## Installation

Ably requires:
1. An Ably account (free tier available)
2. An API key from [ably.com/accounts](https://ably.com/accounts) (or a token-auth endpoint)
3. The Ably JavaScript SDK

### Include the Ably SDK

**Via CDN (Browser):**
```html
<script src="https://cdn.ably.com/lib/ably.min-2.js"></script>
```

**Via npm (Node.js or bundled apps):**
```bash
npm install ably
```

## Usage

### Basic Setup

```typescript
import * as Y from 'yjs'
import { GenericProvider } from 'y-generic'
import { AblyTransport } from 'y-generic/providers/ably'
import * as Ably from 'ably'

// Create Yjs document
const doc = new Y.Doc()

// Create Ably transport — the Realtime class is injected so this package
// never bundles `ably` as a hard dependency
const transport = new AblyTransport({ Realtime: Ably.Realtime })

// Create provider
const provider = new GenericProvider(doc, transport)

// Connect using an API key
await provider.connect({
  apiKey: 'your-ably-api-key',
  room: 'my-collab-room',
})
```

### With Token Auth (recommended for browsers)

```typescript
await provider.connect({
  authUrl: '/api/ably-token', // your server issues a TokenRequest
  authMethod: 'POST',
  room: 'my-collab-room',
})
```

### With a Password-Protected Room

```typescript
await provider.connect({
  apiKey: 'your-ably-api-key',
  room: 'secure-room',
  password: 'my-secret-key-123', // hashed and appended to the channel name
})
```

### With Debug Logging

```typescript
await provider.connect({
  apiKey: 'your-ably-api-key',
  room: 'debug-room',
  debug: true,
})
```

## Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `apiKey` | `string` | ⚠️ One of `apiKey`/`authUrl` | Your Ably API key |
| `authUrl` | `string` | ⚠️ One of `apiKey`/`authUrl` | Token-auth endpoint (recommended for browsers) |
| `authMethod` | `'GET' \| 'POST'` | ❌ No | HTTP method for `authUrl` (default: `GET`) |
| `room` | `string` | ✅ Yes | Room/channel name for collaboration |
| `password` | `string` | ❌ No | Obfuscates the channel name (not encryption) |
| `debug` | `boolean` | ❌ No | Enable debug logging (default: `false`) |
| `persistent` | `boolean` | ❌ No | Save/restore full doc state via Ably LiveObjects (default: `false`) |
| `doc` | `Y.Doc` | ⚠️ Required if `persistent: true` | The Y.Doc to snapshot |
| `persistDebounceMs` | `number` | ❌ No | Debounce delay before writing a snapshot (default: `2000`) |

## Persistent Mode

By default, Ably pub/sub messages aren't retained — if every peer goes
offline, the room's content is gone once they all reconnect with fresh
documents. Setting `persistent: true` saves the full Y.Doc state to Ably's
[LiveObjects](https://ably.com/docs/liveobjects) feature — a durably-stored,
SLA-backed shared-state primitive — and restores it on connect, so the
document survives everyone going offline.

```typescript
import * as Ably from 'ably'
import { LiveObjects } from 'ably/liveobjects'
import { AblyTransport } from 'y-generic/providers/ably'

const transport = new AblyTransport({
  Realtime: Ably.Realtime,
  LiveObjects, // required only when using persistent mode
})

await provider.connect({
  apiKey: 'your-ably-api-key',
  room: 'my-collab-room',
  persistent: true,
  doc, // the same Y.Doc passed to `new GenericProvider(doc, transport)`
})
```

**How it works**: the doc is encoded as a `y-protocols/sync` SYNC_STEP_2
message and written across one or more LiveObjects `LiveMap` keys (large
snapshots are chunked, since each write is capped at Ably's 64 KiB message
size). On connect, any existing snapshot is read back and delivered before
normal sync traffic begins.

**Retention**: LiveObjects state is durably stored for 24h–90 days
(configurable per app, Ably default 90 days) — good enough to resume after
everyone's been offline for a while, not a replacement for a real backend if
you need indefinite retention.

## Methods

### `transport.connect(config: AblyConfig): Promise<void>`
Connect to Ably with configuration.

### `transport.disconnect(): Promise<void>`
Leave presence and disconnect from Ably.

### `transport.getPresence(): Promise<string[]>`
Get list of connected peer client IDs.

## How It Works

1. **Channel Creation**: Room name (optionally password-hashed) is used directly as the Ably channel name
2. **Message Format**: Yjs updates are base64-encoded and published as channel messages
3. **Presence**: Automatic tracking of connected users via Ably's presence set
4. **Chunking**: Messages above ~55 KB (base64-encoded) are split into chunks and reassembled on receipt
5. **Echo Suppression**: `echoMessages: false` prevents a client from receiving its own publishes

## Pros & Cons

### Pros
- ✅ No server infrastructure needed (managed service)
- ✅ Global edge network for low latency
- ✅ Reliable message delivery with automatic reconnection
- ✅ Built-in presence
- ✅ Token-based auth for safe browser usage

### Cons
- ❌ Not serverless (requires an Ably account)
- ❌ Costs for high usage (check Ably pricing)
- ❌ Message size limit (~64 KiB by default, chunked automatically)
- ❌ Dependency on a third-party service

## Ably Account Setup

1. Go to [ably.com/accounts](https://ably.com/accounts)
2. Create a free account
3. Create a new app
4. Copy your API key, or set up token auth for production use

## Testing

Run the test page:

```bash
npm run dev:ably
```

Enter your Ably API key (or token-auth URL) in the configuration panel and start collaborating!

## Security Considerations

- **Token Auth**: Prefer `authUrl` over `apiKey` in browser-facing apps so the raw API key never ships to the client
- **Capabilities**: Scope Ably API keys/tokens to the minimum required capabilities (subscribe/publish/presence) for the channel
- **Key Management**: Keep your keys secure, never commit to git

## Comparison with Other Providers

| Feature | Ably | PubNub | Gun | Trystero |
|---------|------|--------|-----|----------|
| Setup Complexity | Medium | Medium | Low | Low |
| Serverless | ❌ No | ❌ No | ✅ Yes | ✅ Yes |
| Reliability | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| Latency | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| Cost | 💰💰 | 💰💰 | Free | Free |
| Presence | ✅ Built-in | ✅ Built-in | Manual | Manual |
| Token Auth | ✅ Yes | ⚠️ Access Manager | N/A | N/A |

## Resources

- [Ably Docs](https://ably.com/docs)
- [Ably JS SDK](https://github.com/ably/ably-js)
- [Ably Pricing](https://ably.com/pricing)
- [Ably Status](https://status.ably.com/)

## License

MIT
