import { describe, expect, it } from 'vitest';
import { decodeWebSocketFrame, encodeWebSocketFrame } from './websocket';

function maskedFrame(payload: string): Buffer {
  const content = Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = content.length < 126
    ? Buffer.from([0x81, 0x80 | content.length])
    : Buffer.from([0x81, 0x80 | 126, content.length >> 8, content.length & 0xff]);
  const masked = Buffer.from(content.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, masked]);
}

describe('transport WebSocket', () => {
  it('encode les frames serveur RFC 6455', () => {
    const decoded = decodeWebSocketFrame(encodeWebSocketFrame('bonjour'));
    expect(decoded).toMatchObject({ payload: 'bonjour', opcode: 1 });
  });

  it('décode les frames clientes masquées et fragmentées au niveau TCP', () => {
    const frame = maskedFrame(JSON.stringify({ provider: 'mock', messages: [] }));
    expect(decodeWebSocketFrame(frame.subarray(0, 3))).toBeNull();
    expect(decodeWebSocketFrame(frame)?.payload).toContain('"provider":"mock"');
  });

  it('gère les payloads étendus', () => {
    const payload = 'x'.repeat(70_000);
    expect(decodeWebSocketFrame(encodeWebSocketFrame(payload))?.payload).toBe(payload);
  });
});
