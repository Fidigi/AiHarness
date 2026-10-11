import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, readlink, realpath, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStableDirectoryHandle, readStableDirectorySnapshot } from './stable-directory.js';
import { LinkedDirectoryStore, type LinkedConsentDocument } from './linked-directory-store.js';
import { LinkedDirectoryError, type LinkedDirectoryAccess, type LinkedDirectoryContent, type LinkedDirectoryEntry,
  type LinkedDirectoryInventory, type LinkedDirectoryListing, type LinkedDirectorySelector } from './linked-directory-types.js';
import type { WorkspaceManager } from './workspace-manager.js';
import { linkedDirectoryHasHiddenCharacters } from './linked-directory-helpers.js';

const LIMIT = 500;
const MAX_PATH = 4096;
const MAX_DEPTH = 64;
const MAX_BODY = 2 * 1024 * 1024;
const secret = randomBytes(32); // Only opaque UI IDs/revisions; durable grants bind hashed identities instead.
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const opaque = (value: unknown): string => createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex');
function inside(root: string, target: string): boolean {
  return root === target || target.startsWith(root === path.parse(root).root ? root : `${root}${path.sep}`);
}
function bounded(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_PATH
    && !value.includes('\0') && value.split(path.sep).length <= MAX_DEPTH;
}
function relative(value: string): string[] {
  if (!bounded(value) || path.isAbsolute(value) || value.includes('\\')) throw new LinkedDirectoryError('invalid-request');
  if (value === '.') return [];
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new LinkedDirectoryError('invalid-request');
  return parts;
}
function identity(info: Stats): number[] { return [info.dev, info.ino]; }
interface Candidate { entry: LinkedDirectoryEntry; key: string; binding?: string; link: string; target?: string }
interface Snapshot { inventory: LinkedDirectoryInventory; candidates: Candidate[]; document: LinkedConsentDocument }

/**
 * Source/link-scoped file access. This does not widen WorkspaceManager roots.
 * Linux descriptor anchoring prevents pathname swaps from redirecting operations.
 * No command, Git, instruction, project-body discovery or trust grant is provided.
 */
export class LinkedDirectoryConsent {
  private readonly store: LinkedDirectoryStore;
  constructor(private readonly workspaces: WorkspaceManager, options: { storeDirectory: string; protectedPaths?: string[]; homeDir?: string }) {
    if (!bounded(options.storeDirectory) || !path.isAbsolute(options.storeDirectory)) throw new LinkedDirectoryError('invalid-request');
    this.store = new LinkedDirectoryStore(options.storeDirectory);
    this.homeDir = options.homeDir ?? os.homedir();
    this.protectedPaths = [options.storeDirectory, '/proc', '/sys', '/dev', ...(options.protectedPaths ?? [])];
    if (this.protectedPaths.length > 64 || this.protectedPaths.some(value => !bounded(value) || !path.isAbsolute(value))) {
      throw new LinkedDirectoryError('invalid-request');
    }
  }
  private readonly protectedPaths: string[];
  private readonly homeDir: string;

  private async source(cwd: string, directory: string): Promise<{ cwd: string; directory: string; sourceIdentity: number[] }> {
    if (!bounded(cwd)) throw new LinkedDirectoryError('invalid-request');
    relative(directory);
    const canonical = await this.workspaces.resolve(cwd, { kind: 'directory' });
    // The source must be an ordinary configured-root workspace, never another grant.
    const parent = await this.workspaces.resolve(directory, { base: canonical, kind: 'directory' });
    if (!inside(canonical, parent) || parent !== path.resolve(canonical, directory)) throw new LinkedDirectoryError('unsafe-target');
    if (inside(canonical, this.store.directory) || inside(this.store.directory, canonical)) throw new LinkedDirectoryError('store-unavailable');
    const handle = await openStableDirectoryHandle(parent).catch(() => { throw new LinkedDirectoryError('unsafe-target'); });
    try {
      const [source, opened, current] = await Promise.all([lstat(canonical), handle.stat(), lstat(parent)]);
      if (source.isSymbolicLink() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new LinkedDirectoryError('unsafe-target');
      }
      return { cwd: canonical, directory: parent, sourceIdentity: [...identity(source), ...identity(opened)] };
    } finally { await handle.close(); }
  }

  private async candidate(cwd: string, parent: string, name: string, sourceIdentity: number[]): Promise<Candidate> {
    const link = path.join(parent, name);
    const key = digest([cwd, path.relative(cwd, link)]);
    const entry: LinkedDirectoryEntry = { id: opaque(key), name, hiddenCharacters: linkedDirectoryHasHiddenCharacters(name), reason: 'unavailable', allowed: false };
    const candidate: Candidate = { entry, key, link };
    let parentHandle: FileHandle | undefined;
    try {
      if (!bounded(link)) { entry.reason = 'unsafe-target'; return candidate; }
      parentHandle = await openStableDirectoryHandle(parent);
      const parentInfo = await parentHandle.stat();
      if (parentInfo.dev !== sourceIdentity[2] || parentInfo.ino !== sourceIdentity[3]) throw new LinkedDirectoryError('stale-entry');
      const anchoredLink = process.platform === 'linux' ? `/proc/self/fd/${parentHandle.fd}/${name}` : link;
      const before = await lstat(anchoredLink);
      if (!before.isSymbolicLink()) throw new LinkedDirectoryError('stale-entry');
      const raw = await readlink(anchoredLink);
      if (!bounded(raw)) { entry.reason = 'unsafe-target'; return candidate; }
      entry.rawTarget = raw;
      entry.hiddenCharacters ||= linkedDirectoryHasHiddenCharacters(raw);
      const lexical = path.resolve(parent, raw);
      if (!bounded(lexical)) { entry.reason = 'unsafe-target'; return candidate; }
      const target = await realpath(lexical);
      if (!bounded(target)) { entry.reason = 'unsafe-target'; return candidate; }
      entry.canonicalTarget = target;
      entry.hiddenCharacters ||= linkedDirectoryHasHiddenCharacters(target);
      // Keep in-root links on the existing default path, not this outside-root consent surface.
      if (this.workspaces.getAllowedRoots().some(root => inside(root, target))) return candidate;
      if (target !== lexical || path.dirname(target) === target || inside(target, cwd) || inside(target, this.homeDir)
        || this.protectedPaths.some(protectedPath => inside(target, protectedPath) || inside(protectedPath, target))) {
        entry.reason = 'unsafe-target'; return candidate;
      }
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink()) { entry.reason = 'not-directory'; return candidate; }
      if (process.platform !== 'linux') { entry.reason = 'unsupported-platform'; return candidate; }
      // Inventory inspects metadata only: no target handle, enumeration or body open.
      // Descriptor anchoring is deferred until an explicitly authorized browse/read.
      const [after, targetAfter] = await Promise.all([lstat(anchoredLink), lstat(target)]);
      if (!after.isSymbolicLink() || digest([identity(before), before.ctimeMs, before.mtimeMs]) !== digest([identity(after), after.ctimeMs, after.mtimeMs])
        || await readlink(anchoredLink) !== raw || await realpath(lexical) !== target
        || !targetAfter.isDirectory() || targetAfter.isSymbolicLink() || targetAfter.dev !== info.dev || targetAfter.ino !== info.ino) {
        throw new LinkedDirectoryError('stale-entry');
      }
      candidate.target = target;
      candidate.binding = digest([cwd, sourceIdentity, link, identity(before), before.ctimeMs, before.mtimeMs, raw, target, identity(info)]);
      entry.reason = 'directory';
      return candidate;
    } catch { return candidate; }
    finally { await parentHandle?.close(); }
  }

  private async snapshot(cwd: string, directory: string): Promise<Snapshot> {
    const source = await this.source(cwd, directory);
    const document = await this.store.read(); // Fresh across instances and reloads; never cached consent.
    const listing = await readStableDirectorySnapshot(source.directory, LIMIT);
    const candidates: Candidate[] = [];
    for (const { entry } of listing.entries) {
      if (!entry.isSymbolicLink()) continue;
      const candidate = await this.candidate(source.cwd, source.directory, entry.name, source.sourceIdentity);
      if (candidate.entry.canonicalTarget && this.workspaces.getAllowedRoots().some(root => inside(root, candidate.entry.canonicalTarget!))) continue;
      candidate.entry.allowed = Boolean(candidate.binding && document.grants.some(grant => grant.key === candidate.key && grant.binding === candidate.binding));
      candidates.push(candidate);
    }
    candidates.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
    const verified = await this.source(cwd, directory);
    if (digest(verified.sourceIdentity) !== digest(source.sourceIdentity)) throw new LinkedDirectoryError('stale-entry');
    const inventory: LinkedDirectoryInventory = {
      cwd: source.cwd, directory, entries: candidates.map(candidate => candidate.entry), truncated: listing.truncated,
      revision: opaque([source, candidates.map(candidate => [candidate.key, candidate.binding, candidate.entry]), document.generation]),
      restriction: 'scoped-files-only',
    };
    return { inventory, candidates, document };
  }

  async list(cwd: string, directory = '.'): Promise<LinkedDirectoryInventory> {
    return this.store.locked(async () => (await this.snapshot(cwd, directory)).inventory);
  }

  private select(snapshot: Snapshot, selector: LinkedDirectorySelector): Candidate {
    if (!/^[a-f0-9]{64}$/u.test(selector.id) || selector.revision !== snapshot.inventory.revision) throw new LinkedDirectoryError('stale-entry');
    const candidate = snapshot.candidates.find(item => item.entry.id === selector.id);
    if (!candidate) throw new LinkedDirectoryError('stale-entry');
    return candidate;
  }

  async setConsent(selector: LinkedDirectorySelector, allow: boolean, confirm: true): Promise<LinkedDirectoryInventory> {
    if (confirm !== true || typeof allow !== 'boolean') throw new LinkedDirectoryError('invalid-request');
    return this.store.locked(async () => {
      const snapshot = await this.snapshot(selector.cwd, selector.directory);
      const candidate = this.select(snapshot, selector);
      if (allow && (!candidate.binding || candidate.entry.reason !== 'directory')) throw new LinkedDirectoryError('unsafe-target');
      const grants = snapshot.document.grants.filter(grant => grant.key !== candidate.key);
      if (allow) grants.push({ key: candidate.key, binding: candidate.binding! });
      await this.store.write({ ...snapshot.document, grants }, async () => {
        const current = await this.snapshot(selector.cwd, selector.directory);
        this.select(current, selector);
      });
      return (await this.snapshot(selector.cwd, selector.directory)).inventory;
    });
  }

  private async access<T>(selector: LinkedDirectoryAccess, kind: 'file' | 'directory', operation: (handle: FileHandle, info: Stats) => Promise<T>, authorize?: () => Promise<void>): Promise<T> {
    const parts = relative(selector.path);
    if (kind === 'file' && !parts.length) throw new LinkedDirectoryError('invalid-request');
    return this.store.locked(async () => {
      const snapshot = await this.snapshot(selector.cwd, selector.directory);
      const candidate = this.select(snapshot, selector);
      if (!candidate.entry.allowed || !candidate.target || !candidate.binding) throw new LinkedDirectoryError('consent-required');
      const handles: FileHandle[] = [];
      const observed: Array<{ absolute: string; info: Stats }> = [];
      let authorizationFailure: unknown;
      const requireAuthorization = async () => {
        try { await authorize?.(); }
        catch (error) { authorizationFailure = error; throw error; }
      };
      const guard = async (): Promise<void> => {
        const current = await this.snapshot(selector.cwd, selector.directory);
        const latest = this.select(current, selector);
        if (!latest.entry.allowed || latest.binding !== candidate.binding) throw new LinkedDirectoryError('consent-required');
        for (const { absolute, info } of observed) {
          const now = await lstat(absolute);
          if (now.isSymbolicLink() || now.dev !== info.dev || now.ino !== info.ino) throw new LinkedDirectoryError('unsafe-target');
        }
        await requireAuthorization();
      };
      await guard(); // Fresh source/link/target/consent and host policy before opening the target.
      try {
        let handle = await openStableDirectoryHandle(candidate.target);
        handles.push(handle);
        let absolute = candidate.target;
        const rootInfo = await handle.stat();
        observed.push({ absolute, info: rootInfo });
        for (let index = 0; index < parts.length; index++) {
          absolute = path.join(absolute, parts[index]);
          if (!bounded(absolute) || !inside(candidate.target, absolute)) throw new LinkedDirectoryError('invalid-request');
          const finalFile = kind === 'file' && index === parts.length - 1;
          const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (finalFile ? 0 : constants.O_DIRECTORY);
          const anchored = `/proc/self/fd/${handle.fd}/${parts[index]}`;
          const before = await lstat(anchored);
          if (before.isSymbolicLink() || (finalFile ? !before.isFile() || before.nlink !== 1 : !before.isDirectory())) throw new LinkedDirectoryError('unsafe-target');
          await guard(); // Every descendant handle requires a fresh locked authorization.
          handle = await open(anchored, flags);
          handles.push(handle);
          const info = await handle.stat();
          if (info.dev !== before.dev || info.ino !== before.ino) throw new LinkedDirectoryError('unsafe-target');
          observed.push({ absolute, info });
        }
        await guard(); // Before any target enumeration or body read.
        const info = await handle.stat();
        const value = await operation(handle, info);
        await guard();
        const after = await handle.stat();
        if (kind === 'file' && (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.nlink !== 1)) throw new LinkedDirectoryError('unsafe-target');
        return value;
      } catch (error) {
        if (error instanceof LinkedDirectoryError || (authorize && error === authorizationFailure)) throw error;
        throw new LinkedDirectoryError('unsafe-target');
      } finally { await Promise.all(handles.map(handle => handle.close())); }
    });
  }

  /** Optional host authorization is reread inside the lock, before opening/reading and before returning. */
  async browse(selector: LinkedDirectoryAccess, authorize?: () => Promise<void>): Promise<LinkedDirectoryListing> {
    return this.access(selector, 'directory', async handle => {
      const entries: LinkedDirectoryListing['entries'] = [];
      const directory = await opendir(`/proc/self/fd/${handle.fd}`);
      let truncated = false;
      try {
        for await (const entry of directory) {
          if (entries.length >= LIMIT) { truncated = true; break; }
          const info = await lstat(`/proc/self/fd/${handle.fd}/${entry.name}`);
          entries.push({ name: entry.name, path: selector.path === '.' ? entry.name : `${selector.path}/${entry.name}`,
            isDirectory: info.isDirectory(), blocked: info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1 || info.size > MAX_BODY)) });
        }
      } finally { await directory.close().catch(() => undefined); }
      entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      return { path: selector.path, entries, truncated };
    }, authorize);
  }

  async read(selector: LinkedDirectoryAccess, authorize?: () => Promise<void>): Promise<LinkedDirectoryContent> {
    return this.access(selector, 'file', async (handle, info) => {
      if (!info.isFile() || info.nlink !== 1) throw new LinkedDirectoryError('unsafe-target');
      if (info.size > MAX_BODY) throw new LinkedDirectoryError('too-large');
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await handle.read(bytes, count, bytes.length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      if (count !== info.size || bytes.subarray(0, count).includes(0)) throw new LinkedDirectoryError('unsafe-target');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
      return { path: selector.path, content, size: info.size };
    }, authorize);
  }
}
