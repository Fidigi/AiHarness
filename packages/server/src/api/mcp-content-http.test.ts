import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';
const previous = { AI_HARNESS_AUTH_TOKEN: process.env.AI_HARNESS_AUTH_TOKEN, AI_HARNESS_ADMIN_TOKEN: process.env.AI_HARNESS_ADMIN_TOKEN };
let root: string, cwd: string, base: string, services: RuntimeServices;
beforeAll(async () => {
  process.env.AI_HARNESS_AUTH_TOKEN = 'disposable-content-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'disposable-content-admin';
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-content-http-')); cwd = path.join(root, 'work');
  await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
  await writeFile(path.join(cwd, '.ai-harness/mcp.json'), JSON.stringify({ mcpServers: { docs: { command: process.execPath,
    args: [fileURLToPath(new URL('../../../core/src/mcp/fixtures/resource-server.mjs', import.meta.url))] } } }));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Content boundary</title>');
  const server = await start({ host: '127.0.0.1', port: 0, defaultCwd: cwd, dataDir: path.join(root, 'data'), allowedRoots: [root], webRoot: root,
    runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
  base = `http://127.0.0.1:${server.port}`;
  await services.trustManager.setDecision(cwd, true);
});
afterAll(async () => { try { await stop(); if (root) await rm(root, { recursive: true, force: true }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } } });

describe('authenticated MCP retained content HTTP boundary', () => {
  it('serves only session-owned references as inert no-store downloads, then refuses trust withdrawal', async () => {
    const session = await services.sessionManager.create({ cwd, title: 'Content owner' });
    const tools = await services.mcpHost.prepareForPrompt({ sessionId: session.id, cwd, preset: 'read-only' });
    const result = await tools.execute('mcp__docs__read_mcp_resource', { uri: 'fixture://audio' }, { sessionManager: services.sessionManager, currentSessionId: session.id, notify() {} });
    const reference = /mcp-content:([a-f0-9-]{36})/u.exec(result.content)![1]!;
    const url = `${base}/api/mcp/content/${session.id}/${reference}`, headers = { Authorization: 'Bearer disposable-content-user' };
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers }); expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="mcp-content.bin"');
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox'); expect(await response.text()).toBe('disposable-audio');
    const other = await services.sessionManager.create({ cwd, title: 'Other owner' });
    expect((await fetch(url.replace(session.id, other.id), { headers })).status).toBe(404);
    expect((await fetch(url.replace(reference, 'invalid'), { headers })).status).toBe(404);
    await services.trustManager.setDecision(cwd, false);
    expect((await fetch(url, { headers })).status).toBe(404);
  });
});
