import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolSettings } from '@ai-harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, stop } from '../index.js';

describe('scoped sandbox and disabled-tool settings', () => {
  let root = ''; let base = ''; let projectId = '';
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-tool-settings-'));
    await mkdir(path.join(root, 'project'));
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Test</title>');
    const server = await start({ port: 0, host: '127.0.0.1', webRoot: root, dataDir: path.join(root, 'data'),
      allowedRoots: [root], defaultCwd: path.join(root, 'project'), enableMockProvider: true });
    base = `http://127.0.0.1:${server.port}`;
    projectId = (await fetch(`${base}/api/workspaces/default`).then(response => response.json())).id;
  });
  afterAll(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const read = (project = false): Promise<ToolSettings> => fetch(`${base}/api/tools${project
    ? `?cwd=${encodeURIComponent(path.join(root, 'project'))}&projectId=${projectId}` : ''}`).then(response => response.json());
  const patch = (value: unknown) => fetch(`${base}/api/tools`, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

  it('reports cached QuickJS self-test, automatic helpers and read-only/allowlist reasons without executing tools', async () => {
    const settings = await read();
    expect(settings.codemode).toMatchObject({ enabled: false, mode: 'on', inlineBudget: 3000,
      selfTest: { state: 'passed', engine: 'QuickJS' } });
    expect(settings.tools.find(tool => tool.name === 'codemode')).toMatchObject({ available: true, disabledReason: 'automatic' });
    const response = await patch({ enabledTools: ['read', 'write', 'codemode'], toolPreset: 'read-only', powershellEnabled: false,
      codemodeEnabled: true, codemodeMode: 'only', codemodeInlineBudget: 0 });
    expect(response.status).toBe(200);
    const saved = await response.json() as ToolSettings;
    expect(saved.codemode).toMatchObject({ enabled: true, mode: 'only', inlineBudget: 0 });
    expect(saved.tools.find(tool => tool.name === 'write')).toMatchObject({ enabled: true, disabledReason: 'read-only' });
    expect(saved.tools.find(tool => tool.name === 'ls')).toMatchObject({ enabled: false, disabledReason: 'not-selected' });
    expect(saved.tools.find(tool => tool.name === 'codemode')?.disabledReason).toBeUndefined();
    expect((await read()).codemode).toEqual(saved.codemode);
    const palette = await fetch(`${base}/api/agent/palette`).then(response => response.json());
    expect(palette).toContainEqual(expect.objectContaining({ name: 'mcp', source: 'builtin' }));
  });

  it('reports command conflicts without confusing ownership with MCP connection state, and unload restores navigation', async () => {
    const directory = path.join(root, 'data', 'extensions');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'mcp-owner.mjs');
    await writeFile(file, `export default api => { api.registerCommand('mcp', { description: 'Owned command', handler: () => 'owned' }); };`);
    const reload = () => fetch(`${base}/api/agent/reload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect((await reload()).status).toBe(200);
    const palette = await fetch(`${base}/api/agent/palette`).then(response => response.json());
    expect(palette.filter((item: { name: string }) => item.name === 'mcp')).toEqual([
      expect.objectContaining({ name: 'mcp', source: 'extension', extensionId: expect.any(String) }),
    ]);
    const inventory = await fetch(`${base}/api/mcp`).then(response => response.json());
    expect(inventory.command).toMatchObject({ owner: 'extension', conflict: true, extensionId: expect.any(String) });
    expect(inventory.servers).toEqual([]);
    await rm(file);
    expect((await reload()).status).toBe(200);
    expect((await fetch(`${base}/api/mcp`).then(response => response.json())).command).toEqual({ owner: 'builtin', conflict: false });
  });

  it('persists project settings independently and rejects invalid budgets/unknown fields atomically', async () => {
    const scoped = { cwd: path.join(root, 'project'), projectId, enabledTools: ['codemode'], toolPreset: 'chat-only',
      powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'on', codemodeInlineBudget: 500 };
    expect((await patch(scoped)).status).toBe(200);
    expect(await read(true)).toMatchObject({ preset: 'chat-only', codemode: { mode: 'on', inlineBudget: 500 },
      tools: expect.arrayContaining([expect.objectContaining({ name: 'codemode', disabledReason: 'chat-only' })]) });
    expect((await read()).codemode).toMatchObject({ mode: 'only', inlineBudget: 0 });
    for (const invalid of [{ codemodeInlineBudget: 3001 }, { codemodeInlineBudget: -1 }, { codemodeInlineBudget: 1.5 },
      { codemodeMode: 'unsafe' }, { codemodeEnabled: 'true' }, { memoryBytes: 1e9 }]) {
      expect((await patch({ ...scoped, ...invalid })).status).toBe(400);
    }
    expect((await read(true)).codemode).toMatchObject({ mode: 'on', inlineBudget: 500 });
  });
});
