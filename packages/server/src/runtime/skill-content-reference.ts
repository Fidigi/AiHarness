import path from 'node:path';

export interface SkillContentReference { absolutePath: string; relativePath: string; fragment?: string }
const invalid = (): never => { throw Object.assign(new Error('Skill Markdown reference is invalid.'), { status: 400, code: 'INVALID_SKILL_REFERENCE' }); };
const controls = /[\u0000-\u001f\u007f]/u;

/** Resolve only Markdown data under an already authorized skill's declaring
 * directory. Neither a browser href nor the current page grants another root. */
export function skillContentReference(mainFile: string, href: string, from = path.basename(mainFile)): SkillContentReference {
  if (typeof href !== 'string' || !href || href.length > 4096 || controls.test(href)
    || href.includes('\\') || href.includes('?') || /^[a-z][a-z0-9+.-]*:/iu.test(href)) return invalid();
  if (typeof from !== 'string' || !from || from.length > 4096 || controls.test(from) || from.includes('\\')
    || path.posix.isAbsolute(from) || path.win32.isAbsolute(from) || !/\.(?:md|markdown)$/iu.test(from)
    || from.split('/').some(part => !part || part === '.' || part === '..')) return invalid();
  const hash = href.indexOf('#'), raw = hash < 0 ? href : href.slice(0, hash);
  let requested: string, fragment: string | undefined;
  try { requested = decodeURIComponent(raw); fragment = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1)); }
  catch { return invalid(); }
  if (!requested || controls.test(requested) || requested.includes('\\')
    || path.posix.isAbsolute(requested) || path.win32.isAbsolute(requested)
    || (process.platform === 'win32' && (requested.includes(':') || from.includes(':')))
    || (fragment !== undefined && controls.test(fragment))) return invalid();
  const base = path.dirname(path.resolve(mainFile)), absolutePath = path.resolve(base, path.dirname(from), requested);
  const relative = path.relative(base, absolutePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || !/\.(?:md|markdown)$/iu.test(relative)) return invalid();
  return { absolutePath, relativePath: relative.split(path.sep).join('/'), ...(fragment ? { fragment } : {}) };
}
