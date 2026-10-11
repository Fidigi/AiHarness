import { createServer, request as httpRequest } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, start, stop, type ServerConfig } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';
import { ConfigurationStore } from '../config/config-store.js';

const roots: string[] = [];
afterEach(async () => { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function directories() {
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'host-admin');
  vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'host-admin');
  vi.stubEnv('AI_HARNESS_PROVIDER_RENAME_EXCLUSIVE_HOST', '');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-provider-host-')); roots.push(root);
  const dataDir = path.join(root, 'data'); const cwd = path.join(root, 'workspace');
  await mkdir(dataDir); await mkdir(cwd);
  return { root, dataDir, cwd, config: { dataDir, defaultCwd: cwd, allowedRoots: [cwd], port: 0, host: '127.0.0.1' } satisfies ServerConfig };
}
async function fixture(exclusive = true) {
  const dirs = await directories();
  let servicesPromise!: Promise<RuntimeServices>;
  const config = { ...dirs.config, providerRenameExclusiveHost: exclusive,
    runtimeServicesFactory: (proxy: Parameters<typeof createRuntimeServices>[0], options: Parameters<typeof createRuntimeServices>[1]) => (servicesPromise = createRuntimeServices(proxy, options)),
  };
  createApp(config);
  const { port } = await start(); const services = await servicesPromise;
  await services.providerRegistry.upsertProvider({ id: 'acme', name: 'Acme', dialect: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1' });
  const base = `http://127.0.0.1:${port}`;
  const mutate = (url: string, method = 'POST', body: unknown = {}) => fetch(`${base}${url}`, {
    method, headers: { Authorization: 'Bearer host-admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const rename = () => mutate('/api/provider-registry/custom/acme/rename', 'POST', { id: 'fresh', revision: services.providerRegistry.getRevision() });
  return { ...dirs, config, services, base, port, mutate, rename };
}
async function upgrade(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'); let text = '';
    socket.on('connect', () => socket.write('GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer host-admin\r\n\r\n'));
    socket.on('data', chunk => { text += chunk.toString(); if (text.includes('\r\n\r\n')) { resolve(text); socket.destroy(); } });
    socket.on('end', () => resolve(text)); socket.on('error', reject);
  });
}

describe('real restricted provider host composition', () => {
  it.each([false, true].flatMap(exclusive => ['pending', 'malformed', 'linked'].map(intent => ({ exclusive, intent }))))('blocks listener/legacy upgrades on $intent intent in every mode ($exclusive)', async ({ exclusive, intent }) => {
    const { dataDir, config } = await directories();
    const store = new ConfigurationStore(path.join(dataDir, 'config.json')); await store.load();
    await store.rebindProvider('acme', 'fresh', async () => undefined); // deliberately no host finish handshake
    const intentPath = path.join(dataDir, 'config.json.provider-intent.json');
    if (intent === 'malformed') await writeFile(intentPath, 'not-json');
    if (intent === 'linked') {
      await rm(intentPath); const target = path.join(dataDir, 'linked-intent');
      await writeFile(target, '{"version":1,"state":"settled"}'); await symlink(target, intentPath);
    }
    const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as AddressInfo).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
    createApp({ ...config, providerRenameExclusiveHost: exclusive } as ServerConfig);
    await expect(start({ port })).rejects.toMatchObject({ code: 'PROVIDER_TRANSACTION_QUARANTINED' });
    await expect(upgrade(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('defaults OFF and only enables the strict environment value 1', async () => {
    const { config, services, rename, port } = await fixture(false);
    expect(await upgrade(port)).toContain('101 Switching Protocols');
    expect(await (await rename()).json()).toMatchObject({ code: 'PROVIDER_ADMISSION_UNAVAILABLE' });
    await stop();
    for (const value of ['true', '01', ' 1']) {
      vi.stubEnv('AI_HARNESS_PROVIDER_RENAME_EXCLUSIVE_HOST', value);
      let runtime!: Promise<RuntimeServices>;
      createApp({ ...config, providerRenameExclusiveHost: undefined, runtimeServicesFactory: (proxy, options) => (runtime = createRuntimeServices(proxy, options)) });
      await start();
      await expect((await runtime).providerAdministration.rename('acme', async () => undefined)).rejects.toMatchObject({ code: 'PROVIDER_ADMISSION_UNAVAILABLE' });
      await stop();
    }
    vi.stubEnv('AI_HARNESS_PROVIDER_RENAME_EXCLUSIVE_HOST', '1');
    let runtime!: Promise<RuntimeServices>;
    createApp({ ...config, providerRenameExclusiveHost: undefined, runtimeServicesFactory: (proxy, options) => (runtime = createRuntimeServices(proxy, options)) });
    await start();
    await expect((await runtime).providerAdministration.rename('unused', async () => undefined)).resolves.toBeUndefined();
    expect(services.providerRegistry.listProviders()[0]?.id).toBe('acme');
  });

  it('never activates restricted mode over a still-owned previous generation with bounded asynchronous cleanup', async () => {
    const { config, port, rename } = await fixture(false);
    expect(() => createApp({ ...config, providerRenameExclusiveHost: true })).toThrow('Stop the previous host');
    expect(await upgrade(port)).toContain('101 Switching Protocols');
    expect(await (await rename()).json()).toMatchObject({ code: 'PROVIDER_ADMISSION_UNAVAILABLE' });
  });

  it('refuses overlapping data/session/config/trust roots before activation', async () => {
    const { root, cwd, config } = await directories();
    for (const unsafe of [{ dataDir: cwd }, { sessionsDir: path.join(cwd, 'sessions') }, { configurationFile: path.join(cwd, 'config.json') }, { trustFile: path.join(cwd, 'trust.json') }, { allowedRoots: [root] }]) {
      createApp({ ...config, ...unsafe, providerRenameExclusiveHost: true } as ServerConfig);
      await expect(start()).rejects.toMatchObject({ code: 'PROVIDER_ADMINISTRATION_UNSAFE_ROOTS' }); await stop();
    }
    const installedCore = path.resolve('packages/core');
    createApp({ ...config, defaultCwd: installedCore, allowedRoots: [installedCore], providerRenameExclusiveHost: true });
    await expect(start()).rejects.toMatchObject({ code: 'PROVIDER_ADMINISTRATION_UNSAFE_ROOTS' });
  });

  it('permanently refuses unleased legacy, PTY, model and resource/file mutations and upgrades', async () => {
    const { mutate, port } = await fixture();
    for (const [url, method] of [['/api/chat', 'POST'], ['/API/CHAT', 'POST'], ['/api/CHAT/STREAM/', 'POST'], ['/api/config', 'POST'], ['/api/chat/stream', 'POST'], ['/api/chat/compact', 'POST'], ['/api/models/enabled', 'PATCH'], ['/API/MODELS/ENABLED', 'PATCH'], ['/api/models/enabled/batch', 'PATCH'], ['/api/terminals', 'POST'], ['/api/files/content', 'PUT'], ['/api/plugins/reload', 'POST'], ['/api/skills/enabled', 'PATCH'], ['/api/tools/enabled', 'PATCH'], ['/api/workspaces/trust', 'POST'], ['/api/agent/commands', 'POST'], ['/api/agent/sessions/s/commands/package', 'POST'], ['/api/mcp/test', 'POST']]) {
      const response = await mutate(url!, method); expect(response.status, url).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'PROVIDER_REFERENCE_OWNER_UNAVAILABLE' });
    }
    expect(await upgrade(port)).toContain('409 Conflict');
    for (const url of ['/api/files', '/api/files/git/status', '/api/workspaces/default']) {
      expect((await fetch(`http://127.0.0.1:${port}${url}`, { headers: { Authorization: 'Bearer host-admin' } })).status).toBe(409);
    }
  });

  it('holds exclusive ownership after disconnect; excludes inline sessions, profiles and references; settles and restarts', async () => {
    const { services, rename, mutate, base, config, dataDir } = await fixture();
    await services.configurationStore.patch('global', { provider: 'acme', model: 'acme:a', enabledModels: ['acme:a', 'bare'] });
    const original = services.configurationStore.rebindProvider.bind(services.configurationStore);
    const entered = gate(); const hold = gate(); const settled = gate();
    vi.spyOn(services.configurationStore, 'rebindProvider').mockImplementation((oldId, newId, commit) => original(oldId, newId, async () => { entered.release(); await hold.promise; await commit(); }));
    const administrationRename = services.providerAdministration.rename.bind(services.providerAdministration);
    vi.spyOn(services.providerAdministration, 'rename').mockImplementation(async (oldId, operation) => { try { return await administrationRename(oldId, operation); } finally { settled.release(); } });
    const client = httpRequest(`${base}/api/provider-registry/custom/acme/rename`, { method: 'POST', headers: { Authorization: 'Bearer host-admin', 'Content-Type': 'application/json' } });
    client.on('error', () => undefined); client.end(JSON.stringify({ id: 'fresh', revision: services.providerRegistry.getRevision() }));
    await entered.promise; client.destroy();
    try {
      for (const [url, method] of [['/api/sessions', 'POST'], ['/api/sessions/s', 'PATCH'], ['/api/sessions/s/fork', 'POST'], ['/api/sessions/s/clone', 'POST'], ['/api/sessions/s/messages', 'POST'], ['/api/sessions/s', 'DELETE'], ['/api/subagents/profiles', 'POST'], ['/api/configuration/scope', 'PATCH'], ['/api/agent/runs', 'POST']]) {
        const response = await mutate(url!, method); expect(response.status, url).toBe(409); expect(await response.json()).toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
      }
      await expect(services.reloadResources()).rejects.toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
      await expect(services.extensionRegistry.reload()).rejects.toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
      const childStart = vi.spyOn(services.subagentRuntime, 'start');
      await expect(services.extensionRegistry.executeTool('spawn_subagent', { profile: 'general', task: 'test' }, {
        sessionManager: services.sessionManager, notify: () => undefined, currentSessionId: 's', providerName: 'mock',
      })).rejects.toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
      expect(childStart).not.toHaveBeenCalled();
    } finally { hold.release(); }
    await settled.promise;
    expect(services.configurationStore.get('global')).toEqual({ provider: 'fresh', model: 'fresh:a', enabledModels: ['fresh:a', 'bare'] });
    expect(services.providerRegistry.listProviders()[0]?.id).toBe('fresh');
    expect(JSON.parse(await readFile(path.join(dataDir, 'config.json.provider-intent.json'), 'utf8')).state).toBe('settled');
    expect((await mutate('/api/sessions', 'POST', { title: 'Allowed' })).status).toBe(201);
    expect((await rename()).status).toBe(404);
    await stop(); createApp(config); await start();
    const reloaded = new ConfigurationStore(path.join(dataDir, 'config.json')); await reloaded.load(); expect(reloaded.get('global').provider).toBe('fresh');
  });

  it('leases the real inline create handler, child tool admission and extension-triggered reload for their awaited lifetimes', async () => {
    const { services, base, rename, cwd } = await fixture();
    const entered = gate(); const hold = gate();
    const create = services.sessionManager.create.bind(services.sessionManager);
    vi.spyOn(services.sessionManager, 'create').mockImplementation(async (...args) => { entered.release(); await hold.promise; return create(...args); });
    const client = httpRequest(`${base}/api/sessions`, { method: 'POST', headers: { Authorization: 'Bearer host-admin', 'Content-Type': 'application/json' } });
    client.on('error', () => undefined); client.end(JSON.stringify({ cwd })); await entered.promise; client.destroy();
    try { expect(await (await rename()).json()).toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' }); } finally { hold.release(); }
    await expect.poll(() => services.sessionManager.list().length).toBe(1);
    vi.restoreAllMocks();
    await services.trustManager.trust(cwd);
    const admission = gate(); const childHold = gate(); const providerEntered = gate(); const providerHold = gate();
    const childStart = services.subagentRuntime.start.bind(services.subagentRuntime);
    vi.spyOn(services.subagentRuntime, 'start').mockImplementation(async input => { admission.release(); await childHold.promise; return childStart(input); });
    const provider = services.resolveProvider('mock')!; const stream = provider.streamChat.bind(provider);
    vi.spyOn(provider, 'streamChat').mockImplementation(async (...args) => { providerEntered.release(); await providerHold.promise; await stream(...args); });
    const tool = services.extensionRegistry.executeTool('spawn_subagent', { profile: 'general', task: 'test', background: true }, { sessionManager: services.sessionManager, notify: () => undefined, cwd: services.sessionManager.list()[0]!.cwd!, currentSessionId: services.sessionManager.list()[0]!.id, providerName: 'mock' });
    await admission.promise;
    try { expect(await (await rename()).json()).toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' }); } finally { childHold.release(); }
    const toolResult = await tool; await providerEntered.promise;
    const childId = (toolResult.details as { runId: string }).runId;
    try {
      expect(services.subagentRuntime.get(childId)?.status).toBe('running');
      expect(await (await rename()).json()).toMatchObject({ code: 'PROVIDER_IN_USE' });
    } finally { providerHold.release(); await services.subagentRuntime.wait(childId); }
    expect(services.subagentRuntime.get(childId)?.status).toBe('completed');
    const reloadEntered = gate(); const reloadHold = gate();
    const resolve = services.workspaceManager.resolve.bind(services.workspaceManager);
    vi.spyOn(services.workspaceManager, 'resolve').mockImplementation(async (...args) => { reloadEntered.release(); await reloadHold.promise; return resolve(...args); });
    const reload = services.extensionRegistry.reload(); await reloadEntered.promise;
    try { expect(await (await rename()).json()).toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' }); } finally { reloadHold.release(); await reload; }
  });

  it('quarantines a real HTTP rename after same-byte external registry replacement refuses rollback, including restart', async () => {
    const { services, config, dataDir, rename, mutate } = await fixture();
    await services.configurationStore.patch('global', { provider: 'acme' });
    const file = path.join(dataDir, 'providers.json');
    const rebind = services.configurationStore.rebindProvider.bind(services.configurationStore);
    let published = '';
    vi.spyOn(services.configurationStore, 'rebindProvider').mockImplementation((oldId, newId, commit) => rebind(oldId, newId, async () => {
      await commit(); published = await readFile(file, 'utf8');
      const { rename: replace } = await import('node:fs/promises');
      await writeFile(`${file}.external`, published); await replace(`${file}.external`, file);
      throw new Error('host post-commit failure');
    }));
    const response = await rename(); expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'PROVIDER_RENAME_UNCERTAIN', uncertain: true });
    expect(await readFile(file, 'utf8')).toBe(published);
    expect(await readFile(path.join(dataDir, 'config.json'), 'utf8')).toContain('acme');
    expect(await (await mutate('/api/sessions')).json()).toMatchObject({ code: 'PROVIDER_TRANSACTION_QUARANTINED' });
    await stop(); createApp(config);
    await expect(start()).rejects.toMatchObject({ code: 'PROVIDER_TRANSACTION_QUARANTINED' });
  });

  it('keeps ordinary session create/update/append/fork/clone and profile/ref changes available outside rename', async () => {
    const { mutate, rename, services, cwd } = await fixture();
    const created = await mutate('/api/sessions', 'POST', { title: 'Original', cwd }); expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect((await mutate(`/api/sessions/${id}`, 'PATCH', { title: 'Updated' })).status).toBe(200);
    expect((await mutate(`/api/sessions/${id}/messages`, 'POST', { role: 'user', content: 'persisted' })).status).toBe(201);
    expect((await mutate(`/api/sessions/${id}/fork`)).status).toBe(201);
    expect((await mutate(`/api/sessions/${id}/clone`)).status).toBe(201);
    expect((await mutate('/api/subagents/profiles/general/duplicate')).status).toBe(201);
    expect((await mutate('/api/configuration/scope', 'PATCH', { scope: 'global', values: { provider: 'acme', model: 'acme:a' } })).status).toBe(200);
    expect((await rename()).status).toBe(200);
    expect(services.configurationStore.get('global')).toEqual({ provider: 'fresh', model: 'fresh:a' });
    expect((await mutate(`/api/sessions/${id}`, 'DELETE')).status).toBe(409); // descendants still require explicit cascade confirmation
    expect((await mutate(`/api/sessions/${id}?cascade=true`, 'DELETE')).status).toBe(200);
  });

  it('refuses credential command configuration rather than executing it outside the root boundary', async () => {
    const { dataDir, rename } = await fixture(); const marker = path.join(dataDir, 'credential-executed');
    vi.stubEnv('AI_HARNESS_OPENAI_API_KEY_COMMAND', `touch ${marker}`);
    const response = await rename(); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PROVIDER_REFERENCE_OWNER_UNAVAILABLE' });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not execute workspace shell tools or administrator/project extensions in this mode', async () => {
    const { services, dataDir, cwd } = await fixture();
    await mkdir(path.join(dataDir, 'extensions'));
    const marker = path.join(dataDir, 'executed');
    await writeFile(path.join(dataDir, 'extensions', 'unsafe.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad'); export default () => {};`);
    await services.reloadResources();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(services.extensionRegistry.executeTool('bash', { command: `touch ${marker}` }, { sessionManager: services.sessionManager, notify: () => undefined, cwd, projectTrusted: true })).rejects.toThrow();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const name of ['grep', 'find', 'powershell']) {
      await expect(services.extensionRegistry.executeTool(name, {}, { sessionManager: services.sessionManager, notify: () => undefined, cwd, projectTrusted: true })).rejects.toThrow();
    }
    await expect(services.extensionRegistry.executeTool('write', { path: marker, content: 'bad' }, { sessionManager: services.sessionManager, notify: () => undefined, cwd, projectTrusted: true })).rejects.toThrow();
    const nestedExecutor = vi.fn(async () => ({ content: 'unsafe' }));
    await expect(services.extensionRegistry.executeHostedTool('codemode', {}, { sessionManager: services.sessionManager, notify: () => undefined, cwd }, nestedExecutor)).rejects.toThrow();
    expect(nestedExecutor).not.toHaveBeenCalled();
  });
});

// Provider admission must not move the accepted command epoch capture past a new await.
it('captures command interaction authority before provider admission awaits', async () => {
  const { services, mutate, cwd } = await fixture(false);
  const session = await services.sessionManager.create({ title: 'Admission epoch', cwd });
  await services.extensionRegistry.load('admission-epoch-fixture', api => api.registerCommand('lease_epoch', {
    description: 'Disposable captured epoch probe',
    handler: async (_args, context) => {
      const handle = context.requestInteraction!({ kind: 'confirm', title: 'Captured before admission' });
      const id = handle.id ?? null;
      if (handle.id) handle.close!();
      return JSON.stringify({ id, result: await handle });
    },
  }));
  const capture = vi.spyOn(services.agentRuntime, 'createExtensionInteractionRequester');
  const entered = gate(); const held = gate();
  const original = services.configurationStore.assertProviderTransactionSafe.bind(services.configurationStore);
  vi.spyOn(services.configurationStore, 'assertProviderTransactionSafe').mockImplementationOnce(async () => {
    entered.release(); await held.promise; await original();
  });
  const response = mutate('/api/agent/sessions/' + session.id + '/commands/lease_epoch');
  await entered.promise;
  const capturesBeforeAdmission = capture.mock.calls.map(args => [...args]);
  services.agentRuntime.clearExtensionInteractions();
  held.release();
  const settled = await response;
  expect(settled.status).toBe(200);
  expect(capturesBeforeAdmission).toEqual([[session.id]]);
  expect(JSON.parse((await settled.json()).output).result).toEqual({ cancelled: true });
  expect(services.agentRuntime.snapshot(session.id).run?.extensionRequests ?? []).toEqual([]);
});

// Proxy lookup folds provider case; a successful rename must not orphan that alias.
it('refuses mixed-case scoped provider references before rename publication', async () => {
  const { services, dataDir, rename } = await fixture();
  expect(services.resolveProvider('ACME')).toBe(services.resolveProvider('acme'));
  expect(services.resolveProvider('ACME')).toBeDefined();
  await services.configurationStore.patch('global', { provider: 'ACME', model: 'bare-model' });
  const config = await readFile(path.join(dataDir, 'config.json'), 'utf8');
  const registry = await readFile(path.join(dataDir, 'providers.json'), 'utf8');
  const response = await rename();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'PROVIDER_UNSUPPORTED_REFERENCES', uncertain: false });
  expect(await readFile(path.join(dataDir, 'config.json'), 'utf8')).toBe(config);
  expect(await readFile(path.join(dataDir, 'providers.json'), 'utf8')).toBe(registry);
  await expect(readFile(path.join(dataDir, 'config.json.provider-intent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(services.resolveProvider('ACME')).toBe(services.resolveProvider('acme'));
  await services.configurationStore.assertProviderTransactionSafe();
});
