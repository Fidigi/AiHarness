import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeProviderNetworkDispatchers, McpSessionHost, ProjectTrustManager, SessionManager } from '@ai-harness/core';

const mode = process.argv[2];
const scope = 'project';
assert.ok(['command', 'core', 'print', 'json', 'rpc'].includes(mode));
assert.ok(['global', 'project'].includes(scope));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-inheritance-public-'));
const cwd = path.join(root, 'workspace'), agent = path.join(root, 'agent'), log = path.join(root, 'calls.jsonl');
await mkdir(agent); await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
const trust = new ProjectTrustManager(path.join(agent, 'trust.json')); await trust.load(); await trust.setDecision(cwd, true);
const fixture = process.env.AIH_MCP_INHERITANCE_SERVER || fileURLToPath(new URL('../../../../core/src/mcp/fixtures/test-server.mjs', import.meta.url));
const configPath = path.join(cwd, '.ai-harness', 'mcp.json');
const globalPath = path.join(agent, 'mcp.json');
const globalBytes = JSON.stringify({ version: 1, mcpServers: { fixture: {
  command: process.execPath, args: [fixture], enabled: false, exposure: 'hidden',
  env: { MCP_TEST_CALL_LOG: log, INHERITED_SECRET: 'DISPOSABLE-GLOBAL-INHERITANCE-SECRET' },
  toolExposure: { '*': 'hidden' },
} } });
const save = toolExposure => writeFile(configPath, JSON.stringify({ version: 1, mcpServers: { fixture: {
  enabled: true, exposure: 'direct', toolExposure,
} } }));
const calls = async () => {
  try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const tool = 'mcp__fixture__lookup';
let child, host, server, fixtureError;
const declarations = [], allDeclarations = [];
async function cli(args, rpc = false) {
  child = spawn(process.env.AIH_MCP_INHERITANCE_COMMAND || process.execPath, process.env.AIH_MCP_INHERITANCE_COMMAND
    ? args : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url)), ...args], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, NO_COLOR: '1' },
  });
  let stdout = '', stderr = '', pending = '', protocolError;
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk; if (!rpc) return; pending += chunk;
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
      try { if (JSON.parse(line).type === 'agent_settled') child.stdin.end(); }
      catch (failure) { protocolError = failure; child.stdin.end(); }
    }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  if (rpc) child.stdin.write(JSON.stringify({ type: 'prompt', id: 'p', message: 'Read fixture' }) + '\n');
  else child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 6_000);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(protocolError, undefined); assert.deepEqual(exit, { code: 0, signal: null }, JSON.stringify({ exit, stdout, stderr }));
  assert.equal(stderr, ''); return stdout;
}
try {
  await writeFile(globalPath, globalBytes);
  await save(mode === 'command' ? {} : { '*': 'hidden', lookup: 'direct' });
  if (mode === 'command') {
    const inventory = JSON.parse(await cli(['mcp', 'list', '--scope', scope, '--json']));
    assert.equal(inventory.servers.length, 1);
    assert.equal(inventory.servers[0].inheritsGlobal, true);
    assert.equal(inventory.servers[0].valid, true);
    assert.equal(inventory.servers[0].enabled, true);
    assert.equal(inventory.servers[0].exposure, 'direct');
    assert.equal(JSON.stringify(inventory).includes('DISPOSABLE-GLOBAL-INHERITANCE-SECRET'), false);
    const disable = JSON.parse(await cli(['mcp', 'disable', 'fixture', '--scope', scope, '--json']));
    assert.equal(disable.outcomes[0].status, 'changed');
    const enable = JSON.parse(await cli(['mcp', 'enable', 'fixture', '--scope', scope, '--json']));
    assert.equal(enable.outcomes[0].status, 'changed');
    const change = async (name, exposure) => JSON.parse(await cli(['mcp', 'exposure', 'fixture', exposure, '--tool', name, '--scope', scope, '--json']));
    assert.equal((await change('*', 'hidden')).changed, true);
    assert.equal((await change('lookup', 'direct')).changed, true);
    const persisted = JSON.parse(await readFile(configPath, 'utf8')).mcpServers.fixture.toolExposure;
    assert.deepEqual(Object.keys(persisted), ['*', 'lookup']); assert.deepEqual(persisted, { '*': 'hidden', lookup: 'direct' });
    const result = JSON.parse(await cli(['mcp', 'test', 'fixture', '--scope', scope, '--json'])).result;
    assert.equal(result.state, 'connected');
    assert.deepEqual(result.tools.map(entry => [entry.name, entry.exposure]), [['lookup', 'direct'], ['mutate', 'hidden']]);
    assert.deepEqual(await calls(), []);
  } else if (mode === 'core') {
    host = new McpSessionHost({ agentDir: agent, trustManager: trust, startupWaitMs: 2_000, requestTimeoutMs: 2_000, closeWaitMs: 500 });
    const context = { sessionManager: new SessionManager(), notify() {} };
    const prepared = await host.prepareForPrompt({ sessionId: 'consumer', cwd });
    assert.deepEqual(prepared.tools.map(entry => entry.name), [tool]);
    await assert.rejects(prepared.execute('mcp__fixture__mutate', {}, context), /Unknown or disabled/);
    await prepared.execute(tool, {}, context); assert.deepEqual(await calls(), ['lookup']);
    await save({ 'look*': 'deferred', '*': 'hidden' });
    const next = await host.prepareForPrompt({ sessionId: 'consumer', cwd });
    assert.deepEqual(next.tools, []);
    assert.deepEqual((await next.waitForDiscoverableTools()).map(entry => [entry.name, entry.exposure]), [[tool, 'deferred']]);
    await assert.rejects(prepared.execute(tool, {}, context), /not connected/);
    await next.execute(tool, {}, context); assert.deepEqual(await calls(), ['lookup', 'lookup']);
  } else {
    server = createServer(async (request, response) => {
      try {
        let wire = ''; for await (const chunk of request) { wire += chunk; assert.ok(wire.length < 100_000); }
        const body = JSON.parse(wire); assert.equal(body.stream, true); assert.equal(request.url, '/chat/completions');
        const names = (body.tools ?? []).map(entry => entry.function.name); allDeclarations.push(names);
        declarations.push(names.filter(name => name.startsWith('mcp__')));
        const final = body.messages.some(message => message.role === 'tool');
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ choices: [{ delta: final ? { content: 'Exposure OK' } : {
          tool_calls: [{ index: 0, id: 'lookup-call', type: 'function', function: { name: tool, arguments: '{"topic":"docs"}' } }],
        }, finish_reason: final ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
      } catch (failure) { fixtureError = failure; response.writeHead(500); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const extension = path.join(agent, 'provider.mjs');
    await writeFile(extension, `import { OpenAiProvider } from ${JSON.stringify(import.meta.resolve('@ai-harness/core'))};
      export default api => api.registerProvider('mcp-pattern-fixture', { defaultConfig: { model: 'fixture' },
        create: config => new OpenAiProvider({ ...config, type: 'openai', baseUrl: 'http://127.0.0.1:${server.address().port}', apiKey: 'disposable', model: 'fixture' }) });`);
    const stdout = await cli(['--offline', '--approve', '--no-extensions', '-e', 'builtin:mcp', '-e', extension, '--no-context-files',
      '--model', 'mcp-pattern-fixture/fixture', '--session-dir', path.join(root, 'sessions'), '--session-id', 'mcp-pattern',
      ...(mode === 'print' ? ['-p'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Read fixture'])], mode === 'rpc');
    assert.equal(fixtureError, undefined); assert.deepEqual(await calls(), ['lookup']);
    assert.deepEqual(declarations, [[tool], [tool]], JSON.stringify({ allDeclarations }));
    if (mode === 'print') assert.equal(stdout, 'Exposure OK\n');
    else {
      const records = stdout.trim().split('\n').map(line => JSON.parse(line));
      if (mode === 'json') assert.equal(records[0].version, 3);
      assert.equal(records.filter(record => record.type === 'agent_settled').length, 1);
      assert.equal(records.filter(record => record.type === 'tool_execution_start').length, 1);
      assert.equal(records.filter(record => record.type === 'auto_retry_start').length, 0);
      assert.equal(records.filter(record => record.type === 'message_end' && record.message.role === 'assistant').at(-1).message.stopReason, 'stop');
    }
  }
  assert.equal(await readFile(globalPath, 'utf8'), globalBytes);
  const persisted = JSON.parse(await readFile(configPath, 'utf8')).mcpServers.fixture;
  assert.deepEqual(Object.keys(persisted).sort(), ['enabled', 'exposure', 'toolExposure']);
  assert.equal(JSON.stringify(persisted).includes('DISPOSABLE-GLOBAL-INHERITANCE-SECRET'), false);
  console.log(JSON.stringify({ result: 'MCP_INHERITANCE_OK', mode, scope }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await host?.shutdown(); await closeProviderNetworkDispatchers();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
