import { execFile } from 'node:child_process';
import { watch as watchFileSystem } from 'node:fs';
import { access, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { Router, type Request } from 'express';
import type { RuntimeServices } from '../runtime/services.js';
import { requireCapability } from '../security/request-security.js';

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 100_000;

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

function parseGitStatus(output: string): GitStatusEntry[] {
  const records = output.split('\0').filter(Boolean);
  const result: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index++) {
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
    });
    const files = parseGitStatus(stdout);
    const stats = new Map<string, { additions?: number; deletions?: number }>();
    try {
      const { stdout: diff } = await execFileAsync('git', ['-C', cwd, 'diff', '--numstat', 'HEAD'], { timeout: 10_000 });
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

function availableUploadPath(directory: string, name: string, occupied: Set<string>): string {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const candidate = path.join(directory, `${stem} (${suffix})${extension}`);
    if (!occupied.has(candidate)) return candidate;
  }
  throw Object.assign(new Error(`Impossible de choisir un nom libre pour ${name}.`), { status: 409 });
}

export function createFileRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { cwd, target, relativePath } = await workspaceRequest(services, request, 'directory');
      const entries = await readdir(target, { withFileTypes: true });
      const status = await gitStatus(cwd);
      const statusByPath = new Map(status.files.map(file => [file.path, file]));
      response.json({
        cwd,
        path: relativePath,
        entries: entries.map(entry => {
          const entryPath = path.relative(cwd, path.join(target, entry.name)).split(path.sep).join('/');
          const exact = statusByPath.get(entryPath);
          const descendants = entry.isDirectory()
            ? status.files.filter(file => file.path.startsWith(`${entryPath}/`))
            : [];
          return {
            name: entry.name,
            path: entryPath,
            isDirectory: entry.isDirectory(),
            isSymbolicLink: entry.isSymbolicLink(),
            hidden: entry.name.startsWith('.'),
            ...(exact ? { gitStatus: exact.status } : descendants.length ? { gitStatus: 'changed' } : {}),
          };
        }).sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name)),
      });
    } catch (error) { next(error); }
  });

  router.get('/content', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { target, relativePath } = await workspaceRequest(services, request, 'file');
      const info = await stat(target);
      if (info.size > MAX_SOURCE_BYTES) {
        response.status(413).json({
          error: 'Fichier trop volumineux pour l’aperçu.',
          path: relativePath,
          name: path.basename(target),
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          language: languageFor(target),
          binary: false,
          tooLarge: true,
          downloadable: true,
        });
        return;
      }
      const bytes = await readFile(target);
      const binary = bytes.subarray(0, 8_192).includes(0);
      response.json({
        path: relativePath,
        name: path.basename(target),
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        language: languageFor(target),
        binary,
        lineCount: binary ? undefined : bytes.toString('utf8').split('\n').length,
        content: binary ? undefined : bytes.toString('utf8'),
      });
    } catch (error) { next(error); }
  });

  router.get('/download', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { target } = await workspaceRequest(services, request, 'file');
      response.download(target, path.basename(target));
    } catch (error) { next(error); }
  });

  router.get('/index', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { cwd } = await workspaceRequest(services, request, 'directory');
      const query = typeof request.query.q === 'string' ? request.query.q.toLocaleLowerCase() : '';
      const limit = Math.max(1, Math.min(2_000, Number(request.query.limit) || 500));
      let files: string[];
      let sourceTruncated = false;
      try {
        const { stdout } = await execFileAsync('git', ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
          timeout: 10_000,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf8',
        });
        files = stdout.split('\0').filter(Boolean);
      } catch {
        let indexedEntries = 0;
        const walk = async (directory: string, prefix = ''): Promise<string[]> => {
          const found: string[] = [];
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (['.git', 'node_modules'].includes(entry.name)) continue;
            if (indexedEntries >= MAX_INDEX_ENTRIES) {
              sourceTruncated = true;
              break;
            }
            const relative = path.join(prefix, entry.name);
            indexedEntries++;
            if (entry.isDirectory()) found.push(...await walk(path.join(directory, entry.name), relative));
            else if (entry.isFile()) found.push(relative);
          }
          return found;
        };
        files = await walk(cwd);
      }
      files = files.map(file => file.split(path.sep).join('/'));
      const directories = [...new Set(files.flatMap(file => {
        const parts = file.split('/');
        return parts.slice(0, -1).map((_part, index) => `${parts.slice(0, index + 1).join('/')}/`);
      }))];
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
          timeout: 10_000, encoding: 'utf8',
        });
        shouldCompareToEmpty = stdout.startsWith('??');
      }
      if (!diff && shouldCompareToEmpty) {
        // Untracked files (and files in a repository without HEAD) are compared to the platform null device.
        try {
          const result = await execFileAsync('git', ['-C', cwd, 'diff', '--no-index', '--binary', '--', os.devNull, relativePath], {
            timeout: 10_000, maxBuffer: 5 * 1024 * 1024, encoding: 'utf8',
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
        if (typeof file.name !== 'string' || !file.name || file.name !== path.basename(file.name)
          || typeof file.content !== 'string') throw Object.assign(new Error('Upload invalide.'), { status: 400 });
        const bytes = Buffer.from(file.content, 'base64');
        totalBytes += bytes.length;
        if (bytes.length > MAX_UPLOAD_BYTES || totalBytes > 9 * 1024 * 1024) {
          throw Object.assign(new Error('Fichier ou lot uploadé trop volumineux.'), { status: 413 });
        }
        let destination = await services.workspaceManager.resolve(path.join(directory, file.name), { base: cwd, mustExist: false });
        if (!isWithin(cwd, destination)) throw Object.assign(new Error('Destination hors workspace.'), { status: 403 });
        let exists = occupied.has(destination);
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
        await writeFile(file.destination, file.bytes, { flag: collision === 'overwrite' ? 'w' : 'wx', mode: 0o600 });
        written.push(path.relative(cwd, file.destination).split(path.sep).join('/'));
      }
      response.status(201).json({ files: written, collision });
    } catch (error) { next(error); }
  });

  router.get('/watch', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { target, relativePath } = await workspaceRequest(services, request, 'file');
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders?.();
      let revision = 0;
      response.write(`event: connection.ready\ndata: ${JSON.stringify({ path: relativePath, revision })}\n\n`);
      let debounce: NodeJS.Timeout | undefined;
      const watcher = watchFileSystem(target, { persistent: false }, eventType => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          revision++;
          response.write(`id: ${revision}\nevent: file.changed\ndata: ${JSON.stringify({ path: relativePath, eventType, revision })}\n\n`);
        }, 100);
      });
      watcher.on('error', () => {
        response.write(`event: file.unavailable\ndata: ${JSON.stringify({ path: relativePath })}\n\n`);
        response.end();
      });
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
      request.on('close', () => {
        if (debounce) clearTimeout(debounce);
        clearInterval(heartbeat);
        watcher.close();
      });
    } catch (error) { next(error); }
  });

  return router;
}
