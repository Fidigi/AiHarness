import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { decodeWebSocketFrame, encodeWebSocketFrame, handleWebSocketUpgrade } from './websocket';
import { createWebSession } from '../security/request-security';

function maskedFrame(payload: string): Buffer {
  const content = Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = content.length < 126
    ? Buffer.from([0x81, 0x80 | content.length])
    : Buffer.from([0x81, 0x80 | 126, content.length >> 8, content.length & 0xff]);
  const masked = Buffer.from(content.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, masked]);
}

function captureSocket(): { socket: Duplex; output: string[] } {
  const output: string[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      output.push(Buffer.from(chunk).toString());
      callback();
    },
  });
  return { socket, output };
}

describe('transport WebSocket', () => {
  afterEach(() => vi.unstubAllEnvs());

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

  it('protège aussi les upgrades quand seul le jeton administrateur est configuré', () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', '');
    vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin-secret');
    const { socket, output } = captureSocket();
    const request = {
      url: '/api/chat/ws',
      headers: { host: 'localhost', 'sec-websocket-key': 'test-key' },
    } as IncomingMessage;

    handleWebSocketUpgrade(request, socket, {} as never);

    expect(output.join('')).toContain('401 Unauthorized');
    expect(socket.destroyed).toBe(true);
  });

  it('accepte le cookie opaque de la session Web', () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-secret');
    const session = createWebSession('user-secret')!;
    const { socket, output } = captureSocket();
    const request = {
      url: '/api/chat/ws',
      headers: { host: 'localhost', cookie: `aih_session=${session.token}`, 'sec-websocket-key': 'test-key' },
    } as IncomingMessage;

    handleWebSocketUpgrade(request, socket, {} as never);

    expect(output.join('')).toContain('101 Switching Protocols');
    socket.destroy();
  });

  it('accepte le jeton administrateur comme les routes HTTP', () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-secret');
    vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin-secret');
    const { socket, output } = captureSocket();
    const request = {
      url: '/api/chat/ws?token=admin-secret',
      headers: { host: 'localhost', 'sec-websocket-key': 'test-key' },
    } as IncomingMessage;

    handleWebSocketUpgrade(request, socket, {} as never);

    expect(output.join('')).toContain('101 Switching Protocols');
    socket.destroy();
  });
});
