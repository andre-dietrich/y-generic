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
     signaling: ['wss://signaling.yjs.dev'],
     iceServers: [
       { urls: 'stun:stun.l.google.com:19302' },
       {
         urls: 'turn:turn.example.com:3478',
         username: 'user',
         credential: 'pass'
       }
     ]
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

## WebRTC Configuration

### Signaling Servers

Signaling servers are used for peer discovery only (not for data transfer).

**Default**: `wss://signaling.yjs.dev`, `wss://0.peerjs.com/peerjs`

**In the UI**: Click "⚙️ WebRTC Configuration" to configure signaling servers in the browser.

**In code** (see [index.ts](./index.ts)):
```typescript
const transport = new SimplePeerTransport({
  peer: SimplePeer,
  signaling: [
    'wss://signaling.yjs.dev',
    'wss://y-webrtc-signaling-eu.herokuapp.com',
    // Add your own signaling server
  ]
})
```

### STUN Servers

STUN servers help establish direct peer connections through NAT.

**Default**: 
- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

**In the UI**: Configure STUN servers in the "⚙️ WebRTC Configuration" panel.

**In code**:
```typescript
const transport = new SimplePeerTransport({
  peer: SimplePeer,
  signaling: ['wss://signaling.yjs.dev'],
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Add more STUN servers for redundancy
  ]
})
```

### TURN Servers

TURN servers relay traffic when direct connections fail (e.g., behind strict firewalls).

**Default**: None (TURN servers typically require authentication)

**In the UI**: Configure TURN servers in JSON format in the "⚙️ WebRTC Configuration" panel.

**In code**:
```typescript
const transport = new SimplePeerTransport({
  peer: SimplePeer,
  signaling: ['wss://signaling.yjs.dev'],
  iceServers: [
    // STUN servers (no auth required)
    { urls: 'stun:stun.l.google.com:19302' },
    
    // TURN servers (auth required)
    {
      urls: 'turn:turn.example.com:3478',
      username: 'myusername',
      credential: 'mypassword'
    },
    {
      urls: ['turn:turn.example.com:3478?transport=tcp', 'turn:turn.example.com:3478?transport=udp'],
      username: 'myusername',
      credential: 'mypassword'
    }
  ]
})
```

**Note**: TURN servers are typically paid services. Free STUN servers are usually sufficient for most use cases.

## Troubleshooting

### Peers not connecting
- Check browser console for errors
- Verify simple-peer is installed: `npm list simple-peer`
- Try a different signaling server
- Check if WebRTC is blocked by firewall/network
- **NAT/Firewall issues**: If peers can't connect directly, add TURN servers (relay traffic)
- Try different STUN servers or add multiple STUN servers for redundancy

### Connection fails behind corporate firewall
- WebRTC may be blocked by network policies
- **Solution**: Configure TURN servers to relay traffic
- TURN servers can traverse strict firewalls by relaying data (at the cost of bandwidth)

### Slow sync
- WebRTC may take a few seconds to establish connections
- Check peer count - if 0, signaling may have failed
- Try refreshing all browser tabs
- If using TURN relay, expect slower performance than direct P2P

### Configuration not applying
- After changing settings in the UI, **reload the page** to apply
- Check browser console for configuration errors
- Verify TURN server JSON format is valid

### Build errors
- Ensure TypeScript build succeeded: `npm run build`
- Check that all peer dependencies are installed
- Clear parcel cache: `rm -rf .parcel-cache`

## Notes

- This is a test environment - data is not persisted
- WebRTC works best on modern browsers (Chrome, Firefox, Edge, Safari)
- Some corporate networks may block WebRTC traffic
- The signaling server is only used for peer discovery, not data transfer
