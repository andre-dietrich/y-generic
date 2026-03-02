# PubNub Provider

Real-time synchronization transport using PubNub's global pub/sub infrastructure.

## Features

- ✅ **Global Infrastructure**: PubNub's edge network provides low-latency messaging worldwide
- ✅ **Easy Setup**: Simple configuration with publish/subscribe keys
- ✅ **Presence Tracking**: Built-in awareness of connected users
- ✅ **Message Encryption**: Optional cipher key for secure communication
- ✅ **Message Persistence**: Optional message history storage
- ✅ **Reliable Delivery**: Enterprise-grade message delivery guarantees

## Installation

PubNub requires:
1. A PubNub account (free tier available)
2. Publish and subscribe keys from [admin.pubnub.com](https://admin.pubnub.com)
3. The PubNub JavaScript SDK

### Include PubNub SDK

**Via CDN (Browser):**
```html
<script src="https://cdn.pubnub.com/sdk/javascript/pubnub.10.2.7.min.js"></script>
```

**Via npm (Node.js):**
```bash
npm install pubnub
```

## Usage

### Basic Setup

```typescript
import * as Y from 'yjs'
import { GenericProvider } from 'y-generic'
import { PubNubTransport } from 'y-generic/providers/pubnub'

// Create Yjs document
const doc = new Y.Doc()

// Create PubNub transport
const transport = new PubNubTransport()

// Create provider
const provider = new GenericProvider(doc, transport)

// Connect to PubNub
await transport.connect({
  publishKey: 'pub-c-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  subscribeKey: 'sub-c-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  room: 'my-collab-room',
})
```

### With Encryption

```typescript
await transport.connect({
  publishKey: 'pub-c-xxx...',
  subscribeKey: 'sub-c-xxx...',
  room: 'secure-room',
  cipherKey: 'my-secret-key-123', // Enable AES encryption
})
```

### With Message Persistence

```typescript
await transport.connect({
  publishKey: 'pub-c-xxx...',
  subscribeKey: 'sub-c-xxx...',
  room: 'persistent-room',
  storeInHistory: true, // Store messages for replay
})
```

### With Debug Logging

```typescript
await transport.connect({
  publishKey: 'pub-c-xxx...',
  subscribeKey: 'sub-c-xxx...',
  room: 'debug-room',
  debug: true, // Enable console logging
})
```

## Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `publishKey` | `string` | ✅ Yes | Your PubNub publish key |
| `subscribeKey` | `string` | ✅ Yes | Your PubNub subscribe key |
| `room` | `string` | ✅ Yes | Room/channel name for collaboration |
| `cipherKey` | `string` | ❌ No | Optional encryption key (AES) |
| `storeInHistory` | `boolean` | ❌ No | Enable message persistence (default: `false`) |
| `debug` | `boolean` | ❌ No | Enable debug logging (default: `false`) |

## Methods

### `transport.connect(config: PubNubConfig): Promise<void>`
Connect to PubNub with configuration.

### `transport.disconnect(): void`
Disconnect from PubNub.

### `transport.getPresence(): Promise<string[]>`
Get list of connected peer UUIDs.

## How It Works

1. **Channel Creation**: Room name is base64-encoded to create a PubNub channel
2. **Message Format**: Yjs updates are converted to base64 strings for transmission
3. **Presence**: Automatic tracking of connected users via PubNub presence
4. **Encryption**: Optional AES encryption is handled by PubNub SDK
5. **Reliability**: Messages are delivered through PubNub's edge network

## Pros & Cons

### Pros
- ✅ No server infrastructure needed (managed service)
- ✅ Global edge network for low latency
- ✅ Reliable message delivery
- ✅ Built-in encryption and presence
- ✅ Optional message history
- ✅ Works across any network/firewall

### Cons
- ❌ Not serverless (requires PubNub account)
- ❌ Costs for high usage (check PubNub pricing)
- ❌ Message size limit (32 KiB, may need chunking)
- ❌ Dependency on third-party service

## PubNub Account Setup

1. Go to [admin.pubnub.com](https://admin.pubnub.com)
2. Create a free account
3. Create a new app
4. Copy your publish and subscribe keys
5. (Optional) Configure encryption, access manager, presence

## Testing

Run the test page:

```bash
npm run dev:pubnub
```

Enter your PubNub keys in the configuration panel and start collaborating!

## Security Considerations

- **Encryption**: Use `cipherKey` for sensitive data
- **Access Manager**: Configure PubNub Access Manager for auth
- **Key Management**: Keep your keys secure, never commit to git
- **Free Tier**: Be aware of free tier limits

## Comparison with Other Providers

| Feature | PubNub | Gun | Trystero | PeerJS |
|---------|--------|-----|----------|--------|
| Setup Complexity | Medium | Low | Low | Medium |
| Serverless | ❌ No | ✅ Yes | ✅ Yes | ❌ No |
| Reliability | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| Latency | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Cost | 💰💰 | Free | Free | Free |
| Presence | ✅ Built-in | Manual | Manual | Manual |
| History | ✅ Optional | ✅ Yes | ❌ No | ❌ No |

## Resources

- [PubNub Docs](https://www.pubnub.com/docs/sdks/javascript)
- [PubNub Admin Portal](https://admin.pubnub.com)
- [PubNub Pricing](https://www.pubnub.com/pricing/)
- [PubNub Status](https://status.pubnub.com/)

## License

MIT
