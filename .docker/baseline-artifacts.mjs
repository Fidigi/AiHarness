import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Only regular, bounded screenshot files; never traverse repository symlinks. */
async function baselines(root) {
  const entries = new Map();
  let visited = 0;
  let totalBytes = 0;
  async function walk(directory, inSnapshots = false, depth = 0) {
    if (depth > 24) throw new Error('Snapshot directory depth exceeded.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 10_000) throw new Error('Snapshot inventory exceeded.');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file, inSnapshots || entry.name.endsWith('-snapshots'), depth + 1);
      } else if (inSnapshots && entry.isFile() && /\.(?:png|jpe?g|webp)$/.test(entry.name)) {
        const metadata = await lstat(file);
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 16 * 1024 * 1024) {
          throw new Error('Invalid snapshot artifact.');
        }
        if (totalBytes + metadata.size > 256 * 1024 * 1024) throw new Error('Snapshot aggregate size exceeded.');
        const bytes = await readFile(file);
        totalBytes += bytes.length;
        if (bytes.length > 16 * 1024 * 1024 || totalBytes > 256 * 1024 * 1024) throw new Error('Snapshot size exceeded.');
        entries.set(path.relative(root, file), bytes);
      }
    }
  }
  await walk(path.join(root, 'e2e'));
  return entries;
}

export async function snapshotBaselineDigests(root) {
  return new Map([...await baselines(root)].map(([file, bytes]) =>
    [file, createHash('sha256').update(bytes).digest('hex')]));
}

/** Archive only baselines actually added/changed by this run. Copying every
 * source baseline lets a later concurrent run roll back an earlier run's images.
 */
export async function collectChangedBaselines(root, before, destination) {
  await mkdir(destination, { recursive: true });
  const changed = [];
  for (const [file, bytes] of await baselines(root)) {
    if (before.get(file) === createHash('sha256').update(bytes).digest('hex')) continue;
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    changed.push(file);
  }
  return changed;
}
