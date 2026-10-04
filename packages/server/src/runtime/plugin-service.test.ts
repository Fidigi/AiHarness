import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import {
  parsePluginSource,
  PluginService,
  type PluginCommandRunner,
} from './plugin-service.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-plugins-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixturePackage(root: string, version = '1.0.0'): Promise<void> {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'skills', 'review'), { recursive: true });
  await mkdir(path.join(root, 'prompts'), { recursive: true });
  await mkdir(path.join(root, 'themes'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: '@demo/plugin',
    version,
    description: 'Safe test plugin',
    aiHarness: {
      extensions: ['src/**/*.js'],
      skills: ['skills'],
      prompts: ['prompts/*.md'],
      themes: ['themes/*.json'],
    },
  }));
  await writeFile(path.join(root, 'src', 'tool.js'), 'export default () => undefined;');
  await writeFile(path.join(root, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review files\n---\nSecret instructions');
  await writeFile(path.join(root, 'prompts', 'review.md'), '# Review');
  await writeFile(path.join(root, 'themes', 'night.json'), '{"name":"night"}');
}

async function setup(root: string, runner?: PluginCommandRunner): Promise<{
  project: string;
  data: string;
  trust: ProjectTrustManager;
  service: PluginService;
}> {
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  await mkdir(project, { recursive: true });
  await mkdir(data, { recursive: true });
  const workspaces = new WorkspaceManager({ allowedRoots: [root], defaultCwd: project });
  await workspaces.initialize();
  const trust = new ProjectTrustManager(path.join(data, 'trust.json'));
  await trust.load();
  const service = new PluginService(workspaces, trust, path.join(data, 'plugins.json'), data, runner);
  await service.load();
  return { project, data, trust, service };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('parsePluginSource', () => {
  it('normalizes supported sources and rejects ambiguous or credential-bearing input', () => {
    expect(parsePluginSource(' npm:@scope/tool@^2.0.0 ')).toMatchObject({
      normalized: 'npm:@scope/tool@^2.0.0', type: 'npm', packageName: '@scope/tool', configuredVersion: '^2.0.0',
    });
    expect(parsePluginSource('git:github.com/example/plugin.git#main')).toMatchObject({
      normalized: 'git:https://github.com/example/plugin.git#main', type: 'git', gitRef: 'main',
    });
    expect(parsePluginSource('/tmp/plugin')).toMatchObject({ type: 'path', localPath: '/tmp/plugin' });
    expect(() => parsePluginSource('./plugin')).toThrow(/absolu/i);
    expect(() => parsePluginSource('git:https://token@github.com/example/plugin')).toThrow(/credentials/i);
    expect(() => parsePluginSource('git:https://localhost/example/plugin')).toThrow(/refusée/i);
    expect(() => parsePluginSource('npm:--registry=evil')).toThrow(/invalide/i);
  });
});

describe('PluginService', () => {
  it('inventories package resources without contents or symlink traversal and gates project changes on trust', async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, 'source-plugin');
    const outside = path.join(root, 'outside');
    await fixturePackage(source);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'leak.js'), 'credential=do-not-expose');
    await symlink(outside, path.join(source, 'extensions-link'));
    const { project, trust, service } = await setup(root);

    const global = await service.install({ cwd: project, scope: 'global', source });
    const globalPackage = global.packages[0]!;
    expect(globalPackage).toMatchObject({
      scope: 'global', enabled: true, trusted: true, status: 'active', version: '1.0.0',
      counts: { extensions: 1, skills: 1, prompts: 1, themes: 1 },
      restartRequired: true,
    });
    expect(JSON.stringify(global)).not.toContain('Secret instructions');
    expect(JSON.stringify(global)).not.toContain('do-not-expose');
    await expect(service.install({ cwd: project, scope: 'project', source })).rejects.toMatchObject({
      code: 'PROJECT_TRUST_REQUIRED',
    });

    await trust.trust(project);
    const projectCatalog = await service.install({ cwd: project, scope: 'project', source });
    const projectPackage = projectCatalog.packages.find(item => item.scope === 'project')!;
    expect(projectPackage.trusted).toBe(true);
    const roots = await service.getEnabledSkillRoots({ cwd: project, projectId: projectCatalog.projectId });
    expect(roots).toHaveLength(2);
    expect(roots.every(item => item.directory.endsWith(path.join('skills', 'review')))).toBe(true);

    const disabled = await service.setEnabled({
      cwd: project, projectId: projectCatalog.projectId, scope: 'project', key: projectPackage.key, enabled: false,
    });
    expect(disabled.packages.find(item => item.key === projectPackage.key)).toMatchObject({ enabled: false, status: 'disabled' });
    const enabled = await service.setEnabled({
      cwd: project, projectId: projectCatalog.projectId, scope: 'project', key: projectPackage.key, enabled: true,
    });
    expect(enabled.packages.find(item => item.key === projectPackage.key)?.status).toBe('active');
    const removed = await service.remove({
      cwd: project, projectId: projectCatalog.projectId, scope: 'project', key: projectPackage.key,
    });
    expect(removed.packages).toHaveLength(1);

    const persisted = JSON.parse(await readFile(path.join(root, 'data', 'plugins.json'), 'utf8')) as { packages: unknown[] };
    expect(persisted.packages).toHaveLength(1);
  });

  it('hides untrusted project resources while retaining actionable metadata', async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, 'source-plugin');
    await fixturePackage(source);
    const first = await setup(root);
    await first.trust.trust(first.project);
    const installed = await first.service.install({ cwd: first.project, scope: 'project', source });
    await first.trust.untrust(first.project);

    const catalog = await first.service.getCatalog({ cwd: first.project, projectId: installed.projectId, refresh: true });
    expect(catalog.projectResourcesLoaded).toBe(false);
    expect(catalog.packages[0]).toMatchObject({ trusted: false, status: 'installed', counts: EMPTY_COUNTS_FOR_TEST });
    expect(catalog.packages[0]?.diagnostics[0]?.code).toBe('PROJECT_TRUST_REQUIRED');
    expect(await first.service.getEnabledSkillRoots({ cwd: first.project })).toEqual([]);
  });

  it('installs and updates npm packages in staging, checks versions only on request, and keeps state across reloads', async () => {
    const root = await temporaryDirectory();
    let installCount = 0;
    let failInstall = false;
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: PluginCommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === 'npm' && args[0] === 'install') {
          if (failInstall) throw new Error('sanitized install failure');
          installCount++;
          const prefix = args[args.indexOf('--prefix') + 1]!;
          await fixturePackage(path.join(prefix, 'node_modules', '@demo', 'plugin'), `${installCount}.0.0`);
          return { stdout: '', stderr: '' };
        }
        if (command === 'npm' && args[0] === 'view') return { stdout: '"2.0.0"', stderr: '' };
        throw new Error(`Unexpected command: ${command}`);
      },
    };
    const { project, data, service } = await setup(root, runner);
    const installed = await service.install({ cwd: project, scope: 'global', source: 'npm:@demo/plugin' });
    const pkg = installed.packages[0]!;
    expect(pkg).toMatchObject({ sourceType: 'npm', version: '1.0.0', installedPath: expect.stringContaining('plugins/') });
    expect(calls.filter(call => call.args[0] === 'view')).toHaveLength(0);

    await expect(service.checkUpdates({ cwd: project, key: pkg.key, scope: 'global' }))
      .resolves.toEqual([expect.objectContaining({ state: 'update-available', availableVersion: '2.0.0' })]);

    const persist = vi.spyOn(service as unknown as { persist(): Promise<void> }, 'persist');
    const originalUpdatedAt = pkg.updatedAt;
    persist.mockRejectedValueOnce(new Error('state write failed'));
    await expect(service.setEnabled({ cwd: project, key: pkg.key, scope: 'global', enabled: false }))
      .rejects.toThrow('state write failed');
    expect((await service.getCatalog({ cwd: project, refresh: true })).packages[0]).toMatchObject({
      enabled: true,
      updatedAt: originalUpdatedAt,
    });

    persist.mockRejectedValueOnce(new Error('state write failed'));
    await expect(service.remove({ cwd: project, key: pkg.key, scope: 'global' })).rejects.toThrow('state write failed');
    expect((await service.getCatalog({ cwd: project, refresh: true })).packages[0]).toMatchObject({
      key: pkg.key,
      status: 'active',
    });

    const localSource = path.join(root, 'local-rollback-plugin');
    await fixturePackage(localSource);
    persist.mockRejectedValueOnce(new Error('state write failed'));
    await expect(service.install({ cwd: project, scope: 'global', source: localSource })).rejects.toThrow('state write failed');
    expect((await service.getCatalog({ cwd: project, refresh: true })).packages).toHaveLength(1);

    persist.mockRejectedValueOnce(new Error('state write failed'));
    await expect(service.update({ cwd: project, key: pkg.key, scope: 'global' })).rejects.toThrow('state write failed');
    expect((await service.getCatalog({ cwd: project, refresh: true })).packages[0]?.version).toBe('1.0.0');
    installCount = 1;

    const updated = await service.update({ cwd: project, key: pkg.key, scope: 'global' });
    expect(updated.packages[0]?.version).toBe('2.0.0');
    failInstall = true;
    await expect(service.update({ cwd: project, key: pkg.key, scope: 'global' })).rejects.toThrow('sanitized install failure');
    expect((await service.getCatalog({ cwd: project, refresh: true })).packages[0]?.version).toBe('2.0.0');
    failInstall = false;

    const workspaces = new WorkspaceManager({ allowedRoots: [root], defaultCwd: project });
    await workspaces.initialize();
    const trust = new ProjectTrustManager(path.join(data, 'trust.json'));
    await trust.load();
    const restored = new PluginService(workspaces, trust, path.join(data, 'plugins.json'), data, runner);
    await restored.load();
    await expect(restored.getCatalog({ cwd: project })).resolves.toMatchObject({
      packages: [expect.objectContaining({ version: '2.0.0', status: 'active' })],
    });
  });

  it('uses a shallow Git checkout, ignores lifecycle scripts, and compares the installed revision explicitly', async () => {
    const root = await temporaryDirectory();
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const runner: PluginCommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        if (command === 'git' && args[0] === 'clone') {
          await fixturePackage(args.at(-1)!, '0.4.0');
          return { stdout: '', stderr: '' };
        }
        if (command === 'npm' && args[0] === 'install') return { stdout: '', stderr: '' };
        if (command === 'git' && args.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
        if (command === 'git' && args[0] === 'ls-remote') return { stdout: `${'b'.repeat(40)}\trefs/heads/main\n`, stderr: '' };
        throw new Error(`Unexpected command: ${command}`);
      },
    };
    const { project, trust, service } = await setup(root, runner);
    await trust.trust(project);
    const catalog = await service.install({
      cwd: project,
      scope: 'project',
      source: 'git:https://github.com/example/plugin.git#main',
    });
    const pkg = catalog.packages[0]!;
    expect(pkg).toMatchObject({ sourceType: 'git', version: '0.4.0', configuredVersion: 'main', installedRevision: 'a'.repeat(40) });
    expect(calls.find(call => call.command === 'git' && call.args[0] === 'clone')?.args).toEqual([
      'clone', '--depth', '1', '--single-branch', '--branch', 'main', '--',
      'https://github.com/example/plugin.git', expect.stringContaining('.staging-'),
    ]);
    expect(calls.find(call => call.command === 'npm')?.args).toContain('--ignore-scripts');
    await expect(service.checkUpdates({ cwd: project, projectId: catalog.projectId, key: pkg.key, scope: 'project' }))
      .resolves.toEqual([expect.objectContaining({ state: 'update-available', availableVersion: 'b'.repeat(40) })]);
  });

  it('commits reload generations only after every active package validates and inventories standalone extensions by trust', async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, 'source-plugin');
    await fixturePackage(source);
    const { project, data, trust, service } = await setup(root);
    await mkdir(path.join(data, 'extensions'), { recursive: true });
    await writeFile(path.join(data, 'extensions', 'global.js'), 'export default () => undefined;');
    await mkdir(path.join(project, '.ai-harness', 'extensions'), { recursive: true });
    await writeFile(path.join(project, '.ai-harness', 'extensions', 'project.js'), 'export default () => undefined;');
    const installed = await service.install({ cwd: project, scope: 'global', source });
    const otherProject = path.join(root, 'other-project');
    await mkdir(otherProject);
    expect((await service.getCatalog({ cwd: otherProject })).generation).toBe(0);

    const untrustedReload = await service.reload({ cwd: project });
    expect(untrustedReload.catalog.standaloneExtensions.map(item => item.name)).toEqual(['global']);
    expect(untrustedReload.reload).toMatchObject({ generation: 1, restartRequired: true });
    expect((await service.getCatalog({ cwd: otherProject })).generation).toBe(1);
    await trust.trust(project);
    const trusted = await service.getCatalog({ cwd: project, refresh: true });
    expect(trusted.standaloneExtensions.map(item => item.name).sort()).toEqual(['global', 'project']);

    await rm(source, { recursive: true, force: true });
    await expect(service.reload({ cwd: project })).rejects.toMatchObject({ code: 'PLUGIN_RELOAD_FAILED' });
    const failed = await service.getCatalog({ cwd: project, refresh: true });
    expect(failed.generation).toBe(1);
    expect(failed.packages.find(item => item.key === installed.packages[0]!.key)?.status).toBe('missing');
  });
});

const EMPTY_COUNTS_FOR_TEST = { extensions: 0, skills: 0, prompts: 0, themes: 0 };
