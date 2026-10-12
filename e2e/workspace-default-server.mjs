import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from '@ai-harness/core';
import { start, stop } from '../packages/server/dist/index.js';
import { createRuntimeServices } from '../packages/server/dist/runtime/services.js';

const kinds = ['relative', 'missing', 'removed-during-start'];
export async function workspaceDefaultServer(kind = 'missing') {
  assert.ok(kinds.includes(kind));
  const root = await mkdtemp(path.join(os.homedir(), 'aih-workspace-default-'));
  const cwd = path.join(root, 'allowed'); const dataDir = path.join(root, 'private');
  const marker = path.join(root, 'global-loaded'); const projectMarker = path.join(root, 'project-loaded');
  await mkdir(path.join(cwd, '.ai-harness', 'extensions'), { recursive: true });
  await mkdir(path.join(dataDir, 'extensions'), { recursive: true });
  const extension = target => `import { writeFile } from 'node:fs/promises'; export default async () => { await writeFile(${JSON.stringify(target)}, 'loaded'); };`;
  await writeFile(path.join(dataDir, 'extensions', 'global.mjs'), extension(marker));
  await writeFile(path.join(cwd, '.ai-harness', 'extensions', 'project.mjs'), extension(projectMarker));
  const defaultCwd = kind === 'missing' ? path.join(cwd, 'removed')
    : kind === 'removed-during-start' ? path.join(cwd, 'temporary-default') : path.relative(process.cwd(), cwd);
  if (kind === 'removed-during-start') await mkdir(defaultCwd);
  let services;
  try {
    const server = await start({ port: 0, host: '127.0.0.1', webRoot: path.resolve('packages/web/dist'),
      dataDir, allowedRoots: [cwd], defaultCwd, enableMockProvider: true,
      runtimeServicesFactory: async (proxy, options) => {
        const bootstrap = kind === 'removed-during-start' ? { ...options,
          // A trusted-host checkpoint after the first successful default lookup.
          get trustFile() { rmSync(defaultCwd, { recursive: true, force: true }); return path.join(dataDir, 'trust.json'); },
        } : options;
        return (services = await createRuntimeServices(proxy, bootstrap));
      },
    });
    assert.ok(services.workspaceManager instanceof WorkspaceManager);
    return { cwd, root, marker, projectMarker, services, url: `http://127.0.0.1:${server.port}`,
      async close() { await stop(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await stop(); await rm(root, { recursive: true, force: true }); throw error; }
}

if (process.argv.includes('--check')) {
  const selected = process.argv.find(arg => arg.startsWith('--kind='));
  for (const kind of selected ? [selected.slice('--kind='.length)] : kinds) {
    const f = await workspaceDefaultServer(kind);
    try {
      const initial = await fetch(`${f.url}/api/workspaces/default`);
      assert.equal(initial.status, kind === 'relative' ? 200 : 404);
      if (kind !== 'relative') await assert.rejects(access(f.marker));
      const validated = await fetch(`${f.url}/api/workspaces/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: f.cwd }) });
      assert.equal(validated.status, 200);
      const descriptor = await validated.json();
      assert.equal(descriptor.cwd, f.cwd); assert.ok(descriptor.displayPath.startsWith('~/'));
      assert.equal(descriptor.operationTrusted, false);
      assert.equal(await f.services.trustManager.isTrusted(f.cwd), false);
      assert.equal(f.services.sessionManager.list().length, 0);
      const reloaded = await f.services.reloadResources({ cwd: f.cwd });
      assert.deepEqual(reloaded.errors, []);
      await access(f.marker); await assert.rejects(access(f.projectMarker));
      console.log(`WORKSPACE_PUBLIC_OK ${kind}`);
    } finally { await f.close(); }
  }
}
