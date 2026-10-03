import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

const SECRET_KEY = /(?:secret|token|password|api[-_]?key|authorization|credential)/i;
const STRING_KEYS = new Set<keyof ScopedConfigurationValues>([
  'provider', 'model', 'thinking', 'toolPreset', 'systemPrompt',
]);
const ARRAY_KEYS = new Set<keyof ScopedConfigurationValues>([
  'enabledModels', 'enabledSkills', 'enabledPlugins', 'enabledTools',
]);

function cloneFile(value: ConfigurationFile): ConfigurationFile {
  return structuredClone(value);
}

function invalidConfiguration(message: string): never {
  throw Object.assign(new Error(message), { status: 400, code: 'INVALID_CONFIGURATION' });
}

function validateValues(input: unknown): ScopedConfigurationValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidConfiguration('Configuration invalide.');
  const result: ScopedConfigurationValues = {};
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY.test(rawKey)) invalidConfiguration('Les secrets ne sont pas acceptés dans la configuration.');
    const key = rawKey as keyof ScopedConfigurationValues;
    if (STRING_KEYS.has(key)) {
      if (typeof value !== 'string' || value.length > 100_000) invalidConfiguration(`Valeur invalide pour ${rawKey}.`);
      if (key === 'thinking' && !['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
        invalidConfiguration('Niveau de réflexion invalide.');
      }
      if (key === 'toolPreset' && !['configured', 'chat-only', 'read-only', 'default', 'full'].includes(value)) {
        invalidConfiguration("Preset d'outils invalide.");
      }
      Object.assign(result, { [key]: value });
    } else if (ARRAY_KEYS.has(key)) {
      if (!Array.isArray(value) || value.length > 2_000 || !value.every(item => typeof item === 'string' && item.length <= 500)) {
        invalidConfiguration(`Valeur invalide pour ${rawKey}.`);
      }
      Object.assign(result, { [key]: [...new Set(value)] });
    } else if (key === 'autoCompaction' || key === 'powershellEnabled') {
      if (typeof value !== 'boolean') invalidConfiguration(`Valeur invalide pour ${key}.`);
      Object.assign(result, { [key]: value });
    } else {
      invalidConfiguration(`Clé de configuration inconnue : ${rawKey}.`);
    }
  }
  return result;
}

function validatePatchValues(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidConfiguration('Configuration invalide.');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value !== null) {
      Object.assign(result, validateValues({ [key]: value }));
      continue;
    }
    if (SECRET_KEY.test(key)
      || (!STRING_KEYS.has(key as keyof ScopedConfigurationValues)
        && !ARRAY_KEYS.has(key as keyof ScopedConfigurationValues)
        && key !== 'autoCompaction' && key !== 'powershellEnabled')) {
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
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<ConfigurationFile>;
      if (parsed.version !== 1) throw new Error('Version de configuration non prise en charge.');
      this.data = {
        version: 1,
        global: validateValues(parsed.global ?? {}),
        projects: Object.fromEntries(Object.entries(parsed.projects ?? {}).map(([id, values]) => [id, validateValues(values)])),
        sessions: Object.fromEntries(Object.entries(parsed.sessions ?? {}).map(([id, values]) => [id, validateValues(values)])),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.data = cloneFile(EMPTY_FILE);
    }
    this.loaded = true;
  }

  get(scope: ConfigurationScope, scopeId?: string): ScopedConfigurationValues {
    this.assertLoaded();
    if (scope === 'global') return structuredClone(this.data.global);
    if (!scopeId) invalidConfiguration(`scopeId requis pour la portée ${scope}.`);
    return structuredClone(scope === 'project'
      ? this.data.projects[scopeId] ?? {}
      : this.data.sessions[scopeId] ?? {});
  }

  async patch(scope: ConfigurationScope, values: unknown, scopeId?: string): Promise<ScopedConfigurationValues> {
    this.assertLoaded();
    const patch = validatePatchValues(values);
    if (scope !== 'global' && (!scopeId || scopeId.length > 2_000)) {
      invalidConfiguration(`scopeId requis pour la portée ${scope}.`);
    }
    const target: ScopedConfigurationValues = scope === 'global'
      ? { ...this.data.global }
      : scope === 'project' ? { ...(this.data.projects[scopeId!] ?? {}) }
        : { ...(this.data.sessions[scopeId!] ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete (target as Record<string, unknown>)[key];
      else Object.assign(target, { [key]: value });
    }
    if (scope === 'global') this.data.global = target;
    else if (scope === 'project') this.data.projects[scopeId!] = target;
    else this.data.sessions[scopeId!] = target;
    await this.persist();
    return this.get(scope, scopeId);
  }

  async replace(scope: ConfigurationScope, values: unknown, scopeId?: string): Promise<ScopedConfigurationValues> {
    this.assertLoaded();
    const replacement = validateValues(values);
    if (scope !== 'global' && !scopeId) invalidConfiguration(`scopeId requis pour la portée ${scope}.`);
    if (scope === 'global') this.data.global = replacement;
    else if (scope === 'project') this.data.projects[scopeId!] = replacement;
    else this.data.sessions[scopeId!] = replacement;
    await this.persist();
    return this.get(scope, scopeId);
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

  private persist(): Promise<void> {
    const snapshot = cloneFile(this.data);
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('ConfigurationStore.load() must be awaited before use.');
  }
}

export { validateValues as validateConfigurationValues };
