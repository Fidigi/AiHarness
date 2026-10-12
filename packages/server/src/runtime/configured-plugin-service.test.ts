import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { createConfiguredPluginService } from './configured-plugin-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-configured-plugin-')); roots.push(root);
  const cwd = path.join(root, 'workspace'); const dataDir = path.join(root, 'data');
  await mkdir(cwd); await mkdir(dataDir);
  const workspaceManager = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd });
  await workspaceManager.initialize();
  const trustManager = new ProjectTrustManager(path.join(dataDir, 'trust.json')); await trustManager.load();
  return { cwd, dataDir, workspaceManager, trustManager, restricted: false };
}

describe('operation-local configured package service', () => {
  it('canonicalizes default/source cwd and validates its ID without creating state or validating npm eagerly', async () => {
    const deps = await fixture();
    await writeFile(path.join(deps.dataDir, 'settings.json'), JSON.stringify({ npmCommand: ['-invalid-private'] }));
    const operation = await createConfiguredPluginService(deps, { cwd: path.join(deps.cwd, '..', 'workspace') });
    const descriptor = await deps.workspaceManager.describe(deps.cwd, false);
    expect(operation.context).toEqual({ cwd: deps.cwd, projectId: descriptor.id });
    expect((await operation.service.getCatalog(operation.context)).packages).toEqual([]);
    expect((await createConfiguredPluginService(deps)).service).not.toBe(operation.service);
    await expect(createConfiguredPluginService(deps, { projectId: 'wrong' })).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' });
  });

  it('captures project settings, not continuing executable authority, for an admitted global operation', async () => {
    const deps = await fixture();
    const local = path.join(deps.cwd, '.ai-harness'); await mkdir(local);
    const executable = path.join(local, 'npm.cjs'); const marker = path.join(deps.dataDir, 'executed');
    await writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    await chmod(executable, 0o700);
    const settingsPath = path.join(local, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ npmCommand: ['./npm.cjs', 'literal project prefix'] }));
    await deps.trustManager.trust(deps.cwd);
    const admitted = await createConfiguredPluginService(deps);
    const before = await readFile(settingsPath);
    const writer = new ProjectTrustManager(path.join(deps.dataDir, 'trust.json')); await writer.load();
    await writer.setDecision(deps.cwd, false);
    // An embedding input assertion must not authorize the captured project's command.
    await expect(admitted.service.install({ ...admitted.context, projectTrusted: true, scope: 'global', source: 'npm:refused' }))
      .rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    expect(await readFile(settingsPath)).toEqual(before);
    expect(await readdir(deps.dataDir)).not.toContain('executed');
    expect((await readdir(deps.dataDir)).filter(name => /plugins.*(?:json|lock|tmp)/.test(name))).toEqual([]);
    expect((await readdir(path.join(deps.dataDir, 'plugins'))).filter(name => /staging|backup/.test(name))).toEqual([]);
  });

  it('refuses restricted administration before filesystem/settings admission', async () => {
    const deps = await fixture();
    await expect(createConfiguredPluginService({ ...deps, restricted: true }, { cwd: '/not-present' }))
      .rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_OWNER_UNAVAILABLE' });
  });
});
