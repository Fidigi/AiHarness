import { mkdir } from 'node:fs/promises';
import { atomicWriteStableFile, readBoundedResourceText } from '@ai-harness/core';
import path from 'node:path';
import type {
  ConfigurationScope,
  EffectiveConfiguration,
  ScopedConfigurationValues,
} from '@ai-harness/core';

interface ConfigurationFile {
  version: 1;
  global: ScopedConfigurationValues;
  projects: Record<string, ScopedConfigurationValues>;
  sessions: Record<string, ScopedConfigurationValues>;
}

const EMPTY_FILE: ConfigurationFile = {
  version: 1,
  global: {},
  projects: {},
  sessions: {},
};

const MAX_CONFIGURATION_BYTES = 4 * 1024 * 1024;
const mutations = new Map<string, Promise<void>>();

const SECRET_KEY = /(?:secret|token|password|api[-_]?key|authorization|credential)/i;
const STRING_KEYS = new Set<keyof ScopedConfigurationValues>([
  'provider', 'model', 'thinking', 'toolPreset', 'systemPrompt', 'codemodeMode',
]);
const ARRAY_KEYS = new Set<keyof ScopedConfigurationValues>([
  'enabledModels', 'enabledSkills', 'enabledPlugins', 'enabledTools',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function cloneFile(value: ConfigurationFile): ConfigurationFile {
  return structuredClone(value);
}

function invalidConfiguration(message: string): never {
  throw Object.assign(new Error(message), { status: 400, code: 'INVALID_CONFIGURATION' });
}

function validateValues(input: unknown): ScopedConfigurationValues {
  if (!isPlainRecord(input)) invalidConfiguration('Configuration invalide.');
  const result: ScopedConfigurationValues = {};
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY.test(rawKey)) invalidConfiguration('Les secrets ne sont pas acceptés dans la configuration.');
    const key = rawKey as keyof ScopedConfigurationValues;
    if (STRING_KEYS.has(key)) {
      if (typeof value !== 'string' || value.length > 100_000) invalidConfiguration(`Valeur invalide pour ${rawKey}.`);
      if (key === 'thinking' && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
        invalidConfiguration('Niveau de réflexion invalide.');
      }
      if (key === 'toolPreset' && !['configured', 'chat-only', 'read-only', 'default', 'full'].includes(value)) {
        invalidConfiguration("Preset d'outils invalide.");
      }
      if (key === 'codemodeMode' && !['on', 'only'].includes(value)) invalidConfiguration('Invalid codemode mode.');
      Object.assign(result, { [key]: value });
    } else if (key === 'codemodeInlineBudget') {
      if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 3_000) invalidConfiguration('Invalid codemode inline budget.');
      result.codemodeInlineBudget = Number(value);
    } else if (ARRAY_KEYS.has(key)) {
      if (!Array.isArray(value) || value.length > 2_000 || !value.every(item => typeof item === 'string' && item.length <= 500)) {
        invalidConfiguration(`Valeur invalide pour ${rawKey}.`);
      }
      Object.assign(result, { [key]: [...new Set(value)] });
    } else if (key === 'autoCompaction' || key === 'powershellEnabled' || key === 'codemodeEnabled') {
      if (typeof value !== 'boolean') invalidConfiguration(`Valeur invalide pour ${key}.`);
      Object.assign(result, { [key]: value });
    } else {
      invalidConfiguration(`Clé de configuration inconnue : ${rawKey}.`);
    }
  }
  return result;
}

function validatePatchValues(input: unknown): Record<string, unknown> {
  if (!isPlainRecord(input)) invalidConfiguration('Configuration invalide.');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value !== null) {
      Object.assign(result, validateValues({ [key]: value }));
      continue;
    }
    if (SECRET_KEY.test(key)
      || (!STRING_KEYS.has(key as keyof ScopedConfigurationValues)
        && !ARRAY_KEYS.has(key as keyof ScopedConfigurationValues)
        && key !== 'autoCompaction' && key !== 'powershellEnabled' && key !== 'codemodeEnabled' && key !== 'codemodeInlineBudget')) {
      invalidConfiguration(`Clé de configuration inconnue : ${key}.`);
    }
    result[key] = null;
  }
  return result;
}

/** Atomic, validated, non-secret configuration layers. */
export class ConfigurationStore {
  private data: ConfigurationFile = cloneFile(EMPTY_FILE);
  private loaded = false;
  constructor(private readonly filePath: string) {}

  private async read(): Promise<{ data: ConfigurationFile; source?: string }> {
    try {
      const source = await readBoundedResourceText(this.filePath, MAX_CONFIGURATION_BYTES);
      const parsed = JSON.parse(source) as Partial<ConfigurationFile>;
      if (!parsed || Array.isArray(parsed) || parsed.version !== 1
        || Object.keys(parsed).some(key => !['version', 'global', 'projects', 'sessions'].includes(key))) {
        throw new Error('Unsupported configuration version.');
      }
      const layer = (input: unknown): Record<string, ScopedConfigurationValues> => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 10_000) {
          throw new Error('Invalid configuration layers.');
        }
        return Object.fromEntries(Object.entries(input).map(([id, values]) => {
          this.validateScope('project', id);
          return [id, validateValues(values)];
        }));
      };
      return { source, data: { version: 1, global: validateValues(parsed.global ?? {}),
        projects: layer(parsed.projects ?? {}), sessions: layer(parsed.sessions ?? {}) } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: cloneFile(EMPTY_FILE) };
      throw Object.assign(new Error('Configuration cannot be read safely.'), { status: 409, code: 'CONFIGURATION_UNREADABLE' });
    }
  }

  async load(): Promise<void> {
    return this.serialise(async () => {
      const snapshot = await this.read();
      this.data = snapshot.data;
      this.loaded = true;
    });
  }

  get(scope: ConfigurationScope, scopeId?: string): ScopedConfigurationValues {
    this.assertLoaded();
    this.validateScope(scope, scopeId);
    if (scope === 'global') return structuredClone(this.data.global);
    return structuredClone(scope === 'project'
      ? this.data.projects[scopeId!] ?? {}
      : this.data.sessions[scopeId!] ?? {});
  }

  async patch(scope: ConfigurationScope, values: unknown, scopeId?: string): Promise<ScopedConfigurationValues> {
    this.assertLoaded();
    const patch = validatePatchValues(values);
    this.validateScope(scope, scopeId);
    return this.mutate(scope, scopeId, target => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete (target as Record<string, unknown>)[key];
        else Object.assign(target, { [key]: value });
      }
      return target;
    });
  }

  async replace(scope: ConfigurationScope, values: unknown, scopeId?: string): Promise<ScopedConfigurationValues> {
    this.assertLoaded();
    const replacement = validateValues(values);
    this.validateScope(scope, scopeId);
    return this.mutate(scope, scopeId, () => replacement);
  }

  /** Serialized relative mutation against the fresh scope and global base.
   * The callback is synchronous and receives private copies; invalid results
   * and unchanged values are never published to disk.
   */
  async update(scope: ConfigurationScope,
    transform: (target: ScopedConfigurationValues, globalBase: ScopedConfigurationValues) => ScopedConfigurationValues,
    scopeId?: string): Promise<ScopedConfigurationValues> {
    this.assertLoaded();
    this.validateScope(scope, scopeId);
    return this.mutate(scope, scopeId, transform);
  }

  effective(input: {
    projectId?: string;
    sessionId?: string;
    defaults?: ScopedConfigurationValues;
    /** Runtime session fields are layered after persisted session config and before environment overrides. */
    runtimeSession?: ScopedConfigurationValues;
    environment?: ScopedConfigurationValues;
  }): EffectiveConfiguration {
    this.assertLoaded();
    const values: ScopedConfigurationValues = {};
    const provenance: EffectiveConfiguration['provenance'] = {};
    const apply = (
      source: ScopedConfigurationValues | undefined,
      scope: 'default' | 'global' | 'project' | 'session' | 'environment',
      label: string,
    ): void => {
      for (const [rawKey, value] of Object.entries(source ?? {})) {
        if (value === undefined) continue;
        const key = rawKey as keyof ScopedConfigurationValues;
        Object.assign(values, { [key]: structuredClone(value) });
        Object.assign(provenance, { [key]: { value: structuredClone(value), scope, source: label } });
      }
    };
    apply(input.defaults, 'default', 'built-in');
    apply(this.data.global, 'global', 'global');
    if (input.projectId) apply(this.data.projects[input.projectId], 'project', input.projectId);
    if (input.sessionId) apply(this.data.sessions[input.sessionId], 'session', input.sessionId);
    apply(input.runtimeSession, 'session', input.sessionId ?? 'runtime-session');
    apply(input.environment, 'environment', 'environment');
    return { values, provenance };
  }

  private validateScope(scope: ConfigurationScope, id?: string): void {
    if (!['global', 'project', 'session'].includes(scope)
      || (scope !== 'global' && (!id || id.length > 2_000 || /[\u0000-\u001f\u007f]/.test(id)
        || ['__proto__', 'prototype', 'constructor'].includes(id)))) invalidConfiguration('Invalid configuration scope.');
  }

  private serialise<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.filePath);
    const result = (mutations.get(key) ?? Promise.resolve()).then(operation);
    const queued = result.then(() => undefined, () => undefined);
    mutations.set(key, queued);
    void queued.then(() => { if (mutations.get(key) === queued) mutations.delete(key); });
    return result;
  }

  private mutate(scope: ConfigurationScope, id: string | undefined,
    update: (target: ScopedConfigurationValues, globalBase: ScopedConfigurationValues) => ScopedConfigurationValues): Promise<ScopedConfigurationValues> {
    return this.serialise(async () => {
      const key = path.resolve(this.filePath);
      // Fresh read, serialized by pathname across service generations. Never
      // replace unreadable settings or publish an uncommitted value in memory.
      const before = await this.read();
      const snapshot = before.data;
      const previous = scope === 'global' ? snapshot.global
        : (scope === 'project' ? snapshot.projects[id!] : snapshot.sessions[id!]) ?? {};
      const target = validateValues(update(structuredClone(previous),
        structuredClone(scope === 'global' ? {} : snapshot.global)));
      if (JSON.stringify(target) === JSON.stringify(previous)) {
        this.data = snapshot;
        return structuredClone(target);
      }
      if (scope === 'global') snapshot.global = target;
      else if (scope === 'project') snapshot.projects[id!] = target;
      else snapshot.sessions[id!] = target;
      await mkdir(path.dirname(key), { recursive: true, mode: 0o700 });
      await atomicWriteStableFile(key, `${JSON.stringify(snapshot, null, 2)}\n`, {
        overwrite: true, mode: 0o600, maxBytes: MAX_CONFIGURATION_BYTES,
        beforeCommit: async () => {
          if ((await this.read()).source !== before.source) {
            throw Object.assign(new Error('Configuration changed before commit.'), { status: 409, code: 'CONFIGURATION_CHANGED' });
          }
        },
      });
      this.data = snapshot;
      return structuredClone(target);
    });
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('ConfigurationStore.load() must be awaited before use.');
  }
}

export { validateValues as validateConfigurationValues };
