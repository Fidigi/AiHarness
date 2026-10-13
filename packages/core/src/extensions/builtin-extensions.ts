import path from 'node:path';

/** Optional hosted capabilities, not the mandatory workspace/security machinery. */
export const BUILTIN_EXTENSION_NAMES = Object.freeze(['codemode', 'tool-search', 'mcp'] as const);
export type BuiltinExtensionName = typeof BUILTIN_EXTENSION_NAMES[number];
export type BuiltinExtensionPolicy = Readonly<Record<BuiltinExtensionName, boolean>>;

function entries(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200 || value.some(entry => typeof entry !== 'string'
    || !entry.length || entry.includes('\0') || Buffer.byteLength(entry) > 32_768)) {
    throw new Error('Built-in extension selectors are invalid or exceed their limits.');
  }
  return value;
}

function builtinName(value: string): BuiltinExtensionName | undefined {
  if (!value.startsWith('builtin:')) return undefined;
  const name = value.slice('builtin:'.length);
  if (!BUILTIN_EXTENSION_NAMES.some(known => known === name)) throw new Error('Unknown built-in extension.');
  return name as BuiltinExtensionName;
}

/** Metadata-only policy: never opens a path, grants project trust or activates a
 * tool. Global exact removal wins over exact addition; the last matching trusted
 * project override wins over global policy. Explicit CLI IDs have final priority. */
export function resolveBuiltinExtensionPolicy(options: {
  global?: readonly string[];
  project?: readonly string[];
  projectTrusted?: boolean;
  noExtensions?: boolean;
  explicit?: readonly string[];
} = {}): BuiltinExtensionPolicy {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || (options.noExtensions !== undefined && typeof options.noExtensions !== 'boolean')
    || (options.projectTrusted !== undefined && typeof options.projectTrusted !== 'boolean')) {
    throw new Error('Built-in extension policy options are invalid.');
  }
  const enabled = options.noExtensions !== true;
  const policy: Record<BuiltinExtensionName, boolean> = { codemode: enabled, 'tool-search': enabled, mcp: enabled };
  const apply = (entry: string): void => {
    const marker = entry[0];
    if (entry.length === 1 && ['!', '+', '-'].includes(marker!)) throw new Error('Built-in extension selector is invalid.');
    if (marker === '!') {
      const pattern = entry.slice(1);
      if (!/[*?[\]{}()]/u.test(pattern)) builtinName(pattern);
      for (const name of BUILTIN_EXTENSION_NAMES) {
        let matches: boolean;
        try { matches = path.posix.matchesGlob(`builtin:${name}`, pattern); }
        catch { throw new Error('Built-in extension selector is invalid.'); }
        if (matches) policy[name] = false;
      }
    } else {
      const name = builtinName(marker === '+' || marker === '-' ? entry.slice(1) : entry);
      if (name && (marker === '+' || marker === '-')) policy[name] = marker === '+';
    }
  };
  if (enabled) {
    const global = entries(options.global);
    // Validate bare IDs too; they name a default capability, not a filesystem path.
    for (const entry of global) if (!['!', '+', '-'].includes(entry[0]!)) apply(entry);
    for (const marker of ['!', '+', '-']) for (const entry of global) if (entry.startsWith(marker)) apply(entry);
    if (options.projectTrusted === true) for (const entry of entries(options.project)) apply(entry);
  }
  for (const entry of entries(options.explicit)) {
    const name = builtinName(entry);
    if (name) policy[name] = true;
  }
  return Object.freeze(policy);
}
