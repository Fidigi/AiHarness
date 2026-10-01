import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AiProxyServer } from './proxy.js';
import { authenticateUpgrade } from '../security/request-security.js';

export function encodeWebSocketFrame(payload: string, opcode = 0x1): Buffer {
  const content = Buffer.from(payload);
  let header: Buffer;
  if (content.length < 126) {
    header = Buffer.from([0x80 | opcode, content.length]);
  } else if (content.length <= 0xffff) {
    header = Buffer.from([0x80 | opcode, 126, content.length >> 8, content.length & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(content.length), 2);
  }
  return Buffer.concat([header, content]);
}

export function decodeWebSocketFrame(frame: Buffer): { payload: string; opcode: number; bytes: number } | null {
  if (frame.length < 2) return null;
  const opcode = frame[0] & 0x0f;
  const masked = Boolean(frame[1] & 0x80);
  let length = frame[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (frame.length < 4) return null;
    length = frame.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (frame.length < 10) return null;
    const value = Number(frame.readBigUInt64BE(2));
    if (!Number.isSafeInteger(value)) return null;
    length = value;
    offset = 10;
  }
  let mask: Buffer | undefined;
  if (masked) {
    if (frame.length < offset + 4) return null;
    mask = frame.subarray(offset, offset + 4);
    offset += 4;
  }
  if (frame.length < offset + length) return null;
  const payload = Buffer.from(frame.subarray(offset, offset + length));
  if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
  return { payload: payload.toString('utf8'), opcode, bytes: offset + length };
}

/** Minimal RFC 6455 transport for JSON chat requests and SSE-compatible event frames. */
export function handleWebSocketUpgrade(request: IncomingMessage, socket: Duplex, proxy: AiProxyServer): void {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/api/chat/ws') {
    socket.destroy();
    return;
  }
  if (!authenticateUpgrade(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  const requestedProtocols = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',').map(value => value.trim());
  const authProtocol = requestedProtocols.find(value => value.startsWith('aih.bearer.'));
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    ...(authProtocol ? [`Sec-WebSocket-Protocol: ${authProtocol}`] : []),
    '\r\n',
  ].join('\r\n'));

  let pending = Buffer.alloc(0);
  let running = false;
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    if (pending.length > 10 * 1024 * 1024) {
      socket.end(encodeWebSocketFrame('Message too large', 0x8));
      return;
    }
    while (!running) {
      const decoded = decodeWebSocketFrame(pending);
      if (!decoded) return;
      pending = pending.subarray(decoded.bytes);
      if (decoded.opcode === 0x8) {
        socket.end(encodeWebSocketFrame('', 0x8));
        return;
      }
      if (decoded.opcode === 0x9) {
        socket.write(encodeWebSocketFrame(decoded.payload, 0xa));
        continue;
      }
      if (decoded.opcode !== 0x1) continue;
      running = true;
      void (async () => {
        try {
          const input = JSON.parse(decoded.payload) as {
            provider?: string;
            messages?: Array<{ role: string; content: string }>;
            options?: Record<string, unknown>;
          };
          if (!input.provider || !Array.isArray(input.messages)) throw new Error('provider et messages sont requis');
          const result = await proxy.sendChatSSE(input.provider, input.messages as any[], input.options);
          const reader = result.stream.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            socket.write(encodeWebSocketFrame(decoder.decode(item.value)));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          socket.write(encodeWebSocketFrame(`event: error\ndata: ${JSON.stringify({ message })}\n`));
        } finally {
          running = false;
          socket.end(encodeWebSocketFrame('', 0x8));
        }
      })();
    }
  });
}
