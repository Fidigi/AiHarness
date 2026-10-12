import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectTrustManager } from '../security/project-trust.js';
import {
  inspectMcpConfig,
  McpConfigMutationError,
  removeMcpServer,
  restoreMcpServer,
  setMcpServerExposure,
  setMcpServersEnabled,
} from './config-inventory.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  root: string;
  agentDir: string;
  project: string;
  trustManager: ProjectTrustManager;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-mutation-'));
  temporaryDirectories.push(root);
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'project');
  await Promise.all([mkdir(agentDir), mkdir(project)]);
  const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
  await trustManager.load();
  return { root, agentDir, project, trustManager };
}

function mutationCode(error: unknown): string | undefined {
  return error instanceof McpConfigMutationError ? error.code : undefined;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('MCP configuration mutations', () => {
  it('commits a bounded activation group once while retaining format, unknown keys, and restrictive global mode', async () => {
    const { agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    const source = [
      '{',
      '\t"version": 1,',
      '\t"futureRoot": { "retained": true },',
      '\t"mcpServers": {',
      '\t\t"alpha": { "command": "node" },',
      '\t\t"beta": { "url": "https://example.test", "enabled": false },',
      '\t\t"future": { "command": "node", "futureField": "KEEP-ME" }',
      '\t}',
      '}',
      '',
    ].join('\r\n');
    await writeFile(filePath, source, { mode: 0o666 });
    await chmod(filePath, 0o666);
    const before = await inspectMcpConfig({ agentDir });
    const revision = before.files[0]?.revision;
    expect(revision).toMatch(/^[a-f0-9]{64}$/u);

    const result = await setMcpServersEnabled({
      agentDir,
      scope: 'global',
      expectedRevision: revision!,
      names: ['alpha', 'beta', 'missing', 'future'],
      enabled: false,
    });

    expect(result).toMatchObject({
      changed: true,
      outcomes: [
        { name: 'alpha', status: 'changed' },
        { name: 'beta', status: 'unchanged' },
        { name: 'missing', status: 'missing' },
        { name: 'future', status: 'invalid' },
      ],
    });
    const persisted = await readFile(filePath, 'utf8');
    expect(persisted.endsWith('\r\n')).toBe(true);
    expect(persisted).not.toMatch(/(?<!\r)\n/u);
    expect(persisted).toContain('\r\n\t"futureRoot"');
    const parsed = JSON.parse(persisted) as {
      futureRoot: { retained: boolean };
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.futureRoot).toEqual({ retained: true });
    expect(parsed.mcpServers.alpha?.enabled).toBe(false);
    expect(parsed.mcpServers.future?.futureField).toBe('KEEP-ME');
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const after = await inspectMcpConfig({ agentDir });
    await expect(removeMcpServer({
      agentDir,
      scope: 'global',
      expectedRevision: after.files[0]!.revision!,
      name: 'future',
    })).rejects.toMatchObject({ code: 'target-invalid' });
    expect(await readFile(filePath, 'utf8')).toBe(persisted);
  });

  it('changes exposure atomically while retaining secrets, unknown data, style, and file mode', async () => {
    const { agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    const source = [
      '{',
      '\t"version": 1,',
      '\t"futureRoot": { "retained": true },',
      '\t"mcpServers": {',
      '\t\t"alpha": {',
      '\t\t\t"command": "node",',
      '\t\t\t"env": { "TOKEN": "EXPOSURE-SECRET" },',
      '\t\t\t"exposure": "deferred"',
      '\t\t}',
      '\t}',
      '}',
      '',
    ].join('\r\n');
    await writeFile(filePath, source, { mode: 0o664 });
    await chmod(filePath, 0o664);
    const before = await inspectMcpConfig({ agentDir });

    const changed = await setMcpServerExposure({
      agentDir,
      scope: 'global',
      expectedRevision: before.files[0]!.revision!,
      name: 'alpha',
      exposure: 'codemode',
    });
    expect(changed).toMatchObject({ changed: true, revision: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    const codemodeText = await readFile(filePath, 'utf8');
    expect(codemodeText).not.toMatch(/(?<!\r)\n/u);
    expect(codemodeText).toContain('\r\n\t"futureRoot"');
    expect(JSON.parse(codemodeText)).toMatchObject({
      futureRoot: { retained: true },
      mcpServers: { alpha: { env: { TOKEN: 'EXPOSURE-SECRET' }, exposure: 'codemode' } },
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const direct = await setMcpServerExposure({
      agentDir,
      scope: 'global',
      expectedRevision: changed.revision,
      name: 'alpha',
      exposure: 'direct',
    });
    expect(direct.changed).toBe(true);
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      mcpServers: { alpha: Record<string, unknown> };
    };
    expect(persisted.mcpServers.alpha).not.toHaveProperty('exposure');
    expect(persisted.mcpServers.alpha).toMatchObject({ env: { TOKEN: 'EXPOSURE-SECRET' } });
    const directText = await readFile(filePath, 'utf8');
    await expect(setMcpServerExposure({
      agentDir,
      scope: 'global',
      expectedRevision: direct.revision,
      name: 'alpha',
      exposure: 'direct',
    })).resolves.toEqual({ changed: false, revision: direct.revision });
    expect(await readFile(filePath, 'utf8')).toBe(directText);
  });

  it('persists hidden and exact per-tool overrides without changing the server default or secrets', async () => {
    const { agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    await writeFile(filePath, JSON.stringify({ mcpServers: { alpha: {
      command: 'node', exposure: 'codemode', env: { TOKEN: 'KEEP-PRIVATE' },
    } } }));
    const before = await inspectMcpConfig({ agentDir });
    const changed = await setMcpServerExposure({ agentDir, scope: 'global', name: 'alpha',
      expectedRevision: before.files[0]!.revision!, tool: 'remote/read', exposure: 'hidden' });
    expect(changed.changed).toBe(true);
    const overridden = await inspectMcpConfig({ agentDir });
    expect(overridden.servers[0]).toMatchObject({ exposure: 'codemode', toolExposure: { 'remote/read': 'hidden' } });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ mcpServers: { alpha: {
      env: { TOKEN: 'KEEP-PRIVATE' }, exposure: 'codemode', toolExposure: { 'remote/read': 'hidden' },
    } } });
    const direct = await setMcpServerExposure({ agentDir, scope: 'global', name: 'alpha',
      expectedRevision: changed.revision, tool: 'remote/read', exposure: 'direct' });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ mcpServers: { alpha: {
      exposure: 'codemode', toolExposure: { 'remote/read': 'direct' },
    } } });
    await expect(setMcpServerExposure({ agentDir, scope: 'global', name: 'alpha', expectedRevision: direct.revision,
      tool: 'bad\nname', exposure: 'hidden' })).rejects.toMatchObject({ code: 'invalid-request' });
    await setMcpServerExposure({ agentDir, scope: 'global', name: 'alpha', expectedRevision: direct.revision, exposure: 'hidden' });
    const hidden = await inspectMcpConfig({ agentDir });
    expect(hidden.servers[0]).toMatchObject({ exposure: 'hidden', toolExposure: { 'remote/read': 'direct' } });
    expect(JSON.stringify(hidden)).not.toContain('KEEP-PRIVATE');
  });

  it('refuses invalid, missing, and stale exposure mutations without changing the file', async () => {
    const { agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    const source = JSON.stringify({
      mcpServers: {
        alpha: { command: 'node' },
        invalid: { command: 'node', futureField: true },
      },
    });
    await writeFile(filePath, source);
    const before = await inspectMcpConfig({ agentDir });
    const revision = before.files[0]!.revision!;

    await expect(setMcpServerExposure({
      agentDir, scope: 'global', expectedRevision: revision, name: 'missing', exposure: 'deferred',
    })).rejects.toMatchObject({ code: 'target-not-found', uncertain: false });
    await expect(setMcpServerExposure({
      agentDir, scope: 'global', expectedRevision: revision, name: 'invalid', exposure: 'deferred',
    })).rejects.toMatchObject({ code: 'target-invalid', uncertain: false });
    await expect(setMcpServerExposure({
      agentDir, scope: 'global', expectedRevision: revision, name: 'alpha', exposure: 'invalid' as never,
    })).rejects.toMatchObject({ code: 'invalid-request', uncertain: false });

    const committed = await setMcpServerExposure({
      agentDir, scope: 'global', expectedRevision: revision, name: 'alpha', exposure: 'deferred',
    });
    await expect(setMcpServerExposure({
      agentDir, scope: 'global', expectedRevision: revision, name: 'alpha', exposure: 'codemode',
    })).rejects.toMatchObject({ code: 'stale-revision', uncertain: false });
    expect(committed.changed).toBe(true);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
      mcpServers: { alpha: { exposure: 'deferred' }, invalid: { futureField: true } },
    });
  });

  it('rejects stale concurrent writers without publishing a partial batch', async () => {
    const { agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    await writeFile(filePath, JSON.stringify({
      version: 1,
      mcpServers: {
        alpha: { command: 'node' },
        beta: { command: 'node' },
      },
    }));
    const inventory = await inspectMcpConfig({ agentDir });
    const expectedRevision = inventory.files[0]!.revision!;

    const attempts = await Promise.allSettled([
      setMcpServersEnabled({
        agentDir, scope: 'global', expectedRevision, names: ['alpha', 'beta'], enabled: false,
      }),
      setMcpServersEnabled({
        agentDir, scope: 'global', expectedRevision, names: ['alpha'], enabled: false,
      }),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? mutationCode(rejected.reason) : undefined).toBe('stale-revision');

    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      mcpServers: Record<string, { enabled?: boolean }>;
    };
    const states = [parsed.mcpServers.alpha?.enabled, parsed.mcpServers.beta?.enabled];
    expect(states).toEqual(states[1] === false ? [false, false] : [false, undefined]);
  });

  it('leaves malformed and linked targets untouched', async () => {
    const { root, agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    const malformed = '{ "mcpServers": {';
    await writeFile(filePath, malformed);
    const inventory = await inspectMcpConfig({ agentDir });
    await expect(setMcpServersEnabled({
      agentDir,
      scope: 'global',
      expectedRevision: inventory.files[0]!.revision!,
      names: ['alpha'],
      enabled: false,
    })).rejects.toMatchObject({ code: 'invalid-config', uncertain: false });
    expect(await readFile(filePath, 'utf8')).toBe(malformed);

    await rm(filePath);
    const target = path.join(root, 'outside.json');
    await writeFile(target, JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }));
    await symlink(target, filePath);
    await expect(setMcpServersEnabled({
      agentDir,
      scope: 'global',
      expectedRevision: null,
      names: ['alpha'],
      enabled: false,
    })).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ mcpServers: { alpha: { command: 'node' } } });
  });

  it('refuses a linked project configuration directory without touching its target', async () => {
    const { root, agentDir, project, trustManager } = await fixture();
    const outside = path.join(root, 'outside-config');
    await mkdir(outside);
    const outsideFile = path.join(outside, 'mcp.json');
    const source = JSON.stringify({ mcpServers: { alpha: { command: 'node' } } });
    await writeFile(outsideFile, source);
    await symlink(outside, path.join(project, '.ai-harness'));
    await trustManager.trust(project);

    await expect(setMcpServersEnabled({
      agentDir,
      cwd: project,
      trustManager,
      scope: 'project',
      expectedRevision: null,
      names: ['alpha'],
      enabled: false,
    })).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(await readFile(outsideFile, 'utf8')).toBe(source);
  });

  it('requires fresh persisted project trust and preserves an existing project mode', async () => {
    const { agentDir, project, trustManager } = await fixture();
    const directory = path.join(project, '.ai-harness');
    const filePath = path.join(directory, 'mcp.json');

    await expect(setMcpServersEnabled({
      agentDir,
      cwd: project,
      trustManager,
      scope: 'project',
      expectedRevision: null,
      names: ['alpha'],
      enabled: false,
    })).rejects.toMatchObject({ code: 'trust-required' });
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });

    await trustManager.trust(project);
    await mkdir(directory);
    await writeFile(filePath, JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }), { mode: 0o640 });
    await chmod(filePath, 0o640);
    const inventory = await inspectMcpConfig({ agentDir, cwd: project, trustManager });
    await setMcpServersEnabled({
      agentDir,
      cwd: project,
      trustManager,
      scope: 'project',
      expectedRevision: inventory.files.find(file => file.scope === 'project')!.revision!,
      names: ['alpha'],
      enabled: false,
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o640);

    const after = await inspectMcpConfig({ agentDir, cwd: project, trustManager });
    await trustManager.refuse(project);
    await expect(setMcpServersEnabled({
      agentDir,
      cwd: project,
      trustManager,
      scope: 'project',
      expectedRevision: after.files.find(file => file.scope === 'project')!.revision!,
      names: ['alpha'],
      enabled: true,
    })).rejects.toMatchObject({ code: 'trust-required' });
  });

  it('binds project undo material to the canonical trusted directory', async () => {
    const { root, agentDir, project, trustManager } = await fixture();
    const alias = path.join(root, 'project-alias');
    const directory = path.join(project, '.ai-harness');
    await symlink(project, alias);
    await trustManager.trust(project);
    await mkdir(directory);
    await writeFile(path.join(directory, 'mcp.json'), JSON.stringify({
      mcpServers: { secret: { command: 'node', env: { TOKEN: 'LITERAL-SECRET' } } },
    }));
    const inventory = await inspectMcpConfig({ agentDir, cwd: alias, trustManager });

    const removal = await removeMcpServer({
      agentDir,
      cwd: alias,
      trustManager,
      scope: 'project',
      expectedRevision: inventory.files.find(file => file.scope === 'project')!.revision!,
      name: 'secret',
    });

    expect(removal.removed.cwd).toBe(await realpath(project));
    await restoreMcpServer({ agentDir, trustManager, record: removal.removed });
    expect(await readFile(path.join(directory, 'mcp.json'), 'utf8')).toContain('LITERAL-SECRET');
  });

  it('uses mode 0644 when a trusted project restoration creates a new file', async () => {
    const { agentDir, project, trustManager } = await fixture();
    await trustManager.trust(project);
    const result = await restoreMcpServer({
      agentDir,
      trustManager,
      record: {
        scope: 'project',
        cwd: project,
        name: '__proto__',
        index: 0,
        entry: { command: 'node' },
        expectedRevision: null,
      },
    });
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/u);
    const filePath = path.join(project, '.ai-harness', 'mcp.json');
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.hasOwn(parsed.mcpServers, '__proto__')).toBe(true);
    expect((await stat(filePath)).mode & 0o777).toBe(0o644);
  });

  it('removes and restores the literal entry at its original position, with stale restore protection', async () => {
    const { agentDir } = await fixture();
    const filePath = path.join(agentDir, 'mcp.json');
    await writeFile(filePath, JSON.stringify({
      version: 1,
      mcpServers: {
        first: { command: 'node' },
        secret: { command: '/private/bin/server', env: { TOKEN: 'LITERAL-SECRET' } },
        last: { url: 'https://example.test/private' },
      },
    }));
    const before = await inspectMcpConfig({ agentDir });
    const removal = await removeMcpServer({
      agentDir,
      scope: 'global',
      expectedRevision: before.files[0]!.revision!,
      name: 'secret',
    });
    expect(JSON.stringify(removal.removed)).toContain('LITERAL-SECRET');
    expect(Object.keys((JSON.parse(await readFile(filePath, 'utf8')) as { mcpServers: object }).mcpServers))
      .toEqual(['first', 'last']);

    await restoreMcpServer({ agentDir, record: removal.removed });
    const restored = JSON.parse(await readFile(filePath, 'utf8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(Object.keys(restored.mcpServers)).toEqual(['first', 'secret', 'last']);
    expect(restored.mcpServers.secret?.env?.TOKEN).toBe('LITERAL-SECRET');

    await expect(restoreMcpServer({ agentDir, record: removal.removed }))
      .rejects.toMatchObject({ code: 'stale-revision' });
  });
});
