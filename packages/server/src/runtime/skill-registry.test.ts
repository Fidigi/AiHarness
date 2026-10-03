import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillCatalogService } from './skill-catalog.js';
import { SkillRegistryService } from './skill-registry.js';

const roots: string[] = [];
const validSkill = ['---', 'name: registry-review', 'description: Registry review', 'version: 2.0.0', '---', 'Review carefully.'].join('\n');
const digest = createHash('sha256').update(validSkill).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-skill-registry-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  await mkdir(project, { recursive: true });
  const workspaces = new WorkspaceManager({ allowedRoots: [root], defaultCwd: project });
  await workspaces.initialize();
  const trust = new ProjectTrustManager(path.join(data, 'trust.json'));
  await trust.load();
  const skillCatalog = {
    getCatalog: vi.fn().mockResolvedValue({ skills: [] }), invalidate: vi.fn(),
  } as unknown as SkillCatalogService;
  const service = new SkillRegistryService(workspaces, trust, skillCatalog, data, 'http://registry.test/index.json');
  return { root, project, data, workspaces, trust, skillCatalog, service };
}

function registry(content = validSkill, expectedDigest = digest) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const value = String(url);
    if (value.endsWith('/index.json')) return new Response(JSON.stringify({ version: 1, skills: [{
      id: 'registry-review', name: 'registry-review', description: 'Registry review', version: '2.0.0',
      downloadUrl: 'http://registry.test/registry-review.md', sha256: expectedDigest,
    }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(content, { status: 200, headers: { 'Content-Type': 'text/markdown' } });
  }));
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('SkillRegistryService', () => {
  it('searches a bounded registry and atomically installs trusted project skills', async () => {
    const { project, trust, skillCatalog, service } = await fixture();
    registry();
    const found = await service.search({ query: 'review', cwd: project, refresh: true });
    expect(found.entries).toEqual([expect.objectContaining({ name: 'registry-review', version: '2.0.0', sha256: digest })]);

    await expect(service.install({ id: 'registry-review', scope: 'project', cwd: project }))
      .rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    await trust.trust(project);
    const installed = await service.install({ id: 'registry-review', scope: 'project', cwd: project });
    expect(installed.path).toBe(path.join(project, '.ai-harness', 'skills', 'registry-review', 'SKILL.md'));
    expect(await readFile(installed.path, 'utf8')).toBe(validSkill);
    expect(skillCatalog.invalidate).toHaveBeenCalledWith(project);
  });

  it('requires SHA-256 metadata and leaves the prior version intact after an integrity failure', async () => {
    const { data, service } = await fixture();
    registry();
    const first = await service.install({ id: 'registry-review', scope: 'global' });
    expect(await readFile(first.path, 'utf8')).toBe(validSkill);

    registry('tampered body', digest);
    await expect(service.install({ id: 'registry-review', scope: 'global' }))
      .rejects.toMatchObject({ code: 'SKILL_INTEGRITY_FAILED' });
    expect(await readFile(path.join(data, 'skills', 'registry-review', 'SKILL.md'), 'utf8')).toBe(validSkill);

    const invalidFixture = await fixture();
    registry(validSkill, 'missing');
    const invalid = await invalidFixture.service.search({ refresh: true });
    expect(invalid.entries).toEqual([]);
    expect(invalid.error).toContain('SHA-256');
  });

  it('rejects a symlink in the project destination ancestry', async () => {
    const { root, project, trust, service } = await fixture();
    registry();
    await trust.trust(project);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(project, '.ai-harness'));
    await expect(service.install({ id: 'registry-review', scope: 'project', cwd: project }))
      .rejects.toMatchObject({ code: 'SKILL_SYMLINK_REJECTED' });
  });
});
