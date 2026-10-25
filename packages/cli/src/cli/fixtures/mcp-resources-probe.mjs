import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectTrustManager } from '@ai-harness/core';
import { resourceProvider } from '../../../../core/src/mcp/fixtures/resource-provider.mjs';
const [mode, scope] = process.argv[2].split('/');
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-resource-cli-')), agent = path.join(root, 'agent'), cwd = path.join(root, 'work');
const wire = await resourceProvider(); let child;
try {
  await mkdir(agent); await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
  const trust = new ProjectTrustManager(path.join(agent, 'trust.json')); await trust.load(); await trust.setDecision(cwd, true);
  const peer = fileURLToPath(new URL('../../../../core/src/mcp/fixtures/resource-server.mjs', import.meta.url));
  await writeFile(path.join(scope === 'global' ? agent : path.join(cwd, '.ai-harness'), 'mcp.json'), JSON.stringify({ mcpServers: { docs: {
    command: process.execPath, args: [peer], env: { MCP_RICH_TOOL: 'yes', MCP_SECRET: 'disposable-resource-secret' },
  } } }));
  const extension = path.join(agent, 'provider.mjs');
  await writeFile(extension, `import { OpenAiProvider } from ${JSON.stringify(import.meta.resolve('@ai-harness/core'))}; export default api => api.registerProvider('resource-fixture', {
    defaultConfig: { model: 'fixture' }, create: config => new OpenAiProvider({...config, type:'openai', model:'fixture', baseUrl:${JSON.stringify(wire.url)}, apiKey:'opaque-fixture-provider-key'}) });`);
  child = spawn(process.execPath, [fileURLToPath(new URL('../../../dist/index.js', import.meta.url)), '--offline', '--approve', '--no-extensions', '-e', 'builtin:mcp', '-e', extension,
    '--no-context-files', '--model', 'resource-fixture/fixture', '--tools', 'mcp__docs__*', '--session-dir', path.join(root, 'sessions'),
    ...(mode === 'print' ? ['-p'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Read resources'])],
    { cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', pending = '', protocolFailure;
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk; if (mode !== 'rpc') return; pending += chunk;
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const record = JSON.parse(line);
        if (record.type === 'agent_settled') {
          const reference = /mcp-content:([a-f0-9-]{36})/u.exec(stdout)?.[1]; assert.ok(reference);
          child.stdin.write(JSON.stringify({ type: 'read_mcp_content', id: 'binary', reference }) + '\n');
        } else if (record.type === 'response' && record.command === 'read_mcp_content') {
          assert.equal(record.success, true, line); assert.equal(Buffer.from(record.data.data, 'base64').toString(), 'disposable-audio'); child.stdin.end();
        }
      } catch (error) { protocolFailure = error; child.stdin.end(); }
    }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  if (mode === 'rpc') child.stdin.write(JSON.stringify({ type: 'prompt', id: 'prompt', message: 'Read resources' }) + '\n'); else child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
  assert.deepEqual(exit, { code: 0, signal: null }, JSON.stringify({ exit, stdout, stderr })); assert.equal(protocolFailure, undefined); assert.equal(stderr, '');
  assert.equal(wire.failure(), undefined); assert.equal(wire.observed.length, 2);
  const resultWire = JSON.stringify(wire.observed[1].messages);
  for (const token of ['fixture://text', 'uriTemplate', '42', 'data:image/png;base64,', 'mcp-content:']) assert.ok(resultWire.includes(token), token + ': ' + resultWire);
  assert.ok(!resultWire.includes('disposable-resource-secret')); assert.ok(!resultWire.includes('ui://app'));
  if (mode === 'print') assert.equal(stdout, 'MCP resources complete\n');
  else {
    const records = stdout.trim().split('\n').map(line => JSON.parse(line));
    const messages = records.filter(record => record.type === 'message_end' && record.message.role === 'toolResult').map(record => record.message);
    assert.equal(messages.length, 5); assert.equal(messages.flatMap(message => message.content).filter(block => block.type === 'image').length, 2);
    assert.equal(messages.filter(message => message.details?.structuredContent).length, 3);
    assert.equal(records.filter(record => record.type === 'agent_settled').length, 1);
  }
  console.log(JSON.stringify({ result: 'MCP_RESOURCES_OK', mode, scope }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await wire.close(); await rm(root, { recursive: true, force: true });
}
