import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProviderWebSocket,
  closeProviderNetworkDispatchers,
} from './provider-network.js';
import {
  OpenAiResponsesProvider,
  getOpenAiResponsesTransportStats,
  resetOpenAiResponsesTransportStats,
} from './index.js';
import type { Message, ProviderConfig } from '../types/index.js';

function serverFrame(payload: unknown): Buffer {
  const content = Buffer.from(JSON.stringify(payload));
  if (content.length < 126) return Buffer.concat([Buffer.from([0x81, content.length]), content]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(content.length, 2);
  return Buffer.concat([header, content]);
}

function decodeClientFrame(source: Buffer): { payload: string; bytes: number; opcode: number } | undefined {
  if (source.length < 2) return undefined;
  const opcode = source[0]! & 0x0f;
  let length = source[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (source.length < 4) return undefined;
    length = source.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (source.length < 10) return undefined;
    length = Number(source.readBigUInt64BE(2));
    offset = 10;
  }
  const masked = Boolean(source[1]! & 0x80);
  if (!masked || source.length < offset + 4 + length) return undefined;
  const mask = source.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(source.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]!;
  return { payload: payload.toString('utf8'), bytes: offset + length, opcode };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the WebSocket condition.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function message(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: new Date() };
}

afterEach(async () => {
  resetOpenAiResponsesTransportStats();
  await closeProviderNetworkDispatchers();
});

describe('OpenAI Responses real WebSocket transport', () => {
  it('handshakes with an RFC 6455 server, reuses the session socket, and sends a continuation delta', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(500).end();
    });
    server.on('upgrade', (request, socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const key = String(request.headers['sec-websocket-key']);
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'));
      let pending = Buffer.alloc(0);
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        while (true) {
          const frame = decodeClientFrame(pending);
          if (!frame) break;
          pending = pending.subarray(frame.bytes);
          if (frame.opcode === 0x8) {
            socket.write(Buffer.from([0x88, 0x00]));
            socket.end();
            continue;
          }
          const body = JSON.parse(frame.payload) as Record<string, unknown>;
          requests.push(body);
          const sequence = requests.length;
          socket.write(serverFrame({ type: 'response.created', response: { id: `response-${sequence}` } }));
          if (sequence === 3) continue; // Exercise a started response that becomes idle.
          socket.write(serverFrame({ type: 'response.output_text.delta', delta: `answer-${sequence}` }));
          socket.write(serverFrame({
            type: 'response.completed',
            response: { id: `response-${sequence}`, model: 'gpt-test', usage: { input_tokens: 2, output_tokens: 1 } },
          }));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind.');

    const provider = new OpenAiResponsesProvider({
      type: 'openai' as ProviderConfig['type'],
      apiKey: 'test-key',
      model: 'gpt-test',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      transport: 'websocket-cached',
      websocketConnectTimeoutMs: 2_000,
      requestTimeoutMs: 5_000,
      httpIdleTimeoutMs: 50,
    });
    try {
      await expect(provider.chat([message('u1', 'user', 'hello')], { sessionId: 'real-session' }))
        .resolves.toMatchObject({ content: 'answer-1' });
      await expect(provider.chat([
        message('u1', 'user', 'hello'),
        message('a1', 'assistant', 'answer-1'),
        message('u2', 'user', 'again'),
      ], { sessionId: 'real-session' })).resolves.toMatchObject({ content: 'answer-2' });

      expect(sockets.size).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ type: 'response.create' });
      expect(requests[1]).toMatchObject({
        type: 'response.create',
        previous_response_id: 'response-1',
        input: [{ role: 'user', content: 'again' }],
      });
      expect(getOpenAiResponsesTransportStats('real-session')).toMatchObject({
        websocketConnectionsCreated: 1,
        websocketConnectionsReused: 1,
        fullContextRequests: 1,
        deltaRequests: 1,
      });
      await expect(provider.chat([
        message('u1', 'user', 'hello'),
        message('a1', 'assistant', 'answer-1'),
        message('u3', 'user', 'stall now'),
      ], { sessionId: 'real-session' })).rejects.toThrow(
        'The provider WebSocket response was idle for too long.',
      );
    } finally {
      await closeProviderNetworkDispatchers();
      await waitForCondition(() => sockets.size === 0);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('performs a real WebSocket upgrade through the configured CONNECT proxy', async () => {
    const targetSockets = new Set<Socket>();
    const target = createServer();
    target.on('upgrade', (request, socket) => {
      targetSockets.add(socket);
      socket.once('close', () => targetSockets.delete(socket));
      const key = String(request.headers['sec-websocket-key']);
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'));
      let pending = Buffer.alloc(0);
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        const frame = decodeClientFrame(pending);
        if (frame?.opcode === 0x8) {
          socket.write(Buffer.from([0x88, 0x00]));
          socket.end();
        }
      });
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('Target did not bind.');

    let connectRequests = 0;
    const proxySockets = new Set<Socket>();
    const proxy = createServer();
    proxy.on('connect', (request, client, head) => {
      connectRequests += 1;
      const [host, port] = String(request.url).split(':');
      const upstream = createConnection(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      proxySockets.add(client);
      proxySockets.add(upstream);
      client.once('close', () => proxySockets.delete(client));
      upstream.once('close', () => proxySockets.delete(upstream));
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Proxy did not bind.');

    try {
      const lease = await acquireProviderWebSocket(
        `ws://127.0.0.1:${targetAddress.port}/responses`,
        { Authorization: 'Bearer test-key' },
        {
          transport: 'websocket',
          httpProxy: `http://127.0.0.1:${proxyAddress.port}`,
          httpIdleTimeoutMs: 2_000,
          websocketConnectTimeoutMs: 2_000,
          requestTimeoutMs: 5_000,
          maxRetries: 0,
          maxRetryDelayMs: 1_000,
        },
      );
      expect(lease.socket.readyState).toBe(1);
      expect(connectRequests).toBe(1);
      lease.release({ keep: false });
      await waitForCondition(() => targetSockets.size === 0);
    } finally {
      await closeProviderNetworkDispatchers();
      for (const socket of [...targetSockets, ...proxySockets]) socket.destroy();
      await Promise.all([
        new Promise<void>(resolve => target.close(() => resolve())),
        new Promise<void>(resolve => proxy.close(() => resolve())),
      ]);
    }
  });
});
