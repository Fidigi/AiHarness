import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, unlinkSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelEnableBatchResult, ProviderModelCatalog, SkillEnableBatchResult } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';
import { ConfigurationStore } from '../config/config-store.js';

const groups: ProviderModelCatalog[] = ['openai', 'azure'].map(provider => ({ provider, configured: true,
  models: ['same', 'hidden', 'off'].map(id => ({ key: `${provider}:${id}`, id, name: id, provider, enabled: true,
    available: true, source: 'published', capabilities: { reasoning: false, imageInput: false, toolCalls: true } })),
}));

describe('resource batch routes', () => {
  let root: string; let cwd: string; let data: string; let base: string; let projectId: string; let services: RuntimeServices;
  const request = (resource: string, body: unknown, token = 'admin', origin?: string) => fetch(`${base}/api/${resource}/enabled/batch`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  const file = (name: string, project = false) => path.join(project ? cwd : data, project ? '.agents' : '', 'skills', name, 'SKILL.md');
  const source = (name: string) => `\uFEFF---\r\nname: ${name}\r\ndescription: Review safely\r\n# retained comment\r\nversion: '1.2'\r\n---\r\n\r\n# Body\r\n\`\`\`ts\r\nconst unchanged = true;\r\n\`\`\`\r\n`;
  const createSkill = async (name: string, project = false) => {
    await mkdir(path.dirname(file(name, project)), { recursive: true }); await writeFile(file(name, project), source(name));
  };
  beforeAll(async () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin');
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-batches-')); cwd = path.join(root, 'project'); data = path.join(root, 'data');
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
    await rm(path.join(data, 'skills'), { recursive: true, force: true });
    await rm(path.join(cwd, '.agents'), { recursive: true, force: true });
    services.skillCatalog.invalidate();
  });
  afterAll(async () => { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

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

  it('rejects malformed/duplicate/oversized selectors and non-admin/cross-origin writes', async () => {
    for (const changes of [null, {}, [{ key: 'openai:same', enabled: 'yes' }], [{ key: '', enabled: true }],
      [{ key: 'x', enabled: true, path: '/tmp' }], [{ key: 'x', enabled: true }, { key: 'x', enabled: false }],
      Array.from({ length: 501 }, (_, index) => ({ key: `x:${index}`, enabled: true }))]) {
      for (const resource of ['models', 'skills']) expect((await request(resource, { changes })).status).toBe(400);
    }
    expect((await request('models', { changes: [] }, 'user')).status).toBe(403);
    expect((await request('skills', { changes: [] }, 'admin', 'https://evil.test')).status).toBe(403);
  });

  it('continues after malformed, nonregular and linked skill files without changing their bytes', async () => {
    for (const name of ['ok', 'invalid', 'linked', 'hardlink', 'directory']) await createSkill(name);
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const keys = new Map(catalog.skills.map(skill => [skill.name, skill.key]));
    await writeFile(file('invalid'), '---\nname: invalid\nname: duplicate\n---\nbody');
    const invalid = await readFile(file('invalid'), 'utf8');
    await rm(file('linked')); await symlink(file('ok'), file('linked'));
    await rm(file('hardlink')); await link(file('ok'), file('hardlink'));
    // Hardlinks invalidate both names; point the link to an independent file.
    await rm(file('hardlink')); await writeFile(path.join(root, 'outside'), source('hardlink')); await link(path.join(root, 'outside'), file('hardlink'));
    await rm(file('directory')); await mkdir(file('directory'));
    const changes = ['invalid', 'linked', 'hardlink', 'directory', 'ok'].map(name => ({ key: keys.get(name)!, enabled: false }));
    const result = await request('skills', { cwd, projectId, changes }).then(response => response.json()) as SkillEnableBatchResult;
    expect(result.outcomes.map(outcome => outcome.status)).toEqual(['failed', 'failed', 'failed', 'failed', 'changed']);
    expect(await readFile(file('invalid'), 'utf8')).toBe(invalid);
    expect(await readFile(file('ok'), 'utf8')).toBe(source('ok').replace("version: '1.2'", "version: '1.2'\r\ndisable-model-invocation: true"));
    expect(result.catalog.skills.find(skill => skill.name === 'ok')?.modelInvocable).toBe(false);
    expect(JSON.stringify(result)).not.toContain('absolutePath'); expect(JSON.stringify(result)).not.toContain('const unchanged');
  });

  it('rechecks persisted trust per entry and never opens a revoked project document', async () => {
    await createSkill('global'); await createSkill('project', true);
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const global = catalog.skills.find(skill => skill.name === 'global')!; const project = catalog.skills.find(skill => skill.name === 'project')!;
    await services.trustManager.setDecision(cwd, false);
    const result = await request('skills', { cwd, projectId, changes: [{ key: project.key, enabled: false }, { key: global.key, enabled: false }] })
      .then(response => response.json()) as SkillEnableBatchResult;
    expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'PROJECT_TRUST_REQUIRED' }, { status: 'changed' }]);
    expect(await readFile(file('project', true), 'utf8')).toBe(source('project'));
    expect(result.catalog.skills.some(skill => skill.name === 'project')).toBe(false);
  });

  it('preserves scoped skill allowlists and concurrent successes, and supports a single selector and legacy toggle', async () => {
    for (const name of ['first', 'second', 'hidden']) await createSkill(name);
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const keys = new Map(catalog.skills.map(skill => [skill.name, skill.key]));
    await services.configurationStore.patch('global', { enabledSkills: [keys.get('hidden')!, 'future-skill'], thinking: 'medium' });
    await Promise.all(['first', 'second'].map(name => request('skills', { cwd, projectId, changes: [{ key: keys.get(name), enabled: true }] })));
    expect(services.configurationStore.get('global')).toMatchObject({ enabledSkills: [keys.get('hidden'), 'future-skill'], thinking: 'medium' });
    expect(services.configurationStore.get('project', projectId).enabledSkills).toEqual(expect.arrayContaining([...keys.values(), 'future-skill']));
    const before = await stat(file('first'));
    const result = await request('skills', { cwd, projectId, changes: [{ key: keys.get('first'), enabled: true }] }).then(response => response.json()) as SkillEnableBatchResult;
    expect(result.outcomes[0].status).toBe('unchanged'); expect((await stat(file('first'))).ino).toBe(before.ino);
    const legacy = await fetch(`${base}/api/skills/enabled`, { method: 'PATCH', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, projectId, enabledSkills: [keys.get('hidden')] }) });
    expect(legacy.status).toBe(200); expect((await legacy.json() as { skills: { modelInvocable: boolean }[] })
      .skills.filter((skill: { modelInvocable: boolean }) => skill.modelInvocable)).toHaveLength(1);
  });

  it('keeps a scoped effective no-op byte-stable even when metadata differs, and invalidates other workspace caches', async () => {
    await createSkill('shared');
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const key = catalog.skills.find(skill => skill.name === 'shared')!.key;
    await services.configurationStore.patch('project', { enabledSkills: [] }, projectId);
    const info = await stat(file('shared'));
    const unchanged = await request('skills', { cwd, projectId, changes: [{ key, enabled: false }] })
      .then(response => response.json()) as SkillEnableBatchResult;
    expect(unchanged.outcomes[0].status).toBe('unchanged');
    expect(await readFile(file('shared'), 'utf8')).toBe(source('shared')); expect((await stat(file('shared'))).ino).toBe(info.ino);
    const other = path.join(root, 'other-workspace'); await mkdir(other, { recursive: true });
    expect((await services.skillCatalog.getCatalog({ cwd: other })).skills.find(skill => skill.key === key)?.modelInvocable).toBe(true);
    const changed = await request('skills', { cwd, changes: [{ key, enabled: false }] }).then(response => response.json()) as SkillEnableBatchResult;
    expect(changed.outcomes[0].status).toBe('changed');
    expect((await services.skillCatalog.getCatalog({ cwd: other })).skills.find(skill => skill.key === key)?.modelInvocable).toBe(false);
  });

  it('rolls back only a failed skill settings write and keeps a later success', async () => {
    await createSkill('failed'); await createSkill('success');
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const keys = new Map(catalog.skills.map(skill => [skill.name, skill.key]));
    const original = services.configurationStore.update.bind(services.configurationStore);
    const update = vi.spyOn(services.configurationStore, 'update').mockImplementationOnce(original)
      .mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { code: 'CONFIGURATION_UNREADABLE' }));
    try {
      const result = await request('skills', { cwd, projectId, changes: ['failed', 'success'].map(name => ({ key: keys.get(name), enabled: false })) })
        .then(response => response.json()) as SkillEnableBatchResult;
      expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'CONFIGURATION_UNREADABLE' }, { status: 'changed' }]);
      expect(await readFile(file('failed'), 'utf8')).toBe(source('failed'));
      expect(await readFile(file('success'), 'utf8')).toContain('disable-model-invocation: true');
    } finally { update.mockRestore(); }
  });

  for (const interruption of ['none', 'aba', 'in-place-aba', 'revoked'] as const) it(`handles real second-publication failure (${interruption}) without overwriting an intervening writer`, async () => {
    const project = interruption === 'revoked';
    await createSkill('publication', project); await createSkill('later');
    await chmod(file('publication', project), 0o640);
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const key = catalog.skills.find(skill => skill.name === 'publication')!.key;
    const later = catalog.skills.find(skill => skill.name === 'later')!.key;
    await services.configurationStore.patch('global', { enabledSkills: [key, later, 'future-skill'] });
    const config = path.join(data, 'config.json');
    const original = services.configurationStore.update.bind(services.configurationStore);
    let calls = 0; let publicationError: unknown; let externalInode: number | undefined;
    const update = vi.spyOn(services.configurationStore, 'update').mockImplementation(async (scope, transform, id) => {
      if (++calls !== 2) return original(scope, transform, id);
      const settings = await readFile(config, 'utf8');
      try {
        // The real store reads valid settings, then its actual stable writer
        // encounters a nonregular destination. No mocked rejected Promise.
        return await original(scope, (target, inherited) => {
          const result = transform(target, inherited);
          unlinkSync(config); mkdirSync(config);
          return result;
        }, id);
      } catch (error) { publicationError = error; throw error; }
      finally {
        await rm(config, { recursive: true, force: true }); await writeFile(config, settings);
        if (interruption === 'aba') {
          const replacement = `${file('publication')}.external`;
          await writeFile(replacement, await readFile(file('publication')));
          await chmod(replacement, 0o640);
          await rename(replacement, file('publication'));
          externalInode = (await stat(file('publication'))).ino;
        }
        if (interruption === 'in-place-aba') {
          const info = await stat(file('publication'));
          const bytes = await readFile(file('publication'));
          await new Promise(resolve => setTimeout(resolve, 20));
          await writeFile(file('publication'), 'Intervening writer');
          await writeFile(file('publication'), bytes);
          await utimes(file('publication'), info.atime, info.mtime);
          externalInode = (await stat(file('publication'))).ino;
        }
        if (interruption === 'revoked') await services.trustManager.setDecision(cwd, false);
      }
    });
    try {
      const result = await request('skills', { cwd, projectId, changes: [
        { key, enabled: false }, { key: later, enabled: false },
      ] }).then(response => response.json()) as SkillEnableBatchResult;
      expect(publicationError).toMatchObject({ code: 'unsafe-target' });
      expect(result.outcomes[1]).toMatchObject({ status: 'changed' });
      expect(await readFile(file('later'), 'utf8')).toContain('disable-model-invocation: true');
      expect((await stat(file('publication', project))).mode & 0o777).toBe(0o640);
      if (interruption === 'none') {
        expect(result.outcomes[0]).toMatchObject({ status: 'failed', code: 'SKILL_WRITE_FAILED' });
        expect(await readFile(file('publication'), 'utf8')).toBe(source('publication'));
        expect(result.catalog.skills.find(skill => skill.key === key)?.modelInvocable).toBe(true);
      } else {
        expect.soft(result.outcomes[0]).toMatchObject({ status: 'failed', code: 'SKILL_ROLLBACK_FAILED' });
        expect.soft(await readFile(file('publication', project), 'utf8')).toContain('disable-model-invocation: true');
        if (interruption === 'aba' || interruption === 'in-place-aba') {
          expect.soft((await stat(file('publication'))).ino).toBe(externalInode);
          expect.soft(result.catalog.skills.find(skill => skill.key === key)?.defaultModelInvocable).toBe(false);
          // Effective settings still enable the externally replaced document.
          expect(result.catalog.skills.find(skill => skill.key === key)?.modelInvocable).toBe(true);
        } else {
          expect(result.catalog.projectTrusted).toBe(false);
          expect(result.catalog.skills.some(skill => skill.key === key)).toBe(false);
        }
      }
      expect(services.configurationStore.get('global').enabledSkills).toEqual([key, later, 'future-skill']);
      expect(services.configurationStore.get('project', projectId).enabledSkills).toEqual([key, 'future-skill']);
    } finally { update.mockRestore(); }
  });

  it('keeps inherited skill no-ops and merges fresh config without changing hidden/non-target aliases', async () => {
    await createSkill('shared'); await createSkill('shared', true); await createSkill('hidden');
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const global = catalog.skills.find(skill => skill.name === 'shared' && skill.scope === 'global')!;
    const project = catalog.skills.find(skill => skill.name === 'shared' && skill.scope === 'project')!;
    await services.configurationStore.patch('global', { enabledSkills: ['shared', 'hidden', 'future-skill'] });
    const config = path.join(data, 'config.json'); const settings = await readFile(config, 'utf8');
    const settingsInode = (await stat(config)).ino; const skillInode = (await stat(file('shared'))).ino;
    const noop = await request('skills', { cwd, projectId, changes: [{ key: global.key, enabled: true }] })
      .then(response => response.json()) as SkillEnableBatchResult;
    expect(noop.outcomes[0].status).toBe('unchanged');
    expect(await readFile(config, 'utf8')).toBe(settings); expect((await stat(config)).ino).toBe(settingsInode);
    expect((await stat(file('shared'))).ino).toBe(skillInode);
    expect(services.configurationStore.get('project', projectId).enabledSkills).toBeUndefined();
    const external = new ConfigurationStore(config); await external.load();
    const original = services.configurationStore.update.bind(services.configurationStore); let calls = 0;
    const update = vi.spyOn(services.configurationStore, 'update').mockImplementation(async (scope, transform, id) => {
      if (++calls === 2) await external.patch('global', {
        enabledSkills: ['shared', 'hidden', 'future-skill', 'fresh-unavailable'], thinking: 'high',
      });
      return original(scope, transform, id);
    });
    try {
      const result = await request('skills', { cwd, projectId, changes: [{ key: global.key, enabled: false }] })
        .then(response => response.json()) as SkillEnableBatchResult;
      expect(result.outcomes[0].status).toBe('changed');
      expect(services.configurationStore.get('global')).toEqual({
        enabledSkills: ['shared', 'hidden', 'future-skill', 'fresh-unavailable'], thinking: 'high',
      });
      expect(services.configurationStore.get('project', projectId).enabledSkills).toEqual([
        'hidden', 'future-skill', 'fresh-unavailable', project.key,
      ]);
      expect(result.catalog.skills.find(skill => skill.key === project.key)?.modelInvocable).toBe(true);
      expect(result.catalog.skills.find(skill => skill.name === 'hidden')?.modelInvocable).toBe(true);
      expect(await readFile(file('shared', true), 'utf8')).toBe(source('shared'));
      expect(await readFile(file('hidden'), 'utf8')).toBe(source('hidden'));
    } finally { update.mockRestore(); }
  });

  it('fails closed with explicit uncertain state when rollback and canonical config reconciliation are unavailable', async () => {
    await createSkill('uncertain', true);
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const key = catalog.skills.find(skill => skill.name === 'uncertain')!.key;
    await services.configurationStore.patch('global', { enabledSkills: [key] });
    const config = path.join(data, 'config.json'); const settings = await readFile(config, 'utf8');
    const original = services.configurationStore.update.bind(services.configurationStore); let calls = 0;
    const update = vi.spyOn(services.configurationStore, 'update').mockImplementation(async (scope, transform, id) => {
      if (++calls === 2) {
        await services.trustManager.setDecision(cwd, false);
        await writeFile(config, '{broken');
      }
      return original(scope, transform, id);
    });
    try {
      const response = await request('skills', { cwd, projectId, changes: [{ key, enabled: false }] });
      expect(response.status).toBe(409);
      const result = await response.json();
      expect(result).toMatchObject({ code: 'SKILL_BATCH_UNCERTAIN', outcomes: [{ key, enabled: false,
        status: 'failed', code: 'SKILL_ROLLBACK_FAILED' }] });
      expect(result).not.toHaveProperty('catalog');
      const refresh = await fetch(`${base}/api/skills?cwd=${encodeURIComponent(cwd)}&projectId=${projectId}&refresh=true`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(refresh.status).toBe(409);
      expect(await refresh.json()).toMatchObject({ code: 'CONFIGURATION_UNREADABLE' });
      expect(await readFile(config, 'utf8')).toBe('{broken');
      expect(await readFile(file('uncertain', true), 'utf8')).toContain('disable-model-invocation: true');
    } finally { update.mockRestore(); await writeFile(config, settings); }
  });

  it('rejects a file changed during staging, retains external bytes and continues with its sibling', async () => {
    await createSkill('raced', true); await createSkill('sibling', true);
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const keys = new Map(catalog.skills.map(skill => [skill.name, skill.key]));
    let checks = 0;
    const trusted = services.trustManager.isTrusted.bind(services.trustManager);
    const guard = vi.spyOn(services.trustManager, 'isTrusted').mockImplementation(async target => {
      // context + initial entry authorization + write authorization + precommit.
      if (++checks === 4) await writeFile(file('raced', true), source('raced') + 'External change\r\n');
      return trusted(target);
    });
    try {
      const result = await request('skills', { cwd, projectId, changes: ['raced', 'sibling'].map(name => ({ key: keys.get(name), enabled: false })) })
        .then(response => response.json()) as SkillEnableBatchResult;
      expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'SKILL_CHANGED' }, { status: 'changed' }]);
      expect(await readFile(file('raced', true), 'utf8')).toBe(source('raced') + 'External change\r\n');
    } finally { guard.mockRestore(); }
  });

  it('reloads canonical config after a post-publication error even when owned Markdown rollback succeeds', async () => {
    await createSkill('post-error');
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const key = catalog.skills.find(skill => skill.name === 'post-error')!.key;
    await services.configurationStore.patch('global', { enabledSkills: [key, 'future-skill'] });
    const external = new ConfigurationStore(path.join(data, 'config.json')); await external.load();
    const original = services.configurationStore.update.bind(services.configurationStore); let calls = 0;
    const update = vi.spyOn(services.configurationStore, 'update').mockImplementation(async (scope, transform, id) => {
      const result = await original(scope, transform, id);
      if (++calls === 2) {
        // Model the caller-visible error AFTER a real settings publication, then
        // make the store's in-memory state deliberately stale via another store.
        await external.patch('project', { thinking: 'high' }, projectId);
        throw Object.assign(new Error('Post-publication error'), { code: 'CONFIGURATION_POST_PUBLICATION' });
      }
      return result;
    });
    try {
      const result = await services.skillCatalog.setEnabledBatch({ cwd, projectId, changes: [{ key, enabled: false }] });
      expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'CONFIGURATION_POST_PUBLICATION' }]);
      expect(await readFile(file('post-error'), 'utf8')).toBe(source('post-error'));
      expect(services.configurationStore.get('project', projectId)).toEqual({ enabledSkills: ['future-skill'], thinking: 'high' });
      expect(result.catalog.skills.find(skill => skill.key === key)).toMatchObject({ defaultModelInvocable: true, modelInvocable: false });
    } finally { update.mockRestore(); }
  });

  for (const behavior of ['returns', 'throws'] as const) it(`does not invoke writer error-code accessors (${behavior}) and continues siblings`, async () => {
    await createSkill('accessor'); await createSkill('sibling');
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const keys = new Map(catalog.skills.map(skill => [skill.name, skill.key]));
    let reads = 0;
    const failure = Object.defineProperty({}, 'code', { get: () => {
      reads++;
      if (behavior === 'throws') throw new Error('private-getter-detail');
      return 'PRIVATE_WRITER_DETAIL';
    } });
    const original = services.configurationStore.update.bind(services.configurationStore);
    const update = vi.spyOn(services.configurationStore, 'update').mockImplementationOnce(original)
      .mockRejectedValueOnce(failure);
    try {
      const response = await request('skills', { cwd, projectId, changes: ['accessor', 'sibling'].map(name => ({
        key: keys.get(name), enabled: false,
      })) });
      expect(response.status).toBe(200);
      const result = await response.json() as SkillEnableBatchResult;
      expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'SKILL_WRITE_FAILED' }, { status: 'changed' }]);
      expect(reads).toBe(0);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_WRITER_DETAIL|private-getter-detail/);
      expect(await readFile(file('accessor'), 'utf8')).toBe(source('accessor'));
      expect(await readFile(file('sibling'), 'utf8')).toContain('disable-model-invocation: true');
    } finally { update.mockRestore(); }
  });

  it('does not return stale skill state when its initial configuration read fails', async () => {
    await createSkill('unreadable');
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const key = catalog.skills.find(skill => skill.name === 'unreadable')!.key;
    const config = path.join(data, 'config.json'); const before = await readFile(config, 'utf8');
    await writeFile(config, '{broken');
    try {
      const response = await request('skills', { cwd, projectId, changes: [{ key, enabled: false }] });
      expect(response.status).toBe(409);
      const result = await response.json();
      expect(result).toMatchObject({ code: 'SKILL_BATCH_UNCERTAIN', outcomes: [{ key, enabled: false,
        status: 'failed', code: 'CONFIGURATION_UNREADABLE' }] });
      expect(result).not.toHaveProperty('catalog');
      expect(await readFile(config, 'utf8')).toBe('{broken');
      expect(await readFile(file('unreadable'), 'utf8')).toBe(source('unreadable'));
    } finally { await writeFile(config, before); }
  });

  it('disposes both publication and rollback receipts across repeated per-entry failures', async () => {
    await createSkill('lifecycle');
    const catalog = await services.skillCatalog.getCatalog({ cwd, refresh: true });
    const key = catalog.skills.find(skill => skill.name === 'lifecycle')!.key;
    const original = services.configurationStore.update.bind(services.configurationStore);
    const update = vi.spyOn(services.configurationStore, 'update');
    try {
      // More than Core's 64-capability ceiling: leaked success/rollback receipts
      // would exhaust capacity and change the fixed outcome or disk bytes.
      for (let index = 0; index < 70; index++) {
        update.mockImplementationOnce(original).mockRejectedValueOnce(Object.assign(new Error('Settings unavailable'), {
          code: 'CONFIGURATION_UNREADABLE',
        }));
        const result = await services.skillCatalog.setEnabledBatch({ cwd, projectId, changes: [{ key, enabled: false }] });
        expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'CONFIGURATION_UNREADABLE' }]);
        expect(await readFile(file('lifecycle'), 'utf8')).toBe(source('lifecycle'));
      }
      const success = await services.skillCatalog.setEnabledBatch({ cwd, projectId, changes: [{ key, enabled: false }] });
      expect(success.outcomes[0].status).toBe('changed');
    } finally { update.mockRestore(); }
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
