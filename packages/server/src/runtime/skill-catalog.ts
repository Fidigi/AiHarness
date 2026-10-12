import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogScope,
  SkillDiagnostic,
  SkillDefinition,
  ResourceProvenance,
  ResourceEnableChange,
  ResourceEnableOutcome,
  SkillEnableBatchResult,
} from '@ai-harness/core';
import type { ConfigurationStore } from '../config/config-store.js';
import { resolveEffectiveConfiguration } from '../config/effective-configuration.js';
import type { RuntimeServices } from './services.js';
import {
  ResourceManager,
  disposeStableFilePublicationReceipt,
  type StableFilePublicationResult,
  parseResourceMarkdown,
  type ProjectTrustManager,
  type WorkspaceManager,
} from '@ai-harness/core';

import { mergeResourceChanges } from './resource-batches.js';
import { readSkillMarkdown, skillInvocationMarkdown, withSkillMutation, writeSkillMarkdown } from './skill-markdown.js';

const MAX_SKILLS = 500;
const MAX_PATH_ROOTS = 32;
const MAX_CACHED_WORKSPACES = 16;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_CONCURRENT_REFRESHES = 32;

export interface PackageSkillRoot {
  directory: string;
  scope?: 'global' | 'project';
  source: string;
  displayRoot: string;
  trusted: boolean;
}

interface SkillRecord extends Omit<SkillCatalogEntry, 'modelInvocable'> {
  instructions: string;
  absolutePath: string;
  provenance: ResourceProvenance;
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

function environmentPaths(name: string): string[] {
  return (process.env[name] ?? '')
    .split(path.delimiter)
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, MAX_PATH_ROOTS)
    .map(value => path.resolve(value));
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function catalogueScope(provenance: ResourceProvenance): SkillCatalogScope {
  if (provenance.scope === 'project' && provenance.source !== 'package') return 'project';
  if (provenance.source === 'package') return 'package';
  if (provenance.source === 'settings' || provenance.source === 'cli') return 'path';
  return provenance.scope === 'project' ? 'project' : 'global';
}

function matchingRoot(filePath: string, roots: readonly PackageSkillRoot[]): PackageSkillRoot | undefined {
  return roots.filter(root => inside(root.directory, filePath))
    .sort((left, right) => right.directory.length - left.directory.length)[0];
}

function displayPath(filePath: string, root: { directory: string; displayRoot: string }): string {
  const relative = path.relative(root.directory, filePath).split(path.sep).join('/');
  return root.displayRoot ? `${root.displayRoot.replace(/\/$/, '')}/${relative}` : relative;
}

function skillRecord(
  skill: SkillDefinition,
  context: { cwd: string },
  roots: readonly PackageSkillRoot[],
  dataDir: string,
): SkillRecord {
  const scope = catalogueScope(skill.provenance);
  const packageRoot = matchingRoot(skill.filePath, roots);
  const configuredRoot = environmentPaths('AI_HARNESS_SKILL_PATHS')
    .filter(root => inside(root, skill.filePath)).sort((left, right) => right.length - left.length)[0];
  const projectRoot = inside(context.cwd, skill.filePath)
    ? { directory: context.cwd, displayRoot: '' }
    : undefined;
  const agentRoot = inside(path.join(dataDir, 'skills'), skill.filePath)
    ? { directory: path.join(dataDir, 'skills'), displayRoot: '~/.ai-harness/skills' }
    : undefined;
  const specificationRoot = inside(path.join(os.homedir(), '.agents', 'skills'), skill.filePath)
    ? { directory: path.join(os.homedir(), '.agents', 'skills'), displayRoot: '~/.agents/skills' }
    : undefined;
  const root = packageRoot ?? (configuredRoot
    ? { directory: configuredRoot, displayRoot: configuredRoot }
    : projectRoot ?? agentRoot ?? specificationRoot);
  const source = packageRoot?.source
    ?? (configuredRoot ? `configured path ${environmentPaths('AI_HARNESS_SKILL_PATHS').indexOf(configuredRoot) + 1}`
      : scope === 'project' ? '.agents/skills'
        : agentRoot ? '~/.ai-harness/skills'
          : specificationRoot ? '~/.agents/skills' : skill.provenance.selector);
  const fingerprint = createHash('sha256').update(skill.filePath).digest('hex').slice(0, 12);
  return {
    key: `${scope}:${skill.name}:${fingerprint}`,
    name: skill.name,
    description: (skill.description || skill.name).slice(0, 500),
    ...(skill.version ? { version: skill.version.slice(0, 100) } : {}),
    scope,
    source,
    filePath: root ? displayPath(skill.filePath, root) : skill.filePath,
    trusted: skill.provenance.trusted,
    defaultModelInvocable: !skill.disableModelInvocation,
    instructions: skill.instructions,
    absolutePath: skill.filePath,
    provenance: structuredClone(skill.provenance),
  };
}

function scopeOrder(scope: SkillCatalogScope): number {
  return { global: 0, package: 1, path: 2, project: 3 }[scope];
}

/** Discovers Agent Skills documents without exposing their instructions through the catalogue API. */
export class SkillCatalogService {
  private readonly cache = new Map<string, CachedSkills>();
  private readonly cacheBytes = new Map<string, number>();
  private totalCacheBytes = 0;
  private cacheGeneration = 0;
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
    let cached = this.cached(context.cwd);
    if (input.refresh || !cached || cached.projectTrusted !== context.projectTrusted) cached = await this.refresh(context);
    return this.withEnabledState(cached, input.configurationScope);
  }

  async getModelInvocableSkills(input: {
    cwd?: string;
    projectId?: string;
    allowedSkills?: string[];
  } = {}): Promise<ModelInvocableSkill[]> {
    const context = await this.context(input.cwd, input.projectId);
    const existing = this.cached(context.cwd);
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

  async setEnabledBatch(input: {
    cwd?: string; projectId?: string; changes: ResourceEnableChange[];
  }): Promise<SkillEnableBatchResult> {
    const context = await this.context(input.cwd, input.projectId);
    const cached = this.cached(context.cwd) ?? await this.refresh(context);
    const records = new Map(cached.records.map(record => [record.key, record]));
    const outcomes: ResourceEnableOutcome[] = [];
    const scope = input.projectId ? 'project' : 'global';
    // Each entry is independently authorized and committed; a bad file never
    // discards earlier successes. Selectors resolve only through owned discovery.
    for (const change of input.changes) {
      const record = records.get(change.key);
      if (!record) {
        outcomes.push({ ...change, status: 'failed', code: 'UNKNOWN_RESOURCE' });
        continue;
      }
      try {
        const outcome = await withSkillMutation(record.absolutePath, async () => {
          const authorize = async (): Promise<void> => {
            if (!record.trusted || ((record.provenance.scope === 'project' || inside(context.cwd, record.absolutePath))
              && !await this.trustManager.isTrusted(context.cwd))) {
              throw Object.assign(new Error('Project trust required.'), { code: 'PROJECT_TRUST_REQUIRED' });
            }
          };
          await authorize();
          const before = await readSkillMarkdown(record.absolutePath);
          const after = skillInvocationMarkdown(before, record.name, change.enabled);
          let currentEnabled = parseResourceMarkdown(before).attributes['disable-model-invocation'] !== 'true';
          await this.configurationStore.update(scope, (target, inherited) => {
            const configured = target.enabledSkills ?? inherited.enabledSkills;
            if (configured !== undefined) currentEnabled = configured.includes(record.key) || configured.includes(record.name);
            return target;
          }, input.projectId ? context.projectId : undefined);
          if (currentEnabled === change.enabled) return { ...change, status: 'unchanged' as const };
          let publication: StableFilePublicationResult | undefined;
          const settingsOutcomes: ResourceEnableOutcome[] = [];
          try {
            publication = await writeSkillMarkdown(record.absolutePath, before, after, authorize);
            if (publication && 'error' in publication) throw publication.error;
            await this.configurationStore.update(scope, (target, inherited) => {
              if (target.enabledSkills === undefined && inherited.enabledSkills === undefined) return target;
              return mergeResourceChanges(target, inherited, 'enabledSkills', cached.records.map(skill => ({
                key: skill.key, alias: skill.name, defaultEnabled: skill.defaultModelInvocable,
              })), [change], settingsOutcomes);
            }, input.projectId ? context.projectId : undefined);
          } catch (error) {
            // The settings writer also has a void ABI: rejection may follow
            // publication. Reload canonical settings even if Markdown rollback succeeds.
            // A post-publication failure is not evidence of an unchanged file.
            // Restore only the exact owned publication, never an ABA replacement.
            if (publication && publication.publication !== 'not-published') {
              let rollback: StableFilePublicationResult | undefined;
              try {
                if (!publication.receipt) throw new Error('Owned publication unavailable.');
                rollback = await writeSkillMarkdown(record.absolutePath, after, before, authorize, publication.receipt);
                if (rollback && 'error' in rollback) throw rollback.error;
              } catch {
                throw Object.assign(new Error('Skill rollback failed; reconcile canonical state.'), {
                  code: 'SKILL_ROLLBACK_FAILED',
                });
              } finally {
                if (rollback?.receipt) await disposeStableFilePublicationReceipt(rollback.receipt);
              }
            }
            throw error;
          } finally {
            if (publication?.receipt) await disposeStableFilePublicationReceipt(publication.receipt);
          }
          return { ...change, status: before !== after || settingsOutcomes.some(item => item.status === 'changed')
            ? 'changed' as const : 'unchanged' as const };
        });
        outcomes.push(outcome);
      } catch (error) {
        const code = error !== null && typeof error === 'object'
          ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
        outcomes.push({ ...change, status: 'failed', code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
          ? code : 'SKILL_WRITE_FAILED' });
      }
    }
    // Global/package files may also be cached in other workspaces.
    this.invalidate();
    // A writer rejection can follow publication, or the initial read can fail.
    // Always reconcile before returning a catalogue; never bless stale memory.
    try { await this.configurationStore.load(); }
    catch {
      throw Object.assign(new Error('Skill batch state is uncertain; canonical reconciliation required.'), {
        status: 409, code: 'SKILL_BATCH_UNCERTAIN', uncertain: true, outcomes,
      });
    }
    const catalog = await this.getCatalog({ cwd: context.cwd, projectId: input.projectId,
      configurationScope: scope, refresh: true });
    return { outcomes, catalog };
  }

  /** Invalidate discovery after an atomic plugin-resource generation change. */
  invalidate(cwd?: string): void {
    this.cacheGeneration++;
    if (cwd) this.deleteCached(cwd);
    else {
      this.cache.clear();
      this.cacheBytes.clear();
      this.totalCacheBytes = 0;
    }
  }

  /** Resolve duplicate names using project > configured path > package > global precedence. */
  async resolveModelInvocableSkill(
    name: string,
    input: { cwd?: string; projectId?: string; allowedSkills?: string[] } = {},
  ): Promise<ModelInvocableSkill | undefined> {
    if (typeof name !== 'string' || Buffer.byteLength(name) > 128) return undefined;
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
    const refreshKey = `${this.cacheGeneration}\0${context.cwd}\0${context.projectTrusted ? 'trusted' : 'untrusted'}`;
    const active = this.refreshes.get(refreshKey);
    if (active) return active;
    if (this.refreshes.size >= MAX_CONCURRENT_REFRESHES) {
      throw Object.assign(new Error('Too many skill catalog refreshes are active.'), { status: 429 });
    }
    const generation = this.cacheGeneration;
    const refresh = this.scan(context).finally(() => this.refreshes.delete(refreshKey));
    this.refreshes.set(refreshKey, refresh);
    const cached = await refresh;
    if (generation === this.cacheGeneration) this.setCached(context.cwd, cached);
    return cached;
  }

  private cached(cwd: string): CachedSkills | undefined {
    const value = this.cache.get(cwd);
    if (!value) return undefined;
    this.cache.delete(cwd);
    this.cache.set(cwd, value);
    return value;
  }

  private deleteCached(cwd: string): void {
    if (!this.cache.delete(cwd)) return;
    this.totalCacheBytes -= this.cacheBytes.get(cwd) ?? 0;
    this.cacheBytes.delete(cwd);
  }

  private setCached(cwd: string, cached: CachedSkills): void {
    this.deleteCached(cwd);
    const bytes = cached.records.reduce((total, record) => total
      + Buffer.byteLength(record.instructions)
      + Buffer.byteLength(record.name)
      + Buffer.byteLength(record.description)
      + Buffer.byteLength(record.filePath)
      + Buffer.byteLength(record.source), 0)
      + cached.diagnostics.reduce((total, diagnostic) => total + Buffer.byteLength(diagnostic.message), 0);
    if (bytes > MAX_CACHE_BYTES) return;
    while (this.cache.size >= MAX_CACHED_WORKSPACES || this.totalCacheBytes + bytes > MAX_CACHE_BYTES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.deleteCached(oldest);
    }
    this.cache.set(cwd, cached);
    this.cacheBytes.set(cwd, bytes);
    this.totalCacheBytes += bytes;
  }

  private async scan(context: { cwd: string; projectId: string; projectTrusted: boolean }): Promise<CachedSkills> {
    let packageRoots: PackageSkillRoot[] = [];
    try {
      packageRoots = (await this.packageRoots?.({ cwd: context.cwd, projectId: context.projectId }) ?? [])
        .filter(root => root.trusted)
        .slice(0, MAX_PATH_ROOTS * 4);
    } catch {
      // Plugin catalogue diagnostics own package failures; skill discovery remains available.
    }
    const legacyPackageRoot: PackageSkillRoot = {
      directory: path.join(this.dataDir, 'packages'), scope: 'global', source: 'legacy installed packages',
      displayRoot: 'packages', trusted: true,
    };
    const allPackageRoots = [legacyPackageRoot, ...packageRoots];
    const manager = new ResourceManager({
      cwd: context.cwd,
      homeDir: os.homedir(),
      agentDir: this.dataDir,
      agentDirTrusted: true,
      projectTrusted: context.projectTrusted,
      globalSkillPaths: environmentPaths('AI_HARNESS_SKILL_PATHS'),
      globalPackageSkillPaths: allPackageRoots
        .filter(root => root.scope !== 'project')
        .map(root => root.directory),
      projectPackageSkillPaths: context.projectTrusted
        ? allPackageRoots.filter(root => root.scope === 'project').map(root => root.directory)
        : [],
      disablePrompts: true,
      strictSkills: true,
    });
    const loaded = await manager.loadAll();
    const records = manager.listSkillCandidates().slice(0, MAX_SKILLS)
      .map(skill => skillRecord(skill, context, allPackageRoots, this.dataDir))
      .sort((a, b) => scopeOrder(a.scope) - scopeOrder(b.scope)
        || a.name.localeCompare(b.name)
        || a.filePath.localeCompare(b.filePath));
    const diagnostics: SkillDiagnostic[] = loaded.errors.slice(0, 100).map(error => ({
      code: 'INVALID_SKILL_DOCUMENT',
      message: error.message,
    }));
    return {
      records,
      errorCount: loaded.errors.length,
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
      skills: cached.records.map(({ instructions: _instructions, absolutePath: _absolutePath, ...skill }) => ({
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
