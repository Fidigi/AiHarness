import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { start, stop } from './index.js';

const html = '<!doctype html><html><head><title>AiHarness Test</title></head><body>Web bundle</body></html>';
const execFileAsync = promisify(execFile);

describe('combined Web server', () => {
  let webRoot = '';
  let baseUrl = '';

  beforeAll(async () => {
    webRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-web-'));
    await writeFile(path.join(webRoot, 'index.html'), html);
    const server = await start({
      port: 0,
      host: '127.0.0.1',
      webRoot,
      dataDir: path.join(webRoot, '.data'),
      allowedRoots: [webRoot],
      defaultCwd: webRoot,
      enableMockProvider: true,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await stop();
    await rm(webRoot, { recursive: true, force: true });
  });

  it('serves the Web bundle from the root', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('AiHarness Test');
  });

  it('uses the Web entry point as the SPA fallback', async () => {
    const response = await fetch(`${baseUrl}/settings`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Web bundle');
  });

  it('keeps API routes available on the same port', async () => {
    const response = await fetch(`${baseUrl}/api/providers`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('openai');
  });

  it('publishes a grouped model catalogue and persists project activation', async () => {
    const initialResponse = await fetch(`${baseUrl}/api/models?projectId=model-project`);
    expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json() as {
      enabledScope: string;
      providers: Array<{ provider: string; configured: boolean; models: Array<{ key: string; id: string; enabled: boolean; capabilities: unknown }> }>;
    };
    const mock = initial.providers.find(provider => provider.provider === 'mock');
    expect(mock).toMatchObject({ configured: true });
    expect(mock?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'mock:mock-model', enabled: true, capabilities: expect.any(Object) }),
    ]));

    const updateResponse = await fetch(`${baseUrl}/api/models/enabled`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'model-project', enabledModels: ['mock:mock-model'] }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json() as typeof initial;
    expect(updated.enabledScope).toBe('project');
    expect(updated.providers.flatMap(provider => provider.models).filter(model => model.enabled).map(model => model.key))
      .toEqual(['mock:mock-model']);

    const invalid = await fetch(`${baseUrl}/api/models/enabled`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'model-project', enabledModels: ['unknown:model'] }),
    });
    expect(invalid.status).toBe(400);
  });

  it('manages custom providers/models, tool settings, and Web Push subscriptions without exposing secrets', async () => {
    const providerResponse = await fetch(`${baseUrl}/api/provider-registry/custom`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'http-custom', name: 'HTTP Custom', baseUrl: 'https://models.example/v1',
        dialect: 'openai-completions', apiKey: 'route-secret', headers: { 'X-Private': 'header-secret' },
      }),
    });
    expect(providerResponse.status).toBe(201);
    const providerBody = await providerResponse.json() as Record<string, unknown>;
    expect(providerBody).toMatchObject({ id: 'http-custom', configured: true, headerNames: ['X-Private'] });
    expect(JSON.stringify(providerBody)).not.toContain('route-secret');
    expect(JSON.stringify(providerBody)).not.toContain('header-secret');

    const modelResponse = await fetch(`${baseUrl}/api/provider-registry/models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', id: 'gpt-4o', pricing: { inputPerMillion: 2, cacheReadPerMillion: 1 } }),
    });
    expect(modelResponse.status).toBe(201);
    expect(await modelResponse.json()).toMatchObject({
      key: 'openai:gpt-4o', name: 'GPT-4o', contextWindow: 128000,
      pricing: { inputPerMillion: 2, cacheReadPerMillion: 1 },
    });

    const workspace = await fetch(`${baseUrl}/api/workspaces/default`).then(response => response.json()) as { id: string };
    const tools = await fetch(`${baseUrl}/api/tools?cwd=${encodeURIComponent(webRoot)}&projectId=${workspace.id}`)
      .then(response => response.json()) as { tools: Array<{ name: string; extensionId: string }> };
    expect(tools.tools
      .filter(tool => tool.extensionId === 'builtin:workspace-tools')
      .map(tool => tool.name))
      .toEqual([
        'read', 'write', 'edit', 'ls', 'find', 'grep', 'bash',
        ...(process.platform === 'win32' ? ['powershell'] : []),
      ]);
    const toolUpdate = await fetch(`${baseUrl}/api/tools`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: webRoot, projectId: workspace.id, toolPreset: 'read-only', powershellEnabled: false,
        enabledTools: tools.tools.map(tool => tool.name),
      }),
    });
    expect(toolUpdate.status).toBe(200);
    expect(await toolUpdate.json()).toMatchObject({ preset: 'read-only', powershellEnabled: false });

    const pushKey = await fetch(`${baseUrl}/api/push/public-key`).then(response => response.json()) as { publicKey: string };
    expect(pushKey.publicKey.length).toBeGreaterThan(20);
    const endpoint = 'https://push.example.test/http-test';
    const subscribed = await fetch(`${baseUrl}/api/push/subscribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: 'client-key', auth: 'auth-key' } }, categories: ['attention'] }),
    });
    expect(subscribed.status).toBe(201);
    const unsubscribed = await fetch(`${baseUrl}/api/push/subscribe`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }),
    });
    expect(unsubscribed.status).toBe(200);

    const deleted = await fetch(`${baseUrl}/api/provider-registry/custom/http-custom`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const deletedModel = await fetch(`${baseUrl}/api/provider-registry/models/${encodeURIComponent('openai:gpt-4o')}`, { method: 'DELETE' });
    expect(deletedModel.status).toBe(200);
  });

  it('discovers scoped skills, protects project instructions with trust and persists model invocation', async () => {
    await mkdir(path.join(webRoot, '.data', 'skills', 'global-review'), { recursive: true });
    await writeFile(path.join(webRoot, '.data', 'skills', 'global-review', 'SKILL.md'), [
      '---', 'name: global-review', 'description: Global review', '---', 'Never exposed instructions',
    ].join('\n'));
    await mkdir(path.join(webRoot, '.agents', 'skills', 'project-review'), { recursive: true });
    await writeFile(path.join(webRoot, '.agents', 'skills', 'project-review', 'SKILL.md'), [
      '---', 'name: project-review', 'description: Project review', '---', 'Trusted project instructions',
    ].join('\n'));
    const workspace = await fetch(`${baseUrl}/api/workspaces/default`).then(response => response.json()) as { id: string };
    const catalogResponse = await fetch(`${baseUrl}/api/skills?cwd=${encodeURIComponent(webRoot)}&projectId=${workspace.id}&refresh=true`);
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as {
      projectTrusted: boolean;
      enabledScope: string;
      skills: Array<{ key: string; name: string; scope: string; trusted: boolean; modelInvocable: boolean }>;
    };
    expect(JSON.stringify(catalog)).not.toContain('Never exposed instructions');
    expect(catalog.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'global-review', scope: 'global', trusted: true, modelInvocable: true }),
      expect.objectContaining({ name: 'project-review', scope: 'project', trusted: false, modelInvocable: false }),
    ]));
    const globalKey = catalog.skills.find(skill => skill.name === 'global-review')!.key;
    const projectKey = catalog.skills.find(skill => skill.name === 'project-review')!.key;

    const unknown = await fetch(`${baseUrl}/api/skills/enabled`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, projectId: workspace.id, enabledSkills: ['unknown:key'] }),
    });
    expect(unknown.status).toBe(400);
    const globalResponse = await fetch(`${baseUrl}/api/skills/enabled`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, enabledSkills: [globalKey] }),
    });
    expect(globalResponse.status).toBe(200);
    expect((await globalResponse.json() as { enabledScope: string }).enabledScope).toBe('global');
    const rejected = await fetch(`${baseUrl}/api/skills/enabled`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, projectId: workspace.id, enabledSkills: [projectKey] }),
    });
    expect(rejected.status).toBe(409);
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
    const updatedResponse = await fetch(`${baseUrl}/api/skills/enabled`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, projectId: workspace.id, enabledSkills: [globalKey, projectKey] }),
    });
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json() as typeof catalog;
    expect(updated.enabledScope).toBe('project');
    expect(updated.skills.filter(skill => skill.modelInvocable).map(skill => skill.name))
      .toEqual(['global-review', 'project-review']);
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
  });

  it('manages trusted project plugins explicitly and atomically reloads package skills', async () => {
    const pluginRoot = path.join(webRoot, 'http-plugin');
    await mkdir(path.join(pluginRoot, 'extensions'), { recursive: true });
    await mkdir(path.join(pluginRoot, 'skills', 'http-plugin-review'), { recursive: true });
    await writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'http-plugin', version: '1.0.0', description: 'HTTP plugin fixture',
      aiHarness: { extensions: ['extensions/*.js'], skills: ['skills'] },
    }));
    await writeFile(path.join(pluginRoot, 'extensions', 'index.js'), 'export default () => undefined;');
    await writeFile(path.join(pluginRoot, 'skills', 'http-plugin-review', 'SKILL.md'), [
      '---', 'name: http-plugin-review', 'description: Review plugin HTTP APIs', '---', 'Private package instructions',
    ].join('\n'));
    const workspace = await fetch(`${baseUrl}/api/workspaces/default`).then(response => response.json()) as { id: string };
    const baseInput = { cwd: webRoot, projectId: workspace.id, scope: 'project' };

    const invalid = await fetch(`${baseUrl}/api/plugins`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'install', ...baseInput, source: './relative-plugin' }),
    });
    expect(invalid.status).toBe(400);
    const locked = await fetch(`${baseUrl}/api/plugins`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'install', ...baseInput, source: pluginRoot }),
    });
    expect(locked.status).toBe(409);

    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
    const installResponse = await fetch(`${baseUrl}/api/plugins`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'install', ...baseInput, source: pluginRoot }),
    });
    expect(installResponse.status).toBe(200);
    const installed = await installResponse.json() as {
      packages: Array<{ key: string; counts: Record<string, number>; status: string; restartRequired: boolean }>;
      generation: number;
    };
    expect(installed.packages).toEqual([
      expect.objectContaining({
        counts: { extensions: 1, skills: 1, prompts: 0, themes: 0 },
        status: 'active', restartRequired: true,
      }),
    ]);
    expect(JSON.stringify(installed)).not.toContain('Private package instructions');
    const key = installed.packages[0]!.key;

    const skills = await fetch(`${baseUrl}/api/skills?cwd=${encodeURIComponent(webRoot)}&projectId=${workspace.id}&refresh=true`)
      .then(response => response.json()) as { skills: Array<{ name: string; scope: string }> };
    expect(skills.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'http-plugin-review', scope: 'package' }),
    ]));
    const checkResponse = await fetch(`${baseUrl}/api/plugins/check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseInput, key }),
    });
    expect(checkResponse.status).toBe(200);
    expect(await checkResponse.json()).toMatchObject({ updates: [expect.objectContaining({ state: 'unsupported' })] });

    const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Plugin reload session', cwd: webRoot }),
    });
    const session = await sessionResponse.json() as { id: string };
    const reloadResponse = await fetch(`${baseUrl}/api/plugins/reload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseInput, sessionId: session.id }),
    });
    expect(reloadResponse.status).toBe(200);
    expect(await reloadResponse.json()).toMatchObject({
      reload: { generation: expect.any(Number), sessionId: session.id, restartRequired: false, loadedExtensions: 1 },
    });

    const persistedSessionId = 'plugin-persisted-reload';
    const timestamp = Date.now();
    await writeFile(path.join(webRoot, '.data', 'sessions', `${persistedSessionId}.jsonl`), `${JSON.stringify({
      id: 'session-metadata',
      type: 'metadata',
      version: 2,
      schemaVersion: 2,
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      title: 'Persisted plugin reload',
      cwd: webRoot,
      workspaceId: workspace.id,
    })}\n`);
    const persistedReloadResponse = await fetch(`${baseUrl}/api/plugins/reload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseInput, sessionId: persistedSessionId }),
    });
    expect(persistedReloadResponse.status).toBe(200);
    expect(await persistedReloadResponse.json()).toMatchObject({
      reload: { generation: expect.any(Number), sessionId: persistedSessionId, restartRequired: false },
    });
    const mismatchedReloadResponse = await fetch(`${baseUrl}/api/plugins/reload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseInput, projectId: 'a'.repeat(24), sessionId: persistedSessionId }),
    });
    expect(mismatchedReloadResponse.status).toBe(409);
    expect(await mismatchedReloadResponse.json()).toMatchObject({ code: 'SESSION_WORKSPACE_MISMATCH' });

    const disableResponse = await fetch(`${baseUrl}/api/plugins`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'disable', ...baseInput, key }),
    });
    expect(disableResponse.status).toBe(200);
    expect(await disableResponse.json()).toMatchObject({ packages: [expect.objectContaining({ enabled: false })] });
    const disabledSkills = await fetch(`${baseUrl}/api/skills?cwd=${encodeURIComponent(webRoot)}&projectId=${workspace.id}&refresh=true`)
      .then(response => response.json()) as { skills: Array<{ name: string }> };
    expect(disabledSkills.skills.some(skill => skill.name === 'http-plugin-review')).toBe(false);

    const removeResponse = await fetch(`${baseUrl}/api/plugins`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', ...baseInput, key }),
    });
    expect(removeResponse.status).toBe(200);
    expect((await removeResponse.json() as { packages: unknown[] }).packages).toEqual([]);
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
  });

  it('manages sub-agent profiles and executes linked background children', async () => {
    const workspace = await fetch(`${baseUrl}/api/workspaces/default`).then(response => response.json()) as { id: string };
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
    const query = `cwd=${encodeURIComponent(webRoot)}&projectId=${workspace.id}`;
    const defaultsResponse = await fetch(`${baseUrl}/api/subagents/settings?${query}`);
    expect(defaultsResponse.status).toBe(200);
    const defaults = await defaultsResponse.json() as { profiles: Array<{ id: string }>; maxConcurrency: number };
    expect(defaults.profiles.map(profile => profile.id)).toEqual(['explore', 'general', 'plan']);

    const configuredResponse = await fetch(`${baseUrl}/api/subagents/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, projectId: workspace.id, maxConcurrency: 2 }),
    });
    expect(configuredResponse.status).toBe(200);
    expect((await configuredResponse.json() as { maxConcurrency: number }).maxConcurrency).toBe(2);
    const profileResponse = await fetch(`${baseUrl}/api/subagents/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: webRoot, projectId: workspace.id,
        profile: {
          id: 'http-review', name: 'HTTP review', description: 'Review through HTTP',
          instructions: 'Return a concise review.', kind: 'custom', enabled: true,
          tools: ['read'], skills: [], extensions: [], maxTurns: 4,
          inheritContext: true, background: true,
        },
      }),
    });
    expect(profileResponse.status).toBe(201);
    const parentResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Subagent parent', cwd: webRoot }),
    });
    const parent = await parentResponse.json() as { id: string };
    const runResponse = await fetch(`${baseUrl}/api/subagents/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionId: parent.id, profileId: 'http-review', task: 'Inspect HTTP behavior',
        provider: 'mock', background: true,
      }),
    });
    expect(runResponse.status).toBe(202);
    const started = await runResponse.json() as { id: string; childSessionId: string };
    let completed: { status: string; output?: string; attention?: boolean } | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      completed = await fetch(`${baseUrl}/api/subagents/runs/${started.id}`).then(response => response.json());
      if (['completed', 'failed', 'stopped'].includes(completed!.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(completed).toMatchObject({ status: 'completed', attention: true });
    expect(completed?.output).toContain('Mock AI Response');
    const child = await fetch(`${baseUrl}/api/sessions/${started.childSessionId}`).then(response => response.json()) as {
      parentId: string; metadata: Record<string, unknown>;
    };
    expect(child).toMatchObject({ parentId: parent.id, metadata: expect.objectContaining({ subagent: true }) });
    const capabilities = await fetch(`${baseUrl}/api/agent/sessions/${parent.id}/capabilities`).then(response => response.json()) as {
      tools: Array<{ name: string }>;
    };
    expect(capabilities.tools.map(tool => tool.name)).toContain('spawn_subagent');
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
  });

  it('reports Web and agent versions without forcing remote updates', async () => {
    vi.stubEnv('AI_HARNESS_DISABLE_UPDATE_CHECK', '1');
    const response = await fetch(`${baseUrl}/api/app-update`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      webVersion: '0.1.0', agentVersion: '0.1.0', available: false,
      error: { code: 'disabled' },
    });
  });

  it('registers the fixed session tree route before the dynamic session route', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/tree`);
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  it('covers the complete session HTTP lifecycle', async () => {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'HTTP lifecycle' }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { id: string };

    const emptyAutoName = await fetch(`${baseUrl}/api/sessions/${created.id}/auto-name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'mock' }),
    });
    expect(emptyAutoName.status).toBe(409);

    const messageResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: '<script>unsafe</script>' }),
    });
    expect(messageResponse.status).toBe(201);
    const persistedMessage = await messageResponse.json() as { id: string };

    const autoNameResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/auto-name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'mock', model: 'mock-model' }),
    });
    expect(autoNameResponse.status).toBe(200);
    expect(await autoNameResponse.json()).toMatchObject({ id: created.id, title: '[Mock AI Response]' });

    const renameResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed session' }),
    });
    expect(renameResponse.status).toBe(200);

    const getResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    expect(await getResponse.json()).toMatchObject({
      id: created.id,
      title: 'Renamed session',
      messages: [{ role: 'user', content: '<script>unsafe</script>' }],
    });

    const forkResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: persistedMessage.id, title: 'Forked' }),
    });
    expect(forkResponse.status).toBe(201);
    const forked = await forkResponse.json() as { id: string };
    const nestedForkResponse = await fetch(`${baseUrl}/api/sessions/${forked.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex: 0, title: 'Nested fork' }),
    });
    expect(nestedForkResponse.status).toBe(201);
    const nestedFork = await nestedForkResponse.json() as { id: string };

    const cloneResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cloned', messageId: persistedMessage.id }),
    });
    expect(cloneResponse.status).toBe(201);
    const cloned = await cloneResponse.json() as { id: string };

    const treeResponse = await fetch(`${baseUrl}/api/sessions/tree?branchId=${created.id}`);
    const tree = await treeResponse.json() as Array<{ id: string; depth: number; messageCount: number }>;
    expect(tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, depth: 0, messageCount: 1 }),
      expect.objectContaining({ id: forked.id, depth: 1, messageCount: 1 }),
      expect.objectContaining({ id: nestedFork.id, depth: 2, messageCount: 1 }),
    ]));

    const shareResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlHours: 2 }),
    });
    expect(shareResponse.status).toBe(201);
    const share = await shareResponse.json() as { url: string; expiresInHours: number };
    expect(share.expiresInHours).toBe(2);
    const publicPage = await fetch(share.url);
    expect(await publicPage.text()).toContain('&lt;script&gt;unsafe&lt;/script&gt;');

    const listResponse = await fetch(`${baseUrl}/api/sessions`);
    const sessions = await listResponse.json() as Array<{ id: string }>;
    expect(sessions.some(session => session.id === created.id)).toBe(true);

    const refusedDelete = await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: 'DELETE' });
    expect(refusedDelete.status).toBe(409);
    const conflict = await refusedDelete.json() as { code: string; descendants: Array<{ id: string }> };
    expect(conflict.code).toBe('CASCADE_CONFIRMATION_REQUIRED');
    expect(conflict.descendants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: forked.id }),
      expect.objectContaining({ id: nestedFork.id }),
    ]));

    const deleteResponse = await fetch(`${baseUrl}/api/sessions/${created.id}?cascade=true`, { method: 'DELETE' });
    expect(await deleteResponse.json()).toMatchObject({ success: true, deletedCount: 3 });
    expect((await fetch(`${baseUrl}/api/sessions/${created.id}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/sessions/${nestedFork.id}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/sessions/${cloned.id}`)).status).toBe(200);
    await fetch(`${baseUrl}/api/sessions/${cloned.id}`, { method: 'DELETE' });
  });

  it('runs a trusted detached mock agent, replays events, and persists its result', async () => {
    const blocked = await fetch(`${baseUrl}/api/agent/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, provider: 'mock', input: 'must not persist' }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    const trust = await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
    expect(trust.status).toBe(200);

    const startResponse = await fetch(`${baseUrl}/api/agent/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, provider: 'mock', input: 'integration agent' }),
    });
    expect(startResponse.status).toBe(202);
    const started = await startResponse.json() as {
      run: { id: string; sessionId: string };
      session: { title?: string };
    };
    expect(started.session.title).toBe('integration agent');

    let state: { run?: { phase: string }; session: { messages: Array<{ role: string; content: string }> } } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await fetch(`${baseUrl}/api/agent/sessions/${started.run.sessionId}/state`).then(response => response.json()) as typeof state;
      if (state?.run?.phase === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(state?.run?.phase).toBe('completed');
    expect(state?.session.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'integration agent' }),
      expect.objectContaining({ role: 'assistant', content: '[Mock AI Response]' }),
    ]));

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/agent/sessions/${started.run.sessionId}/events?after=0`, {
      signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    let replay = '';
    for (let attempt = 0; attempt < 20 && !replay.includes('run.completed'); attempt++) {
      const chunk = await reader.read();
      replay += new TextDecoder().decode(chunk.value);
      if (chunk.done) break;
    }
    controller.abort();
    expect(replay).toContain('event: connection.ready');
    expect(replay).toContain('event: run.completed');
    expect(replay).toContain('"sequence":');
  });

  it('reports the exact tools enabled by each session preset', async () => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Capabilities', cwd: webRoot }),
    }).then(response => response.json()) as { id: string };
    await fetch(`${baseUrl}/api/sessions/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolPreset: 'chat-only' }),
    });
    const chatOnly = await fetch(`${baseUrl}/api/agent/sessions/${created.id}/capabilities`).then(response => response.json()) as { tools: unknown[] };
    expect(chatOnly.tools).toEqual([]);

    await fetch(`${baseUrl}/api/sessions/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolPreset: 'read-only' }),
    });
    const readOnly = await fetch(`${baseUrl}/api/agent/sessions/${created.id}/capabilities`).then(response => response.json()) as { tools: Array<{ name: string }> };
    expect(readOnly.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'read', 'grep', 'find', 'ls', 'load_skill',
    ]));
    expect(readOnly.tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining([
      'edit', 'write', 'bash',
    ]));
    await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: 'DELETE' });
  });

  it('bounds file access to a trusted workspace and exposes source, index, Git fallback, and upload', async () => {
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
    await writeFile(path.join(webRoot, 'source.ts'), 'export const value = 1;\n');
    await mkdir(path.join(webRoot, 'nested'));
    await writeFile(path.join(webRoot, 'nested', 'guide.md'), '# Guide\n');
    const listing = await fetch(`${baseUrl}/api/files?cwd=${encodeURIComponent(webRoot)}&path=.`);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ entries: expect.arrayContaining([
      expect.objectContaining({ name: 'source.ts', isDirectory: false }),
    ]) });

    const content = await fetch(`${baseUrl}/api/files/content?cwd=${encodeURIComponent(webRoot)}&path=source.ts`);
    expect(await content.json()).toMatchObject({ language: 'typescript', lineCount: 2, content: 'export const value = 1;\n' });
    await writeFile(path.join(webRoot, 'large.log'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    const tooLarge = await fetch(`${baseUrl}/api/files/content?cwd=${encodeURIComponent(webRoot)}&path=large.log`);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ path: 'large.log', tooLarge: true, downloadable: true });
    expect((await fetch(`${baseUrl}/api/files/content?cwd=${encodeURIComponent(webRoot)}&path=..`)).status).toBe(403);

    const index = await fetch(`${baseUrl}/api/files/index?cwd=${encodeURIComponent(webRoot)}&q=sre`).then(response => response.json()) as { files: string[]; directories: string[] };
    expect(index.files).toContain('source.ts');
    const directories = await fetch(`${baseUrl}/api/files/index?cwd=${encodeURIComponent(webRoot)}&q=nest&limit=1`).then(response => response.json()) as { directories: string[] };
    expect(directories.directories).toContain('nested/');
    const git = await fetch(`${baseUrl}/api/files/git/status?cwd=${encodeURIComponent(webRoot)}`).then(response => response.json()) as { repository: boolean };
    expect(git.repository).toBe(false);

    const upload = await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, path: '.', files: [{ name: 'upload.txt', content: Buffer.from('uploaded').toString('base64') }] }),
    });
    expect(upload.status).toBe(201);
    expect(await upload.json()).toMatchObject({ files: ['upload.txt'], collision: 'reject' });
  });

  it('annotates a Git tree, handles tracked/untracked diffs, upload collisions, and file watches', async () => {
    const repository = path.join(webRoot, 'git-fixture');
    await mkdir(repository, { recursive: true });
    await execFileAsync('git', ['init', '-q', repository]);
    await execFileAsync('git', ['-C', repository, 'config', 'user.email', 'tests@example.invalid']);
    await execFileAsync('git', ['-C', repository, 'config', 'user.name', 'AiHarness tests']);
    await writeFile(path.join(repository, 'tracked.txt'), 'before\n');
    await writeFile(path.join(repository, 'deleted.txt'), 'removed content\n');
    await writeFile(path.join(repository, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(repository, 'renamed-old.txt'), 'renamed\n');
    await execFileAsync('git', ['-C', repository, 'add', 'tracked.txt', 'deleted.txt', 'binary.bin', 'renamed-old.txt']);
    await execFileAsync('git', ['-C', repository, 'commit', '-qm', 'fixture']);
    await writeFile(path.join(repository, 'tracked.txt'), 'before\nafter\n');
    await writeFile(path.join(repository, 'binary.bin'), Buffer.from([0, 4, 5, 6]));
    await writeFile(path.join(repository, 'untracked.txt'), 'new file\n');
    await rm(path.join(repository, 'deleted.txt'));
    await execFileAsync('git', ['-C', repository, 'mv', 'renamed-old.txt', 'renamed-new.txt']);
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repository, confirm: true }),
    });

    const listing = await fetch(`${baseUrl}/api/files?cwd=${encodeURIComponent(repository)}&path=.`).then(response => response.json()) as {
      entries: Array<{ name: string; gitStatus?: string }>;
    };
    expect(listing.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'tracked.txt', gitStatus: 'modified' }),
      expect.objectContaining({ name: 'untracked.txt', gitStatus: 'untracked' }),
      expect.objectContaining({ name: 'binary.bin', gitStatus: 'modified' }),
      expect.objectContaining({ name: 'renamed-new.txt', gitStatus: 'renamed' }),
    ]));
    const status = await fetch(`${baseUrl}/api/files/git/status?cwd=${encodeURIComponent(repository)}`).then(response => response.json()) as {
      files: Array<{ path: string; originalPath?: string; additions?: number; deletions?: number }>;
    };
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', additions: 1, deletions: 0 }),
      expect.objectContaining({ path: 'deleted.txt', deletions: 1 }),
      expect.objectContaining({ path: 'renamed-new.txt', originalPath: 'renamed-old.txt' }),
    ]));
    expect(await fetch(`${baseUrl}/api/files/git/diff?cwd=${encodeURIComponent(repository)}&path=tracked.txt`).then(response => response.text()))
      .toContain('+after');
    expect(await fetch(`${baseUrl}/api/files/git/diff?cwd=${encodeURIComponent(repository)}&path=untracked.txt`).then(response => response.text()))
      .toContain('+new file');
    expect(await fetch(`${baseUrl}/api/files/git/diff?cwd=${encodeURIComponent(repository)}&path=deleted.txt`).then(response => response.text()))
      .toContain('-removed content');
    expect(await fetch(`${baseUrl}/api/files/git/diff?cwd=${encodeURIComponent(repository)}&path=binary.bin`).then(response => response.json()))
      .toMatchObject({ path: 'binary.bin', binary: true });

    const collision = await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repository, path: '.', collision: 'reject', files: [{ name: 'tracked.txt', content: Buffer.from('x').toString('base64') }] }),
    });
    expect(collision.status).toBe(409);
    const renamed = await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repository, path: '.', collision: 'rename', files: [{ name: 'tracked.txt', content: Buffer.from('copy').toString('base64') }] }),
    });
    expect(await renamed.json()).toMatchObject({ files: ['tracked (1).txt'], collision: 'rename' });

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/files/watch?cwd=${encodeURIComponent(repository)}&path=tracked.txt`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    let events = new TextDecoder().decode((await reader.read()).value);
    await writeFile(path.join(repository, 'tracked.txt'), 'changed again\n');
    for (let attempt = 0; attempt < 20 && !events.includes('file.changed'); attempt++) {
      events += new TextDecoder().decode((await reader.read()).value);
    }
    controller.abort();
    expect(events).toContain('event: connection.ready');
    expect(events).toContain('event: file.changed');
  });

  it('creates, lists, and removes a disposable Git worktree through the real API', async () => {
    const repository = path.join(webRoot, 'worktree-repository');
    const checkout = path.join(webRoot, 'worktree-checkout');
    await mkdir(repository, { recursive: true });
    await execFileAsync('git', ['init', '-q', repository]);
    await execFileAsync('git', ['-C', repository, 'config', 'user.email', 'tests@example.invalid']);
    await execFileAsync('git', ['-C', repository, 'config', 'user.name', 'AiHarness tests']);
    await writeFile(path.join(repository, 'README.md'), '# disposable worktree\n');
    await execFileAsync('git', ['-C', repository, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repository, 'commit', '-qm', 'fixture']);
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repository, confirm: true }),
    });

    const created = await fetch(`${baseUrl}/api/workspaces/worktrees`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repository, path: checkout, branch: 'integration-worktree', createBranch: true }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ cwd: checkout, git: { branch: 'integration-worktree' } });
    const listed = await fetch(`${baseUrl}/api/workspaces/worktrees?cwd=${encodeURIComponent(repository)}`)
      .then(response => response.json()) as Array<{ path: string; branch?: string }>;
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: checkout, branch: 'integration-worktree' }),
    ]));

    const removed = await fetch(`${baseUrl}/api/workspaces/worktrees`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repository, path: checkout, confirm: true }),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true });
    expect(await fetch(`${baseUrl}/api/workspaces/worktrees?cwd=${encodeURIComponent(repository)}`)
      .then(response => response.json())).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: checkout })]));
  });

  it('searches exact entries and serves bounded history, diagnostics, and exports', async () => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Search target', cwd: webRoot }),
    }).then(response => response.json()) as { id: string };
    for (const [index, content] of ['alpha', 'needle in the transcript', 'omega'].entries()) {
      await fetch(`${baseUrl}/api/sessions/${created.id}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'user', content,
          ...(index === 1 ? { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5, totalTokens: 120, costUsd: 0.004 } } : {}),
        }),
      });
    }
    const search = await fetch(`${baseUrl}/api/sessions/search?q=needle&cwd=${encodeURIComponent(webRoot)}`).then(response => response.json()) as {
      count: number; results: Array<{ sessionId: string; messageId: string }>;
    };
    expect(search).toMatchObject({ count: 1, results: [expect.objectContaining({ sessionId: created.id, messageId: expect.any(String) })] });
    const page = await fetch(`${baseUrl}/api/sessions/${created.id}/messages?limit=2`).then(response => response.json()) as {
      messages: Array<{ id: string; content: string }>; hasMore: boolean; nextBefore: string; total: number;
    };
    expect(page).toMatchObject({ messages: expect.any(Array), hasMore: true, total: 3, nextBefore: expect.any(String) });
    expect(page.messages).toHaveLength(2);
    const previous = await fetch(`${baseUrl}/api/sessions/${created.id}/messages?limit=2&before=${encodeURIComponent(page.nextBefore)}`)
      .then(response => response.json()) as { messages: Array<{ content: string }>; start: number; end: number };
    expect(previous).toMatchObject({ start: 0, end: 1, messages: [{ content: 'alpha' }] });
    const target = await fetch(`${baseUrl}/api/sessions/${created.id}/messages?limit=1&around=${encodeURIComponent(search.results[0]!.messageId)}`)
      .then(response => response.json()) as { messages: Array<{ content: string }>; targetIndex: number };
    expect(target).toMatchObject({ targetIndex: 1, messages: [{ content: 'needle in the transcript' }] });
    const summaries = await fetch(`${baseUrl}/api/sessions?cwd=${encodeURIComponent(webRoot)}&messageLimit=0&includeCommands=false`)
      .then(response => response.json()) as Array<{ id: string; messages: unknown[]; messagePage: { total: number } }>;
    expect(summaries.find(session => session.id === created.id)).toMatchObject({
      messages: [], messagePage: { total: 3 },
    });
    expect(await fetch(`${baseUrl}/api/sessions/${created.id}/info`).then(response => response.json())).toMatchObject({
      id: created.id,
      counts: { user: 3, toolCalls: 0, toolResults: 0, total: 3 },
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5, totalTokens: 120, costUsd: 0.004 },
      cacheHitRate: 0.4,
      cwd: webRoot,
    });
    const exported = await fetch(`${baseUrl}/api/sessions/${created.id}/export?format=markdown`);
    expect(exported.headers.get('content-disposition')).toContain('attachment');
    expect(await exported.text()).toContain('needle in the transcript');
    await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: 'DELETE' });
  });

  it('runs a detached terminal command and replays progressive output', async () => {
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
    const session = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: webRoot }),
    }).then(response => response.json()) as { id: string };
    const started = await fetch(`${baseUrl}/api/agent/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, cwd: webRoot, command: "printf 'terminal-output'", excludedFromContext: false }),
    });
    expect(started.status).toBe(202);
    const command = await started.json() as { id: string };
    let snapshot: { status: string; output: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = await fetch(`${baseUrl}/api/agent/commands/${command.id}`).then(response => response.json()) as typeof snapshot;
      if (snapshot?.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(snapshot).toMatchObject({ status: 'completed', output: 'terminal-output' });
    const events = await fetch(`${baseUrl}/api/agent/commands/${command.id}/events?after=0`).then(response => response.text());
    expect(events).toContain('event: output');
    expect(events).toContain('terminal-output');
    expect(events).toContain('event: exit');
    await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
  });

  it('hosts an interactive PTY with input, resize, replay offsets, and explicit termination', async () => {
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
    const created = await fetch(`${baseUrl}/api/terminals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, cols: 88, rows: 22, name: 'Integration PTY' }),
    });
    expect(created.status).toBe(201);
    const terminal = await created.json() as { id: string; status: string; cols: number; rows: number };
    expect(terminal).toMatchObject({ status: 'running', cols: 88, rows: 22 });

    const resized = await fetch(`${baseUrl}/api/terminals/${terminal.id}/resize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    expect(await resized.json()).toMatchObject({ cols: 100, rows: 30 });
    expect((await fetch(`${baseUrl}/api/terminals/${terminal.id}/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: "printf 'pty-ready\\n'\r" }),
    })).status).toBe(200);

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/terminals/${terminal.id}/events?after=0`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    let replay = '';
    for (let attempt = 0; attempt < 30 && !replay.includes('pty-ready'); attempt++) {
      const chunk = await reader.read();
      replay += new TextDecoder().decode(chunk.value);
      if (chunk.done) break;
    }
    controller.abort();
    expect(replay).toContain('event: connection.ready');
    expect(replay).toContain('event: output');
    expect(replay).toContain('pty-ready');
    expect(replay).toMatch(/"endOffset":\d+/);

    const revoked = await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
    expect(revoked.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/terminals/${terminal.id}/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'pwd\r' }),
    })).status).toBe(409);
    const closed = await fetch(`${baseUrl}/api/terminals/${terminal.id}`, { method: 'DELETE' });
    expect(await closed.json()).toMatchObject({ status: 'killed' });
    expect((await fetch(`${baseUrl}/api/terminals/${terminal.id}`)).status).toBe(404);
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
  });

  it('compacts conversation history and exposes lifecycle events for replay', async () => {
    const session = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Compaction', cwd: webRoot }),
    }).then(response => response.json()) as { id: string };
    for (const content of ['one', 'two', 'three', 'four']) {
      await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'user', content }),
      });
    }
    const response = await fetch(`${baseUrl}/api/agent/sessions/${session.id}/compact`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'mock', instruction: 'Keep decisions.' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      summary: '[Mock AI Response]', tokensBefore: expect.any(Number), tokensAfter: expect.any(Number),
      session: { metadata: { compactionSummary: '[Mock AI Response]' } },
    });

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/agent/sessions/${session.id}/events?after=0`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    let replay = '';
    for (let attempt = 0; attempt < 10 && !replay.includes('compaction.completed'); attempt++) {
      const chunk = await reader.read();
      replay += new TextDecoder().decode(chunk.value);
      if (chunk.done) break;
    }
    controller.abort();
    expect(replay).toContain('compaction.started');
    expect(replay).toContain('compaction.completed');
    await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
  });

  it('supports expiring HttpOnly Web sessions while retaining bearer roles', async () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-token');
    vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin-token');
    expect(await fetch(`${baseUrl}/api/auth/status`).then(response => response.json())).toMatchObject({
      required: true, authenticated: false,
    });
    expect((await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' },
      body: JSON.stringify({ token: 'admin-token' }),
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }),
    })).status).toBe(401);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'admin-token' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toContain('aih_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } }).then(response => response.json()))
      .toMatchObject({ authenticated: true, role: 'admin', expiresAt: expect.any(String) });
    expect((await fetch(`${baseUrl}/api/providers`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } })).status).toBe(200);
    expect(await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } }).then(response => response.json()))
      .toMatchObject({ authenticated: false });
    const secureLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ token: 'admin-token' }),
    });
    expect(secureLogin.headers.get('set-cookie')).toContain('Secure');
  });

  it('enforces user and administrator API permissions', async () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-token');
    vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin-token');

    expect((await fetch(`${baseUrl}/api/providers`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/providers`, {
      headers: { Authorization: 'Bearer user-token' },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/models`, {
      headers: { Authorization: 'Bearer user-token' },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/models/enabled`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledModels: ['mock:mock-model'] }),
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/skills`, {
      headers: { Authorization: 'Bearer user-token' },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/skills/enabled`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledSkills: [] }),
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/subagents/settings`, {
      headers: { Authorization: 'Bearer user-token' },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/subagents/settings`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrency: 2 }),
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/agent/sessions/missing/events`, {
      headers: { Authorization: 'Bearer user-token' },
    })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/terminals`, {
      method: 'POST',
      headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot }),
    })).status).toBe(403);
    const adminTerminal = await fetch(`${baseUrl}/api/terminals`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot }),
    });
    expect(adminTerminal.status).not.toBe(401);
    expect(adminTerminal.status).not.toBe(403);
    if (adminTerminal.status === 201) {
      const terminal = await adminTerminal.json() as { id: string };
      await fetch(`${baseUrl}/api/terminals/${terminal.id}`, {
        method: 'DELETE', headers: { Authorization: 'Bearer admin-token' },
      });
    }
    expect((await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer user-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'openai', apiKey: 'not-persisted' }),
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/configuration/scope`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', values: { model: 'forbidden' } }),
    })).status).toBe(403);
    const configured = await fetch(`${baseUrl}/api/configuration/scope`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', values: { model: 'configured-model', autoCompaction: false } }),
    });
    expect(await configured.json()).toMatchObject({ values: { model: 'configured-model', autoCompaction: false } });
    expect(await fetch(`${baseUrl}/api/configuration/effective`, {
      headers: { Authorization: 'Bearer user-token' },
    }).then(response => response.json())).toMatchObject({
      values: { model: 'configured-model', autoCompaction: false },
      provenance: { model: { scope: 'global', source: 'global' } },
    });
    expect((await fetch(`${baseUrl}/api/configuration/scope`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', values: { apiKey: 'must-not-persist' } }),
    })).status).toBe(400);
    await fetch(`${baseUrl}/api/configuration/scope`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', values: {} }),
    });
  });

  it('resolves session settings with provenance and restores inheritance when overrides are cleared', async () => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Scoped settings', cwd: webRoot }),
    }).then(response => response.json()) as { id: string; workspaceId?: string };

    const updated = await fetch(`${baseUrl}/api/sessions/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'session-model', thinking: 'high', toolPreset: 'read-only', autoCompaction: false }),
    });
    expect(await updated.json()).toMatchObject({
      model: 'session-model', thinking: 'high', toolPreset: 'read-only', autoCompaction: false,
    });
    expect(await fetch(`${baseUrl}/api/configuration/effective?sessionId=${encodeURIComponent(created.id)}`)
      .then(response => response.json())).toMatchObject({
      values: { model: 'session-model', thinking: 'high', toolPreset: 'read-only', autoCompaction: false },
      provenance: {
        model: { scope: 'session', source: created.id },
        autoCompaction: { scope: 'session', source: created.id },
      },
    });

    const cleared = await fetch(`${baseUrl}/api/sessions/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: null, thinking: null, toolPreset: null, autoCompaction: null }),
    });
    expect(await cleared.json()).toMatchObject({ id: created.id });
    const inherited = await fetch(`${baseUrl}/api/configuration/effective?sessionId=${encodeURIComponent(created.id)}`)
      .then(response => response.json()) as { values: Record<string, unknown>; provenance: Record<string, { scope: string }> };
    expect(inherited.values).toMatchObject({ thinking: 'off', toolPreset: 'default', autoCompaction: true });
    expect(inherited.values.model).toBeUndefined();
    expect(inherited.provenance.autoCompaction?.scope).toBe('default');
    await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: 'DELETE' });
  });

  it('applies validated environment defaults as locked effective settings', async () => {
    vi.stubEnv('AI_HARNESS_DEFAULT_MODEL', 'environment-model');
    vi.stubEnv('AI_HARNESS_DEFAULT_THINKING', 'xhigh');
    vi.stubEnv('AI_HARNESS_DEFAULT_TOOL_PRESET', 'read-only');
    vi.stubEnv('AI_HARNESS_AUTO_COMPACTION', 'off');
    expect(await fetch(`${baseUrl}/api/configuration/effective`).then(response => response.json())).toMatchObject({
      values: {
        model: 'environment-model', thinking: 'xhigh', toolPreset: 'read-only', autoCompaction: false,
      },
      provenance: {
        model: { scope: 'environment', source: 'environment' },
        thinking: { scope: 'environment', source: 'environment' },
        toolPreset: { scope: 'environment', source: 'environment' },
        autoCompaction: { scope: 'environment', source: 'environment' },
      },
    });
  });

  it('delivers shared instructions, keeps effective settings ephemeral, and supports explicit session overrides', async () => {
    await fetch(`${baseUrl}/api/workspaces/trust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: webRoot, confirm: true }),
    });
    const projectInstructions = path.join(webRoot, 'AGENTS.override.md');
    const agentDirectory = path.join(webRoot, '.capture-agent');
    await writeFile(projectInstructions, 'ephemeral server-side project instructions');
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(path.join(agentDirectory, 'SYSTEM.md'), 'server-side global system prompt');
    await writeFile(path.join(agentDirectory, 'AGENTS.md'), 'server-side global context');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Inherited run', cwd: webRoot }),
    }).then(response => response.json()) as { id: string; workspaceId: string };
    await fetch(`${baseUrl}/api/configuration/scope`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project', scopeId: created.workspaceId,
        values: { model: 'project-model', thinking: 'high', toolPreset: 'chat-only', autoCompaction: false },
      }),
    });
    const waitForCompletion = async (): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await fetch(`${baseUrl}/api/agent/sessions/${created.id}/state`)
          .then(response => response.json()) as { run?: { phase?: string } };
        if (state.run?.phase === 'completed') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Agent run did not complete');
    };

    let capturedProviderBody: { messages?: Array<{ role?: string; content?: string }> } | undefined;
    const captureServer = createServer((request, response) => {
      let requestBody = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { requestBody += chunk; });
      request.on('end', () => {
        capturedProviderBody = JSON.parse(requestBody) as typeof capturedProviderBody;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: {"choices":[{"delta":{"content":"captured"}}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      captureServer.once('error', reject);
      captureServer.listen(0, '127.0.0.1', resolve);
    });
    const captureAddress = captureServer.address();
    if (!captureAddress || typeof captureAddress === 'string') throw new Error('Capture provider did not bind');
    try {
      const providerResponse = await fetch(`${baseUrl}/api/provider-registry/custom`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'instruction-capture',
          name: 'Instruction capture',
          baseUrl: `http://127.0.0.1:${captureAddress.port}/v1`,
          dialect: 'openai-completions',
          apiKey: 'capture-key',
        }),
      });
      expect(providerResponse.status).toBe(201);
      const captureRun = await fetch(`${baseUrl}/api/agent/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: created.id,
          cwd: webRoot,
          provider: 'instruction-capture',
          input: 'Capture instructions',
          settingOverrides: [],
        }),
      });
      expect(captureRun.status).toBe(202);
      await waitForCompletion();
      const deliveredSystemPrompt = capturedProviderBody?.messages
        ?.find(message => message.role === 'system')?.content;
      expect(deliveredSystemPrompt).toContain('server-side global system prompt');
      expect(deliveredSystemPrompt).toContain('server-side global context');
      expect(deliveredSystemPrompt).toContain('ephemeral server-side project instructions');
    } finally {
      await fetch(`${baseUrl}/api/provider-registry/custom/instruction-capture`, { method: 'DELETE' });
      await new Promise<void>((resolve, reject) => captureServer.close(error => error ? reject(error) : resolve()));
    }

    const inherited = await fetch(`${baseUrl}/api/agent/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.id, cwd: webRoot, provider: 'mock', input: 'Inherited settings',
        model: 'project-model', thinking: 'high', toolPreset: 'chat-only', autoCompaction: false,
        settingOverrides: [],
      }),
    }).then(response => response.json()) as {
      run: { model?: string }; session: Record<string, unknown>;
    };
    expect(inherited.run.model).toBe('project-model');
    expect(inherited.session).not.toHaveProperty('model');
    expect(inherited.session).not.toHaveProperty('thinking');
    expect(inherited.session).not.toHaveProperty('toolPreset');
    expect(inherited.session).not.toHaveProperty('autoCompaction');
    await waitForCompletion();
    const persistedAfterRun = await fetch(`${baseUrl}/api/sessions/${created.id}`).then(response => response.text());
    expect(persistedAfterRun).not.toContain('server-side global system prompt');
    expect(persistedAfterRun).not.toContain('server-side global context');
    expect(persistedAfterRun).not.toContain('ephemeral server-side project instructions');

    const explicit = await fetch(`${baseUrl}/api/agent/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.id, cwd: webRoot, provider: 'mock', input: 'Explicit settings',
        model: 'session-model', thinking: 'max', toolPreset: 'full', autoCompaction: true,
        settingOverrides: ['model', 'thinking', 'toolPreset', 'autoCompaction'],
      }),
    }).then(response => response.json()) as { session: Record<string, unknown> };
    expect(explicit.session).toMatchObject({
      model: 'session-model', thinking: 'max', toolPreset: 'full', autoCompaction: true,
    });
    await waitForCompletion();

    const restored = await fetch(`${baseUrl}/api/agent/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.id, cwd: webRoot, provider: 'mock', input: 'Restore inheritance',
        model: 'project-model', thinking: 'high', toolPreset: 'chat-only', autoCompaction: false,
        settingOverrides: [],
      }),
    }).then(response => response.json()) as { run: { model?: string }; session: Record<string, unknown> };
    expect(restored.run.model).toBe('project-model');
    expect(restored.session).not.toHaveProperty('model');
    expect(restored.session).not.toHaveProperty('autoCompaction');
    await waitForCompletion();

    const legacy = await fetch(`${baseUrl}/api/agent/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.id, cwd: webRoot, provider: 'mock', input: 'Legacy setting request',
        model: 'legacy-model', thinking: 'low',
      }),
    }).then(response => response.json()) as { run: { model?: string }; session: Record<string, unknown> };
    expect(legacy.run.model).toBe('legacy-model');
    expect(legacy.session).toMatchObject({ model: 'legacy-model', thinking: 'low' });
    await waitForCompletion();

    await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: 'DELETE' });
    await rm(projectInstructions, { force: true });
    await rm(agentDirectory, { recursive: true, force: true });
    await fetch(`${baseUrl}/api/configuration/scope`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', scopeId: created.workspaceId, values: {} }),
    });
  });

  it('rejects invalid session message and rename payloads', async () => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then(response => response.json()) as { id: string };

    expect((await fetch(`${baseUrl}/api/sessions/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'system', content: 'invalid' }),
    })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/sessions/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })).status).toBe(400);

    await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: 'DELETE' });
  });
});
