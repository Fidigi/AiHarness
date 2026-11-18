import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelEnableBatchResult, ProviderModelCatalog } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';
import { ConfigurationStore } from '../config/config-store.js';

const groups: ProviderModelCatalog[] = ['openai', 'azure'].map(provider => ({ provider, configured: true,
  models: ['same', 'hidden', 'off'].map(id => ({ key: `${provider}:${id}`, id, name: id, provider, enabled: true,
    available: true, source: 'published', capabilities: { reasoning: false, imageInput: false, toolCalls: true } })),
}));

describe('model batch routes', () => {
  let root: string; let cwd: string; let data: string; let base: string; let projectId: string; let services: RuntimeServices;
  const request = (resource: string, body: unknown, token = 'admin', origin?: string) => fetch(`${base}/api/${resource}/enabled/batch`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  beforeAll(async () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin');
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-model-batches-')); cwd = path.join(root, 'project'); data = path.join(root, 'data');
    await mkdir(cwd);
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: data, allowedRoots: [root], defaultCwd: cwd,
      runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
    base = `http://127.0.0.1:${server.port}`;
    projectId = (await fetch(`${base}/api/workspaces/default`, { headers: { Authorization: 'Bearer admin' } })
      .then(response => response.json()) as { id: string }).id;
    vi.spyOn(services.modelCatalog, 'getCatalog').mockResolvedValue(groups);
  });
  beforeEach(async () => {
    await services.configurationStore.replace('global', {}); await services.configurationStore.replace('project', {}, projectId);
    await services.trustManager.trust(cwd);
  });
  afterAll(async () => { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it('rejects malformed selectors, unknown fields, duplicates, excessive counts and unauthorized writes', async () => {
    for (const changes of [null, {}, [{ key: 'openai:same', enabled: 'yes' }], [{ key: '', enabled: true }],
      [{ key: 'x', enabled: true, path: '/tmp' }], [{ key: 'x', enabled: true }, { key: 'x', enabled: false }],
      Array.from({ length: 501 }, (_, index) => ({ key: `x:${index}`, enabled: true }))]) {
      expect((await request('models', { changes })).status).toBe(400);
    }
    expect((await request('models', { changes: [], npmCommand: ['unsafe'] })).status).toBe(400);
    expect((await request('models', { changes: [] }, 'user')).status).toBe(403);
    expect((await request('models', { changes: [] }, 'admin', 'https://evil.test')).status).toBe(403);
  });

  it('targets qualified models only, preserves inherited hidden/unknown keys and reports every selector', async () => {
    await services.configurationStore.patch('global', { enabledModels: ['same', 'openai:hidden', 'future:model'], thinking: 'high' });
    const response = await request('models', { projectId, changes: [{ key: 'openai:same', enabled: false },
      { key: 'openai:off', enabled: true }, { key: 'absent:model', enabled: true }] });
    expect(response.status).toBe(200);
    const result = await response.json() as ModelEnableBatchResult;
    expect(result.outcomes.map(outcome => outcome.status)).toEqual(['changed', 'changed', 'failed']);
    expect(result.catalog.providers[0].models.map(model => model.enabled)).toEqual([false, true, true]);
    expect(result.catalog.providers[1].models[0].enabled).toBe(true);
    expect(services.configurationStore.get('project', projectId).enabledModels).toEqual(expect.arrayContaining(['future:model', 'openai:hidden', 'azure:same']));
    expect(services.configurationStore.get('global')).toEqual({ enabledModels: ['same', 'openai:hidden', 'future:model'], thinking: 'high' });
  });

  it('gives an exact qualified key precedence over an overlapping legacy model ID', async () => {
    const collisionGroups: ProviderModelCatalog[] = [
      { ...groups[0], models: [groups[0].models[0]] },
      { ...groups[1], models: [{ ...groups[1].models[0], key: 'azure:openai:same', id: 'openai:same' }] },
    ];
    const catalogue = vi.mocked(services.modelCatalog.getCatalog);
    catalogue.mockResolvedValue(collisionGroups);
    try {
      await services.configurationStore.patch('global', { enabledModels: ['openai:same'] });
      const initial = await fetch(`${base}/api/models`, { headers: { Authorization: 'Bearer admin' } }).then(response => response.json());
      expect(initial.providers.map((provider: ProviderModelCatalog) => provider.models[0].enabled)).toEqual([true, false]);
      for (const enabled of [true, false]) {
        const response = await request('models', { projectId, changes: [{ key: 'azure:openai:same', enabled }] });
        expect(response.status).toBe(200);
        const result = await response.json() as ModelEnableBatchResult;
        expect(result.outcomes).toMatchObject([{ status: 'changed' }]);
        expect(result.catalog.providers.map(provider => provider.models[0].enabled)).toEqual([true, enabled]);
        expect(services.configurationStore.get('project', projectId).enabledModels).toContain('openai:same');
      }
      expect(services.configurationStore.get('global').enabledModels).toEqual(['openai:same']);
    } finally { catalogue.mockResolvedValue(groups); }
  });

  it('keeps a no-op inherited and byte-stable and merges concurrent batches/config changes', async () => {
    await services.configurationStore.patch('global', { enabledModels: ['openai:same', 'azure:same'] });
    const config = path.join(data, 'config.json'); const before = await readFile(config, 'utf8'); const info = await stat(config);
    const response = await request('models', { projectId, changes: [{ key: 'openai:same', enabled: true }] });
    expect((await response.json() as ModelEnableBatchResult).outcomes[0].status).toBe('unchanged');
    expect(await readFile(config, 'utf8')).toBe(before); expect((await stat(config)).ino).toBe(info.ino);
    expect(services.configurationStore.get('project', projectId).enabledModels).toBeUndefined();
    await Promise.all([request('models', { projectId, changes: [{ key: 'openai:off', enabled: true }] }),
      request('models', { projectId, changes: [{ key: 'azure:off', enabled: true }] }),
      services.configurationStore.patch('project', { thinking: 'low' }, projectId)]);
    expect(services.configurationStore.get('project', projectId)).toMatchObject({ thinking: 'low',
      enabledModels: expect.arrayContaining(['openai:same', 'azure:same', 'openai:off', 'azure:off']) });
  });

  it('reconciles model configuration after a real publication followed by an error', async () => {
    const config = path.join(data, 'config.json');
    const external = new ConfigurationStore(config); await external.load();
    const original = services.configurationStore.update.bind(services.configurationStore);
    const update = vi.spyOn(services.configurationStore, 'update').mockImplementation(async (scope, transform, id) => {
      await original(scope, transform, id);
      await external.patch('project', { thinking: 'high' }, projectId);
      throw Object.assign(new Error('Post-publication error'), { code: 'CONFIGURATION_POST_PUBLICATION' });
    });
    try {
      const response = await request('models', { projectId, changes: [{ key: 'openai:same', enabled: false }] });
      expect(response.status).toBe(200);
      const result = await response.json() as ModelEnableBatchResult;
      expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'CONFIGURATION_POST_PUBLICATION' }]);
      expect(result.catalog.providers[0].models[0].enabled).toBe(false);
      expect(services.configurationStore.get('project', projectId)).toMatchObject({ thinking: 'high' });
      expect(JSON.parse(await readFile(config, 'utf8')).projects[projectId]).toEqual(services.configurationStore.get('project', projectId));
    } finally { update.mockRestore(); }
  });

  it.each([undefined, null, 'private-writer-detail'])('reconciles a non-Error rejection after publication (%s)', async failure => {
    const config = path.join(data, 'config.json');
    const external = new ConfigurationStore(config); await external.load();
    const original = services.configurationStore.update.bind(services.configurationStore);
    const update = vi.spyOn(services.configurationStore, 'update').mockImplementation(async (scope, transform, id) => {
      await original(scope, transform, id);
      await external.patch('project', { thinking: 'high' }, projectId);
      throw failure;
    });
    try {
      const response = await request('models', { projectId, changes: [{ key: 'openai:same', enabled: false }] });
      expect(response.status).toBe(200);
      const result = await response.json() as ModelEnableBatchResult;
      expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'CONFIGURATION_WRITE_FAILED' }]);
      expect(result.catalog.providers[0].models[0].enabled).toBe(false);
      expect(services.configurationStore.get('project', projectId)).toMatchObject({ thinking: 'high' });
      expect(JSON.parse(await readFile(config, 'utf8')).projects[projectId]).toEqual(services.configurationStore.get('project', projectId));
      expect(JSON.stringify(result)).not.toContain('private-writer-detail');
    } finally { update.mockRestore(); }
  });

  it('does not return a stale model catalogue when canonical configuration cannot be reconciled', async () => {
    const config = path.join(data, 'config.json'); const before = await readFile(config, 'utf8');
    const original = services.configurationStore.update.bind(services.configurationStore);
    const update = vi.spyOn(services.configurationStore, 'update').mockImplementation(async (scope, transform, id) => {
      await original(scope, transform, id);
      await writeFile(config, '{broken');
      throw Object.assign(new Error('Post-publication error'), { code: 'CONFIGURATION_POST_PUBLICATION' });
    });
    try {
      const response = await request('models', { changes: [{ key: 'openai:same', enabled: false }] });
      expect(response.status).toBe(409);
      const result = await response.json() as { code: string; outcomes: ModelEnableBatchResult['outcomes']; catalog?: unknown };
      expect(result.code).toBe('MODEL_BATCH_UNCERTAIN');
      expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'CONFIGURATION_POST_PUBLICATION' }]);
      expect(result).not.toHaveProperty('catalog');
      const refresh = await fetch(`${base}/api/models?refresh=true`, { headers: { Authorization: 'Bearer admin' } });
      expect(refresh.status).toBe(409);
      expect(await refresh.json()).toMatchObject({ code: 'CONFIGURATION_UNREADABLE' });
      expect(await readFile(config, 'utf8')).toBe('{broken');
    } finally { update.mockRestore(); await writeFile(config, before); }
  });

  it('does not publish uncommitted model success or replace unreadable settings', async () => {
    const config = path.join(data, 'config.json'); const before = await readFile(config, 'utf8');
    await writeFile(config, '{broken');
    try {
      const result = await request('models', { changes: [{ key: 'openai:same', enabled: false }] }).then(response => response.json()) as ModelEnableBatchResult;
      expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'CONFIGURATION_UNREADABLE' }]);
      expect(await readFile(config, 'utf8')).toBe('{broken');
    } finally { await writeFile(config, before); }
  });
});
