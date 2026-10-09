import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectChangedBaselines, snapshotBaselineDigests } from './baseline-artifacts.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-baseline-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'e2e', 'first.spec.ts-snapshots'), { recursive: true });
  await mkdir(path.join(root, 'e2e', 'second.spec.ts-snapshots'), { recursive: true });
  return root;
}

test('collects only new or byte-changed images and leaves unchanged baselines out', async t => {
  const root = await fixture(t);
  const old = path.join(root, 'e2e', 'first.spec.ts-snapshots', 'old.png');
  const untouched = path.join(root, 'e2e', 'second.spec.ts-snapshots', 'same.png');
  await writeFile(old, 'old');
  await writeFile(untouched, 'same');
  const before = await snapshotBaselineDigests(root);
  await writeFile(old, 'new');
  await writeFile(path.join(root, 'e2e', 'first.spec.ts-snapshots', 'added.png'), 'added');
  const destination = path.join(root, 'artifacts');
  assert.deepEqual((await collectChangedBaselines(root, before, destination)).sort(), [
    'e2e/first.spec.ts-snapshots/added.png', 'e2e/first.spec.ts-snapshots/old.png',
  ]);
  assert.equal(await readFile(path.join(destination, 'e2e', 'first.spec.ts-snapshots', 'old.png'), 'utf8'), 'new');
  assert.deepEqual(await readdir(path.join(destination, 'e2e')), ['first.spec.ts-snapshots']);
});

test('an unchanged concurrent run cannot archive a stale baseline over another run', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'e2e', 'first.spec.ts-snapshots', 'theme.png');
  await writeFile(file, 'old snapshot copied into this run');
  const before = await snapshotBaselineDigests(root);
  const destination = path.join(root, 'artifacts');
  assert.deepEqual(await collectChangedBaselines(root, before, destination), []);
  assert.deepEqual(await readdir(destination), []);
});

test('does not follow linked files or snapshot directories', async t => {
  const root = await fixture(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.png'), 'must not copy');
  await symlink(outside, path.join(root, 'e2e', 'linked.spec.ts-snapshots'));
  await symlink(path.join(outside, 'private.png'), path.join(root, 'e2e', 'first.spec.ts-snapshots', 'linked.png'));
  assert.equal((await snapshotBaselineDigests(root)).size, 0);
});
