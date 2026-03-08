# Supabase Provider Demo

This demo showcases the Supabase provider for y-generic with both ephemeral and persistent modes.

## Prerequisites

1. **Supabase Project**: Create a free project at [supabase.com](https://supabase.com)
2. **Database Table** (for persistent mode only): Create the required table in your Supabase project

## Database Setup (Persistent Mode Only)

If you want to use persistent mode (database-backed sync), create this table in your Supabase project:

### SQL Setup

Run this SQL in your Supabase SQL Editor:

```sql
-- Create the documents table
CREATE TABLE yjs_documents (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security (RLS)
ALTER TABLE yjs_documents ENABLE ROW LEVEL SECURITY;

-- Create policy for public access (adjust as needed for your use case)
CREATE POLICY "Public Access" ON yjs_documents
  FOR ALL 
  USING (true)
  WITH CHECK (true);

-- Optional: Add an index for faster lookups
CREATE INDEX idx_yjs_documents_id ON yjs_documents(id);

-- Optional: Add a trigger to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_yjs_documents_updated_at 
  BEFORE UPDATE ON yjs_documents 
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();
```

### Adjust RLS Policies (Optional)

The above policy allows public read/write access. For better security, you can:

1. **Require authentication**:
```sql
DROP POLICY "Public Access" ON yjs_documents;

CREATE POLICY "Authenticated Access" ON yjs_documents
  FOR ALL 
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
```

2. **Per-user access** (users can only access their own documents):
```sql
-- Add user_id column
ALTER TABLE yjs_documents ADD COLUMN user_id UUID REFERENCES auth.users(id);

-- Create policy
DROP POLICY "Public Access" ON yjs_documents;

CREATE POLICY "User Access" ON yjs_documents
  FOR ALL 
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

## Running the Demo

1. **Install dependencies** (if not already installed):
```bash
npm install
```

2. **Start the development server**:
```bash
npm run dev:supabase
```

3. **Configure in browser**:
   - Open http://localhost:3010
   - Enter your Supabase project URL (e.g., `https://xxxxx.supabase.co`)
   - Enter your Supabase anon key (found in Settings → API)
   - Enter a room name
   - (Optional) Enter a password to secure the room
   - Choose mode:
     - **Ephemeral**: Peer-to-peer only, no database (RLS not required)
     - **Persistent**: Database-backed, requires the table setup above
   - Click "Connect"

## Features

### Ephemeral Mode
- Real-time peer-to-peer synchronization via Supabase Realtime
- No database operations
- States are lost when all users disconnect
- No database setup required
- Perfect for temporary collaboration sessions

### Persistent Mode
- Real-time peer-to-peer synchronization
- Automatic database persistence
- Document loads from database on connect
- Debounced saves (configurable, default: 2 seconds)
- States survive between sessions
- Requires database table setup (see above)

### Optional Password Protection
- Password is hashed (SHA-256) and included in the channel name
- Provides basic security for both modes
- Users must know the password to join the room

## Testing Multiple Users

To test collaboration:

1. Open multiple browser windows/tabs at http://localhost:3010
2. Use the same Supabase credentials and room name
3. Choose the same mode (ephemeral or persistent)
4. Enter the same password (if using one)
5. Start typing in one window and see it sync to others

## Security Notes

- The **anon key is public** and exposed in client code
- Use **RLS policies** in Supabase to restrict database access
- Passwords are **hashed, not encrypted** - suitable for casual security
- For sensitive data, consider additional encryption at the application level

## Environment Variables (Optional)

For easier development, you can save your Supabase credentials in localStorage. The demo automatically saves and loads:
- Supabase URL
- Supabase Anon Key

These are stored in your browser's localStorage for convenience.

## Troubleshooting

### "Failed to connect" error
- Check your Supabase URL and anon key are correct
- Verify your Supabase project is active
- Check browser console for detailed error messages

### "Failed to save to database" warnings
- Ensure the `yjs_documents` table exists
- Verify RLS policies allow your operations
- Check that the anon key has the required permissions
- Verify column names match (default: `id`, `content`)

### No real-time sync between peers
- Ensure all peers are using the same room name
- If using a password, all peers must use the exact same password
- Check that Supabase Realtime is enabled for your project
- Verify network connectivity

## Advanced Configuration

You can customize the provider configuration in `index.ts`:

```typescript
await provider.connect({
  supabaseUrl: 'https://xxxxx.supabase.co',
  supabaseKey: 'your-anon-key',
  room: 'my-room',
  password: 'optional-password',
  persistent: true,
  
  // Advanced options:
  tableName: 'yjs_documents',        // Custom table name
  columnName: 'content',              // Custom column for document data
  idColumnName: 'id',                 // Custom column for document ID
  persistDebounceMs: 2000,            // Debounce delay for database writes
  debug: true                         // Enable debug logging
})
```

## Next Steps

- Implement proper authentication with Supabase Auth
- Add user profiles and permissions
- Customize RLS policies for your use case
- Add encryption for sensitive data
- Implement document versioning/history
