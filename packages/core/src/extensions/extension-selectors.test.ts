import { link, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionRegistry } from './extension-registry.js';
import { ExtensionModuleLoader } from './module-loader.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(prefix = 'aih-extension-selectors-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(root);
  const cwd = path.join(root, 'project'); const global = path.join(root, 'global');
  await Promise.all([mkdir(cwd), mkdir(global)]);
  const registry = new ExtensionRegistry();
  const file = async (relative: string, source = 'export default () => {};') => {
    const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source); return target;
  };
  return { root, cwd, global, registry, file };
}

describe('bounded executable extension selectors', () => {
  it('applies ordered globs and exact reinclusion to discovered files without executing excluded modules', async () => {
    const test = await fixture();
    const keep = await test.file('global/nested/keep.mjs');
    const restored = await test.file('global/nested/restore.mjs');
    await test.file('global/nested/excluded.mjs', 'throw new Error("Excluded code must never be imported");');
    await test.file('global/notes.ts', 'throw new Error("Not a supported entry");');
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd,
      includeGlobalLocation: false, includeProjectLocation: false,
      selectors: [path.join(test.global, '**/*.mjs'), `!${test.global}/**/{excluded,restore}.mjs`, `+${restored}`] });
    expect(await loader.discover()).toEqual([keep, restored]);
    expect(await loader.loadAll()).toMatchObject({ committed: true, loaded: [keep, restored], errors: [] });
  });

  it.each(['cwd', 'scoped'])('treats a %s base with glob metacharacters as literal filesystem identity', async mode => {
    const test = await fixture('aih-extension-[literal]-');
    const keep = await test.file('global/nested/keep.mjs');
    const js = await test.file('global/nested/plain.js');
    const cjs = await test.file('global/nested/common.cjs', 'module.exports = () => {};');
    await test.file('global/nested/excluded.mjs', 'throw new Error("Excluded entry executed");');
    await test.file('global/nested/source.ts', 'throw new Error("Unsupported TypeScript entry executed");');
    const patterns = ['**/*', '!**/excluded.*'];
    const loader = new ExtensionModuleLoader(test.registry, {
      cwd: mode === 'cwd' ? test.global : test.cwd, includeGlobalLocation: false, includeProjectLocation: false,
      selectors: mode === 'cwd' ? patterns : patterns.map(pattern => ({ pattern, baseDir: test.global })),
    });
    expect(await loader.loadAll()).toMatchObject({ committed: true, loaded: [keep, js, cjs].sort(), errors: [] });
  });

  it.each([
    { pattern: '*.mjs', baseDir: 'relative' },
    { pattern: '', baseDir: '/tmp' },
    { pattern: '*.mjs', baseDir: '/tmp/' + String.fromCharCode(0) },
    { pattern: '*.mjs', baseDir: `/${'x'.repeat(32_768)}` },
  ])('refuses invalid scoped selector identity (%#)', async selector => {
    const test = await fixture();
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false, selectors: [selector] });
    expect(await loader.loadAll()).toMatchObject({ committed: false, loaded: [], errors: [{ path: '<discovery>' }] });
  });

  it('filters automatic/explicit directory discovery and permits a later exact add', async () => {
    const test = await fixture();
    const automatic = await test.file('project/.ai-harness/extensions/automatic.mjs');
    const first = await test.file('global/first.mjs');
    const nested = await test.file('global/package/index.mjs');
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false,
      paths: [test.global], selectors: [`-${test.global}`, `-${automatic}`, `+${nested}`] });
    expect(await loader.discover()).toEqual([nested]);
    expect(await new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false,
      paths: [test.global], selectors: [`!${test.global}/**/*.mjs`, `+${first}`] }).discover()).toEqual([first, automatic].sort());
  });

  it('keeps +path and existing paths literal, including glob metacharacters', async () => {
    const test = await fixture();
    const literal = await test.file('global/entry[1].mjs');
    await test.file('global/entry1.mjs');
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false,
      paths: [literal], selectors: [`-${literal}`, `+${literal}`, `+${test.global}/*.mjs`] });
    expect(await loader.discover()).toEqual([literal]);
  });

  it('rechecks project trust before glob traversal, including ancestor patterns and exact reinclusion', async () => {
    const test = await fixture();
    const global = await test.file('global/safe.mjs');
    const project = await test.file('project/nested/project.mjs');
    let trusted = false;
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false,
      isProjectTrusted: () => trusted, selectors: [`${test.global}/**/*.mjs`, `${test.cwd}/**/*.mjs`, `+${project}`, `${test.root}/**/*.mjs`] });
    expect(await loader.discover()).toEqual([global]);
    trusted = true; expect(await loader.discover()).toEqual([global, project]);
    trusted = false; expect(await loader.discover()).toEqual([global]);
  });

  it('handles filesystem-root containment for both trust and exact removals', async () => {
    const test = await fixture();
    const safe = await test.file('global/safe.mjs');
    const root = path.parse(test.root).root;
    const options = { cwd: test.cwd, includeGlobalLocation: false, isProjectTrusted: () => false, paths: [safe] };
    expect(await new ExtensionModuleLoader(test.registry, { ...options, selectors: [path.join(root, '**/*.mjs')] }).discover()).toEqual([safe]);
    expect(await new ExtensionModuleLoader(test.registry, { ...options, selectors: [`-${root}`] }).discover()).toEqual([]);
  });

  it('refuses linked parents, linked/hard-linked files and oversized modules within a glob', async () => {
    const test = await fixture();
    const safe = await test.file('global/nested/safe.mjs');
    const source = await test.file('global/hard-source.mjs');
    await link(source, path.join(test.global, 'hard-copy.mjs'));
    await symlink(safe, path.join(test.global, 'linked.mjs'));
    await symlink(path.dirname(safe), path.join(test.global, 'linked-dir'));
    const large = await test.file('global/large.mjs'); await truncate(large, 5 * 1024 * 1024 + 1);
    expect(await new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false,
      selectors: [`${test.global}/**/*.mjs`, `${test.global}/linked-dir/*.mjs`] }).discover()).toEqual([safe]);
  });

  it('refreshes dynamic selectors and replaces only its owned generation', async () => {
    const test = await fixture();
    const selected = await test.file('global/selected.mjs', 'export default api => api.registerCommand("selected", { description: "selected", handler: () => "selected" });');
    await test.registry.load('independent', api => api.registerCommand('independent', { description: 'independent', handler: () => 'independent' }));
    let selectors = [`${test.global}/**/*.mjs`];
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false, selectors: () => selectors });
    expect(await loader.loadAll()).toMatchObject({ committed: true, loaded: [selected] });
    expect(test.registry.getCommands().map(command => command.name).sort()).toEqual(['independent', 'selected']);
    selectors = [...selectors, `-${test.global}`];
    expect(await loader.reload()).toMatchObject({ committed: true, loaded: [] });
    expect(test.registry.getCommands().map(command => command.name)).toEqual(['independent']);
  });

  it('refuses selector-count overflow without importing or retiring the previous generation', async () => {
    const test = await fixture();
    const selected = await test.file('global/selected.mjs', 'export default api => api.registerCommand("retained", { description: "retained", handler: () => "retained" });');
    let selectors = [selected];
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false, selectors: () => selectors });
    await loader.loadAll(); selectors = Array(201).fill(selected);
    const refused = await loader.reload();
    expect(refused).toMatchObject({ committed: false, generation: 1, loaded: [selected], errors: [{ path: '<discovery>' }] });
    expect(refused.errors[0]!.error.message).toBe('Extension selectors exceed their count limit.');
    expect(test.registry.getCommands().map(command => command.name)).toEqual(['retained']);
  });

  it.each(['glob', 'exact selector', 'ordinary path'])('fails closed on a truncated %s directory rather than importing an arbitrary prefix', async mode => {
    const test = await fixture();
    await Promise.all(Array.from({ length: 1_001 }, (_, index) => test.file(`global/${index}.mjs`)));
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false,
      ...(mode === 'ordinary path' ? { paths: [test.global] } : { selectors: [mode === 'glob' ? `${test.global}/*.mjs` : `+${test.global}`] }) });
    expect(await loader.loadAll()).toMatchObject({ committed: false, loaded: [], errors: [{ path: '<discovery>' }] });
  });

  it('refuses ordinary path overflow rather than silently dropping the tail', async () => {
    const test = await fixture();
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false,
      includeProjectLocation: false, paths: Array(201).fill(test.global) });
    expect(await loader.loadAll()).toMatchObject({ committed: false, loaded: [], errors: [{ path: '<discovery>' }] });
  });

  it.each(['', '+', '\0', 'é'.repeat(16_385)])('refuses malformed or oversized selectors before import (%#)', async selector => {
    const test = await fixture();
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false, selectors: [selector] });
    expect(await loader.loadAll()).toMatchObject({ committed: false, loaded: [], errors: [{ path: '<discovery>' }] });
  });

  it('bounds the combined positive candidate set across glob directories', async () => {
    const test = await fixture();
    await Promise.all(Array.from({ length: 1_001 }, (_, index) => test.file(`global/${index % 2}/${index}.mjs`)));
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false, selectors: [`${test.global}/**/*.mjs`] });
    const result = await loader.loadAll();
    expect(result).toMatchObject({ committed: false, loaded: [], errors: [{ path: '<discovery>' }] });
    expect(result.errors[0]!.error.message).toBe('Extension selection exceeds its file limit.');
  });

  it('bounds visited directories without executing a partial selection', async () => {
    const test = await fixture();
    await Promise.all(Array.from({ length: 256 }, (_, index) => mkdir(path.join(test.global, String(index)))));
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false, selectors: [`${test.global}/**/*.mjs`] });
    const result = await loader.loadAll();
    expect(result).toMatchObject({ committed: false, loaded: [], errors: [{ path: '<discovery>' }] });
    expect(result.errors[0]!.error.message).toBe('Extension glob exceeds its directory limit.');
  });

  it('bounds aggregate metadata visits across selectors, including repeated patterns', async () => {
    const test = await fixture();
    await Promise.all(Array.from({ length: 900 }, (_, index) => test.file(`global/${index}.txt`)));
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false,
      selectors: Array(12).fill(`${test.global}/*.mjs`) });
    const result = await loader.loadAll();
    expect(result).toMatchObject({ committed: false, loaded: [], errors: [{ path: '<discovery>' }] });
    expect(result.errors[0]!.error.message).toBe('Extension glob exceeds its entry limit.');
  });

  it('does not descend unrelated subtrees for a nonrecursive glob', async () => {
    const test = await fixture();
    const selected = await test.file('global/selected.mjs');
    await test.file(`global/${'nested/'.repeat(9)}entry.mjs`);
    expect(await new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false,
      selectors: [`${test.global}/*.mjs`] }).discover()).toEqual([selected]);
  });

  it('bounds recursive depth and refuses an incomplete candidate generation', async () => {
    const test = await fixture();
    await test.file(`global/${'nested/'.repeat(9)}entry.mjs`);
    const loader = new ExtensionModuleLoader(test.registry, { cwd: test.cwd, includeGlobalLocation: false,
      selectors: [`${test.global}/**/*.mjs`] });
    expect(await loader.loadAll()).toMatchObject({ committed: false, loaded: [], errors: [{ path: '<discovery>' }] });
  });
});
