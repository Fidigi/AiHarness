import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectTrustManager } from '../security/project-trust.js';
import {
  inspectMcpConfig,
  McpServerTargetError,
  readMcpServerTestTarget,
  type McpServerTestTarget,
} from './config-inventory.js';
import {
  connectMcpServerForTest,
  McpServerTester,
  mcpTestRunsCommand,
  type McpServerTestConnect,
} from './server-test.js';

const fixturePath = fileURLToPath(new URL('./fixtures/test-server.mjs', import.meta.url));
const roots: string[] = [];

async function workspace(): Promise<{
  root: string;
  agentDir: string;
  project: string;
  trust: ProjectTrustManager;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-mcp-test-'));
  roots.push(root);
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'project');
  await Promise.all([mkdir(agentDir), mkdir(project)]);
  const trust = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
  await trust.load();
  return { root, agentDir, project, trust };
}

async function writeConfig(agentDir: string, servers: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ version: 1, mcpServers: servers }));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('MCP server connection tests', () => {
  it('reads a fresh target, lists stdio capabilities, masks output, and retains status only for the matching entry', async () => {
    const { agentDir, project, trust } = await workspace();
    const secret = 'xy';
    await writeConfig(agentDir, {
      fixture: {
        command: process.execPath,
        args: [fixturePath],
        env: { MCP_TEST_SECRET: secret },
        exposure: 'deferred',
        enabled: false,
      },
    });
    const target = await readMcpServerTestTarget({
      agentDir,
      scope: 'global',
      name: 'fixture',
      defaultCwd: project,
      trustManager: trust,
    });
    const tester = new McpServerTester();
    const result = await tester.test(target);

    expect(result).toMatchObject({
      state: 'connected',
      toolCount: 2,
      resources: 1,
      resourceTemplates: 1,
      prompts: 1,
      cwd: project,
      serverInfo: { name: 'ai-harness-test-server', version: '1.0.0', title: '•••' },
    });
    expect(result.tools).toEqual([
      { name: 'lookup', description: 'Looks up •••', readOnly: true, exposure: 'deferred' },
      { name: 'mutate', description: 'Changes fixture state', readOnly: false, exposure: 'deferred' },
    ]);
    expect(result.stderr).toBe('fixture ready •••');
    expect(JSON.stringify(result)).not.toContain(secret);

    let inventory = tester.decorateInventory(await inspectMcpConfig({ agentDir }));
    expect(inventory.servers[0]?.testStatus).toEqual(result);
    await writeConfig(agentDir, {
      fixture: { command: process.execPath, args: [fixturePath, '--changed'] },
    });
    inventory = tester.decorateInventory(await inspectMcpConfig({ agentDir }));
    expect(inventory.servers[0]?.testStatus).toBeUndefined();
    await writeConfig(agentDir, {
      fixture: {
        command: process.execPath,
        args: [fixturePath],
        env: { MCP_TEST_SECRET: secret },
        exposure: 'deferred',
        enabled: false,
      },
    });
    inventory = tester.decorateInventory(await inspectMcpConfig({ agentDir }));
    expect(inventory.servers[0]?.testStatus).toBeUndefined();
    await tester.shutdown();
  });

  it('redacts substituted host fragments and refuses reserved child environment names', async () => {
    const { project } = await workspace();
    const previous = process.env.MCP_TEST_HOST_SECRET;
    process.env.MCP_TEST_HOST_SECRET = 'qz';
    const base: McpServerTestTarget = {
      scope: 'global',
      name: 'fragment',
      sourcePath: '/agent/mcp.json',
      configKey: 'f'.repeat(64),
      config: {
        command: process.execPath,
        args: [fixturePath],
        env: { MCP_TEST_SECRET: 'prefix:$MCP_TEST_HOST_SECRET:suffix' },
      },
      cwd: project,
    };
    try {
      const result = await connectMcpServerForTest(base, new AbortController().signal, {
        requestTimeoutMs: 2_000,
        closeWaitMs: 500,
      });
      expect(result).toMatchObject({ state: 'connected', stderr: 'fixture ready •••' });
      expect(result.tools[0]).toMatchObject({ description: 'Looks up •••' });
      expect(JSON.stringify(result)).not.toContain('qz');

      const reserved = await connectMcpServerForTest({
        ...base,
        name: 'reserved',
        configKey: 'r'.repeat(64),
        config: {
          command: process.execPath,
          args: [fixturePath],
          env: { AI_HARNESS_AUTH_TOKEN: 'literal-reserved-value' },
        },
      }, new AbortController().signal, { requestTimeoutMs: 2_000, closeWaitMs: 500 });
      expect(reserved).toMatchObject({ state: 'failed', error: expect.stringContaining('reserved environment name') });
      expect(JSON.stringify(reserved)).not.toContain('literal-reserved-value');
    } finally {
      if (previous === undefined) delete process.env.MCP_TEST_HOST_SECRET;
      else process.env.MCP_TEST_HOST_SECRET = previous;
    }
  });

  it('requires persisted trust for a selected global cwd and every project working directory', async () => {
    const { agentDir, project, trust } = await workspace();
    const sibling = path.join(path.dirname(project), 'sibling');
    await Promise.all([
      mkdir(path.join(project, '.ai-harness')),
      mkdir(sibling),
      writeConfig(agentDir, { global: { command: process.execPath, args: [fixturePath] } }),
    ]);
    await writeFile(path.join(project, '.ai-harness', 'mcp.json'), JSON.stringify({
      mcpServers: { local: { command: process.execPath, args: [fixturePath], cwd: sibling } },
    }));
    const resolveWorkingDirectory = async (configured: string, base: string) => path.resolve(base, configured);
    await expect(readMcpServerTestTarget({
      agentDir,
      scope: 'global',
      name: 'global',
      cwd: project,
      defaultCwd: project,
      trustManager: trust,
      resolveWorkingDirectory,
    })).rejects.toMatchObject<Partial<McpServerTargetError>>({ code: 'trust-required' });
    const options = {
      agentDir,
      scope: 'project' as const,
      name: 'local',
      cwd: project,
      defaultCwd: project,
      trustManager: trust,
      resolveWorkingDirectory,
    };
    await expect(readMcpServerTestTarget(options)).rejects.toMatchObject<Partial<McpServerTargetError>>({
      code: 'trust-required',
    });
    await trust.setDecision(project, true);
    await expect(readMcpServerTestTarget({
      agentDir,
      scope: 'global',
      name: 'global',
      cwd: project,
      defaultCwd: project,
      trustManager: trust,
      resolveWorkingDirectory,
    })).resolves.toMatchObject({ cwd: project });
    await expect(readMcpServerTestTarget(options)).rejects.toMatchObject<Partial<McpServerTargetError>>({
      code: 'trust-required',
    });
    await trust.setDecision(sibling, true);
    await expect(readMcpServerTestTarget(options)).resolves.toMatchObject({ cwd: sibling });
  });

  it('reports an HTTP authentication challenge without resolving OAuth values or starting OAuth', async () => {
    const { root, project } = await workspace();
    const marker = path.join(root, 'oauth-command-ran');
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      });
      response.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind.');
      const target: McpServerTestTarget = {
        scope: 'global',
        name: 'auth',
        sourcePath: '/agent/mcp.json',
        configKey: 'a'.repeat(64),
        config: {
          url: `http://127.0.0.1:${address.port}/mcp`,
          oauth: { clientSecret: `!touch ${marker}` },
        },
        cwd: project,
      };
      expect(mcpTestRunsCommand(target.config)).toBe(false);
      const result = await connectMcpServerForTest(target, new AbortController().signal, {
        requestTimeoutMs: 1_000,
        closeWaitMs: 100,
      });
      expect(result).toMatchObject({ state: 'needs-auth', tools: [], toolCount: 0 });
      expect(result.error).toBeUndefined();
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('retains a bounded status when a command-backed test times out in the queue', async () => {
    const { agentDir, project, trust } = await workspace();
    await writeConfig(agentDir, {
      first: { command: 'server', env: { TOKEN: '!read first' } },
      second: { command: 'server', env: { TOKEN: '!read second' } },
    });
    const target = (name: string) => readMcpServerTestTarget({
      agentDir,
      scope: 'global',
      name,
      defaultCwd: project,
      trustManager: trust,
    });
    const [firstTarget, secondTarget] = await Promise.all([target('first'), target('second')]);
    const tester = new McpServerTester({
      deadlineMs: 10,
      closeWaitMs: 5,
      connect: async () => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return {
          state: 'connected', durationMs: 40,
          tools: [], toolCount: 0, resources: 0, resourceTemplates: 0, prompts: 0,
        };
      },
    });
    const first = tester.test(firstTarget);
    const queued = await tester.test(secondTarget);
    expect(queued).toMatchObject({ state: 'failed', queueTimedOut: true });
    const inventory = tester.decorateInventory(await inspectMcpConfig({ agentDir }));
    expect(inventory.servers.find(server => server.name === 'second')?.testStatus)
      .toMatchObject({ queueTimedOut: true });
    await expect(first).resolves.toMatchObject({ state: 'failed', timedOut: true });
    await tester.shutdown();
  });

  it('serializes command-backed tests, joins identical runs, and bounds an uncooperative connector', async () => {
    const events: string[] = [];
    const connect: McpServerTestConnect = async (target, signal) => {
      events.push(`start:${target.name}`);
      await Promise.race([
        new Promise(resolve => setTimeout(resolve, 50)),
        new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })),
      ]);
      events.push(`end:${target.name}`);
      return {
        state: signal.aborted ? 'failed' : 'connected',
        durationMs: 50,
        tools: [], toolCount: 0, resources: 0, resourceTemplates: 0, prompts: 0,
        ...(signal.aborted ? { timedOut: true as const } : {}),
      };
    };
    const commandTarget = (name: string): McpServerTestTarget => ({
      scope: 'global', name, sourcePath: '/agent/mcp.json', configKey: name.padEnd(64, '0'),
      config: { command: 'server', env: { TOKEN: '!read token' } }, cwd: '/workspace',
    });
    expect(mcpTestRunsCommand(commandTarget('a').config)).toBe(true);
    const tester = new McpServerTester({ connect, deadlineMs: 500, closeWaitMs: 20 });
    const first = tester.test(commandTarget('a'));
    const joined = tester.test(commandTarget('a'));
    expect(joined).toBe(first);
    await Promise.all([first, joined, tester.test(commandTarget('b'))]);
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);

    const cancelledController = new AbortController();
    const survivingController = new AbortController();
    const cancelled = tester.test(commandTarget('c'), cancelledController.signal);
    const surviving = tester.test(commandTarget('c'), survivingController.signal);
    const cancelledExpectation = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    cancelledController.abort();
    await cancelledExpectation;
    await expect(surviving).resolves.toMatchObject({ state: 'connected' });
    expect(events.slice(-2)).toEqual(['start:c', 'end:c']);

    await expect(tester.test(commandTarget('changed'), undefined, async () => {
      throw new McpServerTargetError('server-invalid', 'changed');
    })).rejects.toMatchObject({ code: 'server-invalid' });
    expect(events).not.toContain('start:changed');
    await expect(tester.test(commandTarget('after-change'))).resolves.toMatchObject({ state: 'connected' });
    expect(events.slice(-2)).toEqual(['start:after-change', 'end:after-change']);
    await tester.shutdown();

    const hanging = new McpServerTester({
      connect: () => new Promise(() => undefined),
      deadlineMs: 25,
      closeWaitMs: 20,
    });
    const started = Date.now();
    await expect(hanging.test({
      scope: 'global', name: 'hang', sourcePath: '/agent/mcp.json', configKey: 'h'.repeat(64),
      config: { command: 'server' }, cwd: '/workspace',
    })).resolves.toMatchObject({ state: 'failed', timedOut: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    await hanging.shutdown();
  });
});
