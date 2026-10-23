/**
 * Byte helpers shared by the providers whose backend moves text, or speaks
 * plain Yjs without GenericProvider's frame header (WebSocket to a
 * y-websocket server, Ably, PubNub, Supabase, Nostr, Gun). GenericProvider
 * wraps every frame as [CRC32 (4 bytes, big-endian)][message] and expects the
 * same from onMessage().
 */
export declare function crc32(data: Uint8Array): number;
/** Add a valid CRC32 header so GenericProvider accepts the message. */
export declare function addCRC32Header(data: Uint8Array): Uint8Array;
/** Strip the 4-byte CRC32 header GenericProvider prepends. */
export declare function stripCRC32Header(data: Uint8Array): Uint8Array;
/** Base64 without Buffer; 8 KiB at a time (String.fromCharCode's argument limit). */
export declare function toBase64(data: Uint8Array): string;
export declare function fromBase64(base64: string): Uint8Array;
/**
 * The first 16 hex chars of the password's SHA-256: appended to a room or
 * channel name so only peers that know the password meet there. Obfuscation,
 * not encryption. crypto.subtle needs a secure context (https or localhost).
 */
export declare function hashPassword(password: string): Promise<string>;
//# sourceMappingURL=codec.d.ts.map