import assert from 'node:assert/strict';
import { spawn } from 'node-pty';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const mode = process.argv[2];
assert(['regular', 'fullscreen'].includes(mode));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-management-'));
const cwd = path.join(root, 'project'), agent = path.join(root, 'agent');
let terminal, exited, output = '';
let pendingRequests = 0;
const stalled = createServer(() => { pendingRequests++; });
const wait = async (predicate, label) => {
  const end = performance.now() + 10_000;
  while (!await predicate()) {
    assert(performance.now() < end, `${label}: ${JSON.stringify({ exited, output: output.slice(-8192) })}`);
    await pause(10);
  }
};
const shown = () => (mode === 'fullscreen' ? output.slice(Math.max(0, output.lastIndexOf('\x1b[2J\x1b[H'))) : output)
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '');
const ready = () => shown().includes('editor ready · Enter send') && /mcp-management:\s*$/u.test(shown());
const command = async (text, expected) => {
  // Fullscreen redraws old command results while editing. Require a newly
  // appended result in the current frame, not an earlier matching history row.
  const previous = mode === 'fullscreen' ? shown().split(expected).length - 1 : 0;
  output = ''; terminal.write(text + '\r');
  await wait(() => shown().split(expected).length - 1 > previous && ready(), text);
};
try {
  await mkdir(cwd); await mkdir(agent);
  const config = { command: process.execPath,
    args: [fileURLToPath(new URL('../../../../core/src/mcp/fixtures/test-server.mjs', import.meta.url))],
    timeout: 2, env: { MCP_TEST_SECRET: 'MCP_MANAGEMENT_DISPOSABLE_SECRET' } };
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(agent, 'mcp.json'), JSON.stringify({ mcpServers: {
    fixture: config, stalled: { url: `http://127.0.0.1:${stalled.address().port}/mcp`, enabled: false },
  } }));
  terminal = spawn(process.execPath, [fileURLToPath(new URL('../../../dist/index.js', import.meta.url)),
    '--offline', '--approve', '--no-session', '--model', 'mock/mock-model', '--no-context-files',
    '--no-extensions', '-e', 'builtin:mcp', '--tui-mode', mode, '--theme', 'dark', '--name', 'mcp-management'], {
    cwd, cols: 120, rows: 40, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'),
      AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1', TERM: 'xterm-256color' },
  });
  terminal.onData(text => { output += text; assert(output.length < 1024 * 1024); });
  terminal.onExit(value => { exited = value; });
  await wait(ready, 'startup');
  await command('/mcp test fixture', 'fixture: connected; 2 tools');
  assert(!output.includes('MCP_MANAGEMENT_DISPOSABLE_SECRET'));
  assert.equal(pendingRequests, 0);
  output = ''; terminal.write('/mcp test stalled\r');
  await wait(() => pendingRequests > 0, 'explicit stalled Test');
  terminal.write('\x1b');
  await wait(() => output.includes('The MCP test request was aborted.') && ready(), 'Escape cancels owned Test');
  await command('/mcp tools', 'mcp__fixture__lookup');
  await command('/mcp disable fixture', 'Disabled: fixture=changed');
  assert.equal(JSON.parse(await readFile(path.join(agent, 'mcp.json'), 'utf8')).mcpServers.fixture.enabled, false);
  await command('/mcp tools', 'No direct MCP tools are ready.');
  await command('/mcp enable fixture', 'Enabled: fixture=changed');
  await command('/mcp reconnect', 'MCP connections refreshed.');
  await command('/reload', 'Reloaded ');
  await command('/mcp tools', 'mcp__fixture__lookup');
  terminal.write('/quit\r'); await wait(() => exited !== undefined, 'shutdown');
  assert.equal(exited.exitCode, 0); assert(!exited.signal);
  console.log(JSON.stringify({ result: 'MCP_MANAGEMENT_OK', mode }));
} finally {
  if (terminal && !exited) { terminal.kill('SIGKILL'); await wait(() => exited !== undefined, 'cleanup'); }
  stalled.closeAllConnections(); await new Promise(resolve => stalled.close(resolve));
  await rm(root, { recursive: true, force: true });
}
