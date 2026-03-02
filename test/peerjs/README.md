# PeerJS Provider Test

This demo tests peer-to-peer synchronization using PeerJS transport with Yjs.

## Setup

1. **Install dependencies** (including the peer dependency):
   ```bash
   npm install
   npm install peerjs
   ```

2. **Start the dev server**:
   ```bash
   npm run dev:peerjs
   ```

3. **Usage in your code**:
   ```typescript
   import Peer from 'peerjs'
   import { PeerJSTransport } from 'y-generic/providers/peerjs'
   
   const transport = new PeerJSTransport({
     peer: Peer, // Pass the PeerJS constructor
   })
   ```

4. **Test collaboration**:
   - Open the URL in multiple browser tabs/windows
   - Type in the editor and see changes sync across all instances
   - Customize your username and color
   - Watch the peer count and connection status

## Features

- ✅ **Peer-to-peer sync** - Direct connections between browsers using WebRTC (via PeerJS)
- ✅ **Rich text editing** - Powered by Quill editor
- ✅ **Awareness** - See other users' names and colors
- ✅ **Real-time status** - Connection state and peer count display
- ✅ **Activity log** - Detailed event logging
- ✅ **Built-in signaling** - PeerJS provides its own signaling servers

## How It Works

1. **PeerJS Cloud**: Uses PeerJS Cloud for peer discovery (built-in, free)
2. **WebRTC**: Actual document data transfers directly between peers via WebRTC data channels
3. **BroadcastChannel**: Peers in the same browser discover each other instantly via BroadcastChannel
4. **Mesh Network**: Each peer connects to multiple others for resilience

## Testing Scenarios

### Basic Sync
- Open 2-3 browser tabs
- Type in any tab
- Verify changes appear in all tabs instantly

### Connection Management
- Close one tab
- Verify other tabs detect the disconnection
- User should be removed from "Users Online"

### Cross-Tab Discovery
- Open multiple tabs in the same browser
- Verify they discover each other via BroadcastChannel
- Check peer count increases

## PeerJS Options

You can customize the PeerJS connection:

```typescript
const transport = new PeerJSTransport({
  peer: Peer,
  peerOptions: {
    host: 'your-peerjs-server.com', // Custom PeerJS server
    port: 9000,
    path: '/myapp',
    secure: true,
    config: {
      // ICE servers configuration
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
    }
  },
  password: 'optional-encryption',
  maxConns: 30,
  debug: true
})
```

## Troubleshooting

### Peers not connecting
- Check browser console for errors
- Verify peerjs is installed: `npm list peerjs`
- Try refreshing all browser tabs
- Check if WebRTC is blocked by firewall/network

### Slow sync
- PeerJS may take a few seconds to establish connections
- Check peer count - if 0, discovery may have failed
- Try closing and reopening tabs

### Build errors
- Ensure TypeScript build succeeded: `npm run build`
- Check that all peer dependencies are installed
- Clear parcel cache: `rm -rf .parcel-cache`

## Notes

- This is a test environment - data is not persisted
- PeerJS works best on modern browsers (Chrome, Firefox, Edge, Safari)
- Some corporate networks may block WebRTC traffic
- PeerJS Cloud is free but rate-limited
- Each peer gets a unique ID from PeerJS server
- Same-browser tabs discover each other instantly via BroadcastChannel
