import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { ConfigurationStore } from '../config/config-store.js';
import { SkillCatalogService } from './skill-catalog.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-skills-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function skill(filePath: string, frontmatter: string[], instructions: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, ['---', ...frontmatter, '---', instructions].join('\n'));
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('SkillCatalogService', () => {
  it('discovers all scopes, gates project skills on trust and applies project invocation settings', async () => {
    const root = await temporaryDirectory();
    const project = path.join(root, 'project');
    const data = path.join(root, 'data');
    const configuredPath = path.join(root, 'configured-skills');
    await mkdir(project, { recursive: true });
    await skill(path.join(data, 'skills', 'global-review', 'SKILL.md'),
      ['name: global-review', 'description: Global review', 'version: 1.0.0'], 'Global instructions');
    await skill(path.join(data, 'packages', 'quality-pack', 'skills', 'package-review', 'SKILL.md'),
      ['name: package-review', 'description: Package review'], 'Package instructions');
    await skill(path.join(configuredPath, 'path-review', 'SKILL.md'),
      ['name: path-review', 'description: Path review', 'disable-model-invocation: true'], 'Path instructions');
    await skill(path.join(project, '.agents', 'skills', 'project-review', 'SKILL.md'),
      ['name: project-review', 'description: Project review'], 'Project instructions');
    vi.stubEnv('AI_HARNESS_SKILL_PATHS', configuredPath);

    const workspaces = new WorkspaceManager({ allowedRoots: [root], defaultCwd: project });
    await workspaces.initialize();
    const trust = new ProjectTrustManager(path.join(data, 'trust.json'));
    await trust.load();
    const configuration = new ConfigurationStore(path.join(data, 'config.json'));
    await configuration.load();
    const service = new SkillCatalogService(workspaces, trust, configuration, data);

    const untrusted = await service.getCatalog({ cwd: project });
    expect(new Set(untrusted.skills.map(entry => entry.scope))).toEqual(new Set(['global', 'package', 'path', 'project']));
    expect(untrusted.projectTrusted).toBe(false);
    expect(untrusted.skills.find(entry => entry.name === 'global-review')).toMatchObject({
      trusted: true, modelInvocable: true, filePath: '~/.ai-harness/skills/global-review/SKILL.md',
    });
    expect(untrusted.skills.find(entry => entry.name === 'path-review')).toMatchObject({
      trusted: true, defaultModelInvocable: false, modelInvocable: false,
    });
    expect(untrusted.skills.find(entry => entry.name === 'project-review')).toMatchObject({
      trusted: false, modelInvocable: false, source: '.agents/skills',
    });

    await trust.trust(project);
    const trusted = await service.getCatalog({ cwd: project });
    const globalKey = trusted.skills.find(entry => entry.name === 'global-review')!.key;
    await configuration.patch('global', { enabledSkills: [globalKey] });
    const globalConfigured = await service.getCatalog({ cwd: project });
    expect(globalConfigured.enabledScope).toBe('global');
    expect(globalConfigured.skills.filter(entry => entry.modelInvocable).map(entry => entry.name)).toEqual(['global-review']);
    const selected = trusted.skills.filter(entry => ['path-review', 'project-review'].includes(entry.name));
    await configuration.patch('project', { enabledSkills: selected.map(entry => entry.key) }, trusted.projectId);
    const configured = await service.getCatalog({ cwd: project });
    expect(configured.enabledScope).toBe('project');
    expect(configured.skills.filter(entry => entry.modelInvocable).map(entry => entry.name))
      .toEqual(['path-review', 'project-review']);
    await expect(service.getModelInvocableSkills({ cwd: project, projectId: configured.projectId }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'path-review', instructions: 'Path instructions' }),
        expect.objectContaining({ name: 'project-review', instructions: 'Project instructions' }),
      ]));
    await expect(service.getModelInvocableSkills({
      cwd: project, projectId: configured.projectId, allowedSkills: ['project-review'],
    })).resolves.toEqual([expect.objectContaining({ name: 'project-review' })]);
    await expect(service.resolveModelInvocableSkill('path-review', {
      cwd: project, projectId: configured.projectId, allowedSkills: ['project-review'],
    })).resolves.toBeUndefined();
  });

  it('keeps duplicate names addressable and resolves them by project scope precedence', async () => {
    const root = await temporaryDirectory();
    const project = path.join(root, 'project');
    const data = path.join(root, 'data');
    const configuredPath = path.join(root, 'configured-skills');
    await mkdir(project, { recursive: true });
    await skill(path.join(data, 'skills', 'shared', 'SKILL.md'),
      ['name: shared', 'description: Global shared'], 'Global shared instructions');
    await skill(path.join(data, 'packages', 'pack', 'skills', 'shared', 'SKILL.md'),
      ['name: shared', 'description: Package shared'], 'Package shared instructions');
    await skill(path.join(configuredPath, 'shared', 'SKILL.md'),
      ['name: shared', 'description: Path shared'], 'Path shared instructions');
    await skill(path.join(project, '.agents', 'skills', 'shared', 'SKILL.md'),
      ['name: shared', 'description: Project shared'], 'Project shared instructions');
    vi.stubEnv('AI_HARNESS_SKILL_PATHS', configuredPath);
    const workspaces = new WorkspaceManager({ allowedRoots: [root], defaultCwd: project });
    await workspaces.initialize();
    const trust = new ProjectTrustManager(path.join(data, 'trust.json'));
    await trust.load();
    await trust.trust(project);
    const configuration = new ConfigurationStore(path.join(data, 'config.json'));
    await configuration.load();
    const service = new SkillCatalogService(workspaces, trust, configuration, data);

    const catalog = await service.getCatalog({ cwd: project });
    const duplicates = catalog.skills.filter(entry => entry.name === 'shared');
    expect(duplicates).toHaveLength(4);
    expect(new Set(duplicates.map(entry => entry.key)).size).toBe(4);
    await expect(service.resolveModelInvocableSkill('shared', { cwd: project, projectId: catalog.projectId }))
      .resolves.toMatchObject({ instructions: 'Project shared instructions' });
    const global = duplicates.find(entry => entry.scope === 'global')!;
    await configuration.patch('project', { enabledSkills: [global.key] }, catalog.projectId);
    await expect(service.resolveModelInvocableSkill('shared', { cwd: project, projectId: catalog.projectId }))
      .resolves.toMatchObject({ instructions: 'Global shared instructions' });
  });

  it('rejects mismatched workspace identifiers and reports malformed skills without exposing instructions', async () => {
    const root = await temporaryDirectory();
    const project = path.join(root, 'project');
    const data = path.join(root, 'data');
    await mkdir(project, { recursive: true });
    await skill(path.join(project, '.agents', 'skills', 'empty', 'SKILL.md'), ['name: empty'], '');
    const linked = path.join(root, 'linked-skill');
    await skill(path.join(linked, 'SKILL.md'), ['name: linked'], 'Must not be followed');
    await symlink(linked, path.join(project, '.agents', 'skills', 'linked'));
    const workspaces = new WorkspaceManager({ allowedRoots: [root], defaultCwd: project });
    await workspaces.initialize();
    const trust = new ProjectTrustManager(path.join(data, 'trust.json'));
    await trust.load();
    const configuration = new ConfigurationStore(path.join(data, 'config.json'));
    await configuration.load();
    const service = new SkillCatalogService(workspaces, trust, configuration, data);

    await expect(service.getCatalog({ cwd: project, projectId: 'wrong' })).rejects.toMatchObject({
      code: 'WORKSPACE_MISMATCH',
    });
    const catalog = await service.getCatalog({ cwd: project });
    expect(catalog.errorCount).toBe(1);
    expect(catalog.skills).toEqual([]);
    expect(JSON.stringify(catalog)).not.toContain('instructions');
  });
});
