import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createAgentSession, ExtensionRegistry, ProjectTrustManager, registerWorkspaceTools, WorkspaceManager } from '@ai-harness/core';

const [mode, mutation] = process.argv.slice(2);
assert.ok(['print', 'json', 'rpc', 'sdk'].includes(mode));
assert.ok(['refuse', 'remove'].includes(mutation));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-trust-revocation-'));
const parent = path.join(root, 'projects'), cwd = path.join(parent, 'work'), agent = path.join(root, 'agent');
const trust = new ProjectTrustManager(path.join(agent, 'trust.json'));
let child, sdk, registry, requests = 0, serverError;
const server = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) { text += chunk; assert.ok(text.length < 2_000_000); }
    const body = JSON.parse(text); assert.equal(body.stream, true); requests++;
    let delta, finish_reason;
    if (requests === 1) {
      assert.ok(body.tools.some(tool => tool.function.name === 'write'));
      if (mutation === 'refuse') await trust.refuse(cwd);
      else await trust.setDecision(parent, null);
      delta = { tool_calls: [{ index: 0, id: 'revoked-write', type: 'function', function: { name: 'write',
        arguments: JSON.stringify({ path: 'must-not-exist.txt', content: 'unsafe' }) } }] };
      finish_reason = 'tool_calls';
    } else {
      assert.equal(requests, 2);
      assert.ok(body.messages.some(message => message.role === 'tool' && /trust/i.test(message.content)));
      delta = { content: 'Revocation respected' }; finish_reason = 'stop';
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }], model: 'fixture-model' })}\n\ndata: [DONE]\n\n`);
  } catch (error) { serverError ??= error; response.writeHead(500); response.end('Invalid revocation fixture'); }
});
let timer;
const deadline = promise => Promise.race([promise, new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error('Trust revocation deadline')), 8_000);
})]).finally(() => clearTimeout(timer));
try {
  await mkdir(path.join(cwd, '.ai-harness'), { recursive: true }); await mkdir(agent);
  await writeFile(path.join(cwd, '.ai-harness', 'settings.json'), '{}');
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }));
  await trust.load(); await trust.trust(parent);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  if (mode === 'sdk') {
    // The native SDK never implicitly registers executable tools.
    registry = new ExtensionRegistry();
    const workspace = new WorkspaceManager({ defaultCwd: cwd, allowedRoots: [cwd] }); await workspace.initialize();
    await registerWorkspaceTools(registry, workspace);
    sdk = await createAgentSession({ cwd, allowedRoots: [cwd], extensionRegistry: registry,
      isProjectTrusted: candidate => trust.isTrusted(candidate),
      provider: { kind: 'config', config: { type: 'local', model: 'fixture-model', baseUrl: endpoint } } });
    const result = await deadline(sdk.promptAndWait('Try a write', { model: 'fixture-model' }));
    if (serverError) throw serverError;
    assert.equal(result.phase, 'completed', JSON.stringify(result)); await sdk.dispose(); sdk = undefined;
  } else {
    const command = process.env.AIH_TRUST_COMMAND;
    child = spawn(command ?? process.execPath, [...(command ? [] : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url))]),
      ...(mode === 'print' ? ['--print'] : ['--mode', mode]), '--offline', '--no-session', '--no-mcp', '--no-extensions',
      '--no-context-files', '--tools', 'write', '--model', 'local/fixture-model', ...(mode === 'rpc' ? [] : ['Try a write'])], {
      cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
        LOCAL_BASE_URL: endpoint, LOCAL_MODEL: 'fixture-model', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    if (mode === 'rpc') {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        const record = JSON.parse(line);
        if (record.id === 'prompt') assert.equal(record.success, true);
        if (record.type === 'agent_settled') child.stdin.end();
      });
      child.stdin.write(`${JSON.stringify({ id: 'prompt', type: 'prompt', message: 'Try a write' })}\n`);
    } else child.stdin.end();
    assert.deepEqual(await deadline(exited), { code: 0, signal: null }, stderr);
    assert.ok(stdout.includes('Revocation respected'), stdout + stderr);
  }
  if (serverError) throw serverError;
  assert.equal(requests, 2);
  await assert.rejects(readFile(path.join(cwd, 'must-not-exist.txt')), { code: 'ENOENT' });
  console.log('TRUST_REVOCATION_OK');
} finally {
  child?.kill('SIGKILL'); await sdk?.dispose(); await registry?.unloadAll(); server.closeAllConnections();
  await new Promise(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
}
