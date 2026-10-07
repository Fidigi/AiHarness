import { spawn } from 'node:child_process';
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
