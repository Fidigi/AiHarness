import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink, link, truncate, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { filesUnder, readArtifact } from '../scripts/artifact.mjs';
import { baselineDigests, collectBaselineDelta } from '../scripts/baselines.mjs';

async function disposable(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'aih-demo-export-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('bounded artifact inventory rejects root/ancestor/child symlinks, hardlinks, large files and deep trees', async () => disposable(async root => {
  const tree = path.join(root, 'tree'); await mkdir(tree);
  await writeFile(path.join(tree, 'ok'), 'fixture');
  assert.deepEqual(await filesUnder(tree), ['ok']);
  assert.equal(await readArtifact(path.join(tree, 'ok'), 'utf8'), 'fixture');
  await symlink(tree, path.join(root, 'alias'));
  await assert.rejects(filesUnder(path.join(root, 'alias')));
  await symlink('/etc/passwd', path.join(tree, 'bad'));
  await assert.rejects(filesUnder(tree)); await assert.rejects(readArtifact(path.join(tree, 'bad')));
  await rm(path.join(tree, 'bad'));
  await link(path.join(tree, 'ok'), path.join(tree, 'bad'));
  await assert.rejects(filesUnder(tree)); await assert.rejects(readArtifact(path.join(tree, 'ok')));
  await rm(path.join(tree, 'bad'));
  await writeFile(path.join(tree, 'large'), ''); await truncate(path.join(tree, 'large'), 17 * 1024 * 1024);
  await assert.rejects(filesUnder(tree)); await rm(path.join(tree, 'large'));
  await mkdir(path.join(tree, ...Array(26).fill('deep')), { recursive: true });
  await assert.rejects(filesUnder(tree));
}));

test('baseline delta is byte-based, bounded and excludes unchanged images (no concurrent restoration)', async () => disposable(async root => {
  const baselines = path.join(root, 'baselines'); await mkdir(path.join(baselines, 'demo.spec.ts'), { recursive: true });
  const file = name => path.join(baselines, `demo.spec.ts/demo-${name}-desktop-light.png`);
  await writeFile(file('chat'), 'old-chat'); await writeFile(file('git'), 'old-git');
  const before = await baselineDigests(baselines);
  await writeFile(file('chat'), 'new-chat'); await writeFile(file('files'), 'new-files');
  const delta = path.join(root, 'delta');
  assert.deepEqual(await collectBaselineDelta(baselines, before, delta), ['demo.spec.ts/demo-chat-desktop-light.png', 'demo.spec.ts/demo-files-desktop-light.png']);
  assert(!(await filesUnder(delta)).some(name => name.includes('-git-')));
  await symlink(file('chat'), file('tools'));
  await assert.rejects(baselineDigests(baselines));
}));

// Fault injection exercises the real host wrapper in Docker, not a real Docker daemon.
// Actual docker build/create/start/cp/publication is additionally exercised by run-docker.sh itself.
async function harness(root, env = {}) {
  await mkdir(path.join(root, 'demo/scripts'), { recursive: true });
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await mkdir(path.join(root, 'fixture'), { recursive: true });
  for (const file of ['run-docker.sh', 'scripts/export.sh']) await cp(`demo/${file}`, path.join(root, 'demo', file));
  await writeFile(path.join(root, 'fixture/current.js'), 'validated-current');
  await writeFile(path.join(root, 'bin/docker'), `#!/usr/bin/env bash
if [[ "$1" == "$FAIL_PHASE" ]]; then exit "${'${FAIL_CODE:-37}'}"; fi
if [[ "$1" == cp ]]; then
  case "$2" in
    *:/app/demo/dist/.) [[ "$FAIL_DIST" != yes ]] || exit 44; cp -a "$FIXTURE/." "$3" ;;
    *:/app/demo/.baseline-delta/.) cp -a "$DELTA/." "$3" ;;
    *) exit 45 ;;
  esac
fi
`, { mode: 0o755 });
  return () => spawnSync('bash', ['demo/run-docker.sh', ...(env.UPDATE ? ['--update-snapshots=all'] : [])], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE: `${root}/fixture`, ...env },
  });
}

test('wrapper clean publication removes stale chunks, optional report failures do not mask success', async () => disposable(async root => {
  const run = await harness(root);
  await mkdir(path.join(root, 'demo/dist'));
  await writeFile(path.join(root, 'demo/dist/stale.js'), 'old hash');
  assert.equal(run().status, 0);
  assert.deepEqual(await readdir(path.join(root, 'demo/dist')), ['current.js']);
  assert.equal(await readFile(path.join(root, 'demo/dist/current.js'), 'utf8'), 'validated-current');
}));

test('wrapper required cp failures fail success; failed commands retain exact codes and old dist', async () => {
  for (const env of [{ FAIL_DIST: 'yes' }, ...['build', 'create', 'start'].map(FAIL_PHASE => ({ FAIL_PHASE, FAIL_CODE: '37' }))]) {
    await disposable(async root => {
      const run = await harness(root, env);
      await mkdir(path.join(root, 'demo/dist')); await writeFile(path.join(root, 'demo/dist/old.js'), 'old');
      assert.equal(run().status, env.FAIL_DIST ? 44 : 37);
      assert.deepEqual(await readdir(path.join(root, 'demo/dist')), ['old.js']);
    });
  }
});

test('wrapper refuses linked/unowned generated destinations without touching target', async () => {
  for (const mode of ['destination', 'child', 'hardlink', 'source']) await disposable(async root => {
    const run = await harness(root);
    await mkdir(path.join(root, 'unowned')); await writeFile(path.join(root, 'unowned/keep'), 'untouched');
    if (mode === 'destination') await symlink(path.join(root, 'unowned'), path.join(root, 'demo/dist'));
    else {
      await mkdir(path.join(root, 'demo/dist'));
      if (mode === 'child') await symlink(path.join(root, 'unowned'), path.join(root, 'demo/dist/bad'));
      if (mode === 'hardlink') await link(path.join(root, 'unowned/keep'), path.join(root, 'demo/dist/bad'));
      if (mode === 'source') await symlink(path.join(root, 'unowned/keep'), path.join(root, 'fixture/bad'));
    }
    assert.equal(run().status, 1);
    assert.equal(await readFile(path.join(root, 'unowned/keep'), 'utf8'), 'untouched');
  });
});

test('wrapper delta publication preserves a concurrently changed unchanged baseline', async () => disposable(async root => {
  const delta = path.join(root, 'delta'); await mkdir(path.join(delta, 'demo.spec.ts'), { recursive: true });
  await writeFile(path.join(delta, 'demo.spec.ts/demo-chat-desktop-light.png'), 'new-chat');
  const run = await harness(root, { UPDATE: 'yes', DELTA: delta });
  const destination = path.join(root, 'demo/visual-baselines/demo.spec.ts'); await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'demo-git-desktop-light.png'), 'concurrent-git');
  assert.equal(run().status, 0);
  assert.equal(await readFile(path.join(destination, 'demo-git-desktop-light.png'), 'utf8'), 'concurrent-git');
  assert.equal(await readFile(path.join(destination, 'demo-chat-desktop-light.png'), 'utf8'), 'new-chat');
}));
