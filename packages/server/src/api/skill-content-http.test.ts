import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, type SkillCatalog } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';
import { createSkillRouter } from './skill-routes.js';

const secret = 'disposable-skill-content-secret-not-a-credential';
let root: string, cwd: string, main: string, projectMain: string, base: string, configuration: string;
let services: RuntimeServices, catalog: SkillCatalog, globalKey: string, projectKey: string;
const source = (name: string) => `---\nname: ${name}\ndescription: Public metadata\ndisable-model-invocation: true\n---\n# Full instructions\nPublic body ${secret}\n[Guide](docs/guide.md)\n`;
const headers = { authorization: 'Bearer disposable-user-token' };
const query = (fields: Record<string, string> = {}) => new URLSearchParams({ key: globalKey, cwd, projectId: catalog.projectId, ...fields });
const get = (fields: Record<string, string> = {}) => fetch(`${base}/api/skills/content?${query(fields)}`, { headers });
beforeAll(async () => {
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'disposable-user-token');
  vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'disposable-admin-token');
  vi.stubEnv('AI_HARNESS_SKILL_PATHS', '');
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-skill-http-'));
  cwd = path.join(root, 'project');
  main = path.join(root, 'data', 'skills', 'global-review', 'SKILL.md');
  projectMain = path.join(cwd, '.agents', 'skills', 'project-review', 'SKILL.md');
  configuration = path.join(root, 'data', 'config.json');
  for (const file of [main, projectMain]) {
    await mkdir(path.join(path.dirname(file), 'docs'), { recursive: true });
    await writeFile(file, source(file === main ? 'global-review' : 'project-review'));
    await writeFile(path.join(path.dirname(file), 'docs', 'guide.md'), '# Guide\n[Back](../SKILL.md)\n<script>NO_EXECUTION</script>\n');
  }
  const server = await start({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'data'), configurationFile: configuration,
    allowedRoots: [cwd], defaultCwd: cwd, enableMockProvider: true,
    runtimeServicesFactory: async (proxy, options) => {
      proxy.getCredentialRedactor().add(secret);
      services = await createRuntimeServices(proxy, options);
      return services;
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  expect((await fetch(`${base}/api/skills`, { headers })).status).toBe(200);
  await services.trustManager.trust(cwd);
  catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
  globalKey = catalog.skills.find(skill => skill.name === 'global-review')!.key;
  projectKey = catalog.skills.find(skill => skill.name === 'project-review')!.key;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await stop(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('actual authenticated explicit skill-content HTTP reads', () => {
  it('requires authentication before discovery and body access', async () => {
    const read = vi.spyOn(services.skillCatalog, 'getContent');
    expect((await fetch(`${base}/api/skills/content?${query()}`)).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });
  it('the route itself refuses a request with no workspace-read capability', async () => {
    const app = express(); app.use('/skills', createSkillRouter(Promise.resolve(services)));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const read = vi.spyOn(services.skillCatalog, 'getContent');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener.');
      expect((await fetch(`http://127.0.0.1:${address.port}/skills/content?${query()}`)).status).toBe(403);
      expect(read).not.toHaveBeenCalled();
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('allows an ordinary authenticated read without configuration privileges, but redacts known secrets and never activates/executes resources', async () => {
    const before = await readFile(configuration, 'utf8').catch(() => undefined);
    const observed = [vi.spyOn(MockProvider.prototype, 'chat'), vi.spyOn(MockProvider.prototype, 'streamChat'),
      vi.spyOn(services.agentRuntime, 'start'), vi.spyOn(services, 'reloadResources'),
      vi.spyOn(services.extensionRegistry, 'load'), vi.spyOn(services.extensionRegistry, 'executeTool'),
      vi.spyOn(services.extensionRegistry, 'executeHostedTool'), vi.spyOn(services.mcpHost, 'prepareForPrompt')];
    const response = await get(); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const data = await response.json(); expect(data).toMatchObject({ key: globalKey, relativePath: 'SKILL.md', markdown: expect.stringContaining('# Full instructions') });
    expect(JSON.stringify(data)).not.toContain(secret); expect(data.markdown).not.toContain('disable-model-invocation');
    for (const spy of observed) expect(spy).not.toHaveBeenCalled();
    expect(await readFile(main, 'utf8')).toBe(source('global-review'));
    expect(await readFile(configuration, 'utf8').catch(() => undefined)).toBe(before);
    expect((await services.skillCatalog.getCatalog({ cwd })).skills.find(skill => skill.key === globalKey)?.modelInvocable).toBe(false);
  });
  it('resolves nested/back references against the declaring skill and returns Markdown data, not an execution or navigation instruction', async () => {
    const response = await get({ href: 'docs/guide.md#guide' }); expect(response.status).toBe(200);
    const data = await response.json(); expect(data).toMatchObject({ relativePath: 'docs/guide.md', fragment: 'guide', markdown: expect.stringContaining('<script>NO_EXECUTION</script>') });
    const back = await get({ href: '../SKILL.md', from: data.relativePath }); expect(back.status).toBe(200); expect((await back.json()).relativePath).toBe('SKILL.md');
  });
  it.each(['../outside.md', '%2e%2e/outside.md', '/etc/secret.md', 'file:///etc/secret.md', 'https://invalid.example/doc.md', 'docs/guide.md?query=1', 'docs/guide.md%00', 'docs/guide.md%zz'])('refuses %s without exposing another path or following a remote destination', async href => {
    const response = await get({ href }); expect(response.status).toBe(400); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Skill Markdown reference is invalid.', code: 'INVALID_SKILL_REFERENCE' });
  });
  it.each(['key=', 'href=', 'from=', 'key=a&key=b', 'href[]=guide.md'])('rejects malformed query %s rather than silently defaulting', async suffix => {
    const params = query(); for (const field of ['key', 'href', 'from']) if (suffix.startsWith(field + '=')) params.delete(field);
    const response = await fetch(`${base}/api/skills/content?${params}&${suffix}`, { headers }); expect(response.status).toBe(400);
  });
  it('refuses workspace identity substitution', async () => {
    const response = await get({ projectId: 'unrelated-workspace' }); expect(response.status).toBe(400); expect((await response.json()).code).toBe('WORKSPACE_MISMATCH');
  });
  it('rechecks project trust without falling back to a global document', async () => {
    expect((await get({ key: projectKey })).status).toBe(200);
    await services.trustManager.untrust(cwd);
    try {
      const response = await get({ key: projectKey }); expect(response.status).toBe(404); expect((await response.json()).code).toBe('SKILL_CONTENT_UNAVAILABLE');
      expect((await get()).status).toBe(200);
    } finally { await services.trustManager.trust(cwd); }
  });
  it('refuses an unreadable canonical configuration before reading the body', async () => {
    const before = await readFile(configuration, 'utf8').catch(() => undefined);
    await mkdir(path.dirname(configuration), { recursive: true }); await writeFile(configuration, '{invalid');
    const read = vi.spyOn(services.skillCatalog, 'getContent');
    try {
      const response = await get(); expect(response.status).toBe(409); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'Canonical configuration is unreadable.', code: 'CONFIGURATION_UNREADABLE' }); expect(read).not.toHaveBeenCalled();
    } finally { if (before === undefined) await rm(configuration, { force: true }); else await writeFile(configuration, before); await services.configurationStore.load(); }
  });
});
