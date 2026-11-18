import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpConfigInventory } from '@ai-harness/core';
import { start, stop } from '../index.js';

describe('HTTP typed MCP entry diagnostics', () => {
  let root: string, data: string, base: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-diagnostic-http-'));
    data = path.join(root, 'data');
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Disposable MCP diagnostic fixture</title>');
    const server = await start({ port: 0, host: '127.0.0.1', webRoot: root, dataDir: data,
      allowedRoots: [root], defaultCwd: root, enableMockProvider: true });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => { await stop(); await rm(root, { recursive: true, force: true }); });

  it('delivers value-free codes and unchanged legacy messages, without pretrust reads or command execution', async () => {
    const project = path.join(root, 'project'), marker = path.join(root, 'must-not-run');
    await mkdir(path.join(project, '.ai-harness'), { recursive: true });
    const globalPath = path.join(data, 'mcp.json'), projectPath = path.join(project, '.ai-harness', 'mcp.json');
    const global = JSON.stringify({ mcpServers: {
      invalid: { command: 'node', enabled: 'GLOBAL-PRIVATE-LITERAL' },
      passive: { command: 'sh', args: ['-c', `touch ${marker}`], env: { TOKEN: '!printf NEVER-RESOLVE-ME' } },
    } });
    const local = JSON.stringify({ mcpServers: {
      private: { url: 'https://example.test/private', oauth: { unsupported: 'PROJECT-PRIVATE-LITERAL' } },
    } });
    await writeFile(globalPath, global);
    await writeFile(projectPath, local);
    const url = `${base}/api/mcp?cwd=${encodeURIComponent(project)}`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const locked = await response.json() as McpConfigInventory;
    expect(locked.files.find(file => file.scope === 'project')).toMatchObject({ contentRead: false, problems: [{ reason: 'trust-required' }] });
    expect(locked.servers.map(server => server.name)).toEqual(['invalid', 'passive']);
    expect(locked.servers[0]).toMatchObject({ valid: false, problems: ['Enabled must be a boolean.'], problemReasons: ['enabled'] });
    expect(locked.servers[1]!.problemReasons).toBeUndefined();
    expect(JSON.stringify(locked)).not.toMatch(/GLOBAL-PRIVATE-LITERAL|PROJECT-PRIVATE-LITERAL|NEVER-RESOLVE-ME|touch /u);
    const allowed = await fetch(`${base}/api/workspaces/trust`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: project, confirm: true }) });
    expect(allowed.status).toBe(200);
    const trustedResponse = await fetch(url);
    expect(trustedResponse.status).toBe(200);
    const trusted = await trustedResponse.json() as McpConfigInventory;
    expect(trusted.servers.find(server => server.scope === 'project')).toMatchObject({
      valid: false, problemReasons: ['oauth'], problems: ['OAuth settings do not match the supported schema.'],
    });
    expect(JSON.stringify(trusted)).not.toMatch(/GLOBAL-PRIVATE-LITERAL|PROJECT-PRIVATE-LITERAL|NEVER-RESOLVE-ME|touch /u);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(globalPath, 'utf8')).toBe(global);
    expect(await readFile(projectPath, 'utf8')).toBe(local);
  });

  it('does not let configuration supply its own presentation codes', async () => {
    await writeFile(path.join(data, 'mcp.json'), JSON.stringify({ mcpServers: {
      forged: { command: 'node', problemReasons: ['oauth'] },
    } }));
    const response = await fetch(`${base}/api/mcp`);
    expect(response.status).toBe(200);
    const inventory = await response.json() as McpConfigInventory;
    expect(inventory.servers).toHaveLength(1);
    expect(inventory.servers[0]).toMatchObject({ valid: false, problemReasons: ['unsupported-properties'],
      problems: ['The server entry contains unsupported properties.'] });
  });
});
