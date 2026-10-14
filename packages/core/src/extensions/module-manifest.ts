import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { openStableDirectoryHandle } from '../security/stable-directory.js';
import { isExtensionPathWithin } from './extension-selectors.js';

/** One discovery operation shares these limits across all directory manifests. */
export interface ExtensionManifestBudget { manifests: number; bytes: number; entries: number; probes: number }
export class ExtensionManifestError extends Error {
  constructor() { super('Extension manifest is invalid or exceeds its limits.'); }
}

/** Stable metadata only, shared by resource declarations and literal Node main
 * resolution. No dependency or extension factory is evaluated here. */
export async function readExtensionPackage(directory: string, budget: ExtensionManifestBudget): Promise<Record<string, unknown> | undefined> {
  let parent: Awaited<ReturnType<typeof open>> | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    parent = await openStableDirectoryHandle(directory);
    const parentBefore = await parent.stat();
    const namedParent = await lstat(directory);
    if (!namedParent.isDirectory() || namedParent.isSymbolicLink()
      || namedParent.dev !== parentBefore.dev || namedParent.ino !== parentBefore.ino) throw new ExtensionManifestError();
    const manifest = path.join(directory, 'package.json');
    const anchored = process.platform === 'linux' ? `/proc/self/fd/${parent.fd}/package.json` : manifest;
    const before = await lstat(anchored).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!before) return undefined;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256 * 1024
      || ++budget.manifests > 200 || (budget.bytes += before.size) > 4 * 1024 * 1024) throw new ExtensionManifestError();
    file = await open(anchored, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await file.stat();
    const same = (value: typeof opened) => value.isFile() && !value.isSymbolicLink() && value.nlink === 1
      && value.dev === opened.dev && value.ino === opened.ino && value.size === opened.size
      && value.mtimeMs === opened.mtimeMs && value.ctimeMs === opened.ctimeMs;
    if (!same(before) || !same(opened)) throw new ExtensionManifestError();
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const [after, named, parentAfter] = await Promise.all([file.stat(), lstat(manifest), lstat(directory)]);
    if (offset !== bytes.length || !same(after) || !same(named) || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()
      || parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino || bytes.includes(0)) throw new ExtensionManifestError();
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/u, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ExtensionManifestError();
    return parsed as Record<string, unknown>;
  } catch {
    // JSON syntax errors may quote complete operator-owned source or metadata.
    throw new ExtensionManifestError();
  } finally {
    await file?.close().catch(() => undefined);
    await parent?.close().catch(() => undefined);
  }
}

/** Literal confined declaration, never a glob or bare package specifier. */
export function resolveExtensionManifestPath(directory: string, entry: unknown): string {
  if (typeof entry !== 'string' || !entry.length || Buffer.byteLength(entry) > 32_768
    || /[\u0000-\u001f\u007f]/u.test(entry) || path.isAbsolute(entry) || /^[a-z]:/iu.test(entry)) throw new ExtensionManifestError();
  const resolved = path.resolve(directory, entry.replace(/\\/gu, '/'));
  if (resolved === directory || !isExtensionPathWithin(resolved, directory)) throw new ExtensionManifestError();
  return resolved;
}

/** Undefined preserves ordinary discovery; [] explicitly selects no entries. */
export async function readExtensionManifest(directory: string, budget: ExtensionManifestBudget): Promise<string[] | undefined> {
  const object = await readExtensionPackage(directory, budget);
  if (!object) return undefined;
  const fields = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const declared: unknown = { ...fields(object.pi), ...fields(object.aiHarness) }.extensions;
  if (declared === undefined) return undefined;
  if (!Array.isArray(declared) || declared.length > 100 || (budget.entries += declared.length) > 1_000) throw new ExtensionManifestError();
  return declared.map(entry => resolveExtensionManifestPath(directory, entry));
}
