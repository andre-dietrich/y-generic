# Shared Test Utilities

This directory contains shared code used across all test pages to reduce duplication and improve maintainability.

## Files

### `quill-media.ts`

Common Quill custom blots and handlers for media upload functionality.

**Exports:**
- `VideoBlot` - Custom Quill blot for embedding HTML5 videos with controls
- `imageHandler(logFn?)` - Toolbar handler for image uploads (accepts image/*)
- `videoHandler(logFn?)` - Toolbar handler for video uploads (MP4, WebM, OGG only)
- `registerMediaBlots()` - Registers the VideoBlot with Quill

**Usage:**
```typescript
import { registerMediaBlots, imageHandler, videoHandler } from '../shared/quill-media'
import { log } from '../shared/ui-helpers'

// Register blots before creating Quill
registerMediaBlots()

// Create Quill with media handlers
const quill = new Quill('#editor', {
  modules: {
    toolbar: {
      container: [..., ['image', 'video'], ...],
      handlers: {
        image: function() { imageHandler.call(this, log) },
        video: function() { videoHandler.call(this, log) }
      }
    }
  }
})
```

### `ui-helpers.ts`

Common UI utility functions for logging, status updates, and formatting.

**Exports:**
- `log(message, type?)` - Display logs with timestamps and color coding
- `updateStatus(status, message)` - Update connection status indicator
- `updatePeerCount(count)` - Update peer count display
- `updateSyncStatus(synced)` - Update sync status (for P2P providers)
- `updateStorageStatus(synced)` - Update storage status (for IndexedDB)
- `clearLog()` - Clear the log panel
- `formatBytes(bytes)` - Format bytes to human-readable size
- `formatDuration(ms)` - Format milliseconds to human-readable duration

**Types:**
- `LogType` - `'info' | 'success' | 'error'`
- `ConnectionStatus` - `'connected' | 'disconnected' | 'connecting'`

**Usage:**
```typescript
import { log, updateStatus, updatePeerCount } from '../shared/ui-helpers'

log('🚀 Starting application...', 'info')
updateStatus('connecting', 'Connecting...')
updatePeerCount(3)
log('✅ Connected successfully!', 'success')
```

## Example: Converting an Existing Test

Before (duplicated code in each test):
```typescript
// Custom Video Blot
class VideoBlot extends BlockEmbed { ... }
Quill.register(VideoBlot, true)

// Log function
function log(message: string, type: 'info' | 'success' | 'error' = 'info') { ... }

// Image handler
function imageHandler(this: any) { ... }

// Video handler  
function videoHandler(this: any) { ... }
```

After (using shared modules):
```typescript
import { registerMediaBlots, imageHandler as sharedImageHandler, videoHandler as sharedVideoHandler } from '../shared/quill-media'
import { log, updateStatus } from '../shared/ui-helpers'

registerMediaBlots()

// Wrapper functions to pass log
function imageHandler(this: any) {
  sharedImageHandler.call(this, log)
}

function videoHandler(this: any) {
  sharedVideoHandler.call(this, log)
}
```

## Benefits

1. **Reduced Duplication** - Common code is written once and reused
2. **Easier Maintenance** - Bug fixes and improvements apply to all tests
3. **Consistent Behavior** - All tests use the same implementations
4. **Type Safety** - Shared types ensure compatibility
5. **Smaller Test Files** - Each test focuses on provider-specific logic
