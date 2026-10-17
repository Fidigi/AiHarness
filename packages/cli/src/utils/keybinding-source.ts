import path from 'node:path';

export interface KeybindingSource {
  path?: string;
  kind: 'environment' | 'agent-directory';
  eligible: boolean;
  reason?: 'path' | 'agent-directory' | 'project-trust';
}
/** Literal, process-selected source metadata only. This does not read files or grant trust. */
export function resolveKeybindingSource(options: {
  cwd: string; home: string; agentDir: string; agentDirTrusted: boolean; projectTrusted: boolean; explicitPath?: string;
}): KeybindingSource {
  const explicit = Boolean(options.explicitPath?.trim());
  const kind = explicit ? 'environment' : 'agent-directory';
  const value = explicit ? options.explicitPath! : path.join(options.agentDir, 'keybindings.json');
  if (Buffer.byteLength(value, 'utf8') > 32_768 || /[\u0000-\u001f\u007f]/u.test(value)) return { kind, eligible: false, reason: 'path' };
  const expanded = value === '~' ? options.home
    : value.startsWith('~/') || value.startsWith('~\\') ? path.join(options.home, value.slice(2)) : value;
  const selected = path.resolve(options.cwd, expanded);
  if (!explicit && !options.agentDirTrusted) return { path: selected, kind, eligible: false, reason: 'agent-directory' };
  const relative = path.relative(path.resolve(options.cwd), selected);
  const projectLocated = !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  if (projectLocated && !options.projectTrusted) return { path: selected, kind, eligible: false, reason: 'project-trust' };
  return { path: selected, kind, eligible: true };
}
