import { createHash } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SkillRegistry, SkillRegistryEntry } from '@ai-harness/core';
import type { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import type { SkillCatalogService } from './skill-catalog.js';

const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_ENTRIES = 2_000;
const CACHE_TTL_MS = 5 * 60_000;

interface RegistryDocument {
  version?: number;
  skills?: unknown[];
}

function invalid(message: string, code = 'INVALID_SKILL_REGISTRY'): never {
  throw Object.assign(new Error(message), { status: 400, code });
}

function safeName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,119}$/.test(value)) invalid('Skill name is invalid.');
  return value;
}

function validVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,99}$/.test(value)) invalid('Skill version is invalid.');
  return value;
}

function registryUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_000) invalid('Registry URL is invalid.');
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.protocol === 'http:')) {
    invalid('Registry downloads require HTTPS.');
  }
  if (url.username || url.password) invalid('Registry URLs cannot contain credentials.');
  return url.toString();
}

function compareVersions(left: string | undefined, right: string): number {
  if (!left) return -1;
  const tokenize = (value: string) => value.split(/[.+_-]/).map(part => /^\d+$/.test(part) ? Number(part) : part.toLowerCase());
  const a = tokenize(left);
  const b = tokenize(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av < bv ? -1 : 1;
    return String(av).localeCompare(String(bv));
  }
  return 0;
}

async function assertNoSymlink(boundary: string, destination: string): Promise<void> {
  const relative = path.relative(boundary, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) invalid('Skill destination escapes its scope.', 'SKILL_PATH_ESCAPE');
  let current = boundary;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) invalid('Symbolic links are forbidden in a skill destination.', 'SKILL_SYMLINK_REJECTED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function boundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok) throw new Error(`Registry request failed (${response.status}).`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Registry response is too large.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error('Registry response is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Read-only HTTPS registry plus explicit, atomic Agent Skill installs. */
export class SkillRegistryService {
  private cached?: { entries: SkillRegistryEntry[]; source: string; updatedAt: string; expiresAt: number };
  private refreshPromise?: Promise<SkillRegistry>;

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly trustManager: ProjectTrustManager,
    private readonly skillCatalog: SkillCatalogService,
    private readonly dataDir: string,
    private readonly source = process.env.AI_HARNESS_SKILL_REGISTRY_URL ?? '',
  ) {}

  async search(input: { query?: string; cwd?: string; projectId?: string; refresh?: boolean } = {}): Promise<SkillRegistry> {
    if (!this.source) return {
      source: 'not configured',
      updatedAt: new Date(0).toISOString(),
      entries: [],
      error: 'Set AI_HARNESS_SKILL_REGISTRY_URL to an HTTPS Agent Skills registry index.',
    };
    if (!input.refresh && this.cached && this.cached.expiresAt > Date.now()) {
      return this.withInstalled(this.cached, input);
    }
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refresh(input).finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  async install(input: {
    id: string;
    scope: 'global' | 'project';
    cwd?: string;
    projectId?: string;
  }): Promise<{ entry: SkillRegistryEntry; path: string }> {
    const registry = await this.search({ cwd: input.cwd, projectId: input.projectId, refresh: true });
    const entry = registry.entries.find(candidate => candidate.id === input.id);
    if (!entry) throw Object.assign(new Error('Registry skill not found.'), { status: 404, code: 'SKILL_NOT_FOUND' });
    const destination = await this.destination(entry.name, input);
    const boundary = input.scope === 'global'
      ? path.resolve(this.dataDir)
      : await this.workspaceManager.resolve(input.cwd ?? await this.workspaceManager.getDefaultCwd(), { kind: 'directory' });
    await assertNoSymlink(boundary, destination);
    const response = await fetch(registryUrl(entry.downloadUrl), { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const content = await boundedResponse(response, MAX_SKILL_BYTES);
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== entry.sha256!.toLowerCase()) {
      throw Object.assign(new Error('Skill checksum does not match the registry.'), { status: 502, code: 'SKILL_INTEGRITY_FAILED' });
    }
    this.validateDocument(content, entry);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const staging = `${destination}.staging-${crypto.randomUUID()}`;
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await writeFile(path.join(staging, 'SKILL.md'), content, { mode: 0o600 });
    const backup = `${destination}.backup-${crypto.randomUUID()}`;
    let hadPrevious = false;
    try {
      try {
        const info = await lstat(destination);
        if (info.isSymbolicLink()) invalid('Refusing to replace a symbolic-link skill destination.', 'SKILL_SYMLINK_REJECTED');
        await rename(destination, backup);
        hadPrevious = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(staging, destination);
      if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (hadPrevious) await rename(backup, destination).catch(() => undefined);
      throw error;
    }
    this.skillCatalog.invalidate(input.cwd);
    return { entry, path: path.join(destination, 'SKILL.md') };
  }

  async updateAll(input: { scope: 'global' | 'project'; cwd?: string; projectId?: string }): Promise<Array<{ id: string; updated: boolean; error?: string }>> {
    const registry = await this.search({ cwd: input.cwd, projectId: input.projectId, refresh: true });
    const candidates = registry.entries.filter(entry => entry.installed?.scope === input.scope && entry.installed.updateAvailable);
    const results: Array<{ id: string; updated: boolean; error?: string }> = [];
    for (const entry of candidates) {
      try {
        await this.install({ id: entry.id, ...input });
        results.push({ id: entry.id, updated: true });
      } catch (error) {
        results.push({ id: entry.id, updated: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  private async refresh(input: { query?: string; cwd?: string; projectId?: string }): Promise<SkillRegistry> {
    try {
      const source = registryUrl(this.source);
      const response = await fetch(source, { signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { Accept: 'application/json' } });
      const document = JSON.parse(await boundedResponse(response, MAX_INDEX_BYTES)) as RegistryDocument;
      if (!Array.isArray(document.skills) || document.skills.length > MAX_ENTRIES) throw new Error('Registry index has an invalid skills array.');
      const entries = document.skills.map((raw): SkillRegistryEntry => {
        if (!raw || typeof raw !== 'object') invalid('Registry entry is invalid.');
        const value = raw as Record<string, unknown>;
        const name = safeName(value.name);
        return {
          id: boundedId(value.id ?? name),
          name,
          description: typeof value.description === 'string' ? value.description.slice(0, 1_000) : name,
          version: validVersion(value.version),
          downloadUrl: registryUrl(value.downloadUrl),
          sha256: typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256)
            ? value.sha256.toLowerCase()
            : invalid('Registry skill requires a valid SHA-256 digest.'),
          ...(typeof value.homepage === 'string' ? { homepage: registryUrl(value.homepage) } : {}),
        };
      });
      this.cached = { entries, source, updatedAt: new Date().toISOString(), expiresAt: Date.now() + CACHE_TTL_MS };
    } catch (error) {
      if (!this.cached) return {
        source: this.source,
        updatedAt: new Date().toISOString(),
        entries: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return this.withInstalled(this.cached!, input);
  }

  private async withInstalled(
    cache: { entries: SkillRegistryEntry[]; source: string; updatedAt: string },
    input: { query?: string; cwd?: string; projectId?: string },
  ): Promise<SkillRegistry> {
    let catalog;
    try { catalog = await this.skillCatalog.getCatalog({ cwd: input.cwd, projectId: input.projectId }); }
    catch { catalog = undefined; }
    const query = input.query?.trim().toLocaleLowerCase() ?? '';
    return {
      source: cache.source,
      updatedAt: cache.updatedAt,
      entries: cache.entries.filter(entry => !query
        || entry.name.toLocaleLowerCase().includes(query)
        || entry.description.toLocaleLowerCase().includes(query))
        .map(entry => {
          const installed = catalog?.skills
            .filter(skill => skill.name === entry.name && (skill.scope === 'global' || skill.scope === 'project'))
            .sort((left, right) => left.scope === 'project' ? -1 : right.scope === 'project' ? 1 : 0)[0];
          return installed ? {
            ...entry,
            installed: {
              scope: installed.scope as 'global' | 'project',
              version: installed.version,
              updateAvailable: compareVersions(installed.version, entry.version) < 0,
            },
          } : entry;
        }),
    };
  }

  private async destination(name: string, input: { scope: 'global' | 'project'; cwd?: string; projectId?: string }): Promise<string> {
    if (input.scope === 'global') return path.join(this.dataDir, 'skills', safeName(name));
    const cwd = await this.workspaceManager.resolve(input.cwd ?? await this.workspaceManager.getDefaultCwd(), { kind: 'directory' });
    const trusted = await this.trustManager.isTrusted(cwd);
    if (!trusted) throw Object.assign(new Error('Project trust is required to install a project skill.'), { status: 409, code: 'PROJECT_TRUST_REQUIRED' });
    const descriptor = await this.workspaceManager.describe(cwd, trusted);
    if (input.projectId && input.projectId !== descriptor.id) invalid('Workspace identifier does not match cwd.', 'WORKSPACE_MISMATCH');
    return path.join(cwd, '.ai-harness', 'skills', safeName(name));
  }

  private validateDocument(content: string, entry: SkillRegistryEntry): void {
    const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (!normalized.startsWith('---\n')) invalid('Registry skill must use Agent Skills frontmatter.', 'INVALID_SKILL_DOCUMENT');
    const end = normalized.indexOf('\n---\n', 4);
    if (end < 0) invalid('Registry skill frontmatter is not closed.', 'INVALID_SKILL_DOCUMENT');
    const attributes = Object.fromEntries(normalized.slice(4, end).split('\n').flatMap(line => {
      const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      return match ? [[match[1].toLowerCase(), match[2].trim().replace(/^(['"])(.*)\1$/, '$2')]] : [];
    }));
    if (attributes.name !== entry.name || !attributes.description || !normalized.slice(end + 5).trim()) {
      invalid('Registry skill does not satisfy the Agent Skills name/description/body contract.', 'INVALID_SKILL_DOCUMENT');
    }
  }
}

function boundedId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(value)) invalid('Registry skill id is invalid.');
  return value;
}
