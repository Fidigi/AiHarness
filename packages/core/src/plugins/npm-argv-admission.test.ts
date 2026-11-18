import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentSettings, PluginService, ProjectTrustManager, resolvePluginNpmCommand, WorkspaceManager } from '@ai-harness/core';
import { capturePluginNpmCommandOptions, createPluginCommandRunner, pluginNpmInvocation } from './package-command.js';
import type { PluginNpmCommandOptions } from './package-command.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const invalid = {
  status: 400, code: 'INVALID_PLUGIN_NPM_COMMAND',
  message: 'Invalid npmCommand: expected bounded executable and literal argv.',
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-npm-argv-')); roots.push(root);
  const cwd = path.join(root, 'workspace'), data = path.join(root, 'data');
  await mkdir(path.join(cwd, '.ai-harness'), { recursive: true }); await mkdir(data);
  const log = path.join(root, 'process.jsonl'), marker = path.join(root, 'iterator-or-getter-marker');
  const script = path.join(cwd, '.ai-harness', 'npm.cjs');
  await writeFile(script, `const fs=require('node:fs'),path=require('node:path'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const dest=path.join(args[args.indexOf('--prefix')+1],'node_modules',args.at(-1));
fs.mkdirSync(dest,{recursive:true}); fs.writeFileSync(path.join(dest,'package.json'),JSON.stringify({name:args.at(-1),version:'1.0.0'}));`);
  const workspaces = new WorkspaceManager({ allowedRoots: [root], defaultCwd: cwd }); await workspaces.initialize();
  const trust = new ProjectTrustManager(path.join(data, 'trust.json')); await trust.load();
  await trust.setDecision(cwd, false); // Exact true host override, not saved trust, authorizes valid argv.
  const saved = await readFile(path.join(data, 'trust.json'));
  const resolved = await loadAgentSettings({ cwd, agentDir: data, projectTrusted: true });
  resolved.globalSettings.npmCommand = [process.execPath, script, 'global-fallback-must-not-run'];
  const runner = createPluginCommandRunner(); const run = vi.fn(runner.run.bind(runner));
  const admit = (command: readonly string[], via: 'constructor' | 'resolver') => {
    const options: PluginNpmCommandOptions = via === 'resolver'
      ? resolvePluginNpmCommand(Object.assign(resolved, { projectSettings: { npmCommand: command } }), { cwd, trusted: true })
      : { npmCommand: command, npmCommandBaseDirectory: path.dirname(script), npmCommandSourceWorkspace: cwd,
        npmCommandSourceTrustOverride: { cwd, trusted: true } };
    return { options, service: new PluginService(workspaces, trust, path.join(data, 'plugins.json'), data, { run }, options) };
  };
  return { root, cwd, data, script, log, marker, run, saved, admit };
}

async function noExecution(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.run).not.toHaveBeenCalled();
  for (const file of [f.log, f.marker, path.join(f.data, 'plugins.json')]) {
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(await readFile(path.join(f.data, 'trust.json'))).toEqual(f.saved);
  expect(await readdir(path.join(f.data, 'plugins'))).toEqual([]);
  expect((await readdir(f.data)).filter(name => /lock|tmp/.test(name))).toEqual([]);
}

const malformed = ['executable-accessor', 'prefix-accessor', 'sparse', 'inherited-data-slot', 'inherited-getter-slot',
  'huge-array', '65-slots', 'utf8-item-overflow', 'utf8-total-overflow', 'boxed-string', 'empty', 'leading-dash'] as const;

for (const via of ['constructor', 'resolver'] as const) {
  describe(`${via} bounded own numeric npm argv admission`, () => {
    it.each(malformed)('keeps %s passive and refuses lazily without getter/iterator/process/fallback/state/residue', async kind => {
      const f = await fixture(); const getter = vi.fn(() => 'private accessor value');
      const iterator = vi.fn(function* () { yield process.execPath; yield f.script; yield 'private replacement'; });
      let command: unknown[] = [process.execPath, f.script];
      if (kind === 'executable-accessor' || kind === 'prefix-accessor') {
        Object.defineProperty(command, kind === 'executable-accessor' ? '0' : '1', { get: getter });
      }
      if (kind === 'sparse') command = new Array(2);
      if (kind === 'inherited-data-slot' || kind === 'inherited-getter-slot') {
        delete command[1]; const prototype = Object.create(Array.prototype);
        Object.defineProperty(prototype, '1', kind === 'inherited-data-slot' ? { value: f.script } : { get: getter });
        Object.setPrototypeOf(command, prototype); // Local array only: no global prototype mutation.
      }
      if (kind === 'huge-array' || kind === '65-slots') {
        command.length = kind === 'huge-array' ? 0xffff_ffff : 65;
        Object.defineProperty(command, '0', { get: getter });
        // The old spread consumes a tiny iterator, not 4 billion slots: safe red reproduction.
        Object.defineProperty(command, Symbol.iterator, { value: iterator });
      }
      if (kind === 'utf8-item-overflow') command.push('é'.repeat(2049));
      if (kind === 'utf8-total-overflow') command.push(...Array.from({ length: 8 }, () => 'é'.repeat(2048)));
      if (kind === 'boxed-string') command[1] = new String(f.script);
      if (kind === 'empty') command = [];
      if (kind === 'leading-dash') command[0] = '-private-executable';
      const { service } = f.admit(command as string[], via);
      // Producer repair cannot turn a captured invalid policy into an admitted command.
      Object.defineProperty(command, '0', { value: process.execPath });
      await service.getCatalog({ cwd: f.cwd });
      expect(getter).not.toHaveBeenCalled(); expect(iterator).not.toHaveBeenCalled();
      await expect(service.install({ cwd: f.cwd, scope: 'global', source: 'npm:argv-refused' })).rejects.toMatchObject(invalid);
      expect(getter).not.toHaveBeenCalled(); expect(iterator).not.toHaveBeenCalled(); await noExecution(f);
    });

    it.each(['method', 'accessor', 'non-callable'] as const)(
      'ignores valid own argv custom %s iterator and cannot substitute its payload', async kind => {
        const f = await fixture(); const command = [process.execPath, f.script, 'a b', '$(touch marker)', '; touch marker', 'x|y', '"quoted"'];
        const iterator = vi.fn(function* () { yield '-private replacement'; });
        const getter = vi.fn(() => iterator);
        Object.defineProperty(command, Symbol.iterator, kind === 'accessor' ? { get: getter }
          : { value: kind === 'method' ? iterator : null });
        const { options, service } = f.admit(command, via);
        if (via === 'resolver') {
          expect(Object.isFrozen(options)).toBe(true); expect(Object.isFrozen(options.npmCommand)).toBe(true);
        }
        const snapshot = capturePluginNpmCommandOptions(options).options;
        expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.npmCommand)).toBe(true);
        expect(snapshot.npmCommand).toEqual([process.execPath, f.script, 'a b', '$(touch marker)', '; touch marker', 'x|y', '"quoted"']);
        command[0] = '-mutated'; command[1] = '/private-missing'; command.length = 1;
        await service.getCatalog({ cwd: f.cwd }); expect(f.run).not.toHaveBeenCalled();
        expect(getter).not.toHaveBeenCalled(); expect(iterator).not.toHaveBeenCalled();
        const catalog = await service.install({ cwd: f.cwd, scope: 'global', source: 'npm:argv-valid' });
        expect(catalog.packages[0]?.version).toBe('1.0.0'); expect(f.run).toHaveBeenCalledTimes(1);
        const executed: string[] = JSON.parse((await readFile(f.log, 'utf8')).trim());
        expect(executed.slice(0, 5)).toEqual(['a b', '$(touch marker)', '; touch marker', 'x|y', '"quoted"']);
        expect(getter).not.toHaveBeenCalled(); expect(iterator).not.toHaveBeenCalled();
        await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(path.join(f.data, 'trust.json'))).toEqual(f.saved);
        expect(await readdir(path.join(f.data, 'plugins'))).toEqual(['installed']);
        expect((await readdir(f.data)).filter(name => /lock|tmp/.test(name))).toEqual([]);
      },
    );

    it('bounds a huge sparse array before inspecting any numeric slot, even without a custom iterator', async () => {
      const f = await fixture(); const getter = vi.fn(() => { throw new Error('private getter must not execute'); });
      const command = new Array<string>(0xffff_ffff); Object.defineProperty(command, '0', { get: getter });
      const { service } = f.admit(command, via);
      await service.getCatalog({ cwd: f.cwd });
      await expect(service.install({ cwd: f.cwd, scope: 'global', source: 'npm:huge-refused' })).rejects.toMatchObject(invalid);
      expect(getter).not.toHaveBeenCalled(); await noExecution(f);
    });

    it('captures a throwing numeric accessor as a lazy refusal, not an admission-time exception', async () => {
      const f = await fixture(); const getter = vi.fn(() => { throw new Error('private getter must not execute'); });
      const iterator = vi.fn(() => { throw new Error('private iterator must not execute'); });
      const command = [process.execPath, f.script]; Object.defineProperty(command, '1', { get: getter });
      Object.defineProperty(command, Symbol.iterator, { value: iterator });
      const { service } = f.admit(command, via);
      await service.getCatalog({ cwd: f.cwd });
      await expect(service.install({ cwd: f.cwd, scope: 'global', source: 'npm:accessor-refused' })).rejects.toMatchObject(invalid);
      expect(getter).not.toHaveBeenCalled(); expect(iterator).not.toHaveBeenCalled(); await noExecution(f);
    });

    it('accepts frozen own non-enumerable slots and snapshots without producer mutation authority', async () => {
      const f = await fixture(); const command = [process.execPath, f.script];
      Object.defineProperty(command, '1', { enumerable: false }); Object.freeze(command);
      const { service } = f.admit(command, via);
      await service.getCatalog({ cwd: f.cwd }); expect(f.run).not.toHaveBeenCalled();
      expect((await service.install({ cwd: f.cwd, scope: 'global', source: 'npm:frozen-valid' })).packages[0]?.version).toBe('1.0.0');
      expect(f.run).toHaveBeenCalledTimes(1); expect(await readFile(path.join(f.data, 'trust.json'))).toEqual(f.saved);
      expect(await readdir(path.join(f.data, 'plugins'))).toEqual(['installed']);
      expect((await readdir(f.data)).filter(name => /lock|tmp/.test(name))).toEqual([]);
      await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
}

describe('shared argv boundary and frozen snapshots', () => {
  it('accepts exact 64-slot, 4096-byte item and 32KiB total boundaries before relative executable handling', () => {
    for (const command of [
      ['npm', ...Array.from({ length: 63 }, () => 'x')],
      ['npm', 'é'.repeat(2048)],
      ['npm', ...Array.from({ length: 7 }, () => 'é'.repeat(2048)), 'x'.repeat(4093)],
    ]) {
      const options = capturePluginNpmCommandOptions({ npmCommand: command }).options;
      expect(Object.isFrozen(options.npmCommand)).toBe(true);
      expect(pluginNpmInvocation(options, ['view'])).toEqual({ executable: 'npm', args: [...command.slice(1), 'view'] });
    }
    const options = capturePluginNpmCommandOptions({ npmCommand: ['./npm wrapper', 'literal $value'], npmCommandBaseDirectory: '/settings' }).options;
    expect(pluginNpmInvocation(options, ['view'])).toEqual({ executable: '/settings/npm wrapper', args: ['literal $value', 'view'] });
  });

  it('direct invocation also rejects own accessors without invoking getters or iterators', () => {
    const getter = vi.fn(() => 'npm'); const iterator = vi.fn(function* () { yield 'npm'; });
    const command = ['npm']; Object.defineProperty(command, '0', { get: getter });
    Object.defineProperty(command, Symbol.iterator, { value: iterator });
    expect(() => pluginNpmInvocation({ npmCommand: command }, [])).toThrow(invalid.message);
    expect(getter).not.toHaveBeenCalled(); expect(iterator).not.toHaveBeenCalled();
  });
});
