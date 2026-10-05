import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectTrustManager } from '../security/project-trust.js';
import { importMcpServer, replaceMcpServer } from './config-import.js';
import { inspectMcpConfig } from './config-inventory.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  agentDir: string;
  project: string;
  trustManager: ProjectTrustManager;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-import-write-'));
  temporaryDirectories.push(root);
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'project');
  await Promise.all([mkdir(agentDir), mkdir(project)]);
  const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
  await trustManager.load();
  return { agentDir, project, trustManager };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('importMcpServer', () => {
  it('reparses text and appends one entry with one style- and mode-preserving atomic mutation', async () => {
    const { agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    const source = [
      '{',
      '\t"version": 1,',
      '\t"futureRoot": { "retained": true },',
      '\t"mcpServers": {',
      '\t\t"existing": { "command": "node" }',
      '\t}',
      '}',
      '',
    ].join('\r\n');
    await writeFile(filePath, source, { mode: 0o666 });
    await chmod(filePath, 0o666);
    const before = await inspectMcpConfig({ agentDir });

    const result = await importMcpServer({
      agentDir,
      scope: 'global',
      expectedRevision: before.files[0]!.revision!,
      text: 'npx -y @example/docs-mcp',
      syntax: 'foreign',
      entryIndex: 0,
    });

    expect(result).toEqual({ name: 'docs', scope: 'global', revision: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).not.toMatch(/(?<!\r)\n/u);
    expect(persisted).toContain('\r\n\t"futureRoot"');
    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      futureRoot: { retained: true },
      mcpServers: {
        existing: { command: 'node' },
        docs: { command: 'npx', args: ['-y', '@example/docs-mcp'] },
      },
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('fills fields, replaces paste-owned secrets with references, and requires exact remote confirmations', async () => {
    const { agentDir, project, trustManager } = await fixture();
    await trustManager.trust(project);
    const pastedSecret = 'sk-source-secret-0123456789abcdef';
    const text = JSON.stringify({
      mcpServers: {
        docs: {
          url: 'https://docs.example.test/mcp',
          headers: {
            Authorization: `Bearer ${pastedSecret}`,
            'X-Host': '${HOST_TOKEN}',
            'X-Tenant': 'YOUR_TENANT',
          },
        },
      },
    });

    const base = {
      agentDir,
      cwd: project,
      trustManager,
      scope: 'project' as const,
      expectedRevision: null,
      text,
      syntax: 'foreign' as const,
      entryIndex: 0,
      values: { 'headers.X-Tenant': { reference: 'TENANT_TOKEN' } },
      secretReferences: { 'headers.Authorization': 'DOCS_TOKEN' },
      availableVariableNames: ['HOST_TOKEN', 'TENANT_TOKEN', 'DOCS_TOKEN'],
    };
    await expect(importMcpServer({
      ...base,
      confirmations: { remoteHostVariables: ['HOST_TOKEN', 'TENANT_TOKEN'] },
    })).rejects.toMatchObject({ code: 'confirmation-required' });

    await importMcpServer({
      ...base,
      confirmations: { remoteHostVariables: ['HOST_TOKEN', 'TENANT_TOKEN', 'DOCS_TOKEN'] },
    });
    const filePath = path.join(project, '.ai-harness', 'mcp.json');
    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).not.toContain(pastedSecret);
    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      mcpServers: {
        docs: {
          url: 'https://docs.example.test/mcp',
          headers: {
            Authorization: 'Bearer ${DOCS_TOKEN}',
            'X-Host': '${HOST_TOKEN}',
            'X-Tenant': '${TENANT_TOKEN}',
          },
        },
      },
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o644);
  });

  it('keeps literal secrets out of project files and requires explicit global confirmation', async () => {
    const { agentDir, project, trustManager } = await fixture();
    await trustManager.trust(project);
    const text = 'API_TOKEN=literal-secret-value-0123456789 npx docs-mcp';

    await expect(importMcpServer({
      agentDir,
      cwd: project,
      trustManager,
      scope: 'project',
      expectedRevision: null,
      text,
      entryIndex: 0,
    })).rejects.toMatchObject({ code: 'scope-blocked' });
    await expect(readFile(path.join(project, '.ai-harness', 'mcp.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await expect(importMcpServer({
      agentDir,
      scope: 'global',
      expectedRevision: null,
      text,
      entryIndex: 0,
    })).rejects.toMatchObject({ code: 'confirmation-required' });
    await importMcpServer({
      agentDir,
      scope: 'global',
      expectedRevision: null,
      text,
      entryIndex: 0,
      confirmations: { literalSecret: true },
    });
    expect(await readFile(path.join(agentDir, 'mcp.json'), 'utf8')).toContain('literal-secret-value');
  });

  it('requires an effective persisted allow before creating a project target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-import-'));
    temporaryDirectories.push(root);
    const agentDir = path.join(root, 'agent');
    const project = path.join(root, 'project');
    await mkdir(agentDir);
    await mkdir(project);
    const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
    await trustManager.load();

    await expect(importMcpServer({
      agentDir,
      cwd: project,
      trustManager,
      scope: 'project',
      expectedRevision: null,
      text: 'npx public-mcp-server',
      entryIndex: 0,
    })).rejects.toMatchObject({ code: 'trust-required' });
    await expect(lstat(path.join(project, '.ai-harness'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects missing, unknown, reserved, and unsafe field input without creating a file', async () => {
    const { agentDir } = await fixture();
    const text = JSON.stringify({ command: '<binary>', args: ['-c', 'run'], env: { TOKEN: 'YOUR_TOKEN' } });
    const base = {
      agentDir,
      scope: 'global' as const,
      expectedRevision: null,
      text,
      entryIndex: 0,
    };

    await expect(importMcpServer(base)).rejects.toMatchObject({ code: 'fields-incomplete' });
    await expect(importMcpServer({
      ...base,
      values: { command: 'node', 'env.TOKEN': 'literal', smuggled: 'value' },
    })).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(importMcpServer({
      ...base,
      values: {
        command: 'node',
        'env.TOKEN': { reference: 'AI_HARNESS_MASTER_KEY' },
      },
    })).rejects.toMatchObject({ code: 'reserved-variable' });
    await expect(importMcpServer({
      ...base,
      values: { command: 'sh', 'env.TOKEN': 'literal' },
      confirmations: { literalSecret: true },
    })).rejects.toMatchObject({ code: 'import-invalid' });
    await expect(readFile(path.join(agentDir, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects stale revisions and names taken under the writer lock', async () => {
    const { agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    await writeFile(filePath, JSON.stringify({ mcpServers: { docs: { command: 'node' } } }));
    const inventory = await inspectMcpConfig({ agentDir });
    const request = {
      agentDir,
      scope: 'global' as const,
      expectedRevision: inventory.files[0]!.revision!,
      text: 'npx other-mcp',
      entryIndex: 0,
      name: 'other',
    };
    await writeFile(filePath, JSON.stringify({ mcpServers: { docs: { command: 'node' }, changed: { command: 'node' } } }));
    await expect(importMcpServer(request)).rejects.toMatchObject({ code: 'stale-revision' });

    const fresh = await inspectMcpConfig({ agentDir });
    await expect(importMcpServer({ ...request, expectedRevision: fresh.files[0]!.revision!, name: 'docs' }))
      .rejects.toMatchObject({ code: 'target-conflict' });
    expect(Object.keys((JSON.parse(await readFile(filePath, 'utf8')) as { mcpServers: object }).mcpServers))
      .toEqual(['docs', 'changed']);
  });
});

describe('replaceMcpServer', () => {
  it('reparses text and replaces one entry in place while preserving siblings, style, and mode', async () => {
    const { agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    const source = [
      '{',
      '\t"version": 1,',
      '\t"futureRoot": { "retained": true },',
      '\t"mcpServers": {',
      '\t\t"before": { "command": "node", "env": { "TOKEN": "SIBLING-SECRET" } },',
      '\t\t"docs": { "url": "https://old.example.test", "headers": { "Authorization": "OLD-SECRET" } },',
      '\t\t"after": { "command": "node" }',
      '\t}',
      '}',
      '',
    ].join('\r\n');
    await writeFile(filePath, source, { mode: 0o666 });
    await chmod(filePath, 0o666);
    const before = await inspectMcpConfig({ agentDir });
    const pastedSecret = 'NEW-PASTED-SECRET-0123456789';
    const replacement = {
      agentDir,
      scope: 'global' as const,
      expectedRevision: before.files[0]!.revision!,
      targetName: 'docs',
      text: JSON.stringify({
        mcpServers: {
          replacement: {
            url: 'https://new.example.test/mcp',
            headers: { Authorization: `Bearer ${pastedSecret}`, 'X-Host': '${HOST_TOKEN}' },
          },
        },
      }),
      syntax: 'aiharness' as const,
      entryIndex: 0,
      name: 'renamed-docs',
      availableVariableNames: ['HOST_TOKEN'],
    };
    await expect(replaceMcpServer({
      ...replacement,
      confirmations: { literalSecret: true },
    })).rejects.toMatchObject({ code: 'confirmation-required' });
    expect(await readFile(filePath, 'utf8')).toBe(source);

    const result = await replaceMcpServer({
      ...replacement,
      confirmations: { literalSecret: true, remoteHostVariables: ['HOST_TOKEN'] },
    });

    expect(result).toEqual({
      previousName: 'docs',
      name: 'renamed-docs',
      scope: 'global',
      revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      changed: true,
    });
    expect(JSON.stringify(result)).not.toContain(pastedSecret);
    expect(JSON.stringify(result)).not.toContain('OLD-SECRET');
    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).not.toMatch(/(?<!\r)\n/u);
    expect(persisted).toContain('\r\n\t"futureRoot"');
    expect(Object.keys((JSON.parse(persisted) as { mcpServers: Record<string, unknown> }).mcpServers))
      .toEqual(['before', 'renamed-docs', 'after']);
    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      futureRoot: { retained: true },
      mcpServers: {
        before: { command: 'node', env: { TOKEN: 'SIBLING-SECRET' } },
        'renamed-docs': {
          url: 'https://new.example.test/mcp',
          headers: { Authorization: `Bearer ${pastedSecret}`, 'X-Host': '${HOST_TOKEN}' },
        },
        after: { command: 'node' },
      },
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('is byte-stable when the rebuilt entry and name are unchanged', async () => {
    const { agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    const entry = {
      command: 'node', args: ['server.js'], env: { TOKEN: '${TOKEN}' }, enabled: false, exposure: 'deferred',
    };
    const source = `${JSON.stringify({ version: 1, mcpServers: { 'docs server': entry } }, null, 2)}\n`;
    await writeFile(filePath, source);
    const before = await inspectMcpConfig({ agentDir });

    const result = await replaceMcpServer({
      agentDir,
      scope: 'global',
      expectedRevision: before.files[0]!.revision!,
      targetName: 'docs server',
      text: JSON.stringify({ mcpServers: { replacement: entry } }),
      syntax: 'aiharness',
      entryIndex: 0,
      name: 'docs server',
    });

    expect(result).toMatchObject({
      previousName: 'docs server', name: 'docs server', scope: 'global',
      revision: before.files[0]!.revision, changed: false,
    });
    expect(await readFile(filePath, 'utf8')).toBe(source);
  });

  it('reuses project secret, trust, revision, target, and collision policy', async () => {
    const { agentDir, project, trustManager } = await fixture();
    const projectDirectory = path.join(project, '.ai-harness');
    const filePath = path.join(projectDirectory, 'mcp.json');
    await mkdir(projectDirectory);
    const source = JSON.stringify({
      mcpServers: { docs: { command: 'node' }, occupied: { command: 'node' }, broken: { url: 'ftp://invalid' } },
    });
    await writeFile(filePath, source);
    const text = JSON.stringify({
      mcpServers: { docs: { url: 'https://docs.example.test', headers: { Authorization: 'literal-secret-0123456789' } } },
    });
    await trustManager.trust(project);
    const initial = await inspectMcpConfig({ agentDir, cwd: project, trustManager });
    await trustManager.untrust(project);
    const base = {
      agentDir,
      cwd: project,
      trustManager,
      scope: 'project' as const,
      expectedRevision: initial.files.find(file => file.scope === 'project')!.revision!,
      targetName: 'docs',
      text,
      syntax: 'aiharness' as const,
      entryIndex: 0,
    };

    await expect(replaceMcpServer({
      ...base,
      text: 'npx public-mcp-server',
      syntax: 'foreign',
    })).rejects.toMatchObject({ code: 'trust-required' });
    expect(await readFile(filePath, 'utf8')).toBe(source);
    await trustManager.trust(project);
    await expect(replaceMcpServer(base)).rejects.toMatchObject({ code: 'scope-blocked' });
    await expect(replaceMcpServer({
      ...base,
      targetName: 'broken',
      secretReferences: { 'headers.Authorization': 'DOCS_TOKEN' },
    })).rejects.toMatchObject({ code: 'target-invalid' });
    await expect(replaceMcpServer({
      ...base,
      name: 'occupied',
      secretReferences: { 'headers.Authorization': 'DOCS_TOKEN' },
    })).rejects.toMatchObject({ code: 'target-conflict' });

    await writeFile(filePath, JSON.stringify({
      mcpServers: { docs: { command: 'node' }, occupied: { command: 'node' }, changed: { command: 'node' } },
    }));
    await expect(replaceMcpServer({
      ...base,
      secretReferences: { 'headers.Authorization': 'DOCS_TOKEN' },
    })).rejects.toMatchObject({ code: 'stale-revision' });
  });
});
