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

describe('McpInventoryService import persistence', () => {
  it('passes source text and value-free environment context into Core, then returns only canonical inventory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-import-service-'));
    temporaryDirectories.push(root);
    const agentDir = path.join(root, 'agent');
    await mkdir(agentDir);
    const workspaceManager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: root });
    await workspaceManager.initialize();
    const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
    await trustManager.load();
    const service = new McpInventoryService(agentDir, workspaceManager, trustManager);
    const pastedSecret = 'SERVICE-PASTED-SECRET-0123456789';
    const response = await service.importServer({
      scope: 'global',
      revision: null,
      syntax: 'foreign',
      entryIndex: 0,
      text: JSON.stringify({
        mcpServers: {
          docs: {
            url: 'https://docs.example.test/mcp',
            headers: { Authorization: `Bearer ${pastedSecret}` },
          },
        },
      }),
      confirmations: { literalSecret: true },
    });

    expect(response.added).toEqual({ scope: 'global', name: 'docs' });
    expect(JSON.stringify(response)).not.toContain(pastedSecret);
    expect(await readFile(path.join(agentDir, 'mcp.json'), 'utf8')).toContain(pastedSecret);
  });

  it('marks a canonical reload failure after import as uncertain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-import-service-'));
    temporaryDirectories.push(root);
    const agentDir = path.join(root, 'agent');
    await mkdir(agentDir);
    const workspaceManager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: root });
    await workspaceManager.initialize();
    const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
    await trustManager.load();
    const service = new McpInventoryService(agentDir, workspaceManager, trustManager);
    vi.spyOn(service, 'getOverview').mockRejectedValueOnce(new Error('reload failed'));

    await expect(service.importServer({
      scope: 'global', revision: null, syntax: 'foreign', entryIndex: 0,
      text: 'npx public-mcp-server',
    })).rejects.toMatchObject({ code: 'write-failed', uncertain: true });
    expect(await readFile(path.join(agentDir, 'mcp.json'), 'utf8')).toContain('public-mcp-server');
  });
});

describe('McpInventoryService import preview', () => {
  it('passes only redacted inventory and environment names to the pure Core preview', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-preview-service-'));
    temporaryDirectories.push(root);
    const agentDir = path.join(root, 'agent');
    const project = path.join(root, 'project');
    await Promise.all([
      mkdir(agentDir),
      mkdir(path.join(project, '.ai-harness'), { recursive: true }),
    ]);
    const globalPath = path.join(agentDir, 'mcp.json');
    const projectPath = path.join(project, '.ai-harness', 'mcp.json');
    const globalSource = JSON.stringify({ mcpServers: { existing: { command: 'node' } } });
    const projectSource = JSON.stringify({
      mcpServers: { hidden: { command: 'node', env: { TOKEN: 'UNTRUSTED-PROJECT-SECRET' } } },
    });
    await Promise.all([
      writeFile(globalPath, globalSource),
      writeFile(projectPath, projectSource),
    ]);
    const workspaceManager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: project });
    await workspaceManager.initialize();
    const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
    await trustManager.load();
    const service = new McpInventoryService(agentDir, workspaceManager, trustManager);
    process.env.MCP_PREVIEW_HOST_TOKEN = 'HOST-ENV-SECRET-MUST-NOT-LEAK';
    try {
      const pasteSecret = 'PASTED-SECRET-MUST-NOT-LEAK';
      const preview = await service.previewImport(JSON.stringify({
        mcpServers: {
          existing: {
            url: 'https://example.test/private/path',
            headers: {
              Authorization: `Bearer ${pasteSecret}`,
              'X-Host': '${MCP_PREVIEW_HOST_TOKEN}',
            },
          },
        },
      }), 'foreign', project);
      const serialized = JSON.stringify(preview);

      expect(preview.entries[0]!.variables).toEqual([
        expect.objectContaining({
          name: 'MCP_PREVIEW_HOST_TOKEN', availability: 'available', confirmationRequired: true,
        }),
      ]);
      expect(preview.entries[0]!.scopes).toEqual({
        global: {
          allowed: false,
          reasons: ['name-taken'],
          confirmations: ['literal-secret', 'remote-host-variable'],
        },
        project: {
          allowed: false,
          reasons: ['trust-required', 'literal-secret'],
          confirmations: ['remote-host-variable'],
        },
      });
      expect(serialized).not.toContain(pasteSecret);
      expect(serialized).not.toContain(process.env.MCP_PREVIEW_HOST_TOKEN);
      expect(serialized).not.toContain('UNTRUSTED-PROJECT-SECRET');
      expect(await readFile(globalPath, 'utf8')).toBe(globalSource);
      expect(await readFile(projectPath, 'utf8')).toBe(projectSource);
    } finally {
      delete process.env.MCP_PREVIEW_HOST_TOKEN;
    }
  });

  it('uses a fresh persisted trust decision before offering project scope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-preview-service-'));
    temporaryDirectories.push(root);
    const agentDir = path.join(root, 'agent');
    const project = path.join(root, 'project');
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const workspaceManager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: project });
    await workspaceManager.initialize();
    const trustPath = path.join(agentDir, 'trust.json');
    const trustManager = new ProjectTrustManager(trustPath);
    await trustManager.load();
    const service = new McpInventoryService(agentDir, workspaceManager, trustManager);

    const before = await service.previewImport('npx public-mcp-server', 'foreign', project);
    expect(before.entries[0]!.scopes.project).toEqual({
      allowed: false,
      reasons: ['trust-required'],
      confirmations: [],
    });

    const secondManager = new ProjectTrustManager(trustPath);
    await secondManager.load();
    await secondManager.trust(project);
    const after = await service.previewImport('npx public-mcp-server', 'foreign', project);
    expect(after.entries[0]!.scopes.project).toEqual({ allowed: true, reasons: [], confirmations: [] });
  });
});
