import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockProvider } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

const latch = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('real HTTP run admission ownership', () => {
  let root: string, base: string, services: RuntimeServices;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-http-run-lifetime-'));
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, '.data'), allowedRoots: [root], defaultCwd: root,
      enableMockProvider: true, runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
    base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/workspaces/trust`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: root, confirm: true }) })).status).toBe(200);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await stop(); await rm(root, { recursive: true, force: true }); });

  for (const phase of ['trust', 'hook', 'storage'] as const) it(`withdraws disconnected ${phase} admission without a late prompt or provider call`, async () => {
    const session = await services.sessionManager.create({ cwd: root }), entered = latch(), finish = latch(), cancelled = latch();
    const stream = vi.spyOn(MockProvider.prototype, 'streamChat');
    const gate = async () => { entered.release(); await finish.promise; };
    if (phase === 'trust') {
      const trust = services.trustManager.isTrusted.bind(services.trustManager);
      vi.spyOn(services.trustManager, 'isTrusted').mockImplementation(async (...args) => { await gate(); return trust(...args); });
    }
    if (phase === 'hook') await services.extensionRegistry.load('http-held-admission', api => {
      api.before('before:agent', async data => { data.signal?.addEventListener('abort', cancelled.release, { once: true }); await gate(); });
    });
    if (phase === 'storage') {
      const save = services.sessionStore.saveSession.bind(services.sessionStore);
      vi.spyOn(services.sessionStore, 'saveSession').mockImplementation(async (...args) => { await gate(); return save(...args); });
    }
    const operationDone = latch(), operation = services.providerAdministration.withOperation.bind(services.providerAdministration);
    vi.spyOn(services.providerAdministration, 'withOperation').mockImplementation(async <T>(run: () => Promise<T>): Promise<T> => {
      try { return await operation(run); } finally { operationDone.release(); }
    });
    const body = JSON.stringify({ sessionId: session.id, cwd: root, provider: 'mock', input: 'must not publish', maxRetries: 0 });
    const closed = latch();
    const client = httpRequest(`${base}/api/agent/runs`, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => { response.resume(); response.once('end', closed.release); });
    client.on('error', closed.release); client.end(body);
    try {
      await entered.promise;
      const before = await readFile(services.sessionStore.getSessionFilePath(session.id)!);
      client.destroy(); await closed.promise;
      if (phase === 'hook') await cancelled.promise;
      // Let the server observe its real socket close before releasing the ignored callback/write.
      await tick(); await tick(); finish.release(); await operationDone.promise;
      expect(stream).not.toHaveBeenCalled(); expect(session.messages).toEqual([]);
      expect(services.agentRuntime.getSessionRun(session.id)).toBeUndefined();
      if (phase === 'hook') expect(await readFile(services.sessionStore.getSessionFilePath(session.id)!)).toEqual(before);
      expect((await services.sessionStore.getSessionSnapshot(session.id))?.session.messages).toEqual([]);
    } finally { client.destroy(); finish.release(); await services.extensionRegistry.unload('http-held-admission'); }
  });

  it('transfers accepted work to the detached runtime, not the ended HTTP response', async () => {
    const entered = latch(), finish = latch(), session = await services.sessionManager.create({ cwd: root });
    vi.spyOn(MockProvider.prototype, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
      entered.release(); await finish.promise; complete?.({ content: 'durable after response EOF' });
    });
    const response = await fetch(`${base}/api/agent/runs`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, cwd: root, provider: 'mock', input: 'accepted', maxRetries: 0 }) });
    expect(response.status).toBe(202); const { run } = await response.json() as { run: { id: string } };
    try { await entered.promise; finish.release(); expect((await services.agentRuntime.wait(run.id))?.phase).toBe('completed');
      expect((await services.sessionStore.getSessionSnapshot(session.id))?.session.messages.map(message => message.content))
        .toEqual(['accepted', 'durable after response EOF']);
    } finally { finish.release(); await services.agentRuntime.wait(run.id); }
  });
});
