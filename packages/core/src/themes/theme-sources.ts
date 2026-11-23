import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { openStableDirectoryHandle, readStableDirectorySnapshot } from '../security/stable-directory.js';
import { isResourcePathWithin, selectResourceFiles } from '../resources/file-selectors.js';
import type { ResourceScope, ResourceSource } from '../resources/resource-manager.js';
import type { ThemeLoadContext, ThemeSource } from './theme-manager.js';

/** Ordered metadata selectors. Literal additions use +; baseDir is never a glob. */
export interface ThemeSourceSelector {
  readonly pattern: string;
  readonly baseDir: string;
  readonly scope: ResourceScope;
  readonly source: ResourceSource;
  readonly trusted: boolean;
}

const failure = (): Error => new Error('Theme sources are invalid or exceed their limits.');
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Discover JSON filenames without reading palettes. Returned sources are ordered
 * highest-priority first for ThemeManager's existing first-match contract. */
export async function discoverThemeSources(
  selectors: readonly ThemeSourceSelector[],
  context: Readonly<ThemeLoadContext>,
): Promise<ThemeSource[]> {
  try {
    if (!context || typeof context !== 'object' || !Array.isArray(selectors) || selectors.length > 1_000) throw failure();
    const cwdValue = own(context, 'cwd');
    const trusted = own(context, 'projectTrusted');
    if (typeof cwdValue !== 'string' || !path.isAbsolute(cwdValue) || cwdValue.includes('\0')
      || Buffer.byteLength(cwdValue) > 32_768 || typeof trusted !== 'boolean') throw failure();
    const cwd = path.resolve(cwdValue);
    const requests: ThemeSourceSelector[] = [];
    for (const value of selectors) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
      const scope = own(value, 'scope');
      const source = own(value, 'source');
      const eligible = own(value, 'trusted');
      if ((scope !== 'user' && scope !== 'project' && scope !== 'temporary')
        || (source !== 'auto' && source !== 'settings' && source !== 'package' && source !== 'cli')
        || typeof eligible !== 'boolean') throw failure();
      if (!eligible || (scope === 'project' && !trusted)) continue;
      const pattern = own(value, 'pattern');
      const baseDir = own(value, 'baseDir');
      if (typeof pattern !== 'string' || typeof baseDir !== 'string') throw failure();
      requests.push(Object.freeze({ pattern, baseDir, scope, source, trusted: eligible }));
    }
    const allowed = (candidate: string): boolean => trusted
      || !(isResourcePathWithin(candidate, cwd) || isResourcePathWithin(cwd, candidate));
    let probes = 0;
    let directories = 0;
    let entries = 0;
    const probe = async (candidate: string) => {
      if (++probes > 10_000 || Buffer.byteLength(candidate) > 32_768) throw failure();
      const parentPath = path.dirname(candidate);
      const parent = await openStableDirectoryHandle(parentPath);
      try {
        const opened = await parent.stat();
        const validate = async (): Promise<void> => {
          const named = await lstat(parentPath);
          if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
            || named.dev !== opened.dev || named.ino !== opened.ino) throw failure();
        };
        await validate();
        const target = process.platform === 'linux'
          ? `/proc/self/fd/${parent.fd}/${path.basename(candidate)}` : candidate;
        const info = await lstat(target);
        await validate();
        return info;
      } finally { await parent.close(); }
    };
    const discover = async (candidate: string, directoryOnly = false): Promise<string[]> => {
      if (!allowed(candidate)) return [];
      let info;
      try { info = await probe(candidate); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      if (info.isSymbolicLink()) return [];
      if (info.isFile()) return !directoryOnly && info.nlink === 1 && candidate.endsWith('.json') ? [candidate] : [];
      if (!info.isDirectory()) return [];
      if (++directories > 256) throw failure();
      const listing = await readStableDirectorySnapshot(candidate, 1_000);
      entries += listing.entries.length;
      if (listing.truncated || entries > 10_000) throw failure();
      const files: string[] = [];
      for (const { entry, stats } of listing.entries.sort((left, right) => left.entry.name.localeCompare(right.entry.name))) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
        const file = path.join(candidate, entry.name);
        if (!allowed(file)) continue;
        if (++probes > 10_000 || Buffer.byteLength(file) > 32_768) throw failure();
        if (stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1) files.push(file);
      }
      return files;
    };
    let order = 0;
    const origins = new Map<string, { source: ThemeSource; order: number }>();
    const files = await selectResourceFiles([], requests, {
      cwd, allowed, discover, maxSelectors: 1_000,
      onInclude: (file, selector) => {
        origins.set(file, {
          source: {
            path: file,
            scope: isResourcePathWithin(file, cwd) ? 'project' : selector.scope,
            source: selector.source,
            trusted: true,
          },
          order: order++,
        });
      },
    });
    // ThemeManager inventories at most 512 custom sources. Refuse overflow
    // rather than admitting palettes that its interactive catalogue cannot show.
    if (files.length > 512) throw failure();
    return files.map(file => origins.get(file)!).sort((left, right) => right.order - left.order)
      .map(entry => ({ ...entry.source }));
  } catch { throw failure(); }
}
