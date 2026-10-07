import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { readStableDirectoryEntries } from '../security/stable-directory.js';
import { releaseStableLockPath } from '../security/stable-lock.js';
import { promisify } from 'node:util';
import type {
  PluginCatalog,
  PluginDiagnostic,
  PluginEnableBatchResult,
  PluginEnableChange,
  PluginEnableOutcome,
  PluginPackageInfo,
  PluginReloadResult,
  PluginResourceCounts,
  PluginResourceFilters,
  PluginResourceInfo,
  PluginResourceKind,
  PluginScope,
  PluginSourceType,
  PluginStandaloneExtensionInfo,
  PluginUpdateResult,
} from '../types/index.js';
import type { ProjectTrustManager } from '../security/project-trust.js';
import type { WorkspaceManager } from '../security/workspace-manager.js';
import { filteredProcessEnvironment } from '../tools/process-execution.js';

const execFileAsync = promisify(execFile);
const FILE_VERSION = 1 as const;
const MAX_PACKAGES = 100;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_DEPTH = 8;
const MAX_RESOURCES = 1_000;
const MAX_PATTERNS = 100;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_CACHE = 16;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;
const STALE_LOCK_MS = 30_000;
const INSTALL_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 20_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UNSAFE_METADATA_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/;
const PLUGIN_KEY_PATTERN = /^(?:global|project):[a-zA-Z0-9._:-]{1,200}:[a-f0-9]{20}$/;
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
  resourceFilters?: PluginResourceFilters;
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
  /** Trusted internal callers may apply a one-process decision; HTTP adapters never accept this field. */
  projectTrusted?: boolean;
}

export interface PluginMutationInput extends PluginContextInput {
  scope: PluginScope;
}

export interface PluginSkillRoot {
  directory: string;
  scope: PluginScope;
  source: string;
  displayRoot: string;
  trusted: boolean;
}

export interface PluginResourceLocation {
  kind: PluginResourceKind;
  path: string;
  /** Sanitized catalogue path retained for adapters that expose metadata. */
  displayPath: string;
  source: string;
  scope: PluginScope;
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
    .replace(new RegExp(UNSAFE_METADATA_CHARACTERS.source, 'g'), ' ')
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

function isWorkspaceControlledPackage(record: StoredPlugin, context: PluginContext): boolean {
  return Boolean(record.localPath && inside(context.cwd, path.resolve(record.localPath)));
}

function cloneCatalog(catalog: PluginCatalog): PluginCatalog {
  return structuredClone(catalog);
}

function validatedEnableChanges(value: unknown): PluginEnableChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PACKAGES) {
    throw httpError('Lot d’activation de packages invalide.', 400, 'INVALID_PLUGIN_BATCH');
  }
  const selectors = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw httpError('Lot d’activation de packages invalide.', 400, 'INVALID_PLUGIN_BATCH');
    }
    const change = item as Partial<PluginEnableChange>;
    if (typeof change.key !== 'string' || !PLUGIN_KEY_PATTERN.test(change.key)
      || (change.scope !== 'global' && change.scope !== 'project')
      || typeof change.enabled !== 'boolean') {
      throw httpError('Lot d’activation de packages invalide.', 400, 'INVALID_PLUGIN_BATCH');
    }
    const selector = `${change.scope}:${change.key}`;
    if (selectors.has(selector)) {
      throw httpError('Le lot contient un package en double.', 400, 'INVALID_PLUGIN_BATCH');
    }
    selectors.add(selector);
    return { key: change.key, scope: change.scope, enabled: change.enabled };
  });
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
export function parsePluginSource(input: string, baseDirectory = process.cwd()): ParsedPluginSource {
  const source = input.trim();
  if (!source || source.length > 1_000 || CONTROL_CHARACTERS.test(source)) {
    throw httpError('Source de plugin invalide.', 400, 'INVALID_PLUGIN_SOURCE');
  }
  if (source.startsWith('npm:')) return parseNpmSource(source);
  if (source.startsWith('git:')) return parseGitSource(source);
  if (!path.isAbsolute(source) && !source.startsWith('./') && !source.startsWith('../')) {
    throw httpError('Utilisez npm:, git: ou un chemin local explicite.', 400, 'INVALID_PLUGIN_SOURCE');
  }
  const normalized = path.resolve(baseDirectory, source);
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
          env: filteredProcessEnvironment(),
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
  if (pattern.startsWith('!')) {
    exclude = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('-')) {
    exclude = true;
    exact = true;
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

function validateResourceFilters(value: unknown): PluginResourceFilters | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError('Filtres de ressources invalides.', 400, 'INVALID_PLUGIN_FILTERS');
  }
  const allowed = new Set(['extensions', 'skills', 'prompts', 'themes']);
  const result: PluginResourceFilters = {};
  for (const [field, entries] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(field) || !Array.isArray(entries) || entries.length > MAX_PATTERNS) {
      throw httpError('Filtres de ressources invalides.', 400, 'INVALID_PLUGIN_FILTERS');
    }
    const normalized = entries.map(entry => {
      normalizedPattern(entry);
      return entry as string;
    });
    Object.assign(result, { [field]: [...new Set(normalized)] });
  }
  return result;
}

function selectedByPatterns(
  candidate: { relativePath: string },
  alternatePath: string,
  patterns: ReturnType<typeof normalizedPattern>[] | undefined,
  defaultSelected: boolean,
): boolean {
  if (patterns === undefined) return defaultSelected;
  if (patterns.length === 0) return false;
  const included = patterns.filter(pattern => !pattern.exclude);
  const selected = included.length === 0 || included.some(pattern => (
    patternMatches(candidate.relativePath, pattern) || patternMatches(alternatePath, pattern)
  ));
  return selected && !patterns.some(pattern => pattern.exclude && (
    patternMatches(candidate.relativePath, pattern) || patternMatches(alternatePath, pattern)
  ));
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
    let entries: import('node:fs').Dirent[];
    try {
      const listing = await readStableDirectoryEntries(directory, entriesRemaining);
      entries = listing.entries;
      truncated ||= listing.truncated;
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entriesRemaining-- <= 0 || files.length >= MAX_SCAN_FILES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink() || UNSAFE_METADATA_CHARACTERS.test(entry.name)) continue;
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

async function readPackageText(filePath: string, maxBytes: number): Promise<string> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error('Package resource is not a bounded regular file without links');
  }
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev
      || opened.ino !== before.ino || opened.size !== before.size || opened.size > maxBytes) {
      throw new Error('Package resource changed while it was being opened');
    }
    const contents = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(contents, offset, contents.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const [after, target] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (offset !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || !target.isFile() || target.isSymbolicLink() || target.nlink !== 1
      || target.dev !== after.dev || target.ino !== after.ino || target.size !== after.size
      || target.mtimeMs !== after.mtimeMs || target.ctimeMs !== after.ctimeMs) {
      throw new Error('Package resource changed while it was being read');
    }
    const bounded = contents.subarray(0, offset);
    if (bounded.includes(0)) throw new Error('Package resource must be UTF-8 text');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bounded).replace(/^\ufeff/, ''); }
    catch { throw new Error('Package resource must be UTF-8 text'); }
  } finally {
    await handle.close();
  }
}

async function readPackageManifest(root: string): Promise<Record<string, unknown>> {
  const manifestPath = path.join(root, 'package.json');
  try { await lstat(manifestPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(await readPackageText(manifestPath, MAX_MANIFEST_BYTES)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid package manifest');
  return parsed as Record<string, unknown>;
}

async function inventoryPackage(
  root: string,
  displayRoot: string,
  standaloneFile?: string,
  resourceFilters?: PluginResourceFilters,
): Promise<PackageInventory> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Plugin package root is not a safe directory');
  const manifest = standaloneFile ? {} : await readPackageManifest(root);
  const legacyManifest = manifest.pi && typeof manifest.pi === 'object' && !Array.isArray(manifest.pi)
    ? manifest.pi as Record<string, unknown>
    : {};
  const nativeManifest = manifest.aiHarness && typeof manifest.aiHarness === 'object' && !Array.isArray(manifest.aiHarness)
    ? manifest.aiHarness as Record<string, unknown>
    : {};
  const resourceManifest = { ...legacyManifest, ...nativeManifest };
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
    const configured = resourceManifest[field];
    if (configured !== undefined && (!Array.isArray(configured) || configured.length > MAX_PATTERNS)) {
      throw new Error(`Invalid ${field} package manifest entry`);
    }
    const patterns = configured === undefined ? undefined : configured.map(normalizedPattern);
    const userPatterns = resourceFilters?.[field as keyof PluginResourceFilters]?.map(normalizedPattern);
    const unique = new Map<string, { relativePath: string; absolutePath: string }>();
    for (const candidate of candidates) {
      const skillDocument = kind === 'skill'
        ? `${candidate.relativePath ? `${candidate.relativePath}/` : ''}SKILL.md`
        : candidate.relativePath;
      const manifestSelected = standaloneFile && kind === 'extension'
        ? true
        : selectedByPatterns(candidate, skillDocument, patterns, conventional(candidate, kind));
      const selected = manifestSelected
        && selectedByPatterns(candidate, skillDocument, userPatterns, true);
      if (selected) unique.set(candidate.absolutePath, candidate);
    }
    for (const candidate of unique.values()) {
      if (resources.length >= MAX_RESOURCES) break;
      const relativePath = candidate.relativePath || path.posix.basename(candidate.absolutePath);
      resources.push({
        kind,
        name: resourceName(kind, relativePath),
        relativePath,
        path: standaloneFile
          ? displayRoot
          : `${displayRoot.replace(/\/$/, '')}/${relativePath}`,
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
  let entries: import('node:fs').Dirent[];
  try {
    entries = (await readStableDirectoryEntries(directory, 201)).entries;
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile() && !entry.isSymbolicLink()
      && !UNSAFE_METADATA_CHARACTERS.test(entry.name)
      && EXTENSION_SUFFIXES.has(path.extname(entry.name).toLowerCase()))
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

function validStoredText(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max && cleanText(value, max) === value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 50 && Number.isFinite(Date.parse(value));
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function readBoundedStateFile(filePath: string): Promise<unknown | undefined> {
  let before;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1
    || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    throw new Error('Plugin state must be a private regular file without links.');
  }
  if (before.size > MAX_STATE_BYTES) throw new Error('Plugin state exceeds its size limit.');

  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    let opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.size > MAX_STATE_BYTES
      || (typeof process.getuid === 'function' && opened.uid !== process.getuid())) {
      throw new Error('Plugin state changed while it was being opened.');
    }
    if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
      await handle.chmod(0o600);
      opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || (opened.mode & 0o077) !== 0) {
        throw new Error('Plugin state permissions could not be secured.');
      }
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const [after, target] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (offset !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
      || after.nlink !== 1 || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || !target.isFile() || target.isSymbolicLink() || target.nlink !== 1
      || target.dev !== after.dev || target.ino !== after.ino || target.size !== after.size
      || target.mtimeMs !== after.mtimeMs || target.ctimeMs !== after.ctimeMs) {
      throw new Error('Plugin state changed while it was being read.');
    }
    const contents = bytes.subarray(0, offset);
    if (contents.includes(0)) throw new Error('Plugin state must be UTF-8 JSON.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents).replace(/^\ufeff/, ''); }
    catch { throw new Error('Plugin state must be UTF-8 JSON.'); }
    return JSON.parse(text) as unknown;
  } finally {
    await handle.close();
  }
}

async function removeStalePluginLock(
  lockPath: string,
  observed: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  const stalePath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.stale`;
  try {
    await rename(lockPath, stalePath);
    const moved = await lstat(stalePath);
    if (moved.dev !== observed.dev || moved.ino !== observed.ino || moved.nlink !== 1
      || moved.mtimeMs !== observed.mtimeMs || Date.now() - moved.mtimeMs <= STALE_LOCK_MS) {
      const replacement = await lstat(lockPath).catch(() => undefined);
      if (!replacement) await rename(stalePath, lockPath).catch(() => undefined);
      return;
    }
    await rm(stalePath, { force: true });
  } catch {
    const replacement = await lstat(lockPath).catch(() => undefined);
    if (!replacement) await rename(stalePath, lockPath).catch(() => undefined);
  }
}

async function acquirePluginLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const handle = await open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const owned = await handle.stat().catch(async error => {
        await handle.close().catch(() => undefined);
        throw error;
      });
      if (!owned.isFile() || owned.nlink !== 1
        || (process.platform !== 'win32' && (owned.mode & 0o077) !== 0)
        || (typeof process.getuid === 'function' && owned.uid !== process.getuid())) {
        await handle.close().catch(() => undefined);
        throw new Error('Plugin state lock is unsafe.');
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => undefined);
      }, Math.max(1_000, Math.floor(STALE_LOCK_MS / 3)));
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await handle.close().catch(() => undefined);
        await releaseStableLockPath(lockPath, owned);
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      try {
        const info = await lstat(lockPath);
        if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1
          || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
          || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
          throw new Error('Plugin state lock is unsafe.');
        }
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await removeStalePluginLock(lockPath, info);
          continue;
        }
      } catch (lockError) {
        if (errorCode(lockError) === 'ENOENT') continue;
        throw lockError;
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw httpError('Plugin state is busy.', 409, 'PLUGIN_STATE_BUSY');
}

/** Secure, explicit package installer and metadata-only resource catalogue shared by CLI and Server. */
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
      await this.refreshState();
    } catch {
      console.error('[Plugins] Refusing invalid state.');
    }
  }

  async getCatalog(input: PluginContextInput & { refresh?: boolean } = {}): Promise<PluginCatalog> {
    await this.refreshState();
    const context = await this.context(input);
    const cached = this.catalogCache.get(context.cwd);
    if (cached && !input.refresh && cached.projectTrusted === context.projectTrusted) {
      this.catalogCache.delete(context.cwd);
      this.catalogCache.set(context.cwd, cached);
      return cloneCatalog(cached);
    }
    const catalog = await this.scanCatalog(context, this.state.generation);
    this.catalogCache.delete(context.cwd);
    this.catalogCache.set(context.cwd, catalog);
    while (this.catalogCache.size > MAX_CATALOG_CACHE) {
      const oldest = this.catalogCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.catalogCache.delete(oldest);
    }
    return cloneCatalog(catalog);
  }

  async install(
    input: PluginMutationInput & { source: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalog> {
    return this.queued(async () => {
      const context = await this.context(input);
      const parsed = parsePluginSource(input.source, context.cwd);
      this.requireTrustedMutation(input.scope, context, 'installer');
      if (parsed.localPath && inside(context.cwd, path.resolve(parsed.localPath)) && !context.projectTrusted) {
        throw httpError(
          'Le workspace doit être approuvé avant de lire un plugin local au projet.',
          409,
          'PROJECT_TRUST_REQUIRED',
        );
      }
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
      return this.getCatalog({
        cwd: context.cwd,
        projectId: context.projectId,
        projectTrusted: context.projectTrusted,
        refresh: true,
      });
    });
  }

  async setEnabled(
    input: PluginMutationInput & { key: string; enabled: boolean },
  ): Promise<PluginCatalog> {
    return this.queued(async () => {
      const context = await this.context(input);
      const record = this.findMutable(input.key, input.scope, context);
      if (input.enabled) {
        this.requireTrustedMutation(record.scope, context, 'activer');
        if (isWorkspaceControlledPackage(record, context) && !context.projectTrusted) {
          throw httpError(
            'Le workspace doit être approuvé avant d’activer ce package local.',
            409,
            'PROJECT_TRUST_REQUIRED',
          );
        }
      }
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
      return this.getCatalog({
        cwd: context.cwd,
        projectId: context.projectId,
        projectTrusted: context.projectTrusted,
        refresh: true,
      });
    });
  }

  /** Apply one bounded group change under a single lock/write while reporting policy failures per package. */
  async setEnabledBatch(
    input: PluginContextInput & { changes: readonly PluginEnableChange[] },
  ): Promise<PluginEnableBatchResult> {
    const changes = validatedEnableChanges(input.changes);
    return this.queued(async () => {
      const context = await this.context(input);
      const initial = await this.scanCatalog(context, this.state.generation);
      const initialPackages = new Map(initial.packages.map(pkg => [`${pkg.scope}:${pkg.key}`, pkg]));
      const records = this.visibleRecords(context);
      const snapshots: Array<{ record: StoredPlugin; enabled: boolean; updatedAt: string }> = [];
      const outcomes: PluginEnableOutcome[] = [];
      const updatedAt = new Date().toISOString();

      for (const change of changes) {
        const record = records.find(candidate => candidate.key === change.key && candidate.scope === change.scope);
        if (!record) {
          outcomes.push({
            ...change,
            state: 'failed',
            code: 'PLUGIN_NOT_FOUND',
            message: 'Package introuvable.',
          });
          continue;
        }
        if (change.enabled && !context.projectTrusted
          && (record.scope === 'project' || isWorkspaceControlledPackage(record, context))) {
          outcomes.push({
            ...change,
            state: 'failed',
            code: 'PROJECT_TRUST_REQUIRED',
            message: 'Le workspace doit être approuvé avant d’activer ce package projet.',
          });
          continue;
        }
        if (record.enabled === change.enabled) {
          outcomes.push({ ...change, state: 'unchanged' });
          continue;
        }
        snapshots.push({ record, enabled: record.enabled, updatedAt: record.updatedAt });
        record.enabled = change.enabled;
        record.updatedAt = updatedAt;
        outcomes.push({ ...change, state: 'changed' });
      }

      if (snapshots.length > 0) {
        try {
          await this.persist();
        } catch (error) {
          for (const snapshot of snapshots) {
            snapshot.record.enabled = snapshot.enabled;
            snapshot.record.updatedAt = snapshot.updatedAt;
          }
          throw error;
        }
        this.invalidate();
      }

      const reloadRequired = snapshots.some(snapshot => {
        // Never reopen an untrusted project package merely to classify cleanup. Its prior runtime
        // generation may still contain executable code, so disabling it conservatively requires reload.
        if (snapshot.record.scope === 'project' && !context.projectTrusted) return true;
        return (initialPackages.get(`${snapshot.record.scope}:${snapshot.record.key}`)?.counts.extensions ?? 0) > 0;
      });
      const catalog = await this.getCatalog({
        cwd: context.cwd,
        projectId: context.projectId,
        projectTrusted: context.projectTrusted,
        refresh: true,
      });
      return { catalog, outcomes, reloadRequired };
    });
  }

  async configure(
    input: PluginMutationInput & { key: string; resourceFilters?: PluginResourceFilters },
  ): Promise<PluginCatalog> {
    const resourceFilters = validateResourceFilters(input.resourceFilters);
    return this.queued(async () => {
      const context = await this.context(input);
      const record = this.findMutable(input.key, input.scope, context);
      this.requireTrustedMutation(record.scope, context, 'configurer');
      const previous = {
        resourceFilters: record.resourceFilters,
        updatedAt: record.updatedAt,
      };
      record.resourceFilters = resourceFilters === undefined ? undefined : structuredClone(resourceFilters);
      record.updatedAt = new Date().toISOString();
      try {
        await this.persist();
      } catch (error) {
        record.resourceFilters = previous.resourceFilters;
        record.updatedAt = previous.updatedAt;
        throw error;
      }
      this.invalidate();
      return this.getCatalog({
        cwd: context.cwd,
        projectId: context.projectId,
        projectTrusted: context.projectTrusted,
        refresh: true,
      });
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
          const managedInfo = await lstat(managed);
          if (managedInfo.isSymbolicLink() || !managedInfo.isDirectory()) {
            throw new Error('Managed package must be a real directory');
          }
          const canonicalRoot = await realpath(this.pluginRoot).catch(() => this.pluginRoot);
          const canonicalManaged = await realpath(managed);
          if (!inside(canonicalRoot, canonicalManaged)) throw new Error('Managed package escaped plugin root');
          trashPath = path.join(this.pluginRoot, `.trash-${crypto.randomUUID()}`);
          await rename(managed, trashPath);
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
      return this.getCatalog({
        cwd: context.cwd,
        projectId: context.projectId,
        projectTrusted: context.projectTrusted,
        refresh: true,
      });
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
      return this.getCatalog({
        cwd: context.cwd,
        projectId: context.projectId,
        projectTrusted: context.projectTrusted,
        refresh: true,
      });
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
        projectTrusted: initial.projectTrusted,
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
    await this.refreshState();
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
    await this.refreshState();
    const context = await this.context(input);
    for (const record of [...this.visibleRecords(context)].reverse()) {
      if (!record.enabled || (!context.projectTrusted
        && (record.scope === 'project' || isWorkspaceControlledPackage(record, context)))) continue;
      try {
        const { root, standaloneFile, displayRoot } = await this.resolveInstalled(record);
        const inventory = await inventoryPackage(root, displayRoot, standaloneFile, record.resourceFilters);
        const resource = inventory.resources.find(item => item.kind === 'prompt' && item.name.toLowerCase() === requested);
        if (!resource) continue;
        return {
          content: await readPackageText(resource.absolutePath, MAX_MANIFEST_BYTES),
          source: record.source,
        };
      } catch {
        // Continue to a lower-precedence package when a prompt became unreadable.
      }
    }
    return undefined;
  }

  /** Return trusted, enabled package resources without reading their bodies. */
  async getEnabledResourceLocations(
    kind: PluginResourceKind,
    input: PluginContextInput = {},
  ): Promise<PluginResourceLocation[]> {
    await this.refreshState();
    const context = await this.context(input);
    const locations: PluginResourceLocation[] = [];
    const records = this.visibleRecords(context).sort((left, right) => (
      Number(left.scope === 'project') - Number(right.scope === 'project')
      || left.source.localeCompare(right.source)
    ));
    for (const record of records) {
      if (!record.enabled || (!context.projectTrusted
        && (record.scope === 'project' || isWorkspaceControlledPackage(record, context)))) continue;
      try {
        const { root, standaloneFile, displayRoot } = await this.resolveInstalled(record);
        const inventory = await inventoryPackage(root, displayRoot, standaloneFile, record.resourceFilters);
        for (const resource of inventory.resources.filter(item => item.kind === kind)) {
          if (kind === 'extension' && !['.js', '.mjs'].includes(path.extname(resource.absolutePath).toLowerCase())) continue;
          locations.push({
            kind,
            path: resource.absolutePath,
            displayPath: resource.path,
            source: record.source,
            scope: record.scope,
            trusted: record.scope === 'global' || context.projectTrusted,
          });
          if (locations.length >= MAX_RESOURCES) return locations;
        }
      } catch {
        // Invalid packages remain visible through catalogue diagnostics but are never consumed.
      }
    }
    return locations;
  }

  /** Executable files are consumed only by a trusted Core module-loader composition root. */
  async getEnabledExtensionFiles(input: PluginContextInput = {}): Promise<string[]> {
    return [...new Set((await this.getEnabledResourceLocations('extension', input))
      .map(location => location.path))].sort();
  }

  /** Package skill roots are consumed internally; their instruction bodies never enter the plugin API. */
  async getEnabledSkillRoots(input: PluginContextInput = {}): Promise<PluginSkillRoot[]> {
    return (await this.getEnabledResourceLocations('skill', input)).map(location => ({
      directory: location.path,
      scope: location.scope,
      source: location.source,
      displayRoot: location.displayPath,
      trusted: location.trusted,
    }));
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
      ...(previous?.resourceFilters ? { resourceFilters: structuredClone(previous.resourceFilters) } : {}),
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
        )).stdout.trim();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(installedRevision)) {
          throw new Error('Git returned an invalid installed revision');
        }
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
      const availableVersion = selected?.trim().split(/\s+/)[0];
      if (!availableVersion || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(availableVersion)) {
        throw new Error('Git reference not found');
      }
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
      const workspaceControlled = isWorkspaceControlledPackage(record, context);
      const trusted = context.projectTrusted || (record.scope === 'global' && !workspaceControlled);
      const packageDiagnostics: PluginDiagnostic[] = [];
      let inventory: PackageInventory = { resources: [], counts: structuredClone(EMPTY_COUNTS) };
      let status: PluginPackageInfo['status'] = record.enabled ? 'installed' : 'disabled';
      if (!trusted) {
        packageDiagnostics.push({
          severity: 'warning',
          code: 'PROJECT_TRUST_REQUIRED',
          source: record.source,
          message: 'Les ressources projet restent inactives tant que le workspace n’est pas approuvé.',
        });
      } else {
        try {
          const installed = await this.resolveInstalled(record);
          inventory = await inventoryPackage(
            installed.root,
            installed.displayRoot,
            installed.standaloneFile,
            record.resourceFilters,
          );
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
        ...(record.resourceFilters ? { resourceFilters: structuredClone(record.resourceFilters) } : {}),
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
    const [pluginRootInfo, installationInfo, rootInfo] = await Promise.all([
      realpath(this.pluginRoot),
      lstat(installation),
      lstat(root),
    ]);
    if (installationInfo.isSymbolicLink() || !installationInfo.isDirectory()
      || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error('Managed package roots must be real directories');
    }
    const canonicalInstallation = await realpath(installation);
    const canonicalRoot = await realpath(root);
    if (!inside(pluginRootInfo, canonicalInstallation) || !inside(canonicalInstallation, canonicalRoot)) {
      throw new Error('Package root escaped managed installation');
    }
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
    if (!PLUGIN_KEY_PATTERN.test(key)) {
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
    const savedTrust = await this.trustManager.isTrusted(cwd);
    const descriptor = await this.workspaceManager.describe(cwd, input.projectTrusted ?? savedTrust);
    if (input.projectId && input.projectId !== descriptor.id) throw httpError(
      'Workspace identifier does not match cwd.', 400, 'WORKSPACE_MISMATCH',
    );
    return { cwd, projectId: descriptor.id, projectTrusted: descriptor.trusted };
  }

  private validStored(value: unknown): value is StoredPlugin {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Partial<StoredPlugin>;
    let filtersValid = true;
    try { validateResourceFilters(record.resourceFilters); }
    catch { filtersValid = false; }
    return filtersValid
      && typeof record.key === 'string'
      && PLUGIN_KEY_PATTERN.test(record.key)
      && typeof record.source === 'string' && record.source.length <= 1_000 && !CONTROL_CHARACTERS.test(record.source)
      && ['npm', 'git', 'path'].includes(record.sourceType ?? '')
      && (record.scope === 'global' || record.scope === 'project')
      && (record.scope !== 'project' || (typeof record.projectId === 'string' && /^[a-f0-9]{24}$/.test(record.projectId)))
      && typeof record.enabled === 'boolean'
      && (record.sourceType === 'path'
        ? typeof record.localPath === 'string' && record.localPath.length <= 1_000
          && !CONTROL_CHARACTERS.test(record.localPath) && path.isAbsolute(record.localPath)
          && record.source === record.localPath
        : validRelativePath(record.managedRelativePath) && validRelativePath(record.packageRelativePath))
      && validStoredText(record.packageName, 214)
      && validStoredText(record.version, 100)
      && validStoredText(record.configuredVersion, 200)
      && validStoredText(record.description, 500)
      && (record.installedRevision === undefined
        || (typeof record.installedRevision === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(record.installedRevision)))
      && validTimestamp(record.installedAt)
      && validTimestamp(record.updatedAt);
  }

  private async refreshState(): Promise<void> {
    const value = await readBoundedStateFile(this.stateFile);
    let next: PluginStateFile = { version: FILE_VERSION, generation: 0, packages: [] };
    if (value !== undefined) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Plugin state must contain an object.');
      }
      const parsed = value as Partial<PluginStateFile>;
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.packages)
        || parsed.packages.length > MAX_PACKAGES
        || !Number.isSafeInteger(parsed.generation) || (parsed.generation ?? -1) < 0
        || !parsed.packages.every(record => this.validStored(record))) {
        throw new Error('Plugin state is invalid or uses an unsupported version.');
      }
      const keys = new Set(parsed.packages.map(record => record.key));
      if (keys.size !== parsed.packages.length) throw new Error('Plugin state contains duplicate package keys.');
      next = {
        version: FILE_VERSION,
        generation: parsed.generation!,
        packages: structuredClone(parsed.packages),
      };
    }
    if (JSON.stringify(next) !== JSON.stringify(this.state)) {
      this.state = next;
      this.invalidate();
    }
  }

  private async persist(): Promise<void> {
    // Capture synchronously so a concurrent catalogue refresh cannot replace the
    // in-memory object between a mutation and its atomic write.
    const contents = `${JSON.stringify(this.state, null, 2)}\n`;
    if (Buffer.byteLength(contents, 'utf8') > MAX_STATE_BYTES) {
      throw new Error('Plugin state exceeds its size limit.');
    }
    await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    let closed = false;
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(temporary, this.stateFile);
    } finally {
      if (!closed) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }

  private async queued<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    let failure: unknown;
    const execute = async (): Promise<void> => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquirePluginLock(this.stateFile);
        await this.refreshState();
        result = await operation();
      } catch (error) {
        failure = error;
      } finally {
        await release?.().catch(error => { failure ??= error; });
      }
    };
    this.mutation = this.mutation.then(execute, execute);
    await this.mutation;
    if (failure) throw failure;
    return result;
  }
}
