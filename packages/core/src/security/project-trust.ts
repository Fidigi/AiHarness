import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTEXT_FILE_NAMES, resolveAgentDirectory } from '../prompts/instruction-context.js';

const TRUST_FILE_VERSION = 2 as const;
const MAX_TRUST_FILE_BYTES = 256 * 1024;
const MAX_TRUST_DECISIONS = 10_000;
const MAX_TRUST_PATH_BYTES = 4_096;
const MAX_RESOURCE_RECORDS = 128;
const MAX_ANCESTOR_DIRECTORIES = 64;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;
const STALE_LOCK_MS = 30_000;
const TRUST_LOCK_HEARTBEAT_MS = 5_000;
export const FRESH_PROJECT_SCAN_DEPTH = 4;
export const FRESH_PROJECT_SCAN_MAX_DIRECTORIES = 2_000;
const FRESH_PROJECT_SCAN_SKIP = new Set(['.agents', '.ai-harness', '.git', 'node_modules']);
const MAX_FRESH_PROJECT_PATHS = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const PROJECT_CONFIG_RESOURCES = [
  ['settings.json', 'file'],
  ['mcp.json', 'file'],
  ['extensions', 'directory'],
  ['skills', 'directory'],
  ['prompts', 'directory'],
  ['themes', 'directory'],
  ['SYSTEM.md', 'file'],
  ['APPEND_SYSTEM.md', 'file'],
] as const;

interface TrustFileV2 {
  version: typeof TRUST_FILE_VERSION;
  decisions: Record<string, boolean>;
}

export type ProjectTrustDecision = boolean | null;
export type ProjectTrustDefault = 'ask' | 'always' | 'never';
export type ProjectTrustPromptChoice =
  | 'trust'
  | 'trust-parent'
  | 'trust-session'
  | 'refuse'
  | 'refuse-session';

export interface ProjectTrustDecisionEntry {
  path: string;
  decision: boolean;
}

export interface ProjectTrustUpdate {
  path: string;
  decision: ProjectTrustDecision;
}

export interface ProjectTrustResource {
  path: string;
  relativePath: string;
  kind: 'file' | 'directory' | 'other' | 'unreadable';
  expectedKind: 'file' | 'directory';
  symbolicLink: boolean;
  safeKind: boolean;
  source: 'project-config' | 'project-skill' | 'project-prompt' | 'context';
  error?: string;
}

export interface ProjectTrustInspectionOptions {
  homeDir?: string;
  includeContextFiles?: boolean;
}

export interface ProjectTrustInspection {
  cwd: string;
  requiresTrust: boolean;
  resources: ProjectTrustResource[];
  truncated: boolean;
}

export interface ProjectTrustStatus extends ProjectTrustInspection {
  trusted: boolean;
  decision: ProjectTrustDecision;
  decisionPath?: string;
  inherited: boolean;
  decisionError?: string;
}

export interface ProjectTrustPromptRequest {
  status: ProjectTrustStatus;
  parentPath?: string;
}

export type FreshProjectTrustBlockReason =
  | 'folder-not-fresh'
  | 'trust-too-broad'
  | 'trust-unavailable';

export type FreshProjectTrustBreadthKind =
  | 'contains-home'
  | 'contains-known-folder'
  | 'contains-project'
  | 'contains-protected-path'
  | 'home'
  | 'root'
  | 'scan-limit'
  | 'scan-unreadable';

export interface FreshProjectTrustBreadth {
  kind: FreshProjectTrustBreadthKind;
  path: string;
}

export type FreshProjectTrustStatus =
  | { allowed: true }
  | {
    allowed: false;
    reason: FreshProjectTrustBlockReason;
    breadth?: FreshProjectTrustBreadth;
  };

export interface FreshProjectTrustOptions {
  /** Other workspace/session roots that must not silently inherit this allow. */
  knownFolders?: Iterable<string>;
  /** Data, credential, or runtime roots that must never inherit this allow. */
  protectedPaths?: Iterable<string>;
  homeDir?: string;
}

export type FreshProjectTrustWriteResult<T> =
  | { ok: true; value: T }
  | {
    ok: false;
    reason: FreshProjectTrustBlockReason;
    breadth?: FreshProjectTrustBreadth;
  }
  | {
    ok: false;
    reason: 'write-failed';
    writeError: unknown;
    rollbackError?: unknown;
    trustKept: boolean;
  };

export interface ResolveProjectTrustOptions {
  cwd: string;
  trustManager: ProjectTrustManager;
  override?: boolean;
  defaultProjectTrust?: ProjectTrustDefault;
  includeContextFiles?: boolean;
  prompt?: (request: ProjectTrustPromptRequest) => Promise<ProjectTrustPromptChoice | undefined>;
}

export interface ResolvedProjectTrust extends ProjectTrustStatus {
  source: 'override' | 'saved' | 'not-required' | 'default' | 'prompt' | 'fallback';
  /** Body-loading gate; false for an implicitly safe empty project to close resource-appearance races. */
  resourceTrusted: boolean;
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function insideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeStoredPath(value: string): string {
  if (!path.isAbsolute(value) || Buffer.byteLength(value, 'utf8') > MAX_TRUST_PATH_BYTES
    || CONTROL_CHARACTERS.test(value)) {
    throw new Error('Trust decision paths must be bounded absolute paths.');
  }
  return path.resolve(value);
}

async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function nearestDecision(
  decisions: ReadonlyMap<string, boolean>,
  canonicalCwd: string,
): ProjectTrustDecisionEntry | undefined {
  let current = canonicalCwd;
  while (true) {
    const decision = decisions.get(current);
    if (decision !== undefined) return { path: current, decision };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resourceKind(info: Awaited<ReturnType<typeof lstat>>): ProjectTrustResource['kind'] {
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'directory';
  return 'other';
}

async function inspectCandidate(
  absolutePath: string,
  cwd: string,
  expectedKind: ProjectTrustResource['expectedKind'],
  source: ProjectTrustResource['source'],
): Promise<ProjectTrustResource | undefined> {
  try {
    const info = await lstat(absolutePath);
    const kind = resourceKind(info);
    return {
      path: absolutePath,
      relativePath: insideOrEqual(cwd, absolutePath)
        ? path.relative(cwd, absolutePath) || '.'
        : absolutePath,
      kind,
      expectedKind,
      symbolicLink: info.isSymbolicLink(),
      safeKind: !info.isSymbolicLink() && kind === expectedKind,
      source,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return {
      path: absolutePath,
      relativePath: insideOrEqual(cwd, absolutePath)
        ? path.relative(cwd, absolutePath) || '.'
        : absolutePath,
      kind: 'unreadable',
      expectedKind,
      symbolicLink: false,
      safeKind: false,
      source,
      error: cleanError(error),
    };
  }
}

function ancestorDirectories(cwd: string): { directories: string[]; truncated: boolean } {
  const directories: string[] = [];
  let current = cwd;
  while (directories.length < MAX_ANCESTOR_DIRECTORIES) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) return { directories, truncated: false };
    current = parent;
  }
  return { directories, truncated: true };
}

/**
 * Inspect only path metadata for project-controlled resources. It never reads a
 * resource body, follows a resource link, executes code, or creates files.
 */
export async function inspectProjectTrustResources(
  cwdInput: string,
  options: ProjectTrustInspectionOptions = {},
): Promise<ProjectTrustInspection> {
  const cwd = await canonicalPath(cwdInput);
  const resources: ProjectTrustResource[] = [];
  let truncated = false;
  const add = (resource: ProjectTrustResource | undefined): void => {
    if (!resource) return;
    if (resources.length >= MAX_RESOURCE_RECORDS) {
      truncated = true;
      return;
    }
    resources.push(resource);
  };

  const configDirectory = path.join(cwd, '.ai-harness');
  const configRoot = await inspectCandidate(configDirectory, cwd, 'directory', 'project-config');
  if (configRoot?.symbolicLink || (configRoot && configRoot.kind !== 'directory')) {
    add(configRoot);
  } else {
    for (const [name, expectedKind] of PROJECT_CONFIG_RESOURCES) {
      add(await inspectCandidate(path.join(configDirectory, name), cwd, expectedKind, 'project-config'));
    }
  }

  const home = await canonicalPath(options.homeDir ?? os.homedir());
  const projectSkillPath = path.join(cwd, '.agents', 'skills');
  if (projectSkillPath !== path.join(home, '.agents', 'skills')) {
    add(await inspectCandidate(projectSkillPath, cwd, 'directory', 'project-skill'));
  }
  add(await inspectCandidate(path.join(cwd, 'prompts'), cwd, 'directory', 'project-prompt'));

  if (options.includeContextFiles !== false) {
    const ancestors = ancestorDirectories(cwd);
    truncated = truncated || ancestors.truncated;
    for (const directory of ancestors.directories) {
      for (const name of CONTEXT_FILE_NAMES) {
        const candidate = await inspectCandidate(path.join(directory, name), cwd, 'file', 'context');
        if (candidate) {
          add(candidate);
          break;
        }
      }
    }
  }

  resources.sort((left, right) => left.path.localeCompare(right.path));
  return {
    cwd,
    requiresTrust: resources.length > 0 || truncated,
    resources,
    truncated,
  };
}

async function existingCanonicalDirectory(value: string): Promise<string> {
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_TRUST_PATH_BYTES
    || CONTROL_CHARACTERS.test(value)) {
    throw new Error('Fresh project trust requires a bounded directory path.');
  }
  const canonical = await realpath(path.resolve(value));
  const info = await lstat(canonical);
  if (!info.isDirectory()) throw new Error('Fresh project trust requires an existing directory.');
  return canonical;
}

async function somethingAt(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Project-owned metadata in one directory that a parent allow would cover. */
async function hasOwnTrustRelevantEntries(directory: string): Promise<boolean> {
  const configDirectory = path.join(directory, '.ai-harness');
  try {
    const info = await lstat(configDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) return true;
    for (const [name] of PROJECT_CONFIG_RESOURCES) {
      if (await somethingAt(path.join(configDirectory, name))) return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
  }

  if (await somethingAt(path.join(directory, '.agents', 'skills'))
    || await somethingAt(path.join(directory, 'prompts'))) return true;
  for (const name of CONTEXT_FILE_NAMES) {
    if (await somethingAt(path.join(directory, name))) return true;
  }
  return false;
}

function boundedPathValues(values: Iterable<string> | undefined): string[] {
  if (!values) return [];
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value
      || Buffer.byteLength(value, 'utf8') > MAX_TRUST_PATH_BYTES
      || CONTROL_CHARACTERS.test(value)) {
      throw new Error('Fresh project trust paths must be bounded strings.');
    }
    output.push(value);
    if (output.length > MAX_FRESH_PROJECT_PATHS) {
      throw new Error('Fresh project trust has too many protected paths.');
    }
  }
  return output;
}

async function boundedCanonicalPaths(values: Iterable<string> | undefined): Promise<string[]> {
  const output: string[] = [];
  for (const value of boundedPathValues(values)) output.push(await canonicalPath(value));
  return [...new Set(output)];
}

interface FreshScanIdentity {
  dev: number;
  ino: number;
  kind: 'directory' | 'file';
  mtimeMs: number;
  ctimeMs: number;
}

interface FreshScanDirectory {
  path: string;
  depth: number;
  identity: FreshScanIdentity;
}

function freshScanIdentity(info: Awaited<ReturnType<typeof lstat>>): FreshScanIdentity | undefined {
  if (info.isSymbolicLink()) return undefined;
  const kind = info.isDirectory() ? 'directory' : (info.isFile() ? 'file' : undefined);
  return kind ? {
    dev: Number(info.dev),
    ino: Number(info.ino),
    kind,
    mtimeMs: Number(info.mtimeMs),
    ctimeMs: Number(info.ctimeMs),
  } : undefined;
}

function sameFreshScanIdentity(
  info: Awaited<ReturnType<typeof lstat>>,
  expected: FreshScanIdentity,
): boolean {
  const current = freshScanIdentity(info);
  return Boolean(current
    && current.dev === expected.dev
    && current.ino === expected.ino
    && current.kind === expected.kind
    && current.mtimeMs === expected.mtimeMs
    && current.ctimeMs === expected.ctimeMs);
}

async function findNestedTrustProject(
  cwd: string,
  decisions: ReadonlyMap<string, boolean>,
): Promise<FreshProjectTrustBreadth | undefined> {
  const rootInfo = await lstat(cwd).catch(() => undefined);
  const rootIdentity = rootInfo && freshScanIdentity(rootInfo);
  if (!rootInfo || !rootIdentity || rootIdentity.kind !== 'directory') {
    return { kind: 'scan-unreadable', path: cwd };
  }

  let directoriesRead = 0;
  let pathsInspected = 0;
  const observed = new Map<string, FreshScanIdentity>([[cwd, rootIdentity]]);
  let level: FreshScanDirectory[] = [{ path: cwd, depth: 0, identity: rootIdentity }];
  while (level.length > 0) {
    const next: FreshScanDirectory[] = [];
    for (const candidate of level) {
      const before = await lstat(candidate.path).catch(() => undefined);
      if (!before || !sameFreshScanIdentity(before, candidate.identity)) {
        return { kind: 'scan-unreadable', path: candidate.path };
      }
      const protectingDecision = candidate.depth > 0
        ? nearestDecision(decisions, candidate.path)
        : undefined;
      if (protectingDecision && protectingDecision.path !== cwd) continue;
      if (candidate.depth > 0 && await hasOwnTrustRelevantEntries(candidate.path)) {
        return { kind: 'contains-project', path: candidate.path };
      }
      if (directoriesRead >= FRESH_PROJECT_SCAN_MAX_DIRECTORIES) {
        return { kind: 'scan-limit', path: cwd };
      }
      directoriesRead++;

      try {
        const directory = await opendir(candidate.path);
        for await (const entry of directory) {
          pathsInspected++;
          if (pathsInspected > MAX_FRESH_PROJECT_PATHS) {
            return { kind: 'scan-limit', path: cwd };
          }
          const entryPath = path.join(candidate.path, entry.name);
          const info = await lstat(entryPath).catch(() => undefined);
          const identity = info && freshScanIdentity(info);
          if (!info || !identity) return { kind: 'scan-unreadable', path: entryPath };
          observed.set(entryPath, identity);
          if (identity.kind !== 'directory' || FRESH_PROJECT_SCAN_SKIP.has(entry.name)) continue;
          if (candidate.depth >= FRESH_PROJECT_SCAN_DEPTH) {
            return { kind: 'scan-limit', path: entryPath };
          }
          next.push({ path: entryPath, depth: candidate.depth + 1, identity });
        }
      } catch {
        return { kind: 'scan-unreadable', path: candidate.path };
      }

      const after = await lstat(candidate.path).catch(() => undefined);
      if (!after || !sameFreshScanIdentity(after, candidate.identity)) {
        return { kind: 'scan-unreadable', path: candidate.path };
      }
    }
    level = next;
  }

  for (const [observedPath, identity] of observed) {
    const current = await lstat(observedPath).catch(() => undefined);
    if (!current || !sameFreshScanIdentity(current, identity)) {
      return { kind: 'scan-unreadable', path: observedPath };
    }
  }
  return undefined;
}

async function freshProjectTrustBreadth(
  cwd: string,
  trustFile: string,
  options: FreshProjectTrustOptions,
  decisions: ReadonlyMap<string, boolean>,
): Promise<FreshProjectTrustBreadth | undefined> {
  if (path.dirname(cwd) === cwd) return { kind: 'root', path: cwd };
  const home = await canonicalPath(options.homeDir ?? os.homedir());
  if (cwd === home) return { kind: 'home', path: cwd };
  if (insideOrEqual(cwd, home)) return { kind: 'contains-home', path: home };

  const protectedPaths = await boundedCanonicalPaths([
    path.dirname(trustFile),
    ...await boundedCanonicalPaths(options.protectedPaths),
  ]);
  for (const protectedPath of protectedPaths) {
    if (insideOrEqual(cwd, protectedPath)) {
      return { kind: 'contains-protected-path', path: protectedPath };
    }
  }
  for (const knownFolder of await boundedCanonicalPaths(options.knownFolders)) {
    if (knownFolder !== cwd && insideOrEqual(cwd, knownFolder)) {
      return { kind: 'contains-known-folder', path: knownFolder };
    }
  }
  return findNestedTrustProject(cwd, decisions);
}

async function readBoundedTrustFile(filePath: string): Promise<unknown | undefined> {
  let before;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Trust store must be a regular file and cannot be a symbolic link.');
  }
  if (before.size > MAX_TRUST_FILE_BYTES) {
    throw new Error(`Trust store exceeds the ${MAX_TRUST_FILE_BYTES} byte limit.`);
  }

  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Trust store changed while it was being opened.');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = MAX_TRUST_FILE_BYTES + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_TRUST_FILE_BYTES) {
        throw new Error(`Trust store exceeds the ${MAX_TRUST_FILE_BYTES} byte limit.`);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('Trust store changed while it was being read.');
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.includes(0)) throw new Error('Trust store must be UTF-8 JSON.');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '');
    } catch {
      throw new Error('Trust store is not valid UTF-8.');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('Trust store is not valid JSON.');
    }
  } finally {
    await handle.close();
  }
}

function parseTrustFile(value: unknown): Map<string, boolean> {
  if (value === undefined) return new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Trust store must contain a JSON object.');
  }

  const object = value as Record<string, unknown>;
  const entries: Array<[string, boolean]> = [];
  if (object.version === TRUST_FILE_VERSION) {
    if (!object.decisions || typeof object.decisions !== 'object' || Array.isArray(object.decisions)) {
      throw new Error('Trust store decisions must be an object.');
    }
    const rawEntries = Object.entries(object.decisions as Record<string, unknown>);
    if (rawEntries.length > MAX_TRUST_DECISIONS) throw new Error('Trust store contains too many decisions.');
    for (const [decisionPath, decision] of rawEntries) {
      if (typeof decision !== 'boolean') throw new Error('Trust store decisions must be boolean.');
      entries.push([normalizeStoredPath(decisionPath), decision]);
    }
  } else if ((object.version === 1 || object.version === undefined) && Array.isArray(object.trustedProjects)) {
    const projects = object.trustedProjects;
    if (!Array.isArray(projects) || projects.length > MAX_TRUST_DECISIONS) {
      throw new Error('Legacy trust store has an invalid trustedProjects list.');
    }
    for (const project of projects) {
      if (typeof project !== 'string') throw new Error('Legacy trust paths must be strings.');
      entries.push([normalizeStoredPath(project), true]);
    }
  } else {
    throw new Error('Unsupported trust store version.');
  }
  return new Map(entries);
}

async function loadTrustDecisions(filePath: string): Promise<Map<string, boolean>> {
  return parseTrustFile(await readBoundedTrustFile(filePath));
}

async function persistTrustDecisions(filePath: string, decisions: ReadonlyMap<string, boolean>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const sorted = Object.fromEntries([...decisions.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const value: TrustFileV2 = { version: TRUST_FILE_VERSION, decisions: sorted };
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > MAX_TRUST_FILE_BYTES) {
    throw new Error(`Trust store exceeds the ${MAX_TRUST_FILE_BYTES} byte limit.`);
  }

  const handle = await open(temporary, 'wx', 0o600);
  let closed = false;
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporary, filePath);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function acquireTrustLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      const owned = await handle.stat().catch(async error => {
        await handle.close().catch(() => undefined);
        throw error;
      });
      const heartbeat = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => undefined);
      }, TRUST_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        await handle.close().catch(() => undefined);
        try {
          const current = await lstat(lockPath);
          if (current.dev === owned.dev && current.ino === owned.ino) {
            await rm(lockPath, { force: true });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const info = await lstat(lockPath);
        if (!info.isSymbolicLink() && info.isFile() && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw Object.assign(new Error('Trust store is busy.'), { code: 'TRUST_STORE_BUSY' });
}

/** Persistent canonical project decisions shared by CLI and Web runtimes. */
export class ProjectTrustManager {
  private readonly filePath: string;
  private decisions = new Map<string, boolean>();
  private decisionError: string | undefined;
  private readSequence = 0;
  private appliedSequence = 0;
  private mutation = Promise.resolve();

  constructor(filePath = path.join(resolveAgentDirectory(), 'trust.json')) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    await this.refresh();
  }

  /** Refresh on every asynchronous decision read so another CLI/Web process is observed. */
  async refresh(): Promise<void> {
    await this.readFresh();
  }

  async getDecision(projectPath: string): Promise<ProjectTrustDecisionEntry | undefined> {
    const normalized = await canonicalPath(projectPath);
    const snapshot = await this.readFresh();
    return nearestDecision(snapshot.decisions, normalized);
  }

  getDecisionSync(projectPath: string): ProjectTrustDecisionEntry | undefined {
    return nearestDecision(this.decisions, path.resolve(projectPath));
  }

  /** Resource-sensitive status: a decision-free empty project is safe, but no allow is persisted. */
  async getStatus(
    projectPath: string,
    options: Pick<ProjectTrustInspectionOptions, 'includeContextFiles'> = {},
  ): Promise<ProjectTrustStatus> {
    const inspection = await inspectProjectTrustResources(projectPath, options);
    const snapshot = await this.readFresh();
    const entry = nearestDecision(snapshot.decisions, inspection.cwd);
    const trusted = snapshot.decisionError
      ? false
      : entry?.decision ?? !inspection.requiresTrust;
    return {
      ...inspection,
      trusted,
      decision: entry?.decision ?? null,
      ...(entry ? { decisionPath: entry.path } : {}),
      inherited: Boolean(entry && entry.path !== inspection.cwd),
      ...(snapshot.decisionError ? { decisionError: snapshot.decisionError } : {}),
    };
  }

  /**
   * Whether an exact allow can be created safely as part of one first project
   * write. This is stricter than ordinary trust: the folder must have no
   * trust-requiring resource or effective decision, and the allow must not
   * silently reach a broad/sensitive/nested folder.
   */
  async getFreshProjectTrustStatus(
    projectPath: string,
    options: FreshProjectTrustOptions = {},
  ): Promise<FreshProjectTrustStatus> {
    try {
      const cwd = await existingCanonicalDirectory(projectPath);
      const inspection = await inspectProjectTrustResources(cwd);
      const snapshot = await this.readFresh();
      if (snapshot.decisionError) return { allowed: false, reason: 'trust-unavailable' };
      if (inspection.requiresTrust || nearestDecision(snapshot.decisions, cwd)) {
        return { allowed: false, reason: 'folder-not-fresh' };
      }
      const breadth = await freshProjectTrustBreadth(cwd, this.filePath, options, snapshot.decisions);
      if (breadth) return { allowed: false, reason: 'trust-too-broad', breadth };
      const verifiedInspection = await inspectProjectTrustResources(cwd);
      return verifiedInspection.requiresTrust
        ? { allowed: false, reason: 'folder-not-fresh' }
        : { allowed: true };
    } catch {
      return { allowed: false, reason: 'trust-unavailable' };
    }
  }

  /** Return the effective saved allow; use resolveProjectTrust for resource-sensitive process policy. */
  async isTrusted(projectPath: string): Promise<boolean> {
    return (await this.getDecision(projectPath))?.decision === true;
  }

  /** Only use after an async status/read for this canonical path. */
  isTrustedSync(projectPath: string): boolean {
    if (this.decisionError) return false;
    const normalized = path.resolve(projectPath);
    return nearestDecision(this.decisions, normalized)?.decision === true;
  }

  async trust(projectPath: string): Promise<string> {
    return this.setDecision(projectPath, true);
  }

  async refuse(projectPath: string): Promise<string> {
    return this.setDecision(projectPath, false);
  }

  /** Backward-compatible revocation now records an explicit refusal. */
  async untrust(projectPath: string): Promise<string> {
    return this.refuse(projectPath);
  }

  async forget(projectPath: string): Promise<string> {
    return this.setDecision(projectPath, null);
  }

  async setDecision(projectPath: string, decision: ProjectTrustDecision): Promise<string> {
    const normalized = await canonicalPath(projectPath);
    await this.setMany([{ path: normalized, decision }]);
    return normalized;
  }

  async setMany(updates: readonly ProjectTrustUpdate[]): Promise<void> {
    if (updates.length > MAX_TRUST_DECISIONS) throw new Error('Too many trust decisions in one update.');
    const normalizedUpdates: ProjectTrustUpdate[] = [];
    for (const update of updates) {
      if (update.decision !== null && typeof update.decision !== 'boolean') {
        throw new Error('Trust decisions must be true, false, or null.');
      }
      const canonical = await canonicalPath(update.path);
      normalizedUpdates.push({ path: normalizeStoredPath(canonical), decision: update.decision });
    }
    await this.queued(async () => {
      const release = await acquireTrustLock(this.filePath);
      try {
        const next = await loadTrustDecisions(this.filePath);
        for (const update of normalizedUpdates) {
          if (update.decision === null) next.delete(update.path);
          else next.set(update.path, update.decision);
        }
        if (next.size > MAX_TRUST_DECISIONS) throw new Error('Trust store contains too many decisions.');
        await persistTrustDecisions(this.filePath, next);
        this.applySnapshot(next);
      } finally {
        await release();
      }
    });
  }

  /**
   * Persist an exact allow, run one write while the trust-store lock is held,
   * and remove only that allow if the write fails. Cooperative CLI/Web
   * processes serialize on the same inter-process lock; folder identity,
   * resources, decisions, breadth, and nested projects are rechecked after
   * waiting for it. The operation receives a guard for a second check after
   * acquiring its own write lock.
   */
  async trustFreshProjectAndRun<T>(
    projectPath: string,
    operation: (revalidate: () => Promise<FreshProjectTrustStatus>) => Promise<T> | T,
    options: FreshProjectTrustOptions = {},
  ): Promise<FreshProjectTrustWriteResult<T>> {
    let cwd: string;
    let identity: { dev: number; ino: number };
    let transactionOptions: FreshProjectTrustOptions;
    try {
      transactionOptions = {
        ...options,
        knownFolders: boundedPathValues(options.knownFolders),
        protectedPaths: boundedPathValues(options.protectedPaths),
      };
      cwd = await existingCanonicalDirectory(projectPath);
      const info = await lstat(cwd);
      identity = { dev: info.dev, ino: info.ino };
    } catch {
      return { ok: false, reason: 'trust-unavailable' };
    }

    return this.queued(async (): Promise<FreshProjectTrustWriteResult<T>> => {
      const release = await acquireTrustLock(this.filePath).catch(() => undefined);
      if (!release) return { ok: false, reason: 'trust-unavailable' };
      try {
        const current = await lstat(cwd).catch(() => undefined);
        if (!current || !current.isDirectory()
          || current.dev !== identity.dev || current.ino !== identity.ino) {
          return { ok: false, reason: 'folder-not-fresh' };
        }

        let decisions: Map<string, boolean>;
        try {
          decisions = await loadTrustDecisions(this.filePath);
        } catch {
          return { ok: false, reason: 'trust-unavailable' };
        }
        let inspection: ProjectTrustInspection;
        try {
          inspection = await inspectProjectTrustResources(cwd);
        } catch {
          return { ok: false, reason: 'trust-unavailable' };
        }
        if (inspection.requiresTrust || nearestDecision(decisions, cwd)) {
          return { ok: false, reason: 'folder-not-fresh' };
        }
        let breadth: FreshProjectTrustBreadth | undefined;
        try {
          breadth = await freshProjectTrustBreadth(cwd, this.filePath, transactionOptions, decisions);
        } catch {
          return { ok: false, reason: 'trust-unavailable' };
        }
        if (breadth) return { ok: false, reason: 'trust-too-broad', breadth };
        let verifiedInspection: ProjectTrustInspection;
        try {
          verifiedInspection = await inspectProjectTrustResources(cwd);
        } catch {
          return { ok: false, reason: 'trust-unavailable' };
        }
        if (verifiedInspection.requiresTrust) {
          return { ok: false, reason: 'folder-not-fresh' };
        }
        const verifiedIdentity = await lstat(cwd).catch(() => undefined);
        if (!verifiedIdentity || !verifiedIdentity.isDirectory()
          || verifiedIdentity.dev !== identity.dev || verifiedIdentity.ino !== identity.ino) {
          return { ok: false, reason: 'folder-not-fresh' };
        }

        const trusted = new Map(decisions);
        trusted.set(cwd, true);
        try {
          await persistTrustDecisions(this.filePath, trusted);
          this.applySnapshot(trusted);
        } catch {
          return { ok: false, reason: 'trust-unavailable' };
        }

        const revalidate = async (): Promise<FreshProjectTrustStatus> => {
          const latestIdentity = await lstat(cwd).catch(() => undefined);
          if (!latestIdentity || !latestIdentity.isDirectory()
            || latestIdentity.dev !== identity.dev || latestIdentity.ino !== identity.ino) {
            return { allowed: false, reason: 'folder-not-fresh' };
          }
          let latestDecisions: Map<string, boolean>;
          try {
            latestDecisions = await loadTrustDecisions(this.filePath);
          } catch {
            return { allowed: false, reason: 'trust-unavailable' };
          }
          const exact = nearestDecision(latestDecisions, cwd);
          if (!exact || exact.path !== cwd || exact.decision !== true) {
            return { allowed: false, reason: 'folder-not-fresh' };
          }
          try {
            const latestInspection = await inspectProjectTrustResources(cwd);
            if (latestInspection.requiresTrust) {
              return { allowed: false, reason: 'folder-not-fresh' };
            }
            const latestBreadth = await freshProjectTrustBreadth(
              cwd,
              this.filePath,
              transactionOptions,
              latestDecisions,
            );
            if (latestBreadth) {
              return { allowed: false, reason: 'trust-too-broad', breadth: latestBreadth };
            }
            const verifiedInspection = await inspectProjectTrustResources(cwd);
            if (verifiedInspection.requiresTrust) {
              return { allowed: false, reason: 'folder-not-fresh' };
            }
            const verifiedIdentity = await lstat(cwd).catch(() => undefined);
            return !verifiedIdentity || !verifiedIdentity.isDirectory()
              || verifiedIdentity.dev !== identity.dev || verifiedIdentity.ino !== identity.ino
              ? { allowed: false, reason: 'folder-not-fresh' }
              : { allowed: true };
          } catch {
            return { allowed: false, reason: 'trust-unavailable' };
          }
        };

        try {
          return { ok: true, value: await operation(revalidate) };
        } catch (writeError) {
          const rolledBack = new Map(decisions);
          try {
            await persistTrustDecisions(this.filePath, rolledBack);
            this.applySnapshot(rolledBack);
            return { ok: false, reason: 'write-failed', writeError, trustKept: false };
          } catch (rollbackError) {
            this.applySnapshot(trusted);
            return {
              ok: false,
              reason: 'write-failed',
              writeError,
              rollbackError,
              trustKept: true,
            };
          }
        }
      } finally {
        await release().catch(() => undefined);
      }
    });
  }

  list(): string[] {
    return [...this.decisions.entries()]
      .filter(([, decision]) => decision)
      .map(([decisionPath]) => decisionPath)
      .sort();
  }

  listDecisions(): ProjectTrustDecisionEntry[] {
    return [...this.decisions.entries()]
      .map(([decisionPath, decision]) => ({ path: decisionPath, decision }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private applySnapshot(decisions: Map<string, boolean>): void {
    const sequence = ++this.readSequence;
    this.appliedSequence = sequence;
    this.decisions = decisions;
    this.decisionError = undefined;
  }

  private async readFresh(): Promise<{ decisions: Map<string, boolean>; decisionError?: string }> {
    const sequence = ++this.readSequence;
    let decisions: Map<string, boolean>;
    let decisionError: string | undefined;
    try {
      decisions = await loadTrustDecisions(this.filePath);
    } catch (error) {
      decisions = new Map();
      decisionError = cleanError(error);
    }
    if (sequence > this.appliedSequence) {
      this.appliedSequence = sequence;
      this.decisions = decisions;
      this.decisionError = decisionError;
    }
    return { decisions, ...(decisionError ? { decisionError } : {}) };
  }

  private async queued<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    let failure: unknown;
    const execute = async (): Promise<void> => {
      try {
        result = await operation();
      } catch (error) {
        failure = error;
      }
    };
    this.mutation = this.mutation.then(execute, execute);
    await this.mutation;
    if (failure) throw failure;
    return result;
  }
}

/** Resolve one process's trust without duplicating CLI/Web decision semantics. */
export async function resolveProjectTrust(options: ResolveProjectTrustOptions): Promise<ResolvedProjectTrust> {
  const status = await options.trustManager.getStatus(options.cwd, {
    includeContextFiles: options.includeContextFiles,
  });
  if (options.override !== undefined) {
    return { ...status, trusted: options.override, resourceTrusted: options.override, source: 'override' };
  }
  if (status.decisionError) {
    return { ...status, trusted: false, resourceTrusted: false, source: 'fallback' };
  }
  if (status.decision !== null) {
    return { ...status, resourceTrusted: status.trusted, source: 'saved' };
  }
  if (!status.requiresTrust) {
    return { ...status, trusted: true, resourceTrusted: false, source: 'not-required' };
  }

  const fallback = options.defaultProjectTrust ?? 'ask';
  if (fallback === 'always') return { ...status, trusted: true, resourceTrusted: true, source: 'default' };
  if (fallback === 'never') return { ...status, trusted: false, resourceTrusted: false, source: 'default' };
  if (!options.prompt) return { ...status, trusted: false, resourceTrusted: false, source: 'fallback' };

  const parentPath = path.dirname(status.cwd) === status.cwd ? undefined : path.dirname(status.cwd);
  const choice = await options.prompt({ status, parentPath });
  if (choice === 'trust') {
    await options.trustManager.trust(status.cwd);
    return {
      ...status,
      trusted: true,
      resourceTrusted: true,
      decision: true,
      decisionPath: status.cwd,
      inherited: false,
      source: 'prompt',
    };
  }
  if (choice === 'trust-parent' && parentPath) {
    await options.trustManager.setMany([
      { path: parentPath, decision: true },
      { path: status.cwd, decision: null },
    ]);
    return {
      ...status,
      trusted: true,
      resourceTrusted: true,
      decision: true,
      decisionPath: parentPath,
      inherited: true,
      source: 'prompt',
    };
  }
  if (choice === 'trust-session') {
    return { ...status, trusted: true, resourceTrusted: true, source: 'prompt' };
  }
  if (choice === 'refuse') {
    await options.trustManager.refuse(status.cwd);
    return {
      ...status,
      trusted: false,
      resourceTrusted: false,
      decision: false,
      decisionPath: status.cwd,
      inherited: false,
      source: 'prompt',
    };
  }
  return {
    ...status,
    trusted: false,
    resourceTrusted: false,
    source: choice === 'refuse-session' ? 'prompt' : 'fallback',
  };
}
