import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { filteredProcessEnvironment } from '../tools/process-execution.js';
import { openStableDirectoryHandle, readStableDirectoryEntries } from './stable-directory.js';

const execFileAsync = promisify(execFile);
const gitEnvironment = (): NodeJS.ProcessEnv => ({ ...filteredProcessEnvironment(), LC_ALL: 'C' });
export const WORKSPACE_BROWSE_ENTRY_LIMIT = 500;

export type WorkspacePathKind = 'any' | 'file' | 'directory';

export interface WorkspaceDescriptor {
  id: string;
  cwd: string;
  name: string;
  trusted: boolean;
  /** Persisted effective allow suitable for trust-requiring operations. */
  operationTrusted?: boolean;
  git?: {
    root: string;
    branch?: string;
    detached: boolean;
  };
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface GitWorktree {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked?: string;
  prunable?: string;
}

export class WorkspacePathError extends Error {
  constructor(
    readonly code: 'INVALID_PATH' | 'OUTSIDE_ALLOWED_ROOTS' | 'NOT_FOUND' | 'WRONG_KIND' | 'ALREADY_EXISTS' | 'FORCE_REQUIRED' | 'GIT_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir;
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/')) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

/** Canonical path boundary shared by workspaces, files, Git, tools and terminals. */
export class WorkspaceManager {
  private roots: string[] = [];
  private initialized = false;
  private readonly configuredRoots: string[];
  private readonly homeDir: string;
  private readonly defaultPath: string;

  constructor(options: { allowedRoots?: string[]; defaultCwd?: string; homeDir?: string } = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.defaultPath = options.defaultCwd ?? process.cwd();
    this.configuredRoots = options.allowedRoots?.length ? options.allowedRoots : [this.defaultPath];
  }

  async initialize(): Promise<void> {
    const canonical: string[] = [];
    for (const configured of this.configuredRoots) {
      const expanded = path.resolve(expandHome(configured, this.homeDir));
      try {
        const resolved = await realpath(expanded);
        if ((await stat(resolved)).isDirectory()) canonical.push(resolved);
      } catch {
        throw new WorkspacePathError('NOT_FOUND', `Racine de workspace introuvable : ${expanded}`);
      }
    }
    this.roots = [...new Set(canonical)].sort();
    this.initialized = true;
  }

  getAllowedRoots(): readonly string[] {
    this.assertInitialized();
    return this.roots;
  }

  async getDefaultCwd(): Promise<string> {
    return this.resolve(this.defaultPath, { kind: 'directory' });
  }

  async resolve(
    input: string,
    options: { base?: string; mustExist?: boolean; kind?: WorkspacePathKind } = {},
  ): Promise<string> {
    this.assertInitialized();
    if (!input || input.includes('\0')) {
      throw new WorkspacePathError('INVALID_PATH', 'Chemin invalide.');
    }
    const expanded = expandHome(input, this.homeDir);
    const base = options.base
      ? await this.resolve(options.base, { kind: 'directory' })
      : await this.canonicalConfiguredDefault();
    const absolute = path.resolve(base, expanded);
    // Reject lexical escapes before realpath/lstat so an untrusted path cannot probe
    // filesystem metadata outside the configured roots.
    if (!this.roots.some(root => inside(root, absolute))) {
      throw new WorkspacePathError('OUTSIDE_ALLOWED_ROOTS', 'Chemin hors des racines autorisées.');
    }
    const mustExist = options.mustExist ?? true;
    let canonical: string;

    try {
      canonical = await realpath(absolute);
    } catch {
      if (mustExist) throw new WorkspacePathError('NOT_FOUND', 'Chemin introuvable.');
      canonical = await this.resolveFuturePath(absolute);
    }

    if (!this.roots.some(root => inside(root, canonical))) {
      throw new WorkspacePathError('OUTSIDE_ALLOWED_ROOTS', 'Chemin hors des racines autorisées.');
    }

    if (mustExist && options.kind && options.kind !== 'any') {
      const info = await stat(canonical);
      if (options.kind === 'directory' && !info.isDirectory()) {
        throw new WorkspacePathError('WRONG_KIND', 'Le chemin doit désigner un répertoire.');
      }
      if (options.kind === 'file' && !info.isFile()) {
        throw new WorkspacePathError('WRONG_KIND', 'Le chemin doit désigner un fichier.');
      }
    }
    return canonical;
  }

  /** Resolve a file publication target without following its final path component. */
  async resolveDestination(
    input: string,
    options: { base?: string; kind?: WorkspacePathKind } = {},
  ): Promise<string> {
    this.assertInitialized();
    if (!input || input.includes('\0')) {
      throw new WorkspacePathError('INVALID_PATH', 'Chemin invalide.');
    }
    const expanded = expandHome(input, this.homeDir);
    const base = options.base
      ? await this.resolve(options.base, { kind: 'directory' })
      : await this.canonicalConfiguredDefault();
    const absolute = path.resolve(base, expanded);
    if (!this.roots.some(root => inside(root, absolute))) {
      throw new WorkspacePathError('OUTSIDE_ALLOWED_ROOTS', 'Chemin hors des racines autorisées.');
    }
    const lexicalParent = path.dirname(absolute);
    const canonicalParent = await this.resolve(lexicalParent, { kind: 'directory' });
    if (path.resolve(lexicalParent) !== canonicalParent) {
      throw new WorkspacePathError('INVALID_PATH', 'Les parents symboliques sont interdits pour cette destination.');
    }
    const name = path.basename(absolute);
    if (!name || name === '.' || name === '..') {
      throw new WorkspacePathError('INVALID_PATH', 'Destination invalide.');
    }
    const destination = path.join(canonicalParent, name);
    if (!this.roots.some(root => inside(root, destination))) {
      throw new WorkspacePathError('OUTSIDE_ALLOWED_ROOTS', 'Chemin hors des racines autorisées.');
    }
    const existing = await lstat(destination).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink()) {
      throw new WorkspacePathError('INVALID_PATH', 'La destination ne peut pas être un lien symbolique.');
    }
    if (existing && options.kind && options.kind !== 'any') {
      if (options.kind === 'file' && !existing.isFile()) {
        throw new WorkspacePathError('WRONG_KIND', 'Le chemin doit désigner un fichier.');
      }
      if (options.kind === 'directory' && !existing.isDirectory()) {
        throw new WorkspacePathError('WRONG_KIND', 'Le chemin doit désigner un répertoire.');
      }
    }
    return destination;
  }

  /** Resolve an existing ordinary file without accepting symbolic or hard links. */
  async resolveStableFile(input: string, options: { base?: string } = {}): Promise<string> {
    const destination = await this.resolveDestination(input, { base: options.base, kind: 'file' });
    const info = await lstat(destination).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new WorkspacePathError('NOT_FOUND', 'Chemin introuvable.');
      }
      throw error;
    });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new WorkspacePathError('INVALID_PATH', 'Le fichier doit être un fichier ordinaire sans lien.');
    }
    const canonical = await realpath(destination);
    if (canonical !== destination || !this.roots.some(root => inside(root, canonical))) {
      throw new WorkspacePathError('INVALID_PATH', 'Le fichier doit rester dans une racine autorisée.');
    }
    return destination;
  }

  async describe(cwd: string, trusted: boolean): Promise<WorkspaceDescriptor> {
    const canonical = await this.resolve(cwd, { kind: 'directory' });
    const git = trusted ? await this.gitInfo(canonical) : undefined;
    return {
      id: createHash('sha256').update(canonical).digest('hex').slice(0, 24),
      cwd: canonical,
      name: path.basename(canonical) || canonical,
      trusted,
      ...(git ? { git } : {}),
    };
  }

  async browse(input: string, parent = false): Promise<{
    cwd: string;
    parent?: string;
    entries: DirectoryEntry[];
    truncated: boolean;
  }> {
    const requested = await this.resolve(input, { kind: 'directory' });
    const cwd = parent
      ? await this.resolve(path.dirname(requested), { kind: 'directory' })
      : requested;
    const entries: DirectoryEntry[] = [];
    const listing = await readStableDirectoryEntries(cwd, WORKSPACE_BROWSE_ENTRY_LIMIT);
    for (const entry of listing.entries) {
      const entryPath = path.join(cwd, entry.name);
      const symbolic = entry.isSymbolicLink();
      let isDirectory = entry.isDirectory();
      if (symbolic) {
        try {
          const target = await realpath(entryPath);
          isDirectory = this.roots.some(root => inside(root, target)) && (await stat(target)).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      entries.push({ name: entry.name, path: entryPath, isDirectory, isSymbolicLink: symbolic });
    }
    entries.sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory)
      || left.name.localeCompare(right.name));
    const parentPath = path.dirname(cwd);
    return {
      cwd,
      ...(parentPath !== cwd && this.roots.some(root => inside(root, parentPath)) ? { parent: parentPath } : {}),
      entries,
      truncated: listing.truncated,
    };
  }

  /** Create exactly one direct child under a canonical allowed directory. */
  async createDirectory(parent: string, name: string): Promise<string> {
    const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
    if (!name || name !== name.trim() || name === '.' || name === '..' || name.endsWith('.')
      || reservedWindowsName || Buffer.byteLength(name, 'utf8') > 255
      || /[\\/<>:"|?*\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(name)) {
      throw new WorkspacePathError('INVALID_PATH', 'Nom de répertoire invalide.');
    }
    const canonicalParent = await this.resolve(parent, { kind: 'directory' });
    const parentHandle = await openStableDirectoryHandle(canonicalParent).catch(() => {
      throw new WorkspacePathError('INVALID_PATH', 'Le répertoire parent est instable.');
    });
    try {
      const parentOpened = await parentHandle.stat();
      const parentBefore = await lstat(canonicalParent);
      if (!parentOpened.isDirectory() || !parentBefore.isDirectory() || parentBefore.isSymbolicLink()
        || parentOpened.dev !== parentBefore.dev || parentOpened.ino !== parentBefore.ino) {
        throw new WorkspacePathError('INVALID_PATH', 'Le répertoire parent est instable.');
      }
      const anchoredParent = process.platform === 'linux'
        ? `/proc/self/fd/${parentHandle.fd}` : canonicalParent;
      const anchoredDestination = path.join(anchoredParent, name);
      const existing = await lstat(anchoredDestination).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (existing) {
        throw new WorkspacePathError('ALREADY_EXISTS', 'Un fichier ou répertoire porte déjà ce nom.');
      }
      try { await mkdir(anchoredDestination, { mode: 0o755 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new WorkspacePathError('ALREADY_EXISTS', 'Un fichier ou répertoire porte déjà ce nom.');
        }
        throw new WorkspacePathError('INVALID_PATH', 'Création du répertoire impossible.');
      }
      const [created, parentAfter, parentPathAfter] = await Promise.all([
        lstat(anchoredDestination), parentHandle.stat(), lstat(canonicalParent),
      ]);
      if (!created.isDirectory() || created.isSymbolicLink()
        || parentAfter.dev !== parentOpened.dev || parentAfter.ino !== parentOpened.ino
        || !parentPathAfter.isDirectory() || parentPathAfter.isSymbolicLink()
        || parentPathAfter.dev !== parentOpened.dev || parentPathAfter.ino !== parentOpened.ino) {
        throw new WorkspacePathError('INVALID_PATH', 'Le répertoire créé est instable.');
      }
      await parentHandle.sync().catch(() => undefined);
      return path.join(canonicalParent, name);
    } finally {
      await parentHandle.close().catch(() => undefined);
    }
  }

  /** Create missing directory components without traversing symbolic links. */
  async ensureDirectory(input: string, options: { base?: string } = {}): Promise<string> {
    this.assertInitialized();
    if (!input || input.includes('\0')) throw new WorkspacePathError('INVALID_PATH', 'Chemin invalide.');
    const base = options.base
      ? await this.resolve(options.base, { kind: 'directory' })
      : await this.canonicalConfiguredDefault();
    const absolute = path.resolve(base, expandHome(input, this.homeDir));
    if (!inside(base, absolute) || !this.roots.some(root => inside(root, absolute))) {
      throw new WorkspacePathError('OUTSIDE_ALLOWED_ROOTS', 'Chemin hors des racines autorisées.');
    }
    const relative = path.relative(base, absolute);
    if (!relative) return base;
    let current = base;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      const candidate = path.join(current, component);
      const existing = await lstat(candidate).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (!existing) {
        current = await this.createDirectory(current, component);
        continue;
      }
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new WorkspacePathError('INVALID_PATH', 'Chemin hors des parents ordinaires autorisés.');
      }
      const resolved = await this.resolve(candidate, { kind: 'directory' });
      if (resolved !== candidate) {
        throw new WorkspacePathError('INVALID_PATH', 'Les parents symboliques sont interdits.');
      }
      current = resolved;
    }
    return current;
  }

  async gitInfo(cwd: string): Promise<WorkspaceDescriptor['git'] | undefined> {
    const canonical = await this.resolve(cwd, { kind: 'directory' });
    try {
      const [{ stdout: rootOutput }, { stdout: branchOutput }] = await Promise.all([
        execFileAsync('git', ['-C', canonical, 'rev-parse', '--show-toplevel'], {
          timeout: 5_000, env: gitEnvironment(),
        }),
        execFileAsync('git', ['-C', canonical, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
          timeout: 5_000, env: gitEnvironment(),
        })
          .catch(() => ({ stdout: '' })),
      ]);
      const root = await this.resolve(rootOutput.trim(), { kind: 'directory' });
      const branch = branchOutput.trim() || undefined;
      return { root, branch, detached: !branch };
    } catch {
      return undefined;
    }
  }

  async listWorktrees(cwd: string): Promise<GitWorktree[]> {
    const canonical = await this.resolve(cwd, { kind: 'directory' });
    try {
      const { stdout } = await execFileAsync('git', ['-C', canonical, 'worktree', 'list', '--porcelain'], {
        timeout: 10_000, env: gitEnvironment(),
      });
      const records = stdout.trim().split(/\n\s*\n/).filter(Boolean);
      const worktrees: GitWorktree[] = [];
      for (const record of records.slice(0, 500)) {
        const values = new Map<string, string>();
        for (const line of record.split('\n')) {
          const separator = line.indexOf(' ');
          values.set(separator < 0 ? line : line.slice(0, separator), separator < 0 ? '' : line.slice(separator + 1));
        }
        const worktreePath = values.get('worktree');
        if (!worktreePath) continue;
        let safePath: string;
        try {
          safePath = await this.resolve(worktreePath, { kind: 'directory' });
        } catch {
          continue;
        }
        worktrees.push({
          path: safePath,
          head: values.get('HEAD'),
          branch: values.get('branch')?.replace(/^refs\/heads\//, ''),
          bare: values.has('bare'),
          detached: values.has('detached'),
          locked: values.get('locked'),
          prunable: values.get('prunable'),
        });
      }
      return worktrees;
    } catch {
      throw new WorkspacePathError('GIT_ERROR', 'Liste des worktrees indisponible.');
    }
  }

  async createWorktree(input: {
    cwd: string;
    path: string;
    branch: string;
    createBranch?: boolean;
    startPoint?: string;
  }): Promise<void> {
    const cwd = await this.resolve(input.cwd, { kind: 'directory' });
    const destination = await this.resolve(input.path, { mustExist: false });
    if (Buffer.byteLength(input.branch) > 255 || !/^[A-Za-z0-9._/-]+$/.test(input.branch)
      || input.branch.startsWith('-')) {
      throw new WorkspacePathError('INVALID_PATH', 'Nom de branche invalide.');
    }
    const startPoint = input.startPoint || 'HEAD';
    if (Buffer.byteLength(startPoint) > 255 || !/^[A-Za-z0-9._/-]+$/.test(startPoint)
      || startPoint.startsWith('-')) {
      throw new WorkspacePathError('INVALID_PATH', 'Point de départ Git invalide.');
    }
    const args = ['-C', cwd, 'worktree', 'add'];
    if (input.createBranch) args.push('-b', input.branch, destination, startPoint);
    else args.push(destination, input.branch);
    try {
      await execFileAsync('git', args, { timeout: 30_000, env: gitEnvironment() });
    } catch {
      throw new WorkspacePathError('GIT_ERROR', 'Création du worktree impossible.');
    }
  }

  async removeWorktree(cwd: string, worktreePath: string, force = false): Promise<void> {
    const canonicalCwd = await this.resolve(cwd, { kind: 'directory' });
    const target = await this.resolve(worktreePath, { kind: 'directory' });
    const known = await this.listWorktrees(canonicalCwd);
    if (!known.some(item => item.path === target)) {
      throw new WorkspacePathError('GIT_ERROR', 'Worktree inconnu pour ce dépôt.');
    }
    if (!force) {
      try {
        const { stdout } = await execFileAsync('git', ['-C', target, 'status', '--porcelain', '--untracked-files=normal'], {
          timeout: 10_000,
          env: gitEnvironment(),
        });
        if (stdout.trim()) {
          throw new WorkspacePathError('FORCE_REQUIRED', 'Le worktree contient des modifications locales.');
        }
      } catch (error) {
        if (error instanceof WorkspacePathError) throw error;
        throw new WorkspacePathError('GIT_ERROR', 'État du worktree indisponible.');
      }
    }
    try {
      await execFileAsync('git', ['-C', canonicalCwd, 'worktree', 'remove', ...(force ? ['--force'] : []), target], {
        timeout: 30_000,
        env: gitEnvironment(),
      });
    } catch (error) {
      const details = error as Error & { stderr?: string };
      if (!force && /force|modified|untracked|dirty/i.test(`${details.message}\n${details.stderr ?? ''}`)) {
        throw new WorkspacePathError('FORCE_REQUIRED', 'La suppression exige une confirmation forcée.');
      }
      throw new WorkspacePathError('GIT_ERROR', 'Suppression du worktree impossible.');
    }
  }

  private async resolveFuturePath(absolute: string): Promise<string> {
    let ancestor = absolute;
    const suffix: string[] = [];
    while (true) {
      try {
        await lstat(ancestor);
        break;
      } catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new WorkspacePathError('NOT_FOUND', 'Parent du chemin introuvable.');
        suffix.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    }
    const canonicalAncestor = await realpath(ancestor);
    return path.resolve(canonicalAncestor, ...suffix);
  }

  private async canonicalConfiguredDefault(): Promise<string> {
    const absolute = path.resolve(expandHome(this.defaultPath, this.homeDir));
    try {
      return await realpath(absolute);
    } catch {
      return this.roots[0];
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('WorkspaceManager.initialize() must be awaited before use.');
  }
}
