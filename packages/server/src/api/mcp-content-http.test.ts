import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('keeps real extension registrations passive, file mutations separate, and reload/workspace withdrawal authoritative over HTTP', async () => {
    await services.trustManager.setDecision(cwd, true);
    const projectExtension = path.join(cwd, '.ai-harness/extensions/registered.mjs');
    const globalExtension = path.join(root, 'data/extensions/registered.mjs');
    const peer = fileURLToPath(new URL('../../../core/src/mcp/fixtures/resource-server.mjs', import.meta.url));
    for (const [file, name] of [[projectExtension, 'projectdocs'], [globalExtension, 'globaldocs']]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `export default api => { api.registerMcpServer('${name}', { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(peer)}], env: { MCP_SECRET: 'registration-private-secret' } }); };`);
    }
    const headers = { Authorization: 'Bearer disposable-content-admin', Origin: base, 'Content-Type': 'application/json' };
    const post = (route: string, body: unknown) => fetch(base + '/api/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const overview = async (directory: string) => (await fetch(`${base}/api/mcp?cwd=${encodeURIComponent(directory)}`, { headers })).json();
    try {
      expect((await services.reloadResources({ cwd })).errors).toEqual([]);
      const inventory = await overview(cwd);
      expect(inventory.servers.filter((server: { registration?: unknown }) => server.registration)).toMatchObject([
        { name: 'globaldocs', scope: 'global', registration: { extensionId: globalExtension } },
        { name: 'projectdocs', scope: 'project', registration: { extensionId: projectExtension } },
      ]);
      expect(JSON.stringify(inventory)).not.toContain('registration-private-secret');
      expect(inventory.servers.filter((server: { registration?: unknown }) => server.registration).every((server: { runtimeStatus?: unknown }) => !server.runtimeStatus)).toBe(true);
      const bytes = await readFile(path.join(cwd, '.ai-harness/mcp.json'), 'utf8');
      const denied = await post('mcp/actions', { action: 'set-enabled', scope: 'project', cwd, names: ['projectdocs'], enabled: false,
        revision: inventory.files.find((file: { scope: string }) => file.scope === 'project').revision });
      expect(denied.status).toBe(400); expect(await readFile(path.join(cwd, '.ai-harness/mcp.json'), 'utf8')).toBe(bytes);
      const tested = await post('mcp/test', { scope: 'project', name: 'projectdocs', cwd });
      expect(tested.status).toBe(200); expect((await tested.json()).result.state).toBe('connected');
      const session = await services.sessionManager.create({ cwd, title: 'Registered owner' });
      const prepared = await services.mcpHost.prepareForPrompt({ sessionId: session.id, cwd });
      const result = await prepared.execute('mcp__projectdocs__read_mcp_resource', { uri: 'fixture://audio' }, { sessionManager: services.sessionManager, currentSessionId: session.id, notify() {} });
      const reference = /mcp-content:([a-f0-9-]{36})/u.exec(result.content)![1]!;
      const url = `${base}/api/mcp/content/${session.id}/${reference}`;
      expect((await fetch(url, { headers })).status).toBe(200);
      expect((await post('agent/reload', { cwd })).status).toBe(200);
      expect((await fetch(url, { headers })).status).toBe(404);
      await expect(prepared.execute('mcp__projectdocs__read_mcp_resource', { uri: 'fixture://text' }, { sessionManager: services.sessionManager, notify() {} })).rejects.toThrow();
      const other = path.join(root, 'other'); await mkdir(other); await services.trustManager.setDecision(other, true);
      expect((await post('agent/reload', { cwd: other })).status).toBe(200);
      const next = await overview(other);
      expect(next.servers.filter((server: { registration?: unknown }) => server.registration)).toMatchObject([{ name: 'globaldocs', scope: 'global' }]);
      expect((await overview(cwd)).servers.some((server: { registration?: unknown }) => server.registration)).toBe(false);
      const fresh = await services.mcpHost.prepareForPrompt({ sessionId: 'rebound-global', cwd: other });
      expect(fresh.tools.some(tool => tool.name === 'mcp__globaldocs__read_mcp_resource')).toBe(true);
      expect(fresh.tools.some(tool => tool.name.startsWith('mcp__projectdocs__'))).toBe(false);
    } finally {
      await rm(projectExtension, { force: true }); await rm(globalExtension, { force: true });
      await services.reloadResources({ cwd });
    }
  });
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
