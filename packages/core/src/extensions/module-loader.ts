import { randomUUID } from 'node:crypto';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { findPackageJSON, registerHooks } from 'node:module';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFunction } from 'node:vm';
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
  importAttempt: string,
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

    // Keep the real entry URL for relative imports and import.meta.url, but read
    // entry source from the held descriptor. Importing /proc/self/fd/N directly is unsafe:
    // Node caches its realpath even after N is closed and reused for another module.
    // Vitest's VM loader uses the pathname with the same before/open/after checks.
    const moduleUrl = `${pathToFileURL(filePath).href}?aiharness=${importAttempt}`;
    const hooks = !RUNNING_UNDER_VITEST ? registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        return specifier === moduleUrl ? { ...resolved, url: moduleUrl, shortCircuit: true } : resolved;
      },
      load(url, context, nextLoad) {
        if (url !== moduleUrl) return nextLoad(url, context);
        const source = readFileSync(fileHandle!.fd, 'utf8');
        let format = context.format;
        // Preserve Node's .js package-type/syntax detection, including CommonJS factories.
        // Compiling an ambiguous CommonJS wrapper detects ESM-only syntax without executing it.
        // Some source loaders (e.g. tsx) label ambiguous .js as CommonJS before
        // Node's syntax detection. Only an explicit package type fixes .js format.
        const packageJson = format === 'commonjs' && filePath.endsWith('.js')
          ? findPackageJSON(pathToFileURL(filePath)) : undefined;
        // Node can return the entry path itself when there is no package scope.
        const packageType: unknown = packageJson && path.basename(packageJson) === 'package.json'
          ? JSON.parse(readFileSync(packageJson, 'utf8')).type : undefined;
        if (!format || (format === 'commonjs' && filePath.endsWith('.js')
          && packageType !== 'commonjs' && packageType !== 'module')) {
          try {
            compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname']);
            format = 'commonjs';
          } catch {
            format = 'module';
          }
        }
        if (format === 'commonjs') {
          // Node's CJS translator caches by filename, ignoring the attempt query.
          // Evaluate just this entry in an ESM envelope instead: do not delete or
          // replace any require.cache entry (even during a failed candidate).
          // Dependencies still use Node's ordinary cache and real entry location.
          return { format: 'module', source: `
            import Module, { createRequire } from 'node:module';
            const filename = ${JSON.stringify(filePath)};
            const require = createRequire(filename);
            const module = new Module(filename);
            module.filename = filename;
            module.paths = require.resolve.paths('aiharness-entry') ?? [];
            // Node's own CJS compiler retains sloppy mode, wrapper variables,
            // shebang handling and dynamic import resolution at the real filename.
            module._compile(${JSON.stringify(source)}, filename);
            module.loaded = true;
            export default module.exports;
          `, shortCircuit: true };
        }
        return { format, source, shortCircuit: true };
      },
    }) : undefined;
    let loaded: { default?: ExtensionFactory };
    try {
      loaded = await import(moduleUrl) as { default?: ExtensionFactory };
    } finally {
      hooks?.deregister();
    }

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
  // Failed candidates are still cached by ESM. Never reuse an attempted import URL.
  private importAttempt = 0;
  private readonly importIdentity = randomUUID();
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
    const importAttempt = ++this.importAttempt;
    const errors: ExtensionModuleLoadError[] = [];
    const candidates: Array<{ id: string; factory: ExtensionFactory }> = [];
    for (const filePath of await this.discover()) {
      try {
        candidates.push({ id: filePath, factory: await importExtensionFactory(filePath, `${this.importIdentity}-${importAttempt}`) });
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
    for (const name of ['index.mjs', 'index.js', 'index.cjs']) {
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
    return filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs');
  }
}
