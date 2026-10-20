import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';

const mode = process.argv[2];
assert.ok(['print', 'json', 'rpc', 'regular', 'fullscreen'].includes(mode));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-ext-execution-'));
const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
await mkdir(cwd); await mkdir(agent);
await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, compaction: { enabled: false } }));
const extension = path.join(agent, 'review.mjs');
await writeFile(extension, `import assert from 'node:assert/strict';
import {MockProvider} from '@ai-harness/core';
class Provider extends MockProvider {
  calls = 0;
  async streamChat(messages, chunk, complete) {
    const step = this.calls++;
    if (step > 0) assert.ok(messages.some(message => message.role === 'tool' && message.content.includes('REPLACED_RESULT')));
    if (step === 2) assert.ok(JSON.stringify(messages).includes('REVIEW_CONTINUATION'));
    assert.ok(!JSON.stringify(messages).includes('PRIVATE_REVIEW_STATE'));
    const content = step === 2 ? 'EXTENSION-FINAL' : step === 1 ? 'INTERMEDIATE' : '';
    if (content) await chunk(content);
    complete({content, model:'fixture', usage:{promptTokens:2,completionTokens:1,totalTokens:3},
      ...(step === 0 ? {toolCalls:[{id:'call-review',name:'review_probe',input:{}}]} : {})});
  }
}
export default api => {
  api.registerProvider('reviewfixture', {defaultConfig:{model:'fixture'},create:config=>new Provider(config)});
  api.registerTool({name:'review_probe',description:'Review tool',execute:()=>({content:'ORIGINAL_RESULT',details:{usage:{totalTokens:99999}}})});
  api.before('before:message', data => ({content:data.content ? 'OWNED-' + data.content : ''}));
  api.before('before:tool:result', () => ({result:{content:'REPLACED_RESULT',structuredContent:{reviewed:true}}}));
  api.before('before:turn:end', async data => {
    const manager=data.context.sessionManager;
    await manager.appendCustomEntry(data.sessionId,'review:turn',{round:data.round,private:'PRIVATE_REVIEW_STATE'});
  });
  api.before('before:agent:settle', data => data.round===1 ? {continuation:{type:'review:followup',content:'REVIEW_CONTINUATION'}} : undefined);
};`);
const command = process.env.AIH_EXT_COMMAND;
const terminalMode = ['regular', 'fullscreen'].includes(mode);
const args = [...(command ? [] : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url))]),
  '--offline', '--approve', '--no-context-files', '--no-extensions', '-e', extension, '--no-builtin-tools',
  '--model', 'reviewfixture/fixture', '--session-dir', sessions, '--session-id', 'execution-probe',
  ...(mode === 'print' ? ['--print'] : terminalMode ? ['--tui-mode', mode, '--verbose', '--theme', 'dark'] : ['--mode', mode]),
  ...(!terminalMode && mode !== 'rpc' ? ['initial'] : [])];
const env = { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, TERM: 'xterm-256color', NO_COLOR: '1' };
let child, terminal, output = '', stderr = '', exit;
const waitFor = async predicate => {
  const until = Date.now() + 8000;
  while (!await predicate()) {
    assert.ok(Date.now() < until && !exit, JSON.stringify({mode,exit,output,stderr}));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
try {
  if (terminalMode) {
    const pty = await import(process.env.AIH_TEST_MODULES_ROOT ? pathToFileURL(path.join(process.env.AIH_TEST_MODULES_ROOT, 'node-pty/lib/index.js')).href : 'node-pty');
    terminal = pty.spawn(command ?? process.execPath, args, {cwd,env,cols:160,rows:40});
    terminal.onData(text => { output += text; }); terminal.onExit(result => { exit = result; });
    await waitFor(() => stripVTControlCharacters(output).includes('editor ready'));
    terminal.write('initial\r');
    await waitFor(async () => {
      const text = stripVTControlCharacters(output), final = text.lastIndexOf('OWNED-EXTENSION-FINAL');
      if (final < 0 || text.indexOf('editor ready', final) < 0) return false;
      const disk = await readFile(path.join(sessions, 'execution-probe.jsonl'), 'utf8');
      return disk.includes('OWNED-EXTENSION-FINAL') && disk.includes('"round":2');
    });
    terminal.write('\u0004');
    const until = Date.now() + 5000;
    while (!exit) { assert.ok(Date.now() < until, output); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(exit.exitCode, 0, output);
  } else {
    child = spawn(command ?? process.execPath, args, {cwd,env,stdio:['pipe','pipe','pipe']});
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    if (mode === 'rpc') {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => { const record = JSON.parse(line); if (record.type === 'agent_settled') child.stdin.end(); });
      child.stdin.write(JSON.stringify({id:'prompt',type:'prompt',message:'initial'}) + '\n');
    } else child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({code,signal})));
    clearTimeout(timer);
    assert.deepEqual(result, {code:0,signal:null}, output + stderr);
    if (mode === 'print') assert.equal(output.trim(), 'OWNED-EXTENSION-FINAL');
    else {
      const records = output.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(records.filter(record => record.type === 'agent_settled').length, 1);
      assert.ok(output.includes('OWNED-EXTENSION-FINAL'));
    }
  }
  assert.ok(!output.includes('PRIVATE_REVIEW_STATE')); assert.ok(!stderr.includes('PRIVATE_REVIEW_STATE'));
  const manager = new SessionManager({store:new JsonlSessionStore(sessions)});
  await manager.loadAllSessions();
  const entries = await manager.getRawEntries('execution-probe');
  assert.deepEqual(entries.filter(entry => entry.type === 'custom' && entry.customType === 'review:turn').map(entry => entry.data.round), [0,1,2]);
  assert.equal(entries.filter(entry => entry.type === 'custom_message' && entry.customType === 'review:followup').length, 1);
  assert.equal(entries.filter(entry => entry.type === 'message' && entry.role === 'user').length, 1);
  assert.equal(manager.get('execution-probe').usage.totalTokens, 9);
  assert.ok(entries.some(entry => entry.type === 'message' && entry.role === 'tool' && entry.content.includes('REPLACED_RESULT')));
  console.log('EXTENSION_EXECUTION_OK');
} finally {
  child?.kill('SIGKILL'); if (terminal && !exit) terminal.kill();
  await rm(root, {recursive:true,force:true});
}
