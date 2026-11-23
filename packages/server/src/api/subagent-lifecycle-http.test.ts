import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { subagentServer } from '../../../../tests/fixtures/web06-subagents.js';
import type { SubagentRunSnapshot } from '@ai-harness/core';

async function settled(f: Awaited<ReturnType<typeof subagentServer>>, id: string) {
  let run!: SubagentRunSnapshot;
  await expect.poll(async () => {
    run = await f.request(`/api/subagents/runs/${id}`).then(response => response.json());
    return ['completed', 'failed', 'stopped'].includes(run.status);
  }, { timeout: 10_000 }).toBe(true);
  return run;
}

describe('native authenticated child runtime, policy and journal HTTP', () => {
  it('requires auth, Origin and fresh trust; preserves native scoped profiles and durable history', async () => {
    const f = await subagentServer();
    try {
      expect((await fetch(f.base() + '/api/subagents/runs')).status).toBe(401);
      expect((await f.request('/api/subagents/settings', 'PATCH', { maxConcurrency: 1 }, f.user)).status).toBe(403);
      expect((await f.request('/api/subagents/settings', 'PATCH', { maxConcurrency: 1 }, f.admin, 'https://foreign.invalid')).status).toBe(403);
      const parent = await f.request('/api/sessions', 'POST', { cwd: f.cwd, title: 'Native parent' }).then(response => response.json());
      const input = { parentSessionId: parent.id, profileId: 'general', provider: 'mock', task: 'child:done' };
      expect((await f.request('/api/subagents/runs', 'POST', input)).status).toBe(409);
      await f.trustAndLoad();
      const settings = await f.request('/api/subagents/settings').then(response => response.json());
      expect(settings.profiles.map((profile: { id: string }) => profile.id)).toEqual(['explore', 'general', 'plan']);
      expect((await f.request('/api/subagents/runs', 'POST', input, f.user, 'https://foreign.invalid')).status).toBe(403);
      const admitted = await f.request('/api/subagents/runs', 'POST', input, f.user);
      expect(admitted.status).toBe(202); expect(admitted.headers.get('cache-control')).toBe('no-store');
      const child = await admitted.json();
      expect(await settled(f, child.id)).toMatchObject({ status: 'completed', attention: true, output: 'CHILD_RESULT_é😀' });
      expect(await f.request(`/api/subagents/runs/${child.id}/acknowledge`, 'POST').then(response => response.json())).toMatchObject({ attention: false });
      expect((await f.request(`/api/subagents/runs/${child.id}`)).headers.get('cache-control')).toBe('no-store');
      await f.restart();
      const history = await f.request(`/api/sessions/${child.childSessionId}`).then(response => response.json());
      expect(history).toMatchObject({ parentId: parent.id, metadata: { subagent: true, subagentDepth: 1 } });
      expect(history.messages.at(-1).content).toBe('CHILD_RESULT_é😀');
      expect(await f.request('/api/subagents/runs').then(response => response.json())).toEqual([]);
    } finally { await f.close(); }
  }, 30_000);

  it('applies real MCP read-only/empty-tool policy, refuses undeclared writes, and stops background work', async () => {
    const f = await subagentServer();
    try {
      await f.trustAndLoad();
      const parent = await f.request('/api/sessions', 'POST', { cwd: f.cwd }).then(response => response.json());
      const config = (values: unknown) => f.request('/api/configuration/scope', 'PATCH', { scope: 'global', values });
      expect((await config({ toolPreset: 'read-only' })).status).toBe(200);
      const start = async (task: string) => {
        const response = await f.request('/api/subagents/runs', 'POST', { parentSessionId: parent.id, profileId: 'general', provider: 'mock', task });
        expect(response.status).toBe(202); return response.json();
      };
      const lookup = await start('child:lookup');
      expect((await settled(f, lookup.id)).output).toContain('lookup:');
      const frame = f.frames.find(frame => frame.sessionId === lookup.childSessionId)!;
      expect(frame.tools.some(tool => tool.includes('lookup'))).toBe(true);
      expect(frame.tools.some(tool => tool.includes('mutate'))).toBe(false);
      expect(frame.tools).not.toContain('write');
      expect(await f.calls()).toEqual(['"lookup"']);
      const attack = await start('child:attack');
      await settled(f, attack.id);
      await expect(access(path.join(f.cwd, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const connections = (await f.starts()).length;
      expect(connections).toBe(2);
      expect((await config({ enabledTools: [] })).status).toBe(200);
      const empty = await start('child:done'); await settled(f, empty.id);
      expect(f.frames.find(frame => frame.sessionId === empty.childSessionId)?.tools).toEqual([]);
      expect(await f.starts()).toHaveLength(connections);
      expect((await config({ enabledTools: null, toolPreset: 'default' })).status).toBe(200);
      const held = await start('child:hold');
      await expect.poll(() => f.frames.some(frame => frame.sessionId === held.childSessionId && frame.tools.includes('wait_child'))).toBe(true);
      expect((await f.request(`/api/subagents/runs/${held.id}/stop`, 'POST')).status).toBe(202);
      expect(await settled(f, held.id)).toMatchObject({ status: 'stopped', attention: true });
      const delegated = await f.request('/api/agent/runs', 'POST', {
        sessionId: parent.id, cwd: f.cwd, provider: 'mock', input: 'delegate:sync-held', maxRetries: 0,
      }).then(response => response.json());
      let synchronous!: SubagentRunSnapshot;
      await expect.poll(async () => {
        const runs: SubagentRunSnapshot[] = await f.request(`/api/subagents/runs?parentSessionId=${parent.id}`).then(response => response.json());
        synchronous = runs.find(run => run.id !== held.id && run.task === 'child:hold')!;
        return synchronous?.status;
      }).toBe('running');
      expect(synchronous.background).toBe(false);
      expect((await f.request(`/api/agent/runs/${delegated.run.id}/stop`, 'POST')).status).toBe(202);
      expect(await settled(f, synchronous.id)).toMatchObject({ status: 'stopped', attention: true });
      expect(await f.calls()).toEqual(['"lookup"']);
    } finally { await f.close(); }
  }, 30_000);
});
