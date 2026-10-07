import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { sanitizedProxyChatOptions, type AiProxyServer } from './proxy.js';
import { authenticateUpgrade, isAllowedOrigin } from '../security/request-security.js';

const MAX_SERVER_WEBSOCKETS = 256;
const MAX_CLIENT_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_SERVER_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_SERVER_STREAM_BYTES = 64 * 1024 * 1024;
const WEBSOCKET_DRAIN_TIMEOUT_MS = 30_000;
const WEBSOCKET_PROVIDER_IDLE_TIMEOUT_MS = 120_000;
const activeSockets = new Set<Duplex>();

function requestedProtocols(value: string | string[] | undefined): { valid: boolean; application: boolean } {
  const source = Array.isArray(value) ? value.join(',') : value ?? '';
  if (!source) return { valid: true, application: false };
  if (source.length > 16 * 1024) return { valid: false, application: false };
  const protocols = source.split(',').map(protocol => protocol.trim());
  const unique = new Set(protocols);
  const valid = protocols.length <= 128 && unique.size === protocols.length
    && protocols.every(protocol => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(protocol));
  return { valid, application: valid && unique.has('aih.v1') };
}

function validWebSocketKey(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4}){5}[A-Za-z0-9+/]{2}==$/u.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === 16 && bytes.toString('base64') === value;
  } catch { return false; }
}

function validChatInput(value: unknown): value is {
  provider: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  options?: Record<string, unknown>;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as { provider?: unknown; messages?: unknown; options?: unknown };
  if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/u.test(input.provider)
    || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 10_000
    || (input.options !== undefined && (!input.options || typeof input.options !== 'object'
      || Array.isArray(input.options)))) return false;
  let bytes = 0;
  for (const message of input.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    const candidate = message as { role?: unknown; content?: unknown };
    if (typeof candidate.role !== 'string'
      || !['system', 'user', 'assistant', 'tool'].includes(candidate.role)
      || typeof candidate.content !== 'string') return false;
    const contentBytes = Buffer.byteLength(candidate.content);
    if (contentBytes > 4 * 1024 * 1024) return false;
    bytes += contentBytes;
    if (bytes > 8 * 1024 * 1024) return false;
  }
  return true;
}

export function encodeWebSocketFrame(payload: string | Uint8Array, opcode = 0x1): Buffer {
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

export function decodeWebSocketFrame(frame: Buffer): {
  payload: string;
  payloadBytes: Buffer;
  opcode: number;
  bytes: number;
  masked: boolean;
  final: boolean;
  validUtf8: boolean;
  validLength: boolean;
  reserved: boolean;
} | null {
  if (frame.length < 2) return null;
  const opcode = frame[0] & 0x0f;
  const final = Boolean(frame[0] & 0x80);
  const masked = Boolean(frame[1] & 0x80);
  let length = frame[1] & 0x7f;
  let offset = 2;
  let validLength = true;
  if (length === 126) {
    if (frame.length < 4) return null;
    length = frame.readUInt16BE(2);
    validLength = length >= 126;
    offset = 4;
  } else if (length === 127) {
    if (frame.length < 10) return null;
    const extended = frame.readBigUInt64BE(2);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    length = Number(extended);
    validLength = length > 0xffff;
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
  const textPayload = opcode === 0x1 || opcode === 0x8;
  try {
    const text = opcode === 0x8 && payload.length >= 2 ? payload.subarray(2) : payload;
    return {
      payload: textPayload ? new TextDecoder('utf-8', { fatal: true }).decode(text) : '',
      payloadBytes: payload,
      opcode,
      bytes: offset + length,
      masked,
      final,
      validUtf8: true,
      validLength,
      reserved: Boolean(frame[0] & 0x70),
    };
  } catch {
    return {
      payload: '', payloadBytes: payload, opcode, bytes: offset + length, masked, final, validUtf8: false,
      validLength, reserved: Boolean(frame[0] & 0x70),
    };
  }
}

function validCloseCode(code: number): boolean {
  return (code >= 1_000 && code <= 1_014 && ![1_004, 1_005, 1_006].includes(code))
    || (code >= 3_000 && code <= 4_999);
}

function closeFrame(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason);
  const boundedReason = reasonBytes.subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + boundedReason.length);
  payload.writeUInt16BE(code, 0);
  boundedReason.copy(payload, 2);
  return encodeWebSocketFrame(payload, 0x8);
}

/** Abort and remove every upgraded connection owned by this Server process. */
export function closeServerWebSockets(): void {
  for (const socket of activeSockets) socket.destroy();
  activeSockets.clear();
}

/** Minimal RFC 6455 transport for JSON chat requests and SSE-compatible event frames. */
export function handleWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  proxy: AiProxyServer,
  initialData: Uint8Array = new Uint8Array(),
): void {
  socket.once('error', () => socket.destroy());
  let url: URL;
  try { url = new URL(request.url || '/', 'http://localhost'); }
  catch { socket.destroy(); return; }
  const upgrade = request.headers.upgrade;
  const connection = request.headers.connection;
  if (url.pathname !== '/api/chat/ws' || request.method !== 'GET'
    || typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket'
    || typeof connection !== 'string'
    || !connection.split(',').some(value => value.trim().toLowerCase() === 'upgrade')
    || request.headers['sec-websocket-version'] !== '13') {
    socket.destroy();
    return;
  }
  if (!isAllowedOrigin(request as unknown as import('express').Request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!authenticateUpgrade(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = request.headers['sec-websocket-key'];
  const protocols = requestedProtocols(request.headers['sec-websocket-protocol']);
  if (typeof key !== 'string' || !validWebSocketKey(key) || !protocols.valid) {
    socket.destroy();
    return;
  }
  for (const active of activeSockets) if (active.destroyed) activeSockets.delete(active);
  if (activeSockets.size >= MAX_SERVER_WEBSOCKETS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  activeSockets.add(socket);
  socket.once('close', () => activeSockets.delete(socket));
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    ...(protocols.application ? ['Sec-WebSocket-Protocol: aih.v1'] : []),
    '\r\n',
  ].join('\r\n'));

  let pending = Buffer.alloc(0);
  let running = false;
  let ended = false;
  let abortRunning: (() => void) | undefined;
  const idleTimer = setTimeout(() => {
    ended = true;
    socket.end(closeFrame(1_008, 'Request timeout'));
  }, 30_000);
  idleTimer.unref?.();
  socket.once('close', () => clearTimeout(idleTimer));
  const receive = (chunk: Uint8Array): void => {
    if (ended) return;
    const incoming = Buffer.from(chunk);
    if (pending.length + incoming.length > MAX_CLIENT_FRAME_BYTES) {
      ended = true;
      abortRunning?.();
      socket.end(closeFrame(1_009, 'Message too large'));
      return;
    }
    pending = pending.length ? Buffer.concat([pending, incoming]) : incoming;
    while (!ended) {
      const decoded = decodeWebSocketFrame(pending);
      if (!decoded) return;
      pending = pending.subarray(decoded.bytes);
      const control = decoded.opcode >= 0x8;
      const supportedOpcode = [0x1, 0x8, 0x9, 0xa].includes(decoded.opcode);
      const closeCode = decoded.opcode === 0x8 && decoded.payloadBytes.length >= 2
        ? decoded.payloadBytes.readUInt16BE(0) : undefined;
      if (!decoded.masked || decoded.reserved || !decoded.validUtf8 || !decoded.validLength
        || !supportedOpcode || !decoded.final || (control && decoded.payloadBytes.length > 125)
        || (decoded.opcode === 0x8 && (decoded.payloadBytes.length === 1
          || (closeCode !== undefined && !validCloseCode(closeCode))))) {
        ended = true;
        abortRunning?.();
        socket.end(closeFrame(1_002, 'Invalid frame'));
        return;
      }
      if (decoded.opcode === 0x8) {
        ended = true;
        abortRunning?.();
        socket.end(decoded.payloadBytes.length
          ? encodeWebSocketFrame(decoded.payloadBytes, 0x8)
          : closeFrame(1_000, ''));
        return;
      }
      if (decoded.opcode === 0x9) {
        socket.write(encodeWebSocketFrame(decoded.payloadBytes, 0xa));
        continue;
      }
      if (decoded.opcode === 0xa) continue;
      if (decoded.opcode !== 0x1 || running) {
        ended = true;
        abortRunning?.();
        socket.end(closeFrame(1_003, 'Unsupported frame'));
        return;
      }
      clearTimeout(idleTimer);
      running = true;
      void (async () => {
        const controller = new AbortController();
        let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const abortRequest = (): void => {
          controller.abort('client-disconnected');
          void responseReader?.cancel().catch(() => undefined);
        };
        abortRunning = abortRequest;
        socket.once('close', abortRequest);
        const responseDecoder = new TextDecoder('utf-8', { fatal: true });
        const responseRedactor = proxy.getCredentialRedactor().createStream();
        let responseFlushed = false;
        let writtenBytes = 0;
        const writeFrame = async (payload: string): Promise<void> => {
          if (!payload || socket.destroyed || ended) return;
          const payloadBytes = Buffer.byteLength(payload);
          if (payloadBytes > MAX_SERVER_FRAME_BYTES || writtenBytes + payloadBytes > MAX_SERVER_STREAM_BYTES) {
            throw new Error('Provider stream event exceeded its output limit.');
          }
          writtenBytes += payloadBytes;
          if (socket.write(encodeWebSocketFrame(payload))) return;
          await new Promise<void>(resolve => {
            const done = (): void => {
              clearTimeout(timer);
              socket.off('drain', done);
              socket.off('close', disconnected);
              resolve();
            };
            const disconnected = (): void => done();
            const timer = setTimeout(() => {
              controller.abort('socket-backpressure-timeout');
              try { socket.destroy(); } catch { /* Socket already closed. */ }
              done();
            }, WEBSOCKET_DRAIN_TIMEOUT_MS);
            timer.unref?.();
            socket.once('drain', done);
            socket.once('close', disconnected);
          });
        };
        const sendSafeResponse = async (value: string, final = false): Promise<void> => {
          const safe = responseRedactor.push(value) + (final ? responseRedactor.flush() : '');
          await writeFrame(safe);
          if (final) responseFlushed = true;
        };
        try {
          const parsed: unknown = JSON.parse(decoded.payload);
          if (!validChatInput(parsed)) throw new Error('invalid-request');
          const safeOptions = sanitizedProxyChatOptions(parsed.options);
          if (parsed.options !== undefined && safeOptions === null) throw new Error('invalid-request');
          const messages = parsed.messages.map((message, index) => ({
            ...message,
            id: `websocket-${index}`,
            timestamp: new Date(),
          }));
          const result = await proxy.sendChatSSE(parsed.provider, messages, {
            ...(safeOptions ?? {}),
            signal: controller.signal,
          });
          const reader = result.stream.getReader();
          responseReader = reader;
          if (controller.signal.aborted) void reader.cancel().catch(() => undefined);
          const abortedResult = Symbol('aborted');
          let readerCompleted = false;
          const readProviderItem = async (): Promise<Awaited<ReturnType<typeof reader.read>> | typeof abortedResult> => {
            if (controller.signal.aborted) return abortedResult;
            let timer: NodeJS.Timeout | undefined;
            let onAbort!: () => void;
            const aborted = new Promise<typeof abortedResult>(resolve => {
              onAbort = () => resolve(abortedResult);
              controller.signal.addEventListener('abort', onAbort, { once: true });
            });
            const deadline = new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Provider stream was idle for too long.')),
                WEBSOCKET_PROVIDER_IDLE_TIMEOUT_MS);
              timer.unref?.();
            });
            try { return await Promise.race([reader.read(), aborted, deadline]); }
            finally {
              if (timer) clearTimeout(timer);
              controller.signal.removeEventListener('abort', onAbort);
            }
          };
          try {
            while (!controller.signal.aborted) {
              const item = await readProviderItem();
              if (item === abortedResult) break;
              if (item.done) { readerCompleted = true; break; }
              await sendSafeResponse(responseDecoder.decode(item.value, { stream: true }));
            }
          } finally {
            if (!readerCompleted) void reader.cancel().catch(() => undefined);
            responseReader = undefined;
            try { reader.releaseLock(); } catch { /* Cancellation may still be settling. */ }
          }
          await sendSafeResponse(responseDecoder.decode(), true);
        } catch {
          if (!controller.signal.aborted) {
            let suffix = '';
            try { suffix = responseDecoder.decode(); } catch { /* Invalid provider UTF-8 fails closed. */ }
            try {
              await sendSafeResponse(`${suffix}event: error\ndata: ${JSON.stringify({ message: 'Provider request failed.' })}\n\n`, true);
            } catch { controller.abort('socket-write-failed'); }
          }
        } finally {
          if (!responseFlushed) await sendSafeResponse('', true).catch(() => undefined);
          socket.off('close', abortRequest);
          abortRunning = undefined;
          running = false;
          ended = true;
          if (!socket.destroyed) {
            try { socket.end(closeFrame(1_000, '')); }
            catch { socket.destroy(); }
          }
        }
      })();
    }
  };
  socket.on('data', receive);
  if (initialData.byteLength) receive(initialData);
}
