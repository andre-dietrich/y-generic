import './bluetooth.d.ts';
// Custom Bluetooth service UUID for y-generic
// Generated UUID: a7b3c4d5-e6f7-4a5b-8c9d-0e1f2a3b4c5d
const SERVICE_UUID = 'a7b3c4d5-e6f7-4a5b-8c9d-0e1f2a3b4c5d';
// Characteristic UUIDs
const TX_CHARACTERISTIC_UUID = 'a7b3c4d6-e6f7-4a5b-8c9d-0e1f2a3b4c5d'; // Client → Server (write)
const RX_CHARACTERISTIC_UUID = 'a7b3c4d7-e6f7-4a5b-8c9d-0e1f2a3b4c5d'; // Server → Client (notify)
// Maximum chunk size for BLE (conservative, most devices support 512+ bytes)
const MAX_CHUNK_SIZE = 512;
/**
 * WebBluetooth Transport for Yjs
 *
 * Enables device-to-device collaboration via Bluetooth Low Energy.
 * Perfect for offline/local collaboration scenarios.
 *
 * Features:
 * - No internet required
 * - Zero server setup
 * - Works on Android Chrome/Edge
 * - Automatic peer discovery
 * - Multi-peer mesh network
 * - Message chunking for large updates
 *
 * @example
 * ```ts
 * import * as Y from 'yjs'
 * import { GenericProvider } from 'y-generic'
 * import { WebBluetoothTransport } from 'y-generic/providers/webbluetooth'
 *
 * const doc = new Y.Doc()
 * const transport = new WebBluetoothTransport()
 *
 * const provider = new GenericProvider(doc, transport)
 * await provider.connect({
 *   room: 'my-collab-room'
 * })
 * ```
 */
export class WebBluetoothTransport {
    constructor() {
        this.config = null;
        this._isConnected = false;
        this.debug = false;
        this.peers = new Map();
        this.scanning = false;
        this.intentionalDisconnect = false;
    }
    get isConnected() {
        return this._isConnected;
    }
    /**
     * Connect and start discovering Bluetooth peers
     */
    async connect(config) {
        this.config = config;
        this.debug = config.debug ?? false;
        this.intentionalDisconnect = false;
        // Check if Web Bluetooth is supported
        if (!navigator.bluetooth) {
            throw new Error('Web Bluetooth is not supported in this browser. ' +
                'Try Chrome/Edge on Android, Windows, macOS, or Linux. ' +
                'Note: iOS does not support Web Bluetooth.');
        }
        this.log('🔷 Starting WebBluetooth transport...');
        try {
            // Request to discover devices with our service
            this.log('🔍 Scanning for nearby devices...');
            await this.scanForPeers();
            this._isConnected = true;
            this.log('✅ Connected! Watching for peers...');
            // Continue scanning for new peers periodically
            if (config.autoReconnect !== false) {
                this.startPeriodicScan();
            }
        }
        catch (error) {
            this.log('❌ Connection failed:', error);
            throw error;
        }
    }
    /**
     * Scan for Bluetooth peers
     */
    async scanForPeers() {
        if (this.scanning)
            return;
        this.scanning = true;
        try {
            // Request device with our service UUID
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [SERVICE_UUID] }],
                optionalServices: [SERVICE_UUID],
            });
            this.log(`📱 Found device: ${device.name || device.id}`);
            // Connect to the device
            await this.connectToPeer(device);
        }
        catch (error) {
            // User cancelled selection or no devices found
            if (error.name === 'NotFoundError') {
                this.log('ℹ️ No devices found. Make sure other devices are visible.');
            }
            else if (error.name !== 'NotFoundError') {
                this.log('⚠️ Scan error:', error);
            }
        }
        finally {
            this.scanning = false;
        }
    }
    /**
     * Connect to a discovered peer
     */
    async connectToPeer(device) {
        const peerId = device.id;
        // Don't reconnect to already connected peers
        if (this.peers.has(peerId)) {
            this.log(`Already connected to ${device.name || peerId}`);
            return;
        }
        this.log(`🔗 Connecting to ${device.name || peerId}...`);
        try {
            // Connect to GATT server
            const server = await device.gatt.connect();
            this.log(`✅ Connected to GATT server`);
            // Get our service
            const service = await server.getPrimaryService(SERVICE_UUID);
            this.log(`✅ Got service`);
            // Get characteristics
            const txCharacteristic = await service.getCharacteristic(TX_CHARACTERISTIC_UUID);
            const rxCharacteristic = await service.getCharacteristic(RX_CHARACTERISTIC_UUID);
            this.log(`✅ Got characteristics`);
            // Setup peer
            const peer = {
                device,
                server,
                txCharacteristic,
                rxCharacteristic,
                receiveBuffer: [],
                expectedChunks: 0,
                receivedChunks: 0,
            };
            this.peers.set(peerId, peer);
            // Listen for incoming data
            await rxCharacteristic.startNotifications();
            rxCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
                this.handleIncomingData(peerId, event.target.value);
            });
            // Listen for disconnection
            device.addEventListener('gattserverdisconnected', () => {
                this.handlePeerDisconnected(peerId);
            });
            this.log(`✅ Peer ${device.name || peerId} ready!`);
        }
        catch (error) {
            this.log(`❌ Failed to connect to peer:`, error);
            this.peers.delete(peerId);
        }
    }
    /**
     * Handle incoming data from peer
     */
    handleIncomingData(peerId, dataView) {
        const peer = this.peers.get(peerId);
        if (!peer)
            return;
        // Read chunk header (first byte indicates chunk info)
        const header = dataView.getUint8(0);
        const isFirstChunk = (header & 0x80) !== 0;
        const isLastChunk = (header & 0x40) !== 0;
        const chunkIndex = header & 0x3f;
        // Read data (skip header)
        const chunkData = new Uint8Array(dataView.buffer, 1);
        if (isFirstChunk) {
            // Reset buffer for new message
            peer.receiveBuffer = [];
            peer.receivedChunks = 0;
            // Read total chunks from second byte
            peer.expectedChunks = dataView.getUint8(1);
            // Skip first 2 bytes (header + chunk count)
            const actualData = new Uint8Array(dataView.buffer, 2);
            peer.receiveBuffer.push(actualData);
            this.log(`📦 Received first chunk (${peer.expectedChunks} total expected)`);
        }
        else {
            peer.receiveBuffer.push(chunkData);
            this.log(`📦 Received chunk ${chunkIndex + 1}/${peer.expectedChunks}`);
        }
        peer.receivedChunks++;
        // Check if we have all chunks
        if (isLastChunk || peer.receivedChunks >= peer.expectedChunks) {
            // Reassemble message
            const totalLength = peer.receiveBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
            const completeMessage = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of peer.receiveBuffer) {
                completeMessage.set(chunk, offset);
                offset += chunk.length;
            }
            this.log(`📨 Received complete message: ${completeMessage.length} bytes`);
            // Pass to callback
            if (this.messageCallback) {
                this.messageCallback(completeMessage);
            }
            // Reset buffer
            peer.receiveBuffer = [];
            peer.receivedChunks = 0;
            peer.expectedChunks = 0;
        }
    }
    /**
     * Handle peer disconnection
     */
    handlePeerDisconnected(peerId) {
        const peer = this.peers.get(peerId);
        if (!peer)
            return;
        this.log(`📵 Peer disconnected: ${peer.device.name || peerId}`);
        this.peers.delete(peerId);
        // Try to reconnect if auto-reconnect is enabled
        if (this.config?.autoReconnect !== false && !this.intentionalDisconnect) {
            this.log(`🔄 Will attempt to reconnect...`);
        }
    }
    /**
     * Start periodic scanning for new peers
     */
    startPeriodicScan() {
        // Scan every 30 seconds for new peers
        setInterval(() => {
            if (!this.intentionalDisconnect && this._isConnected) {
                this.log('🔍 Scanning for new peers...');
                // Note: We can't auto-scan, user must click "Add Peer" button
            }
        }, 30000);
    }
    /**
     * Disconnect from all peers
     */
    async disconnect() {
        this.log('📴 Disconnecting from all peers...');
        this.intentionalDisconnect = true;
        this._isConnected = false;
        for (const [peerId, peer] of this.peers) {
            try {
                await peer.server?.disconnect();
                this.log(`Disconnected from ${peer.device.name || peerId}`);
            }
            catch (error) {
                this.log(`Error disconnecting from peer:`, error);
            }
        }
        this.peers.clear();
    }
    /**
     * Send data to all connected peers
     */
    send(data) {
        if (!this._isConnected || this.peers.size === 0) {
            this.log('⚠️ No peers connected, cannot send');
            return;
        }
        // Send to all connected peers
        for (const [peerId, peer] of this.peers) {
            this.sendToPeer(peer, data).catch((error) => {
                this.log(`❌ Failed to send to ${peer.device.name || peerId}:`, error);
            });
        }
    }
    /**
     * Send data to a specific peer (with chunking)
     */
    async sendToPeer(peer, data) {
        if (!peer.txCharacteristic) {
            throw new Error('TX characteristic not available');
        }
        // Calculate chunks needed (account for header bytes)
        const dataSize = data.length;
        const chunkPayloadSize = MAX_CHUNK_SIZE - 2; // Reserve 2 bytes for header
        const numChunks = Math.ceil(dataSize / chunkPayloadSize);
        this.log(`📤 Sending ${dataSize} bytes in ${numChunks} chunks`);
        for (let i = 0; i < numChunks; i++) {
            const isFirst = i === 0;
            const isLast = i === numChunks - 1;
            // Calculate chunk data range
            const start = i * chunkPayloadSize;
            const end = Math.min(start + chunkPayloadSize, dataSize);
            const chunkData = data.slice(start, end);
            // Build header byte
            let header = i & 0x3f; // Chunk index (6 bits)
            if (isFirst)
                header |= 0x80; // Set first chunk bit
            if (isLast)
                header |= 0x40; // Set last chunk bit
            // Build packet
            let packet;
            if (isFirst) {
                // First chunk includes total chunk count
                packet = new Uint8Array(chunkData.length + 2);
                packet[0] = header;
                packet[1] = numChunks;
                packet.set(chunkData, 2);
            }
            else {
                packet = new Uint8Array(chunkData.length + 1);
                packet[0] = header;
                packet.set(chunkData, 1);
            }
            // Send chunk
            await peer.txCharacteristic.writeValue(packet.buffer);
            this.log(`✉️ Sent chunk ${i + 1}/${numChunks}`);
            // Small delay between chunks to avoid overwhelming BLE
            if (!isLast) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        this.log(`✅ Sent complete message to ${peer.device.name || peer.device.id}`);
    }
    /**
     * Register message callback
     */
    onMessage(callback) {
        this.messageCallback = callback;
        return () => {
            this.messageCallback = undefined;
        };
    }
    /**
     * Manually trigger peer discovery
     * (must be called from user gesture due to browser security)
     */
    async discoverPeers() {
        await this.scanForPeers();
    }
    /**
     * Get list of connected peers
     */
    getConnectedPeers() {
        return Array.from(this.peers.values()).map((peer) => ({
            id: peer.device.id,
            name: peer.device.name,
        }));
    }
    /**
     * Log debug messages
     */
    log(...args) {
        if (this.debug) {
            console.log('[WebBluetoothTransport]', ...args);
        }
    }
}
//# sourceMappingURL=index.js.map