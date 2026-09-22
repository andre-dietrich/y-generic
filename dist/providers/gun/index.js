/**
 * GunDB Transport Provider
 *
 * Decentralized peer-to-peer transport using GunDB graph database.
 * GunDB provides automatic conflict resolution and offline-first sync.
 *
 * Features:
 * - Decentralized P2P architecture
 * - Automatic conflict resolution (CRDT)
 * - Offline-first with auto-sync
 * - Real-time updates via .on()
 * - Optional relay servers
 * - Graph-based data structure
 * - Password-protected rooms with AES encryption (via SEA)
 *
 * @example
 * ```typescript
 * import { GenericProvider } from 'y-generic'
 * import { GunTransport } from 'y-generic/providers/gun'
 * import Gun from 'gun'
 *
 * const doc = new Y.Doc()
 * const transport = new GunTransport({
 *   gun: Gun, // Pass the Gun constructor
 *   peers: ['https://gun-relay.herokuapp.com/gun']
 * })
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({ room: 'my-room' })
 * ```
 *
 * @example Password-protected room
 * ```typescript
 * import Gun from 'gun'
 * import 'gun/sea'  // Required for encryption
 *
 * const transport = new GunTransport({
 *   gun: Gun,
 *   sea: Gun.SEA,  // Provide SEA module
 *   password: 'my-secret-room-password',
 *   peers: ['https://gun-relay.herokuapp.com/gun']
 * })
 * ```
 */
import { watchPageBack } from '../resume';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
// ---------------------------------------------------------------------------
// CRC32 helpers — needed to wrap snapshot payloads for GenericProvider
// ---------------------------------------------------------------------------
const _CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();
function _crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++)
        crc = (crc >>> 8) ^ _CRC32_TABLE[(crc ^ data[i]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
}
function addCRC32Header(data) {
    const crc = _crc32(data);
    const wrapped = new Uint8Array(4 + data.length);
    wrapped[0] = (crc >>> 24) & 0xff;
    wrapped[1] = (crc >>> 16) & 0xff;
    wrapped[2] = (crc >>> 8) & 0xff;
    wrapped[3] = crc & 0xff;
    wrapped.set(data, 4);
    return wrapped;
}
// Message type identifiers (must match GenericProvider)
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// The update slot a page that unloads writes into (`slot-<writer>-unload`) -
// warmed at connect, so that write needs no round trip (flush()). Not one of
// the circular buffer's slots, so it overwrites nothing a peer may still be
// missing; and a writer's own, so two pages that unload at once do not
// overwrite each other either.
const UNLOAD_SLOT = 'unload';
// A presence slot older than this is ignored on receipt: the relay keeps
// every slot ever written and `.map().on()` replays all of them to a
// joiner, so without a bound a joiner inherited one phantom presence per
// connection the room ever had (round 7, item 5; measured 55 phantoms for
// 60 slots in test/dummy/bench-gun-awareness-replay.ts). A live slot is
// rewritten every lease/2 (at most 150 s at the playgrounds' 120 s lease),
// so 5 min is never reached by one; a bound the size of the lease would
// make a peer whose clock runs a minute or two off invisible to everyone.
// Since round 10 the replay is not presence at all (setupAwarenessListener:
// an answer to our own get is history) - this bound stays as the belt for
// a live write that is old by its own stamp.
const AWARENESS_MAX_AGE_MS = 5 * 60000;
/**
 * GunDB transport implementation.
 * Creates decentralized P2P connections using Gun graph database.
 *
 * Note: deliberately does NOT set `preferredBatchMs` on the Transport
 * interface. send() already debounces internally via `batchInterval`
 * (see flushBatch()) — an additional GenericProvider-level batch delay
 * would just stack a second debounce in front of this one for no benefit.
 */
export class GunTransport {
    /**
     * Create a new Gun transport.
     *
     * @param options - Configuration options (must include gun constructor)
     */
    constructor(options) {
        // Relay mesh with its own debounce/throttle: a few hundred ms round trip.
        this.expectedRttMs = 500;
        this._connected = false;
        this._room = '';
        this.gun = null;
        this.roomNode = null;
        this.updateListener = null;
        this.lastUpdateTime = 0;
        this.updateBatch = [];
        this.processedUpdates = new Set();
        this.pendingUpdates = new Map();
        this.updateSlot = 0;
        // Each writer its own ring of update slots (`slot-<writer>-<n>`). One ring
        // for the room, every writer counting from slot-0, made concurrent writers
        // put into the same keys - gun keeps one - and the receivers' dedupe key
        // (slot, 100 ms window) made two writers in one slot one update: five
        // writers at 4 Hz, 60 of 200 frames heard live (test/gun/repro-concurrent-
        // writers.mjs); ten typing peers, the lag typed -> seen 13 s at the median,
        // 52 s at p95 - the core's resync filled the holes (room-scenarios STORM).
        this.BUFFER_SIZE = 10; // slots per writer
        this.writerId = '';
        this.writeSeq = 0;
        this.awarenessListener = null;
        this.lastAwarenessId = ''; // Track last awareness ID to avoid processing our own
        this.ownAwarenessId = null; // Stable per-client slot key under the awareness node
        this.encryptionEnabled = false;
        // Persistence
        this.persistentMode = false;
        this.persistDoc = null;
        this.persistDebounceMs = 2000;
        this._redialTimers = new Map();
        this._redialNow = new Map(); // url -> dial it now (a backoff to skip)
        this.isWritingToGun = false;
        this.savePending = false;
        /** Data loaded from Gun snapshot before onMessage callback is registered */
        this.pendingLoad = null;
        /** True once loadSnapshot()'s initial Gun read has completed */
        this.snapshotLoaded = false;
        if (!options.gun) {
            throw new Error('GunTransport requires the "gun" option. ' +
                'Please provide the Gun constructor: ' +
                'import Gun from "gun"; new GunTransport({ gun: Gun, ... })');
        }
        // Validate SEA is provided when using password
        if (options.password && !options.sea) {
            throw new Error('GunTransport requires the "sea" option when using password encryption. ' +
                'Please provide Gun.SEA: import "gun/sea"; new GunTransport({ gun: Gun, sea: Gun.SEA, password: "..." })');
        }
        this.options = {
            gun: options.gun,
            peers: options.peers ?? [],
            gunOptions: options.gunOptions ?? {},
            debug: options.debug ?? false,
            batchInterval: options.batchInterval ?? 100, // Debounce: wait 100ms after last update
            password: options.password,
            sea: options.sea,
        };
        this.encryptionEnabled = !!(options.password && options.sea);
        if (this.encryptionEnabled) {
            this.log('🔐 Encryption enabled');
        }
    }
    /**
     * Connect to the room and start syncing.
     */
    async connect(config) {
        if (this._connected) {
            throw new Error('Already connected');
        }
        this._room = config.room;
        this.persistentMode = config.persistent ?? false;
        this.persistDoc = config.doc ?? null;
        this.persistDebounceMs = config.persistDebounceMs ?? 2000;
        if (this.persistentMode && !this.persistDoc) {
            throw new Error('GunTransport: a Y.Doc must be provided via config.doc when persistent is true');
        }
        this.log('🔗 Initializing Gun...');
        // Initialize Gun
        const gunConfig = {
            localStorage: false, // Disable localStorage to prevent quota errors
            radisk: false, // Disable radisk
            ...this.options.gunOptions,
        };
        // Add peers if specified. Gun wants full URLs ending in the relay's
        // path (`http://host:8765/gun`; it turns http(s) into ws(s) itself) -
        // a bare `host:8765` never connects and Gun says nothing. Fill in what
        // is missing: http:// (https:// only if the relay has a certificate),
        // and /gun when there is no path.
        if (this.options.peers.length > 0) {
            const peers = this.options.peers.map((peer) => {
                let url = peer.trim();
                if (!/^(https?|wss?):\/\//i.test(url))
                    url = 'http://' + url;
                if (/^(https?|wss?):\/\/[^/]+\/?$/i.test(url))
                    url = url.replace(/\/?$/, '/gun');
                return url;
            });
            gunConfig.peers = peers;
            this.log('📡 Connecting to peers:', peers);
        }
        const relayUrls = [...(gunConfig.peers ?? [])]; // Gun turns the array it is given into an object
        this.gun = new this.options.gun(gunConfig);
        this._watchRelays(this.gun, relayUrls);
        // Navigate to room node
        this.roomNode = this.gun.get(`yjs-room-${this._room}`);
        this.log('✅ Gun initialized for room:', this._room);
        // Note: We use a circular buffer (10 slots) to prevent infinite accumulation
        // of update nodes in Gun's graph. This prevents the "1K+ records" warning.
        // Each update overwrites one of the slots (slot-0 through slot-9).
        // Subscribe to updates from Gun (both doc sync and awareness)
        this.setupUpdateListener();
        this.setupAwarenessListener();
        // Wait for the first relay to say hi before anything is written: a put
        // made before the websocket is up is stored by the relay but not pushed
        // to peers already subscribed (measured 2026-09-07 with two Node peers
        // on gun's own examples/http.js relay: the joiner's JOIN batch and
        // presence, written ~10 ms before 'hi', never reached the settled
        // peer; every later write did). GenericProvider sends its connect
        // batch the moment connect() resolves, so resolve after 'hi' - or after
        // a short timeout for a relay that is down or a local-only instance.
        if (this.options.peers.length > 0) {
            await new Promise((resolve) => {
                let done = false;
                const finish = () => {
                    if (done)
                        return;
                    done = true;
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(() => {
                    this.log('⏱️ No relay said hi within 3 s, continuing');
                    finish();
                }, 3000);
                try {
                    this.gun.on('hi', (peer) => {
                        this.log('🤝 Relay connected:', peer?.url ?? peer?.id ?? '?');
                        finish();
                    });
                }
                catch {
                    finish();
                }
            });
        }
        this._connected = true;
        this.writerId = this.stableWriterId();
        // Warm the slot a page that unloads writes its last words into (see
        // flush()): gun sends a `get` for a node it does not know yet and puts
        // only when the answer is in - a round trip a page that is going away
        // does not have. A node it HAS written once is put in the calling task.
        // `data: null` is ignored by every receiver (setupUpdateListener).
        this.roomNode
            .get('updates')
            .get(this.slotKey(UNLOAD_SLOT))
            .put({ data: null, timestamp: Date.now() });
        // Persistence: load existing snapshot or clear it for a fresh session
        this.snapshotLoaded = false;
        if (this.persistentMode) {
            this.loadSnapshot();
        }
        else {
            // Overwrite any previously saved snapshot so reconnecting peers start fresh
            this.roomNode
                .get('snapshot')
                .put({ cleared: true, timestamp: Date.now() });
        }
    }
    /**
     * Setup listener for Gun updates.
     */
    setupUpdateListener() {
        let lastProcessTime = 0;
        const THROTTLE_MS = 300; // Process updates at most every 300ms
        // One listener for what the relay holds and what comes later: `.map().on()`
        // fires for every update slot, the existing ones at subscribe (each as the
        // answer to our own get) and every write from then on; processedUpdates
        // dedupes. Until round 10 an initial load with `.once()` on the updates
        // node came first and the map listener skipped everything that arrived
        // before it had called back - which was every replayed slot: gun's once
        // waits 99 ms for more answers, the slots' own answers are in by then,
        // and the once callback itself sees the node's links, not the slots' data.
        // A joiner in a room whose peers were all gone got no document at all
        // (test/gun/repro-lone-joiner.mjs: three updates, a live witness heard
        // them, the lone joiner nothing); with a peer in the room the core's
        // sync had covered it. Yjs applies updates in any order, so the slots
        // need none.
        this.updateListener = this.roomNode
            .get('updates')
            .map()
            .on((update, updateId) => {
            if (!update || !update.data)
                return;
            // Use sequence number for deduplication
            const sequence = update.sequence || Math.floor(update.timestamp / 100);
            const updateKey = `${updateId}-${sequence}`;
            if (this.processedUpdates.has(updateKey)) {
                return;
            }
            // Store update for throttled processing
            this.pendingUpdates.set(updateKey, update);
            // Throttle processing (batching)
            const now = Date.now();
            if (now - lastProcessTime < THROTTLE_MS) {
                if (!this.throttleTimeout) {
                    this.throttleTimeout = setTimeout(() => {
                        this.processPendingUpdates();
                        lastProcessTime = Date.now();
                        this.throttleTimeout = undefined;
                    }, THROTTLE_MS);
                }
                return;
            }
            // Process immediately if enough time has passed
            lastProcessTime = now;
            this.processPendingUpdates();
        });
        this.log('👂 Listening for new updates...');
    }
    /**
     * Process all pending updates at once.
     */
    async processPendingUpdates() {
        if (this.pendingUpdates.size === 0)
            return;
        const updates = Array.from(this.pendingUpdates.entries());
        this.pendingUpdates.clear();
        for (const [updateKey, update] of updates) {
            // Mark as processed
            this.processedUpdates.add(updateKey);
            // Clean old entries from processed set (keep last 200)
            if (this.processedUpdates.size > 200) {
                const entries = Array.from(this.processedUpdates);
                entries.slice(0, entries.length - 200).forEach((key) => {
                    this.processedUpdates.delete(key);
                });
            }
            try {
                let payload = update.data;
                // Decrypt if encrypted
                if (update.encrypted && this.encryptionEnabled) {
                    payload = await this.decrypt(payload);
                    if (!payload) {
                        this.log('❌ Failed to decrypt update (wrong password?)');
                        continue;
                    }
                }
                // Decode base64 back to Uint8Array, then split the length-prefixed
                // framing back into the individual envelopes flushBatch() combined
                // (see frameUpdates()/unframeUpdates()) — a flush may contain
                // several independently CRC32-wrapped GenericProvider messages.
                const decoded = this.base64ToUint8Array(payload);
                const frames = this.unframeUpdates(decoded);
                if (this._callback) {
                    for (const frame of frames) {
                        this._callback(frame);
                    }
                }
                if (updates.length === 1) {
                    this.log('📥 Received update:', frames.length, frames.length === 1 ? 'message' : 'messages', update.encrypted ? '(decrypted)' : '');
                }
            }
            catch (error) {
                this.log('❌ Error processing update:', error);
            }
        }
        if (updates.length > 1) {
            this.log(`📥 Processed ${updates.length} batched updates`);
        }
    }
    /**
     * Bring a lost relay back. gun 0.2020.1241's browser websocket adapter
     * tries ONCE: wire.onclose calls reconnect(peer) - one attempt, 2 s later -
     * and then mesh.bye(peer), whose handler deletes the peer from opt.peers;
     * when that one attempt fails, reconnect() returns at
     * `if(!opt.peers[peer.url])` and nothing ever dials again. A relay down
     * for more than ~2 s, a page frozen for 20 s (Chrome closes its sockets, and
     * the one attempt runs into the freeze): the peer neither hears nor reaches
     * anybody again, with no error anywhere - 25 browsers after a 5 s relay
     * restart: every roster at 1, editors different
     * (test/e2e/room-scenarios.mjs gun, test/gun/repro-relay-restart.mjs).
     *
     * So on every 'bye' of one of OUR relays: put it back into opt.peers and
     * dial, 3 s later, doubling up to 30 s while it keeps failing (a failed
     * dial ends in another 'bye'). Gun re-sends its subscriptions by itself on
     * 'hi'; the provider is told as well (onPeerConnect), for what it wrote and
     * missed meanwhile.
     *
     * And the page's own signs that its network is back - visible again,
     * `online`, a change of `navigator.connection` - dial at once instead of
     * sitting out the backoff (watchPageBack, as simple-peer, PeerJS, Nostr
     * and WebSocket do since round 10). A phone with its display off loses the
     * relay socket again and again (a real phone on Gun, 2026-09-21: "relay
     * gone" at 33 s and 72 s of a 84 s absence, the wait at 12 s by then);
     * that it was back 0.2 s after the display came on was a pending timer
     * that fired on wake - a backoff set right before the WiFi went, with the
     * display on, would have been waited out. Gate: test/gun/repro-page-back.mjs.
     */
    _watchRelays(gun, urls) {
        const transport = this;
        const lost = new Map(); // url -> failed dials since the relay went
        const dial = (url) => {
            transport._redialTimers.delete(url);
            transport._redialNow.delete(url);
            if (transport.gun !== gun)
                return;
            try {
                if (gun._.opt.peers[url]?.wire)
                    return; // Gun's own attempt made it
                gun.opt({ peers: [url] });
                gun._.opt.mesh.hi(gun._.opt.peers[url]); // no wire yet: this dials
            }
            catch (error) {
                transport.log('❌ Redial failed:', error);
            }
        };
        // `function`, and this.to.next(): Gun's listeners are a chain, and one
        // that does not pass the event on ends it for everybody registered later.
        gun.on('bye', function (peer) {
            this.to.next(peer);
            const url = peer?.url;
            if (transport.gun !== gun || !urls.includes(url) || transport._redialTimers.has(url))
                return;
            const attempt = lost.get(url) ?? 0;
            lost.set(url, attempt + 1);
            const delay = Math.min(30000, 3000 * 2 ** attempt);
            transport.log('🔌 Relay gone:', url, '- dialing again in', delay, 'ms');
            transport._redialTimers.set(url, setTimeout(() => dial(url), delay));
            transport._redialNow.set(url, () => dial(url));
        });
        if (!this._stopPageWatch) {
            this._stopPageWatch = watchPageBack(() => {
                if (transport.gun !== gun || transport._redialNow.size === 0)
                    return;
                transport.log('📱 Page is back: dialing now, not after the backoff');
                for (const [url, now] of [...transport._redialNow]) {
                    clearTimeout(transport._redialTimers.get(url));
                    now();
                }
            });
        }
        gun.on('hi', function (peer) {
            this.to.next(peer);
            if (transport.gun !== gun || !lost.delete(peer?.url))
                return;
            transport.log('🤝 Relay is back:', peer.url);
            transport._peerConnectCallback?.(peer.url);
        });
    }
    /**
     * Transport.onPeerConnect: fires when a relay that was lost says hi again
     * (never at the first connect) - see _watchRelays().
     */
    onPeerConnect(callback) {
        this._peerConnectCallback = callback;
        return () => {
            this._peerConnectCallback = undefined;
        };
    }
    /**
     * Transport.flush: run gun's own pending work in THIS task.
     *
     * gun 0.2020.1241 hands every write to its turn queue
     * (`setTimeout.turn`, gun.js's shim), which is drained by a MessageChannel
     * task in the browser and by setImmediate under Node - synchronously only
     * while the last drain is less than 9 ms old (`setTimeout.hold`). A page
     * that unloads runs no further task, so the presence removal the provider
     * sends from `beforeunload` never reached the wire: a reloaded page stayed
     * a ghost in every roster until the presence lease ran out - 124 s in round
     * 8, 128.5 s of 25 browsers in round 10 (test/e2e/room-scenarios.mjs gun).
     *
     * So we run what gun queued, now: its own functions, one task earlier.
     * Each one may queue the next layer (chain -> root.on('out') -> mesh.say ->
     * wire.send), hence the rounds; the cap is there so a queue that refills
     * itself cannot hold the page. Gate: test/gun/repro-unload-removal.mjs.
     *
     * Our own debounce (`batchInterval`) is a timer of exactly the same kind,
     * so the queued document updates go first - the words a page typed just
     * before it was closed - and into UNLOAD_SLOT, the one update node warmed
     * at connect: gun asks the relay about a node it has not written before
     * and puts only when the answer is in, which is a round trip this page
     * does not have (measured in the wire trace: a put to a fresh slot sends a
     * `get` and nothing else). With a password they do not make it either way:
     * the encryption of flushBatch() is asynchronous, and nothing after an
     * `await` runs in a page that is already gone.
     */
    flush() {
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
            this.batchTimeout = undefined;
        }
        this.flushBatch(this.slotKey(UNLOAD_SLOT));
        const turn = setTimeout
            .turn;
        if (!turn?.s)
            return;
        for (let round = 0; round < 50 && turn.s.length > 0; round++) {
            for (const pending of turn.s.splice(0, turn.s.length)) {
                try {
                    pending();
                }
                catch (error) {
                    this.log('❌ Flush failed:', error);
                }
            }
        }
    }
    /**
     * Disconnect from Gun and cleanup.
     */
    disconnect() {
        if (!this._connected)
            return;
        this.log('👋 Disconnecting...');
        for (const timer of this._redialTimers.values())
            clearTimeout(timer);
        this._redialTimers.clear();
        this._redialNow.clear();
        this._stopPageWatch?.();
        this._stopPageWatch = undefined;
        // Clear batch timeout
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
            this.batchTimeout = undefined;
        }
        // Clear persist debounce and flush snapshot synchronously (Gun is async internally)
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        if (this.persistentMode && this.persistDoc) {
            this.saveSnapshot();
        }
        // Clear throttle timeout
        if (this.throttleTimeout) {
            clearTimeout(this.throttleTimeout);
            this.throttleTimeout = undefined;
        }
        // Process any pending updates before disconnect
        this.processPendingUpdates();
        // Flush any pending updates
        this.flushBatch();
        // Our presence slot stays, with the removal the provider wrote into it
        // just before (it removes the local state before it disconnects the
        // transport). Round 7 nulled the slot here, "to take it with us" - and
        // took the removal with it: a page's beforeunload wrote the removal,
        // the playground's own handler called disconnect(), and gun's queue
        // sent the null two tasks later, before pagehide. Live peers had the
        // removal by then; a page that joined afterwards - the reloaded page
        // itself - was replayed an empty slot, and a presence table a peer had
        // written into ITS slot seconds earlier put the old client back. The
        // reloaded page held its own ghost for a lease while every other
        // roster was whole (25 browsers: 127.9 s). The slot ages out at the
        // receivers as any other (AWARENESS_MAX_AGE_MS); a replayed removal of
        // a client nobody knows costs y-protocols one clock entry.
        // Gate: test/gun/repro-unload-removal.mjs, the disconnect part.
        // Remove listeners
        if (this.updateListener) {
            // Gun doesn't have a clear off() method for map listeners
            // The listener will be garbage collected
            this.updateListener = null;
        }
        if (this.awarenessListener) {
            this.awarenessListener = null;
        }
        this.roomNode = null;
        this.gun = null;
        this._connected = false;
        this.processedUpdates.clear();
        this.pendingUpdates.clear();
        this.persistentMode = false;
        this.persistDoc = null;
        this.pendingLoad = null;
        this.snapshotLoaded = false;
        this.log('✅ Disconnected');
    }
    /**
     * Send data to all peers via Gun.
     * Routes awareness to a separate volatile node, doc sync to circular buffer.
     * Uses debouncing for doc sync - each new update resets the timer.
     */
    send(data) {
        if (!this._connected || !this.roomNode) {
            this.log('⚠️ Not connected, cannot send');
            return;
        }
        // Peek message type (after CRC32 header: 4 bytes CRC + 1 byte type)
        const messageType = this.peekMessageType(data);
        // Route awareness to separate volatile node (immediate, no buffer)
        if (messageType === MESSAGE_AWARENESS) {
            this.sendAwareness(data);
            return;
        }
        // Doc sync goes through batched circular buffer
        this.updateBatch.push(data);
        // Clear existing timeout (debouncing - resets timer on each update)
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
        }
        // Set new timeout to flush batch after period of inactivity
        this.batchTimeout = setTimeout(() => {
            this.flushBatch();
        }, this.options.batchInterval);
        // Schedule a snapshot save for persistent mode
        if (this.persistentMode) {
            this.queuePersist();
        }
    }
    /**
     * Peek at the message type from CRC32-wrapped data.
     * Format: [CRC32 (4 bytes)][message type (varint)]...
     * Returns -1 if cannot determine type.
     */
    peekMessageType(data) {
        // Need at least 5 bytes: 4 for CRC32 + 1 for message type
        if (data.length < 5)
            return -1;
        // Message type is stored as varint after CRC32, but for small values (0-3)
        // it's just a single byte
        return data[4];
    }
    /**
     * Send awareness update to a per-client slot under the awareness node.
     * Awareness is ephemeral - only the latest state per client matters.
     * Each client writes to its own slot (keyed by a stable per-connection id)
     * so peers never overwrite each other's presence data.
     */
    async sendAwareness(data) {
        let payload = this.uint8ArrayToBase64(data);
        // Encrypt if password is set
        if (this.encryptionEnabled) {
            payload = await this.encrypt(payload);
        }
        // Generated once per connection and reused for every broadcast, so all
        // of this client's updates land in the same slot instead of each
        // clobbering a shared node.
        if (!this.ownAwarenessId) {
            this.ownAwarenessId = `aware-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        }
        const awarenessId = this.ownAwarenessId;
        // Track this ID so we don't process our own update
        this.lastAwarenessId = awarenessId;
        this.roomNode.get('awareness').get(awarenessId).put({
            data: payload,
            id: awarenessId,
            timestamp: Date.now(),
            encrypted: this.encryptionEnabled,
        });
        this.log('📤 Sent awareness update', this.encryptionEnabled ? '(encrypted)' : '');
    }
    /**
     * Setup listener for awareness updates (separate from doc sync).
     * `.map().on()` fires for every per-client slot: the ones the relay
     * holds when we subscribe (replayed, each as the answer to our own get -
     * gun sets `@`, the id of that get, on an answer and nothing on a live
     * write), and every write from then on.
     *
     * Presence from the replay is history and dropped: a slot's last value is
     * the last thing that connection wrote, and a page killed without a word
     * (a closed laptop, a crashed tab) left its presence there. To a joiner
     * it looked like a live peer - written when, the joiner cannot tell
     * without trusting the writer's clock - so the joiner listed it for a
     * whole lease of its own, long after the room had expired it: with 25
     * browsers the page that reloaded after a killed tab was alone at 25 for
     * 122 s (test/e2e/room-scenarios.mjs gun, rejoin after vanish). Round 7's
     * five-minute bound (AWARENESS_MAX_AGE_MS) cut the phantoms of hours-old
     * slots, not this one. Who is here now, a joiner learns from the room:
     * its JOIN is answered with a live presence table (round 5, presence on
     * demand; the reloaded page's roster was whole in 0.4 s from that). A
     * re-subscribe after a relay restart gets answers the same way, and the
     * provider asks the room for its presence then too (onPeerConnect).
     * Gate: test/gun/repro-unload-removal.mjs, the late joiner C.
     */
    setupAwarenessListener() {
        this.awarenessListener = this.roomNode
            .get('awareness')
            .map()
            .on(async (awareness, _key, msg) => {
            if (!awareness || !awareness.data)
                return;
            // Only a wire message with its own id (`#`) and no `@` is a peer's
            // live write. An answer to our own get has `@`. And gun re-emits a
            // whole node key by key ("convert from old format", gun.js `input`)
            // with the original message under VIA - in the browser that wave
            // came 60 ms after the answers, when the page wrote its own slot,
            // with neither `#` nor `@` on the converted message: the same
            // stale slots again, a killed tab's 180 s old presence among them.
            let wire = msg;
            while (wire && (wire.VIA || wire.via))
                wire = wire.VIA || wire.via;
            if (!wire || wire['#'] === undefined || wire['@'] !== undefined) {
                this.log('🕰️ Replayed presence dropped: slot', awareness.id, 'written', typeof awareness.timestamp === 'number'
                    ? `${Date.now() - awareness.timestamp} ms ago`
                    : 'unknown', 'message keys', msg ? Object.keys(msg).join(',') : '-', wire !== msg ? `via ${wire ? Object.keys(wire).join(',') : '-'}` : '');
                return;
            }
            // Skip our own awareness updates
            if (awareness.id === this.lastAwarenessId)
                return;
            // Skip the presence of connections long gone (see AWARENESS_MAX_AGE_MS)
            if (typeof awareness.timestamp === 'number' &&
                Date.now() - awareness.timestamp > AWARENESS_MAX_AGE_MS) {
                return;
            }
            try {
                let payload = awareness.data;
                // Decrypt if encrypted
                if (awareness.encrypted && this.encryptionEnabled) {
                    payload = await this.decrypt(payload);
                    if (!payload) {
                        this.log('❌ Failed to decrypt awareness (wrong password?)');
                        return;
                    }
                }
                const decoded = this.base64ToUint8Array(payload);
                if (this._callback) {
                    this._callback(decoded);
                }
                this.log('📥 Received awareness update', awareness.encrypted ? '(decrypted)' : '', 'slot', awareness.id, 'written', typeof awareness.timestamp === 'number'
                    ? `${Date.now() - awareness.timestamp} ms ago`
                    : 'unknown', 'message keys', msg ? Object.keys(msg).join(',') : '-');
            }
            catch (error) {
                this.log('❌ Error processing awareness:', error);
            }
        });
        this.log('👂 Listening for awareness updates...');
    }
    /**
     * Frame a list of independently-wrapped envelopes with 4-byte big-endian
     * length prefixes so they can be split back apart after transmission as
     * one combined Gun record. See unframeUpdates() for the inverse.
     */
    frameUpdates(updates) {
        const totalLength = updates.reduce((sum, arr) => sum + 4 + arr.length, 0);
        const merged = new Uint8Array(totalLength);
        const view = new DataView(merged.buffer);
        let offset = 0;
        for (const update of updates) {
            view.setUint32(offset, update.length, false);
            merged.set(update, offset + 4);
            offset += 4 + update.length;
        }
        return merged;
    }
    /**
     * Split a buffer produced by frameUpdates() back into the individual
     * envelopes it contains. Malformed/truncated framing stops early rather
     * than throwing, since a partial batch is still recoverable via periodic
     * sync / hash verification.
     */
    unframeUpdates(data) {
        const frames = [];
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;
        while (offset + 4 <= data.length) {
            const len = view.getUint32(offset, false);
            offset += 4;
            if (len < 0 || offset + len > data.length) {
                this.log('⚠️ Malformed batch framing, stopping split early');
                break;
            }
            frames.push(data.subarray(offset, offset + len));
            offset += len;
        }
        return frames;
    }
    /**
     * Flush batched updates to Gun.
     * Called after debounce period (no new updates for batchInterval ms).
     */
    async flushBatch(slotId) {
        if (this.updateBatch.length === 0)
            return;
        // Frame each queued update with a 4-byte big-endian length prefix so
        // multiple independently CRC32-wrapped GenericProvider envelopes can be
        // split back apart on the receiving side (see processPendingUpdates()).
        // Each entry in updateBatch is already a complete, self-checksummed
        // envelope — naively concatenating them without a delimiter made the
        // combined blob fail CRC32 verification (and get silently dropped)
        // whenever 2+ updates landed in the same flush.
        const merged = this.frameUpdates(this.updateBatch);
        // Clear batch
        this.updateBatch = [];
        // Convert to base64 for Gun storage
        let payload = this.uint8ArrayToBase64(merged);
        // Encrypt if password is set
        if (this.encryptionEnabled) {
            payload = await this.encrypt(payload);
        }
        // Create update object with circular buffer slot
        const updateId = slotId ?? this.generateUpdateId();
        const timestamp = Date.now();
        // Unique per write - the receivers dedupe on (slot, sequence). Not the
        // 100 ms window it used to be (two writes of one slot within 100 ms were
        // one), and not a counter alone: a reloaded tab keeps its writer id.
        const sequence = `${timestamp}.${++this.writeSeq}`;
        // Mark as processed so we don't receive our own update
        this.processedUpdates.add(`${updateId}-${sequence}`);
        // Store in Gun using circular buffer slot
        const updates = this.roomNode.get('updates');
        updates.get(updateId).put({
            data: payload,
            timestamp: timestamp,
            sequence: sequence,
            size: merged.length,
            encrypted: this.encryptionEnabled,
        });
        this.log('📤 Sent update:', merged.length, 'bytes', this.encryptionEnabled ? '(encrypted)' : '');
    }
    /**
     * Register callback for incoming messages.
     */
    onMessage(callback) {
        this._callback = callback;
        // Flush any snapshot data that arrived before this callback was registered
        if (this.pendingLoad) {
            const data = this.pendingLoad;
            this.pendingLoad = null;
            // Defer by one microtask so GenericProvider finishes its own setup first
            Promise.resolve().then(() => callback(data));
        }
        return () => {
            this._callback = undefined;
        };
    }
    /**
     * Check if connected.
     */
    get isConnected() {
        return this._connected;
    }
    /**
     * Generate a circular buffer slot ID.
     * Uses only BUFFER_SIZE slots to prevent infinite accumulation.
     */
    generateUpdateId() {
        const slotId = this.slotKey(String(this.updateSlot));
        this.updateSlot = (this.updateSlot + 1) % this.BUFFER_SIZE;
        return slotId;
    }
    slotKey(n) {
        return `slot-${this.writerId}-${n}`;
    }
    /**
     * The writer id: per tab, and the same after a reload (sessionStorage), so
     * the relay's graph grows by a ring per tab rather than per page load - it
     * keeps every slot, and a joiner is replayed all of them.
     */
    stableWriterId() {
        const fresh = () => Math.random().toString(36).slice(2, 10);
        try {
            const store = globalThis.sessionStorage;
            if (!store)
                return fresh();
            const key = `ygen-gun-writer-${this._room}`;
            let id = store.getItem(key);
            if (!id)
                store.setItem(key, (id = fresh()));
            return id;
        }
        catch {
            return fresh();
        }
    }
    // ---------------------------------------------------------------------------
    // Persistence helpers
    // ---------------------------------------------------------------------------
    /**
     * Schedule a debounced snapshot write. Called on every doc update.
     * Always saves the latest full state, never an individual delta.
     */
    queuePersist() {
        if (this.persistTimer)
            clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => this.saveSnapshot(), this.persistDebounceMs);
    }
    /**
     * Encode the full Y.Doc state as a proper y-protocols SYNC_STEP_2 message
     * and write it to the Gun `snapshot` node.
     * Using SYNC_STEP_2 format ensures GenericProvider interprets it correctly.
     */
    async saveSnapshot() {
        if (!this.persistDoc || !this.persistentMode || !this.roomNode)
            return;
        if (!this.snapshotLoaded) {
            // The initial Gun read hasn't resolved yet — saving now could clobber
            // the real persisted state with our still-unmerged local doc. Retry
            // shortly instead of writing.
            this.persistTimer = setTimeout(() => this.saveSnapshot(), 100);
            return;
        }
        if (this.isWritingToGun) {
            this.savePending = true;
            return;
        }
        this.isWritingToGun = true;
        this.savePending = false;
        try {
            // Encode as a proper y-generic SYNC_STEP_2 message
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, 0); // MESSAGE_SYNC
            syncProtocol.writeSyncStep2(enc, this.persistDoc);
            const snapshotBytes = encoding.toUint8Array(enc);
            let payload = this.uint8ArrayToBase64(snapshotBytes);
            if (this.encryptionEnabled) {
                payload = await this.encrypt(payload);
            }
            this.roomNode.get('snapshot').put({
                data: payload,
                timestamp: Date.now(),
                encrypted: this.encryptionEnabled,
            });
            this.log('💾 Snapshot saved', snapshotBytes.length, 'bytes');
        }
        catch (error) {
            this.log('❌ Error saving snapshot:', error.message);
            console.warn('GunTransport: Failed to save snapshot. Will retry later.', error);
            this.savePending = true;
        }
        finally {
            this.isWritingToGun = false;
            if (this.savePending) {
                setTimeout(() => this.saveSnapshot(), 1000);
            }
        }
    }
    /**
     * Load the snapshot from Gun and deliver it to the message callback.
     * Uses a pendingLoad buffer in case the callback isn't registered yet.
     */
    loadSnapshot() {
        this.roomNode.get('snapshot').once(async (snap) => {
            try {
                if (!snap || !snap.data || snap.cleared) {
                    this.log('📭 No snapshot found in Gun');
                    return;
                }
                let payload = snap.data;
                if (snap.encrypted && this.encryptionEnabled) {
                    const decrypted = await this.decrypt(payload);
                    if (!decrypted) {
                        this.log('❌ Failed to decrypt snapshot (wrong password?)');
                        return;
                    }
                    payload = decrypted;
                }
                const snapshotBytes = this.base64ToUint8Array(payload);
                if (snapshotBytes.length > 0) {
                    // Wrap with CRC32 so GenericProvider accepts it
                    const wrapped = addCRC32Header(snapshotBytes);
                    if (this._callback) {
                        this._callback(wrapped);
                    }
                    else {
                        // Callback not yet registered — buffer until onMessage() is called
                        this.pendingLoad = wrapped;
                    }
                    this.log('💾 Loaded snapshot:', snapshotBytes.length, 'bytes');
                }
            }
            catch (error) {
                this.log('❌ Error loading snapshot:', error);
                console.warn('GunTransport: Failed to load snapshot:', error);
            }
            finally {
                // Only now is it safe for saveSnapshot() to write — the local doc
                // has had a chance to merge in whatever Gun had stored.
                this.snapshotLoaded = true;
            }
        });
    }
    /**
     * Convert Uint8Array to base64 string.
     */
    uint8ArrayToBase64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }
    /**
     * Convert base64 string to Uint8Array.
     */
    base64ToUint8Array(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
    /**
     * Encrypt data using SEA with the configured password.
     */
    async encrypt(data) {
        if (!this.options.sea || !this.options.password) {
            return data;
        }
        return await this.options.sea.encrypt(data, this.options.password);
    }
    /**
     * Decrypt data using SEA with the configured password.
     * Returns null if decryption fails (wrong password).
     */
    async decrypt(data) {
        if (!this.options.sea || !this.options.password) {
            return data;
        }
        try {
            const decrypted = await this.options.sea.decrypt(data, this.options.password);
            return decrypted || null;
        }
        catch (error) {
            this.log('❌ Decryption failed:', error);
            return null;
        }
    }
    /**
     * Log debug messages if enabled.
     */
    log(...args) {
        if (this.options.debug) {
            console.log('[GunTransport]', ...args);
        }
    }
}
//# sourceMappingURL=index.js.map