import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { SubagentService } from './subagent-service.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  root: string;
  project: string;
  workspaceId: string;
  service: SubagentService;
  filePath: string;
  workspaces: WorkspaceManager;
  trust: ProjectTrustManager;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-subagents-'));
  temporaryDirectories.push(root);
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const workspaces = new WorkspaceManager({ allowedRoots: [root], defaultCwd: project });
  await workspaces.initialize();
  const trust = new ProjectTrustManager(path.join(root, 'trust.json'));
  await trust.load();
  await trust.trust(project);
  const filePath = path.join(root, 'subagents.json');
  const service = new SubagentService(workspaces, trust, filePath);
  await service.load();
  const descriptor = await workspaces.describe(project, true);
  return { root, project, workspaceId: descriptor.id, service, filePath, workspaces, trust };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('SubagentService', () => {
  it('provides built-ins and persists scoped CRUD settings', async () => {
    const { project, workspaceId, service, filePath, workspaces, trust } = await fixture();
    const defaults = await service.getConfiguration({ cwd: project, projectId: workspaceId });
    expect(defaults).toMatchObject({ engineEnabled: true, maxConcurrency: 4, scope: 'global', source: 'built-in' });
    expect(defaults.profiles.map(profile => profile.id)).toEqual(['explore', 'general', 'plan']);

    const settings = await service.updateSettings(
      { cwd: project, projectId: workspaceId, scope: 'project' },
      { engineEnabled: true, maxConcurrency: 2 },
    );
    expect(settings).toMatchObject({ scope: 'project', source: workspaceId, maxConcurrency: 2 });
    const created = await service.createProfile({ cwd: project, projectId: workspaceId }, {
      id: 'security-review', name: 'Security review', description: 'Review boundaries',
      instructions: 'Inspect trust boundaries.', kind: 'custom', enabled: true,
      tools: ['read_file'], skills: ['review'], extensions: ['safe-extension'],
      thinking: 'high', maxTurns: 6, inheritContext: false, background: true,
    });
    expect(created.profiles).toContainEqual(expect.objectContaining({
      id: 'security-review', builtIn: false, tools: ['read_file'], skills: ['review'],
    }));
    const updated = await service.updateProfile(
      { cwd: project, projectId: workspaceId }, 'security-review', { maxTurns: 7, enabled: false },
    );
    expect(updated.profiles.find(profile => profile.id === 'security-review')).toMatchObject({ maxTurns: 7, enabled: false });
    const duplicated = await service.duplicateProfile({ cwd: project, projectId: workspaceId }, 'security-review');
    const copy = duplicated.profiles.find(profile => profile.name === 'Security review copy');
    expect(copy).toMatchObject({ kind: 'custom', builtIn: false });
    const removed = await service.deleteProfile({ cwd: project, projectId: workspaceId }, copy!.id);
    expect(removed.profiles.some(profile => profile.id === copy!.id)).toBe(false);
    await expect(service.deleteProfile({ cwd: project, projectId: workspaceId }, 'explore'))
      .rejects.toMatchObject({ code: 'BUILTIN_PROFILE' });

    const reloaded = new SubagentService(workspaces, trust, filePath);
    await reloaded.load();
    await expect(reloaded.getConfiguration({ cwd: project, projectId: workspaceId }))
      .resolves.toMatchObject({ maxConcurrency: 2, scope: 'project' });
  });

  it('rejects workspace mismatches and invalid profile policies', async () => {
    const { project, service } = await fixture();
    await expect(service.getConfiguration({ cwd: project, projectId: 'wrong' }))
      .rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' });
    await expect(service.createProfile({ cwd: project }, {
      name: 'Invalid', description: 'Invalid', instructions: 'Invalid', kind: 'custom', enabled: true,
      tools: ['../../escape'], skills: [], extensions: [], maxTurns: 100,
      inheritContext: true, background: false,
    })).rejects.toMatchObject({ code: 'INVALID_SUBAGENT_PROFILE' });
  });
});
