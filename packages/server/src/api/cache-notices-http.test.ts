import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

it('projects branch-relative historical cache notices through bounded authenticated pages, never private receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cache-http-'));
  let services!: RuntimeServices;
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'notice-reader'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'notice-admin');
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), defaultCwd: root, allowedRoots: [root],
      enableMockProvider: true, runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
    const base = `http://127.0.0.1:${server.port}`;
    const request = (route: string, token = 'notice-reader', body?: unknown) => fetch(base + route, {
      method: body === undefined ? 'GET' : 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const manager = services.sessionManager;
    const session = await manager.create({ cwd: root });
    await manager.addMessage(session.id, { role: 'assistant', content: 'cached', provider: 'anthropic', model: 'claude-sonnet-4-6',
      usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 100_000, totalTokens: 100_001 } });
    const first = session.messages[0].id;
    await manager.appendCustomEntry(session.id, 'provider.router_state', { private: 'NEVER_RETURN_ROUTER_STATE' });
    await manager.recordProviderUsage(session.id, { provider: 'anthropic', model: 'claude-sonnet-4-6',
      usage: { cacheReadTokens: 100_000, outputTokens: 1, costUsd: 0.03 } }, session.activeLeafId!);
    await manager.addMessage(session.id, { role: 'assistant', content: 'missed', provider: 'anthropic', model: 'claude-sonnet-4-6',
      usage: { inputTokens: 100_000, outputTokens: 1, cacheReadTokens: 0, totalTokens: 100_001 } });
    const last = session.messages.at(-1)!.id, route = `/api/sessions/${session.id}`;
    expect((await fetch(base + route)).status).toBe(401);
    const tail = await request(route + '?messageLimit=1').then(response => response.json());
    expect(tail.cacheNotices).toEqual([expect.objectContaining({ kind: 'cache_miss', afterEntryId: last, missedTokens: 100_000 })]);
    const older = await request(`${route}/messages?before=${last}&limit=1`).then(response => response.json());
    expect(older.cacheNotices).toEqual([expect.objectContaining({ kind: 'cache_warm', afterEntryId: first, costUsd: 0.03 })]);
    const stateRoute = `/api/agent/sessions/${session.id}/state`;
    const state = await request(stateRoute).then(response => response.json());
    expect(state.session.cacheNotices).toEqual([...older.cacheNotices, ...tail.cacheNotices]);
    const stateTail = await request(stateRoute + '?messageLimit=1').then(response => response.json());
    expect(stateTail.session.cacheNotices).toEqual(tail.cacheNotices);
    expect(JSON.stringify([tail, older, state, stateTail])).not.toContain('NEVER_RETURN_ROUTER_STATE');
    expect(JSON.stringify([tail, older, state, stateTail])).not.toContain('provider.cache_warm');
    const before = await manager.getRawEntries(session.id);
    const setting = { scope: 'global', values: { showCacheMissNotices: false } };
    expect((await request('/api/configuration/scope', 'notice-reader', setting)).status).toBe(403);
    expect((await request('/api/configuration/scope', 'notice-admin', { ...setting, scope: 'project', scopeId: 'p' })).status).toBe(400);
    expect((await request('/api/configuration/scope', 'notice-admin', setting)).status).toBe(200);
    expect(await request(route).then(response => response.json())).toMatchObject({ cacheNotices: [], showCacheMissNotices: false });
    expect(await request(stateRoute).then(response => response.json())).toMatchObject({ session: { cacheNotices: [], showCacheMissNotices: false } });
    expect(await manager.getRawEntries(session.id)).toEqual(before);
    expect((await request('/api/configuration/scope', 'notice-admin', { scope: 'global', values: { showCacheMissNotices: null } })).status).toBe(200);
    await manager.navigateTree(session.id, first);
    expect(await request(route).then(response => response.json())).toMatchObject({ cacheNotices: [], showCacheMissNotices: true });
    expect(await request(stateRoute).then(response => response.json())).toMatchObject({ session: { cacheNotices: [], showCacheMissNotices: true } });
    await manager.navigateTree(session.id, last);
    const original = await request(route).then(response => response.json());
    expect(original.cacheNotices).toHaveLength(2);
    const cloned = await manager.cloneSession(session.id);
    const clone = await request(`/api/sessions/${cloned!.id}`).then(response => response.json());
    expect(clone.cacheNotices.map((notice: { kind: string }) => notice.kind)).toEqual(['cache_warm', 'cache_miss']);
    expect(clone.messages.map((message: { id: string }) => message.id)).not.toEqual(original.messages.map((message: { id: string }) => message.id));
  } finally { await stop(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
