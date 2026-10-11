import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStableDirectoryHandle } from './stable-directory.js';
import { atomicWriteStableFile } from './stable-file.js';
import { releaseStableLockPath } from './stable-lock.js';
import { LinkedDirectoryError } from './linked-directory-types.js';
import { parseLinkedDirectoryStoreJson } from './linked-directory-helpers.js';

const MAX_BYTES = 128 * 1024;
const MAX_GRANTS = 256;
interface Grant { key: string; binding: string }
export interface LinkedConsentDocument { version: 1; generation: string; grants: Grant[] }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function privateFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1
    && (info.mode & 0o077) === 0 && (!process.getuid || info.uid === process.getuid());
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
/** Bounded private hashed consent. No target paths, link text, bodies or credentials. */
export class LinkedDirectoryStore {
  private readonly file: string;
  private directoryIdentity?: { dev: number; ino: number };
  constructor(readonly directory: string) { this.file = path.join(directory, 'linked-directories.json'); }

  private async parent(): Promise<FileHandle> {
    if (process.platform !== 'linux') throw new LinkedDirectoryError('unsupported-platform');
    const handle = await openStableDirectoryHandle(this.directory).catch(() => { throw new LinkedDirectoryError('store-unavailable'); });
    try {
      const info = await handle.stat();
      const current = await lstat(this.directory);
      if (!info.isDirectory() || current.isSymbolicLink() || info.dev !== current.dev || info.ino !== current.ino
        || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
        throw new LinkedDirectoryError('store-unavailable');
      }
      if (this.directoryIdentity && (this.directoryIdentity.dev !== info.dev || this.directoryIdentity.ino !== info.ino)) {
        throw new LinkedDirectoryError('store-unavailable');
      }
      this.directoryIdentity = { dev: info.dev, ino: info.ino };
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  async read(): Promise<LinkedConsentDocument> {
    const parent = await this.parent();
    let handle: FileHandle | undefined;
    try {
      const anchored = `/proc/self/fd/${parent.fd}/linked-directories.json`;
      const before = await lstat(anchored).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (!before) return { version: 1, generation: 'missing', grants: [] };
      if (!privateFile(before) || before.size > MAX_BYTES) throw new LinkedDirectoryError('store-unavailable');
      handle = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!privateFile(opened) || !same(before, opened)) throw new LinkedDirectoryError('store-unavailable');
      const bytes = Buffer.alloc(opened.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await handle.read(bytes, count, bytes.length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      const [after, current, parentAfter] = await Promise.all([handle.stat(), lstat(anchored), lstat(this.directory)]);
      const parentInfo = await parent.stat();
      if (count !== opened.size || !privateFile(current) || !same(opened, after) || !same(after, current)
        || parentAfter.isSymbolicLink() || parentInfo.dev !== parentAfter.dev || parentInfo.ino !== parentAfter.ino) {
        throw new LinkedDirectoryError('store-unavailable');
      }
      const value = parseLinkedDirectoryStoreJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))) as LinkedConsentDocument;
      if (!value || value.version !== 1 || typeof value.generation !== 'string'
        || !/^[a-f0-9-]{36}$/u.test(value.generation) || !Array.isArray(value.grants) || value.grants.length > MAX_GRANTS
        || Object.keys(value).some(key => !['version', 'generation', 'grants'].includes(key))
        || value.grants.some(grant => !grant || !hash(grant.key) || !hash(grant.binding)
          || Object.keys(grant).some(key => !['key', 'binding'].includes(key)))
        || new Set(value.grants.map(grant => grant.key)).size !== value.grants.length) {
        throw new LinkedDirectoryError('store-unavailable');
      }
      return value;
    } catch { throw new LinkedDirectoryError('store-unavailable'); }
    finally { await handle?.close(); await parent.close(); }
  }

  async write(document: LinkedConsentDocument, guard: () => Promise<void>): Promise<void> {
    if (document.grants.length > MAX_GRANTS) throw new LinkedDirectoryError('too-large');
    const next = { ...document, generation: randomUUID() };
    await atomicWriteStableFile(this.file, `${JSON.stringify(next)}\n`, {
      overwrite: true, mode: 0o600, maxBytes: MAX_BYTES, beforeCommit: guard,
    }).catch(error => { if (error instanceof LinkedDirectoryError) throw error; throw new LinkedDirectoryError('store-unavailable'); });
  }

  /** All cooperating reads and mutations serialize; stale locks fail closed, never guessed away. */
  async locked<T>(operation: () => Promise<T>): Promise<T> {
    const parent = await this.parent();
    const anchored = `/proc/self/fd/${parent.fd}/linked-directories.json.lock`;
    let lock: FileHandle | undefined;
    let identity: Stats | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          lock = await open(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          identity = await lock.stat();
          if (!privateFile(identity)) throw new LinkedDirectoryError('store-unavailable');
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const info = await lstat(anchored);
          if (!privateFile(info)) throw new LinkedDirectoryError('store-unavailable');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      if (!lock) throw new LinkedDirectoryError('busy');
      return await operation();
    } finally {
      await lock?.close();
      if (identity) await releaseStableLockPath(anchored, identity);
      await parent.close();
    }
  }
}
