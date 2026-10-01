import { lstat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionFactory } from './extension-registry.js';
import type { ExtensionRegistry } from './extension-registry.js';

export interface ExtensionModuleLoaderOptions {
  cwd?: string;
  homeDir?: string;
  paths?: string[] | (() => string[] | Promise<string[]>);
  isProjectTrusted?: () => boolean | Promise<boolean>;
  includeGlobalLocation?: boolean;
  includeProjectLocation?: boolean;
}

export interface ExtensionModuleLoadError {
  path: string;
  error: Error;
}

export interface ExtensionModuleLoadResult {
  loaded: string[];
  errors: ExtensionModuleLoadError[];
  generation: number;
  committed: boolean;
}

/** Discovers trusted JavaScript modules and swaps their registrations transactionally. */
export class ExtensionModuleLoader {
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly configuredPaths: ExtensionModuleLoaderOptions['paths'];
  private readonly isProjectTrusted: NonNullable<ExtensionModuleLoaderOptions['isProjectTrusted']>;
  private readonly includeGlobalLocation: boolean;
  private readonly includeProjectLocation: boolean;
  private managedIds = new Set<string>();
  private generation = 0;
  private activeReload?: Promise<ExtensionModuleLoadResult>;

  constructor(
    private readonly registry: ExtensionRegistry,
    options: ExtensionModuleLoaderOptions = {},
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.homeDir = options.homeDir ?? os.homedir();
    this.configuredPaths = options.paths ?? [];
    this.isProjectTrusted = options.isProjectTrusted ?? (() => true);
    this.includeGlobalLocation = options.includeGlobalLocation !== false;
    this.includeProjectLocation = options.includeProjectLocation !== false;
  }

  loadAll(): Promise<ExtensionModuleLoadResult> {
    return this.reload();
  }

  reload(): Promise<ExtensionModuleLoadResult> {
    if (this.activeReload) return this.activeReload;
    this.activeReload = this.performReload().finally(() => { this.activeReload = undefined; });
    return this.activeReload;
  }

  /** Remove this loader's complete generation, used to prevent cross-workspace fallback leaks. */
  async clear(): Promise<ExtensionModuleLoadResult> {
    if (this.activeReload) await this.activeReload;
    await this.registry.replaceManaged(this.managedIds, []);
    this.managedIds.clear();
    this.generation++;
    return { loaded: [], errors: [], generation: this.generation, committed: true };
  }

  async discover(): Promise<string[]> {
    const environment = process.env.AI_HARNESS_EXTENSIONS
      ?.split(path.delimiter)
      .map(item => item.trim())
      .filter(Boolean) ?? [];
    const explicit = typeof this.configuredPaths === 'function'
      ? await this.configuredPaths()
      : this.configuredPaths ?? [];
    const candidates = [
      ...(this.includeGlobalLocation ? [{ path: path.join(this.homeDir, '.ai-harness', 'extensions'), project: false }] : []),
      ...(this.includeProjectLocation ? [{ path: path.join(this.cwd, '.ai-harness', 'extensions'), project: true }] : []),
      ...environment.map(candidate => ({ path: candidate, project: false })),
      ...explicit.map(candidate => ({ path: candidate, project: false })),
    ];
    const projectTrusted = await this.isProjectTrusted();
    const files = new Set<string>();

    for (const candidate of candidates.slice(0, 200)) {
      if (candidate.project && !projectTrusted) continue;
      const resolved = path.resolve(this.cwd, candidate.path);
      try {
        const info = await lstat(resolved);
        if (info.isSymbolicLink()) continue;
        if (info.isFile() && info.size <= 5 * 1024 * 1024 && this.isExtensionFile(resolved)) files.add(resolved);
        if (info.isDirectory()) {
          const index = await this.findIndex(resolved);
          if (index) files.add(index);
          for (const entry of (await readdir(resolved, { withFileTypes: true })).slice(0, 1_000)) {
            const entryPath = path.join(resolved, entry.name);
            if (entry.isFile() && this.isExtensionFile(entryPath)) {
              try {
                const entryInfo = await lstat(entryPath);
                if (entryInfo.isFile() && !entryInfo.isSymbolicLink() && entryInfo.size <= 5 * 1024 * 1024) files.add(entryPath);
              } catch { /* Entry changed during discovery. */ }
            }
            if (entry.isDirectory()) {
              const childIndex = await this.findIndex(entryPath);
              if (childIndex) files.add(childIndex);
            }
          }
        }
      } catch {
        // Missing optional discovery locations are expected.
      }
    }
    return [...files].sort();
  }

  private async performReload(): Promise<ExtensionModuleLoadResult> {
    const nextGeneration = this.generation + 1;
    const errors: ExtensionModuleLoadError[] = [];
    const candidates: Array<{ id: string; factory: ExtensionFactory }> = [];
    for (const filePath of await this.discover()) {
      try {
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024) {
          throw new Error('Extension module must be a regular file no larger than 5 MiB');
        }
        const moduleUrl = `${pathToFileURL(filePath).href}?aiharness=${nextGeneration}`;
        const loaded = await import(moduleUrl) as { default?: ExtensionFactory };
        if (typeof loaded.default !== 'function') {
          throw new Error('Extension module must export a default factory function');
        }
        candidates.push({ id: filePath, factory: loaded.default });
      } catch (error) {
        errors.push({ path: filePath, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
    if (errors.length) {
      return { loaded: [...this.managedIds], errors, generation: this.generation, committed: false };
    }

    try {
      await this.registry.replaceManaged(this.managedIds, candidates);
    } catch (error) {
      errors.push({ path: '<generation>', error: error instanceof Error ? error : new Error(String(error)) });
      return { loaded: [...this.managedIds], errors, generation: this.generation, committed: false };
    }
    this.managedIds = new Set(candidates.map(candidate => candidate.id));
    this.generation = nextGeneration;
    return { loaded: [...this.managedIds], errors: [], generation: this.generation, committed: true };
  }

  private async findIndex(directory: string): Promise<string | undefined> {
    for (const name of ['index.mjs', 'index.js']) {
      const candidate = path.join(directory, name);
      try {
        const info = await lstat(candidate);
        if (info.isFile() && !info.isSymbolicLink() && info.size <= 5 * 1024 * 1024) return candidate;
      } catch {
        // Try next supported entry point.
      }
    }
    return undefined;
  }

  private isExtensionFile(filePath: string): boolean {
    return filePath.endsWith('.js') || filePath.endsWith('.mjs');
  }
}
