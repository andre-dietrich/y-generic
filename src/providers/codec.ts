/**
 * Byte helpers shared by the providers whose backend moves text, or speaks
 * plain Yjs without GenericProvider's frame header (WebSocket to a
 * y-websocket server, Ably, PubNub, Supabase, Nostr, Gun). GenericProvider
 * wraps every frame as [CRC32 (4 bytes, big-endian)][message] and expects the
 * same from onMessage().
 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

/** Add a valid CRC32 header so GenericProvider accepts the message. */
export function addCRC32Header(data: Uint8Array): Uint8Array {
  const wrapped = new Uint8Array(4 + data.length)
  new DataView(wrapped.buffer).setUint32(0, crc32(data))
  wrapped.set(data, 4)
  return wrapped
}

/** Strip the 4-byte CRC32 header GenericProvider prepends. */
export function stripCRC32Header(data: Uint8Array): Uint8Array {
  return data.length >= 4 ? data.subarray(4) : data
}

/** Base64 without Buffer; 8 KiB at a time (String.fromCharCode's argument limit). */
export function toBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i += 8192) {
    binary += String.fromCharCode(...data.subarray(i, i + 8192))
  }
  return btoa(binary)
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * The first 16 hex chars of the password's SHA-256: appended to a room or
 * channel name so only peers that know the password meet there. Obfuscation,
 * not encryption. crypto.subtle needs a secure context (https or localhost).
 */
export async function hashPassword(password: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password))
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16)
}
