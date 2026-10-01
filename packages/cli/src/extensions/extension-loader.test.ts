import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'fs/promises';
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
