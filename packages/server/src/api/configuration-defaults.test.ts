import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockProvider } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

describe('independent new-session defaults', () => {
  let root: string;
  let base: string;
  let projectId: string;
  let services: RuntimeServices;
  const request = (route: string, method = 'GET', body?: unknown) => fetch(`${base}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  beforeAll(async () => {
    for (const key of ['AI_HARNESS_DEFAULT_PROVIDER', 'AI_HARNESS_DEFAULT_MODEL', 'AI_HARNESS_DEFAULT_THINKING']) vi.stubEnv(key, '');
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-defaults-'));
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, '.data'),
      allowedRoots: [root], defaultCwd: root, enableMockProvider: true,
      runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
    base = `http://127.0.0.1:${server.port}`;
    projectId = (await request('/api/workspaces/default').then(response => response.json()) as { id: string }).id;
    expect((await request('/api/workspaces/trust', 'POST', { cwd: root, confirm: true })).status).toBe(200);
  });
  afterAll(async () => { await stop(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it('saves model and thinking independently, reports masked project precedence, and inherits in a new run', async () => {
    await services.configurationStore.patch('global', { provider: 'mock', model: 'old', thinking: 'low', toolPreset: 'read-only' });
    await services.configurationStore.patch('project', { model: 'project-model', thinking: 'minimal' }, projectId);
    const model = await request('/api/configuration/defaults', 'PATCH', { kind: 'model', provider: 'mock', model: 'mock-model', projectId });
    expect(model.status).toBe(200);
    expect(await model.json()).toMatchObject({ values: { model: 'mock-model', thinking: 'low', toolPreset: 'read-only' }, overridden: ['model'] });
    const thinking = await request('/api/configuration/defaults', 'PATCH', { kind: 'thinking', thinking: 'high', projectId });
    expect(thinking.status).toBe(200);
    expect(await thinking.json()).toMatchObject({ values: { model: 'mock-model', thinking: 'high', toolPreset: 'read-only' }, overridden: ['thinking'] });
    await services.configurationStore.patch('project', { model: null, thinking: null }, projectId);
    const stream = vi.spyOn(MockProvider.prototype, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => complete?.({ content: 'Done' }));
    try {
      const started = await request('/api/agent/runs', 'POST', { cwd: root, input: 'Inherited defaults' });
      expect(started.status).toBe(202);
      const body = await started.json() as { run: { id: string } };
      await services.agentRuntime.wait(body.run.id);
      expect(stream.mock.calls[0]?.[4]).toMatchObject({ model: 'mock-model', thinking: 'high' });
    } finally { stream.mockRestore(); }
  });

  it('transmits scoped numeric reasoning budgets to detached runs without accepting prompt-body overrides', async () => {
    const patch = async (scope: string, values: unknown, scopeId?: string) => {
      const response = await request('/api/configuration/scope', 'PATCH', { scope, scopeId, values });
      expect(response.status).toBe(200);
    };
    const stream = vi.spyOn(MockProvider.prototype, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => complete?.({ content: 'Budget fixture' }));
    let sessionId: string | undefined;
    const run = async (expected: unknown) => {
      const started = await request('/api/agent/runs', 'POST', { cwd: root, sessionId, input: 'Scoped reasoning',
        thinkingBudgets: { high: 999999 } });
      expect(started.status).toBe(202);
      const body = await started.json() as { run: { id: string }; session: { id: string } };
      sessionId = body.session.id;
      expect((await services.agentRuntime.wait(body.run.id))?.phase).toBe('completed');
      expect(stream.mock.calls.at(-1)?.[4]?.thinkingBudgets).toEqual(expected);
    };
    try {
      await patch('global', { thinkingBudgets: { low: 1000, high: 8000 } });
      await patch('project', { thinkingBudgets: { high: 2500 } }, projectId);
      for (const invalid of [{ high: -1 }, { max: 1 }, { high: '1000' }]) {
        expect((await request('/api/configuration/scope', 'PATCH', {
          scope: 'project', scopeId: projectId, values: { thinkingBudgets: invalid },
        })).status).toBe(400);
      }
      await run({ high: 2500 });
      await patch('session', { thinkingBudgets: {} }, sessionId);
      await run({});
      await patch('session', { thinkingBudgets: null }, sessionId);
      await run({ high: 2500 });
      await patch('project', { thinkingBudgets: null }, projectId);
      await run({ low: 1000, high: 8000 });
      await mkdir(path.join(root, '.ai-harness'), { recursive: true });
      await writeFile(path.join(root, '.ai-harness', 'settings.json'), JSON.stringify({ thinkingBudgets: { low: 3000 } }));
      await patch('global', { thinkingBudgets: null });
      await run({ low: 3000 });
      await patch('global', { thinkingBudgets: {} });
      await run({});
      await patch('global', { thinkingBudgets: null });
      await run({ low: 3000 });
      expect(stream).toHaveBeenCalledTimes(7);
    } finally {
      stream.mockRestore();
      await rm(path.join(root, '.ai-harness', 'settings.json'), { force: true });
      await patch('global', { thinkingBudgets: null });
      await patch('project', { thinkingBudgets: null }, projectId);
      if (sessionId) await patch('session', { thinkingBudgets: null }, sessionId);
    }
  });

  it('rejects invalid levels, hidden fields and scope selectors without changing another key', async () => {
    const before = services.configurationStore.get('global');
    for (const body of [
      { kind: 'thinking', thinking: 'unlimited' }, { kind: 'thinking', thinking: null },
      { kind: 'thinking', thinking: 'high', model: 'clobber' }, { kind: 'thinking', thinking: 'low', projectId: '__proto__' },
      { kind: 'model', provider: 'mock', model: '' }, { kind: 'model', provider: 'mock', model: 'new', thinking: 'off' },
      { kind: 'model', provider: 'mock', model: 'new', apiKey: 'must-not-be-used' },
    ]) expect((await request('/api/configuration/defaults', 'PATCH', body)).status).toBe(400);
    expect(services.configurationStore.get('global')).toEqual(before);
  });

  it('never overwrites settings which became unreadable after startup', async () => {
    const file = path.join(root, '.data', 'config.json');
    const before = await readFile(file, 'utf8');
    await writeFile(file, '{unreadable');
    try {
      expect((await request('/api/configuration/scope?scope=global')).status).toBe(409);
      expect((await request('/api/configuration/effective')).status).toBe(409);
      expect((await request('/api/configuration/defaults', 'PATCH', { kind: 'thinking', thinking: 'off' })).status).toBe(409);
      expect(await readFile(file, 'utf8')).toBe('{unreadable');
    } finally { await writeFile(file, before); }
  });
});
