# SimplePeer Provider Test

This demo tests peer-to-peer synchronization using SimplePeer transport (WebRTC via simple-peer library) with Yjs.

## Setup

1. **Install dependencies** (including the peer dependency):
   ```bash
   npm install
   npm install simple-peer
   ```

2. **Start the dev server**:
   ```bash
   npm run dev:simple-peer
   ```

3. **Usage in your code**:
   ```typescript
   import Peer from 'simple-peer'
   import { SimplePeerTransport } from 'y-generic/providers/simple-peer'
   
   const transport = new SimplePeerTransport({
     peer: Peer, // Pass the simple-peer constructor
     signaling: ['wss://signaling.yjs.dev']
   })
   ```

4. **Test collaboration**:
   - Open the URL in multiple browser tabs/windows
   - Type in the editor and see changes sync across all instances
   - Customize your username and color
   - Watch the peer count and connection status

## Features

- ✅ **Peer-to-peer sync** - Direct connections between browsers using WebRTC (via simple-peer)
- ✅ **Rich text editing** - Powered by Quill editor
- ✅ **Awareness** - See other users' names and colors
- ✅ **Real-time status** - Connection state and peer count display
- ✅ **Activity log** - Detailed event logging

## How It Works

1. **Signaling**: Uses `signaling.yjs.dev` for peer discovery only
2. **WebRTC**: Actual document data transfers directly between peers via WebRTC data channels (powered by simple-peer library)
3. **Mesh Network**: Each peer connects to multiple others for resilience
4. **No Central Server**: After initial signaling, all sync happens peer-to-peer

## Testing Scenarios

### Basic Sync
- Open 2-3 browser tabs
- Type in any tab
- Verify changes appear in all tabs instantly

### Connection Management
- Close one tab
- Verify other tabs detect the disconnection
- User should be removed from "Users Online"

### Cross-Device
- Open on multiple devices (phone, tablet, laptop)
- Verify sync works across different devices
- Note: Devices must be able to connect (may require public signaling server)

### Network Resilience
- Disable/enable network on one peer
- Verify reconnection behavior
- Check sync recovery after reconnection

## Signaling Servers

Default signaling server: `wss://signaling.yjs.dev`

You can add more signaling servers in [index.ts](./index.ts):

```typescript
const SIGNALING_SERVERS = [
  'wss://signaling.yjs.dev',
  'wss://y-webrtc-signaling-eu.herokuapp.com',
  // Add your own signaling server
]
```

## Troubleshooting

### Peers not connecting
- Check browser console for errors
- Verify simple-peer is installed: `npm list simple-peer`
- Try a different signaling server
- Check if WebRTC is blocked by firewall/network

### Slow sync
- WebRTC may take a few seconds to establish connections
- Check peer count - if 0, signaling may have failed
- Try refreshing all browser tabs

### Build errors
- Ensure TypeScript build succeeded: `npm run build`
- Check that all peer dependencies are installed
- Clear parcel cache: `rm -rf .parcel-cache`

## Notes

- This is a test environment - data is not persisted
- WebRTC works best on modern browsers (Chrome, Firefox, Edge, Safari)
- Some corporate networks may block WebRTC traffic
- The signaling server is only used for peer discovery, not data transfer
