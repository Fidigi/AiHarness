import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTrustManager } from '../security/project-trust.js';
import { importMcpServer } from './config-import.js';

const handoff = vi.hoisted(() => ({
  path: undefined as string | undefined,
  action: undefined as (() => Promise<void>) | undefined,
  unreadable: false,
  observed: 0,
}));

// Preserve real exclusive opens and filesystem reads. Inject the owner handoff
// only after the OS has actually rejected our open with EEXIST, before lstat.
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof FsPromises>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      try {
        return await fs.open(...args);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && args[0] === handoff.path && handoff.action) {
          const action = handoff.action;
          handoff.action = undefined;
          handoff.observed++;
          await action();
        }
        throw error;
      }
    },
    lstat: (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === handoff.path && handoff.unreadable) {
        return Promise.reject(Object.assign(new Error('unreadable lock'), { code: 'EACCES' }));
      }
      return fs.lstat(...args);
    },
  };
});

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-lock-handoff-'));
  roots.push(root);
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'project');
  await Promise.all([mkdir(agentDir), mkdir(project)]);
  const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
  await trustManager.load();
  return { root, agentDir, project, trustManager };
}
async function holdLock(directory: string, action: () => Promise<void>) {
  handoff.path = path.join(directory, 'mcp.json.lock');
  handoff.action = action;
  await writeFile(handoff.path, 'existing-owner\n');
}
const request = (agentDir: string) => ({ agentDir, scope: 'global' as const, expectedRevision: null,
  text: 'npx lock-handoff-mcp', entryIndex: 0 });

afterEach(async () => {
  vi.restoreAllMocks();
  handoff.path = undefined;
  handoff.action = undefined;
  handoff.unreadable = false;
  handoff.observed = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('MCP exclusive lock owner handoff', () => {
  it('acquires a normally released lock and performs the actual atomic mutation', async () => {
    const { agentDir } = await fixture();
    await holdLock(agentDir, () => rm(handoff.path!));
    await expect(importMcpServer(request(agentDir))).resolves.toMatchObject({ scope: 'global' });
    expect(handoff.observed).toBe(1);
    expect(JSON.parse(await readFile(path.join(agentDir, 'mcp.json'), 'utf8')).mcpServers)
      .toHaveProperty('lock-handoff');
    await expect(readFile(handoff.path!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still revalidates fresh-folder resources under the acquired lock and rolls trust back', async () => {
    const { agentDir, project, trustManager } = await fixture();
    const directory = path.join(project, '.ai-harness');
    await mkdir(directory);
    await holdLock(directory, async () => {
      expect(await trustManager.getDecision(project)).toMatchObject({ decision: true });
      await writeFile(path.join(directory, 'settings.json'), '{}');
      await rm(handoff.path!);
    });
    await expect(importMcpServer({ ...request(agentDir), scope: 'project', cwd: project, trustManager,
      trustFreshProject: { knownFolders: [project] } }))
      .rejects.toMatchObject({ code: 'folder-not-fresh', trustKept: false });
    expect(handoff.observed).toBe(1);
    await expect(trustManager.getDecision(project)).resolves.toBeUndefined();
    await expect(readFile(path.join(directory, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['symlink', 'directory', 'unreadable'] as const)('rejects a %s lock without mutating configuration', async kind => {
    const { agentDir, root } = await fixture();
    const outside = path.join(root, 'outside');
    await writeFile(outside, 'retained');
    await holdLock(agentDir, async () => {
      if (kind === 'unreadable') {
        handoff.unreadable = true;
        return;
      }
      await rm(handoff.path!);
      if (kind === 'symlink') await symlink(outside, handoff.path!);
      else await mkdir(handoff.path!);
    });
    await expect(importMcpServer(request(agentDir))).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(handoff.observed).toBe(1);
    await expect(readFile(path.join(agentDir, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(outside, 'utf8')).toBe('retained');
  });

  it('retains the original acquisition deadline across disappearance', async () => {
    const { agentDir } = await fixture();
    await holdLock(agentDir, async () => {
      await rm(handoff.path!);
      const expired = Date.now() + 2_001;
      vi.spyOn(Date, 'now').mockReturnValue(expired);
    });
    await expect(importMcpServer(request(agentDir))).rejects.toMatchObject({ code: 'lock-timeout' });
    expect(handoff.observed).toBe(1);
    await expect(readFile(path.join(agentDir, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
