import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, WorkspacePathError } from '@ai-harness/core';
import { getProxy, start, stop } from '../index.js';
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
      const delegated = await request('/api/subagents/runs', 'POST', { parentSessionId: sessionId,
        profileId: 'general', provider: 'mock', task: 'Inherit reasoning',
        thinkingBudgets: { high: 999999 }, parentPolicy: { thinkingBudgets: { high: 999999 } } });
      expect(delegated.status).toBe(202);
      const child = await delegated.json() as { id: string };
      expect((await services.subagentRuntime.wait(child.id))?.status).toBe('completed');
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
      expect(stream).toHaveBeenCalledTimes(14);
    } finally {
      stream.mockRestore();
      await rm(path.join(root, '.ai-harness', 'settings.json'), { force: true });
      await patch('global', { thinkingBudgets: null });
      await patch('project', { thinkingBudgets: null }, projectId);
      if (sessionId) await patch('session', { thinkingBudgets: null }, sessionId);
    }
  });

  it('resolves scoped budgets and trusted-file fallback for delegation without a prior parent run', async () => {
    const parent = await services.sessionManager.create({ cwd: root, workspaceId: projectId });
    const stream = vi.spyOn(MockProvider.prototype, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => complete?.({ content: 'Child budget' }));
    const file = path.join(root, '.ai-harness', 'settings.json');
    const delegate = async (expected: unknown) => {
      const response = await request('/api/subagents/runs', 'POST', { parentSessionId: parent.id,
        profileId: 'general', provider: 'mock', task: 'Scoped child', thinkingBudgets: { high: 999999 } });
      expect(response.status).toBe(202);
      const child = await response.json() as { id: string };
      expect((await services.subagentRuntime.wait(child.id))?.status).toBe('completed');
      expect(stream.mock.calls.at(-1)?.[4]?.thinkingBudgets).toEqual(expected);
    };
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ thinkingBudgets: { high: 3000 } }));
      await delegate({ high: 3000 });
      await services.configurationStore.patch('global', { thinkingBudgets: { low: 1500 } });
      await delegate({ low: 1500 });
      await services.configurationStore.patch('session', { thinkingBudgets: {} }, parent.id);
      await delegate({});
      await services.configurationStore.patch('session', { thinkingBudgets: null }, parent.id);
      await services.configurationStore.patch('global', { thinkingBudgets: null });
      await writeFile(file, JSON.stringify({ thinkingBudgets: { high: 4000 } }));
      await delegate({ high: 4000 });
      expect(services.agentRuntime.getSessionRun(parent.id)).toBeUndefined();
      expect(stream).toHaveBeenCalledTimes(4);
    } finally {
      stream.mockRestore();
      await rm(file, { force: true });
      await services.configurationStore.patch('global', { thinkingBudgets: null });
      await services.configurationStore.patch('session', { thinkingBudgets: null }, parent.id);
    }
  });

  it.each(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-5',
    'claude-opus-4-5-20251101', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'])(
    'owns legacy HTTP numeric budgets for %s in the default workspace, never in caller selectors or maps', async model => {
    const globalFile = path.join(root, '.data', 'settings.json');
    const projectFile = path.join(root, '.ai-harness', 'settings.json');
    const cacheId = 'legacy-provider-cache';
    const previousThinking = services.configurationStore.get('global').thinking;
    const calls: Array<Record<string, unknown>> = [];
    const actualFetch = globalThis.fetch.bind(globalThis);
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(base + '/')) return actualFetch(input, init);
      if (url !== 'https://api.anthropic.com/v1/messages') throw new Error('Unexpected legacy-budget outbound request');
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response([
        ['message_start', { message: { id: 'legacy-budget', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 3 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: 'LEGACY_BUDGET_OK' } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
        ['message_stop', {}],
      ].map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const chat = async (budget: number | 'off' | 'omitted' | 'refused', thinking = 'low') => {
      for (const route of ['/api/chat', '/api/chat/stream']) {
        const before = calls.length;
        const response = await request(route, 'POST', { provider: 'anthropic', messages: [{ role: 'user', content: 'Trusted numeric policy' }],
          cwd: '/caller-cannot-select', projectId: 'caller-project', sessionId: cacheId, thinkingBudgets: { low: 999999 },
          options: { model, maxTokens: 64000, ...(budget === 'omitted' ? {} : { thinking }), sessionId: cacheId,
            thinkingBudgets: { low: 999999, high: 999999 } } });
        expect(response.status).toBe(200);
        const body = await response.text();
        if (budget === 'refused') {
          expect(body.match(/^event: error$/gm)).toHaveLength(1);
          expect(body).toContain('Provider request failed.');
          for (const forbidden of ['LEGACY_BUDGET_OK', 'event: message_end', 'Invalid Anthropic thinking allocation.']) expect(body).not.toContain(forbidden);
          expect(calls).toHaveLength(before);
          continue;
        }
        expect(body).toContain('LEGACY_BUDGET_OK');
        expect(calls).toHaveLength(before + 1);
        if (budget === 'omitted') {
          expect(calls.at(-1)).toMatchObject({ model, max_tokens: 64000, stream: true });
          expect(calls.at(-1)).not.toHaveProperty('thinking');
        } else expect(calls.at(-1)).toMatchObject({ model, max_tokens: 64000, stream: true,
          thinking: budget === 'off' ? { type: 'disabled' } : { type: 'enabled', budget_tokens: budget, display: 'summarized' } });
      }
    };
    try {
      getProxy().setApiKey('anthropic', 'disposable-legacy-budget-key', undefined, model);
      await services.configurationStore.patch('global', { thinking: 'high' });
      await mkdir(path.dirname(projectFile), { recursive: true });
      await writeFile(globalFile, JSON.stringify({ thinkingBudgets: { low: 1600 } }));
      await writeFile(projectFile, JSON.stringify({ thinkingBudgets: { low: 3000 } }));
      await services.configurationStore.patch('session', { thinkingBudgets: { low: 9000 } }, cacheId);
      await chat(3000);
      await services.configurationStore.patch('global', { thinkingBudgets: { low: 2200 } });
      await services.configurationStore.patch('project', { thinkingBudgets: { high: 3500 } }, projectId);
      await chat(2048); // A scoped whole map does not inherit the missing low key.
      await chat(3500, 'high');
      await chat(3500, 'xhigh');
      await chat(3500, 'max');
      await chat('omitted');
      await services.configurationStore.patch('project', { thinkingBudgets: { high: 999999 } }, projectId);
      await chat(62976, 'high'); // Published 64,000 ceiling retains 1,024 answer tokens.
      await services.configurationStore.patch('project', { thinkingBudgets: { high: 0 } }, projectId);
      await chat(1024, 'high'); // Zero retains the native fallback; it is not logical off.
      await services.configurationStore.patch('project', { thinkingBudgets: { low: 1 } }, projectId);
      await chat('refused');
      await services.configurationStore.patch('project', { thinkingBudgets: {} }, projectId);
      await chat(2048);
      await services.configurationStore.patch('project', { thinkingBudgets: null }, projectId);
      await chat(2200);
      await services.configurationStore.patch('global', { thinkingBudgets: null });
      await chat(3000);
      await writeFile(projectFile, JSON.stringify({ thinkingBudgets: { low: 4000 } }));
      await chat(4000);
      await services.trustManager.refuse(root);
      await chat(1600);
      await services.configurationStore.patch('project', { thinkingBudgets: { low: 4500 } }, projectId);
      await chat(4500); // An administrator-owned map is not a project file.
      await services.configurationStore.patch('project', { thinkingBudgets: null }, projectId);
      await services.trustManager.trust(root);
      await chat(4000);
      const unavailable = vi.spyOn(services.workspaceManager, 'getDefaultCwd')
        .mockRejectedValue(new WorkspacePathError('OUTSIDE_ALLOWED_ROOTS', 'Unavailable default'));
      try { await chat(1600); } finally { unavailable.mockRestore(); }
      await chat('off', 'off');
      expect(calls).toHaveLength(34);
    } finally {
      transport.mockRestore();
      await services.trustManager.trust(root);
      await rm(globalFile, { force: true });
      await rm(projectFile, { force: true });
      await services.configurationStore.patch('global', { thinkingBudgets: null, thinking: previousThinking ?? null });
      await services.configurationStore.patch('project', { thinkingBudgets: null }, projectId);
      await services.configurationStore.patch('session', { thinkingBudgets: null }, cacheId);
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
