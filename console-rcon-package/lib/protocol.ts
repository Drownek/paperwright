/**
 * Wire format for the Source RCON protocol (used unmodified by vanilla/Paper/Spigot):
 * a 4-byte little-endian length prefix, a 4-byte request id, a 4-byte packet type, the
 * payload as a null-terminated string, and one extra trailing null byte.
 */
export const PacketType = {
    RESPONSE_VALUE: 0,
    EXECCOMMAND: 2,
    AUTH_RESPONSE: 2,
    AUTH: 3,
} as const;

export interface DecodedPacket {
    id: number;
    type: number;
    payload: string;
}

export function encodePacket(id: number, type: number, payload: string): Buffer {
    const payloadBuf = Buffer.from(payload, 'utf8');
    const bodySize = 4 + 4 + payloadBuf.length + 2; // id + type + payload + 2 null terminators
    const buf = Buffer.alloc(4 + bodySize);
    let offset = 0;
    buf.writeInt32LE(bodySize, offset); offset += 4;
    buf.writeInt32LE(id, offset); offset += 4;
    buf.writeInt32LE(type, offset); offset += 4;
    payloadBuf.copy(buf, offset); offset += payloadBuf.length;
    buf.writeUInt8(0, offset); offset += 1;
    buf.writeUInt8(0, offset);
    return buf;
}

/** Decodes one packet body — everything after the 4-byte length prefix a caller already
 *  stripped off while reassembling the stream. */
export function decodePacketBody(body: Buffer): DecodedPacket {
    const id = body.readInt32LE(0);
    const type = body.readInt32LE(4);
    const payload = body.toString('utf8', 8, body.length - 2);
    return { id, type, payload };
}
