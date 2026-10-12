import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialRedactor } from '@ai-harness/core';
import type { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import {
  closeServerWebSockets,
  decodeWebSocketFrame,
  encodeWebSocketFrame,
  handleWebSocketUpgrade,
} from './websocket';
import { createWebSession } from '../security/request-security';

function maskedFrame(payload: string | Uint8Array, opcode = 0x1, final = true, reserved = false): Buffer {
  const content = Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const first = (final ? 0x80 : 0) | (reserved ? 0x40 : 0) | opcode;
  const header = content.length < 126
    ? Buffer.from([first, 0x80 | content.length])
    : Buffer.from([first, 0x80 | 126, content.length >> 8, content.length & 0xff]);
  const masked = Buffer.from(content.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, masked]);
}

function upgradeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: 'localhost',
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    ...extra,
  };
}

function captureSocket(): { socket: Duplex; output: string[]; chunks: Buffer[] } {
  const output: string[] = [];
  const chunks: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      output.push(bytes.toString());
      callback();
    },
  });
  return { socket, output, chunks };
}

describe('transport WebSocket', () => {
  afterEach(() => {
    closeServerWebSockets();
    vi.unstubAllEnvs();
  });

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

  it('rejette les frames non masquées, réservées, fragmentées, non canoniques et UTF-8 invalides', async () => {
    const request = {
      method: 'GET',
      url: '/api/chat/ws',
      headers: upgradeHeaders(),
    } as IncomingMessage;
    const mask = Buffer.from([1, 2, 3, 4]);
    const nonCanonicalPayload = Buffer.from([0x78 ^ mask[0]]);
    const nonCanonical = Buffer.concat([Buffer.from([0x81, 0xfe, 0, 1]), mask, nonCanonicalPayload]);
    const cases = [
      encodeWebSocketFrame('{"provider":"mock"}'),
      maskedFrame('{}', 0x1, true, true),
      maskedFrame('{}', 0x1, false),
      nonCanonical,
      maskedFrame(Buffer.from([0xc3]), 0x1),
      maskedFrame(Buffer.from([0x00]), 0x8),
    ];

    for (const frame of cases) {
      const { socket, chunks } = captureSocket();
      handleWebSocketUpgrade(request, socket, {} as never);
      socket.push(frame);
      await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(1));
      const closed = decodeWebSocketFrame(chunks.at(-1)!);
      expect(closed?.opcode).toBe(0x8);
      expect(closed?.payloadBytes.readUInt16BE(0)).toBe(1_002);
      socket.destroy();
    }
  });

  it('répond aux pings binaires et accepte une fermeture RFC 6455 valide', async () => {
    const { socket, chunks } = captureSocket();
    const request = {
      method: 'GET', url: '/api/chat/ws', headers: upgradeHeaders(),
    } as IncomingMessage;
    handleWebSocketUpgrade(request, socket, {} as never);

    socket.push(maskedFrame(Buffer.from([0xff, 0x00]), 0x9));
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(1));
    const pong = decodeWebSocketFrame(chunks.at(-1)!);
    expect(pong).toMatchObject({ opcode: 0xa, payloadBytes: Buffer.from([0xff, 0x00]) });

    const closePayload = Buffer.alloc(2);
    closePayload.writeUInt16BE(1_000);
    socket.push(maskedFrame(closePayload, 0x8));
    await vi.waitFor(() => expect(decodeWebSocketFrame(chunks.at(-1)!)?.opcode).toBe(0x8));
    expect(decodeWebSocketFrame(chunks.at(-1)!)?.payloadBytes.readUInt16BE(0)).toBe(1_000);
    socket.destroy();
  });

  it('consomme les octets déjà lus avec la requête upgrade', async () => {
    const { socket } = captureSocket();
    const sendChatSSE = vi.fn(async () => ({
      stream: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    }));
    const proxy = { getCredentialRedactor: () => new CredentialRedactor(), sendChatSSE };
    const request = {
      method: 'GET', url: '/api/chat/ws', headers: upgradeHeaders(),
    } as IncomingMessage;
    const firstFrame = maskedFrame(JSON.stringify({
      provider: 'mock', messages: [{ role: 'user', content: 'from-head' }],
    }));

    handleWebSocketUpgrade(request, socket, proxy as never, firstFrame);

    await vi.waitFor(() => expect(sendChatSSE).toHaveBeenCalledTimes(1));
    expect(sendChatSSE.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ role: 'user', content: 'from-head', id: 'websocket-0' }),
    ]);
    socket.destroy();
  });

  it('borne le nombre de connexions upgradées actives', () => {
    const sockets: Duplex[] = [];
    const request = {
      method: 'GET', url: '/api/chat/ws', headers: upgradeHeaders(),
    } as IncomingMessage;
    for (let index = 0; index < 256; index++) {
      const target = captureSocket();
      sockets.push(target.socket);
      handleWebSocketUpgrade(request, target.socket, {} as never);
      expect(target.output.join('')).toContain('101 Switching Protocols');
    }
    const refused = captureSocket();
    handleWebSocketUpgrade(request, refused.socket, {} as never);
    expect(refused.output.join('')).toContain('503 Service Unavailable');
    for (const socket of sockets) socket.destroy();
  });

  it('protège aussi les upgrades quand seul le jeton administrateur est configuré', () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', '');
    vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin-secret');
    const { socket, output } = captureSocket();
    const request = {
      method: 'GET',
      url: '/api/chat/ws',
      headers: upgradeHeaders(),
    } as IncomingMessage;

    handleWebSocketUpgrade(request, socket, {} as never);

    expect(output.join('')).toContain('401 Unauthorized');
    expect(socket.destroyed).toBe(true);
  });

  it('authentifie le sous-protocole sans le réfléchir dans le handshake', () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-secret');
    const encoded = Buffer.from('user-secret').toString('base64url');
    const { socket, output } = captureSocket();
    const request = {
      method: 'GET',
      url: '/api/chat/ws',
      headers: upgradeHeaders({ 'sec-websocket-protocol': `aih.bearer.${encoded}` }),
    } as IncomingMessage;

    handleWebSocketUpgrade(request, socket, {} as never);

    expect(output.join('')).toContain('101 Switching Protocols');
    expect(output.join('')).not.toContain(encoded);
    expect(output.join('')).not.toContain('Sec-WebSocket-Protocol');
    socket.destroy();
  });

  it('sélectionne uniquement le protocole applicatif sûr pour les clients navigateur', () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-secret');
    const encoded = Buffer.from('user-secret').toString('base64url');
    const { socket, output } = captureSocket();
    const request = {
      method: 'GET',
      url: '/api/chat/ws',
      headers: upgradeHeaders({
        'sec-websocket-protocol': `aih.v1, aih.bearer.${encoded}`,
      }),
    } as IncomingMessage;

    handleWebSocketUpgrade(request, socket, {} as never);

    expect(output.join('')).toContain('101 Switching Protocols');
    expect(output.join('')).toContain('Sec-WebSocket-Protocol: aih.v1');
    expect(output.join('')).not.toContain(encoded);
    socket.destroy();
  });

  it('accepte le cookie opaque de la session Web', () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-secret');
    const session = createWebSession('user-secret')!;
    const { socket, output } = captureSocket();
    const request = {
      method: 'GET',
      url: '/api/chat/ws',
      headers: upgradeHeaders({ cookie: `aih_session=${session.token}` }),
    } as IncomingMessage;

    handleWebSocketUpgrade(request, socket, {} as never);

    expect(output.join('')).toContain('101 Switching Protocols');
    socket.destroy();
  });

  it('annule la requête provider lorsque le client ferme la socket', async () => {
    const { socket } = captureSocket();
    const cancelled = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const proxy = {
      getCredentialRedactor: () => new CredentialRedactor(),
      sendChatSSE: vi.fn(async (_provider: string, _messages: unknown[], options: { signal?: AbortSignal }) => {
        requestSignal = options.signal;
        return { stream: new ReadableStream<Uint8Array>({ cancel: cancelled }) };
      }),
    };
    const request = {
      method: 'GET',
      url: '/api/chat/ws',
      headers: upgradeHeaders(),
    } as IncomingMessage;

    handleWebSocketUpgrade(request, socket, proxy as never);
    socket.push(maskedFrame(JSON.stringify({
      provider: 'mock',
      messages: [{ role: 'user', content: 'hello' }],
    })));
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    socket.destroy();

    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
  });

  it('ferme les sockets upgradées et annule leur provider lors de l’arrêt du runtime', async () => {
    const { socket } = captureSocket();
    const cancelled = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const proxy = {
      getCredentialRedactor: () => new CredentialRedactor(),
      sendChatSSE: vi.fn(async (_provider: string, _messages: unknown[], options: { signal?: AbortSignal }) => {
        requestSignal = options.signal;
        return { stream: new ReadableStream<Uint8Array>({ cancel: cancelled }) };
      }),
    };
    const request = {
      method: 'GET', url: '/api/chat/ws', headers: upgradeHeaders(),
    } as IncomingMessage;
    handleWebSocketUpgrade(request, socket, proxy as never);
    socket.push(maskedFrame(JSON.stringify({
      provider: 'mock', messages: [{ role: 'user', content: 'shutdown' }],
    })));
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    closeServerWebSockets();

    expect(socket.destroyed).toBe(true);
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    expect(() => closeServerWebSockets()).not.toThrow();
  });

  it('accepte le jeton administrateur dans le sous-protocole non réfléchi', () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-secret');
    vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin-secret');
    const encoded = Buffer.from('admin-secret').toString('base64url');
    const { socket, output } = captureSocket();
    const request = {
      method: 'GET',
      url: '/api/chat/ws',
      headers: upgradeHeaders({ 'sec-websocket-protocol': `aih.bearer.${encoded}` }),
    } as IncomingMessage;

    handleWebSocketUpgrade(request, socket, {} as never);

    expect(output.join('')).toContain('101 Switching Protocols');
    expect(output.join('')).not.toContain(encoded);
    socket.destroy();
  });

  it('refuse les anciens jetons placés dans la chaîne de requête', () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-secret');
    const { socket, output } = captureSocket();
    const request = {
      method: 'GET',
      url: '/api/chat/ws?token=user-secret',
      headers: upgradeHeaders(),
    } as IncomingMessage;

    handleWebSocketUpgrade(request, socket, {} as never);

    expect(output.join('')).toContain('401 Unauthorized');
    expect(socket.destroyed).toBe(true);
  });
});
