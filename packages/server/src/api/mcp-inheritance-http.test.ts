import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpConfigInventory } from '@ai-harness/core';
import { start, stop } from '../index.js';

const user = 'disposable-inheritance-user', admin = 'disposable-inheritance-admin';
const peer = fileURLToPath(new URL('../../../core/src/mcp/fixtures/test-server.mjs', import.meta.url));
const environment = { AI_HARNESS_AUTH_TOKEN: process.env.AI_HARNESS_AUTH_TOKEN, AI_HARNESS_ADMIN_TOKEN: process.env.AI_HARNESS_ADMIN_TOKEN };
let root: string, data: string, base: string, sequence = 0;
const headers = (token = admin, origin = base) => ({ Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' });
const post = (route: string, body: unknown, token = admin, origin = base) => fetch(base + route, {
  method: 'POST', headers: headers(token, origin), body: JSON.stringify(body),
});
async function fixture() {
  const cwd = path.join(root, `project-${++sequence}`), log = path.join(root, `calls-${sequence}.jsonl`);
  await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
  const globalFile = path.join(data, 'mcp.json'), projectFile = path.join(cwd, '.ai-harness/mcp.json');
  const globalBytes = JSON.stringify({ version: 1, mcpServers: { shared: {
    command: process.execPath, args: [peer], enabled: false, exposure: 'hidden', toolExposure: { '*': 'hidden' },
    env: { MCP_TEST_CALL_LOG: log, INHERITED_SECRET: 'DISPOSABLE-GLOBAL-INHERITANCE-SECRET' },
  } } });
  const localBytes = JSON.stringify({ version: 1, mcpServers: { shared: {
    enabled: true, exposure: 'direct', toolExposure: { '*': 'hidden', lookup: 'direct' },
  } } });
  await writeFile(globalFile, globalBytes); await writeFile(projectFile, localBytes); await chmod(projectFile, 0o640);
  const get = (token = admin) => fetch(`${base}/api/mcp?cwd=${encodeURIComponent(cwd)}`, { headers: headers(token) });
  const trust = async () => { expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200); };
  const inventory = async () => { const response = await get(); expect(response.status).toBe(200); return await response.json() as McpConfigInventory; };
  return { cwd, log, globalFile, projectFile, globalBytes, localBytes, get, trust, inventory };
}

beforeAll(async () => {
  process.env.AI_HARNESS_AUTH_TOKEN = user; process.env.AI_HARNESS_ADMIN_TOKEN = admin;
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-inheritance-http-')); data = path.join(root, 'data');
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Disposable inheritance fixture</title>');
  const server = await start({ port: 0, host: '127.0.0.1', webRoot: root, dataDir: data,
    allowedRoots: [root], defaultCwd: root, enableMockProvider: true });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  try { await stop(); if (root) await rm(root, { recursive: true, force: true }); }
  finally { for (const [name, value] of Object.entries(environment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});

describe('authenticated native HTTP targetless MCP inheritance', () => {
  it('keeps inventory passive/pretrust-private and tests inherited controls without revealing global values', async () => {
    const f = await fixture();
    expect((await fetch(`${base}/api/mcp`)).status).toBe(401);
    const locked = await f.inventory();
    expect(locked.files.find(file => file.scope === 'project')).toMatchObject({ contentRead: false });
    expect(locked.servers.every(server => server.scope === 'global')).toBe(true);
    const body = { cwd: f.cwd, scope: 'project', name: 'shared' };
    expect((await post('/api/mcp/test', body)).status).toBe(403);
    await f.trust();
    const response = await f.get(user); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const inventory = await response.json() as McpConfigInventory;
    expect(inventory.servers.find(server => server.scope === 'project')).toMatchObject({
      valid: true, inheritsGlobal: true, enabled: true, exposure: 'direct', replacesGlobal: true,
    });
    expect(inventory.servers.find(server => server.scope === 'global')).toMatchObject({ shadowedByProject: true });
    expect(JSON.stringify(inventory)).not.toContain('DISPOSABLE-GLOBAL-INHERITANCE-SECRET');
    await expect(access(f.log)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await post('/api/mcp/test', body, user)).status).toBe(403);
    expect((await post('/api/mcp/test', body, admin, 'https://foreign.invalid')).status).toBe(403);
    const tested = await post('/api/mcp/test', body); expect(tested.status).toBe(200); expect(tested.headers.get('cache-control')).toBe('no-store');
    const result = await tested.json(); expect(result.result.state).toBe('connected');
    expect(result.result.tools.map((tool: { name: string; exposure: string }) => [tool.name, tool.exposure]))
      .toEqual([['lookup', 'direct'], ['mutate', 'hidden']]);
    expect(JSON.stringify(result)).not.toContain('DISPOSABLE-GLOBAL-INHERITANCE-SECRET');
    await expect(access(f.log)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.globalFile, 'utf8')).toBe(f.globalBytes); expect(await readFile(f.projectFile, 'utf8')).toBe(f.localBytes);
  });

  it('writes only raw controls atomically while retaining auth/Origin/stale-revision refusal', async () => {
    const f = await fixture(); await f.trust();
    const inventory = await f.inventory(), revision = inventory.files.find(file => file.scope === 'project')?.revision;
    if (!revision) throw new Error('Native project revision is unavailable.');
    const body = { action: 'set-exposure', scope: 'project', name: 'shared', cwd: f.cwd, revision, exposure: 'hidden' };
    expect((await post('/api/mcp/actions', body, user)).status).toBe(403);
    expect((await post('/api/mcp/actions', body, admin, 'https://foreign.invalid')).status).toBe(403);
    expect(await readFile(f.projectFile, 'utf8')).toBe(f.localBytes);
    const changed = await post('/api/mcp/actions', body); expect(changed.status).toBe(200);
    expect(JSON.stringify(await changed.json())).not.toContain('DISPOSABLE-GLOBAL-INHERITANCE-SECRET');
    expect(JSON.parse(await readFile(f.projectFile, 'utf8'))).toEqual({ version: 1, mcpServers: { shared: {
      enabled: true, exposure: 'hidden', toolExposure: { '*': 'hidden', lookup: 'direct' },
    } } });
    const saved = await readFile(f.projectFile), info = await lstat(f.projectFile);
    expect(info.nlink).toBe(1); expect(info.mode & 0o777).toBe(0o640);
    const stale = await post('/api/mcp/actions', { ...body, exposure: 'direct' }); expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale-revision', uncertain: false });
    expect(await readFile(f.projectFile)).toEqual(saved); expect(await readFile(f.globalFile, 'utf8')).toBe(f.globalBytes);
    await expect(access(f.log)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses orphan and authority-changing targetless entries without process effects or private diagnostics', async () => {
    const f = await fixture(); await f.trust();
    await writeFile(f.projectFile, JSON.stringify({ mcpServers: { shared: { env: { TOKEN: 'PRIVATE-REDIRECT' } } } }));
    const invalid = await f.inventory();
    expect(invalid.servers.find(server => server.scope === 'project')).toMatchObject({ valid: false, problemReasons: ['override-fields'] });
    expect(JSON.stringify(invalid)).not.toMatch(/PRIVATE-REDIRECT|DISPOSABLE-GLOBAL-INHERITANCE-SECRET/u);
    const body = { cwd: f.cwd, scope: 'project', name: 'shared' };
    expect((await post('/api/mcp/test', body)).status).toBe(409);
    await writeFile(f.projectFile, f.localBytes); await writeFile(f.globalFile, '{"mcpServers":{}}');
    const orphan = await f.inventory(); expect(orphan.servers.find(server => server.scope === 'project'))
      .toMatchObject({ valid: false, problemReasons: ['orphan-override'] });
    expect((await post('/api/mcp/test', body)).status).toBe(409);
    expect(await readFile(f.projectFile, 'utf8')).toBe(f.localBytes);
    await expect(access(f.log)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
