import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const mode = process.argv[2];
assert.ok(mode === 'memory' || mode === 'durable');
const root = await mkdtemp(path.join(os.tmpdir(), 'extension-session-cli-'));
console.log(JSON.stringify({ root, mode, node: process.versions.node }));
const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
const entry = path.join(agent, 'state.mjs'), trace = path.join(root, 'trace.jsonl');
await mkdir(cwd); await mkdir(agent);
const moduleBody = version => `import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { SessionManager, AI_HARNESS_EXTENSION_API_VERSION } from '@ai-harness/core';
const version=${version};
const revisions=entries=>entries.filter(entry=>entry.type==='custom'&&entry.customType==='fixture:private').map(entry=>entry.data.revision);
export default api=>{
  assert.equal(api.version,AI_HARNESS_EXTENSION_API_VERSION);assert.equal(api.version,1);
  api.registerCommand('state-probe',{description:'Exercise supported session state',handler:async(operation,context)=>{
    const manager=context.sessionManager,id=context.currentSessionId;
    assert.ok(manager instanceof SessionManager);assert.equal(id,'extension-state-primary');
    if(operation==='setup') {
      assert.deepEqual(revisions(await manager.getActiveBranchEntries(id)),[]);
      await manager.addMessage(id,{role:'user',content:'Shared root'});
      await manager.appendCustomEntry(id,'fixture:private',{revision:1,private:'NEVER_MODEL_PRIVATE'});
      await manager.appendCustomMessage(id,'fixture:note','MODEL_CUSTOM_NOTE',{display:false,details:{private:'NEVER_MODEL_DETAILS'}});
      await manager.addMessage(id,{role:'user',content:'Selected user'});
      const target=manager.get(id).activeLeafId;
      await manager.appendCustomEntry(id,'fixture:private',{revision:2});
      await manager.addMessage(id,{role:'assistant',content:'Abandoned answer'});
      const source=manager.get(id).activeLeafId;
      const selected=await manager.navigateTree(id,target,{summarize:true,summarizer:async()=>({summary:'Observed abandoned work.'})});
      assert.equal(selected.status,'navigated');assert.equal(selected.summary.parentEntryId,target);assert.equal(selected.summary.fromEntryId,source);
    }
    if(operation==='forks') {
      const path=await manager.getActiveBranchEntries(id);
      const target=path.filter(entry=>entry.type==='message'&&entry.role==='user').at(-1).id;
      for(const kind of ['entry','current','index','clone']) {
        const child=kind==='entry'?await manager.forkSessionAtEntry(id,target):kind==='clone'?await manager.cloneSession(id):await manager.forkSession(id,kind==='index'?target:undefined);
        assert.ok(child);assert.deepEqual(revisions(await manager.getActiveBranchEntries(child.id)),[1]);
        assert.equal(kind==='clone'?child.metadata.clonedFromSessionId:child.parentId,id);
        await manager.appendCustomEntry(child.id,'fixture:private',{revision:3});
        assert.deepEqual(revisions(await manager.getActiveBranchEntries(child.id)),[1,3]);
        assert.deepEqual(revisions(await manager.getActiveBranchEntries(id)),[1]);
      }
    }
    if(operation==='compact') {
      const target=(await manager.getActiveBranchEntries(id)).filter(entry=>entry.type==='message'&&entry.role==='user').at(-1).id;
      await manager.applyCompaction(id,'Selected compaction background',target);
      await manager.addMessage(id,{role:'user',content:'After compaction'});
    }
    const selected=await manager.getActiveBranchEntries(id);
    const expected=operation==='empty'?[]:[1];
    assert.deepEqual(revisions(selected),expected);
    if(operation!=='empty') {
      assert.deepEqual(revisions(await manager.getRawEntries(id)),[1,2]);
      const model=JSON.stringify(manager.getEffectiveContext(id));
      assert.ok(!model.includes('NEVER_MODEL_PRIVATE'));assert.ok(!model.includes('NEVER_MODEL_DETAILS'));
      if(selected.some(entry=>entry.type==='compaction')) {assert.ok(model.includes('Selected compaction background'));assert.ok(!model.includes('MODEL_CUSTOM_NOTE'));}
      else assert.ok(model.includes('MODEL_CUSTOM_NOTE'));
    }
    const result={version,operation,revisions:revisions(selected)};
    await appendFile(${JSON.stringify(trace)},JSON.stringify(result)+'\\n');
    return 'STATE_EXTENSION_RESULT '+JSON.stringify(result);
  }});
};`;
await writeFile(entry, moduleBody(1));
await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true }));
const deadline = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${mode}/${label}`)), 5_000); })]).finally(() => clearTimeout(timer));
};
let active;
const records = async () => (await readFile(trace, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
function open() {
  const command = process.env.AIH_STATE_COMMAND;
  const child = spawn(command ?? process.execPath, [...(command ? [] : [process.env.AIH_STATE_CLI ?? '/app/packages/cli/dist/index.js']),
    '--mode','rpc','--offline','--approve','--no-context-files','--no-extensions','-e',entry,
    '--model','mock/mock-model','--session-dir',sessions,'--session-id','extension-state-primary',...(mode==='memory'?['--no-session']:[])],
  { cwd, env: { PATH: process.env.PATH, HOME: path.join(root,'home'), AI_HARNESS_AGENT_DIR: agent, NO_COLOR:'1' }, stdio:['pipe','pipe','pipe'] });
  active = child;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const pending = new Map(), output = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const value = JSON.parse(line); output.push(value); if(value.type==='response'&&pending.has(value.id)){pending.get(value.id)(value);pending.delete(value.id);} });
  const exited = new Promise(resolve => child.once('exit',(code,signal)=>resolve({code,signal})));
  let sequence = 0;
  return {
    async run(operation) {
      const id = `state-${++sequence}`;
      const response = new Promise(resolve => pending.set(id, resolve));
      child.stdin.write(JSON.stringify({type:'prompt',id,message:`/state-probe ${operation}`})+'\n');
      const value = await deadline(response, `${operation}/${stderr}`);
      assert.equal(value.success,true,JSON.stringify({value,stderr}));assert.equal(value.data.disposition,'handled');
    },
    async close() {
      child.stdin.end();assert.deepEqual(await deadline(exited,'clean EOF'),{code:0,signal:null},stderr);
      assert.equal(output.filter(value=>value.type==='extension_error').length,0,stderr);
      assert.ok(!JSON.stringify(output).includes('NEVER_MODEL_PRIVATE'));
      assert.ok(!JSON.stringify(output).includes('NEVER_MODEL_DETAILS'));
      active=undefined;
    },
  };
}
try {
  const first = open();
  for (const operation of ['setup','read','forks','compact','forks','read']) await first.run(operation);
  await writeFile(entry, moduleBody(2));
  await first.run('read');
  assert.deepEqual((await records()).map(value=>value.version),Array(7).fill(1),'RPC executable generation stays startup-scoped; disk edits do not reload it.');
  await first.close();
  const restarted = open();
  await restarted.run(mode==='memory'?'empty':'read');
  await restarted.close();
  const last = (await records()).at(-1);
  assert.deepEqual(last,{version:2,operation:mode==='memory'?'empty':'read',revisions:mode==='memory'?[]:[1]});
  await rm(root,{recursive:true,force:true});
  console.log(JSON.stringify({result:'EXTENSION_SESSION_CLI_OK',mode,commands:8,restart:true,explicitExecutableGeneration:true}));
} finally { active?.kill('SIGKILL'); }
