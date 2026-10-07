import { execFile } from 'node:child_process';
import { constants as fsConstants, watch as watchFileSystem } from 'node:fs';
import { access, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { Router, type Request } from 'express';
import {
  atomicWriteStableFile,
  filteredProcessEnvironment,
  openStableDirectoryHandle,
  readStableDirectoryEntries,
  readStableDirectorySnapshot,
  StableFileError,
} from '@ai-harness/core';
import type { RuntimeServices } from '../runtime/services.js';
import { requireCapability } from '../security/request-security.js';
import { SseChannel } from './sse-channel.js';

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 100_000;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_FILE_WATCHERS = 128;
const MAX_CONCURRENT_DOWNLOADS = 4;
const gitEnvironment = (): NodeJS.ProcessEnv => ({ ...filteredProcessEnvironment(), LC_ALL: 'C' });

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function workspaceRequest(
  services: RuntimeServices,
  request: Request,
  kind: 'file' | 'directory' | 'any' = 'any',
  mustExist = true,
): Promise<{ cwd: string; target: string; relativePath: string }> {
  const cwdInput = typeof request.query.cwd === 'string' ? request.query.cwd : request.body?.cwd;
  if (typeof cwdInput !== 'string') throw Object.assign(new Error('cwd requis.'), { status: 400 });
  const cwd = await services.workspaceManager.resolve(cwdInput, { kind: 'directory' });
  if (!await services.trustManager.isTrusted(cwd)) {
    throw Object.assign(new Error('Workspace non approuvé.'), { status: 409, code: 'PROJECT_TRUST_REQUIRED' });
  }
  const input = typeof request.query.path === 'string'
    ? request.query.path
    : typeof request.body?.path === 'string' ? request.body.path : '.';
  const target = await services.workspaceManager.resolve(input, { base: cwd, kind, mustExist });
  if (!isWithin(cwd, target)) throw Object.assign(new Error('Chemin hors du workspace actif.'), { status: 403 });
  return { cwd, target, relativePath: path.relative(cwd, target) || '.' };
}

function fuzzyScore(candidate: string, query: string): number | undefined {
  if (!query) return 0;
  const value = candidate.toLocaleLowerCase();
  const exact = value.indexOf(query);
  if (exact >= 0) return exact * 2 + candidate.length / 10_000;
  let cursor = 0;
  let gap = 0;
  for (const character of query) {
    const found = value.indexOf(character, cursor);
    if (found < 0) return undefined;
    gap += found - cursor;
    cursor = found + 1;
  }
  return 1_000 + gap + candidate.length / 10_000;
}

function rankPaths(values: string[], query: string): string[] {
  return values
    .map(value => ({ value, score: fuzzyScore(value, query) }))
    .filter((entry): entry is { value: string; score: number } => entry.score !== undefined)
    .sort((left, right) => left.score - right.score || left.value.localeCompare(right.value))
    .map(entry => entry.value);
}

function languageFor(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return ({
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    json: 'json', md: 'markdown', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml',
    sh: 'shell', bash: 'shell', zsh: 'shell', toml: 'toml', xml: 'xml', svg: 'svg',
  } as Record<string, string>)[extension] ?? 'text';
}

type GitStatusEntry = {
  path: string;
  originalPath?: string;
  status: string;
  staged: boolean;
  additions?: number;
  deletions?: number;
};

function boundedNulRecords(output: string, limit: number): { records: string[]; truncated: boolean } {
  const records: string[] = [];
  let cursor = 0;
  while (cursor < output.length && records.length <= limit) {
    const separator = output.indexOf('\0', cursor);
    const end = separator < 0 ? output.length : separator;
    const value = output.slice(cursor, end);
    cursor = end + 1;
    if (value) records.push(value);
  }
  return { records: records.slice(0, limit), truncated: records.length > limit || cursor < output.length };
}

function parseGitStatus(output: string): GitStatusEntry[] {
  const { records } = boundedNulRecords(output, MAX_INDEX_ENTRIES * 2);
  const result: GitStatusEntry[] = [];
  for (let index = 0; index < records.length && result.length < MAX_INDEX_ENTRIES; index++) {
    const record = records[index];
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    const renamed = code.includes('R') || code.includes('C');
    const originalPath = renamed ? records[++index] : undefined;
    result.push({
      path: filePath,
      ...(originalPath ? { originalPath } : {}),
      status: code === '??' ? 'untracked' : code.includes('D') ? 'deleted'
        : code.includes('A') ? 'added' : code.includes('U') ? 'conflict' : renamed ? 'renamed' : 'modified',
      staged: code[0] !== ' ' && code[0] !== '?',
    });
  }
  return result;
}

async function gitStatus(cwd: string): Promise<{
  repository: boolean;
  files: GitStatusEntry[];
  total: number;
  additions: number;
  deletions: number;
}> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain=v1', '-z'], {
      timeout: 10_000,
      maxBuffer: 5 * 1024 * 1024,
      encoding: 'utf8',
      env: gitEnvironment(),
    });
    const files = parseGitStatus(stdout);
    const stats = new Map<string, { additions?: number; deletions?: number }>();
    try {
      const { stdout: diff } = await execFileAsync('git', ['-C', cwd, 'diff', '--numstat', 'HEAD'], {
        timeout: 10_000, env: gitEnvironment(),
      });
      for (const line of diff.trim().split('\n').filter(Boolean)) {
        const [added, deleted, ...nameParts] = line.split('\t');
        const filePath = nameParts.join('\t');
        const additions = added === '-' ? undefined : Number(added) || 0;
        const deletions = deleted === '-' ? undefined : Number(deleted) || 0;
        stats.set(filePath, { additions, deletions });
      }
    } catch { /* Initial repositories may not have HEAD yet. */ }
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      Object.assign(file, stats.get(file.path));
      additions += file.additions ?? 0;
      deletions += file.deletions ?? 0;
    }
    return { repository: true, files, total: files.length, additions, deletions };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 128 || error.code === 'ENOENT')) {
      return { repository: false, files: [], total: 0, additions: 0, deletions: 0 };
    }
    throw error;
  }
}

async function readStableDownload(target: string, maxBytes = MAX_DOWNLOAD_BYTES): Promise<{
  bytes: Buffer;
  size: number;
  modifiedAt: string;
}> {
  const parentPath = path.dirname(target);
  const parentHandle = await openStableDirectoryHandle(parentPath).catch(() => {
    throw Object.assign(new Error('Répertoire de fichier instable.'), { status: 409 });
  });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const parentOpened = await parentHandle.stat();
    const parentBefore = await lstat(parentPath);
    if (!parentOpened.isDirectory() || !parentBefore.isDirectory() || parentBefore.isSymbolicLink()
      || parentOpened.dev !== parentBefore.dev || parentOpened.ino !== parentBefore.ino) {
      throw Object.assign(new Error('Répertoire de fichier instable.'), { status: 409 });
    }
    const anchoredTarget = process.platform === 'linux'
      ? `/proc/self/fd/${parentHandle.fd}/${path.basename(target)}`
      : target;
    const before = await lstat(anchoredTarget);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw Object.assign(new Error('Fichier indisponible pour le téléchargement.'), { status: 409 });
    }
    if (before.size > maxBytes) {
      throw Object.assign(new Error('Fichier trop volumineux pour le téléchargement.'), {
        status: 413,
        stableSize: before.size,
        stableModifiedAt: before.mtime.toISOString(),
      });
    }
    handle = await open(
      anchoredTarget,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.size > maxBytes) {
      throw Object.assign(new Error('Le fichier a changé pendant son ouverture.'), { status: 409 });
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [after, targetAfter, parentAfter, parentPathAfter] = await Promise.all([
      handle.stat(), lstat(anchoredTarget), parentHandle.stat(), lstat(parentPath),
    ]);
    if (offset !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
      || after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || !targetAfter.isFile() || targetAfter.isSymbolicLink()
      || targetAfter.nlink !== 1 || targetAfter.dev !== after.dev || targetAfter.ino !== after.ino
      || targetAfter.size !== after.size || targetAfter.mtimeMs !== after.mtimeMs
      || targetAfter.ctimeMs !== after.ctimeMs || parentAfter.dev !== parentOpened.dev
      || parentAfter.ino !== parentOpened.ino || !parentPathAfter.isDirectory()
      || parentPathAfter.isSymbolicLink() || parentPathAfter.dev !== parentOpened.dev
      || parentPathAfter.ino !== parentOpened.ino) {
      throw Object.assign(new Error('Le fichier a changé pendant sa lecture.'), { status: 409 });
    }
    return { bytes, size: after.size, modifiedAt: after.mtime.toISOString() };
  } finally {
    await handle?.close().catch(() => undefined);
    await parentHandle.close().catch(() => undefined);
  }
}

function containsKnownCredential(services: RuntimeServices, bytes: Buffer): boolean {
  const redactor = services.createTextRedactor();
  const decoder = new TextDecoder('utf-8');
  const chunkBytes = 64 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    redactor.push(decoder.decode(bytes.subarray(offset, offset + chunkBytes), { stream: true }));
  }
  redactor.push(decoder.decode());
  redactor.flush();
  return redactor.redacted;
}

function availableUploadPath(directory: string, name: string, occupied: Set<string>): string {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const candidate = path.join(directory, `${stem} (${suffix})${extension}`);
    if (!occupied.has(candidate)) return candidate;
  }
  throw Object.assign(new Error('Impossible de choisir un nom de fichier libre.'), { status: 409 });
}

async function writeStableUpload(destination: string, bytes: Buffer, overwrite: boolean): Promise<void> {
  try {
    await atomicWriteStableFile(destination, bytes, {
      overwrite,
      maxBytes: MAX_UPLOAD_BYTES,
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof StableFileError)) throw error;
    throw Object.assign(new Error(error.code === 'target-exists'
      ? 'Le fichier existe déjà.' : 'La destination d’upload est instable.'), {
      status: error.code === 'invalid-content' ? 413 : 409,
      ...(error.code === 'target-exists' ? { code: 'FILE_EXISTS' } : {}),
    });
  }
}

export function createFileRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();
  let activeWatchers = 0;
  let activeDownloads = 0;

  router.get('/', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { cwd, target, relativePath } = await workspaceRequest(services, request, 'directory');
      const listing = await readStableDirectorySnapshot(target, MAX_DIRECTORY_ENTRIES);
      const entries = listing.entries.filter(({ entry }) => entry.name !== '.git' && entry.name !== '.DS_Store');
      const status = await gitStatus(cwd);
      const statusByPath = new Map(status.files.map(file => [file.path, file]));
      const changedDirectories = new Set<string>();
      for (const file of status.files) {
        const parts = file.path.split('/');
        for (let index = 1; index < parts.length; index++) {
          changedDirectories.add(parts.slice(0, index).join('/'));
        }
      }
      response.json({
        cwd,
        path: relativePath,
        truncated: listing.truncated,
        entries: entries.map(({ entry, stats }) => {
          const entryPath = path.relative(cwd, path.join(target, entry.name)).split(path.sep).join('/');
          const exact = statusByPath.get(entryPath);
          return {
            name: entry.name,
            path: entryPath,
            isDirectory: stats.isDirectory(),
            isSymbolicLink: stats.isSymbolicLink(),
            hidden: entry.name.startsWith('.'),
            ...(exact ? { gitStatus: exact.status }
              : stats.isDirectory() && changedDirectories.has(entryPath) ? { gitStatus: 'changed' } : {}),
          };
        }).sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name)),
      });
    } catch (error) { next(error); }
  });

  router.get('/content', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { target, relativePath } = await workspaceRequest(services, request, 'file');
      let stable;
      try {
        stable = await readStableDownload(target, MAX_SOURCE_BYTES);
      } catch (error) {
        const boundedError = error as {
          status?: unknown;
          stableSize?: unknown;
          stableModifiedAt?: unknown;
        };
        if (boundedError.status !== 413 || typeof boundedError.stableSize !== 'number'
          || typeof boundedError.stableModifiedAt !== 'string') throw error;
        response.status(413).json({
          error: 'Fichier trop volumineux pour l’aperçu.',
          path: relativePath,
          name: path.basename(target),
          size: boundedError.stableSize,
          modifiedAt: boundedError.stableModifiedAt,
          language: languageFor(target),
          binary: false,
          tooLarge: true,
          downloadable: boundedError.stableSize <= MAX_DOWNLOAD_BYTES,
        });
        return;
      }
      const { bytes } = stable;
      let content: string | undefined;
      if (!bytes.subarray(0, 8_192).includes(0)) {
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { content = undefined; }
      }
      const binary = content === undefined;
      response.json({
        path: relativePath,
        name: path.basename(target),
        size: stable.size,
        modifiedAt: stable.modifiedAt,
        language: languageFor(target),
        binary,
        lineCount: content === undefined ? undefined : content.split('\n').length,
        content,
      });
    } catch (error) { next(error); }
  });

  router.get('/download', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { target } = await workspaceRequest(services, request, 'file');
      if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
        throw Object.assign(new Error('Trop de téléchargements sont actifs.'), { status: 429 });
      }
      activeDownloads++;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        activeDownloads--;
      };
      response.once('finish', release);
      response.once('close', release);
      const { bytes } = await readStableDownload(target);
      if (containsKnownCredential(services, bytes)) {
        response.status(409).json({
          error: 'Le téléchargement a été bloqué car le fichier contient une valeur sensible active.',
          code: 'CREDENTIAL_REDACTION_REQUIRED',
        });
        return;
      }
      const downloadName = services.redactText(path.basename(target))
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, '_');
      response.attachment(downloadName || 'download.bin');
      response.type('application/octet-stream').send(bytes);
    } catch (error) { next(error); }
  });

  router.get('/index', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { cwd } = await workspaceRequest(services, request, 'directory');
      const rawQuery = typeof request.query.q === 'string' ? request.query.q : '';
      if (Buffer.byteLength(rawQuery) > 4_096 || /[\u0000-\u001f\u007f]/u.test(rawQuery)) {
        throw Object.assign(new Error('Recherche de fichiers invalide.'), { status: 400 });
      }
      const query = rawQuery.toLocaleLowerCase();
      const rawLimit = request.query.limit;
      if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d{0,3}$/u.test(rawLimit)
        || Number(rawLimit) > 2_000)) {
        throw Object.assign(new Error('Limite de recherche invalide.'), { status: 400 });
      }
      const limit = rawLimit === undefined ? 500 : Number(rawLimit);
      let files: string[];
      let sourceTruncated = false;
      try {
        const { stdout } = await execFileAsync('git', ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
          timeout: 10_000,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf8',
          env: gitEnvironment(),
        });
        const discovered = boundedNulRecords(stdout, MAX_INDEX_ENTRIES);
        sourceTruncated = discovered.truncated;
        files = discovered.records.filter(file => (
          !file.split('/').some(component => component === '.git' || component === '.DS_Store')
        ));
      } catch {
        let indexedEntries = 0;
        files = [];
        const directoriesToVisit: Array<{ directory: string; prefix: string }> = [{ directory: cwd, prefix: '' }];
        while (directoriesToVisit.length && indexedEntries < MAX_INDEX_ENTRIES) {
          const current = directoriesToVisit.pop()!;
          const listing = await readStableDirectoryEntries(
            current.directory,
            MAX_INDEX_ENTRIES - indexedEntries,
          );
          for (const entry of listing.entries) {
            if (['.git', '.DS_Store', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
            const relative = path.join(current.prefix, entry.name);
            indexedEntries++;
            if (entry.isDirectory()) {
              directoriesToVisit.push({ directory: path.join(current.directory, entry.name), prefix: relative });
            } else if (entry.isFile()) files.push(relative);
          }
          if (listing.truncated) {
            sourceTruncated = true;
            break;
          }
        }
        if (directoriesToVisit.length) sourceTruncated = true;
      }
      files = files.slice(0, MAX_INDEX_ENTRIES).map(file => file.split(path.sep).join('/'));
      const directorySet = new Set<string>();
      for (const file of files) {
        const parts = file.split('/');
        for (let index = 0; index < parts.length - 1 && directorySet.size < MAX_INDEX_ENTRIES; index++) {
          directorySet.add(`${parts.slice(0, index + 1).join('/')}/`);
        }
        if (directorySet.size >= MAX_INDEX_ENTRIES) {
          sourceTruncated = true;
          break;
        }
      }
      const directories = [...directorySet];
      const matches = rankPaths(files, query);
      const directoryMatches = rankPaths(directories, query);
      response.json({
        files: matches.slice(0, limit),
        directories: directoryMatches.slice(0, limit),
        truncated: sourceTruncated || matches.length > limit || directoryMatches.length > limit,
        total: matches.length,
        directoryTotal: directoryMatches.length,
      });
    } catch (error) { next(error); }
  });

  router.get('/git/status', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { cwd } = await workspaceRequest(services, request, 'directory');
      response.json(await gitStatus(cwd));
    } catch (error) { next(error); }
  });

  router.get('/git/diff', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { cwd, relativePath } = await workspaceRequest(services, request, 'file', false);
      let diff = '';
      let headFailed: unknown;
      try {
        const result = await execFileAsync('git', ['-C', cwd, 'diff', '--no-ext-diff', '--binary', 'HEAD', '--', relativePath], {
          timeout: 10_000,
          maxBuffer: 5 * 1024 * 1024,
          encoding: 'utf8',
          env: gitEnvironment(),
        });
        diff = result.stdout;
      } catch (error) {
        headFailed = error;
        const failure = error as { stdout?: string };
        if (typeof failure.stdout === 'string' && failure.stdout) diff = failure.stdout;
      }
      let shouldCompareToEmpty = Boolean(headFailed);
      if (!diff && !shouldCompareToEmpty) {
        const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain=v1', '--', relativePath], {
          timeout: 10_000, encoding: 'utf8', env: gitEnvironment(),
        });
        shouldCompareToEmpty = stdout.startsWith('??');
      }
      if (!diff && shouldCompareToEmpty) {
        // Untracked files (and files in a repository without HEAD) are compared to the platform null device.
        try {
          const result = await execFileAsync('git', ['-C', cwd, 'diff', '--no-index', '--binary', '--', os.devNull, relativePath], {
            timeout: 10_000, maxBuffer: 5 * 1024 * 1024, encoding: 'utf8', env: gitEnvironment(),
          });
          diff = result.stdout;
        } catch (untrackedError) {
          const untracked = untrackedError as { stdout?: string };
          if (typeof untracked.stdout === 'string') diff = untracked.stdout;
          else throw headFailed ?? untrackedError;
        }
      }
      response.json({ path: relativePath, diff, binary: /(?:Binary files|GIT binary patch)/.test(diff) });
    } catch (error) { next(error); }
  });

  router.post('/upload', requireCapability('files:write'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { cwd, target: directory } = await workspaceRequest(services, request, 'directory');
      const files = Array.isArray(request.body?.files) ? request.body.files : [];
      if (files.length < 1 || files.length > 20) {
        response.status(400).json({ error: 'Entre 1 et 20 fichiers sont requis.' });
        return;
      }
      const collision = request.body?.collision === 'overwrite' || request.body?.collision === 'rename'
        ? request.body.collision : 'reject';
      const prepared: Array<{ destination: string; bytes: Buffer }> = [];
      const occupied = new Set<string>();
      let totalBytes = 0;
      for (const file of files as Array<{ name?: unknown; content?: unknown }>) {
        if (!file || typeof file !== 'object' || typeof file.name !== 'string'
          || !file.name || file.name !== path.basename(file.name) || file.name === '.' || file.name === '..'
          || /[. ]$/u.test(file.name)
          || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(file.name)
          || Buffer.byteLength(file.name) > 255
          || /[\\/<>:"|?*\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(file.name)
          || typeof file.content !== 'string' || file.content.length > 12 * 1024 * 1024
          || file.content.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.content)) {
          throw Object.assign(new Error('Upload invalide.'), { status: 400 });
        }
        const bytes = Buffer.from(file.content, 'base64');
        if (bytes.toString('base64') !== file.content) {
          throw Object.assign(new Error('Upload invalide.'), { status: 400 });
        }
        totalBytes += bytes.length;
        if (bytes.length > MAX_UPLOAD_BYTES || totalBytes > 9 * 1024 * 1024) {
          throw Object.assign(new Error('Fichier ou lot uploadé trop volumineux.'), { status: 413 });
        }
        if (containsKnownCredential(services, bytes)) {
          throw Object.assign(new Error('L’upload contient une valeur sensible active.'), {
            status: 409,
            code: 'CREDENTIAL_REDACTION_REQUIRED',
          });
        }
        let destination = await services.workspaceManager.resolveDestination(
          path.join(directory, file.name),
          { base: cwd, kind: 'file' },
        );
        if (!isWithin(cwd, destination)) throw Object.assign(new Error('Destination hors workspace.'), { status: 403 });
        const duplicatedInBatch = occupied.has(destination);
        if (duplicatedInBatch && collision === 'overwrite') {
          throw Object.assign(new Error('Le lot contient des destinations dupliquées.'), { status: 409 });
        }
        let exists = duplicatedInBatch;
        if (!exists) {
          try { await access(destination); exists = true; } catch { /* Available. */ }
        }
        if (exists && collision === 'rename') {
          destination = availableUploadPath(directory, file.name, occupied);
          while (true) {
            try {
              await access(destination);
              occupied.add(destination);
              destination = availableUploadPath(directory, file.name, occupied);
            } catch { break; }
          }
        } else if (exists && collision === 'reject') {
          throw Object.assign(new Error(`Le fichier existe déjà : ${file.name}`), { status: 409, code: 'FILE_EXISTS' });
        }
        occupied.add(destination);
        prepared.push({ destination, bytes });
      }
      const written: string[] = [];
      for (const file of prepared) {
        await writeStableUpload(file.destination, file.bytes, collision === 'overwrite');
        written.push(path.relative(cwd, file.destination).split(path.sep).join('/'));
      }
      response.status(201).json({ files: written, collision });
    } catch (error) { next(error); }
  });

  router.get('/watch', async (request, response, next) => {
    let releaseSlot: (() => void) | undefined;
    let watchedParentHandle: Awaited<ReturnType<typeof open>> | undefined;
    let watchedHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const services = await servicesPromise;
      const { target, relativePath } = await workspaceRequest(services, request, 'file');
      if (activeWatchers >= MAX_FILE_WATCHERS) {
        throw Object.assign(new Error('Trop de fichiers sont actuellement surveillés.'), { status: 429 });
      }
      activeWatchers++;
      let released = false;
      releaseSlot = () => {
        if (released) return;
        released = true;
        activeWatchers--;
      };
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      const channel = new SseChannel(response, services.createTextRedactor());
      let revision = 0;
      const watchedParentPath = path.dirname(target);
      watchedParentHandle = await openStableDirectoryHandle(watchedParentPath).catch(() => {
        throw Object.assign(new Error('Répertoire de surveillance instable.'), { status: 409 });
      });
      const stableParentHandle = watchedParentHandle;
      const watchedParentOpened = await stableParentHandle.stat();
      const watchedParentBefore = await lstat(watchedParentPath);
      if (!watchedParentOpened.isDirectory() || !watchedParentBefore.isDirectory()
        || watchedParentBefore.isSymbolicLink() || watchedParentOpened.dev !== watchedParentBefore.dev
        || watchedParentOpened.ino !== watchedParentBefore.ino) {
        throw Object.assign(new Error('Répertoire de surveillance instable.'), { status: 409 });
      }
      const anchoredTarget = process.platform === 'linux'
        ? `/proc/self/fd/${stableParentHandle.fd}/${path.basename(target)}`
        : target;
      const watchedBefore = await lstat(anchoredTarget);
      if (!watchedBefore.isFile() || watchedBefore.isSymbolicLink() || watchedBefore.nlink !== 1) {
        throw Object.assign(new Error('Fichier indisponible pour la surveillance.'), { status: 409 });
      }
      watchedHandle = await open(
        anchoredTarget,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      );
      const watchedOpened = await watchedHandle.stat();
      if (!watchedOpened.isFile() || watchedOpened.nlink !== 1 || watchedOpened.dev !== watchedBefore.dev
        || watchedOpened.ino !== watchedBefore.ino) {
        throw Object.assign(new Error('Fichier instable pour la surveillance.'), { status: 409 });
      }
      const watchPath = process.platform === 'linux' ? `/proc/self/fd/${watchedHandle.fd}` : target;
      let debounce: NodeJS.Timeout | undefined;
      const watcher = watchFileSystem(watchPath, { persistent: false }, eventType => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          void (async () => {
            if (response.writableEnded || response.destroyed) return;
            const [current, anchoredCurrent, parentCurrent, parentPathCurrent] = await Promise.all([
              lstat(target).catch(() => undefined),
              lstat(anchoredTarget).catch(() => undefined),
              stableParentHandle.stat().catch(() => undefined),
              lstat(watchedParentPath).catch(() => undefined),
            ]);
            if (!current?.isFile() || current.isSymbolicLink() || current.nlink !== 1
              || current.dev !== watchedOpened.dev || current.ino !== watchedOpened.ino
              || !anchoredCurrent?.isFile() || anchoredCurrent.isSymbolicLink() || anchoredCurrent.nlink !== 1
              || anchoredCurrent.dev !== watchedOpened.dev || anchoredCurrent.ino !== watchedOpened.ino
              || !parentCurrent?.isDirectory() || parentCurrent.dev !== watchedParentOpened.dev
              || parentCurrent.ino !== watchedParentOpened.ino || !parentPathCurrent?.isDirectory()
              || parentPathCurrent.isSymbolicLink() || parentPathCurrent.dev !== watchedParentOpened.dev
              || parentPathCurrent.ino !== watchedParentOpened.ino) {
              channel.send('file.unavailable', services.redactJson({ path: relativePath }));
              channel.close();
              cleanup();
              return;
            }
            revision++;
            channel.send('file.changed', services.redactJson({ path: relativePath, eventType, revision }), revision);
          })().catch(() => {
            channel.close();
            cleanup();
          });
        }, 100);
      });
      let heartbeat: NodeJS.Timeout | undefined;
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        if (debounce) clearTimeout(debounce);
        if (heartbeat) clearInterval(heartbeat);
        watcher.close();
        void watchedHandle?.close().catch(() => undefined);
        watchedHandle = undefined;
        void watchedParentHandle?.close().catch(() => undefined);
        watchedParentHandle = undefined;
        releaseSlot?.();
      };
      watcher.on('error', () => {
        if (!response.writableEnded && !response.destroyed) {
          channel.send('file.unavailable', services.redactJson({ path: relativePath }));
          channel.close();
        }
        cleanup();
      });
      const [watchedAfter, watchedAnchoredAfter, watchedParentAfter, watchedParentPathAfter] = await Promise.all([
        lstat(target), lstat(anchoredTarget), stableParentHandle.stat(), lstat(watchedParentPath),
      ]);
      if (!watchedAfter.isFile() || watchedAfter.isSymbolicLink() || watchedAfter.nlink !== 1
        || watchedAfter.dev !== watchedOpened.dev || watchedAfter.ino !== watchedOpened.ino
        || !watchedAnchoredAfter.isFile() || watchedAnchoredAfter.isSymbolicLink()
        || watchedAnchoredAfter.nlink !== 1 || watchedAnchoredAfter.dev !== watchedOpened.dev
        || watchedAnchoredAfter.ino !== watchedOpened.ino || !watchedParentAfter.isDirectory()
        || watchedParentAfter.dev !== watchedParentOpened.dev || watchedParentAfter.ino !== watchedParentOpened.ino
        || !watchedParentPathAfter.isDirectory() || watchedParentPathAfter.isSymbolicLink()
        || watchedParentPathAfter.dev !== watchedParentOpened.dev
        || watchedParentPathAfter.ino !== watchedParentOpened.ino) {
        cleanup();
        throw Object.assign(new Error('Fichier instable pour la surveillance.'), { status: 409 });
      }
      response.flushHeaders?.();
      channel.send('connection.ready', services.redactJson({ path: relativePath, revision }));
      heartbeat = setInterval(() => {
        if (!response.writableEnded && !response.destroyed) channel.heartbeat();
      }, 15_000);
      request.once('close', cleanup);
      response.once('finish', cleanup);
      response.once('close', cleanup);
    } catch (error) {
      await watchedHandle?.close().catch(() => undefined);
      await watchedParentHandle?.close().catch(() => undefined);
      releaseSlot?.();
      next(error);
    }
  });

  return router;
}
