import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@ai-harness/core';
import { AiProxyServer } from './proxy.js';
import { createProviderRegistryRouter } from './provider-registry-routes.js';
import { ProviderRegistryService } from '../runtime/provider-registry.js';
import { ProviderAdministration, assertProviderReferenceOwners } from '../runtime/provider-administration.js';
import { ConfigurationStore } from '../config/config-store.js';
import { createConfigurationRouter } from './config-routes.js';
import { createAgentRouter } from './agent-routes.js';
import { createSubagentRouter } from './subagent-routes.js';
import type { RuntimeServices } from '../runtime/services.js';
import { authenticationMiddleware, credentialRedactionMiddleware, originMiddleware, safeErrorHandler } from '../security/request-security.js';

const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'test-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'test-admin');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-provider-routes-')); roots.push(root);
  const proxy = new AiProxyServer();
  const providerRegistry = new ProviderRegistryService(path.join(root, 'providers.json'), proxy, path.join(root, 'secrets.enc'), 'test-only-private-master-key');
  await providerRegistry.load();
  await providerRegistry.upsertProvider({ id: 'acme', name: 'Acme', baseUrl: 'http://127.0.0.1:1/gateway/v1', dialect: 'openai-completions', apiKey: 'must-never-disclose', headers: { 'X-Private': 'private-header' } });
  const sessions: Session[] = [];
  const configurationStore: { rebindProvider?: (old: string, next: string, commit: () => Promise<void>) => Promise<void> } = {};
  const realStore = new ConfigurationStore(path.join(root, 'config.json')); await realStore.load();
  const invalidated = vi.fn();
  const services = { providerRegistry, configurationStore, sessionManager: { list: () => sessions },
    subagentService: { createProfile: vi.fn(async () => ({})) },
    agentRuntime: { listRunning: () => [] }, modelCatalog: { invalidateProvider: invalidated } } as unknown as RuntimeServices & { providerAdministration?: ProviderAdministration };
  const administration = new ProviderAdministration(realStore, oldId => assertProviderReferenceOwners({
    oldId, sessions, running: services.agentRuntime.listRunning(), sessionsDir: path.join(root, 'sessions'),
    subagentsFile: path.join(root, 'subagents.json'), agentSettingsFile: path.join(root, 'settings.json'), projectDirectories: [], projectRoots: [], extensionIds: [],
  }));
  administration.activateForExclusiveHost(); services.providerAdministration = administration;
  const app = express(); app.use(express.json());
  app.use(authenticationMiddleware(), originMiddleware(), credentialRedactionMiddleware(proxy.getCredentialRedactor()));
  app.use('/api/provider-registry', createProviderRegistryRouter(Promise.resolve(services), proxy, () => undefined));
  app.use('/api/configuration', createConfigurationRouter(Promise.resolve(services)));
  app.use('/api/agent', createAgentRouter(Promise.resolve(services)));
  app.use('/api/subagents', createSubagentRouter(Promise.resolve(services)));
  app.use((error: unknown, request: Request, response: Response, next: NextFunction) => safeErrorHandler(error, request, response, next));
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (body: unknown, token: string = 'test-admin', origin?: string) => fetch(`${base}/api/provider-registry/custom/acme/rename`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  });
  const mutate = (url: string, method = 'POST', body: unknown = {}) => fetch(`${base}${url}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' }, body: JSON.stringify(body),
  });
  return { providerRegistry, request, configurationStore, sessions, invalidated, services, base, realStore, root, administration, mutate };
}

describe('provider rename HTTP security and transaction adapter', () => {
  it('does not activate from rebind alone or from an unwired administration helper', async () => {
    const { services, request, providerRegistry, realStore, configurationStore } = await fixture();
    configurationStore.rebindProvider = realStore.rebindProvider.bind(realStore);
    services.providerAdministration = undefined;
    expect(await (await request({ id: 'renamed', revision: providerRegistry.getRevision() })).json()).toMatchObject({ code: 'PROVIDER_ADMISSION_UNAVAILABLE' });
    services.providerAdministration = new ProviderAdministration(realStore, async () => undefined);
    expect(await (await request({ id: 'renamed', revision: providerRegistry.getRevision() })).json()).toMatchObject({ code: 'PROVIDER_ADMISSION_UNAVAILABLE' });
    expect(providerRegistry.listProviders()[0]?.id).toBe('acme');
  });

  it('uses the real config transaction and refuses profile/environment/durable qualified references', async () => {
    const { providerRegistry, realStore, configurationStore, request, root } = await fixture();
    configurationStore.rebindProvider = realStore.rebindProvider.bind(realStore);
    await realStore.patch('global', { provider: 'acme', enabledModels: ['acme:a', 'bare'] });
    await providerRegistry.upsertModel({ provider: 'acme', id: 'a' });
    const secrets = await readFile(path.join(root, 'secrets.enc'));
    await writeFile(path.join(root, 'subagents.json'), JSON.stringify({ version: 1, projects: { p: { profiles: [{ model: 'acme:a', enabled: false }] } } }));
    expect(await (await request({ id: 'renamed', revision: providerRegistry.getRevision() })).json()).toMatchObject({ code: 'PROVIDER_UNSUPPORTED_REFERENCES' });
    await rm(path.join(root, 'subagents.json'));
    vi.stubEnv('AI_HARNESS_DEFAULT_MODEL', 'acme:a');
    expect(await (await request({ id: 'renamed', revision: providerRegistry.getRevision() })).json()).toMatchObject({ code: 'PROVIDER_ENVIRONMENT_LOCKED' });
    vi.unstubAllEnvs(); vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'test-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'test-admin');
    const response = await request({ id: 'renamed', revision: providerRegistry.getRevision() });
    expect(response.status).toBe(200);
    expect(realStore.get('global')).toEqual({ provider: 'renamed', enabledModels: ['renamed:a', 'bare'] });
    expect(providerRegistry.getModels()[0]).toMatchObject({ provider: 'renamed', key: 'renamed:a' });
    expect(await readFile(path.join(root, 'secrets.enc'))).toEqual(secrets);
    await new ConfigurationStore(path.join(root, 'config.json')).load();
  });

  it('excludes admission and reference mutations even after the rename client disconnects', async () => {
    const { base, realStore, configurationStore, providerRegistry, mutate, services, administration } = await fixture();
    await realStore.patch('global', { provider: 'acme' });
    let completed!: () => void; const settled = new Promise<void>(resolve => { completed = resolve; });
    const rename = administration.rename.bind(administration);
    vi.spyOn(administration, 'rename').mockImplementation(async (oldId, operation) => {
      try { return await rename(oldId, operation); } finally { completed(); }
    });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    configurationStore.rebindProvider = (oldId, newId, commit) => realStore.rebindProvider(oldId, newId, async () => {
      entered(); await hold; await commit();
    });
    const request = httpRequest(`${base}/api/provider-registry/custom/acme/rename`, { method: 'POST', headers: {
      Authorization: 'Bearer test-admin', 'Content-Type': 'application/json',
    } });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ id: 'renamed', revision: providerRegistry.getRevision() }));
    await started; request.destroy();
    try {
      for (const [url, method] of [
        ['/api/agent/runs', 'POST'], ['/api/agent/sessions/s/compact', 'POST'],
        ['/api/configuration/scope', 'PATCH'], ['/api/configuration/defaults', 'PATCH'],
        ['/api/subagents/runs', 'POST'], ['/api/subagents/profiles', 'POST'],
        ['/api/provider-registry/models', 'POST'], ['/api/provider-registry/custom/acme', 'DELETE'],
      ]) {
        const response = await mutate(url!, method);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
      }
      expect(services.subagentService.createProfile).not.toHaveBeenCalled();
    } finally { release(); }
    // Join actual host/registry settlement, not a response finish signal.
    await settled; await realStore.load();
    expect(realStore.get('global').provider).toBe('renamed');
    expect(providerRegistry.listProviders()[0]?.id).toBe('renamed');
  });

  it('holds an operation lease through an earlier reference mutation and refuses rename without waiting', async () => {
    const { administration, request, configurationStore, realStore, providerRegistry } = await fixture();
    configurationStore.rebindProvider = realStore.rebindProvider.bind(realStore);
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const operation = administration.withOperation(() => hold);
    try {
      expect(await (await request({ id: 'renamed', revision: providerRegistry.getRevision() })).json()).toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
    } finally { release(); await operation; }
    expect(providerRegistry.listProviders()[0]?.id).toBe('acme');
  });

  it('keeps direct-shell work leased after sending HTTP 202 until real runtime settlement', async () => {
    const { services, mutate, request, providerRegistry, configurationStore, realStore } = await fixture();
    configurationStore.rebindProvider = realStore.rebindProvider.bind(realStore);
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    Object.assign(services, {
      workspaceManager: { resolve: async () => '/workspace' }, trustManager: { isTrusted: async () => true },
      commandRuntime: { start: () => ({ id: 'cmd' }), wait: () => hold },
    });
    Object.assign(services.sessionManager, { get: () => ({ id: 's', cwd: '/workspace' }) });
    const response = await mutate('/api/agent/commands', 'POST', { sessionId: 's', command: 'test-command' });
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ id: 'cmd' });
    try {
      expect(await (await request({ id: 'renamed', revision: providerRegistry.getRevision() })).json()).toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
    } finally { release(); }
    expect(providerRegistry.listProviders()[0]?.id).toBe('acme');
  });

  it('does not release an earlier profile mutation lease when that client disconnects', async () => {
    const { base, services, request, providerRegistry, configurationStore, realStore } = await fixture();
    configurationStore.rebindProvider = realStore.rebindProvider.bind(realStore);
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    let complete!: () => void; const completed = new Promise<void>(resolve => { complete = resolve; });
    vi.spyOn(services.subagentService, 'createProfile').mockImplementation(async () => {
      enter(); await hold; complete(); return {} as never;
    });
    const client = httpRequest(`${base}/api/subagents/profiles`, { method: 'POST', headers: {
      Authorization: 'Bearer test-admin', 'Content-Type': 'application/json',
    } });
    client.on('error', () => undefined); client.end('{}'); await entered; client.destroy();
    try {
      expect(await (await request({ id: 'renamed', revision: providerRegistry.getRevision() })).json()).toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
    } finally { release(); await completed; }
    expect(providerRegistry.listProviders()[0]?.id).toBe('acme');
  });

  it('keeps rollback quarantine and refuses subsequent admission after a registry CAS failure', async () => {
    const { configurationStore, realStore, root, request, providerRegistry, mutate } = await fixture();
    await realStore.patch('global', { provider: 'acme' });
    const original = await readFile(path.join(root, 'providers.json'), 'utf8');
    configurationStore.rebindProvider = (oldId, newId, commit) => realStore.rebindProvider(oldId, newId, async () => {
      await writeFile(path.join(root, 'providers.json'), `${original} `); await commit();
    });
    expect(await (await request({ id: 'renamed', revision: providerRegistry.getRevision() })).json()).toMatchObject({ uncertain: true });
    expect(await readFile(path.join(root, 'config.json'), 'utf8')).toContain('acme');
    expect(await (await mutate('/api/agent/runs')).json()).toMatchObject({ code: 'PROVIDER_TRANSACTION_QUARANTINED' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(`${original} `);
  });

  it('requires admin and trusted Origin before any lifecycle operation', async () => {
    const { providerRegistry, request, configurationStore } = await fixture();
    const rebind = vi.fn(async (_old, _next, commit: () => Promise<void>) => commit()); configurationStore.rebindProvider = rebind;
    const body = { id: 'renamed', revision: providerRegistry.getRevision() };
    expect((await request(body, '')).status).toBe(401);
    expect((await request(body, 'test-user')).status).toBe(403);
    expect((await request(body, 'test-admin', 'https://hostile.example')).status).toBe(403);
    expect(rebind).not.toHaveBeenCalled();
    expect(providerRegistry.listProviders()[0]?.id).toBe('acme');
  });
  it('rejects payload smuggling, unsafe project/trust selectors and missing atomic rebind', async () => {
    const { providerRegistry, request } = await fixture();
    for (const extras of [{ apiKey: 'private-request' }, { headers: { Authorization: 'private' } }, { cwd: '/untrusted' }, { trust: true }, { scope: 'project' }]) {
      expect((await request({ id: 'renamed', revision: providerRegistry.getRevision(), ...extras })).status).toBe(400);
    }
    expect((await request({ id: 'renamed', revision: 'bad' })).status).toBe(400);
    const missing = await request({ id: 'renamed', revision: providerRegistry.getRevision() });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: 'PROVIDER_REBIND_UNAVAILABLE', uncertain: false });
  });
  it('refuses durable session, active agent and environment references rather than silently rebinding runtime state', async () => {
    const { providerRegistry, request, configurationStore, sessions, services } = await fixture();
    const rebind = vi.fn(async (_old, _next, commit: () => Promise<void>) => commit()); configurationStore.rebindProvider = rebind;
    const body = { id: 'renamed', revision: providerRegistry.getRevision() };
    sessions.push({ providerConfig: { type: 'acme' } } as Session);
    expect(await (await request(body)).json()).toMatchObject({ code: 'PROVIDER_IN_USE' });
    sessions.length = 0;
    vi.spyOn(services.agentRuntime, 'listRunning').mockReturnValue([{} as never]);
    expect(await (await request(body)).json()).toMatchObject({ code: 'PROVIDER_IN_USE' });
    vi.restoreAllMocks();
    vi.stubEnv('AI_HARNESS_DEFAULT_PROVIDER', 'acme');
    expect(await (await request(body)).json()).toMatchObject({ code: 'PROVIDER_ENVIRONMENT_LOCKED' });
    expect(rebind).not.toHaveBeenCalled();
  });
  it('rechecks session safety after waiting for the host reference transaction', async () => {
    const { providerRegistry, request, configurationStore, sessions } = await fixture();
    configurationStore.rebindProvider = async (_old, _next, commit) => {
      sessions.push({ providerConfig: { type: 'acme' } } as Session);
      await commit();
    };
    const result = await request({ id: 'renamed', revision: providerRegistry.getRevision() });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'PROVIDER_IN_USE', uncertain: false });
    expect(providerRegistry.listProviders()[0]?.id).toBe('acme');
  });
  it('passes one bounded identity-only transaction and invalidates old/new discovery sources without private auth disclosure', async () => {
    const { providerRegistry, request, configurationStore, invalidated, base } = await fixture();
    const rebind = vi.fn(async (_old, _next, commit: () => Promise<void>) => commit()); configurationStore.rebindProvider = rebind;
    const response = await request({ id: 'renamed', revision: providerRegistry.getRevision() }, 'test-admin', base);
    expect(response.status).toBe(200);
    const text = await response.text(); expect(text).not.toMatch(/must-never-disclose|private-header|credentialId/);
    expect(JSON.parse(text)).toMatchObject({ id: 'renamed', configured: true });
    expect(rebind).toHaveBeenCalledOnce();
    expect(rebind.mock.calls[0]?.slice(0, 2)).toEqual(['acme', 'renamed']);
    expect(invalidated.mock.calls).toEqual([['acme'], ['renamed']]);
  });
});
