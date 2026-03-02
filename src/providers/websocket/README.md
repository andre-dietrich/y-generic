# WebSocket Provider

Real-time synchronization transport using WebSocket connections.

## Features

- ✅ **Direct Connection**: Low-latency WebSocket connection to server
- ✅ **Room-based**: Multiple rooms on single server
- ✅ **Auto-reconnect**: Automatic reconnection on connection loss
- ✅ **Binary Protocol**: Efficient binary message format
- ✅ **Simple Setup**: Easy to configure and deploy
- ✅ **Compatible**: Works with y-websocket servers

## Installation

The WebSocket provider requires a WebSocket server. You can use:
- [y-websocket](https://github.com/yjs/y-websocket) - Official Yjs WebSocket server
- Custom WebSocket server implementing the protocol

### Install y-websocket Server (Optional)

```bash
npm install -g y-websocket
```

Or run locally:
```bash
npm install y-websocket
```

## Usage

### Basic Setup

```typescript
import * as Y from 'yjs'
import { GenericProvider } from 'y-generic'
import { WebSocketTransport } from 'y-generic/providers/websocket'

// Create Yjs document
const doc = new Y.Doc()

// Create WebSocket transport
const transport = new WebSocketTransport()

// Create provider
const provider = new GenericProvider(doc, transport)

// Connect to WebSocket server
await provider.connect({
  serverUrl: 'ws://localhost:1234',
  room: 'my-collab-room',
})
```

### 🔴 Important: y-websocket Server Compatibility

When connecting to y-websocket servers, you **must disable verifyUpdates**:

```typescript
// Create provider with verifyUpdates disabled
const provider = new GenericProvider(doc, transport, {
  verifyUpdates: false, // Required for y-websocket compatibility
})

// Then connect as normal
await provider.connect({
  serverUrl: 'ws://localhost:1234',
  room: 'my-room',
})
```

**Why?** GenericProvider's `MESSAGE_SYNC_VERIFIED` (type 3) conflicts with y-websocket's `messageQueryAwareness` (type 3). Setting `verifyUpdates: false` uses standard sync messages (type 0) that are compatible.

### With Auto-reconnect

```typescript
await provider.connect({
  serverUrl: 'ws://localhost:1234',
  room: 'my-room',
  autoReconnect: true,        // Enable auto-reconnect (default: true)
  reconnectDelay: 2000,       // Wait 2s before reconnecting (default: 2000)
  maxReconnectAttempts: 0,    // Infinite retries (default: 0)
})
```

### With Debug Logging

```typescript
await provider.connect({
  serverUrl: 'ws://localhost:1234',
  room: 'debug-room',
  debug: true,                // Enable console logging
})
```

### Secure Connection (WSS)

```typescript
await provider.connect({
  serverUrl: 'wss://example.com',  // Use wss:// for secure connection
  room: 'secure-room',
})
```

## Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `serverUrl` | `string` | ✅ Yes | WebSocket server URL (ws:// or wss://) |
| `room` | `string` | ✅ Yes | Room/channel name for collaboration |
| `autoReconnect` | `boolean` | ❌ No | Enable automatic reconnection (default: `true`) |
| `reconnectDelay` | `number` | ❌ No | Delay before reconnection in ms (default: `2000`) |
| `maxReconnectAttempts` | `number` | ❌ No | Max reconnect attempts, 0=infinite (default: `0`) |
| `protocols` | `string \| string[]` | ❌ No | WebSocket sub-protocols |
| `debug` | `boolean` | ❌ No | Enable debug logging (default: `false`) |

## Running a WebSocket Server

### Using y-websocket CLI

The easiest way to run a WebSocket server:

```bash
# Install globally
npm install -g y-websocket

# Start server
y-websocket-server --port 1234
```

Server will run on `ws://localhost:1234`

### Using y-websocket Programmatically

```javascript
// server.js
const { WebSocketServer } = require('y-websocket')

const wss = new WebSocketServer({
  port: 1234,
  // Optional persistence
  // persistence: {
  //   provider: require('y-leveldb'),
  //   path: './yjs-data'
  // }
})

console.log('WebSocket server running on ws://localhost:1234')
```

Run with: `node server.js`

## Protocol

The WebSocket provider is **fully compatible with y-websocket servers**.

### URL Format
Room name is appended to the server URL:
```
ws://localhost:1234/my-room-name
```

### Message Format
Raw binary Yjs updates are sent directly without any wrapper protocol. The GenericProvider handles all Yjs sync protocol encoding/decoding.

## How It Works

1. **Connection**: Client connects to WebSocket server
2. **Join Room**: Client sends join message with room name
3. **Sync**: Server syncs client with existing room state
4. **Updates**: All document changes are broadcast to room members
5. **Reconnection**: On disconnect, client automatically attempts to reconnect

## Pros & Cons

### Pros
- ✅ Low latency (direct WebSocket connection)
- ✅ Simple setup and configuration
- ✅ Works behind firewalls/NAT
- ✅ Reliable message delivery
- ✅ Scalable with server clustering
- ✅ Compatible with y-websocket ecosystem

### Cons
- ❌ Requires running a server
- ❌ Server is single point of failure (without clustering)
- ❌ Not P2P (all traffic goes through server)

## Deployment

### Development
```bash
# Run test page
npm run dev:websocket
```

### Production Considerations

1. **Use WSS**: Always use secure WebSocket (wss://) in production
2. **Load Balancing**: Use nginx or similar for load balancing multiple servers
3. **Persistence**: Enable y-leveldb for document persistence
4. **Authentication**: Add authentication middleware to server
5. **Rate Limiting**: Implement rate limiting for connections/messages

### Example nginx Configuration

```nginx
upstream websocket {
  server 127.0.0.1:1234;
  server 127.0.0.1:1235;
}

server {
  listen 443 ssl;
  server_name ws.example.com;
  
  ssl_certificate /path/to/cert.pem;
  ssl_certificate_key /path/to/key.pem;
  
  location / {
    proxy_pass http://websocket;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

## Comparison with Other Providers

| Feature | WebSocket | Gun | Trystero | PubNub |
|---------|-----------|-----|----------|--------|
| Server Required | ✅ Yes | ❌ No* | ❌ No | ❌ No† |
| Setup Complexity | Low | Low | Low | Medium |
| Latency | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Reliability | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Cost | Free | Free | Free | 💰💰 |
| Offline Support | Via persistence | ✅ Built-in | ❌ No | Via history |

\* Optional relay servers  
† Managed cloud service

## Troubleshooting

### Connection Failed
- Verify WebSocket server is running
- Check firewall settings
- Confirm server URL is correct (ws:// vs wss://)

### Auto-reconnect Not Working
- Check `autoReconnect` is set to `true`
- Verify `maxReconnectAttempts` isn't reached
- Check browser console for error messages

### High Latency
- Use WebSocket server geographically close to users
- Check network conditions
- Consider using wss:// for better routing

## Resources

- [y-websocket GitHub](https://github.com/yjs/y-websocket)
- [WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455)
- [Yjs Documentation](https://docs.yjs.dev/)

## License

MIT
