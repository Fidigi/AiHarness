import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { LinkedDirectoriesService } from './linked-directories-service.js';
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('linked directories service policy', () => {
  it('refuses consent when the exact target cannot be shown without revealing an active secret', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'aih-linked-policy-')); temporary.push(base);
    const cwd = path.join(base, 'workspace'); const target = path.join(base, 'active-secret-path'); const storeDirectory = path.join(base, 'private');
    await mkdir(cwd); await mkdir(target); await mkdir(storeDirectory, { mode: 0o700 });
    await writeFile(path.join(target, 'file'), 'BODY'); await symlink(target, path.join(cwd, 'external'));
    const workspaces = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd }); await workspaces.initialize();
    const trust = new ProjectTrustManager(path.join(storeDirectory, 'trust.json')); await trust.load();
    const service = new LinkedDirectoriesService(workspaces, trust, { storeDirectory }, value => value.replaceAll('active-secret-path', '[REDACTED]'));
    const inventory = await service.list(cwd);
    expect(JSON.stringify(inventory)).not.toContain('active-secret-path');
    expect(inventory.entries[0]).toMatchObject({ allowed: false, reason: 'unsafe-target' });
    const selector = { cwd, directory: '.', id: inventory.entries[0].id, revision: inventory.revision };
    await expect(service.setConsent(selector, true, true)).rejects.toMatchObject({ code: 'unsafe-target' });
    expect(await trust.isTrusted(target)).toBe(false);
  });

  it('rereads shared source trust inside the consent lock before target access', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'aih-linked-fresh-trust-')); temporary.push(base);
    const cwd = path.join(base, 'workspace'); const target = path.join(base, 'target'); const storeDirectory = path.join(base, 'private');
    await mkdir(cwd); await mkdir(target); await mkdir(storeDirectory, { mode: 0o700 });
    await writeFile(path.join(target, 'file'), 'BODY'); await symlink(target, path.join(cwd, 'external'));
    const workspaces = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd }); await workspaces.initialize();
    const trustFile = path.join(storeDirectory, 'trust.json');
    const trust = new ProjectTrustManager(trustFile); await trust.load(); await trust.trust(cwd);
    const externalTrust = new ProjectTrustManager(trustFile); await externalTrust.load();
    const service = new LinkedDirectoriesService(workspaces, trust, { storeDirectory }, value => value);
    const inventory = await service.list(cwd);
    const granted = await service.setConsent({ cwd, directory: '.', id: inventory.entries[0].id, revision: inventory.revision }, true, true);
    const selected = { cwd, directory: '.', id: granted.entries[0].id, revision: granted.revision, path: 'file' };
    const original = trust.isTrusted.bind(trust); let calls = 0;
    const probe = vi.spyOn(trust, 'isTrusted').mockImplementation(async source => {
      const allowed = await original(source);
      if (++calls === 1) await externalTrust.refuse(cwd);
      return allowed;
    });
    try {
      await expect(service.read(selected)).rejects.toMatchObject({ code: 'source-trust-required' });
      expect(calls).toBe(2);
    } finally { probe.mockRestore(); }
    expect(await trust.isTrusted(target)).toBe(false);
  });

  it('masks and blocks secret-bearing descendant names without exposing target bodies', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'aih-linked-descendant-secret-')); temporary.push(base);
    const cwd = path.join(base, 'workspace'); const target = path.join(base, 'target'); const storeDirectory = path.join(base, 'private');
    await mkdir(cwd); await mkdir(target); await mkdir(storeDirectory, { mode: 0o700 });
    await writeFile(path.join(target, 'active-secret-name'), 'BODY'); await symlink(target, path.join(cwd, 'external'));
    const workspaces = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd }); await workspaces.initialize();
    const trust = new ProjectTrustManager(path.join(storeDirectory, 'trust.json')); await trust.load(); await trust.trust(cwd);
    const service = new LinkedDirectoriesService(workspaces, trust, { storeDirectory }, value => value.replaceAll('active-secret-name', '[REDACTED]'));
    const inventory = await service.list(cwd);
    const granted = await service.setConsent({ cwd, directory: '.', id: inventory.entries[0].id, revision: inventory.revision }, true, true);
    const selected = { cwd, directory: '.', id: granted.entries[0].id, revision: granted.revision };
    const listing = await service.browse({ ...selected, path: '.' });
    expect(listing.entries[0]).toMatchObject({ name: '[REDACTED]', path: '[REDACTED]', blocked: true });
    expect(JSON.stringify(listing)).not.toContain('active-secret-name'); expect(JSON.stringify(listing)).not.toContain('BODY');
    await expect(service.read({ ...selected, path: 'active-secret-name' })).rejects.toMatchObject({ code: 'unsafe-target' });
  });
});
