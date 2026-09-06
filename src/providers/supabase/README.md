# Supabase Provider for y-generic

Real-time collaborative editing with Supabase Realtime and optional database persistence.

## Features

- **Dual Mode Operation**
  - **Ephemeral Mode**: Peer-to-peer sync via Supabase Realtime (no database)
  - **Persistent Mode**: Database-backed sync with automatic state persistence
- **Optional Password Protection**: Secure rooms with password hashing
- **Debounced Database Updates**: Configurable debouncing to reduce database writes
- **Automatic Retry**: Failed database operations are queued and retried
- **Room-based Collaboration**: Multiple isolated collaboration rooms
- **Real-time Sync**: Low-latency synchronization via Supabase WebSocket channels

## Installation

```bash
npm install y-generic @supabase/supabase-js yjs
```

## Wire format

Updates are broadcast as **binary payloads** (no base64), which needs
`@supabase/supabase-js` **2.91.0 or newer on every peer** - an older client
silently drops binary broadcasts. Updates above 200 KB are sent as base64
chunks and reassembled; updates above 2 KB are compressed first
(`compressionThresholdBytes` hint, see the `GenericProvider` option).

## Database Setup (for Persistent Mode)

Create a table in your Supabase project:

```sql
CREATE TABLE yjs_documents (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Optional: Add RLS policies if needed
ALTER TABLE yjs_documents ENABLE ROW LEVEL SECURITY;

-- Allow public read/write (adjust as needed)
CREATE POLICY "Public Access" ON yjs_documents
  FOR ALL USING (true);
```

## Usage

### Ephemeral Mode (No Persistence)

```typescript
import * as Y from 'yjs'
import { GenericProvider } from 'y-generic'
import { SupabaseTransport } from 'y-generic/providers/supabase'

const doc = new Y.Doc()
const transport = new SupabaseTransport()
const provider = new GenericProvider(doc, transport)

await provider.connect({
  supabaseUrl: 'https://xxxxx.supabase.co',
  supabaseKey: 'your-anon-key',
  room: 'my-room',
  persistent: false // Ephemeral mode
})

// States are synchronized between peers in real-time
// When all users disconnect, the state is lost
```

### Persistent Mode (Database-backed)

```typescript
import * as Y from 'yjs'
import { GenericProvider } from 'y-generic'
import { SupabaseTransport } from 'y-generic/providers/supabase'

const doc = new Y.Doc()
const transport = new SupabaseTransport()
const provider = new GenericProvider(doc, transport)

await provider.connect({
  supabaseUrl: 'https://xxxxx.supabase.co',
  supabaseKey: 'your-anon-key',
  room: 'my-room',
  persistent: true, // Enable persistence
  password: 'optional-secret', // Optional password protection
  persistDebounceMs: 2000 // Debounce database writes (default: 2000ms)
})

// States are synchronized AND saved to database
// Document is loaded from database on connect
// Updates are debounced and saved automatically
```

### With Password Protection

```typescript
await provider.connect({
  supabaseUrl: 'https://xxxxx.supabase.co',
  supabaseKey: 'your-anon-key',
  room: 'my-room',
  password: 'secret-password', // Password is hashed into channel name
  persistent: true
})
```

## Configuration Options

```typescript
interface SupabaseConfig {
  // Required
  supabaseUrl: string        // Your Supabase project URL
  supabaseKey: string        // Your Supabase anon/public key
  room: string               // Room/channel name for collaboration

  // Optional
  password?: string          // Password to secure the room (hashed)
  persistent?: boolean       // Enable database persistence (default: false)
  tableName?: string         // Database table name (default: 'yjs_documents')
  columnName?: string        // Column for document data (default: 'content')
  idColumnName?: string      // Column for document ID (default: 'id')
  persistDebounceMs?: number // Debounce delay for DB writes (default: 2000)
  debug?: boolean            // Enable debug logging
}
```

## How It Works

### Ephemeral Mode
1. Connects to Supabase Realtime channel
2. Broadcasts document updates to all peers in the room
3. Receives updates from other peers in real-time
4. No database operations

### Persistent Mode
1. Connects to Supabase Realtime channel
2. Loads initial document state from database (if exists)
3. Broadcasts updates to peers AND queues for database
4. Debounces database writes to reduce load
5. Retries failed database operations automatically
6. On disconnect, flushes pending updates to database

## Error Handling

- Database errors are logged with `console.warn`
- Failed updates are queued and retried after 1 second
- Connection failures throw errors that can be caught

## Best Practices

1. **Use Ephemeral Mode** for temporary collaboration sessions where persistence isn't needed
2. **Use Persistent Mode** for documents that need to survive between sessions
3. **Adjust debounce delay** based on your use case:
   - Higher values (5000ms+) for less critical updates
   - Lower values (1000ms) for more frequent saves
4. **Use passwords** to prevent unauthorized access to rooms
5. **Configure RLS policies** in Supabase for additional security

## Security Considerations

- The anon key is public and included in client code
- Use RLS (Row Level Security) policies in Supabase to restrict access
- Passwords are hashed with SHA-256 and included in channel names
- For sensitive data, consider additional encryption at the application level

## CDN Usage

```html
<script type="module">
  import * as Y from 'https://cdn.jsdelivr.net/npm/yjs@13/+esm'
  import { GenericProvider } from 'https://cdn.jsdelivr.net/npm/y-generic/+esm'
  import { SupabaseTransport } from 'https://cdn.jsdelivr.net/npm/y-generic/providers/supabase/+esm'
  import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

  // Your code here
</script>
```

## License

MIT
