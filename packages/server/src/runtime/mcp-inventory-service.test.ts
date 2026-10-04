import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { McpInventoryService } from './mcp-inventory-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('McpInventoryService undo store', () => {
  it('keeps raw removals server-side and enforces one-shot, FIFO, and expiry bounds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-service-'));
    temporaryDirectories.push(root);
    const agentDir = path.join(root, 'agent');
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        first: { command: 'node', env: { TOKEN: 'FIRST-SERVER-SECRET' } },
        second: { command: 'node', env: { TOKEN: 'SECOND-SERVER-SECRET' } },
        third: { command: 'node', env: { TOKEN: 'THIRD-SERVER-SECRET' } },
      },
    }));
    const workspaceManager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: root });
    await workspaceManager.initialize();
    const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
    await trustManager.load();
    let now = 1_000;
    let sequence = 0;
    const service = new McpInventoryService(agentDir, workspaceManager, trustManager, {
      undoMaxRecords: 2,
      undoTtlMs: 100,
      now: () => now,
      createToken: () => `opaque-token-${String(++sequence).padStart(4, '0')}`,
    });

    let inventory = await service.getOverview();
    const remove = async (name: string): Promise<string> => {
      const revision = inventory.files[0]!.revision!;
      const response = await service.remove({ scope: 'global', revision, name });
      expect(JSON.stringify(response)).not.toContain('SERVER-SECRET');
      inventory = response.inventory;
      return response.undo!.token;
    };
    const first = await remove('first');
    const second = await remove('second');
    const third = await remove('third');

    await expect(service.restore({ undoToken: first })).rejects.toMatchObject({ code: 'target-not-found' });
    await expect(service.restore({ undoToken: second })).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(service.restore({ undoToken: second })).rejects.toMatchObject({ code: 'target-not-found' });
    now += 101;
    await expect(service.restore({ undoToken: third })).rejects.toMatchObject({ code: 'target-not-found' });
  });

  it('marks a failed canonical reload after commit as uncertain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-service-'));
    temporaryDirectories.push(root);
    const agentDir = path.join(root, 'agent');
    const filePath = path.join(agentDir, 'mcp.json');
    await mkdir(agentDir);
    await writeFile(filePath, JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }));
    const workspaceManager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: root });
    await workspaceManager.initialize();
    const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
    await trustManager.load();
    const service = new McpInventoryService(agentDir, workspaceManager, trustManager);
    const inventory = await service.getOverview();
    vi.spyOn(service, 'getOverview').mockRejectedValueOnce(new Error('reload failed'));

    await expect(service.setEnabled({
      scope: 'global',
      revision: inventory.files[0]!.revision!,
      names: ['alpha'],
      enabled: false,
    })).rejects.toMatchObject({ code: 'write-failed', uncertain: true });

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
      mcpServers: { alpha: { enabled: false } },
    });
  });
});
