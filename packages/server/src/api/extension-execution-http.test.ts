import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRunSnapshot } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

let root: string, cwd: string, data: string, base: string, services: RuntimeServices;
const headers = { Authorization: 'Bearer extension-admin', 'Content-Type': 'application/json' };
const post = (route: string, body: unknown) => fetch(`${base}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
beforeAll(async () => {
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'extension-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'extension-admin');
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-ext-http-')); cwd = path.join(root, 'work'); data = path.join(root, 'data');
  await mkdir(cwd); await mkdir(path.join(data, 'extensions'), { recursive: true });
  await writeFile(path.join(data, 'extensions', 'review.mjs'), `export default api => {
    api.registerTool({name:'review_probe',description:'Review',execute:()=>({content:'ORIGINAL'})});
    api.before('before:message', data=>({content:'OWNED:' + data.content}));
    api.before('before:tool:result', ()=>({result:{content:'REPLACED'}}));
    api.before('before:turn:end', async data=>{
      await data.context.sessionManager.appendCustomEntry(data.sessionId,'review:state',{round:data.round,private:'PRIVATE_HTTP_STATE'});
    });
    api.before('before:agent:settle', data=>data.round===1 ? {continuation:{type:'review:http',content:'HTTP_CONTINUATION'}} : undefined);
  };`);
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: data, allowedRoots: [root], defaultCwd: cwd,
    runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
  base = `http://127.0.0.1:${server.port}`;
  expect((await fetch(`${base}/api/workspaces/default`, { headers })).status).toBe(200);
  await services.trustManager.trust(cwd);
});
afterAll(async () => { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('runs loaded transformations and custom continuation through actual authenticated HTTP, replay and JSONL', async () => {
  const inputs: string[] = [];
  vi.spyOn(services.resolveProvider('mock')!, 'streamChat').mockImplementation(async (messages, chunk, complete) => {
    inputs.push(JSON.stringify(messages));
    if (inputs.length === 1) complete?.({ content: '', toolCalls: [{ id: 'review-http', name: 'review_probe', input: {} }], usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });
    else {
      expect(messages.some(message => message.role === 'tool' && message.content === 'REPLACED')).toBe(true);
      await chunk('RAW'); complete?.({ content: 'RAW', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });
    }
  });
  const response = await post('agent/runs', { cwd, provider: 'mock', toolPreset: 'full', input: 'review', autoCompaction: false });
  expect(response.status).toBe(202);
  const { run } = await response.json() as { run: AgentRunSnapshot };
  expect((await services.agentRuntime.wait(run.id))?.phase).toBe('completed');
  expect(inputs).toHaveLength(3); expect(inputs[2]).toContain('HTTP_CONTINUATION');
  expect(inputs.every(input => !input.includes('PRIVATE_HTTP_STATE'))).toBe(true);
  const stateResponse = await fetch(`${base}/api/agent/sessions/${run.sessionId}/state`, { headers });
  expect(stateResponse.status).toBe(200);
  const state = await stateResponse.json();
  expect(state.session.messages.at(-1).content).toBe('OWNED:RAW');
  expect(JSON.stringify(state)).not.toContain('PRIVATE_HTTP_STATE');
  const events = services.agentRuntime.journal.replay(run.sessionId).events;
  expect(events.filter(event => event.type === 'run.completed')).toHaveLength(1);
  expect(events.filter(event => event.type === 'message.completed').at(-1)?.data).toMatchObject({ content: 'OWNED:RAW' });
  const raw = await services.sessionManager.getRawEntries(run.sessionId);
  expect(raw.filter(entry => entry.type === 'custom_message')).toHaveLength(1);
  expect(raw.filter(entry => entry.type === 'message' && entry.role === 'user')).toHaveLength(1);
  expect(services.sessionManager.get(run.sessionId)?.usage.totalTokens).toBe(9);
  expect(await readFile(path.join(data, 'sessions', `${run.sessionId}.jsonl`), 'utf8')).toContain('HTTP_CONTINUATION');
  expect((await fetch(`${base}/api/plugins?cwd=${encodeURIComponent(cwd)}`, { headers })).status).toBe(200);
  expect(inputs).toHaveLength(3); // Passive inventory never invokes hooks/providers.
});
