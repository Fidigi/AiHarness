import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { releaseStableLockPath } from './stable-lock.js';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_CREDENTIALS = 256;
const MAX_NAME_BYTES = 256;
const MAX_VALUE_BYTES = 64 * 1024;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;
const STALE_LOCK_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

interface EncryptedDocument {
  version: typeof STORE_VERSION;
  algorithm: 'aes-256-gcm';
  kdf: 'scrypt';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

export interface EncryptedCredentialStoreOptions {
  maxBytes?: number;
}

/** Stable, value-free failures suitable for CLI and server boundaries. */
export class CredentialStoreError extends Error {
  constructor(
    public readonly code:
      | 'invalid-key'
      | 'invalid-name'
      | 'invalid-value'
      | 'unsafe-store'
      | 'invalid-store'
      | 'store-too-large'
      | 'store-busy',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}

function invalidStore(): CredentialStoreError {
  return new CredentialStoreError('invalid-store', 'The credential store could not be opened.');
}

function validateName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!NAME_PATTERN.test(normalized) || Buffer.byteLength(normalized) > MAX_NAME_BYTES) {
    throw new CredentialStoreError('invalid-name', 'The credential name is invalid.');
  }
  return normalized;
}

function validateValue(value: string): string {
  if (!value || Buffer.byteLength(value) > MAX_VALUE_BYTES || value.includes('\0')) {
    throw new CredentialStoreError('invalid-value', 'The credential value is invalid.');
  }
  return value;
}

function decodeBase64(value: unknown, exactBytes?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalidStore();
  const decoded = Buffer.from(value, 'base64');
  if ((exactBytes !== undefined && decoded.length !== exactBytes)
    || decoded.toString('base64') !== value) throw invalidStore();
  return decoded;
}

function parseDocument(source: string, maxBytes = MAX_STORE_BYTES): EncryptedDocument {
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw invalidStore(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidStore();
  const value = parsed as Partial<EncryptedDocument>;
  if (value.version !== STORE_VERSION || value.algorithm !== 'aes-256-gcm' || value.kdf !== 'scrypt') {
    throw invalidStore();
  }
  decodeBase64(value.salt, 16);
  decodeBase64(value.iv, 12);
  decodeBase64(value.tag, 16);
  const encrypted = decodeBase64(value.data);
  if (encrypted.length > maxBytes) throw invalidStore();
  return value as EncryptedDocument;
}

function parseCredentials(source: string): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw invalidStore(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidStore();
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_CREDENTIALS) throw invalidStore();
  const credentials = Object.create(null) as Record<string, string>;
  for (const [name, value] of entries) {
    const normalized = validateName(name);
    if (normalized !== name || typeof value !== 'string') throw invalidStore();
    credentials[normalized] = validateValue(value);
  }
  return credentials;
}

async function deriveKey(masterKey: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      masterKey,
      salt,
      32,
      { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key as Buffer),
    );
  });
}

async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<string | undefined> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const directoryBefore = await lstat(directory);
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directoryHandle = await open(
      directory,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_DIRECTORY ?? 0),
    );
    const directoryOpened = await directoryHandle.stat();
    if (!directoryOpened.isDirectory() || directoryOpened.dev !== directoryBefore.dev
      || directoryOpened.ino !== directoryBefore.ino) {
      throw new CredentialStoreError('unsafe-store', 'The credential store directory changed unexpectedly.');
    }
    const anchoredDirectory = process.platform === 'linux' ? `/proc/self/fd/${directoryHandle.fd}` : directory;
    const target = path.join(anchoredDirectory, path.basename(filePath));
    let before: Awaited<ReturnType<typeof lstat>>;
    try { before = await lstat(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new CredentialStoreError('unsafe-store', 'The credential store is unavailable.');
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
      throw new CredentialStoreError('unsafe-store', 'The credential store must be a private regular file.');
    }
    if (before.size > maxBytes) {
      throw new CredentialStoreError('store-too-large', 'The credential store exceeds its size limit.');
    }
    handle = await open(
      target,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.size > maxBytes
      || (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && opened.uid !== process.getuid())) {
      throw new CredentialStoreError('unsafe-store', 'The credential store changed while it was opened.');
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [after, targetAfter, directoryAfter, directoryPathAfter] = await Promise.all([
      handle.stat(),
      lstat(target),
      directoryHandle.stat(),
      lstat(directory),
    ]);
    if (offset !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || after.nlink !== 1 || (process.platform !== 'win32' && (after.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && after.uid !== process.getuid())
      || !targetAfter.isFile() || targetAfter.isSymbolicLink() || targetAfter.nlink !== 1
      || targetAfter.dev !== after.dev || targetAfter.ino !== after.ino || targetAfter.size !== after.size
      || targetAfter.mtimeMs !== after.mtimeMs || targetAfter.ctimeMs !== after.ctimeMs
      || directoryAfter.dev !== directoryOpened.dev || directoryAfter.ino !== directoryOpened.ino
      || !directoryPathAfter.isDirectory() || directoryPathAfter.isSymbolicLink()
      || directoryPathAfter.dev !== directoryOpened.dev || directoryPathAfter.ino !== directoryOpened.ino) {
      throw new CredentialStoreError('unsafe-store', 'The credential store changed while it was read.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error;
    throw invalidStore();
  } finally {
    await handle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CredentialStoreError('unsafe-store', 'The credential store directory is unavailable.');
      }
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new CredentialStoreError('unsafe-store', 'The credential store directory is unavailable.');
        }
      }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CredentialStoreError('unsafe-store', 'The credential store directory is unsafe.');
    }
  }
  let handle;
  try {
    handle = await open(
      absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_DIRECTORY ?? 0),
    );
    const before = await handle.stat();
    if (!before.isDirectory()) throw new CredentialStoreError('unsafe-store', 'The credential store directory is unsafe.');
    await handle.chmod(0o700);
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino
      || (typeof process.getuid === 'function' && after.uid !== process.getuid())
      || (process.platform !== 'win32' && (after.mode & 0o077) !== 0)) {
      throw new CredentialStoreError('unsafe-store', 'The credential store directory changed unexpectedly.');
    }
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error;
    throw new CredentialStoreError('unsafe-store', 'The credential store directory is unavailable.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeStaleLock(lockPath: string, observed: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  const stalePath = `${lockPath}.${process.pid}.${randomBytes(8).toString('hex')}.stale`;
  try {
    await rename(lockPath, stalePath);
    const moved = await lstat(stalePath);
    if (moved.dev !== observed.dev || moved.ino !== observed.ino
      || moved.nlink !== 1 || moved.mtimeMs !== observed.mtimeMs
      || Date.now() - moved.mtimeMs <= STALE_LOCK_MS) {
      const replacement = await lstat(lockPath).catch(() => undefined);
      if (!replacement) await rename(stalePath, lockPath).catch(() => undefined);
      return;
    }
    await rm(stalePath, { force: true });
  } catch {
    const replacement = await lstat(lockPath).catch(() => undefined);
    if (!replacement) await rename(stalePath, lockPath).catch(() => undefined);
  }
}

async function acquireLock(filePath: string): Promise<() => Promise<void>> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const directoryBefore = await lstat(directory);
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directoryHandle = await open(
      directory,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_DIRECTORY ?? 0),
    );
    const directoryOpened = await directoryHandle.stat();
    if (!directoryOpened.isDirectory() || directoryOpened.dev !== directoryBefore.dev
      || directoryOpened.ino !== directoryBefore.ino) {
      throw new CredentialStoreError('unsafe-store', 'The credential store directory changed unexpectedly.');
    }
    const anchoredDirectory = process.platform === 'linux' ? `/proc/self/fd/${directoryHandle.fd}` : directory;
    const lockPath = path.join(anchoredDirectory, `${path.basename(filePath)}.lock`);
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        const handle = await open(
          lockPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        );
        const identity = await handle.stat();
        if (!identity.isFile() || identity.nlink !== 1
          || (process.platform !== 'win32' && (identity.mode & 0o077) !== 0)
          || (typeof process.getuid === 'function' && identity.uid !== process.getuid())) {
          await handle.close().catch(() => undefined);
          throw new CredentialStoreError('unsafe-store', 'The credential store lock is unsafe.');
        }
        const heartbeat = setInterval(() => {
          const now = new Date();
          void handle.utimes(now, now).catch(() => undefined);
        }, LOCK_HEARTBEAT_MS);
        heartbeat.unref?.();
        const retainedDirectoryHandle = directoryHandle;
        if (!retainedDirectoryHandle) {
          await handle.close().catch(() => undefined);
          throw new CredentialStoreError('unsafe-store', 'The credential store lock is unavailable.');
        }
        directoryHandle = undefined;
        return async () => {
          clearInterval(heartbeat);
          await handle.close().catch(() => undefined);
          try {
            await releaseStableLockPath(lockPath, identity);
          } finally {
            await retainedDirectoryHandle.close().catch(() => undefined);
          }
        };
      } catch (error) {
        if (error instanceof CredentialStoreError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new CredentialStoreError('unsafe-store', 'The credential store lock is unavailable.');
        }
        const current = await lstat(lockPath).catch(() => undefined);
        if (!current) continue;
        if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
          || (process.platform !== 'win32' && (current.mode & 0o077) !== 0)
          || (typeof process.getuid === 'function' && current.uid !== process.getuid())) {
          throw new CredentialStoreError('unsafe-store', 'The credential store lock is unsafe.');
        }
        if (Date.now() - current.mtimeMs > STALE_LOCK_MS) {
          await removeStaleLock(lockPath, current);
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    throw new CredentialStoreError('store-busy', 'The credential store is busy.');
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

async function atomicPrivateWrite(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const directoryBefore = await lstat(directory);
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporary = '';
  try {
    directoryHandle = await open(
      directory,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_DIRECTORY ?? 0),
    );
    const directoryOpened = await directoryHandle.stat();
    if (!directoryOpened.isDirectory() || directoryOpened.dev !== directoryBefore.dev
      || directoryOpened.ino !== directoryBefore.ino) {
      throw new CredentialStoreError('unsafe-store', 'The credential store directory changed unexpectedly.');
    }
    const anchoredDirectory = process.platform === 'linux' ? `/proc/self/fd/${directoryHandle.fd}` : directory;
    const target = path.join(anchoredDirectory, path.basename(filePath));
    const existing = await lstat(target).catch(() => undefined);
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1
      || (process.platform !== 'win32' && (existing.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && existing.uid !== process.getuid()))) {
      throw new CredentialStoreError('unsafe-store', 'The credential store must be a private regular file.');
    }
    temporary = path.join(
      anchoredDirectory,
      `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    const staged = await handle.stat();
    if (!staged.isFile() || staged.nlink !== 1 || staged.size !== Buffer.byteLength(content)
      || (process.platform !== 'win32' && (staged.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && staged.uid !== process.getuid())) {
      throw new CredentialStoreError('unsafe-store', 'The credential store staging file changed unexpectedly.');
    }
    const current = await lstat(target).catch(() => undefined);
    if ((existing && (!current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.dev !== existing.dev || current.ino !== existing.ino || current.size !== existing.size
      || current.mtimeMs !== existing.mtimeMs || current.ctimeMs !== existing.ctimeMs))
      || (!existing && current)) {
      throw new CredentialStoreError('unsafe-store', 'The credential store changed while it was being replaced.');
    }
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    temporary = '';
    const [committed, directoryAfter, directoryPathAfter] = await Promise.all([
      lstat(target),
      directoryHandle.stat(),
      lstat(directory),
    ]);
    if (!committed.isFile() || committed.isSymbolicLink() || committed.nlink !== 1
      || committed.dev !== staged.dev || committed.ino !== staged.ino || committed.size !== staged.size
      || directoryAfter.dev !== directoryOpened.dev || directoryAfter.ino !== directoryOpened.ino
      || !directoryPathAfter.isDirectory() || directoryPathAfter.isSymbolicLink()
      || directoryPathAfter.dev !== directoryOpened.dev || directoryPathAfter.ino !== directoryOpened.ino) {
      throw new CredentialStoreError('unsafe-store', 'The credential store changed while it was committed.');
    }
    await directoryHandle.sync().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}

/**
 * AES-256-GCM credential persistence shared by CLI and Server.
 *
 * The encrypted file is bounded, no-follow, owner-only and atomically replaced.
 * Mutations reload under an inter-process lock so independent frontends do not
 * overwrite one another. Errors are deliberately value-free.
 */
export class EncryptedCredentialStore {
  private credentials: Record<string, string> = Object.create(null) as Record<string, string>;
  private loaded = false;
  private mutation = Promise.resolve();
  private readonly filePath: string;
  private readonly maxBytes: number;

  constructor(filePath: string, private readonly masterKey: string, options: EncryptedCredentialStoreOptions = {}) {
    if (Buffer.byteLength(masterKey) < 16 || Buffer.byteLength(masterKey) > 16 * 1024 || masterKey.includes('\0')) {
      throw new CredentialStoreError('invalid-key', 'AI_HARNESS_MASTER_KEY must contain at least 16 bytes.');
    }
    this.filePath = path.resolve(filePath);
    this.maxBytes = options.maxBytes ?? MAX_STORE_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 256 || this.maxBytes > 16 * 1024 * 1024) {
      throw new CredentialStoreError('store-too-large', 'The credential store size limit is invalid.');
    }
  }

  async load(): Promise<void> {
    await this.queued(async () => {
      const loaded = await this.readCurrent();
      this.credentials = loaded;
      this.loaded = true;
    });
  }

  get(name: string): string | undefined {
    return this.credentials[validateName(name)];
  }

  list(): string[] {
    return Object.keys(this.credentials).sort();
  }

  async set(name: string, value: string): Promise<void> {
    const normalized = validateName(name);
    const validated = validateValue(value);
    await this.queued(async () => {
      const release = await acquireLock(this.filePath);
      try {
        const current = await this.readCurrent();
        current[normalized] = validated;
        if (Object.keys(current).length > MAX_CREDENTIALS) {
          throw new CredentialStoreError('invalid-value', 'The credential store has too many entries.');
        }
        await this.writeCurrent(current);
        this.credentials = current;
        this.loaded = true;
      } finally {
        await release();
      }
    });
  }

  async update(values: Readonly<Record<string, string | undefined>>): Promise<void> {
    const updates = Object.entries(values).map(([name, value]) => [
      validateName(name), value === undefined ? undefined : validateValue(value),
    ] as const);
    if (updates.length > MAX_CREDENTIALS) {
      throw new CredentialStoreError('invalid-value', 'The credential store update is too large.');
    }
    await this.queued(async () => {
      const release = await acquireLock(this.filePath);
      try {
        const current = await this.readCurrent();
        for (const [name, value] of updates) {
          if (value === undefined) delete current[name];
          else current[name] = value;
        }
        if (Object.keys(current).length > MAX_CREDENTIALS) {
          throw new CredentialStoreError('invalid-value', 'The credential store has too many entries.');
        }
        await this.writeCurrent(current);
        this.credentials = current;
        this.loaded = true;
      } finally {
        await release();
      }
    });
  }

  async delete(name: string): Promise<boolean> {
    const normalized = validateName(name);
    return this.queued(async () => {
      const release = await acquireLock(this.filePath);
      try {
        const current = await this.readCurrent();
        if (!Object.hasOwn(current, normalized)) {
          this.credentials = current;
          this.loaded = true;
          return false;
        }
        delete current[normalized];
        await this.writeCurrent(current);
        this.credentials = current;
        this.loaded = true;
        return true;
      } finally {
        await release();
      }
    });
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  private queued<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    const next = (async () => {
      await previous.catch(() => undefined);
      return operation();
    })();
    this.mutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async readCurrent(): Promise<Record<string, string>> {
    const source = await readBoundedRegularFile(this.filePath, this.maxBytes);
    if (source === undefined) return Object.create(null) as Record<string, string>;
    try {
      const document = parseDocument(source, this.maxBytes);
      const salt = decodeBase64(document.salt, 16);
      const iv = decodeBase64(document.iv, 12);
      const tag = decodeBase64(document.tag, 16);
      const encrypted = decodeBase64(document.data);
      const key = await deriveKey(this.masterKey, salt);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from('ai-harness:credentials:v1', 'utf8'));
      decipher.setAuthTag(tag);
      const clear = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      if (clear.length > this.maxBytes) throw invalidStore();
      return parseCredentials(new TextDecoder('utf-8', { fatal: true }).decode(clear));
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      throw invalidStore();
    }
  }

  private async writeCurrent(credentials: Record<string, string>): Promise<void> {
    const clear = JSON.stringify(credentials);
    if (Buffer.byteLength(clear) > this.maxBytes) {
      throw new CredentialStoreError('store-too-large', 'The credential store exceeds its size limit.');
    }
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveKey(this.masterKey, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('ai-harness:credentials:v1', 'utf8'));
    const encrypted = Buffer.concat([cipher.update(clear, 'utf8'), cipher.final()]);
    const document: EncryptedDocument = {
      version: STORE_VERSION,
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    };
    const serialized = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(serialized) > this.maxBytes) {
      throw new CredentialStoreError('store-too-large', 'The credential store exceeds its size limit.');
    }
    await atomicPrivateWrite(this.filePath, serialized);
  }
}

/** Constant-time comparison helper for explicitly requested credential checks. */
export function credentialValuesEqual(left: string, right: string): boolean {
  const leftHash = Buffer.from(left);
  const rightHash = Buffer.from(right);
  return leftHash.length === rightHash.length && timingSafeEqual(leftHash, rightHash);
}
