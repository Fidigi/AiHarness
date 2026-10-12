import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, link, mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionRegistry } from '@ai-harness/core';
import { ExtensionLoader, getExtensionPaths } from './extension-loader';

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-extensions-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ExtensionLoader', () => {
  it('discovers files and directory entry points', async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, 'hello.mjs'), 'export default () => {};');
    await writeFile(path.join(directory, 'common.cjs'), 'module.exports = () => {};');
    await mkdir(path.join(directory, 'cjs-package'));
    await writeFile(path.join(directory, 'cjs-package', 'index.cjs'), 'module.exports = () => {};');
    await mkdir(path.join(directory, 'package'));
    await writeFile(path.join(directory, 'package', 'index.js'), 'export default () => {};');
    await writeFile(path.join(directory, 'ignored.ts'), 'export default () => {};');
    const loader = new ExtensionLoader(new ExtensionRegistry(), {
      cwd: directory,
      homeDir: path.join(directory, 'home'),
      paths: [directory],
    });

    const discovered = await loader.discover();

    expect(discovered).toEqual([
      path.join(directory, 'cjs-package', 'index.cjs'),
      path.join(directory, 'common.cjs'),
      path.join(directory, 'hello.mjs'),
      path.join(directory, 'package', 'index.js'),
    ]);
  });

  it('refuses symbolic links and oversized files inside extension directories', async () => {
    const directory = await tempDirectory();
    const target = path.join(directory, 'target.mjs');
    const linked = path.join(directory, 'linked.mjs');
    const oversized = path.join(directory, 'oversized.mjs');
    await writeFile(target, 'export default () => {};');
    await symlink(target, linked);
    await writeFile(oversized, '');
    await truncate(oversized, 5 * 1024 * 1024 + 1);
    const loader = new ExtensionLoader(new ExtensionRegistry(), {
      cwd: directory,
      homeDir: path.join(directory, 'home'),
      paths: [directory],
    });

    expect(await loader.discover()).toEqual([target]);
  });

  it('refuses hard-linked modules and modules reached through linked parents', async () => {
    const directory = await tempDirectory();
    const source = path.join(directory, 'source.mjs');
    const linkedFile = path.join(directory, 'linked-hard.mjs');
    const realParent = path.join(directory, 'real-parent');
    const linkedParent = path.join(directory, 'linked-parent');
    await writeFile(source, 'export default () => {};');
    await link(source, linkedFile);
    await mkdir(realParent);
    await writeFile(path.join(realParent, 'index.mjs'), 'export default () => {};');
    await symlink(realParent, linkedParent, 'dir');

    const hardLinkLoader = new ExtensionLoader(new ExtensionRegistry(), {
      cwd: directory,
      homeDir: path.join(directory, 'home'),
      paths: [linkedFile],
    });
    const parentLinkLoader = new ExtensionLoader(new ExtensionRegistry(), {
      cwd: directory,
      homeDir: path.join(directory, 'home'),
      paths: [path.join(linkedParent, 'index.mjs')],
    });

    expect(await hardLinkLoader.discover()).toEqual([]);
    expect(await parentLinkLoader.discover()).toEqual([]);
  });

  it.runIf(process.platform === 'linux')('anchors the evaluated entry while its pathname is replaced', async () => {
    const directory = await tempDirectory();
    const extensionPath = path.join(directory, 'raced.mjs');
    const replacementPath = path.join(directory, 'replacement.mjs');
    const readyPath = path.join(directory, 'ready');
    const releasePath = path.join(directory, 'release');
    const markerPath = path.join(directory, 'evaluated');
    await writeFile(extensionPath, `
      import { readFile, writeFile } from 'node:fs/promises';
      await writeFile(${JSON.stringify(readyPath)}, 'ready');
      while (true) {
        try { if (await readFile(${JSON.stringify(releasePath)}, 'utf8') === 'go') break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await writeFile(${JSON.stringify(markerPath)}, 'original');
      export default () => {};
    `);
    await writeFile(replacementPath, `
      import { writeFile } from 'node:fs/promises';
      await writeFile(${JSON.stringify(markerPath)}, 'replacement');
      export default () => {};
    `);

    const moduleLoaderUrl = new URL('../../../core/src/extensions/module-loader.ts', import.meta.url).href;
    const registryUrl = new URL('../../../core/src/extensions/extension-registry.ts', import.meta.url).href;
    const script = `
      import { ExtensionModuleLoader } from ${JSON.stringify(moduleLoaderUrl)};
      import { ExtensionRegistry } from ${JSON.stringify(registryUrl)};
      const loader = new ExtensionModuleLoader(new ExtensionRegistry(), {
        cwd: ${JSON.stringify(directory)}, homeDir: ${JSON.stringify(path.join(directory, 'home'))},
        paths: [${JSON.stringify(extensionPath)}], includeGlobalLocation: false,
        includeProjectLocation: false, isProjectTrusted: () => true,
      });
      const result = await loader.loadAll();
      process.stdout.write(JSON.stringify({
        committed: result.committed,
        error: result.errors[0]?.error.message,
      }));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });

    let ready = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      try { await access(readyPath); ready = true; break; } catch { /* Module has not started evaluating yet. */ }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(ready, stderr).toBe(true);
    await rename(replacementPath, extensionPath);
    await writeFile(releasePath, 'go');

    const code = child.exitCode ?? await Promise.race([
      new Promise<number | null>(resolve => child.once('exit', resolve)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Extension race child timed out.')), 10_000)),
    ]).finally(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    expect(code, stderr).toBe(0);
    expect(await readFile(markerPath, 'utf8')).toBe('original');
    expect(JSON.parse(stdout)).toEqual({
      committed: false,
      error: 'Extension module changed while it was being imported',
    });
  });

  it('loads command factories and reloads changed modules', async () => {
    const directory = await tempDirectory();
    const extensionPath = path.join(directory, 'greeting.mjs');
    await writeFile(extensionPath, `export default api => api.registerCommand('greet', {
      description: 'Greeting', handler: name => 'Hello ' + name
    });`);
    const registry = new ExtensionRegistry();
    const loader = new ExtensionLoader(registry, {
      cwd: directory,
      homeDir: path.join(directory, 'home'),
      paths: [extensionPath],
    });

    const first = await loader.loadAll();
    expect(first.errors).toEqual([]);
    expect(await registry.getCommand('greet')?.handler('Ada', {} as never)).toBe('Hello Ada');

    await writeFile(extensionPath, `export default api => api.registerCommand('greet', {
      description: 'Greeting', handler: name => 'Bonjour ' + name
    });`);
    const second = await loader.reload();
    expect(second.errors).toEqual([]);
    expect(await registry.getCommand('greet')?.handler('Ada', {} as never)).toBe('Bonjour Ada');
  });

  it('owns option metadata across reload, conflict rollback and removal', async () => {
    const directory = await tempDirectory();
    const extensionPath = path.join(directory, 'options.mjs');
    const source = (name: string): string => `export default api => {
      api.registerOption('${name}', { type: 'string', description: 'Style', default: 'brief', completions: ['brief', 'full'] });
      api.registerCommand('value', { description: 'Read option', handler: () => api.getOption('${name}') });
    };`;
    await writeFile(extensionPath, source('review-style'));
    const registry = new ExtensionRegistry();
    const loader = new ExtensionLoader(registry, {
      cwd: directory, homeDir: path.join(directory, 'home'), paths: [directory],
    });
    expect(await loader.loadAll()).toMatchObject({ committed: true, generation: 1 });
    registry.setOptionValues({ 'review-style': 'full' });
    await writeFile(path.join(directory, 'conflict.mjs'), `export default api => {
      api.registerOption('review-style', { type: 'boolean', description: 'Conflict' });
    };`);
    expect(await loader.reload()).toMatchObject({ committed: false, generation: 1 });
    expect(registry.getOptions()).toEqual([expect.objectContaining({ name: 'review-style', type: 'string' })]);
    expect(await registry.getCommand('value')?.handler('', {} as never)).toBe('full');
    await rm(path.join(directory, 'conflict.mjs'));
    await writeFile(extensionPath, source('review-new'));
    expect(await loader.reload()).toMatchObject({ committed: true, generation: 2 });
    expect(registry.getOptions().map(option => option.name)).toEqual(['review-new']);
    expect(await registry.getCommand('value')?.handler('', {} as never)).toBe('brief');
    await rm(extensionPath);
    expect((await loader.reload()).committed).toBe(true);
    expect(registry.getOptions()).toEqual([]);
  });

  it('uses fresh import attempts after registration and import failures in a real process', async () => {
    const directory = await tempDirectory();
    const moduleLoaderUrl = new URL('../../../core/src/extensions/module-loader.ts', import.meta.url).href;
    const registryUrl = new URL('../../../core/src/extensions/extension-registry.ts', import.meta.url).href;
    const script = `
      import { writeFile, rm } from 'node:fs/promises';
      import { ExtensionModuleLoader } from ${JSON.stringify(moduleLoaderUrl)};
      import { ExtensionRegistry } from ${JSON.stringify(registryUrl)};
      const directory = ${JSON.stringify(directory)};
      const entry = directory + '/option.mjs';
      const conflict = directory + '/conflict.mjs';
      await writeFile(directory + '/helper.mjs', 'export const description = "Style";');
      const source = name => 'import { description } from "./helper.mjs"; export default api => { if (!import.meta.url.startsWith("file://" + ' + JSON.stringify(directory) + ')) throw new Error("Entry URL changed"); api.registerOption("' + name + '", { type: "string", description, default: "brief" }); api.registerCommand("value", { description: "Read", handler: () => api.getOption("' + name + '") }); };';
      const registry = new ExtensionRegistry();
      const loader = new ExtensionModuleLoader(registry, {
        cwd: directory, paths: [entry, conflict], includeGlobalLocation: false, includeProjectLocation: false,
      });
      const results = [];
      const snapshot = async () => {
        const result = await loader.reload();
        results.push({ committed: result.committed, generation: result.generation,
          names: registry.getOptions().map(option => option.name), value: await registry.getCommand('value')?.handler('', {}) });
      };
      await writeFile(entry, source('review-style'));
      await snapshot();
      registry.setOptionValues({ 'review-style': 'full' });
      await writeFile(conflict, source('review-style'));
      await snapshot();
      await rm(conflict);
      await writeFile(entry, source('review-new'));
      await snapshot();
      await writeFile(entry, 'throw new Error("invalid candidate"); export default () => {};');
      await snapshot();
      await writeFile(entry, source('review-fixed'));
      await snapshot();
      await writeFile(entry, source('review-independent'));
      const independent = new ExtensionRegistry();
      const secondLoader = new ExtensionModuleLoader(independent, {
        cwd: directory, paths: [entry], includeGlobalLocation: false, includeProjectLocation: false,
      });
      const second = await secondLoader.loadAll();
      results.push({ committed: second.committed, generation: second.generation,
        names: independent.getOptions().map(option => option.name), value: await independent.getCommand('value')?.handler('', {}) });
      await independent.shutdown();
      for (const [name, code, expected] of [
        ['esm', 'export default api => api.registerCommand("value", { description: "ESM", handler: () => "esm-compatible" });', 'esm-compatible'],
        ['cjs', 'module.exports = api => api.registerCommand("value", { description: "CommonJS", handler: () => require("./cjs-helper.cjs").value });', 'cjs-compatible'],
      ]) {
        await writeFile(directory + '/cjs-helper.cjs', 'exports.value = "cjs-compatible";');
        const compatibilityPath = directory + '/' + name + '.js';
        await writeFile(compatibilityPath, code);
        const compatibilityRegistry = new ExtensionRegistry();
        const compatibilityLoader = new ExtensionModuleLoader(compatibilityRegistry, {
          cwd: directory, paths: [compatibilityPath], includeGlobalLocation: false, includeProjectLocation: false,
        });
        const result = await compatibilityLoader.loadAll();
        if (!result.committed || await compatibilityRegistry.getCommand('value')?.handler('', {}) !== expected) {
          throw new Error(name + ' compatibility failed: ' + result.errors[0]?.error.message);
        }
        await compatibilityRegistry.shutdown();
      }
      await registry.shutdown();
      process.stdout.write(JSON.stringify(results));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Reload child timed out.')); }, 10_000);
      child.once('error', reject);
      child.once('close', value => { clearTimeout(timeout); resolve(value); });
    });
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { committed: true, generation: 1, names: ['review-style'], value: 'brief' },
      { committed: false, generation: 1, names: ['review-style'], value: 'full' },
      { committed: true, generation: 2, names: ['review-new'], value: 'brief' },
      { committed: false, generation: 2, names: ['review-new'], value: 'brief' },
      { committed: true, generation: 3, names: ['review-fixed'], value: 'brief' },
      { committed: true, generation: 1, names: ['review-independent'], value: 'brief' },
    ]);
  }, 15_000);

  // Plain Node against built Core: no tsx hooks and no Vitest VM module cache.
  it.each(['ambiguous-js', 'commonjs-js', 'cjs'])('freshly evaluates %s entries on successful reload and in independent loaders', async format => {
    const directory = await tempDirectory();
    const entry = path.join(directory, format === 'cjs' ? 'entry.cjs' : 'entry.js');
    const moduleLoaderUrl = new URL('../../../core/dist/extensions/module-loader.js', import.meta.url).href;
    const registryUrl = new URL('../../../core/dist/extensions/extension-registry.js', import.meta.url).href;
    const script = `
      import { writeFile } from 'node:fs/promises';
      import { createRequire } from 'node:module';
      import { ExtensionModuleLoader } from ${JSON.stringify(moduleLoaderUrl)};
      import { ExtensionRegistry } from ${JSON.stringify(registryUrl)};
      const directory = ${JSON.stringify(directory)};
      const entry = ${JSON.stringify(entry)};
      ${format === 'commonjs-js' ? 'await writeFile(directory + "/package.json", \'{"type":"commonjs"}\');' : ''}
      await writeFile(directory + '/helper.cjs', 'globalThis.helperLoads = (globalThis.helperLoads ?? 0) + 1; exports.value = "relative-require";');
      await writeFile(directory + '/dynamic.mjs', 'export const value = "relative-import";');
      const source = value => \`
        globalThis.entryLoads = (globalThis.entryLoads ?? 0) + 1;
        const helper = require('./helper.cjs');
        module.exports = api => {
          api.registerOption('review-cjs', { type: 'string', description: 'CJS reload', default: \${JSON.stringify(value)} });
          api.registerCommand('value', { description: 'Read', handler: async () => ({
            value: api.getOption('review-cjs'), required: helper.value,
            imported: (await import('./dynamic.mjs')).value,
            filename: __filename, dirname: __dirname,
          }) });
        };
      \`;
      const require = createRequire(import.meta.url);
      await writeFile(entry, source('first'));
      const previousExports = require(entry);
      const previousCache = require.cache[entry];
      const options = { cwd: directory, homeDir: directory, paths: [entry],
        includeGlobalLocation: false, includeProjectLocation: false, isProjectTrusted: () => true };
      const registry = new ExtensionRegistry();
      const loader = new ExtensionModuleLoader(registry, options);
      const snapshots = [];
      const snapshot = async (loader, registry) => {
        const result = await loader.reload();
        snapshots.push({ committed: result.committed, generation: result.generation,
          errors: result.errors.map(item => item.error.message), default: registry.getOptions()[0]?.default,
          command: await registry.getCommand('value')?.handler('', {}),
          cachePreserved: require.cache[entry] === previousCache && require(entry) === previousExports });
      };
      await snapshot(loader, registry);
      await writeFile(entry, source('second'));
      await snapshot(loader, registry);
      await writeFile(entry, source('independent'));
      const independent = new ExtensionRegistry();
      await snapshot(new ExtensionModuleLoader(independent, options), independent);
      const oldValue = await registry.getCommand('value').handler('', {});
      // An entry not previously required must also stay out of the shared cache.
      delete require.cache[entry];
      await writeFile(entry, source('uncached'));
      const uncachedRegistry = new ExtensionRegistry();
      const uncachedResult = await new ExtensionModuleLoader(uncachedRegistry, options).loadAll();
      const uncached = { committed: uncachedResult.committed, generation: uncachedResult.generation,
        errors: uncachedResult.errors.map(item => item.error.message),
        default: uncachedRegistry.getOptions()[0]?.default,
        command: await uncachedRegistry.getCommand('value')?.handler('', {}),
        cacheAbsent: !Object.hasOwn(require.cache, entry) };
      await uncachedRegistry.shutdown();
      await independent.shutdown();
      await registry.shutdown();
      process.stdout.write(JSON.stringify({ snapshots, entryLoads: globalThis.entryLoads,
        helperLoads: globalThis.helperLoads, oldValue, uncached }));
    `;
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--input-type=module', '--eval', script], { timeout: 10_000 });
    const command = (value: string): object => ({ value, required: 'relative-require', imported: 'relative-import', filename: entry, dirname: directory });
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      snapshots: [
        { committed: true, generation: 1, errors: [], default: 'first', command: command('first'), cachePreserved: true },
        { committed: true, generation: 2, errors: [], default: 'second', command: command('second'), cachePreserved: true },
        { committed: true, generation: 1, errors: [], default: 'independent', command: command('independent'), cachePreserved: true },
      ],
      entryLoads: 5, helperLoads: 1, oldValue: command('second'),
      uncached: { committed: true, generation: 1, errors: [], default: 'uncached', command: command('uncached'), cacheAbsent: true },
    });
  }, 15_000);

  it.each(['ambiguous-js', 'commonjs-js', 'cjs'])('rolls back failed %s candidates and evaluates the next attempt afresh', async format => {
    const directory = await tempDirectory();
    const entry = path.join(directory, format === 'cjs' ? 'entry.cjs' : 'entry.js');
    const moduleLoaderUrl = new URL('../../../core/dist/extensions/module-loader.js', import.meta.url).href;
    const registryUrl = new URL('../../../core/dist/extensions/extension-registry.js', import.meta.url).href;
    const script = `
      import { writeFile } from 'node:fs/promises';
      import { createRequire } from 'node:module';
      import { ExtensionModuleLoader } from ${JSON.stringify(moduleLoaderUrl)};
      import { ExtensionRegistry } from ${JSON.stringify(registryUrl)};
      const directory = ${JSON.stringify(directory)};
      const entry = ${JSON.stringify(entry)};
      ${format === 'commonjs-js' ? 'await writeFile(directory + "/package.json", \'{"type":"commonjs"}\');' : ''}
      const source = (value, fail = false) => \`
        module.exports = api => {
          api.registerOption('review-cjs', { type: 'string', description: 'CJS reload', default: \${JSON.stringify(value)} });
          api.registerCommand('value', { description: 'Read', handler: () => api.getOption('review-cjs') });
          \${fail ? 'throw new Error("factory candidate failed");' : ''}
        };
      \`;
      await writeFile(entry, source('first'));
      const require = createRequire(import.meta.url);
      const previousExports = require(entry);
      const previousCache = require.cache[entry];
      const registry = new ExtensionRegistry();
      const loader = new ExtensionModuleLoader(registry, { cwd: directory, homeDir: directory,
        paths: [entry], includeGlobalLocation: false, includeProjectLocation: false, isProjectTrusted: () => true });
      const snapshots = [];
      const snapshot = async () => {
        const result = await loader.reload();
        snapshots.push({ committed: result.committed, generation: result.generation,
          errors: result.errors.map(item => item.error.message), default: registry.getOptions()[0]?.default,
          value: await registry.getCommand('value')?.handler('', {}),
          cachePreserved: require.cache[entry] === previousCache && require(entry) === previousExports });
      };
      await snapshot();
      registry.setOptionValues({ 'review-cjs': 'explicit' });
      await writeFile(entry, source('failed-factory', true));
      await snapshot();
      await writeFile(entry, source('second'));
      await snapshot();
      await writeFile(entry, 'throw new Error("import candidate failed"); module.exports = () => {};');
      await snapshot();
      await writeFile(entry, source('third'));
      await snapshot();
      await registry.shutdown();
      process.stdout.write(JSON.stringify(snapshots));
    `;
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--input-type=module', '--eval', script], { timeout: 10_000 });
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual([
      { committed: true, generation: 1, errors: [], default: 'first', value: 'first', cachePreserved: true },
      { committed: false, generation: 1, errors: ['factory candidate failed'], default: 'first', value: 'explicit', cachePreserved: true },
      { committed: true, generation: 2, errors: [], default: 'second', value: 'second', cachePreserved: true },
      { committed: false, generation: 2, errors: ['import candidate failed'], default: 'second', value: 'second', cachePreserved: true },
      { committed: true, generation: 3, errors: [], default: 'third', value: 'third', cachePreserved: true },
    ]);
  }, 15_000);

  it('skips project extensions when the project is not trusted', async () => {
    const root = await tempDirectory();
    const projectDirectory = path.join(root, '.ai-harness', 'extensions');
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(path.join(projectDirectory, 'project.mjs'), `export default api => api.registerCommand('project', { description: 'Project', handler: () => 'ok' });`);
    const registry = new ExtensionRegistry();
    const loader = new ExtensionLoader(registry, {
      cwd: root,
      homeDir: path.join(root, 'home'),
      paths: [path.join(projectDirectory, 'project.mjs')],
      isProjectTrusted: () => false,
    });

    expect(await loader.discover()).toEqual([]);
    expect((await loader.loadAll()).loaded).toEqual([]);
    expect(registry.getCommand('project')).toBeUndefined();
  });

  it('keeps the previous atomic generation when any replacement module is invalid', async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, 'valid.mjs'), `export default api => api.registerCommand('valid', {
      description: 'Valid', handler: () => 'ok'
    });`);
    const registry = new ExtensionRegistry();
    const loader = new ExtensionLoader(registry, {
      cwd: directory,
      homeDir: path.join(directory, 'home'),
      paths: [directory],
    });
    const first = await loader.loadAll();
    expect(first.committed).toBe(true);
    await writeFile(path.join(directory, 'invalid.mjs'), 'export const value = 1;');

    const result = await loader.reload();

    expect(result.committed).toBe(false);
    expect(result.loaded).toEqual(first.loaded);
    expect(result.errors).toHaveLength(1);
    expect(registry.getCommand('valid')).toBeDefined();
  });
});

describe('getExtensionPaths', () => {
  it('parses repeated extension arguments', () => {
    expect(getExtensionPaths([
      '--extension', './one.mjs',
      '--regular',
      '--extension=./two.mjs',
    ])).toEqual(['./one.mjs', './two.mjs']);
  });
});
