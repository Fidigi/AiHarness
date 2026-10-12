import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectTrustManager } from '../security/project-trust.js';
import { WorkspaceManager } from '../security/workspace-manager.js';
import {
  parsePluginSource,
  PluginService,
  type PluginCommandRunner,
  type PluginNpmCommandOptions,
} from './plugin-service.js';
import { createPluginCommandRunner, resolvePluginNpmCommand } from './package-command.js';
import { loadAgentSettings } from '../config/agent-settings.js';
import { PluginService as PublicPluginService, resolvePluginNpmCommand as publicNpmOptions } from '@ai-harness/core';

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
    pi: {
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

async function setup(root: string, runner?: PluginCommandRunner, npmOptions?: PluginNpmCommandOptions): Promise<{
  project: string;
  data: string;
  trust: ProjectTrustManager;
  workspaces: WorkspaceManager;
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
  const service = new PluginService(workspaces, trust, path.join(data, 'plugins.json'), data, runner, npmOptions);
  await service.load();
  return { project, data, trust, workspaces, service };
}

afterEach(async () => {
  vi.unstubAllEnvs();
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
    expect(parsePluginSource('./plugin', '/workspace')).toMatchObject({
      normalized: path.join('/workspace', 'plugin'), type: 'path', localPath: path.join('/workspace', 'plugin'),
    });
    expect(() => parsePluginSource('ambiguous-package-name')).toThrow(/npm|git|local/i);
    expect(() => parsePluginSource('git:https://token@github.com/example/plugin')).toThrow(/credentials/i);
    expect(() => parsePluginSource('git:https://localhost/example/plugin')).toThrow(/refusée/i);
    expect(() => parsePluginSource('npm:--registry=evil')).toThrow(/invalide/i);
  });
});

describe('PluginService', () => {
  it('checks only requested package scopes even without an individual key', async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, 'source-plugin');
    await fixturePackage(source);
    const runner = { run: vi.fn(async () => { throw new Error('No process expected.'); }) };
    const { project, data, trust, service } = await setup(root, runner);
    await service.install({ cwd: project, scope: 'global', source });
    await trust.trust(project);
    const catalog = await service.install({ cwd: project, scope: 'project', source });
    const originalState = await readFile(path.join(data, 'plugins.json'), 'utf8');
    for (const scope of ['global', 'project'] as const) {
      const result = await service.checkUpdates({ cwd: project, scope });
      expect(result.map(item => item.scope)).toEqual([scope]);
      const other = catalog.packages.find(item => item.scope !== scope)!;
      await expect(service.checkUpdates({ cwd: project, scope, key: other.key })).rejects.toMatchObject({
        code: 'PLUGIN_NOT_FOUND',
      });
    }
    expect(await service.checkUpdates({ cwd: project })).toHaveLength(2);
    await trust.refuse(project);
    // Administration still exposes the safe metadata-only local-source outcome.
    expect(await service.checkUpdates({ cwd: project, scope: 'project' })).toMatchObject([
      { scope: 'project', state: 'unsupported' },
    ]);
    expect(await readFile(path.join(data, 'plugins.json'), 'utf8')).toBe(originalState);
    expect(runner.run).not.toHaveBeenCalled();
  });

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

    const configured = await service.configure({
      cwd: project,
      projectId: projectCatalog.projectId,
      scope: 'project',
      key: projectPackage.key,
      resourceFilters: { extensions: [], skills: ['+skills/review'], prompts: ['!prompts/review.md'] },
    });
    expect(configured.packages.find(item => item.key === projectPackage.key)).toMatchObject({
      counts: { extensions: 0, skills: 1, prompts: 0, themes: 1 },
      resourceFilters: { extensions: [], skills: ['+skills/review'], prompts: ['!prompts/review.md'] },
    });
    expect(await service.getEnabledResourceLocations('extension', {
      cwd: project, projectId: projectCatalog.projectId,
    })).toHaveLength(1);

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

  it('applies group activation in one write and reports untrusted entries independently', async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, 'batch-plugin');
    await fixturePackage(source);
    const { project, trust, service } = await setup(root);

    const globalCatalog = await service.install({ cwd: project, scope: 'global', source });
    await trust.trust(project);
    const installed = await service.install({ cwd: project, scope: 'project', source });
    const globalPackage = globalCatalog.packages[0]!;
    const projectPackage = installed.packages.find(pkg => pkg.scope === 'project')!;
    await service.configure({
      cwd: project,
      key: globalPackage.key,
      scope: 'global',
      resourceFilters: { prompts: [] },
    });

    const changes = [
      { key: globalPackage.key, scope: 'global' as const, enabled: false },
      { key: projectPackage.key, scope: 'project' as const, enabled: false },
    ];
    const persist = vi.spyOn(service as unknown as { persist(): Promise<void> }, 'persist');
    persist.mockRejectedValueOnce(new Error('simulated batch persistence failure'));
    await expect(service.setEnabledBatch({ cwd: project, projectId: installed.projectId, changes }))
      .rejects.toThrow('simulated batch persistence failure');
    const rolledBack = await service.getCatalog({ cwd: project, projectId: installed.projectId, refresh: true });
    expect(rolledBack.packages.filter(pkg => [globalPackage.key, projectPackage.key].includes(pkg.key)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: globalPackage.key, enabled: true }),
        expect.objectContaining({ key: projectPackage.key, enabled: true }),
      ]));

    persist.mockClear();
    const disabled = await service.setEnabledBatch({
      cwd: project,
      projectId: installed.projectId,
      changes,
    });
    expect(disabled.outcomes).toEqual([
      expect.objectContaining({ key: globalPackage.key, state: 'changed' }),
      expect.objectContaining({ key: projectPackage.key, state: 'changed' }),
    ]);
    expect(disabled.reloadRequired).toBe(true);
    expect(disabled.catalog.packages.find(pkg => pkg.key === globalPackage.key)).toMatchObject({
      enabled: false,
      resourceFilters: { prompts: [] },
    });
    expect(persist).toHaveBeenCalledTimes(1);

    await service.setEnabled({
      cwd: project,
      projectId: installed.projectId,
      key: projectPackage.key,
      scope: 'project',
      enabled: true,
    });
    persist.mockClear();
    await trust.untrust(project);
    const cleanup = await service.setEnabledBatch({
      cwd: project,
      projectId: installed.projectId,
      changes: [{ key: projectPackage.key, scope: 'project', enabled: false }],
    });
    expect(cleanup.outcomes).toEqual([expect.objectContaining({ state: 'changed' })]);
    expect(cleanup.reloadRequired).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);

    persist.mockClear();
    const missingKey = `global:global:${'f'.repeat(20)}`;
    const partial = await service.setEnabledBatch({
      cwd: project,
      projectId: installed.projectId,
      changes: [
        { key: globalPackage.key, scope: 'global', enabled: true },
        { key: projectPackage.key, scope: 'project', enabled: true },
        { key: missingKey, scope: 'global', enabled: true },
      ],
    });
    expect(partial.outcomes).toEqual([
      expect.objectContaining({ key: globalPackage.key, state: 'changed' }),
      expect.objectContaining({ key: projectPackage.key, state: 'failed', code: 'PROJECT_TRUST_REQUIRED' }),
      expect.objectContaining({ key: missingKey, state: 'failed', code: 'PLUGIN_NOT_FOUND' }),
    ]);
    expect(partial.reloadRequired).toBe(true);
    expect(partial.catalog.packages.find(pkg => pkg.key === globalPackage.key)).toMatchObject({
      enabled: true,
      resourceFilters: { prompts: [] },
    });
    expect(partial.catalog.packages.find(pkg => pkg.key === projectPackage.key)?.enabled).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    await expect(service.setEnabledBatch({ cwd: project, changes: [] }))
      .rejects.toMatchObject({ code: 'INVALID_PLUGIN_BATCH' });
  });

  it('rejects linked local roots, manifests, and persisted state', async () => {
    const root = await temporaryDirectory();
    const realSource = path.join(root, 'real-source');
    const linkedSource = path.join(root, 'linked-source');
    await fixturePackage(realSource);
    await symlink(realSource, linkedSource);
    const { project, data, service } = await setup(root);

    await expect(service.install({ cwd: project, scope: 'global', source: linkedSource }))
      .rejects.toMatchObject({ code: 'PLUGIN_SYMLINK_REJECTED' });

    const linkedManifestSource = path.join(root, 'linked-manifest-source');
    const outsideManifest = path.join(root, 'outside-package.json');
    await fixturePackage(linkedManifestSource);
    await writeFile(outsideManifest, JSON.stringify({ name: 'outside' }));
    await rm(path.join(linkedManifestSource, 'package.json'));
    await symlink(outsideManifest, path.join(linkedManifestSource, 'package.json'));
    await expect(service.install({ cwd: project, scope: 'global', source: linkedManifestSource }))
      .rejects.toThrow(/bounded regular file/i);

    const outsideState = path.join(root, 'outside-state.json');
    await writeFile(outsideState, '{"version":1,"generation":0,"packages":[]}');
    const stateFile = path.join(data, 'plugins.json');
    await symlink(outsideState, stateFile);
    await expect(service.getCatalog({ cwd: project })).rejects.toThrow(/regular file|symbolic link/i);
    await rm(stateFile);
    await writeFile(stateFile, '{not-json');
    await expect(service.getCatalog({ cwd: project })).rejects.toBeInstanceOf(SyntaxError);
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

  it('serializes state across service instances and observes external mutations without losing packages', async () => {
    const root = await temporaryDirectory();
    const firstSource = path.join(root, 'first-plugin');
    const secondSource = path.join(root, 'second-plugin');
    await fixturePackage(firstSource);
    await fixturePackage(secondSource);
    await writeFile(path.join(secondSource, 'package.json'), JSON.stringify({
      name: '@demo/second',
      version: '1.0.0',
      pi: { extensions: ['src/**/*.js'], prompts: [] },
      aiHarness: { extensions: [], prompts: ['prompts/*.md'] },
    }));
    const first = await setup(root);
    const second = await setup(root);

    await Promise.all([
      first.service.install({ cwd: first.project, scope: 'global', source: '../first-plugin' }),
      second.service.install({ cwd: second.project, scope: 'global', source: '../second-plugin' }),
    ]);

    const refreshed = await first.service.getCatalog({ cwd: first.project });
    expect(refreshed.packages.map(pkg => pkg.packageName).sort()).toEqual(['@demo/plugin', '@demo/second']);
    expect(refreshed.packages.find(pkg => pkg.packageName === '@demo/second')?.counts).toMatchObject({
      extensions: 0,
      prompts: 1,
    });
    const state = JSON.parse(await readFile(path.join(root, 'data', 'plugins.json'), 'utf8')) as { packages: unknown[] };
    expect(state.packages).toHaveLength(2);
    await expect(readFile(path.join(root, 'data', 'plugins.json.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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
    expect((await service.getEnabledSkillRoots({ cwd: project }))[0]?.displayRoot).toMatch(/^plugins\//);
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

  it('executes a real disposable configured npm wrapper for install/check/update/all, preserving literal argv, trust and rollback', async () => {
    const root = await temporaryDirectory();
    const executable = path.join(root, 'npm wrapper');
    const log = path.join(root, 'process-log.jsonl');
    const control = path.join(root, 'control.json');
    const marker = path.join(root, 'shell-must-not-run');
    const literal = `$(touch ${marker}); echo private|cat > ${marker}`;
    await writeFile(control, JSON.stringify({ version: '1.0.0' }));
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [log, control, literal, ...args] = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ args, literal, cwd: process.cwd(), env: process.env }) + '\\n');
const state = JSON.parse(fs.readFileSync(control, 'utf8'));
if (state.fail) { console.error('private-child-stderr'); console.log('private-child-stdout'); process.exit(9); }
if (args[0] === 'view') { console.log(JSON.stringify(state.version)); process.exit(0); }
if (args[0] !== 'install' || !args.includes('--ignore-scripts')) process.exit(10);
const prefix = args.indexOf('--prefix');
const dest = prefix < 0 ? process.cwd() : path.join(args[prefix + 1], 'node_modules', ...args.at(-1).split('/'));
fs.mkdirSync(path.join(dest, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: prefix < 0 ? '@demo/git' : args.at(-1), version: state.version }));
fs.writeFileSync(path.join(dest, 'prompts', 'review.md'), 'inert prompt');
`);
    await chmod(executable, 0o700);
    vi.stubEnv('OPENAI_API_KEY', 'disposable-parent-secret');
    vi.stubEnv('NODE_OPTIONS', '--require=/must-not-execute');
    vi.stubEnv('NPM_CONFIG_IGNORE_SCRIPTS', 'false');
    const command = ['./npm wrapper', log, control, literal];
    const { project, data, service } = await setup(root, undefined, { npmCommand: command, npmCommandBaseDirectory: root });
    // The service snapshots caller-owned argv, and list/reload cannot execute it.
    command[0] = './not-the-wrapper';
    await service.getCatalog({ cwd: project });
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.install({ cwd: project, scope: 'project', source: 'npm:@demo/blocked' }))
      .rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
    const installed = await service.install({ cwd: project, scope: 'global', source: 'npm:@demo/plugin' });
    const pkg = installed.packages[0]!;
    await service.reload({ cwd: project });
    await writeFile(control, JSON.stringify({ version: '2.0.0' }));
    expect(await service.checkUpdates({ cwd: project, key: pkg.key })).toEqual([
      expect.objectContaining({ state: 'update-available', availableVersion: '2.0.0' }),
    ]);
    await service.update({ cwd: project, key: pkg.key, scope: 'global' });
    await writeFile(control, JSON.stringify({ version: '3.0.0' }));
    expect((await service.updateAll({ cwd: project })).packages[0]?.version).toBe('3.0.0');
    const before = await readFile(path.join(data, 'plugins.json'), 'utf8');
    const persist = vi.spyOn(service as unknown as { persist(): Promise<void> }, 'persist');
    persist.mockRejectedValueOnce(new Error('simulated persistence failure'));
    await writeFile(control, JSON.stringify({ version: '4.0.0' }));
    await expect(service.update({ cwd: project, key: pkg.key, scope: 'global' })).rejects.toThrow('simulated persistence failure');
    expect(await readFile(path.join(data, 'plugins.json'), 'utf8')).toBe(before);
    expect((await service.getCatalog({ cwd: project, refresh: true })).packages[0]?.version).toBe('3.0.0');
    await writeFile(control, JSON.stringify({ fail: true }));
    await expect(service.update({ cwd: project, key: pkg.key, scope: 'global' }))
      .rejects.toMatchObject({ message: 'npm a échoué (9).' });
    await expect(service.install({ cwd: project, scope: 'global', source: 'npm:@demo/failed' }))
      .rejects.toMatchObject({ message: 'npm a échoué (9).' });
    expect(await service.checkUpdates({ cwd: project, key: pkg.key })).toEqual([
      expect.objectContaining({ state: 'error', message: 'Vérification impossible.' }),
    ]);
    expect(await readFile(path.join(data, 'plugins.json'), 'utf8')).toBe(before);
    expect(await readdir(path.join(data, 'plugins'))).toEqual(['installed']);
    await expect(readFile(path.join(data, 'plugins.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const entries = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
      args: string[]; literal: string; env: Record<string, string>;
    });
    expect(entries.map(entry => entry.args[0])).toEqual(['install', 'view', 'install', 'install', 'install', 'install', 'install', 'view']);
    for (const entry of entries) {
      expect(entry.literal).toBe(literal);
      expect(entry.env.OPENAI_API_KEY).toBeUndefined();
      expect(entry.env.NODE_OPTIONS).toBeUndefined();
      expect(entry.env.NPM_CONFIG_IGNORE_SCRIPTS).toBeUndefined();
      expect(entry.env.npm_config_ignore_scripts).toBe('true');
      if (entry.args[0] === 'install') {
        expect(entry.args).toEqual([
          'install', '--prefix', expect.stringContaining('.staging-'), '--ignore-scripts', '--no-audit', '--no-fund',
          '--package-lock=false', '--omit=dev', expect.stringMatching(/^@demo\//),
        ]);
      }
    }
    expect(JSON.stringify(await service.getCatalog({ cwd: project }))).not.toContain('private-child');
  });

  it('routes Git dependency installation and reinstallation through the configured npm executable', async () => {
    const root = await temporaryDirectory();
    const executable = path.join(root, 'dependency npm');
    const log = path.join(root, 'dependencies.jsonl');
    await writeFile(executable, `#!/usr/bin/env node
require('node:fs').appendFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd() }) + '\\n');
`);
    await chmod(executable, 0o700);
    const actual = createPluginCommandRunner();
    const runner: PluginCommandRunner = {
      async run(command, args, options) {
        if (command !== 'git') return actual.run(command, args, options);
        if (args[0] === 'clone') await fixturePackage(args.at(-1)!);
        return { stdout: args.includes('rev-parse') ? 'a'.repeat(40) : '', stderr: '' };
      },
    };
    const { project, service } = await setup(root, runner, { npmCommand: [executable, log] });
    const installed = await service.install({ cwd: project, scope: 'global', source: 'git:https://github.com/example/plugin.git' });
    await service.update({ cwd: project, key: installed.packages[0]!.key, scope: 'global' });
    const entries = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry).toEqual({
      args: ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--omit=dev'],
      cwd: expect.stringMatching(/\.staging-.*[/\\]repository$/),
    });
  });

  it('public Core admitted project command refuses global install/check/update with saved revocation, including after a lock wait', async () => {
    const root = await temporaryDirectory();
    const { project, data, trust, workspaces } = await setup(root);
    const local = path.join(project, '.ai-harness'); await mkdir(local);
    const log = path.join(root, 'executed'); const executable = path.join(local, 'npm.cjs');
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const args = process.argv.slice(2);
if (args.includes('view')) console.log('"2.0.0"');
else { const dest = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', args.at(-1));
fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: args.at(-1), version: '1.0.0' })); }
`);
    await chmod(executable, 0o700);
    const settingsPath = path.join(local, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ npmCommand: ['./npm.cjs', 'project prefix'] }));
    await trust.trust(project);
    const resolved = await loadAgentSettings({ cwd: project, agentDir: data, projectTrusted: true });
    const options = { ...publicNpmOptions(resolved) };
    const admitted = new PublicPluginService(workspaces, trust, path.join(data, 'plugins.json'), data, undefined, options);
    await admitted.load();
    // Mutating caller data cannot remove the captured source binding.
    options.npmCommandSourceWorkspace = undefined;
    resolved.projectSettings.npmCommand![0] = '/not-the-captured-command';
    const installed = await admitted.install({ cwd: project, scope: 'global', source: 'npm:core-seed' });
    const key = installed.packages[0]!.key;
    const files = [path.join(data, 'plugins.json'), settingsPath, executable, log];
    const bytes = await Promise.all(files.map(file => readFile(file)));
    const alias = path.join(root, 'source-alias'); await symlink(project, alias, 'dir');
    const aliased = new PublicPluginService(workspaces, trust, path.join(data, 'plugins.json'), data, undefined,
      { ...options, npmCommandSourceWorkspace: alias });
    await aliased.load();
    // Even a saved allow for the target cannot authorize a noncanonical source binding.
    await expect(aliased.install({ cwd: project, scope: 'global', source: 'npm:aliased-source' }))
      .rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    const writer = new ProjectTrustManager(path.join(data, 'trust.json')); await writer.load();
    const lock = path.join(data, 'plugins.json.lock'); await writeFile(lock, '', { mode: 0o600 });
    const pending = admitted.install({ cwd: project, projectTrusted: true, scope: 'global', source: 'npm:core-refused' });
    const refusal = expect(pending).rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    await new Promise(resolve => setTimeout(resolve, 50)); // Actual Core lock is held by the test.
    await writer.setDecision(project, false); await rm(lock);
    await refusal;
    await expect(admitted.update({ cwd: project, projectTrusted: true, key, scope: 'global' }))
      .rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    await expect(admitted.updateAll({ cwd: project, projectTrusted: true, scope: 'global' }))
      .rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    expect(await admitted.checkUpdates({ cwd: project, projectTrusted: true, key, scope: 'global' }))
      .toMatchObject([{ state: 'error', message: 'Vérification impossible.' }]);
    // Different operation cwd/trust never substitutes for trust of the captured source.
    await expect(admitted.install({ cwd: data, projectTrusted: true, scope: 'global', source: 'npm:other-target' }))
      .rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    expect(await Promise.all(files.map(file => readFile(file)))).toEqual(bytes);
    expect(await readdir(path.join(data, 'plugins'))).toEqual(['installed']);
    expect((await readdir(data)).filter(name => /lock|tmp/.test(name))).toEqual([]);
  });

  it('rechecks captured project source trust after a genuine delayed Git clone before npm dependency execution', async () => {
    const root = await temporaryDirectory();
    const { project, data, trust, workspaces } = await setup(root);
    const local = path.join(project, '.ai-harness'); const bin = path.join(root, 'bin');
    await mkdir(local); await mkdir(bin);
    const marker = path.join(root, 'clone-started'); const release = path.join(root, 'clone-release');
    const npmLog = path.join(root, 'npm-executed'); const gitLog = path.join(root, 'git-executed');
    const npm = path.join(local, 'npm.cjs'); const git = path.join(bin, 'git');
    await writeFile(npm, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(npmLog)}, 'executed');`);
    await writeFile(git, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
// Workspace descriptions also probe Git. Only the admitted clone is delayed.
if (process.argv[2] !== 'clone') {
  if (process.argv.includes('rev-parse') && process.argv.at(-1) === 'HEAD') console.log('a'.repeat(40));
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.writeFileSync(${JSON.stringify(marker)}, 'started');
const wait = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return;
clearInterval(wait); const dest = process.argv.at(-1); fs.mkdirSync(dest, { recursive: true });
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: 'git-fixture', version: '1.0.0' })); }, 10);
`);
    await chmod(npm, 0o700); await chmod(git, 0o700);
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    const settingsPath = path.join(local, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ npmCommand: ['./npm.cjs', 'project prefix'] }));
    await trust.trust(project);
    const options = publicNpmOptions(await loadAgentSettings({ cwd: project, agentDir: data, projectTrusted: true }));
    const admitted = new PublicPluginService(workspaces, trust, path.join(data, 'plugins.json'), data, undefined, options);
    await admitted.load();
    const before = await Promise.all([settingsPath, npm, git].map(file => readFile(file)));
    const pending = admitted.install({ cwd: project, scope: 'global', source: 'git:https://github.com/example/plugin.git' });
    const refusal = expect(pending).rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    const deadline = Date.now() + 3000;
    while (!await readFile(marker).then(() => true, () => false)) {
      if (Date.now() > deadline) throw new Error('Disposable Git process did not start.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const writer = new ProjectTrustManager(path.join(data, 'trust.json')); await writer.load();
    await writer.setDecision(project, false); await writeFile(release, 'release');
    await refusal;
    await expect(readFile(npmLog)).rejects.toMatchObject({ code: 'ENOENT' });
    const calls = (await readFile(gitLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1); expect(calls[0][0]).toBe('clone');
    // Revoked policy also refuses Git at preflight, even when npm might not be needed.
    await expect(admitted.install({ cwd: project, scope: 'global', source: 'git:https://github.com/example/second.git' }))
      .rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    expect((await readFile(gitLog, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(await Promise.all([settingsPath, npm, git].map(file => readFile(file)))).toEqual(before);
    await expect(readFile(path.join(data, 'plugins.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.join(data, 'plugins'))).toEqual([]);
    expect((await readdir(data)).filter(name => /lock|tmp/.test(name))).toEqual([]);
  });

  it('invalid configured npm argv cleans staging and never reaches the runner', async () => {
    const root = await temporaryDirectory();
    const run = vi.fn();
    const { project, data, service } = await setup(root, { run }, { npmCommand: ['npm', 'private\nargument'] });
    await expect(service.install({ cwd: project, scope: 'global', source: 'npm:@demo/plugin' }))
      .rejects.toMatchObject({ code: 'INVALID_PLUGIN_NPM_COMMAND' });
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(path.join(data, 'plugins'))).toEqual([]);
    expect((await service.getCatalog({ cwd: project })).packages).toEqual([]);
  });

  it('does not start Git or publish a package when settings diagnostics block npm policy', async () => {
    const root = await temporaryDirectory();
    const agentDir = path.join(root, 'agent');
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ npmCommand: null }));
    const resolved = await loadAgentSettings({ cwd: path.join(root, 'project'), agentDir });
    const run = vi.fn();
    const { project, data, service } = await setup(root, { run }, resolvePluginNpmCommand(resolved));
    expect((await service.getCatalog({ cwd: project })).packages).toEqual([]);
    await service.reload({ cwd: project });
    const state = await readFile(path.join(data, 'plugins.json'), 'utf8');
    for (const source of ['npm:@demo/plugin', 'git:https://github.com/example/plugin']) {
      await expect(service.install({ cwd: project, scope: 'global', source }))
        .rejects.toMatchObject({ code: 'INVALID_PLUGIN_NPM_COMMAND' });
    }
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(path.join(data, 'plugins.json'), 'utf8')).toBe(state);
    expect(await readdir(path.join(data, 'plugins'))).toEqual([]);
    expect((await service.getCatalog({ cwd: project })).packages).toEqual([]);
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
