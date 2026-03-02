# Matrix Provider

Real-time synchronization transport using Matrix protocol (decentralized, federated).

## Features

- ✅ **Decentralized**: Matrix is a federated protocol - no single point of failure
- ✅ **Account Support**: Use your existing Matrix account
- ✅ **Guest Access**: Optional guest registration (if homeserver supports it)
- ✅ **Persistent History**: Messages are stored on the homeserver
- ✅ **E2E Encryption Ready**: Matrix supports end-to-end encryption
- ✅ **Federation**: Connect to any Matrix homeserver
- ✅ **Open Protocol**: Based on open standards
- ✅ **Free Accounts**: Get a free Matrix account at [Element](https://app.element.io)

## Installation

No additional dependencies! The Matrix provider uses the Matrix Client-Server API directly.

## Usage

### ⚠️ Important: Guest Access Status

**Many public Matrix homeservers (including matrix.org) have disabled guest access** due to spam concerns. You have three options:

**Option 1: Use Your Matrix Account** (Recommended)
```typescript
await provider.connect({
  homeserverUrl: 'https://matrix.org',
  room: '#my-collab-room:matrix.org',
  accessToken: 'your-access-token',
  userId: '@yourname:matrix.org',
})
```

**Option 2: Self-Host with Guest Access**
Run your own Matrix homeserver with guest access enabled (see [Self-Hosting](#self-hosted) section).

**Option 3: Find a Homeserver with Guest Access**
Some smaller community homeservers may still support guest access. Check their registration policies.

### Getting Your Access Token

If you have a Matrix account (create one free at [Element](https://app.element.io)):

1. Open Element web client (https://app.element.io)
2. Click your profile → **All Settings**
3. Go to **Help & About**
4. Click **Access Token** (will show temporarily)
5. Copy the token

⚠️ **Keep your access token secret!** Don't share it or commit it to version control.

### Basic Setup with Account

### Basic Setup with Account

```typescript
import * as Y from 'yjs'
import { GenericProvider } from 'y-generic'
import { MatrixTransport } from 'y-generic/providers/matrix'

// Create Yjs document
const doc = new Y.Doc()

// Create Matrix transport
const transport = new MatrixTransport()

// Create provider
const provider = new GenericProvider(doc, transport, {
  verifyUpdates: false, // Recommended for simplicity
})

// Connect with your Matrix account
await provider.connect({
  homeserverUrl: 'https://matrix.org',
  room: '#my-collab-room:matrix.org',
  accessToken: 'your-access-token-here',
  userId: '@yourname:matrix.org',
})
```

### Guest Access (If Supported)

### Guest Access (If Supported)

If your homeserver supports guest registration, you can omit the credentials:

```typescript
// Automatically registers as guest (if homeserver allows)
await provider.connect({
  homeserverUrl: 'https://your-homeserver.com',
  room: '#my-room:your-homeserver.com',
})
```

Guest access means **no registration or login required!** When you connect, the provider:

1. Automatically registers as a guest user on the homeserver
2. Receives a temporary access token
3. Joins the specified room
4. Starts syncing

**Guest users can:**
- Join public rooms
- Send and receive messages
- Collaborate in real-time

**Guest limitations:**
- Temporary account (not persistent across sessions)
- May have restricted permissions on some servers
- Limited to homeservers that support guest access
- ⚠️ **Most public homeservers have disabled guest access**

### With Debug Logging

```typescript
await provider.connect({
  homeserverUrl: 'https://matrix.org',
  room: '#debug-room:matrix.org',
  debug: true, // Enable console logging
})
```

## Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `homeserverUrl` | `string` | ✅ Yes | Matrix homeserver URL (e.g., 'https://matrix.org') |
| `room` | `string` | ✅ Yes | Room identifier (alias or ID) |
| `accessToken` | `string` | ❌ No | Access token (if not provided, registers as guest) |
| `userId` | `string` | ❌ No | User ID (required if accessToken provided) |
| `deviceId` | `string` | ❌ No | Device ID for the session |
| `debug` | `boolean` | ❌ No | Enable debug logging (default: `false`) |

## Room Identifiers

Matrix supports two types of room identifiers:

### Room Alias (Readable)
```
#room-name:server.com
```
Example: `#yjs-test:matrix.org`

- Human-readable
- Can be changed by room admins
- Requires `#` prefix

### Room ID (Permanent)
```
!AbCdEfGhIj:server.com
```
Example: `!OGEhHVWSdvArJzumhm:matrix.org`

- Permanent identifier
- Never changes
- Requires `!` prefix

## Homeserver Options

### Public Homeservers with Guest Access

Some public homeservers that support guest access:

- **matrix.org** - The main Matrix homeserver (https://matrix.org)
- **matrix.envs.net** - Community homeserver (https://matrix.envs.net)

Check homeserver's `/_matrix/client/versions` endpoint to verify guest support.

### Self-Hosted

You can run your own Matrix homeserver:

- [Synapse](https://github.com/matrix-org/synapse) - Reference Python implementation
- [Dendrite](https://github.com/matrix-org/dendrite) - Go implementation
- [Conduit](https://conduit.rs/) - Lightweight Rust implementation

Enable guest access in your homeserver config:
```yaml
# synapse config
allow_guest_access: true
```

## How It Works

1. **Connection**: Client connects to Matrix homeserver via HTTPS
2. **Authentication**: 
   - Guest: Automatic registration at `/_matrix/client/v3/register?kind=guest`
   - Account: Uses provided access token
3. **Room Join**: Client joins room via `/_matrix/client/v3/join/{roomId}`
4. **Sync Loop**: Long-polling at `/_matrix/client/v3/sync` for updates
5. **Send Updates**: Yjs updates sent as custom message events (`y.update`)
6. **Receive Updates**: Incoming events decoded and applied to document

## Protocol Details

### Message Format

Yjs updates are sent as Matrix events:

```json
{
  "type": "m.room.message",
  "content": {
    "msgtype": "y.update",
    "body": "<base64-encoded-yjs-update>"
  }
}
```

### Sync Strategy

- Uses Matrix's long-polling `/sync` endpoint
- 30-second timeout for efficient real-time updates
- Tracks `next_batch` token for incremental sync
- Filters for specific room events

## Limitations

- **Guest Access Required**: Homeserver must support guest registration
- **Base64 Overhead**: ~33% size increase due to JSON encoding
- **Public Rooms**: Guest users typically limited to public rooms
- **Rate Limits**: Subject to homeserver rate limiting
- **No E2E Encryption Yet**: Current implementation doesn't support encrypted rooms

## Comparison with Other Providers

| Feature | Matrix | WebSocket | PubNub |
|---------|--------|-----------|--------|
| **Setup** | Guest registration | Server required | Signup required |
| **Persistence** | ✅ Built-in | ⚠️ Optional | ⚠️ Optional |
| **Decentralized** | ✅ Federated | ❌ Centralized | ❌ Centralized |
| **E2E Encryption** | ⚠️ Supported (not impl.) | ❌ No | ✅ Optional |
| **Latency** | ~1-2s | <100ms | <100ms |
| **History** | ✅ Full | ⚠️ Depends | ⚠️ Limited |

## Advanced Usage

### Getting Guest Token for Reuse

```typescript
// After connecting as guest
const transport = new MatrixTransport()
const provider = new GenericProvider(doc, transport)

await provider.connect({
  homeserverUrl: 'https://matrix.org',
  room: '#my-room:matrix.org',
})

// Access the internal credentials (for debugging)
console.log('Guest token:', (transport as any).accessToken)
console.log('Guest user ID:', (transport as any).userId)
```

Note: Guest tokens expire after some time (usually 24 hours).

### Creating a Room

To create a new room for collaboration, use the Matrix Client-Server API:

```bash
# Get guest token first
curl -X POST "https://matrix.org/_matrix/client/v3/register?kind=guest" \
  -H "Content-Type: application/json" \
  -d '{}'

# Create room with that token
curl -X POST "https://matrix.org/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "room_alias_name": "my-yjs-room",
    "name": "My Collaborative Room",
    "topic": "Yjs collaboration",
    "preset": "public_chat"
  }'
```

## Troubleshooting

### "Guest registration failed" or "M_FORBIDDEN"

**This is normal!** Most public homeservers (including matrix.org) have disabled guest access.

**Solutions:**
1. **Use your Matrix account** (recommended): Provide your `accessToken` and `userId`
   - Get your access token from Element: Settings → Help & About → Access Token
2. **Self-host**: Run your own Matrix homeserver with guest access enabled
3. **Find alternative homeserver**: Some community homeservers may still support guests

### "Failed to join room"

**Solution**: 
- Verify the room identifier format (`#alias:server` or `!id:server`)
- Ensure you have permission to join (public rooms or rooms you're invited to)
- Check if the room exists on the specified homeserver
- If using guest access, the room must be public

### High Latency

**Solution**:
- Matrix sync uses long-polling (30s timeout)
- First sync may take several seconds to receive messages
- For lower latency, consider WebSocket or WebRTC providers

### Messages Not Appearing

**Solution**:
- Check browser console for errors
- Enable debug logging: `debug: true`
- Verify you're in the same room across clients
- Check if homeserver is rate limiting requests

## Examples

See [test/matrix/](../../test/matrix/) for a complete working example with:
- Automatic guest registration
- Quill editor integration
- Real-time collaboration
- Chat functionality

## Future Enhancements

- ✨ End-to-end encryption support
- ✨ Presence indicators via Matrix presence
- ✨ Threading support for structured conversations
- ✨ Media upload support for rich content
- ✨ Read receipts and typing indicators

## Resources

- [Matrix Specification](https://spec.matrix.org/)
- [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/)
- [Matrix Public Homeservers](https://www.hello-matrix.net/public_servers.php)
- [Run Your Own Synapse](https://matrix-org.github.io/synapse/latest/setup/installation.html)
