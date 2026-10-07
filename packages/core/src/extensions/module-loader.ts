import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStableDirectoryHandle, readStableDirectoryEntries } from '../security/stable-directory.js';
import type { ExtensionFactory } from './extension-registry.js';
import type { ExtensionRegistry } from './extension-registry.js';

const RUNNING_UNDER_VITEST = Reflect.has(globalThis, '__vitest_worker__');

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

async function pathContainsSymbolicLink(candidate: string): Promise<boolean> {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

interface ExtensionFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function sameExtensionIdentity(
  value: ExtensionFileIdentity,
  expected: ExtensionFileIdentity,
): boolean {
  return value.dev === expected.dev && value.ino === expected.ino && value.size === expected.size
    && value.mtimeMs === expected.mtimeMs && value.ctimeMs === expected.ctimeMs;
}

async function importExtensionFactory(
  filePath: string,
  generation: number,
): Promise<ExtensionFactory> {
  const parentPath = path.dirname(filePath);
  const parentHandle = await openStableDirectoryHandle(parentPath).catch(() => {
    throw new Error('Extension module parent must be a stable regular directory');
  });
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const parentOpened = await parentHandle.stat();
    const parentBefore = await lstat(parentPath);
    if (!parentOpened.isDirectory() || !parentBefore.isDirectory() || parentBefore.isSymbolicLink()
      || parentOpened.dev !== parentBefore.dev || parentOpened.ino !== parentBefore.ino) {
      throw new Error('Extension module parent changed while it was being opened');
    }
    const anchoredPath = process.platform === 'linux'
      ? `/proc/self/fd/${parentHandle.fd}/${path.basename(filePath)}`
      : filePath;
    const before = await lstat(anchoredPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size > 5 * 1024 * 1024) {
      throw new Error('Extension module must be a stable regular file no larger than 5 MiB');
    }
    fileHandle = await open(
      anchoredPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const opened = await fileHandle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 5 * 1024 * 1024
      || !sameExtensionIdentity(opened, before)) {
      throw new Error('Extension module changed while it was being opened');
    }

    // Linux imports through the held descriptor so a pathname replacement cannot substitute the entry module.
    // Vitest's VM loader cannot import /proc descriptors; process-level contract tests exercise that path.
    // Other platforms retain the same before/open/after identity checks and fail closed when instability is seen.
    const descriptorImport = process.platform === 'linux' && !RUNNING_UNDER_VITEST;
    const importPath = descriptorImport ? `/proc/self/fd/${fileHandle.fd}` : filePath;
    const moduleUrl = `${pathToFileURL(importPath).href}?aiharness=${generation}`;
    const loaded = await import(moduleUrl) as { default?: ExtensionFactory };

    const [openedAfter, pathAfter, parentAfter] = await Promise.all([
      fileHandle.stat(),
      lstat(filePath),
      parentHandle.stat(),
    ]);
    if (!openedAfter.isFile() || openedAfter.nlink !== 1 || !sameExtensionIdentity(openedAfter, opened)
      || !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1
      || !sameExtensionIdentity(pathAfter, opened)
      || !parentAfter.isDirectory() || parentAfter.dev !== parentOpened.dev || parentAfter.ino !== parentOpened.ino) {
      throw new Error('Extension module changed while it was being imported');
    }
    if (typeof loaded.default !== 'function') {
      throw new Error('Extension module must export a default factory function');
    }
    return loaded.default;
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await parentHandle.close().catch(() => undefined);
  }
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
      const resolved = path.resolve(this.cwd, candidate.path);
      const relative = path.relative(this.cwd, resolved);
      const withinProject = relative === ''
        || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
      const projectWithinCandidate = resolved === this.cwd || this.cwd.startsWith(`${resolved}${path.sep}`);
      if (!projectTrusted && (candidate.project || withinProject || projectWithinCandidate)) continue;
      try {
        if (await pathContainsSymbolicLink(resolved)) continue;
        const info = await lstat(resolved);
        if (info.isSymbolicLink()) continue;
        if (info.isFile() && info.nlink === 1 && info.size <= 5 * 1024 * 1024
          && this.isExtensionFile(resolved)) files.add(resolved);
        if (info.isDirectory()) {
          const index = await this.findIndex(resolved);
          if (index) files.add(index);
          for (const entry of (await readStableDirectoryEntries(resolved, 1_000)).entries) {
            const entryPath = path.join(resolved, entry.name);
            if (entry.isFile() && this.isExtensionFile(entryPath)) {
              try {
                const entryInfo = await lstat(entryPath);
                if (entryInfo.isFile() && !entryInfo.isSymbolicLink() && entryInfo.nlink === 1
                  && entryInfo.size <= 5 * 1024 * 1024) files.add(entryPath);
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
        candidates.push({ id: filePath, factory: await importExtensionFactory(filePath, nextGeneration) });
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
        if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1
          && info.size <= 5 * 1024 * 1024 && !(await pathContainsSymbolicLink(candidate))) return candidate;
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
