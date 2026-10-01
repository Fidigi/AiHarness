import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  PluginCatalog,
  PluginDiagnostic,
  PluginPackageInfo,
  PluginReloadResult,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginResourceKind,
  PluginScope,
  PluginSourceType,
  PluginStandaloneExtensionInfo,
  PluginUpdateResult,
  ProjectTrustManager,
  WorkspaceManager,
} from '@ai-harness/core';

const execFileAsync = promisify(execFile);
const FILE_VERSION = 1 as const;
const MAX_PACKAGES = 100;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_DEPTH = 8;
const MAX_RESOURCES = 1_000;
const MAX_PATTERNS = 100;
const INSTALL_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 20_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const EXTENSION_SUFFIXES = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx']);
const EMPTY_COUNTS: PluginResourceCounts = { extensions: 0, skills: 0, prompts: 0, themes: 0 };

interface PluginStateFile {
  version: typeof FILE_VERSION;
  generation: number;
  packages: StoredPlugin[];
}

interface StoredPlugin {
  key: string;
  source: string;
  sourceType: PluginSourceType;
  scope: PluginScope;
  projectId?: string;
  enabled: boolean;
  managedRelativePath?: string;
  packageRelativePath?: string;
  localPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  description?: string;
  installedRevision?: string;
  installedAt: string;
  updatedAt: string;
}

export interface ParsedPluginSource {
  normalized: string;
  type: PluginSourceType;
  identity: string;
  packageName?: string;
  configuredVersion?: string;
  gitUrl?: string;
  gitRef?: string;
  localPath?: string;
}

export interface PluginCommandResult {
  stdout: string;
  stderr: string;
}

export interface PluginCommandRunner {
  run(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<PluginCommandResult>;
}

export interface PluginContextInput {
  cwd?: string;
  projectId?: string;
}

export interface PluginMutationInput extends PluginContextInput {
  scope: PluginScope;
}

export interface PluginSkillRoot {
  directory: string;
  source: string;
  displayRoot: string;
  trusted: boolean;
}

interface PluginContext {
  cwd: string;
  projectId: string;
  projectTrusted: boolean;
}

interface ScannedFile {
  absolutePath: string;
  relativePath: string;
}

interface InventoryResource extends PluginResourceInfo {
  absolutePath: string;
}

interface PackageInventory {
  packageName?: string;
  version?: string;
  description?: string;
  resources: InventoryResource[];
  counts: PluginResourceCounts;
}

interface PreparedInstall {
  record: StoredPlugin;
  stagingPath?: string;
  finalPath?: string;
}

function httpError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function pluginHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function cloneCatalog(catalog: PluginCatalog): PluginCatalog {
  return structuredClone(catalog);
}

function sourceHosts(): Set<string> {
  const configured = process.env.AI_HARNESS_PLUGIN_GIT_HOSTS
    ?.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return new Set(configured?.length ? configured : ['github.com', 'gitlab.com', 'bitbucket.org']);
}

function parseNpmSource(source: string): ParsedPluginSource {
  const specification = source.slice(4);
  if (!specification || specification.length > 300 || CONTROL_CHARACTERS.test(specification)
    || specification.includes('://') || /[\s\\?#]/.test(specification)) {
    throw httpError('Source npm invalide.', 400, 'INVALID_PLUGIN_SOURCE');
  }

  let packageName = specification;
  let configuredVersion: string | undefined;
  if (specification.startsWith('@')) {
    const slash = specification.indexOf('/');
    const separator = slash < 0 ? -1 : specification.indexOf('@', slash);
    if (separator > slash) {
      packageName = specification.slice(0, separator);
      configuredVersion = specification.slice(separator + 1);
    }
  } else {
    const separator = specification.indexOf('@');
    if (separator > 0) {
      packageName = specification.slice(0, separator);
      configuredVersion = specification.slice(separator + 1);
    }
  }

  if (!/^(?:@[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}|[a-z0-9][a-z0-9._-]{0,199})$/i.test(packageName)
    || (configuredVersion !== undefined && (!configuredVersion
      || configuredVersion.length > 100
      || !/^[a-z0-9*._+~^<>=|-]+$/i.test(configuredVersion)))) {
    throw httpError('Nom ou version npm invalide.', 400, 'INVALID_PLUGIN_SOURCE');
  }

  const normalized = `npm:${packageName}${configuredVersion ? `@${configuredVersion}` : ''}`;
  return {
    normalized,
    type: 'npm',
    identity: `npm:${packageName.toLowerCase()}`,
    packageName,
    ...(configuredVersion ? { configuredVersion } : {}),
  };
}

function parseGitSource(source: string): ParsedPluginSource {
  let specification = source.slice(4);
  if (!specification || specification.length > 1_000 || CONTROL_CHARACTERS.test(specification)) {
    throw httpError('Source Git invalide.', 400, 'INVALID_PLUGIN_SOURCE');
  }
  if (/^(?:github\.com|gitlab\.com|bitbucket\.org)\//i.test(specification)) specification = `https://${specification}`;

  let url: URL;
  try {
    url = new URL(specification);
  } catch {
    throw httpError('La source Git doit être une URL HTTPS valide.', 400, 'INVALID_PLUGIN_SOURCE');
  }
  let gitRef: string | undefined;
  try {
    gitRef = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
  } catch {
    throw httpError('Référence Git invalide.', 400, 'INVALID_PLUGIN_SOURCE');
  }
  url.hash = '';
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.port
    || !sourceHosts().has(url.hostname.toLowerCase())
    || !/^\/[A-Za-z0-9._~/-]+$/.test(url.pathname)
    || url.pathname.includes('/../') || url.pathname.endsWith('/..')
    || (gitRef && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(gitRef) || gitRef.includes('..')))) {
    throw httpError('Source Git refusée : utilisez un dépôt HTTPS autorisé, sans credentials ni query string.', 400, 'INVALID_PLUGIN_SOURCE');
  }
  const gitUrl = url.toString().replace(/\/$/, '');
  const normalized = `git:${gitUrl}${gitRef ? `#${gitRef}` : ''}`;
  return {
    normalized,
    type: 'git',
    identity: `git:${url.hostname.toLowerCase()}${url.pathname.replace(/\.git$/i, '').toLowerCase()}`,
    gitUrl,
    ...(gitRef ? { gitRef, configuredVersion: gitRef } : {}),
  };
}

/** Strict, side-effect-free source parsing. Filesystem boundaries are checked during installation. */
export function parsePluginSource(input: string): ParsedPluginSource {
  const source = input.trim();
  if (!source || source.length > 1_000 || CONTROL_CHARACTERS.test(source)) {
    throw httpError('Source de plugin invalide.', 400, 'INVALID_PLUGIN_SOURCE');
  }
  if (source.startsWith('npm:')) return parseNpmSource(source);
  if (source.startsWith('git:')) return parseGitSource(source);
  if (!path.isAbsolute(source)) {
    throw httpError('Utilisez npm:, git: ou un chemin absolu.', 400, 'INVALID_PLUGIN_SOURCE');
  }
  const normalized = path.normalize(source);
  return {
    normalized,
    type: 'path',
    identity: `path:${normalized}`,
    localPath: normalized,
  };
}

function defaultRunner(): PluginCommandRunner {
  return {
    async run(command, args, options) {
      try {
        const result = await execFileAsync(command, args, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          timeout: options.timeoutMs,
          signal: options.signal,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        return { stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const code = typeof (error as NodeJS.ErrnoException).code === 'string'
          ? (error as NodeJS.ErrnoException).code
          : typeof (error as { code?: unknown }).code === 'number'
            ? String((error as { code: number }).code)
            : 'FAILED';
        throw httpError(`${command} a échoué (${code}).`, 502, 'PLUGIN_COMMAND_FAILED');
      }
    },
  };
}

function normalizedPattern(value: unknown): { pattern: string; exclude: boolean; exact: boolean } {
  if (typeof value !== 'string' || !value || value.length > 500 || CONTROL_CHARACTERS.test(value)) {
    throw new Error('Invalid plugin resource pattern');
  }
  let pattern = value.replace(/\\/g, '/');
  let exclude = false;
  let exact = false;
  if (pattern.startsWith('!') || pattern.startsWith('-')) {
    exclude = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('+')) {
    exact = true;
    pattern = pattern.slice(1);
  }
  pattern = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  if (!pattern || path.posix.isAbsolute(pattern) || pattern.split('/').includes('..')) {
    throw new Error('Plugin resource pattern escapes its package');
  }
  return { pattern, exclude, exact };
}

function globExpression(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?';
          index += 2;
        } else {
          expression += '.*';
          index++;
        }
      } else expression += '[^/]*';
    } else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${expression}$`);
}

function patternMatches(relativePath: string, pattern: ReturnType<typeof normalizedPattern>): boolean {
  if (pattern.exact) return relativePath === pattern.pattern;
  if (!pattern.pattern.includes('*') && !pattern.pattern.includes('?')) {
    return relativePath === pattern.pattern || relativePath.startsWith(`${pattern.pattern}/`);
  }
  return globExpression(pattern.pattern).test(relativePath);
}

async function scanFiles(root: string): Promise<{ files: ScannedFile[]; truncated: boolean }> {
  const files: ScannedFile[] = [];
  let entriesRemaining = MAX_SCAN_ENTRIES;
  let truncated = false;

  async function walk(directory: string, depth: number): Promise<void> {
    if (entriesRemaining <= 0 || files.length >= MAX_SCAN_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entriesRemaining-- <= 0 || files.length >= MAX_SCAN_FILES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isFile()) {
        files.push({ absolutePath, relativePath: path.relative(root, absolutePath).split(path.sep).join('/') });
      } else if (entry.isDirectory() && depth < MAX_SCAN_DEPTH) await walk(absolutePath, depth + 1);
    }
  }

  await walk(root, 0);
  return { files, truncated };
}

function candidateForKind(file: ScannedFile, kind: PluginResourceKind): { relativePath: string; absolutePath: string } | undefined {
  const lower = file.relativePath.toLowerCase();
  const extension = path.extname(lower);
  if (kind === 'extension' && EXTENSION_SUFFIXES.has(extension)) return file;
  if (kind === 'prompt' && extension === '.md') return file;
  if (kind === 'theme' && extension === '.json') return file;
  if (kind === 'skill' && path.posix.basename(lower) === 'skill.md') {
    const directory = path.posix.dirname(file.relativePath);
    return {
      relativePath: directory === '.' ? '' : directory,
      absolutePath: path.dirname(file.absolutePath),
    };
  }
  return undefined;
}

function conventional(candidate: { relativePath: string }, kind: PluginResourceKind): boolean {
  const root = { extension: 'extensions', skill: 'skills', prompt: 'prompts', theme: 'themes' }[kind];
  return candidate.relativePath === root || candidate.relativePath.startsWith(`${root}/`);
}

function resourceName(kind: PluginResourceKind, relativePath: string): string {
  const basename = path.posix.basename(relativePath || 'root');
  return kind === 'skill' ? basename : basename.replace(/\.(?:md|json|[cm]?js|[cm]?ts|tsx)$/i, '');
}

function countsFor(resources: Array<Pick<PluginResourceInfo, 'kind'>>): PluginResourceCounts {
  return {
    extensions: resources.filter(resource => resource.kind === 'extension').length,
    skills: resources.filter(resource => resource.kind === 'skill').length,
    prompts: resources.filter(resource => resource.kind === 'prompt').length,
    themes: resources.filter(resource => resource.kind === 'theme').length,
  };
}

async function readPackageManifest(root: string): Promise<Record<string, unknown>> {
  const manifestPath = path.join(root, 'package.json');
  try {
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) {
      throw new Error('Invalid package manifest');
    }
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid package manifest');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function inventoryPackage(
  root: string,
  displayRoot: string,
  standaloneFile?: string,
): Promise<PackageInventory> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Plugin package root is not a safe directory');
  const manifest = await readPackageManifest(root);
  const piManifest = manifest.pi && typeof manifest.pi === 'object' && !Array.isArray(manifest.pi)
    ? manifest.pi as Record<string, unknown>
    : {};
  let files: ScannedFile[];
  let truncated = false;
  if (standaloneFile) {
    const info = await lstat(standaloneFile);
    if (!info.isFile() || info.isSymbolicLink() || !inside(root, standaloneFile)) {
      throw new Error('Standalone extension is not a safe file');
    }
    files = [{ absolutePath: standaloneFile, relativePath: path.relative(root, standaloneFile).split(path.sep).join('/') }];
  } else {
    const scanned = await scanFiles(root);
    files = scanned.files;
    truncated = scanned.truncated;
  }

  const resources: InventoryResource[] = [];
  for (const kind of ['extension', 'skill', 'prompt', 'theme'] as PluginResourceKind[]) {
    const candidates = files.map(file => candidateForKind(file, kind)).filter((item): item is NonNullable<typeof item> => Boolean(item));
    const field = `${kind}s`;
    const configured = piManifest[field];
    if (configured !== undefined && (!Array.isArray(configured) || configured.length > MAX_PATTERNS)) {
      throw new Error(`Invalid ${field} package manifest entry`);
    }
    const patterns = configured === undefined ? undefined : configured.map(normalizedPattern);
    const unique = new Map<string, { relativePath: string; absolutePath: string }>();
    for (const candidate of candidates) {
      const skillDocument = kind === 'skill'
        ? `${candidate.relativePath ? `${candidate.relativePath}/` : ''}SKILL.md`
        : candidate.relativePath;
      const selected = standaloneFile && kind === 'extension'
        ? true
        : patterns === undefined
          ? conventional(candidate, kind)
          : patterns.some(pattern => !pattern.exclude
            && (patternMatches(candidate.relativePath, pattern) || patternMatches(skillDocument, pattern)))
            && !patterns.some(pattern => pattern.exclude
              && (patternMatches(candidate.relativePath, pattern) || patternMatches(skillDocument, pattern)));
      if (selected) unique.set(candidate.absolutePath, candidate);
    }
    for (const candidate of unique.values()) {
      if (resources.length >= MAX_RESOURCES) break;
      const relativePath = candidate.relativePath || path.posix.basename(candidate.absolutePath);
      resources.push({
        kind,
        name: resourceName(kind, relativePath),
        relativePath,
        path: `${displayRoot.replace(/\/$/, '')}/${relativePath}`,
        absolutePath: candidate.absolutePath,
      });
    }
  }
  if (truncated) throw new Error('Plugin resource scan budget exceeded');
  resources.sort((left, right) => left.kind.localeCompare(right.kind) || left.relativePath.localeCompare(right.relativePath));
  return {
    ...(cleanText(manifest.name, 214) ? { packageName: cleanText(manifest.name, 214) } : {}),
    ...(cleanText(manifest.version, 100) ? { version: cleanText(manifest.version, 100) } : {}),
    ...(cleanText(manifest.description, 500) ? { description: cleanText(manifest.description, 500) } : {}),
    resources,
    counts: countsFor(resources),
  };
}

async function standaloneExtensions(
  directory: string,
  displayRoot: string,
  scope: PluginScope,
  trusted: boolean,
): Promise<PluginStandaloneExtensionInfo[]> {
  if (scope === 'project' && !trusted) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile() && !entry.isSymbolicLink() && EXTENSION_SUFFIXES.has(path.extname(entry.name).toLowerCase()))
    .slice(0, 200)
    .map(entry => ({
      kind: 'extension' as const,
      name: resourceName('extension', entry.name),
      relativePath: entry.name,
      path: `${displayRoot}/${entry.name}`,
      scope,
      enabled: true,
      trusted,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function validRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 500
    && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !CONTROL_CHARACTERS.test(value);
}

/** Secure, explicit package installer and metadata-only resource catalogue. */
export class PluginService {
  private state: PluginStateFile = { version: FILE_VERSION, generation: 0, packages: [] };
  private mutation = Promise.resolve();
  private readonly catalogCache = new Map<string, PluginCatalog>();
  private readonly pluginRoot: string;

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly trustManager: ProjectTrustManager,
    private readonly stateFile: string,
    private readonly dataDir: string,
    private readonly runner: PluginCommandRunner = defaultRunner(),
  ) {
    this.pluginRoot = path.join(dataDir, 'plugins');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<PluginStateFile>;
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.packages) || parsed.packages.length > MAX_PACKAGES) return;
      const packages = parsed.packages.flatMap(record => this.validStored(record) ? [record] : []);
      this.state = {
        version: FILE_VERSION,
        generation: Number.isSafeInteger(parsed.generation) && (parsed.generation ?? -1) >= 0 ? parsed.generation! : 0,
        packages: structuredClone(packages),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[Plugins] Ignoring invalid state:', error instanceof Error ? error.message : error);
      }
    }
  }

  async getCatalog(input: PluginContextInput & { refresh?: boolean } = {}): Promise<PluginCatalog> {
    const context = await this.context(input);
    const cached = this.catalogCache.get(context.cwd);
    if (cached && !input.refresh && cached.projectTrusted === context.projectTrusted) return cloneCatalog(cached);
    const catalog = await this.scanCatalog(context, this.state.generation);
    this.catalogCache.set(context.cwd, catalog);
    return cloneCatalog(catalog);
  }

  async install(
    input: PluginMutationInput & { source: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalog> {
    const parsed = parsePluginSource(input.source);
    return this.queued(async () => {
      const context = await this.context(input);
      this.requireTrustedMutation(input.scope, context, 'installer');
      if (this.state.packages.length >= MAX_PACKAGES) {
        throw httpError('Nombre maximal de packages atteint.', 409, 'PLUGIN_LIMIT');
      }
      const owner = input.scope === 'project' ? context.projectId : 'global';
      const key = `${input.scope}:${owner}:${pluginHash(parsed.identity)}`;
      if (this.state.packages.some(record => record.key === key)) {
        throw httpError('Ce package est déjà configuré dans cette portée.', 409, 'PLUGIN_EXISTS');
      }
      const prepared = await this.prepareInstall(parsed, key, input.scope, context, signal);
      try {
        if (prepared.stagingPath && prepared.finalPath) {
          await mkdir(path.dirname(prepared.finalPath), { recursive: true, mode: 0o700 });
          await rename(prepared.stagingPath, prepared.finalPath);
        }
        this.state.packages.push(prepared.record);
        try {
          await this.persist();
        } catch (error) {
          this.state.packages = this.state.packages.filter(record => record.key !== key);
          if (prepared.finalPath) await rm(prepared.finalPath, { recursive: true, force: true });
          throw error;
        }
      } finally {
        if (prepared.stagingPath) await rm(prepared.stagingPath, { recursive: true, force: true });
      }
      this.invalidate();
      return this.getCatalog({ cwd: context.cwd, projectId: context.projectId, refresh: true });
    });
  }

  async setEnabled(
    input: PluginMutationInput & { key: string; enabled: boolean },
  ): Promise<PluginCatalog> {
    return this.queued(async () => {
      const context = await this.context(input);
      const record = this.findMutable(input.key, input.scope, context);
      if (input.enabled) this.requireTrustedMutation(record.scope, context, 'activer');
      const previous = { enabled: record.enabled, updatedAt: record.updatedAt };
      record.enabled = input.enabled;
      record.updatedAt = new Date().toISOString();
      try {
        await this.persist();
      } catch (error) {
        record.enabled = previous.enabled;
        record.updatedAt = previous.updatedAt;
        throw error;
      }
      this.invalidate();
      return this.getCatalog({ cwd: context.cwd, projectId: context.projectId, refresh: true });
    });
  }

  async remove(input: PluginMutationInput & { key: string }): Promise<PluginCatalog> {
    return this.queued(async () => {
      const context = await this.context(input);
      const record = this.findMutable(input.key, input.scope, context);
      const index = this.state.packages.indexOf(record);
      let trashPath: string | undefined;
      const managed = record.managedRelativePath ? this.managedPath(record) : undefined;
      if (managed) {
        try {
          const canonicalRoot = await realpath(this.pluginRoot).catch(() => this.pluginRoot);
          const canonicalManaged = await realpath(managed);
          if (!inside(canonicalRoot, canonicalManaged)) throw new Error('Managed package escaped plugin root');
          trashPath = path.join(this.pluginRoot, `.trash-${crypto.randomUUID()}`);
          await rename(canonicalManaged, trashPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      this.state.packages.splice(index, 1);
      try {
        await this.persist();
      } catch (error) {
        this.state.packages.splice(index, 0, record);
        if (trashPath && managed) await rename(trashPath, managed).catch(() => undefined);
        throw error;
      }
      if (trashPath) await rm(trashPath, { recursive: true, force: true });
      this.invalidate();
      return this.getCatalog({ cwd: context.cwd, projectId: context.projectId, refresh: true });
    });
  }

  async update(
    input: PluginContextInput & { key: string; scope: PluginScope },
    signal?: AbortSignal,
  ): Promise<PluginCatalog> {
    return this.queued(async () => {
      const context = await this.context(input);
      const current = this.findMutable(input.key, input.scope, context);
      this.requireTrustedMutation(current.scope, context, 'mettre à jour');
      if (current.sourceType === 'path') {
        throw httpError('Les sources locales sont rechargées directement et ne se mettent pas à jour automatiquement.', 400, 'PLUGIN_UPDATE_UNSUPPORTED');
      }
      const parsed = parsePluginSource(current.source);
      const prepared = await this.prepareInstall(parsed, current.key, current.scope, context, signal, current);
      const finalPath = prepared.finalPath!;
      const stagingPath = prepared.stagingPath!;
      const backupPath = path.join(this.pluginRoot, `.backup-${crypto.randomUUID()}`);
      const index = this.state.packages.indexOf(current);
      try {
        await rename(finalPath, backupPath);
        try {
          await rename(stagingPath, finalPath);
          this.state.packages[index] = prepared.record;
          await this.persist();
        } catch (error) {
          this.state.packages[index] = current;
          await rm(finalPath, { recursive: true, force: true });
          await rename(backupPath, finalPath);
          throw error;
        }
        await rm(backupPath, { recursive: true, force: true });
      } finally {
        await rm(stagingPath, { recursive: true, force: true });
      }
      this.invalidate();
      return this.getCatalog({ cwd: context.cwd, projectId: context.projectId, refresh: true });
    });
  }

  async updateAll(
    input: PluginContextInput & { scope?: PluginScope },
    signal?: AbortSignal,
  ): Promise<PluginCatalog> {
    const initial = await this.getCatalog({ ...input, refresh: true });
    const targets = initial.packages.filter(item => item.canCheckForUpdates
      && (!input.scope || item.scope === input.scope));
    let catalog = initial;
    for (const target of targets) {
      if (signal?.aborted) throw httpError('Mise à jour annulée.', 499, 'PLUGIN_OPERATION_ABORTED');
      if (target.scope === 'project' && !initial.projectTrusted) continue;
      catalog = await this.update({
        cwd: initial.cwd,
        projectId: initial.projectId,
        key: target.key,
        scope: target.scope,
      }, signal);
    }
    return catalog;
  }

  async checkUpdates(
    input: PluginContextInput & { key?: string; scope?: PluginScope },
    signal?: AbortSignal,
  ): Promise<PluginUpdateResult[]> {
    const context = await this.context(input);
    const records = this.visibleRecords(context).filter(record => !input.key || (
      record.key === input.key && (!input.scope || record.scope === input.scope)
    ));
    if (input.key && records.length === 0) throw httpError('Package introuvable.', 404, 'PLUGIN_NOT_FOUND');
    const results: PluginUpdateResult[] = [];
    for (const record of records) {
      if (signal?.aborted) throw httpError('Vérification annulée.', 499, 'PLUGIN_OPERATION_ABORTED');
      results.push(await this.checkRecord(record, signal));
    }
    return results;
  }

  /** Validate every active package before committing a new resource generation. */
  async reload(input: PluginContextInput = {}): Promise<{ catalog: PluginCatalog; reload: PluginReloadResult }> {
    return this.queued(async () => {
      const context = await this.context(input);
      const candidate = await this.scanCatalog(context, this.state.generation + 1);
      const blocking = candidate.packages.find(item => item.enabled && item.trusted
        && (item.status === 'missing' || item.status === 'error'));
      if (blocking) {
        throw httpError(`Reload annulé : ${blocking.source} n'est pas valide.`, 409, 'PLUGIN_RELOAD_FAILED');
      }
      const previousGeneration = this.state.generation;
      this.state.generation++;
      try {
        await this.persist();
      } catch (error) {
        this.state.generation = previousGeneration;
        throw error;
      }
      candidate.generation = this.state.generation;
      candidate.updatedAt = new Date().toISOString();
      this.catalogCache.clear();
      this.catalogCache.set(context.cwd, candidate);
      const restartRequired = candidate.packages.some(item => item.enabled && item.trusted && item.restartRequired)
        || candidate.standaloneExtensions.some(item => item.enabled);
      return {
        catalog: cloneCatalog(candidate),
        reload: {
          reloadedAt: candidate.updatedAt,
          generation: candidate.generation,
          resourceCounts: structuredClone(candidate.totals),
          restartRequired,
          message: restartRequired
            ? 'Les ressources déclaratives sont rechargées. Redémarrez le serveur pour appliquer les extensions exécutables.'
            : 'Les ressources du catalogue ont été rechargées atomiquement.',
        },
      };
    });
  }

  /** Resolve an enabled prompt as inert text; executable or markup content is never evaluated. */
  async resolvePrompt(name: string, input: PluginContextInput = {}): Promise<{ content: string; source: string } | undefined> {
    const requested = name.trim().toLowerCase();
    const context = await this.context(input);
    for (const record of [...this.visibleRecords(context)].reverse()) {
      if (!record.enabled || (record.scope === 'project' && !context.projectTrusted)) continue;
      try {
        const { root, standaloneFile, displayRoot } = await this.resolveInstalled(record);
        const inventory = await inventoryPackage(root, displayRoot, standaloneFile);
        const resource = inventory.resources.find(item => item.kind === 'prompt' && item.name.toLowerCase() === requested);
        if (!resource) continue;
        const file = await lstat(resource.absolutePath);
        if (!file.isFile() || file.size > MAX_MANIFEST_BYTES) continue;
        return { content: await readFile(resource.absolutePath, 'utf8'), source: record.source };
      } catch {
        // Continue to a lower-precedence package when a prompt became unreadable.
      }
    }
    return undefined;
  }

  /** Executable files are consumed only by the trusted server-side module loader. */
  async getEnabledExtensionFiles(input: PluginContextInput = {}): Promise<string[]> {
    const context = await this.context(input);
    const files: string[] = [];
    for (const record of this.visibleRecords(context)) {
      if (!record.enabled || (record.scope === 'project' && !context.projectTrusted)) continue;
      try {
        const { root, standaloneFile, displayRoot } = await this.resolveInstalled(record);
        const inventory = await inventoryPackage(root, displayRoot, standaloneFile);
        for (const resource of inventory.resources.filter(item => item.kind === 'extension')) {
          if (!['.js', '.mjs'].includes(path.extname(resource.absolutePath).toLowerCase())) continue;
          files.push(resource.absolutePath);
          if (files.length >= MAX_RESOURCES) return [...new Set(files)].sort();
        }
      } catch {
        // Invalid packages remain visible through catalogue diagnostics but are never executed.
      }
    }
    return [...new Set(files)].sort();
  }

  /** Package skill roots are consumed internally; their instruction bodies never enter the plugin API. */
  async getEnabledSkillRoots(input: PluginContextInput = {}): Promise<PluginSkillRoot[]> {
    const context = await this.context(input);
    const roots: PluginSkillRoot[] = [];
    for (const record of this.visibleRecords(context)) {
      if (!record.enabled || (record.scope === 'project' && !context.projectTrusted)) continue;
      try {
        const { root, standaloneFile, displayRoot } = await this.resolveInstalled(record);
        const inventory = await inventoryPackage(root, displayRoot, standaloneFile);
        for (const resource of inventory.resources.filter(item => item.kind === 'skill')) {
          roots.push({
            directory: resource.absolutePath,
            source: record.source,
            displayRoot: resource.path,
            trusted: record.scope === 'global' || context.projectTrusted,
          });
          if (roots.length >= MAX_RESOURCES) return roots;
        }
      } catch {
        // Invalid packages are reported by the plugin catalogue and are not exposed as skills.
      }
    }
    return roots;
  }

  invalidate(): void {
    this.catalogCache.clear();
  }

  private async prepareInstall(
    parsed: ParsedPluginSource,
    key: string,
    scope: PluginScope,
    context: PluginContext,
    signal?: AbortSignal,
    previous?: StoredPlugin,
  ): Promise<PreparedInstall> {
    if (signal?.aborted) throw httpError('Installation annulée.', 499, 'PLUGIN_OPERATION_ABORTED');
    const now = new Date().toISOString();
    const base: StoredPlugin = {
      key,
      source: parsed.normalized,
      sourceType: parsed.type,
      scope,
      ...(scope === 'project' ? { projectId: context.projectId } : {}),
      enabled: previous?.enabled ?? true,
      ...(parsed.packageName ? { packageName: parsed.packageName } : {}),
      ...(parsed.configuredVersion ? { configuredVersion: parsed.configuredVersion } : {}),
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    };

    if (parsed.type === 'path') {
      const canonical = await this.workspaceManager.resolve(parsed.localPath!, { kind: 'any' });
      const sourceInfo = await lstat(parsed.localPath!);
      if (sourceInfo.isSymbolicLink()) throw httpError('Les racines de plugin symboliques sont refusées.', 400, 'PLUGIN_SYMLINK_REJECTED');
      const canonicalInfo = await lstat(canonical);
      const standaloneFile = canonicalInfo.isFile() ? canonical : undefined;
      if (!canonicalInfo.isDirectory() && !standaloneFile) {
        throw httpError('Le chemin de plugin doit désigner un dossier ou une extension.', 400, 'INVALID_PLUGIN_SOURCE');
      }
      if (standaloneFile && !EXTENSION_SUFFIXES.has(path.extname(standaloneFile).toLowerCase())) {
        throw httpError('Le fichier local ne correspond pas à une extension prise en charge.', 400, 'INVALID_PLUGIN_SOURCE');
      }
      const root = standaloneFile ? path.dirname(standaloneFile) : canonical;
      const inventory = await inventoryPackage(root, canonical, standaloneFile);
      return {
        record: {
          ...base,
          source: canonical,
          localPath: canonical,
          ...(inventory.packageName ? { packageName: inventory.packageName } : {}),
          ...(inventory.version ? { version: inventory.version } : {}),
          ...(inventory.description ? { description: inventory.description } : {}),
        },
      };
    }

    await mkdir(this.pluginRoot, { recursive: true, mode: 0o700 });
    const stagingPath = path.join(this.pluginRoot, `.staging-${crypto.randomUUID()}`);
    const managedRelativePath = path.join(
      'installed',
      scope === 'global' ? 'global' : path.join('projects', context.projectId),
      pluginHash(key),
    );
    const finalPath = path.join(this.pluginRoot, managedRelativePath);
    await mkdir(stagingPath, { recursive: true, mode: 0o700 });
    let packageRelativePath: string;
    let installedRevision: string | undefined;
    try {
      if (parsed.type === 'npm') {
        await this.runner.run('npm', [
          'install', '--prefix', stagingPath, '--ignore-scripts', '--no-audit', '--no-fund',
          '--package-lock=false', '--omit=dev', parsed.normalized.slice(4),
        ], { timeoutMs: INSTALL_TIMEOUT_MS, signal });
        packageRelativePath = path.join('node_modules', ...parsed.packageName!.split('/'));
      } else {
        packageRelativePath = 'repository';
        const repository = path.join(stagingPath, packageRelativePath);
        const cloneArguments = ['clone', '--depth', '1', '--single-branch'];
        if (parsed.gitRef) cloneArguments.push('--branch', parsed.gitRef);
        cloneArguments.push('--', parsed.gitUrl!, repository);
        await this.runner.run('git', cloneArguments, { timeoutMs: INSTALL_TIMEOUT_MS, signal });
        const packageJson = path.join(repository, 'package.json');
        try {
          const info = await lstat(packageJson);
          if (info.isFile() && !info.isSymbolicLink()) {
            await this.runner.run('npm', [
              'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--omit=dev',
            ], { cwd: repository, timeoutMs: INSTALL_TIMEOUT_MS, signal });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        installedRevision = (await this.runner.run(
          'git', ['-C', repository, 'rev-parse', 'HEAD'], { timeoutMs: CHECK_TIMEOUT_MS, signal },
        )).stdout.trim().slice(0, 64);
      }
      const packageRoot = path.join(stagingPath, packageRelativePath);
      const inventory = await inventoryPackage(packageRoot, `plugins/${managedRelativePath.split(path.sep).join('/')}`);
      return {
        stagingPath,
        finalPath,
        record: {
          ...base,
          managedRelativePath,
          packageRelativePath,
          ...(inventory.packageName ? { packageName: inventory.packageName } : {}),
          ...(inventory.version ? { version: inventory.version } : {}),
          ...(inventory.description ? { description: inventory.description } : {}),
          ...(installedRevision ? { installedRevision } : {}),
        },
      };
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async checkRecord(record: StoredPlugin, signal?: AbortSignal): Promise<PluginUpdateResult> {
    const base: Omit<PluginUpdateResult, 'state'> = {
      key: record.key,
      source: record.source,
      scope: record.scope,
      displayName: record.packageName ?? record.source,
      type: record.sourceType,
      ...(record.version ? { installedVersion: record.version } : {}),
    };
    if (record.sourceType === 'path') return {
      ...base,
      state: 'unsupported',
      message: 'Une source locale est relue directement lors du reload.',
    };
    try {
      const parsed = parsePluginSource(record.source);
      if (record.sourceType === 'npm') {
        const specification = `${parsed.packageName}${parsed.configuredVersion ? `@${parsed.configuredVersion}` : ''}`;
        const output = await this.runner.run(
          'npm', ['view', specification, 'version', '--json'], { timeoutMs: CHECK_TIMEOUT_MS, signal },
        );
        const value = JSON.parse(output.stdout) as unknown;
        const availableVersion = Array.isArray(value)
          ? cleanText(value[value.length - 1], 100)
          : cleanText(value, 100);
        if (!availableVersion) throw new Error('Invalid npm version response');
        return {
          ...base,
          availableVersion,
          state: record.version === availableVersion ? 'up-to-date' : 'update-available',
        };
      }
      const references = parsed.gitRef ? [parsed.gitRef, `${parsed.gitRef}^{}`] : ['HEAD'];
      const output = await this.runner.run(
        'git', ['ls-remote', parsed.gitUrl!, ...references], { timeoutMs: CHECK_TIMEOUT_MS, signal },
      );
      const lines = output.stdout.trim().split(/\r?\n/).filter(Boolean);
      const selected = lines.find(line => line.endsWith('^{}')) ?? lines[0];
      const availableVersion = selected?.trim().split(/\s+/)[0]?.slice(0, 64);
      if (!availableVersion) throw new Error('Git reference not found');
      return {
        ...base,
        availableVersion,
        state: record.installedRevision === availableVersion ? 'up-to-date' : 'update-available',
      };
    } catch (error) {
      return {
        ...base,
        state: 'error',
        message: error instanceof Error ? cleanText(error.message, 300) ?? 'Vérification impossible.' : 'Vérification impossible.',
      };
    }
  }

  private async scanCatalog(context: PluginContext, generation: number): Promise<PluginCatalog> {
    const packages: PluginPackageInfo[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    for (const record of this.visibleRecords(context)) {
      const trusted = record.scope === 'global' || context.projectTrusted;
      const packageDiagnostics: PluginDiagnostic[] = [];
      let inventory: PackageInventory = { resources: [], counts: structuredClone(EMPTY_COUNTS) };
      let status: PluginPackageInfo['status'] = record.enabled ? 'installed' : 'disabled';
      if (record.scope === 'project' && !trusted) {
        packageDiagnostics.push({
          severity: 'warning',
          code: 'PROJECT_TRUST_REQUIRED',
          source: record.source,
          message: 'Les ressources projet restent inactives tant que le workspace n’est pas approuvé.',
        });
      } else {
        try {
          const installed = await this.resolveInstalled(record);
          inventory = await inventoryPackage(installed.root, installed.displayRoot, installed.standaloneFile);
          status = record.enabled ? 'active' : 'disabled';
        } catch (error) {
          const missing = ['ENOENT', 'NOT_FOUND'].includes(String((error as NodeJS.ErrnoException).code));
          status = missing ? 'missing' : 'error';
          packageDiagnostics.push({
            severity: 'error',
            code: missing ? 'PLUGIN_MISSING' : 'PLUGIN_INVENTORY_FAILED',
            source: record.source,
            message: missing ? 'Le package installé est introuvable.' : 'L’inventaire du package a échoué.',
          });
        }
      }
      diagnostics.push(...packageDiagnostics);
      packages.push({
        key: record.key,
        source: record.source,
        sourceType: record.sourceType,
        scope: record.scope,
        enabled: record.enabled,
        trusted,
        canCheckForUpdates: record.sourceType !== 'path',
        ...(record.localPath ? { installedPath: record.localPath } : record.managedRelativePath
          ? { installedPath: `plugins/${record.managedRelativePath.split(path.sep).join('/')}` }
          : {}),
        ...(inventory.packageName ?? record.packageName ? { packageName: inventory.packageName ?? record.packageName } : {}),
        ...(inventory.version ?? record.version ? { version: inventory.version ?? record.version } : {}),
        ...(record.configuredVersion ? { configuredVersion: record.configuredVersion } : {}),
        ...(inventory.description ?? record.description ? { description: inventory.description ?? record.description } : {}),
        ...(record.installedRevision ? { installedRevision: record.installedRevision } : {}),
        counts: inventory.counts,
        resources: inventory.resources.map(({ absolutePath: _absolutePath, ...resource }) => resource),
        diagnostics: packageDiagnostics,
        status,
        restartRequired: record.enabled && trusted && inventory.counts.extensions > 0,
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
      });
    }
    packages.sort((left, right) => Number(left.scope === 'global') - Number(right.scope === 'global')
      || left.source.localeCompare(right.source));

    const globalExtensions = await standaloneExtensions(
      path.join(this.dataDir, 'extensions'), '~/.ai-harness/extensions', 'global', true,
    );
    const projectExtensions = await standaloneExtensions(
      path.join(context.cwd, '.ai-harness', 'extensions'), '.ai-harness/extensions', 'project', context.projectTrusted,
    );
    const standalone = [...projectExtensions, ...globalExtensions];
    const totals = countsFor([
      ...packages.filter(item => item.enabled && item.trusted && item.status === 'active').flatMap(item => item.resources),
      ...standalone.filter(item => item.enabled),
    ]);
    return {
      updatedAt: new Date().toISOString(),
      generation,
      cwd: context.cwd,
      projectId: context.projectId,
      projectTrusted: context.projectTrusted,
      projectResourcesLoaded: context.projectTrusted,
      packages,
      standaloneExtensions: standalone,
      totals,
      diagnostics,
    };
  }

  private async resolveInstalled(record: StoredPlugin): Promise<{
    root: string;
    standaloneFile?: string;
    displayRoot: string;
  }> {
    if (record.sourceType === 'path') {
      const canonical = await this.workspaceManager.resolve(record.localPath!, { kind: 'any' });
      const original = await lstat(record.localPath!);
      if (original.isSymbolicLink()) throw new Error('Symbolic plugin root rejected');
      const info = await lstat(canonical);
      return info.isFile()
        ? { root: path.dirname(canonical), standaloneFile: canonical, displayRoot: canonical }
        : { root: canonical, displayRoot: canonical };
    }
    const installation = this.managedPath(record);
    const root = path.join(installation, record.packageRelativePath!);
    const canonicalInstallation = await realpath(installation);
    const canonicalRoot = await realpath(root);
    if (!inside(canonicalInstallation, canonicalRoot)) throw new Error('Package root escaped managed installation');
    return {
      root: canonicalRoot,
      displayRoot: `plugins/${record.managedRelativePath!.split(path.sep).join('/')}`,
    };
  }

  private managedPath(record: StoredPlugin): string {
    if (!validRelativePath(record.managedRelativePath)) throw new Error('Invalid managed plugin path');
    const result = path.resolve(this.pluginRoot, record.managedRelativePath);
    if (!inside(path.resolve(this.pluginRoot), result)) throw new Error('Managed plugin path escaped its root');
    return result;
  }

  private visibleRecords(context: PluginContext): StoredPlugin[] {
    return this.state.packages.filter(record => record.scope === 'global' || record.projectId === context.projectId);
  }

  private findMutable(key: string, scope: PluginScope, context: PluginContext): StoredPlugin {
    if (!/^(?:global|project):[a-zA-Z0-9._:-]{1,200}:[a-f0-9]{20}$/.test(key)) {
      throw httpError('Identifiant de package invalide.', 400, 'INVALID_PLUGIN_KEY');
    }
    const record = this.state.packages.find(candidate => candidate.key === key
      && candidate.scope === scope
      && (candidate.scope === 'global' || candidate.projectId === context.projectId));
    if (!record) throw httpError('Package introuvable.', 404, 'PLUGIN_NOT_FOUND');
    return record;
  }

  private requireTrustedMutation(scope: PluginScope, context: PluginContext, action: string): void {
    if (scope === 'project' && !context.projectTrusted) throw httpError(
      `Le workspace doit être approuvé avant de ${action} un plugin projet.`,
      409,
      'PROJECT_TRUST_REQUIRED',
    );
  }

  private async context(input: PluginContextInput): Promise<PluginContext> {
    const cwd = await this.workspaceManager.resolve(
      input.cwd ?? await this.workspaceManager.getDefaultCwd(),
      { kind: 'directory' },
    );
    const descriptor = await this.workspaceManager.describe(cwd, await this.trustManager.isTrusted(cwd));
    if (input.projectId && input.projectId !== descriptor.id) throw httpError(
      'Workspace identifier does not match cwd.', 400, 'WORKSPACE_MISMATCH',
    );
    return { cwd, projectId: descriptor.id, projectTrusted: descriptor.trusted };
  }

  private validStored(value: unknown): value is StoredPlugin {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Partial<StoredPlugin>;
    return typeof record.key === 'string'
      && /^(?:global|project):[a-zA-Z0-9._:-]{1,200}:[a-f0-9]{20}$/.test(record.key)
      && typeof record.source === 'string' && record.source.length <= 1_000 && !CONTROL_CHARACTERS.test(record.source)
      && ['npm', 'git', 'path'].includes(record.sourceType ?? '')
      && (record.scope === 'global' || record.scope === 'project')
      && (record.scope !== 'project' || (typeof record.projectId === 'string' && /^[a-f0-9]{24}$/.test(record.projectId)))
      && typeof record.enabled === 'boolean'
      && (record.sourceType === 'path'
        ? typeof record.localPath === 'string' && path.isAbsolute(record.localPath)
        : validRelativePath(record.managedRelativePath) && validRelativePath(record.packageRelativePath))
      && typeof record.installedAt === 'string'
      && typeof record.updatedAt === 'string';
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.stateFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async queued<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    let failure: unknown;
    const execute = async () => {
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
