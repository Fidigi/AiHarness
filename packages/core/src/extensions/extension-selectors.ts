import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { readStableDirectoryEntries } from '../security/stable-directory.js';

const MAGIC = /[*?[\]{}()]/u;
const MAX_FILES = 1_000;

/** A declaring directory is literal filesystem identity, never glob syntax. */
export type ExtensionModuleSelector = string | {
  readonly pattern: string;
  readonly baseDir: string;
};

/** Internal lexical containment, including filesystem roots. */
export function isExtensionPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function matches(file: string, root: string, pattern: string): boolean {
  if (!isExtensionPathWithin(file, root)) return false;
  try { return path.matchesGlob(path.relative(root, file), pattern); } catch { return false; }
}

/** Internal metadata-only selection. Import authority remains with the loader's
 * fresh trust checks and stable descriptor-backed module admission. */
export async function selectExtensionFiles(
  initial: readonly string[],
  selectors: readonly ExtensionModuleSelector[],
  options: {
    cwd: string;
    allowed(candidate: string): boolean;
    discover(candidate: string): Promise<string[]>;
  },
): Promise<string[]> {
  if (!Array.isArray(selectors) || selectors.length > 200) throw new Error('Extension selectors exceed their count limit.');
  const normalized = selectors.map(selector => {
    const raw = typeof selector === 'string' ? selector : selector?.pattern;
    const base = typeof selector === 'string' ? options.cwd : selector?.baseDir;
    if (typeof raw !== 'string' || !raw.length || raw.includes('\0')
      || typeof base !== 'string' || !base.length || base.includes('\0')
      || (typeof selector !== 'string' && !path.isAbsolute(base))
      || Buffer.byteLength(raw) + (typeof selector === 'string' ? 0 : Buffer.byteLength(base)) > 32_768) {
      throw new Error('Extension selector is invalid.');
    }
    return { raw, base };
  });
  if (!normalized.length) return [...initial].sort();
  const selected = new Set(initial);
  const add = (files: readonly string[]): void => {
    for (const file of files) selected.add(file);
    if (selected.size > MAX_FILES) throw new Error('Extension selection exceeds its file limit.');
  };
  add([]);
  let directories = 0;
  let entries = 0;
  const walk = async (directory: string, root: string, pattern: string, depth: number, patternDepth: number): Promise<void> => {
    if (!options.allowed(directory)) return;
    if (++directories > 256) throw new Error('Extension glob exceeds its directory limit.');
    const listing = await readStableDirectoryEntries(directory, 1_000);
    entries += listing.entries.length;
    if (listing.truncated || entries > 10_000) throw new Error('Extension glob exceeds its entry limit.');
    for (const entry of listing.entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || !options.allowed(candidate)) continue;
      if (entry.isDirectory()) {
        if (depth >= patternDepth) continue;
        if (depth >= 8) throw new Error('Extension glob exceeds its depth limit.');
        await walk(candidate, root, pattern, depth + 1, patternDepth);
      } else if (entry.isFile() && matches(candidate, root, pattern)) {
        add(await options.discover(candidate));
      }
    }
  };
  for (const { raw, base } of normalized) {
    const marker = ['+', '-', '!'].includes(raw[0]!) ? raw[0] : '';
    const input = marker ? raw.slice(1) : raw;
    if (!input) throw new Error('Extension selector is invalid.');
    const value = path.normalize(input);
    const absolute = path.resolve(base, value);
    if (marker === '-') {
      for (const file of selected) if (isExtensionPathWithin(file, absolute)) selected.delete(file);
      continue;
    }
    // + is deliberately exact, so brackets and other glob characters in a
    // literal filename remain addressable. Existing options.paths is exact too.
    if (marker !== '!' && (marker === '+' || !MAGIC.test(value))) {
      if (options.allowed(absolute)) add(await options.discover(absolute));
      continue;
    }
    const prefix = MAGIC.test(value) ? value.slice(0, value.search(MAGIC)) : value;
    const separator = prefix.lastIndexOf(path.sep);
    const root = path.resolve(base, separator < 0 ? '.' : prefix.slice(0, separator) || path.parse(value).root);
    const pattern = path.relative(root, absolute);
    if (marker === '!') {
      for (const file of selected) if (matches(file, root, pattern)) selected.delete(file);
      continue;
    }
    if (!options.allowed(root)) continue;
    const info = await lstat(root).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Extension glob root is unavailable.');
    });
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    // Stable directory enumeration refuses symbolic ancestors and replacements.
    const patternDepth = pattern.includes('**') ? Infinity : pattern.split(path.sep).length - 1;
    await walk(root, root, pattern, 0, patternDepth);
  }
  return [...selected].sort();
}
