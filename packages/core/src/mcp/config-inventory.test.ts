import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectTrustManager } from '../security/project-trust.js';
import {
  inspectMcpConfig,
  MCP_CONFIG_MAX_BYTES,
  MCP_CONFIG_MAX_SERVERS,
} from './config-inventory.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ root: string; agentDir: string; project: string; trustManager: ProjectTrustManager }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-inventory-'));
  temporaryDirectories.push(root);
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'project');
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(path.join(project, '.ai-harness'), { recursive: true }),
  ]);
  const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
  await trustManager.load();
  return { root, agentDir, project, trustManager };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('inspectMcpConfig', () => {
  it('reads JSONC files only, validates entries, masks literals, and reports shadowing', async () => {
    const { agentDir, project, trustManager } = await fixture();
    await writeFile(path.join(agentDir, 'mcp.json'), `{
      // JSONC comments and trailing commas are accepted.
      "version": 1,
      "mcpServers": {
        "shared": {
          "type": "streamable-http",
          "url": "https://user:password@example.test/private/token-value?api_key=literal-secret",
          "headers": {
            "Authorization": "Bearer literal-secret",
            "X-Token": "\${HOST_TOKEN}",
          },
          "exposure": "deferred",
        },
        "local": {
          "command": "/usr/local/bin/npx",
          "args": ["-y", "@scope/server", "--api-key=literal-secret", "\${SAFE_ARG}"],
          "env": { "TOKEN": "!secret-command", "HOME_REF": "$HOME" },
        },
      },
    }`);
    await writeFile(path.join(project, '.ai-harness', 'mcp.json'), JSON.stringify({
      version: 1,
      mcpServers: {
        shared: { url: 'https://project.example.test/mcp', enabled: false },
      },
    }));
    await trustManager.trust(project);

    const inventory = await inspectMcpConfig({ agentDir, cwd: project, trustManager });
    expect(inventory.project).toMatchObject({ contentTrusted: true, decision: true, inherited: false });
    expect(inventory.files).toEqual([
      expect.objectContaining({ scope: 'global', exists: true, contentRead: true, problems: [] }),
      expect.objectContaining({ scope: 'project', exists: true, contentRead: true, problems: [] }),
    ]);
    expect(inventory.servers).toHaveLength(3);
    expect(inventory.servers[0]).toMatchObject({
      name: 'shared', scope: 'global', valid: true, transport: 'http', exposure: 'deferred',
      url: 'https://example.test/•••?•••', masked: true, shadowedByProject: true,
      headerNames: ['Authorization', 'X-Token'],
      variableReferences: [{ field: 'headers.X-Token', names: ['HOST_TOKEN'] }],
    });
    expect(inventory.servers[1]).toMatchObject({
      name: 'local', command: 'npx', args: ['-y', '•••', '--api-key=•••', '${SAFE_ARG}'],
      commandFields: ['env.TOKEN'],
      variableReferences: [{ field: 'env.HOME_REF', names: ['HOME'] }],
    });
    expect(inventory.servers[2]).toMatchObject({
      name: 'shared', scope: 'project', enabled: false, replacesGlobal: true,
    });
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain('literal-secret');
    expect(serialized).not.toContain('secret-command');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('/usr/local/bin');
  });

  it('lists invalid entries with value-free strict-schema diagnostics and escaped hidden names', async () => {
    const { agentDir } = await fixture();
    const unknownLiteral = 'UNKNOWN-FIELD-LITERAL-MUST-NOT-LEAK';
    const headerLiteral = 'HEADER-LITERAL-MUST-NOT-LEAK';
    await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
      version: 1,
      mcpServers: {
        'bad\u202ename': {
          url: 'ftp://example.test/secret-path',
          headers: { Authorization: headerLiteral },
          enabled: 'yes',
          unsupported: unknownLiteral,
        },
        scalar: unknownLiteral,
      },
    }));

    const inventory = await inspectMcpConfig({ agentDir });
    expect(inventory.servers).toHaveLength(2);
    expect(inventory.servers[0]).toMatchObject({
      name: 'bad\\u202ename', valid: false, url: '[invalid URL]', headerNames: ['Authorization'],
    });
    expect(inventory.servers[0].problems).toEqual(expect.arrayContaining([
      'The server name is empty, too long, or contains hidden characters.',
      'The server entry contains unsupported properties.',
      'The URL must be a bounded HTTP or HTTPS URL.',
      'Enabled must be a boolean.',
    ]));
    expect(inventory.servers[1]).toMatchObject({ valid: false, problems: expect.any(Array) });
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain(unknownLiteral);
    expect(serialized).not.toContain(headerLiteral);
    expect(serialized).not.toContain('\u202e');
  });

  it('never reads project configuration content without an effective saved allow', async () => {
    const { root, agentDir, project, trustManager } = await fixture();
    const marker = path.join(root, 'must-not-exist');
    const secret = 'PROJECT-CONTENT-MUST-NOT-LEAK';
    await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: { global: { command: 'safe-global' } },
    }));
    await writeFile(path.join(project, '.ai-harness', 'mcp.json'), JSON.stringify({
      mcpServers: {
        [secret]: { command: 'sh', env: { RUN: `!touch ${marker}` } },
      },
    }));

    const inventory = await inspectMcpConfig({ agentDir, cwd: project, trustManager });
    expect(inventory.project).toMatchObject({ contentTrusted: false, decision: null });
    expect(inventory.servers.map(server => server.name)).toEqual(['global']);
    expect(inventory.files[1]).toMatchObject({
      scope: 'project', exists: true, contentRead: false,
      problems: [{ reason: 'trust-required' }],
    });
    expect(JSON.stringify(inventory)).not.toContain(secret);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });

    await trustManager.refuse(project);
    const refused = await inspectMcpConfig({ agentDir, cwd: project, trustManager });
    expect(refused.project).toMatchObject({ contentTrusted: false, decision: false });
    expect(refused.files[1].contentRead).toBe(false);
  });

  it('refuses links and non-regular files instead of following or blocking on them', async () => {
    const { root, agentDir, project, trustManager } = await fixture();
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, JSON.stringify({ mcpServers: { leaked: { command: 'outside-secret' } } }));
    await trustManager.trust(project);
    await symlink(outside, path.join(project, '.ai-harness', 'mcp.json'));

    const linkedFile = await inspectMcpConfig({ agentDir, cwd: project, trustManager });
    expect(linkedFile.files[1]).toMatchObject({
      exists: true, contentRead: false, problems: [{ reason: 'unsafe-link' }],
    });
    expect(JSON.stringify(linkedFile)).not.toContain('outside-secret');

    await rm(path.join(project, '.ai-harness'), { recursive: true });
    await symlink(root, path.join(project, '.ai-harness'));
    const linkedDirectory = await inspectMcpConfig({ agentDir, cwd: project, trustManager });
    expect(linkedDirectory.files[1]).toMatchObject({
      exists: false, contentRead: false, problems: [{ reason: 'unsafe-link' }],
    });
  });

  it('bounds bytes, nesting, server counts, and syntax diagnostics without quoting source', async () => {
    const { agentDir, project, trustManager } = await fixture();
    await writeFile(path.join(agentDir, 'mcp.json'), 'x'.repeat(MCP_CONFIG_MAX_BYTES + 1));
    let inventory = await inspectMcpConfig({ agentDir });
    expect(inventory.files[0]).toMatchObject({ contentRead: false, problems: [{ reason: 'too-large' }] });

    const secret = 'SYNTAX-SECRET-SHOULD-NOT-BE-QUOTED';
    await writeFile(path.join(agentDir, 'mcp.json'), `{"mcpServers":{"${secret}":`);
    inventory = await inspectMcpConfig({ agentDir });
    expect(inventory.files[0]).toMatchObject({ contentRead: true, problems: [{ reason: 'invalid-syntax' }] });
    expect(JSON.stringify(inventory)).not.toContain(secret);

    await trustManager.trust(project);
    const deep = `${'{"nested":'.repeat(70)}null${'}'.repeat(70)}`;
    await writeFile(path.join(project, '.ai-harness', 'mcp.json'), `{"mcpServers":{},"extra":${deep}}`);
    inventory = await inspectMcpConfig({ agentDir, cwd: project, trustManager });
    expect(inventory.files[1].problems).toEqual([expect.objectContaining({ reason: 'too-deep' })]);

    const servers = Object.fromEntries(Array.from({ length: MCP_CONFIG_MAX_SERVERS + 1 }, (_, index) => [
      `server-${index}`, { command: 'node' },
    ]));
    await writeFile(path.join(project, '.ai-harness', 'mcp.json'), JSON.stringify({ mcpServers: servers }));
    inventory = await inspectMcpConfig({ agentDir, cwd: project, trustManager });
    expect(inventory.files[1].problems).toEqual([expect.objectContaining({ reason: 'too-many-servers' })]);
    expect(inventory.servers).toEqual([]);
  });
});
