import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentSettings, PluginService, ProjectTrustManager, resolvePluginNpmCommand, WorkspaceManager } from '@ai-harness/core';
import type { PluginNpmCommandOptions, PluginNpmSourceTrustOverride } from './package-command.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-npm-override-')); roots.push(root);
  const source = path.join(root, 'source'); const target = path.join(root, 'target'); const data = path.join(root, 'data');
  const local = path.join(source, '.ai-harness');
  for (const dir of [local, target, data]) await mkdir(dir, { recursive: true });
  const log = path.join(root, 'npm.jsonl'); const script = path.join(local, 'npm.cjs');
  await writeFile(script, `const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'view') console.log('"2.0.0"');
else if (args.includes('--prefix')) { const dest = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', args.at(-1));
fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: args.at(-1), version: '1.0.0' })); }
`);
  // Project controls only a prefix, not the absolute host executable. It still owns source authority.
  const settingsPath = path.join(local, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ npmCommand: [process.execPath, script] }));
  const workspaces = new WorkspaceManager({ allowedRoots: [root], defaultCwd: target }); await workspaces.initialize();
  const trust = new ProjectTrustManager(path.join(data, 'trust.json')); await trust.load();
  const writer = new ProjectTrustManager(path.join(data, 'trust.json')); await writer.load();
  const resolved = await loadAgentSettings({ cwd: source, agentDir: data, projectTrusted: true });
  const admit = (options: PluginNpmCommandOptions) => new PluginService(workspaces, trust, path.join(data, 'plugins.json'), data, undefined, options);
  return { root, source, target, data, log, script, settingsPath, trust, writer, resolved, admit };
}
const input = (cwd: string) => ({ cwd, projectTrusted: true, scope: 'global' as const, source: 'npm:override-fixture' });
const refusal = { code: 'PROJECT_TRUST_REQUIRED', status: 409, message: 'Le workspace source de npmCommand doit être approuvé.' };

async function noExecution(f: Awaited<ReturnType<typeof fixture>>) {
  await expect(readFile(f.log)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(f.data, 'plugins.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(path.join(f.data, 'plugins'))).toEqual([]);
  expect((await readdir(f.data)).filter(name => /lock|tmp/.test(name))).toEqual([]);
}

describe('host-only exact npm source process approval', () => {
  it('snapshots own fields; true outranks independent refusal during a real lock wait without changing saved trust', async () => {
    const f = await fixture();
    await f.writer.setDecision(f.root, false); // inherited saved refusal
    const override = { cwd: f.source, trusted: true };
    const selected = resolvePluginNpmCommand(f.resolved, override);
    expect(Object.isFrozen(selected.npmCommandSourceTrustOverride)).toBe(true);
    const options = { ...selected, npmCommand: [...selected.npmCommand!], npmCommandSourceTrustOverride: { ...override } };
    const service = f.admit(options); await service.load();
    options.npmCommand[0] = '/private-unavailable'; options.npmCommandSourceWorkspace = f.target;
    options.npmCommandSourceTrustOverride.cwd = f.target; options.npmCommandSourceTrustOverride.trusted = false;
    override.trusted = false; f.resolved.cwd = f.target; f.resolved.projectSettings.npmCommand![0] = '/private-edited';
    const lock = path.join(f.data, 'plugins.json.lock'); await writeFile(lock, '', { mode: 0o600 });
    const pending = service.install(input(f.target));
    await new Promise(resolve => setTimeout(resolve, 50));
    await f.writer.setDecision(f.source, false); // exact independent refusal after admission
    const saved = await readFile(path.join(f.data, 'trust.json'));
    await rm(lock);
    const installed = await pending; const key = installed.packages[0]!.key;
    expect(installed.packages[0]?.version).toBe('1.0.0');
    expect(await service.checkUpdates({ cwd: f.target, scope: 'global', key })).toMatchObject([{ state: 'update-available' }]);
    await service.update({ cwd: f.target, scope: 'global', key }); await service.updateAll({ cwd: f.target, scope: 'global' });
    expect(await readFile(path.join(f.data, 'trust.json'))).toEqual(saved);
    expect((await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)[0])).toEqual(['install', 'view', 'install', 'install']);
    expect(await readdir(path.join(f.data, 'plugins'))).toEqual(['installed']);
    expect((await readdir(f.data)).filter(name => /lock|tmp/.test(name))).toEqual([]);
  });

  it('false remains false after caller mutation despite a saved allow', async () => {
    const f = await fixture(); await f.trust.trust(f.source);
    const options = { ...resolvePluginNpmCommand(f.resolved), npmCommandSourceTrustOverride: { cwd: f.source, trusted: false } };
    const service = f.admit(options); options.npmCommandSourceTrustOverride.trusted = true;
    await expect(service.install(input(f.target))).rejects.toMatchObject(refusal); await noExecution(f);
  });

  it('cannot add an override after admission; restored saved allow authorizes only the original snapshot', async () => {
    const f = await fixture(); await f.trust.trust(f.source);
    const options: PluginNpmCommandOptions & { npmCommandSourceTrustOverride?: PluginNpmSourceTrustOverride } = { ...resolvePluginNpmCommand(f.resolved) };
    const service = f.admit(options);
    Object.assign(options, { npmCommandSourceTrustOverride: { cwd: f.source, trusted: true } });
    await f.writer.setDecision(f.source, false);
    await expect(service.install(input(f.target))).rejects.toMatchObject(refusal); await noExecution(f);
    await writeFile(f.settingsPath, JSON.stringify({ npmCommand: null }));
    await f.writer.setDecision(f.source, true);
    expect((await service.install(input(f.target))).packages[0]?.version).toBe('1.0.0');
    const fresh = f.admit(resolvePluginNpmCommand(await loadAgentSettings({ cwd: f.source, agentDir: f.data, projectTrusted: true })));
    await expect(fresh.install({ ...input(f.target), source: 'npm:fresh-refused' })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_NPM_COMMAND' });
    expect((await readFile(f.log, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it.each(['alias', 'relative', 'outside', 'missing', 'file', 'deleted', 'mismatch'])(
    'explicit true cannot bypass %s source validation', async kind => {
      const f = await fixture(); await f.trust.trust(f.source);
      let source = f.source;
      if (kind === 'alias') { source = path.join(f.root, 'alias'); await symlink(f.source, source); }
      if (kind === 'relative') source = 'source';
      if (kind === 'outside') source = os.tmpdir();
      if (kind === 'missing') source = path.join(f.root, 'missing');
      if (kind === 'file') source = f.script;
      const options = { ...resolvePluginNpmCommand(f.resolved), npmCommandSourceWorkspace: source,
        npmCommandSourceTrustOverride: { cwd: kind === 'mismatch' ? f.target : source, trusted: true } };
      const service = f.admit(options);
      if (kind === 'deleted') await rm(f.source, { recursive: true });
      await expect(service.install(input(f.target))).rejects.toMatchObject(refusal); await noExecution(f);
    },
  );

  it.each(['null', 'undefined', 'string', 'number', 'missing-cwd', 'missing-boolean', 'inherited-cwd', 'inherited-boolean', 'inherited-option', 'inherited-source', 'inherited-command', 'accessor', 'option-accessor', 'orphan'])(
    'rejects %s authority without invoking getters or any process', async kind => {
      const f = await fixture(); await f.trust.trust(f.source);
      const valid = { cwd: f.source, trusted: true }; const getter = vi.fn(() => true);
      const hostile: Record<string, unknown> = { ...resolvePluginNpmCommand(f.resolved), npmCommandSourceTrustOverride: valid };
      if (kind === 'null') hostile.npmCommandSourceTrustOverride = null;
      if (kind === 'undefined') hostile.npmCommandSourceTrustOverride = undefined;
      if (kind === 'string') hostile.npmCommandSourceTrustOverride = 'private-secret';
      if (kind === 'number') hostile.npmCommandSourceTrustOverride = { cwd: f.source, trusted: 1 };
      if (kind === 'missing-cwd') hostile.npmCommandSourceTrustOverride = { trusted: true };
      if (kind === 'missing-boolean') hostile.npmCommandSourceTrustOverride = { cwd: f.source };
      if (kind === 'inherited-cwd') hostile.npmCommandSourceTrustOverride = Object.assign(Object.create({ cwd: f.source }), { trusted: true });
      if (kind === 'inherited-boolean') hostile.npmCommandSourceTrustOverride = Object.assign(Object.create({ trusted: true }), { cwd: f.source });
      if (kind === 'accessor') hostile.npmCommandSourceTrustOverride = Object.defineProperty({ cwd: f.source }, 'trusted', { get: getter });
      if (kind === 'inherited-option') { delete hostile.npmCommandSourceTrustOverride; Object.setPrototypeOf(hostile, { npmCommandSourceTrustOverride: valid }); }
      if (kind === 'inherited-source') { delete hostile.npmCommandSourceWorkspace; Object.setPrototypeOf(hostile, { npmCommandSourceWorkspace: f.source }); }
      if (kind === 'inherited-command') { delete hostile.npmCommand; Object.setPrototypeOf(hostile, { npmCommand: [process.execPath, f.script] }); }
      if (kind === 'option-accessor') Object.defineProperty(hostile, 'npmCommandSourceTrustOverride', { get: getter });
      if (kind === 'orphan') delete hostile.npmCommandSourceWorkspace;
      const service = f.admit(hostile as PluginNpmCommandOptions);
      await service.getCatalog({ cwd: f.target }); // invalid policy stays passive
      await expect(service.install(input(f.target))).rejects.toMatchObject(refusal);
      expect(getter).not.toHaveBeenCalled(); await noExecution(f);
    },
  );

  it('fresh unavailable saved trust fails closed without an explicit override', async () => {
    const f = await fixture(); await f.trust.trust(f.source);
    const service = f.admit(resolvePluginNpmCommand(f.resolved));
    await writeFile(path.join(f.data, 'trust.json'), '{private-invalid-trust');
    await expect(service.install(input(f.target))).rejects.toMatchObject(refusal); await noExecution(f);
  });

  it('resolver copies own override fields, never promotes resolved trust, and rejects malformed/mismatched input', async () => {
    const f = await fixture();
    expect(resolvePluginNpmCommand(f.resolved).npmCommandSourceTrustOverride).toBeUndefined();
    for (const trusted of [true, false]) {
      const original = { cwd: f.source, trusted };
      const selected = PluginService.resolveNpmCommand(f.resolved, original);
      original.cwd = f.target; original.trusted = !trusted;
      expect(selected.npmCommandSourceWorkspace).toBe(f.source);
      expect(selected.npmCommandSourceTrustOverride).toEqual({ cwd: f.source, trusted });
    }
    for (const bad of [null, 'private-secret', {}, { cwd: f.target, trusted: true },
      { cwd: f.source, trusted: 'true' }, Object.create({ cwd: f.source, trusted: true })]) {
      expect(() => resolvePluginNpmCommand(f.resolved, bad as PluginNpmSourceTrustOverride)).toThrow(refusal.message);
    }
    f.resolved.projectSettings = Object.create({ npmCommand: [process.execPath, f.script] });
    expect(resolvePluginNpmCommand(f.resolved)).toEqual({ npmCommandBlocked: true });
  });

  it('true remains exact-source authority after genuine delayed Git clone and independent saved revoke', async () => {
    const f = await fixture(); const bin = path.join(f.root, 'bin'); await mkdir(bin);
    const started = path.join(f.root, 'started'); const release = path.join(f.root, 'release'); const gitLog = path.join(f.root, 'git.jsonl');
    const git = path.join(bin, 'git');
    await writeFile(git, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'); const args = process.argv.slice(2);
if (args[0] === 'clone') {
fs.appendFileSync(${JSON.stringify(gitLog)}, 'clone\\n'); fs.writeFileSync(${JSON.stringify(started)}, 'started');
const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return; clearInterval(timer);
const dest = args.at(-1); fs.mkdirSync(dest, { recursive: true });
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: 'git-override', version: '1.0.0' })); }, 10);
} else if (args.includes('rev-parse') && args.at(-1) === 'HEAD') console.log('a'.repeat(40));
`); await chmod(git, 0o700); vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    const service = f.admit(resolvePluginNpmCommand(f.resolved, { cwd: f.source, trusted: true }));
    const pending = service.install({ cwd: f.target, scope: 'global', source: 'git:https://github.com/example/plugin.git' });
    const deadline = Date.now() + 3000;
    while (!await readFile(started).then(() => true, () => false)) {
      if (Date.now() > deadline) throw new Error('Disposable clone did not start.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await f.writer.setDecision(f.source, false); const saved = await readFile(path.join(f.data, 'trust.json'));
    await writeFile(release, 'release');
    expect((await pending).packages[0]?.version).toBe('1.0.0');
    expect(await readFile(gitLog, 'utf8')).toBe('clone\n');
    expect(JSON.parse((await readFile(f.log, 'utf8')).trim())).toEqual(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--omit=dev']);
    expect(await readFile(path.join(f.data, 'trust.json'))).toEqual(saved);
    expect(await readdir(path.join(f.data, 'plugins'))).toEqual(['installed']);
    expect((await readdir(f.data)).filter(name => /lock|tmp/.test(name))).toEqual([]);
  });
});
