import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionModuleLoader } from './module-loader.js';
import { ExtensionRegistry } from './extension-registry.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-typescript-')); roots.push(root);
  const registry = new ExtensionRegistry();
  const loader = (paths: string[], trusted = true) => new ExtensionModuleLoader(registry, { cwd: root, paths,
    includeGlobalLocation: false, includeProjectLocation: false, includeEnvironmentPaths: false, isProjectTrusted: () => trusted });
  return { root, registry, loader };
}
const factory = (value: string) => `import type {ExtensionAPI} from '@ai-harness/core';
  import { resolveBuiltinExtensionPolicy } from '@ai-harness/core';
  enum Value { Ready = 7 } class Box { constructor(public value: number) {} }
  export default (api: ExtensionAPI) => api.registerCommand('typed', { description: '${value}',
    handler: () => '${value}:' + new Box(Value.Ready).value + ':' + resolveBuiltinExtensionPolicy().mcp });`;

describe('descriptor-admitted TypeScript extension modules', () => {
  it.each(['ts', 'mts', 'cts'])('evaluates %s annotations, enums, parameter properties and the host Core namespace', async suffix => {
    const test = await fixture(); const file = path.join(test.root, `entry.${suffix}`); await writeFile(file, factory(suffix));
    const result = await test.loader([file]).loadAll(); expect(result.errors).toEqual([]); expect(result.committed).toBe(true);
    expect(await test.registry.getCommand('typed')?.handler('', {} as never)).toBe(`${suffix}:7:true`);
  });
  it('evaluates CommonJS TypeScript exports without changing their filename identity', async () => {
    const test = await fixture(); const file = path.join(test.root, 'entry.cts');
    await writeFile(file, `const filename: string = __filename; module.exports = api => api.registerCommand('typed', {description:'CommonJS', handler:()=>filename});`);
    expect((await test.loader([file]).loadAll()).errors).toEqual([]);
    expect(await test.registry.getCommand('typed')?.handler('', {} as never)).toBe(file);
  });
  it('transforms TSX without adding a React or browser rendering contract', async () => {
    const test = await fixture(); const file = path.join(test.root, 'entry.tsx');
    await writeFile(file, `const React = {createElement:(name: string, _props: unknown, text: string) => name+':'+text};
      const value = <label>typed</label>; export default api => api.registerCommand('typed', {description:'JSX',handler:()=>value});`);
    expect((await test.loader([file]).loadAll()).errors).toEqual([]);
    expect(await test.registry.getCommand('typed')?.handler('', {} as never)).toBe('label:typed');
  });
  it('supports relative extensionless and late imports with original import.meta identity', async () => {
    const test = await fixture(); const file = path.join(test.root, 'entry.mts');
    await writeFile(path.join(test.root, 'helper.ts'), 'export enum State { Ready = 9 }; export const value: number = State.Ready;');
    await writeFile(path.join(test.root, 'late.ts'), 'export const text: string = "late";');
    await writeFile(file, `import {value} from './helper'; const origin = import.meta.url;
      export default api => api.registerCommand('typed', {description:'Relative',handler:async()=>({value,origin,text:(await import('./late.ts')).text})});`);
    expect((await test.loader([file]).loadAll()).errors).toEqual([]);
    const result = await test.registry.getCommand('typed')?.handler('', {} as never);
    expect(result).toEqual({ value: 9, origin: pathToFileURL(file).href, text: 'late' });
  });
  it('refreshes entry/dependency generations and retains old registrations after a value-free syntax failure', async () => {
    const test = await fixture(); const file = path.join(test.root, 'entry.ts'); const helper = path.join(test.root, 'helper.ts');
    await writeFile(helper, 'export const value: string = "first";');
    const source = `import {value} from './helper.ts'; export default api => api.registerCommand('typed', {description:value,handler:()=>value});`;
    await writeFile(file, source); const loader = test.loader([file]);
    expect(await loader.loadAll()).toMatchObject({ committed: true, generation: 1 });
    await writeFile(helper, 'export const value: string = "second";');
    expect(await loader.reload()).toMatchObject({ committed: true, generation: 2 });
    expect(await test.registry.getCommand('typed')?.handler('', {} as never)).toBe('second');
    await writeFile(file, 'const private_source_secret: = "do not echo"');
    const failed = await loader.reload(); expect(failed).toMatchObject({ committed: false, generation: 2 });
    expect(failed.errors.map(entry => entry.error.message)).toEqual(['TypeScript extension evaluation failed.']);
    expect(await test.registry.getCommand('typed')?.handler('', {} as never)).toBe('second');
    await writeFile(file, source); expect(await loader.reload()).toMatchObject({ committed: true, generation: 3 });
    await loader.clear(); expect(test.registry.getCommand('typed')).toBeUndefined();
  });
  it('never imports refused, linked, oversized or declaration entries', async () => {
    const test = await fixture(); const marker = path.join(test.root, 'marker'); const file = path.join(test.root, 'entry.ts');
    const source = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'unsafe'); export default ()=>{};`;
    await writeFile(file, source); expect((await test.loader([file], false).loadAll()).loaded).toEqual([]);
    const hard = path.join(test.root, 'hard.ts'); await link(file, hard);
    const symbolic = path.join(test.root, 'symbolic.ts'); await symlink(file, symbolic);
    const large = path.join(test.root, 'large.ts'); await writeFile(large, ''); await truncate(large, 5 * 1024 * 1024 + 1);
    for (const suffix of ['d.ts', 'd.mts', 'd.cts']) await writeFile(path.join(test.root, `types.${suffix}`), source);
    expect((await test.loader([test.root]).loadAll()).loaded).toEqual([]);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('discovers typed child indexes, deduplicates paths and preserves JavaScript index precedence', async () => {
    const test = await fixture(); await mkdir(path.join(test.root, 'child'));
    const ts = path.join(test.root, 'child/index.ts'); await writeFile(ts, factory('typed'));
    expect(await test.loader([test.root, ts]).discover()).toEqual([ts]);
    const js = path.join(test.root, 'child/index.js'); await writeFile(js, 'export default ()=>{};');
    expect(await test.loader([test.root]).discover()).toEqual([js]);
  });
  it('leaves existing native CommonJS cache ownership intact across successful and failed candidates', async () => {
    const test = await fixture(); const dependency = path.join(test.root, 'dependency.cjs');
    await writeFile(dependency, 'module.exports = {value: "owned"};'); const require = createRequire(import.meta.url);
    const value: unknown = require(dependency); const cached = require.cache[dependency];
    const file = path.join(test.root, 'entry.ts'); await writeFile(file, `import dependency from './dependency.cjs'; export default api => api.registerCommand('typed', {description:dependency.value,handler:()=>dependency.value});`);
    const loader = test.loader([file]); expect((await loader.loadAll()).errors).toEqual([]);
    expect(require.cache[dependency]).toBe(cached); expect(require(dependency)).toBe(value);
    await writeFile(file, `import dependency from './dependency.cjs'; throw new Error('failed candidate'); export default ()=>{};`);
    expect((await loader.reload()).committed).toBe(false);
    expect(require.cache[dependency]).toBe(cached); expect(require(dependency)).toBe(value);
    expect(await test.registry.getCommand('typed')?.handler('', {} as never)).toBe('owned');
  });
});
