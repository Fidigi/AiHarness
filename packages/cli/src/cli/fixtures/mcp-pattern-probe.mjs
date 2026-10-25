import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeProviderNetworkDispatchers, McpSessionHost, ProjectTrustManager, SessionManager } from '@ai-harness/core';

const [mode, scope, policy = 'exact'] = process.argv[2].split('/');
assert.ok(['exact', 'missing', 'excluded', 'codemode', 'deferred', 'hidden'].includes(policy));
assert.ok(['command', 'core', 'print', 'json', 'rpc'].includes(mode));
assert.ok(['global', 'project'].includes(scope));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-pattern-public-'));
const cwd = path.join(root, 'workspace'), agent = path.join(root, 'agent'), log = path.join(root, 'calls.jsonl');
await mkdir(agent); await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
const trust = new ProjectTrustManager(path.join(agent, 'trust.json')); await trust.load(); await trust.setDecision(cwd, true);
const fixture = process.env.AIH_MCP_PATTERN_SERVER || fileURLToPath(new URL('../../../../core/src/mcp/fixtures/test-server.mjs', import.meta.url));
const configPath = path.join(scope === 'global' ? agent : path.join(cwd, '.ai-harness'), 'mcp.json');
const save = toolExposure => writeFile(configPath, JSON.stringify({ version: 1, mcpServers: { fixture: {
  command: process.execPath, args: [fixture], env: { MCP_TEST_CALL_LOG: log },
  ...(['missing', 'excluded'].includes(policy) ? {} : { exposure: ['codemode', 'deferred', 'hidden'].includes(policy) ? policy : 'direct' }), toolExposure,
} } }));
const calls = async () => {
  try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const tool = 'mcp__fixture__lookup', mutate = 'mcp__fixture__mutate';
const resourceNames = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].map(name => `mcp__fixture__${name}`);
let child, host, server, fixtureError;
const declarations = [], allDeclarations = [], toolResults = [];
async function cli(args, rpc = false) {
  child = spawn(process.env.AIH_MCP_PATTERN_COMMAND || process.execPath, process.env.AIH_MCP_PATTERN_COMMAND
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
  await save(mode === 'command' || policy !== 'exact' ? {} : { '*': 'hidden', lookup: 'direct' });
  if (mode === 'command') {
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
    const call = (name, args = {}) => ({ name, args });
    const plan = policy === 'missing' ? [[call(tool), call(mutate)]]
      : policy === 'excluded' ? [[call(tool), call(mutate)]]
      : policy === 'hidden' ? [[call(tool)]]
      : policy === 'codemode' ? [[call('tool_search', { query: 'documentation state' })],
        [call('codemode', { code: `text(await tools.${tool}({})); text(typeof tools.${mutate});` })]]
      : policy === 'deferred' ? [[call('tool_search', { query: 'documentation state' }), call(tool)], [call(tool)]]
      : [[call(tool, { topic: 'docs' })]];
    server = createServer(async (request, response) => {
      try {
        let wire = ''; for await (const chunk of request) { wire += chunk; assert.ok(wire.length < 100_000); }
        const body = JSON.parse(wire); assert.equal(body.stream, true); assert.equal(request.url, '/chat/completions');
        const names = (body.tools ?? []).map(entry => entry.function.name); allDeclarations.push(names);
        declarations.push(names.filter(name => name.startsWith('mcp__')));
        toolResults.push(body.messages.filter(message => message.role === 'tool'));
        const phase = allDeclarations.length - 1;
        const requested = plan[phase];
        const final = !requested;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ choices: [{ delta: final ? { content: 'Exposure OK' } : {
          tool_calls: requested.map((entry, index) => ({ index, id: `call-${phase}-${index}`, type: 'function',
            function: { name: entry.name, arguments: JSON.stringify(entry.args) } })),
        }, finish_reason: final ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
      } catch (failure) { fixtureError = failure; response.writeHead(500); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const extension = path.join(agent, 'provider.mjs');
    await writeFile(extension, `import { OpenAiProvider } from ${JSON.stringify(import.meta.resolve('@ai-harness/core'))};
      export default api => api.registerProvider('mcp-pattern-fixture', { defaultConfig: { model: 'fixture' },
        create: config => new OpenAiProvider({ ...config, type: 'openai', baseUrl: 'http://127.0.0.1:${server.address().port}', apiKey: 'disposable', model: 'fixture' }) });`);
    const controls = ['codemode', 'deferred'].includes(policy) ? ['-e', 'builtin:tool-search', '-e', 'builtin:codemode'] : [];
    const selection = policy === 'exact' || policy === 'missing' ? [] : ['--tools',
      [...(policy === 'codemode' ? ['codemode'] : []), ...(['codemode', 'deferred'].includes(policy) ? ['tool_search'] : []), 'mcp__fixture__*'].join(','),
      '--exclude-tools', mutate];
    const stdout = await cli(['--offline', '--approve', '--no-extensions', '-e', 'builtin:mcp', ...controls, '-e', extension, '--no-context-files', ...selection,
      '--model', 'mcp-pattern-fixture/fixture', '--session-dir', path.join(root, 'sessions'), '--session-id', 'mcp-pattern',
      ...(mode === 'print' ? ['-p'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Read fixture'])], mode === 'rpc');
    assert.equal(fixtureError, undefined);
    assert.deepEqual(await calls(), policy === 'missing' ? ['lookup', 'mutate'] : policy === 'hidden' ? [] : ['lookup'],
      JSON.stringify({ allDeclarations, toolResults }));
    const directNames = policy === 'excluded' ? [...resourceNames, tool] : [tool];
    const expected = policy === 'missing' ? [[...resourceNames, tool, mutate], [...resourceNames, tool, mutate]]
      : policy === 'hidden' ? [[], []] : policy === 'codemode' ? [[], [], []]
      : policy === 'deferred' ? [[], [tool], [tool]] : [directNames, directNames];
    assert.deepEqual(declarations, expected, JSON.stringify({ allDeclarations }));
    if (['codemode', 'deferred'].includes(policy)) assert.ok(allDeclarations[0].includes('tool_search'));
    if (mode === 'print') assert.equal(stdout, 'Exposure OK\n');
    else {
      const records = stdout.trim().split('\n').map(line => JSON.parse(line));
      if (mode === 'json') assert.equal(records[0].version, 3);
      assert.equal(records.filter(record => record.type === 'agent_settled').length, 1);
      if (policy === 'exact') assert.equal(records.filter(record => record.type === 'tool_execution_start').length, 1);
      assert.equal(records.filter(record => record.type === 'auto_retry_start').length, 0);
      assert.equal(records.filter(record => record.type === 'message_end' && record.message.role === 'assistant').at(-1).message.stopReason, 'stop');
    }
  }
  console.log(JSON.stringify({ result: 'MCP_PATTERN_OK', mode, scope, ...(policy === 'exact' ? {} : { policy }) }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await host?.shutdown(); await closeProviderNetworkDispatchers();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
