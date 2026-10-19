import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectTrustManager } from '../security/project-trust.js';
import { SessionManager } from '../sessions/session-manager.js';
import {
  inspectMcpConfig, mcpToolExposure, readMcpServerTestTarget, removeMcpServer,
  restoreMcpServer, setMcpServerExposure, setMcpServersEnabled,
} from './config-inventory.js';
import { McpSessionHost } from './session-host.js';

const roots: string[] = [];
const peer = fileURLToPath(new URL('./fixtures/test-server.mjs', import.meta.url));
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-inheritance-'));
  roots.push(root);
  const agentDir = path.join(root, 'agent'), project = path.join(root, 'project');
  await mkdir(agentDir); await mkdir(path.join(project, '.ai-harness'), { recursive: true });
  const globalFile = path.join(agentDir, 'mcp.json'), projectFile = path.join(project, '.ai-harness/mcp.json');
  const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
  await trustManager.load(); await trustManager.trust(project);
  const options = { agentDir, cwd: project, trustManager };
  const writeGlobal = (servers: Record<string, unknown>) => writeFile(globalFile, JSON.stringify({ version: 1, mcpServers: servers }));
  const writeProject = (servers: Record<string, unknown>) => writeFile(projectFile, JSON.stringify({ version: 1, mcpServers: servers }));
  const inspect = () => inspectMcpConfig(options);
  const target = () => readMcpServerTestTarget({ ...options, scope: 'project', name: 'shared', defaultCwd: project });
  const revision = async () => {
    const file = (await inspect()).files.find(value => value.scope === 'project');
    if (!file?.revision) throw new Error('Native project revision is unavailable.');
    return file.revision;
  };
  return { root, ...options, globalFile, projectFile, writeGlobal, writeProject, inspect, target, revision };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('native targetless project MCP overrides', () => {
  it('inherits only three controls while retaining private global HTTP configuration and passive bytes', async () => {
    const f = await fixture();
    const base = { url: 'https://user:PRIVATE-PASSWORD@example.test/PRIVATE-PATH',
      headers: { Authorization: 'Bearer PRIVATE-HEADER' },
      oauth: { clientId: 'native-client', clientSecret: '!PRIVATE-COMMAND' },
      description: 'global description', enabled: false, exposure: 'deferred',
      toolExposure: { 'get_*': 'codemode', get_one: 'hidden' } };
    const override = { enabled: true, exposure: 'direct' };
    await f.writeGlobal({ shared: base }); await f.writeProject({ shared: override });
    const before = await Promise.all([readFile(f.globalFile), readFile(f.projectFile)]);
    const inventory = await f.inspect(), project = inventory.servers.find(server => server.scope === 'project');
    expect(project).toMatchObject({ valid: true, enabled: true, exposure: 'direct', inheritsGlobal: true,
      transport: 'http', replacesGlobal: true, headerNames: ['Authorization'], problems: [],
      toolExposure: base.toolExposure, commandFields: ['oauth.clientSecret'] });
    expect(inventory.servers.find(server => server.scope === 'global')).toMatchObject({ shadowedByProject: true });
    const target = await f.target();
    expect(target.config).toEqual({ ...base, ...override });
    expect(target.configKey).toBe(project?.configKey); expect(target.sourcePath).toBe(f.projectFile);
    for (const secret of ['PRIVATE-PASSWORD', 'PRIVATE-PATH', 'PRIVATE-HEADER', 'PRIVATE-COMMAND']) {
      expect(JSON.stringify(inventory)).not.toContain(secret);
    }
    expect(await readFile(f.globalFile)).toEqual(before[0]); expect(await readFile(f.projectFile)).toEqual(before[1]);
  });

  it.each(['env', 'headers', 'oauth', 'args', 'cwd', 'description', 'unknown'])('rejects targetless %s rather than changing global authority', async field => {
    const f = await fixture();
    await f.writeGlobal({ shared: { command: 'node', env: { TOKEN: 'PRIVATE-GLOBAL' } } });
    await f.writeProject({ shared: { enabled: true, [field]: 'PRIVATE-PROJECT' } });
    const inventory = await f.inspect(), project = inventory.servers.find(server => server.scope === 'project');
    expect(project).toMatchObject({ valid: false, problemReasons: expect.arrayContaining(['override-fields']) });
    expect(inventory.servers.find(server => server.scope === 'global')).toMatchObject({ shadowedByProject: false });
    await expect(f.target()).rejects.toMatchObject({ code: 'server-invalid' });
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE-GLOBAL');
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE-PROJECT');
  });

  it.each(['missing', 'invalid', 'syntax', 'linked'])('reports value-free orphan diagnostics for a %s global base', async kind => {
    const f = await fixture();
    if (kind === 'invalid') await f.writeGlobal({ shared: { url: 'ftp://PRIVATE-GLOBAL' } });
    if (kind === 'syntax') await writeFile(f.globalFile, '{"PRIVATE-GLOBAL":');
    if (kind === 'linked') {
      const outside = path.join(f.root, 'outside.json');
      await writeFile(outside, JSON.stringify({ mcpServers: { shared: { command: 'PRIVATE-GLOBAL' } } }));
      await symlink(outside, f.globalFile);
    }
    await f.writeProject({ shared: { enabled: false } });
    const inventory = await f.inspect();
    expect(inventory.servers.find(server => server.scope === 'project')).toMatchObject({
      valid: false, problemReasons: expect.arrayContaining(['orphan-override']),
    });
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE-GLOBAL');
    await expect(f.target()).rejects.toMatchObject({ code: 'server-invalid' });
  });

  it.each([{ type: 'stdio' }, { command: null }, { url: null }])('does not reinterpret explicit target/transport intent as an override: %j', async entry => {
    const f = await fixture(); await f.writeGlobal({ shared: { command: 'node' } });
    await f.writeProject({ shared: entry });
    expect((await f.inspect()).servers.find(server => server.scope === 'project')).toMatchObject({ valid: false });
    await expect(f.target()).rejects.toMatchObject({ code: 'server-invalid' });
  });

  it('keeps global targetless entries invalid and full project targets independent', async () => {
    const f = await fixture();
    await f.writeGlobal({ shared: { enabled: false }, another: { command: 'node' } });
    await f.writeProject({ shared: { url: 'https://project.example.test', exposure: 'hidden' } });
    const inventory = await f.inspect();
    expect(inventory.servers.find(server => server.scope === 'global' && server.name === 'shared')).toMatchObject({ valid: false });
    expect((await f.target()).config).toEqual({ url: 'https://project.example.test', exposure: 'hidden' });
    expect(inventory.servers.find(server => server.scope === 'project')).not.toHaveProperty('inheritsGlobal');
  });

  it('pins both parsed source generations even when their current effective controls coincide', async () => {
    const f = await fixture();
    await f.writeGlobal({ shared: { command: 'node', enabled: false, exposure: 'hidden' } });
    await f.writeProject({ shared: { enabled: true, exposure: 'direct' } });
    const first = await f.target();
    await f.writeGlobal({ shared: { command: 'node', enabled: true, exposure: 'codemode' } });
    const second = await f.target();
    await f.writeProject({ shared: { exposure: 'direct' } });
    const third = await f.target();
    expect(first.config).toEqual(second.config); expect(second.config).toEqual(third.config);
    expect(new Set([first.configKey, second.configKey, third.configKey]).size).toBe(3);
    expect(third.configKey).toBe((await f.inspect()).servers.find(server => server.scope === 'project')?.configKey);
  });

  it('revalidates the current global base for raw override undo without flattening its secret values', async () => {
    const f = await fixture();
    await f.writeGlobal({ shared: { command: 'node', env: { TOKEN: 'PRIVATE-GLOBAL' } } });
    await f.writeProject({ shared: { enabled: false } });
    const removed = await removeMcpServer({ ...f, scope: 'project', expectedRevision: await f.revision(), name: 'shared' });
    const bytes = await readFile(f.projectFile);
    await f.writeGlobal({});
    await expect(restoreMcpServer({ agentDir: f.agentDir, trustManager: f.trustManager, record: removed.removed }))
      .rejects.toMatchObject({ code: 'target-invalid' });
    expect(await readFile(f.projectFile)).toEqual(bytes);
    await f.writeGlobal({ shared: { command: 'node', env: { TOKEN: 'PRIVATE-GLOBAL' } } });
    await restoreMcpServer({ agentDir: f.agentDir, trustManager: f.trustManager, record: removed.removed });
    expect(JSON.parse(await readFile(f.projectFile, 'utf8'))).toEqual({ version: 1, mcpServers: { shared: { enabled: false } } });
  });

  it('rekeys inherited generations on global changes and refuses removal of the base without stale runtime reuse', async () => {
    const f = await fixture(); await f.writeGlobal({ shared: { command: 'node', env: { TOKEN: 'FIRST-PRIVATE' } } });
    await f.writeProject({ shared: {} });
    const first = await f.target();
    await f.writeGlobal({ shared: { command: 'node', env: { TOKEN: 'SECOND-PRIVATE' } } });
    const second = await f.target(); expect(second.configKey).not.toBe(first.configKey);
    expect(second.config).toMatchObject({ env: { TOKEN: 'SECOND-PRIVATE' } });
    expect(second.configKey).toBe((await f.inspect()).servers.find(server => server.scope === 'project')?.configKey);
    await f.writeGlobal({}); await expect(f.target()).rejects.toMatchObject({ code: 'server-invalid' });
    expect((await f.inspect()).servers.find(server => server.scope === 'project')).toMatchObject({ valid: false });
  });

  it('requires fresh persisted trust for reads and writes, without exposing a refused project body', async () => {
    const f = await fixture(); await f.writeGlobal({ shared: { command: 'node' } });
    await f.writeProject({ shared: { exposure: 'hidden' } }); const expectedRevision = await f.revision();
    await f.trustManager.refuse(f.cwd);
    const inventory = await f.inspect();
    expect(inventory.files.find(file => file.scope === 'project')).toMatchObject({ contentRead: false });
    expect(inventory.servers.every(server => server.scope === 'global' && !server.shadowedByProject)).toBe(true);
    await expect(f.target()).rejects.toMatchObject({ code: 'trust-required' });
    await expect(setMcpServerExposure({ ...f, scope: 'project', name: 'shared', expectedRevision, exposure: 'direct' }))
      .rejects.toMatchObject({ code: 'trust-required' });
    expect(JSON.parse(await readFile(f.projectFile, 'utf8'))).toEqual({ version: 1, mcpServers: { shared: { exposure: 'hidden' } } });
  });

  it('writes explicit inherited defaults atomically without copying credentials or targets into the project', async () => {
    const f = await fixture();
    await f.writeGlobal({ shared: { command: 'node', enabled: false, exposure: 'deferred', env: { TOKEN: 'PRIVATE-GLOBAL' } } });
    await f.writeProject({ shared: {} }); await chmod(f.projectFile, 0o640);
    const globalBytes = await readFile(f.globalFile);
    const enabled = await setMcpServersEnabled({ ...f, scope: 'project', expectedRevision: await f.revision(), names: ['shared'], enabled: true });
    expect(enabled).toMatchObject({ changed: true, outcomes: [{ name: 'shared', status: 'changed' }] });
    const direct = await setMcpServerExposure({ ...f, scope: 'project', expectedRevision: enabled.revision, name: 'shared', exposure: 'direct' });
    expect(direct.changed).toBe(true);
    const projectBytes = await readFile(f.projectFile, 'utf8');
    expect(JSON.parse(projectBytes)).toEqual({ version: 1, mcpServers: { shared: { enabled: true, exposure: 'direct' } } });
    expect((await lstat(f.projectFile)).mode & 0o777).toBe(0o640);
    expect((await lstat(f.projectFile)).nlink).toBe(1);
    expect(await readFile(f.globalFile)).toEqual(globalBytes);
    const unchanged = await setMcpServerExposure({ ...f, scope: 'project', expectedRevision: direct.revision, name: 'shared', exposure: 'direct' });
    expect(unchanged.changed).toBe(false); expect(await readFile(f.projectFile, 'utf8')).toBe(projectBytes);
    const removed = await removeMcpServer({ ...f, scope: 'project', expectedRevision: unchanged.revision, name: 'shared' });
    await restoreMcpServer({ agentDir: f.agentDir, trustManager: f.trustManager, record: removed.removed });
    expect(JSON.parse(await readFile(f.projectFile, 'utf8'))).toEqual(JSON.parse(projectBytes));
    await expect(setMcpServersEnabled({ ...f, scope: 'project', expectedRevision: enabled.revision, names: ['shared'], enabled: false }))
      .rejects.toMatchObject({ code: 'stale-revision' });
    expect(await readFile(f.globalFile)).toEqual(globalBytes);
  });

  it('keeps exact/ordered exposure semantics and writes one effective inherited tool map without secret flattening', async () => {
    const f = await fixture();
    const toolExposure = { get_exact: 'hidden', 'get_*': 'codemode', '*': 'deferred' };
    await f.writeGlobal({ shared: { command: 'node', toolExposure, env: { TOKEN: 'PRIVATE-GLOBAL' } } });
    await f.writeProject({ shared: {} });
    const target = await f.target();
    expect(mcpToolExposure(target.config, 'get_exact')).toBe('hidden');
    expect(mcpToolExposure(target.config, 'get_other')).toBe('codemode');
    expect(mcpToolExposure(target.config, 'other')).toBe('deferred');
    await setMcpServerExposure({ ...f, scope: 'project', expectedRevision: await f.revision(), name: 'shared', tool: 'get_new', exposure: 'direct' });
    expect(JSON.parse(await readFile(f.projectFile, 'utf8'))).toEqual({ version: 1, mcpServers: {
      shared: { toolExposure: { ...toolExposure, get_new: 'direct' } },
    } });
    await f.writeProject({ shared: { toolExposure: {} } });
    expect(mcpToolExposure((await f.target()).config, 'get_exact')).toBe('direct');
  });

  it('uses the real stdio host and inherited secret redaction while preserving read-only/hidden and disable boundaries', async () => {
    const f = await fixture(), calls = path.join(f.root, 'calls.jsonl');
    await f.writeGlobal({ shared: { command: process.execPath, args: [peer], exposure: 'deferred',
      env: { MCP_TEST_SECRET: 'PRIVATE-INHERITED', MCP_TEST_CALL_LOG: calls } } });
    await f.writeProject({ shared: { exposure: 'hidden', toolExposure: { lookup: 'direct', mutate: 'direct' } } });
    const host = new McpSessionHost({ agentDir: f.agentDir, trustManager: f.trustManager, startupWaitMs: 2_000, requestTimeoutMs: 2_000, closeWaitMs: 500 });
    const context = { sessionManager: new SessionManager(), notify: () => undefined };
    try {
      const prepared = await host.prepareForPrompt({ sessionId: 'inherited', cwd: f.cwd, preset: 'read-only' });
      expect(prepared.tools.map(tool => tool.mcp)).toEqual([{ scope: 'project', server: 'shared', tool: 'lookup' }]);
      const lookup = prepared.tools[0]; if (!lookup) throw new Error('Native inherited tool is unavailable.');
      const result = await prepared.execute(lookup.name, { topic: 'safe' }, context);
      expect(result.content).toContain('lookup:'); expect(result.content).not.toContain('PRIVATE-INHERITED');
      expect(await readFile(calls, 'utf8')).toBe('"lookup"\n');
      await f.writeProject({ shared: { enabled: false } });
      expect((await host.prepareForPrompt({ sessionId: 'inherited', cwd: f.cwd })).tools).toEqual([]);
      await expect(prepared.execute(lookup.name, {}, context)).rejects.toThrow();
      expect(await readFile(calls, 'utf8')).toBe('"lookup"\n');
    } finally { await host.shutdown(); }
  });
});
