import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

const MAX_STABLE_DIRECTORY_ENTRIES = 100_000;

export interface StableDirectoryListing {
  entries: Dirent[];
  truncated: boolean;
  /** Identity of the held directory during enumeration. */
  stats: Stats;
}

export interface StableDirectorySnapshotEntry {
  entry: Dirent;
  stats: Stats;
}

export interface StableDirectorySnapshot {
  entries: StableDirectorySnapshotEntry[];
  truncated: boolean;
  /** Identity of the held directory during enumeration. */
  stats: Stats;
}

/** Open an absolute directory without traversing symbolic components on Linux. */
export async function openStableDirectoryHandle(directoryPath: string): Promise<FileHandle> {
  if (typeof directoryPath !== 'string' || !path.isAbsolute(directoryPath)
    || Buffer.byteLength(directoryPath) > 32 * 1024 || directoryPath.includes('\0')) {
    throw new Error('Stable directory request is invalid.');
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_DIRECTORY ?? 0);
  if (process.platform !== 'linux') return open(directoryPath, flags);
  const parsed = path.parse(directoryPath);
  let handle = await open(parsed.root, flags);
  try {
    const components = directoryPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (const component of components) {
      const previous = handle;
      const next = await open(`/proc/self/fd/${previous.fd}/${component}`, flags);
      handle = next;
      await previous.close().catch(() => undefined);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readStableDirectory(
  directoryPath: string,
  maxEntries: number,
  signal: AbortSignal | undefined,
  includeStats: false,
): Promise<StableDirectoryListing>;
async function readStableDirectory(
  directoryPath: string,
  maxEntries: number,
  signal: AbortSignal | undefined,
  includeStats: true,
): Promise<StableDirectorySnapshot>;
async function readStableDirectory(
  directoryPath: string,
  maxEntries: number,
  signal: AbortSignal | undefined,
  includeStats: boolean,
): Promise<StableDirectoryListing | StableDirectorySnapshot> {
  if (typeof directoryPath !== 'string' || !path.isAbsolute(directoryPath)
    || Buffer.byteLength(directoryPath) > 32 * 1024 || directoryPath.includes('\0')
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1
    || maxEntries > MAX_STABLE_DIRECTORY_ENTRIES) {
    throw new Error('Stable directory request is invalid.');
  }
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
  const handle = await openStableDirectoryHandle(directoryPath).catch(() => {
    throw new Error('Directory is not a stable regular directory.');
  });
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    const opened = await handle.stat();
    const pathBefore = await lstat(directoryPath);
    if (!opened.isDirectory() || !pathBefore.isDirectory() || pathBefore.isSymbolicLink()
      || opened.dev !== pathBefore.dev || opened.ino !== pathBefore.ino) {
      throw new Error('Directory changed while it was opened.');
    }
    const anchoredPath = process.platform === 'linux'
      ? `/proc/self/fd/${handle.fd}`
      : directoryPath;
    directory = await opendir(anchoredPath);
    const entries: Dirent[] = [];
    const snapshots: StableDirectorySnapshotEntry[] = [];
    let truncated = false;
    for await (const entry of directory) {
      if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
      if (includeStats) snapshots.push({ entry, stats: await lstat(path.join(anchoredPath, entry.name)) });
    }
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(directoryPath)]);
    if (!after.isDirectory() || after.dev !== opened.dev || after.ino !== opened.ino
      || !pathAfter.isDirectory() || pathAfter.isSymbolicLink()
      || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new Error('Directory changed while it was read.');
    }
    return includeStats
      ? { entries: snapshots, truncated, stats: opened }
      : { entries, truncated, stats: opened };
  } finally {
    await directory?.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
}

/**
 * Enumerate a previously confined directory while holding and revalidating its
 * identity. Callers remain responsible for confining `directoryPath` through
 * WorkspaceManager before calling this helper.
 */
export function readStableDirectoryEntries(
  directoryPath: string,
  maxEntries = MAX_STABLE_DIRECTORY_ENTRIES,
  signal?: AbortSignal,
): Promise<StableDirectoryListing> {
  return readStableDirectory(directoryPath, maxEntries, signal, false);
}

/** Enumerate entries and capture each identity through the held directory. */
export function readStableDirectorySnapshot(
  directoryPath: string,
  maxEntries = MAX_STABLE_DIRECTORY_ENTRIES,
  signal?: AbortSignal,
): Promise<StableDirectorySnapshot> {
  return readStableDirectory(directoryPath, maxEntries, signal, true);
}
