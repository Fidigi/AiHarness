import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { ProjectTrustManager } from './project-trust';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(item => rm(item, { recursive: true, force: true }))));

describe('ProjectTrustManager', () => {
  it('persists trusted projects in a private file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-trust-'));
    directories.push(root);
    const filePath = path.join(root, 'config', 'trust.json');
    const project = path.join(root, 'project');
    const manager = new ProjectTrustManager(filePath);
    await manager.load();

    await manager.trust(project);

    expect(await manager.isTrusted(project)).toBe(true);
    expect(JSON.parse(await readFile(filePath, 'utf8')).trustedProjects).toContain(path.resolve(project));
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const reloaded = new ProjectTrustManager(filePath);
    await reloaded.load();
    expect(await reloaded.isTrusted(project)).toBe(true);
    await reloaded.untrust(project);
    expect(await reloaded.isTrusted(project)).toBe(false);
  });
});
