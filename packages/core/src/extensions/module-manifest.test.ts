import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionModuleLoader } from './module-loader.js';
import { ExtensionRegistry } from './extension-registry.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-manifest-')); roots.push(root);
  const cwd = path.join(root, 'project'); const pkg = path.join(root, 'package [literal]');
  await mkdir(cwd); await mkdir(pkg);
  const registry = new ExtensionRegistry();
  const file = async (name: string, body: string) => { await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, body); return name; };
  const manifest = (value: unknown) => file(path.join(pkg, 'package.json'), JSON.stringify(value));
  const factory = (name: string) => `export default api => api.registerCommand(${JSON.stringify(name)}, {description:'Manifest',handler:()=>${JSON.stringify(name)}});`;
  const loader = (paths: string[], trusted = true, selectors: string[] = []) => new ExtensionModuleLoader(registry, {
    cwd, paths, selectors, includeGlobalLocation: false, includeProjectLocation: false, includeEnvironmentPaths: false, isProjectTrusted: () => trusted,
  });
  return { root, cwd, pkg, registry, file, manifest, factory, loader };
}
const diagnostic = 'Extension manifest is invalid or exceeds its limits.';

describe('bounded directory extension manifests', () => {
  it('loads only native exact declared entries from a directory and not sibling factories', async () => {
    const test = await fixture(); const entry = await test.file(path.join(test.pkg, 'nested/entry.ts'), test.factory('chosen'));
    await test.file(path.join(test.pkg, 'index.mjs'), 'throw new Error("Index must not run");');
    await test.file(path.join(test.pkg, 'sibling.ts'), 'throw new Error("Sibling must not run");');
    await test.manifest({ aiHarness: { extensions: ['nested/entry.ts', 'nested/entry.ts'] } });
    expect(await test.loader([test.pkg, entry]).loadAll()).toMatchObject({ committed: true, loaded: [entry], errors: [] });
    expect(test.registry.getCommand('chosen')).toBeDefined();
  });
  it('discovers a child manifest without recursively autoloading its undeclared siblings', async () => {
    const test = await fixture(); const entry = await test.file(path.join(test.pkg, 'src/entry.mjs'), test.factory('child'));
    await test.manifest({ aiHarness: { extensions: ['src/entry.mjs'] } });
    expect(await test.loader([test.root]).loadAll()).toMatchObject({ committed: true, loaded: [entry] });
  });
  it('only uses native resource fields, preserving ordinary discovery and explicit empty selection', async () => {
    const test = await fixture(); const first = await test.file(path.join(test.pkg, 'first.ts'), test.factory('first'));
    const second = await test.file(path.join(test.pkg, 'src/second.ts'), test.factory('second'));
    await test.manifest({ other: { extensions: ['first.ts'] }, aiHarness: { extensions: ['src/second.ts'] } });
    const loader = test.loader([test.pkg]); expect((await loader.loadAll()).loaded).toEqual([second]);
    await test.manifest({ other: { extensions: ['src/second.ts'] }, aiHarness: { skills: [] } });
    expect((await loader.reload()).loaded).toEqual([first]); expect(test.registry.getCommand('second')).toBeUndefined();
    await test.manifest({ other: { extensions: ['first.ts'] }, aiHarness: { extensions: [] } });
    expect((await loader.reload()).loaded).toEqual([]); expect(test.registry.getCommand('first')).toBeUndefined();
  });
  it('keeps index priority, portable exact paths, declaration exclusion and outer selector removals', async () => {
    const test = await fixture(); const js = await test.file(path.join(test.pkg, 'src/index.cjs'), 'module.exports = '+test.factory('index').replace('export default ',''));
    await test.file(path.join(test.pkg, 'src/index.ts'), 'throw new Error("Lower priority index ran");');
    const other = await test.file(path.join(test.pkg, 'nested/entry[1].mts'), test.factory('other'));
    await test.file(path.join(test.pkg, 'types.d.ts'), 'throw new Error("Declaration ran");');
    await test.manifest({ aiHarness: { extensions: ['src', 'nested\\entry[1].mts', 'types.d.ts'] } });
    expect((await test.loader([test.pkg], true, [`-${other}`]).loadAll()).loaded).toEqual([js]);
  });
  it('preserves ordinary directory discovery when no extension manifest field exists', async () => {
    const test = await fixture(); const entry = await test.file(path.join(test.pkg, 'entry.mjs'), test.factory('ordinary'));
    await test.manifest({ type: 'module', aiHarness: { themes: [] } });
    expect((await test.loader([test.pkg]).loadAll()).loaded).toEqual([entry]);
  });
  it('never reads a refused project manifest, including malformed source', async () => {
    const test = await fixture(); const marker = path.join(test.root, 'marker');
    await test.file(path.join(test.cwd, 'package.json'), '{ private-source');
    await test.file(path.join(test.cwd, 'entry.ts'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');export default()=>{};`);
    expect(await test.loader([test.cwd], false).loadAll()).toMatchObject({ committed: true, loaded: [], errors: [] });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['non-object', []], ['non-array', { aiHarness: { extensions: 'entry.ts' } }],
    ['non-string', { aiHarness: { extensions: [7] } }], ['empty', { aiHarness: { extensions: [''] } }],
    ['escape', { aiHarness: { extensions: ['../outside.ts'] } }], ['self', { aiHarness: { extensions: ['.'] } }],
    ['absolute', { aiHarness: { extensions: ['/outside.ts'] } }], ['drive', { aiHarness: { extensions: ['C:/outside.ts'] } }],
    ['control', { aiHarness: { extensions: ['bad\n.ts'] } }], ['over-count', { aiHarness: { extensions: Array(101).fill('entry.ts') } }],
    ['over-string', { aiHarness: { extensions: ['a'.repeat(32_769)] } }],
  ])('refuses %s metadata before any candidate import and preserves the prior generation', async (_name, manifest) => {
    const test = await fixture(); const entry = await test.file(path.join(test.pkg, 'entry.ts'), test.factory('retained'));
    await test.manifest({ aiHarness: { extensions: ['entry.ts'] } }); const loader = test.loader([test.pkg]);
    expect((await loader.loadAll()).committed).toBe(true); const previous = test.registry.getCommand('retained');
    await test.manifest(manifest); await test.file(entry, 'throw new Error("Failed discovery must not import");');
    const failed = await loader.reload(); expect(failed).toMatchObject({ committed: false, generation: 1, loaded: [entry] });
    expect(failed.errors.map(item => item.error.message)).toEqual([diagnostic]); expect(test.registry.getCommand('retained')).toBe(previous);
  });
  it.each(['syntax', 'utf8', 'nul', 'oversized', 'symlink', 'hardlink', 'directory'])('refuses %s manifest files with a source-free diagnostic', async kind => {
    const test = await fixture(); const manifest = path.join(test.pkg, 'package.json');
    await test.file(path.join(test.pkg, 'entry.ts'), 'throw new Error("Invalid manifest must prevent imports");');
    if (kind === 'directory') await mkdir(manifest);
    else if (kind === 'symlink' || kind === 'hardlink') {
      const target = await test.file(path.join(test.root, 'metadata'), '{}');
      if (kind === 'symlink') await symlink(target, manifest); else await link(target, manifest);
    } else if (kind === 'utf8') await writeFile(manifest, Buffer.from([0xff]));
    else {
      await writeFile(manifest, kind === 'syntax' ? '{ "private_body" :' : kind === 'nul' ? '{}\0' : '{}');
      if (kind === 'oversized') await truncate(manifest, 256 * 1024 + 1);
    }
    const failed = await test.loader([test.pkg]).loadAll(); expect(failed.committed).toBe(false);
    expect(failed.errors.map(item => item.error.message)).toEqual([diagnostic]);
  });
  it.each(['missing', 'symlink', 'hardlink', 'oversized', 'no-index', 'cycle'])('rejects incomplete %s declared entries rather than falling back to siblings', async kind => {
    const test = await fixture(); const target = path.join(test.pkg, 'entry.ts');
    const body = test.factory('unused');
    if (kind === 'symlink' || kind === 'hardlink') {
      const other = await test.file(path.join(test.root, 'other.ts'), body);
      if (kind === 'symlink') await symlink(other, target); else await link(other, target);
    } else if (kind === 'oversized') { await writeFile(target, body); await truncate(target, 5 * 1024 * 1024 + 1); }
    else if (kind === 'no-index' || kind === 'cycle') {
      await mkdir(target); if (kind === 'cycle') await test.file(path.join(target, 'package.json'), JSON.stringify({ aiHarness: { extensions: ['..'] } }));
    }
    await test.file(path.join(test.pkg, 'index.mjs'), 'throw new Error("Fallback must not run");');
    await test.manifest({ aiHarness: { extensions: ['entry.ts'] } });
    const failed = await test.loader([test.pkg]).loadAll(); expect(failed.committed).toBe(false);
    expect(failed.errors.map(item => item.error.message)).toEqual([diagnostic]);
  });
  it.each(['manifests', 'bytes', 'entries'])('bounds aggregate %s work and retains unrelated owners', async limit => {
    const test = await fixture(); const count = limit === 'manifests' ? 201 : limit === 'bytes' ? 17 : 11;
    for (let index = 0; index < count; index++) {
      const directory = path.join(test.pkg, String(index));
      await test.file(path.join(directory, 'index.ts'), test.factory('never'));
      await test.file(path.join(directory, 'package.json'), JSON.stringify({ pad: limit === 'bytes' ? 'x'.repeat(250_000) : '',
        aiHarness: { extensions: Array(limit === 'entries' ? 100 : 1).fill('index.ts') } }));
    }
    await test.registry.load('independent', api => api.registerCommand('independent', { description: 'Independent', handler: () => '' }));
    const result = await test.loader([test.pkg]).loadAll(); expect(result.committed).toBe(false);
    expect(result.errors.map(item => item.error.message)).toEqual([diagnostic]);
    expect(test.registry.getCommand('independent')).toBeDefined(); expect(test.registry.getCommand('never')).toBeUndefined();
  });
});
