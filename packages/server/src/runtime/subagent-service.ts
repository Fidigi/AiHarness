import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ProjectTrustManager,
  SubagentConfiguration,
  SubagentProfile,
  SubagentProfileKind,
  WorkspaceManager,
} from '@ai-harness/core';

const FILE_VERSION = 1 as const;
const MAX_PROFILES = 50;

interface StoredSubagentConfiguration {
  engineEnabled: boolean;
  maxConcurrency: number;
  profiles: SubagentProfile[];
  updatedAt: string;
}

interface SubagentConfigurationFile {
  version: typeof FILE_VERSION;
  global?: StoredSubagentConfiguration;
  projects: Record<string, StoredSubagentConfiguration>;
}

export interface SubagentContextInput {
  cwd?: string;
  projectId?: string;
  scope?: 'global' | 'project';
}

export type SubagentProfileInput = Omit<SubagentProfile, 'id' | 'builtIn'> & { id?: string };

function builtInProfiles(): SubagentProfile[] {
  return [
    {
      id: 'explore',
      name: 'Explore',
      description: 'Inspect the workspace and report focused findings without modifying files.',
      instructions: 'Explore the workspace methodically. Cite relevant files and return concise findings. Do not modify files.',
      kind: 'explore',
      enabled: true,
      builtIn: true,
      tools: ['ls', 'read', 'grep', 'find', 'load_skill'],
      skills: [],
      extensions: [],
      thinking: 'low',
      maxTurns: 8,
      inheritContext: true,
      background: true,
    },
    {
      id: 'general',
      name: 'General purpose',
      description: 'Handle a delegated implementation or investigation with the parent tool policy.',
      instructions: 'Complete the delegated task independently, validate the result, and return a concise summary.',
      kind: 'general',
      enabled: true,
      builtIn: true,
      tools: [],
      skills: [],
      extensions: [],
      maxTurns: 12,
      inheritContext: true,
      background: true,
    },
    {
      id: 'plan',
      name: 'Plan',
      description: 'Analyze a request and produce an actionable plan without modifying files.',
      instructions: 'Analyze constraints, inspect only what is needed, and return an ordered implementation plan. Do not modify files.',
      kind: 'plan',
      enabled: true,
      builtIn: true,
      tools: ['ls', 'read', 'grep', 'find', 'load_skill'],
      skills: [],
      extensions: [],
      thinking: 'high',
      maxTurns: 8,
      inheritContext: true,
      background: false,
    },
  ];
}

function defaultStoredConfiguration(): StoredSubagentConfiguration {
  return {
    engineEnabled: true,
    maxConcurrency: 4,
    profiles: builtInProfiles(),
    updatedAt: new Date().toISOString(),
  };
}

function cloneStored(value: StoredSubagentConfiguration): StoredSubagentConfiguration {
  return structuredClone(value);
}

function boundedString(value: unknown, field: string, max: number, optional = false): string | undefined {
  if ((value === undefined || value === null || value === '') && optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000\u007f]/.test(value)) {
    throw Object.assign(new Error(`${field} invalide.`), { status: 400, code: 'INVALID_SUBAGENT_PROFILE' });
  }
  return value.trim();
}

function normalizedId(value: string): string {
  const id = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(id)) {
    throw Object.assign(new Error('Identifiant de profil invalide.'), { status: 400, code: 'INVALID_SUBAGENT_PROFILE' });
  }
  return id;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 100 || !value.every(item => (
    typeof item === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/.test(item)
  ))) {
    throw Object.assign(new Error(`${field} invalide.`), { status: 400, code: 'INVALID_SUBAGENT_PROFILE' });
  }
  return [...new Set(value.map(item => item.trim().toLowerCase()))];
}

function validateProfile(input: Partial<SubagentProfile>, options: { id?: string; builtIn?: boolean } = {}): SubagentProfile {
  const kind = input.kind ?? 'custom';
  if (!(['explore', 'general', 'plan', 'custom'] as SubagentProfileKind[]).includes(kind)) {
    throw Object.assign(new Error('Type de profil invalide.'), { status: 400, code: 'INVALID_SUBAGENT_PROFILE' });
  }
  const thinking = input.thinking;
  if (thinking !== undefined && !['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) {
    throw Object.assign(new Error('Niveau de réflexion invalide.'), { status: 400, code: 'INVALID_SUBAGENT_PROFILE' });
  }
  const maxTurns = input.maxTurns;
  if (!Number.isSafeInteger(maxTurns) || (maxTurns ?? 0) < 1 || (maxTurns ?? 0) > 32) {
    throw Object.assign(new Error('Nombre maximal de tours invalide.'), { status: 400, code: 'INVALID_SUBAGENT_PROFILE' });
  }
  const name = boundedString(input.name, 'Nom', 120)!;
  const id = normalizedId(options.id ?? input.id ?? `${name}-${crypto.randomUUID().slice(0, 8)}`);
  return {
    id,
    name,
    description: boundedString(input.description, 'Description', 1_000)!,
    instructions: boundedString(input.instructions, 'Instructions', 100_000)!,
    kind,
    enabled: input.enabled !== false,
    builtIn: options.builtIn ?? false,
    tools: stringList(input.tools ?? [], 'Outils'),
    skills: stringList(input.skills ?? [], 'Skills'),
    extensions: stringList(input.extensions ?? [], 'Extensions'),
    ...(input.model ? { model: boundedString(input.model, 'Modèle', 500)! } : {}),
    ...(thinking ? { thinking } : {}),
    maxTurns: maxTurns!,
    inheritContext: input.inheritContext !== false,
    background: input.background === true,
  };
}

/** Persistent scoped profile catalogue used by the integrated child-agent runtime. */
export class SubagentService {
  private file: SubagentConfigurationFile = { version: FILE_VERSION, projects: {} };
  private mutation = Promise.resolve();

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly trustManager: ProjectTrustManager,
    private readonly filePath: string,
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<SubagentConfigurationFile>;
      if (parsed.version !== FILE_VERSION || !parsed.projects || typeof parsed.projects !== 'object') return;
      const next: SubagentConfigurationFile = { version: FILE_VERSION, projects: {} };
      if (parsed.global) next.global = this.validateStored(parsed.global);
      for (const [id, configuration] of Object.entries(parsed.projects)) {
        if (/^[a-zA-Z0-9._:-]{1,200}$/.test(id)) next.projects[id] = this.validateStored(configuration);
      }
      this.file = next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[Subagents] Ignoring invalid configuration:', error instanceof Error ? error.message : error);
      }
    }
  }

  async getConfiguration(input: SubagentContextInput = {}): Promise<SubagentConfiguration> {
    const context = await this.context(input);
    const global = this.file.global ?? defaultStoredConfiguration();
    const project = context.scope === 'project' ? this.file.projects[context.projectId!] : undefined;
    const selected = cloneStored(project ?? global);
    return {
      ...selected,
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(context.projectId ? { projectId: context.projectId } : {}),
      scope: project ? 'project' : 'global',
      source: project ? context.projectId! : this.file.global ? 'global' : 'built-in',
    };
  }

  async updateSettings(
    input: SubagentContextInput,
    changes: { engineEnabled?: boolean; maxConcurrency?: number },
  ): Promise<SubagentConfiguration> {
    if (changes.engineEnabled !== undefined && typeof changes.engineEnabled !== 'boolean') {
      throw Object.assign(new Error('Activation du moteur invalide.'), { status: 400 });
    }
    if (changes.maxConcurrency !== undefined && (
      !Number.isSafeInteger(changes.maxConcurrency) || changes.maxConcurrency < 1 || changes.maxConcurrency > 16
    )) throw Object.assign(new Error('Concurrence invalide.'), { status: 400 });
    return this.mutate(input, configuration => ({
      ...configuration,
      ...(changes.engineEnabled === undefined ? {} : { engineEnabled: changes.engineEnabled }),
      ...(changes.maxConcurrency === undefined ? {} : { maxConcurrency: changes.maxConcurrency }),
    }));
  }

  async createProfile(input: SubagentContextInput, profile: Partial<SubagentProfile>): Promise<SubagentConfiguration> {
    return this.mutate(input, configuration => {
      if (configuration.profiles.length >= MAX_PROFILES) throw Object.assign(
        new Error('Nombre maximal de profils atteint.'), { status: 409, code: 'SUBAGENT_PROFILE_LIMIT' },
      );
      const created = validateProfile(profile);
      if (configuration.profiles.some(item => item.id === created.id)) throw Object.assign(
        new Error('Ce profil existe déjà.'), { status: 409, code: 'SUBAGENT_PROFILE_EXISTS' },
      );
      return { ...configuration, profiles: [...configuration.profiles, created] };
    });
  }

  async duplicateProfile(input: SubagentContextInput, profileId: string): Promise<SubagentConfiguration> {
    const current = await this.getConfiguration(input);
    const source = current.profiles.find(profile => profile.id === profileId);
    if (!source) throw Object.assign(new Error('Profil introuvable.'), { status: 404 });
    return this.createProfile(input, {
      ...source,
      id: `${source.id.slice(0, 60)}-copy-${crypto.randomUUID().slice(0, 6)}`,
      name: `${source.name} copy`,
      kind: 'custom',
      builtIn: false,
    });
  }

  async updateProfile(
    input: SubagentContextInput,
    profileId: string,
    profile: Partial<SubagentProfile>,
  ): Promise<SubagentConfiguration> {
    return this.mutate(input, configuration => {
      const index = configuration.profiles.findIndex(item => item.id === profileId);
      if (index < 0) throw Object.assign(new Error('Profil introuvable.'), { status: 404 });
      const current = configuration.profiles[index]!;
      const updated = validateProfile({ ...current, ...profile, id: current.id }, {
        id: current.id,
        builtIn: current.builtIn,
      });
      const profiles = [...configuration.profiles];
      profiles[index] = updated;
      return { ...configuration, profiles };
    });
  }

  async deleteProfile(input: SubagentContextInput, profileId: string): Promise<SubagentConfiguration> {
    return this.mutate(input, configuration => {
      const profile = configuration.profiles.find(item => item.id === profileId);
      if (!profile) throw Object.assign(new Error('Profil introuvable.'), { status: 404 });
      if (profile.builtIn) throw Object.assign(
        new Error('Un profil intégré ne peut pas être supprimé.'), { status: 409, code: 'BUILTIN_PROFILE' },
      );
      return { ...configuration, profiles: configuration.profiles.filter(item => item.id !== profileId) };
    });
  }

  private async mutate(
    input: SubagentContextInput,
    change: (configuration: StoredSubagentConfiguration) => StoredSubagentConfiguration,
  ): Promise<SubagentConfiguration> {
    const context = await this.context(input);
    let result!: SubagentConfiguration;
    const execute = async () => {
      const inherited = context.scope === 'project'
        ? this.file.projects[context.projectId!] ?? this.file.global ?? defaultStoredConfiguration()
        : this.file.global ?? defaultStoredConfiguration();
      const changed = change(cloneStored(inherited));
      changed.updatedAt = new Date().toISOString();
      if (context.scope === 'project') this.file.projects[context.projectId!] = changed;
      else this.file.global = changed;
      await this.persist();
      result = await this.getConfiguration({
        cwd: context.cwd,
        projectId: context.projectId,
        scope: context.scope,
      });
    };
    this.mutation = this.mutation.then(execute, execute);
    await this.mutation;
    return result;
  }

  private async context(input: SubagentContextInput): Promise<{
    scope: 'global' | 'project';
    cwd?: string;
    projectId?: string;
  }> {
    const scope = input.scope ?? (input.cwd || input.projectId ? 'project' : 'global');
    if (scope === 'global') return { scope };
    const cwd = await this.workspaceManager.resolve(
      input.cwd ?? await this.workspaceManager.getDefaultCwd(),
      { kind: 'directory' },
    );
    const descriptor = await this.workspaceManager.describe(cwd, await this.trustManager.isTrusted(cwd));
    if (input.projectId && input.projectId !== descriptor.id) throw Object.assign(
      new Error('Workspace identifier does not match cwd.'),
      { status: 400, code: 'WORKSPACE_MISMATCH' },
    );
    return { scope, cwd, projectId: descriptor.id };
  }

  private validateStored(input: StoredSubagentConfiguration): StoredSubagentConfiguration {
    if (typeof input.engineEnabled !== 'boolean'
      || !Number.isSafeInteger(input.maxConcurrency)
      || input.maxConcurrency < 1
      || input.maxConcurrency > 16
      || !Array.isArray(input.profiles)
      || input.profiles.length > MAX_PROFILES) throw new Error('Invalid subagent configuration');
    return {
      engineEnabled: input.engineEnabled,
      maxConcurrency: input.maxConcurrency,
      profiles: input.profiles.map(profile => validateProfile(profile, {
        id: profile.id,
        builtIn: builtInProfiles().some(item => item.id === profile.id) && profile.builtIn === true,
      })),
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
    };
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
