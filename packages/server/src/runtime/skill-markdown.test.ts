import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { ConfigurationStore } from '../config/config-store.js';
import { SkillCatalogService } from './skill-catalog.js';

const hooks = vi.hoisted(() => ({
  afterPublish: undefined as (() => Promise<void>) | undefined,
  failPublishedStat: false,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (String(args[1]).endsWith('/SKILL.md') && hooks.afterPublish) {
        const hook = hooks.afterPublish; hooks.afterPublish = undefined; await hook();
      }
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]).endsWith('/SKILL.md') && hooks.failPublishedStat) {
        hooks.failPublishedStat = false; throw new Error('Post-publication validation failed');
      }
      return actual.lstat(...args);
    },
  };
});
const roots: string[] = [];
const source = (name: string) => `\uFEFF---\r\nname: ${name}\r\ndescription: Safe rollback\r\n# retained\r\n---\r\nBody\r\n`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-skill-receipts-')); roots.push(root);
  const cwd = path.join(root, 'project'); const data = path.join(root, 'data'); await mkdir(cwd);
  const file = (name: string) => path.join(data, 'skills', name, 'SKILL.md');
  for (const name of ['failed', 'sibling']) {
    await mkdir(path.dirname(file(name)), { recursive: true }); await writeFile(file(name), source(name)); await chmod(file(name), 0o640);
  }
  const workspace = new WorkspaceManager({ allowedRoots: [root], defaultCwd: cwd }); await workspace.initialize();
  const trust = new ProjectTrustManager(path.join(data, 'trust.json')); await trust.load(); await trust.trust(cwd);
  const configuration = new ConfigurationStore(path.join(data, 'config.json')); await configuration.load();
  const service = new SkillCatalogService(workspace, trust, configuration, data);
  const catalog = await service.getCatalog({ cwd, refresh: true });
  const changes = ['failed', 'sibling'].map(name => ({ key: catalog.skills.find(skill => skill.name === name)!.key, enabled: false }));
  return { cwd, service, file, changes };
}
afterEach(async () => {
  hooks.afterPublish = undefined; hooks.failPublishedStat = false; vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('skill per-entry receipt errors from the actual Core writer', () => {
  it('rolls back its owned first publication after a real post-rename validation error and continues', async () => {
    const { cwd, service, file, changes } = await fixture();
    const baseline = (await readdir('/proc/self/fd')).length;
    hooks.afterPublish = async () => { hooks.failPublishedStat = true; };
    const result = await service.setEnabledBatch({ cwd, changes });
    expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'SKILL_WRITE_FAILED' }, { status: 'changed' }]);
    expect(await readFile(file('failed'), 'utf8')).toBe(source('failed'));
    expect((await lstat(file('failed'))).mode & 0o777).toBe(0o640);
    expect(await readFile(file('sibling'), 'utf8')).toContain('disable-model-invocation: true');
    expect(result.catalog.skills.find(skill => skill.key === changes[0].key)?.defaultModelInvocable).toBe(true);
    expect((await readdir('/proc/self/fd')).length).toBe(baseline);
  });

  it('refuses rollback when the first publication was replaced before validation and returns fresh canonical metadata', async () => {
    const { cwd, service, file, changes } = await fixture(); let externalInode: number | undefined;
    const baseline = (await readdir('/proc/self/fd')).length;
    hooks.afterPublish = async () => {
      const external = `${file('failed')}.external`; await writeFile(external, await readFile(file('failed')));
      await chmod(external, 0o640); await rename(external, file('failed')); externalInode = (await lstat(file('failed'))).ino;
    };
    const result = await service.setEnabledBatch({ cwd, changes });
    expect(result.outcomes).toMatchObject([{ status: 'failed', code: 'SKILL_ROLLBACK_FAILED' }, { status: 'changed' }]);
    expect((await lstat(file('failed'))).ino).toBe(externalInode);
    expect(await readFile(file('failed'), 'utf8')).toContain('disable-model-invocation: true');
    expect(result.catalog.skills.find(skill => skill.key === changes[0].key)).toMatchObject({
      defaultModelInvocable: false, modelInvocable: false,
    });
    expect((await readdir('/proc/self/fd')).length).toBe(baseline);
  });
});
