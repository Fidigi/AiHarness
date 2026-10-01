import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type WorkspacePathKind = 'any' | 'file' | 'directory';

export interface WorkspaceDescriptor {
  id: string;
  cwd: string;
  name: string;
  trusted: boolean;
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
    readonly code: 'INVALID_PATH' | 'OUTSIDE_ALLOWED_ROOTS' | 'NOT_FOUND' | 'WRONG_KIND' | 'GIT_ERROR',
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

  async describe(cwd: string, trusted: boolean): Promise<WorkspaceDescriptor> {
    const canonical = await this.resolve(cwd, { kind: 'directory' });
    const git = await this.gitInfo(canonical);
    return {
      id: createHash('sha256').update(canonical).digest('hex').slice(0, 24),
      cwd: canonical,
      name: path.basename(canonical) || canonical,
      trusted,
      ...(git ? { git } : {}),
    };
  }

  async browse(input: string, parent = false): Promise<{ cwd: string; parent?: string; entries: DirectoryEntry[] }> {
    const requested = await this.resolve(input, { kind: 'directory' });
    const cwd = parent
      ? await this.resolve(path.dirname(requested), { kind: 'directory' })
      : requested;
    const entries = await Promise.all((await readdir(cwd, { withFileTypes: true })).map(async entry => {
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
      return { name: entry.name, path: entryPath, isDirectory, isSymbolicLink: symbolic };
    }));
    entries.sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory)
      || left.name.localeCompare(right.name));
    const parentPath = path.dirname(cwd);
    return {
      cwd,
      ...(parentPath !== cwd && this.roots.some(root => inside(root, parentPath)) ? { parent: parentPath } : {}),
      entries,
    };
  }

  async gitInfo(cwd: string): Promise<WorkspaceDescriptor['git'] | undefined> {
    const canonical = await this.resolve(cwd, { kind: 'directory' });
    try {
      const [{ stdout: rootOutput }, { stdout: branchOutput }] = await Promise.all([
        execFileAsync('git', ['-C', canonical, 'rev-parse', '--show-toplevel'], { timeout: 5_000 }),
        execFileAsync('git', ['-C', canonical, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5_000 })
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
      const { stdout } = await execFileAsync('git', ['-C', canonical, 'worktree', 'list', '--porcelain'], { timeout: 10_000 });
      const records = stdout.trim().split(/\n\s*\n/).filter(Boolean);
      const worktrees: GitWorktree[] = [];
      for (const record of records) {
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
    } catch (error) {
      throw new WorkspacePathError('GIT_ERROR', error instanceof Error ? error.message : 'Erreur Git.');
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
    if (!/^[A-Za-z0-9._\/-]+$/.test(input.branch) || input.branch.startsWith('-')) {
      throw new WorkspacePathError('INVALID_PATH', 'Nom de branche invalide.');
    }
    const args = ['-C', cwd, 'worktree', 'add'];
    if (input.createBranch) args.push('-b', input.branch, destination, input.startPoint || 'HEAD');
    else args.push(destination, input.branch);
    try {
      await execFileAsync('git', args, { timeout: 30_000 });
    } catch (error) {
      throw new WorkspacePathError('GIT_ERROR', error instanceof Error ? error.message : 'Création du worktree impossible.');
    }
  }

  async removeWorktree(cwd: string, worktreePath: string, force = false): Promise<void> {
    const canonicalCwd = await this.resolve(cwd, { kind: 'directory' });
    const target = await this.resolve(worktreePath, { kind: 'directory' });
    const known = await this.listWorktrees(canonicalCwd);
    if (!known.some(item => item.path === target)) {
      throw new WorkspacePathError('GIT_ERROR', 'Worktree inconnu pour ce dépôt.');
    }
    try {
      await execFileAsync('git', ['-C', canonicalCwd, 'worktree', 'remove', ...(force ? ['--force'] : []), target], {
        timeout: 30_000,
      });
    } catch (error) {
      throw new WorkspacePathError('GIT_ERROR', error instanceof Error ? error.message : 'Suppression du worktree impossible.');
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
