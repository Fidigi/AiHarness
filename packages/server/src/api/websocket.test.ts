import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';
import { AiProxyServer } from './proxy.js';

let root: string | undefined;
afterEach(async () => {
  await stop();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('rejects retired HTTP and WebSocket chat without dispatch, retaining authentication and Origin checks', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-retired-chat-'));
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'synthetic-user');
  vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'synthetic-admin');
  const proxy = new AiProxyServer({ enableMockProvider: true });
  const chat = vi.spyOn(proxy, 'sendChat');
  const stream = vi.spyOn(proxy, 'sendChatSSE');
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'),
    allowedRoots: [root], defaultCwd: root, proxy });
  const base = `http://127.0.0.1:${server.port}`;
  for (const route of ['/api/chat', '/api/chat/stream', '/api/chat/compact']) {
    const body = JSON.stringify({ provider: 'mock', messages: [{ role: 'user', content: 'must-not-run' }] });
    const rejected = await fetch(base + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-user' }, body });
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toEqual({ error: 'Not found' });
    expect((await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(401);
  }
  expect((await fetch(base + '/api/chat', { method: 'POST', headers: {
    Authorization: 'Bearer synthetic-admin', Origin: 'https://foreign.invalid',
  } })).status).toBe(403);

  const upgrade = (authorization: boolean) => new Promise<string>((resolve, reject) => {
    const socket = connect(server.port, '127.0.0.1');
    let response = '';
    socket.on('connect', () => socket.write('GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\n'
      + 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      + 'Sec-WebSocket-Protocol: aih.v1, aih.bearer.private-marker\r\n'
      + (authorization ? 'Authorization: Bearer synthetic-user\r\n' : '') + '\r\n'));
    socket.on('data', chunk => {
      response += chunk.toString();
      if (response.includes('\r\n\r\n')) { socket.destroy(); resolve(response); }
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
  expect(await upgrade(true)).toMatch(/^HTTP\/1\.1 404 /);
  const unauthorized = await upgrade(false);
  expect(unauthorized).toMatch(/^HTTP\/1\.1 401 /);
  expect(unauthorized).not.toContain('private-marker');
  expect(chat).not.toHaveBeenCalled();
  expect(stream).not.toHaveBeenCalled();
});
