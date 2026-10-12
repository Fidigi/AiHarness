import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { filesUnder, readArtifact } from './artifact.mjs';

const allowed = /^demo\.spec\.ts\/demo-(chat|files|git|terminal|models|tools|reset)-(desktop|mobile)-(light|dark)\.png$/;
export async function baselineDigests(root) {
  const entries = new Map();
  for (const file of await filesUnder(root)) {
    if (!allowed.test(file)) throw new Error('Unexpected demo baseline path');
    entries.set(file, createHash('sha256').update(await readArtifact(path.join(root, file))).digest('hex'));
  }
  return entries;
}
export async function collectBaselineDelta(root, before, destination) {
  await mkdir(destination); // exclusive fresh generated destination
  const changed = [];
  for (const [file, digest] of await baselineDigests(root)) {
    if (before.get(file) === digest) continue;
    const bytes = await readArtifact(path.join(root, file));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Baseline changed during collection');
    await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await writeFile(path.join(destination, file), bytes, { flag: 'wx' });
    changed.push(file);
  }
  return changed;
}
