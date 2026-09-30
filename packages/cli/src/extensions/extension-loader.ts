import { access, readdir, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { ExtensionFactory, ExtensionRegistry } from '@ai-harness/core';

export interface ExtensionLoaderOptions {
  cwd?: string;
  homeDir?: string;
  paths?: string[];
  isProjectTrusted?: () => boolean;
}

export interface ExtensionLoadResult {
  loaded: string[];
  errors: Array<{ path: string; error: Error }>;
}

/** Discovers and loads trusted JavaScript extension modules. */
export class ExtensionLoader {
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly explicitPaths: string[];
  private readonly isProjectTrusted: () => boolean;
  private generation = 0;

  constructor(
    private readonly registry: ExtensionRegistry,
    options: ExtensionLoaderOptions = {},
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.homeDir = options.homeDir ?? os.homedir();
    this.explicitPaths = options.paths ?? [];
    this.isProjectTrusted = options.isProjectTrusted ?? (() => true);
  }

  async loadAll(): Promise<ExtensionLoadResult> {
    const result: ExtensionLoadResult = { loaded: [], errors: [] };
    for (const filePath of await this.discover()) {
      try {
        const moduleUrl = `${pathToFileURL(filePath).href}?aiharness=${this.generation}`;
        const module = await import(moduleUrl) as { default?: ExtensionFactory };
        if (typeof module.default !== 'function') {
          throw new Error('Extension module must export a default factory function');
        }
        await this.registry.load(filePath, module.default);
        result.loaded.push(filePath);
      } catch (error) {
        result.errors.push({
          path: filePath,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return result;
  }

  async reload(): Promise<ExtensionLoadResult> {
    await this.registry.unloadAll();
    this.generation++;
    return this.loadAll();
  }

  async discover(): Promise<string[]> {
    const configured = process.env.AI_HARNESS_EXTENSIONS
      ?.split(path.delimiter)
      .map(item => item.trim())
      .filter(Boolean) ?? [];
    const candidates = [
      { path: path.join(this.homeDir, '.ai-harness', 'extensions'), project: false },
      { path: path.join(this.cwd, '.ai-harness', 'extensions'), project: true },
      ...configured.map(candidate => ({ path: candidate, project: false })),
      ...this.explicitPaths.map(candidate => ({ path: candidate, project: false })),
    ];
    const files = new Set<string>();

    for (const candidate of candidates) {
      if (candidate.project && !this.isProjectTrusted()) continue;
      const resolved = path.resolve(this.cwd, candidate.path);
      try {
        const info = await stat(resolved);
        if (info.isFile() && this.isExtensionFile(resolved)) files.add(resolved);
        if (info.isDirectory()) {
          const index = await this.findIndex(resolved);
          if (index) files.add(index);
          for (const entry of await readdir(resolved, { withFileTypes: true })) {
            const entryPath = path.join(resolved, entry.name);
            if (entry.isFile() && this.isExtensionFile(entryPath)) files.add(entryPath);
            if (entry.isDirectory()) {
              const childIndex = await this.findIndex(entryPath);
              if (childIndex) files.add(childIndex);
            }
          }
        }
      } catch {
        // Missing discovery locations are expected.
      }
    }

    return [...files].sort();
  }

  private async findIndex(directory: string): Promise<string | undefined> {
    for (const name of ['index.mjs', 'index.js']) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next supported entry point.
      }
    }
    return undefined;
  }

  private isExtensionFile(filePath: string): boolean {
    return filePath.endsWith('.js') || filePath.endsWith('.mjs');
  }
}

/** Parse repeatable `--extension <path>` and `--extension=<path>` arguments. */
export function getExtensionPaths(args: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--extension' && args[index + 1]) paths.push(args[++index]);
    else if (argument.startsWith('--extension=')) paths.push(argument.slice('--extension='.length));
  }
  return paths;
}
