/** AiHarness extension API v1 startup option metadata. Names omit the leading --. */
export type ExtensionOption =
  | { type: 'boolean'; description: string; default?: boolean; completions?: never }
  | { type: 'string'; description: string; default?: string; completions?: readonly string[] };

export type ExtensionOptionValue = boolean | string;
export type ExtensionOptionDescriptor = ExtensionOption & { name: string; extensionId: string };

/** All built-in long names, including aliases and metadata-only operations, are reserved. */
export const RESERVED_STARTUP_OPTIONS: ReadonlySet<string> = new Set([
  'help', 'version', 'print', 'rpc', 'mode', 'continue', 'resume', 'session', 'session-id',
  'fork', 'session-dir', 'name', 'no-session', 'theme', 'extension', 'skill', 'prompt-template',
  'no-skills', 'no-prompt-templates', 'tui-mode', 'regular', 'no-fullscreen', 'fullscreen',
  'tools', 'exclude-tools', 'no-tools', 'no-builtin-tools', 'provider', 'model', 'models',
  'list-models', 'api-key', 'system-prompt', 'append-system-prompt', 'no-context-files',
  'approve', 'no-approve', 'thinking', 'help-extensions', 'completion',
]);

export function validateExtensionOption(name: string, metadata: ExtensionOption): ExtensionOption {
  const invalid = (): never => { throw new Error('Invalid extension startup option metadata.'); };
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)
    || RESERVED_STARTUP_OPTIONS.has(name)) return invalid();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || Object.keys(metadata).some(key => !['type', 'description', 'default', 'completions'].includes(key))
    || !['boolean', 'string'].includes(metadata.type)
    || typeof metadata.description !== 'string' || !metadata.description.trim()
    || metadata.description.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(metadata.description)) return invalid();
  if (metadata.default !== undefined && (typeof metadata.default !== metadata.type
    || (typeof metadata.default === 'string' && (metadata.default.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(metadata.default))))) return invalid();
  if (metadata.completions !== undefined && (metadata.type !== 'string'
    || !Array.isArray(metadata.completions) || metadata.completions.length > 64
    || metadata.completions.some(value => typeof value !== 'string' || !value || value.length > 256
      || /[\x00-\x1f\x7f-\x9f]/.test(value)))) return invalid();
  return Object.freeze({ ...metadata, ...(metadata.completions ? { completions: Object.freeze([...new Set(metadata.completions)]) } : {}) }) as ExtensionOption;
}
