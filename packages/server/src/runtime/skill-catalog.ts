import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogScope,
  SkillDiagnostic,
} from '@ai-harness/core';
import type { ConfigurationStore } from '../config/config-store.js';
import { resolveEffectiveConfiguration } from '../config/effective-configuration.js';
import type { RuntimeServices } from './services.js';
import type { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SKILLS = 500;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_PATH_ROOTS = 32;
const MAX_DEPTH = 4;

interface SkillRoot {
  directory: string;
  scope: SkillCatalogScope;
  source: string;
  displayRoot: string;
  trusted: boolean;
}

export interface PackageSkillRoot {
  directory: string;
  source: string;
  displayRoot: string;
  trusted: boolean;
}

interface SkillRecord extends Omit<SkillCatalogEntry, 'modelInvocable'> {
  instructions: string;
}

interface ModelInvocableSkill {
  key: string;
  name: string;
  description: string;
  instructions: string;
  filePath: string;
}

interface CachedSkills {
  records: SkillRecord[];
  errorCount: number;
  diagnostics: SkillDiagnostic[];
  updatedAt: string;
  projectId: string;
  cwd: string;
  projectTrusted: boolean;
}

interface SkillDocument {
  attributes: Record<string, string>;
  body: string;
  frontmatter: boolean;
}

function parseDocument(source: string): SkillDocument {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { attributes: {}, body: normalized.trim(), frontmatter: false };
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return { attributes: {}, body: normalized.trim(), frontmatter: false };
  const attributes: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    attributes[match[1].toLowerCase()] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { attributes, body: normalized.slice(end + 5).trim(), frontmatter: true };
}

function normalizeName(value: string): string {
  const name = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z][a-z0-9:_-]*$/.test(name) || name.length > 120) {
    throw new Error('Invalid skill name');
  }
  return name;
}

function bounded(value: string | undefined, fallback: string, max: number): string {
  const normalized = value?.trim() || fallback;
  return normalized.slice(0, max);
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function findSkillFiles(
  root: string,
  budget: { files: number; entries: number },
): Promise<{ files: string[]; errors: number }> {
  if (budget.files <= 0 || budget.entries <= 0 || !await directoryExists(root)) return { files: [], errors: 0 };
  const files: string[] = [];
  let errors = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (budget.files <= 0 || budget.entries <= 0) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      errors++;
      return;
    }
    for (const item of entries) {
      if (budget.files <= 0 || budget.entries <= 0) break;
      budget.entries--;
      const itemPath = path.join(directory, item.name);
      if (item.isFile() && item.name.toLowerCase() === 'skill.md') {
        files.push(itemPath);
        budget.files--;
      } else if (item.isDirectory() && depth < MAX_DEPTH) await walk(itemPath, depth + 1);
    }
  }

  await walk(root, 0);
  return { files: files.sort(), errors };
}

function environmentPaths(name: string): string[] {
  return (process.env[name] ?? '')
    .split(path.delimiter)
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, MAX_PATH_ROOTS)
    .map(value => path.resolve(value));
}

function displayFile(filePath: string, root: SkillRoot): string {
  const relative = path.relative(root.directory, filePath).split(path.sep).join('/');
  return root.displayRoot ? `${root.displayRoot.replace(/\/$/, '')}/${relative}` : relative;
}

async function parseSkill(filePath: string, root: SkillRoot): Promise<SkillRecord> {
  const file = await lstat(filePath);
  if (!file.isFile() || file.size > MAX_SKILL_BYTES) throw new Error('Skill file is too large');
  const document = parseDocument(await readFile(filePath, 'utf8'));
  if (!document.frontmatter) throw new Error('Agent Skills frontmatter is required');
  if (!document.body) throw new Error('Skill body is empty');
  if (!document.attributes.name) throw new Error('Skill frontmatter requires name');
  if (!document.attributes.description) throw new Error('Skill frontmatter requires description');
  const fallbackName = path.basename(path.dirname(filePath));
  const name = normalizeName(document.attributes.name);
  if (name !== normalizeName(fallbackName)) throw new Error('Skill name must match its directory name');
  const fingerprint = createHash('sha256').update(filePath).digest('hex').slice(0, 12);
  const disabledByDefault = document.attributes['disable-model-invocation']?.toLowerCase() === 'true';
  return {
    key: `${root.scope}:${name}:${fingerprint}`,
    name,
    description: bounded(document.attributes.description, name, 500),
    ...(document.attributes.version ? { version: bounded(document.attributes.version, '', 100) } : {}),
    scope: root.scope,
    source: root.source,
    filePath: displayFile(filePath, root),
    trusted: root.trusted,
    defaultModelInvocable: !disabledByDefault,
    instructions: document.body,
  };
}

function scopeOrder(scope: SkillCatalogScope): number {
  return { global: 0, package: 1, path: 2, project: 3 }[scope];
}

/** Discovers Agent Skills documents without exposing their instructions through the catalogue API. */
export class SkillCatalogService {
  private readonly cache = new Map<string, CachedSkills>();
  private readonly refreshes = new Map<string, Promise<CachedSkills>>();

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly trustManager: ProjectTrustManager,
    private readonly configurationStore: ConfigurationStore,
    private readonly dataDir: string,
    private readonly packageRoots?: (input: { cwd: string; projectId: string }) => Promise<PackageSkillRoot[]>,
  ) {}

  async getCatalog(input: {
    cwd?: string;
    projectId?: string;
    refresh?: boolean;
    configurationScope?: 'global' | 'project';
  } = {}): Promise<SkillCatalog> {
    const context = await this.context(input.cwd, input.projectId);
    let cached = this.cache.get(context.cwd);
    if (input.refresh || !cached || cached.projectTrusted !== context.projectTrusted) cached = await this.refresh(context);
    return this.withEnabledState(cached, input.configurationScope);
  }

  async getModelInvocableSkills(input: {
    cwd?: string;
    projectId?: string;
    allowedSkills?: string[];
  } = {}): Promise<ModelInvocableSkill[]> {
    const context = await this.context(input.cwd, input.projectId);
    const existing = this.cache.get(context.cwd);
    const cached = !existing || existing.projectTrusted !== context.projectTrusted
      ? await this.refresh(context)
      : existing;
    const catalog = this.withEnabledState(cached);
    const enabled = new Set(catalog.skills.filter(skill => skill.modelInvocable).map(skill => skill.key));
    const allowed = input.allowedSkills?.length ? new Set(input.allowedSkills) : undefined;
    return cached.records
      .filter(record => enabled.has(record.key)
        && (!allowed || allowed.has(record.key) || allowed.has(record.name)))
      .sort((a, b) => scopeOrder(a.scope) - scopeOrder(b.scope))
      .map(record => ({
        key: record.key,
        name: record.name,
        description: record.description,
        instructions: record.instructions,
        filePath: record.filePath,
      }));
  }

  /** Invalidate discovery after an atomic plugin-resource generation change. */
  invalidate(cwd?: string): void {
    if (cwd) this.cache.delete(cwd);
    else this.cache.clear();
  }

  /** Resolve duplicate names using project > configured path > package > global precedence. */
  async resolveModelInvocableSkill(
    name: string,
    input: { cwd?: string; projectId?: string; allowedSkills?: string[] } = {},
  ): Promise<ModelInvocableSkill | undefined> {
    const requested = name.trim().toLowerCase();
    return [...await this.getModelInvocableSkills(input)].reverse()
      .find(candidate => candidate.name === requested);
  }

  private async context(cwd?: string, projectId?: string): Promise<{
    cwd: string;
    projectId: string;
    projectTrusted: boolean;
  }> {
    const canonical = await this.workspaceManager.resolve(
      cwd ?? await this.workspaceManager.getDefaultCwd(),
      { kind: 'directory' },
    );
    const descriptor = await this.workspaceManager.describe(
      canonical,
      await this.trustManager.isTrusted(canonical),
    );
    if (projectId && projectId !== descriptor.id) throw Object.assign(
      new Error('Workspace identifier does not match cwd.'),
      { status: 400, code: 'WORKSPACE_MISMATCH' },
    );
    return { cwd: canonical, projectId: descriptor.id, projectTrusted: descriptor.trusted };
  }

  private async refresh(context: { cwd: string; projectId: string; projectTrusted: boolean }): Promise<CachedSkills> {
    const active = this.refreshes.get(context.cwd);
    if (active) return active;
    const refresh = this.scan(context).finally(() => this.refreshes.delete(context.cwd));
    this.refreshes.set(context.cwd, refresh);
    const cached = await refresh;
    this.cache.set(context.cwd, cached);
    return cached;
  }

  private async scan(context: { cwd: string; projectId: string; projectTrusted: boolean }): Promise<CachedSkills> {
    const home = os.homedir();
    let packageRoots: PackageSkillRoot[] = [];
    try {
      packageRoots = (await this.packageRoots?.({ cwd: context.cwd, projectId: context.projectId }) ?? [])
        .slice(0, MAX_PATH_ROOTS * 4);
    } catch {
      // Plugin catalogue diagnostics own package failures; skill discovery remains available.
    }
    const roots: SkillRoot[] = [
      {
        directory: path.join(home, '.agents', 'skills'), scope: 'global', source: '~/.agents/skills',
        displayRoot: '~/.agents/skills', trusted: true,
      },
      {
        directory: path.join(this.dataDir, 'skills'), scope: 'global', source: '~/.ai-harness/skills',
        displayRoot: '~/.ai-harness/skills', trusted: true,
      },
      {
        directory: path.join(this.dataDir, 'packages'), scope: 'package', source: 'legacy installed packages',
        displayRoot: 'packages', trusted: true,
      },
      ...packageRoots.map((root): SkillRoot => ({ ...root, scope: 'package' })),
      ...environmentPaths('AI_HARNESS_SKILL_PATHS').map((directory, index): SkillRoot => ({
        directory, scope: 'path', source: `configured path ${index + 1}`, displayRoot: directory, trusted: true,
      })),
      {
        directory: path.join(context.cwd, '.agents', 'skills'), scope: 'project', source: '.agents/skills',
        displayRoot: '.agents/skills', trusted: context.projectTrusted,
      },
      {
        directory: path.join(context.cwd, '.ai-harness', 'skills'), scope: 'project', source: '.ai-harness/skills',
        displayRoot: '.ai-harness/skills', trusted: context.projectTrusted,
      },
    ];

    const records: SkillRecord[] = [];
    const budget = { files: MAX_SKILLS, entries: MAX_SCAN_ENTRIES };
    let errorCount = 0;
    const diagnostics: SkillDiagnostic[] = [];
    for (const root of roots) {
      if (budget.files <= 0 || budget.entries <= 0) break;
      const found = await findSkillFiles(root.directory, budget);
      errorCount += found.errors;
      if (found.errors) diagnostics.push({
        code: 'SKILL_SCAN_FAILED',
        message: `${found.errors} director${found.errors === 1 ? 'y' : 'ies'} could not be scanned.`,
        path: root.displayRoot,
      });
      for (const filePath of found.files) {
        if (records.length >= MAX_SKILLS) break;
        try {
          records.push(await parseSkill(filePath, root));
        } catch (error) {
          errorCount++;
          if (diagnostics.length < 100) diagnostics.push({
            code: 'INVALID_SKILL_DOCUMENT',
            message: error instanceof Error ? error.message : String(error),
            path: displayFile(filePath, root),
          });
        }
      }
    }
    records.sort((a, b) => scopeOrder(a.scope) - scopeOrder(b.scope)
      || a.name.localeCompare(b.name)
      || a.filePath.localeCompare(b.filePath));
    return {
      records,
      errorCount,
      diagnostics,
      updatedAt: new Date().toISOString(),
      ...context,
    };
  }

  private withEnabledState(cached: CachedSkills, configurationScope: 'global' | 'project' = 'project'): SkillCatalog {
    const effective = resolveEffectiveConfiguration(
      { configurationStore: this.configurationStore } as Pick<RuntimeServices, 'configurationStore'>,
      { projectId: configurationScope === 'project' ? cached.projectId : undefined },
    );
    const configured = effective.values.enabledSkills;
    const enabled = configured === undefined ? undefined : new Set(configured);
    const provenance = effective.provenance.enabledSkills;
    return {
      updatedAt: cached.updatedAt,
      projectId: cached.projectId,
      cwd: cached.cwd,
      projectTrusted: cached.projectTrusted,
      enabledScope: provenance?.scope ?? 'default',
      enabledSource: provenance?.source ?? 'skill metadata',
      skills: cached.records.map(({ instructions: _instructions, ...skill }) => ({
        ...skill,
        modelInvocable: skill.trusted && (enabled === undefined
          ? skill.defaultModelInvocable
          : enabled.has(skill.key) || enabled.has(skill.name)),
      })),
      errorCount: cached.errorCount,
      diagnostics: structuredClone(cached.diagnostics),
    };
  }
}
