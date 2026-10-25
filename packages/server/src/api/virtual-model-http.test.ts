import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { MockProvider, type VirtualModelRequest } from '@ai-harness/core';
import { start, stop } from '../index.js';
import type { AiProxyServer } from './proxy.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

it('routes legacy JSON/SSE/summary and isolated children, then resumes an unloaded router with physical accounting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-router-http-'));
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'router-admin');
  vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'router-admin');
  let services!: RuntimeServices, hostProxy!: AiProxyServer;
  const requests: VirtualModelRequest[] = [];
  const calls: string[] = [];
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'),
      defaultCwd: root, allowedRoots: [root], enableMockProvider: true, runtimeServicesFactory: async (proxy, options) => {
        hostProxy = proxy;
        services = await createRuntimeServices(proxy, options);
        const physical = new MockProvider({ type: 'physical', model: 'native' });
        physical.streamChat = async (_messages, chunk, complete, _error, request) => {
          calls.push(request!.model!); await chunk('physical reply');
          complete?.({ content: 'physical reply', model: request!.model, usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });
        };
        proxy.setCustomProvider('physical', physical);
        await services.extensionRegistry.load('router', api => api.registerVirtualModel({ provider: 'router', id: 'auto', route(request) {
          requests.push(request); return { provider: 'physical', id: 'native', state: { private: 'PRIVATE_ROUTER_STATE' } };
        } }));
        return services;
      } });
    const base = `http://127.0.0.1:${server.port}`;
    const post = (route: string, body: unknown, token = 'router-admin') => fetch(base + route, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const input = { provider: 'router', messages: [{ role: 'user', content: 'direct question' }], options: { model: 'auto', stream: false } };
    expect((await post('/api/chat', input, 'wrong')).status).toBe(401);
    const json = await post('/api/chat', input);
    expect(json.status).toBe(200);
    const jsonEvents = await json.text();
    expect(jsonEvents).toContain('"provider":"physical"');
    expect(await hostProxy.sendChat('router', [{ id: 'direct', timestamp: new Date(), role: 'user', content: 'question' }], input.options))
      .toMatchObject({ content: 'physical reply', provider: 'physical', model: 'native' });
    const stream = await post('/api/chat/stream', input);
    expect(stream.status).toBe(200);
    const events = await stream.text();
    expect(events).toContain('physical reply'); expect(events).toContain('"provider":"physical"'); expect(events).toContain('"model":"native"');
    expect(events).not.toContain('event: error');
    const summary = await post('/api/chat/compact', { ...input, messages: Array(4).fill(input.messages[0]) });
    expect(summary.status).toBe(200);
    expect(requests.map(request => request.reason)).toEqual(['direct', 'direct', 'direct', 'direct']);
    expect(requests.every(request => request.state === undefined)).toBe(true);

    await services.trustManager.trust(root);
    const parent = await services.sessionManager.create({ cwd: root, model: 'auto', toolPreset: 'chat-only' });
    const run = await services.agentRuntime.start({ sessionId: parent.id, cwd: root, provider: 'router', model: 'auto', input: 'parent' });
    await services.agentRuntime.wait(run.id);
    expect(services.agentRuntime.getRun(run.id)?.phase).toBe('completed');
    expect(parent.messages.at(-1)).toMatchObject({ provider: 'physical', model: 'native', metadata: { selection: { provider: 'router', id: 'auto' } } });
    const childRun = await services.subagentRuntime.start({ parentSessionId: parent.id, profileId: 'explore', provider: 'router', task: 'child task' });
    expect((await services.subagentRuntime.wait(childRun.id))?.status).toBe('completed');
    const child = services.sessionManager.get(childRun.childSessionId)!;
    expect(child.model).toBe('auto');
    expect(child.messages.at(-1)).toMatchObject({ provider: 'physical', model: 'native', metadata: { selection: { provider: 'router', id: 'auto' } } });
    expect(requests.at(-1)?.state).toBeUndefined();
    expect(requests.at(-1)?.messages.some(message => JSON.stringify(message).includes('PRIVATE_ROUTER_STATE'))).toBe(false);
    const parentStates = (await services.sessionManager.getActiveBranchEntries(parent.id)).filter(entry => entry.type === 'custom');
    await services.extensionRegistry.unload('router');
    const resumed = await post('/api/agent/runs', { sessionId: parent.id, cwd: root, provider: 'router', model: 'auto', input: 'resume' });
    expect(resumed.status).toBe(202);
    const { run: receipt } = await resumed.json();
    await services.agentRuntime.wait(receipt.id);
    expect(services.agentRuntime.getRun(receipt.id)?.phase).toBe('completed');
    expect(requests).toHaveLength(6); expect(calls).toEqual(Array(7).fill('native'));
    expect((await services.sessionManager.getActiveBranchEntries(parent.id)).filter(entry => entry.type === 'custom')).toEqual(parentStates);
    const wire = await fetch(`${base}/api/sessions/${parent.id}`, { headers: { Authorization: 'Bearer router-admin' } }).then(response => response.json());
    expect(wire.messages.at(-1)).toMatchObject({ provider: 'physical', model: 'native', metadata: { selection: { provider: 'router', id: 'auto' } } });
    expect(JSON.stringify(wire)).not.toContain('PRIVATE_ROUTER_STATE');
    expect(hostProxy.getUsage('router')).toBeUndefined();
    expect(hostProxy.getUsage('physical')).toMatchObject({ requests: 7 });
  } finally { await stop(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
