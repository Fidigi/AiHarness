import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import pty from 'node-pty';

const scenario = process.argv[2];
assert.ok(['regular-memory','regular-durable','fullscreen-memory','fullscreen-durable'].includes(scenario));
const mode = scenario.startsWith('regular') ? 'regular' : 'fullscreen', durable = scenario.endsWith('durable');
const root = await mkdtemp(path.join(os.tmpdir(),'extension-state-terminal-'));
console.log(JSON.stringify({root,scenario,node:process.versions.node}));
const cwd=path.join(root,'work'),agent=path.join(root,'agent'),sessions=path.join(root,'sessions'),trace=path.join(root,'trace.jsonl');
const entry=path.join(agent,'state.mjs');
await mkdir(cwd);await mkdir(agent);await writeFile(path.join(agent,'settings.json'),JSON.stringify({quietStartup:true}));
const body=version=>`import assert from 'node:assert/strict';import {appendFile} from 'node:fs/promises';
import {SessionManager} from '@ai-harness/core';const version=${version};
export default api=>{assert.equal(api.version,1);api.registerCommand('state-probe',{description:'Read persistent private state',handler:async(operation,context)=>{
  const manager=context.sessionManager,id=context.currentSessionId;assert.ok(manager instanceof SessionManager);assert.equal(id,'state-terminal-primary');
  if(operation==='setup'){
    await manager.addMessage(id,{role:'user',content:'Root'});
    await manager.appendCustomEntry(id,'fixture:terminal',{revision:1,private:'PRIVATE_SESSION_STATE'});
    await manager.appendCustomMessage(id,'fixture:note','Terminal custom context',{display:false,details:'PRIVATE_SESSION_DETAILS'});
    await manager.addMessage(id,{role:'user',content:'Selected context'});
    const target=manager.get(id).activeLeafId;
    await manager.appendCustomEntry(id,'fixture:terminal',{revision:2});
    await manager.addMessage(id,{role:'assistant',content:'Abandoned answer'});
    assert.equal((await manager.navigateTree(id,target)).status,'navigated');
    await manager.applyCompaction(id,'Terminal selected background',target);
  }
  const entries=await manager.getActiveBranchEntries(id);
  const revisions=entries.filter(entry=>entry.type==='custom'&&entry.customType==='fixture:terminal').map(entry=>entry.data.revision);
  assert.deepEqual(revisions,operation==='empty'?[]:[1]);
  const model=JSON.stringify(manager.getEffectiveContext(id));assert.ok(!model.includes('PRIVATE_SESSION_STATE'));assert.ok(!model.includes('PRIVATE_SESSION_DETAILS'));
  if(operation!=='empty'){assert.ok(model.includes('Terminal selected background'));assert.ok(!model.includes('Terminal custom context'));}
  const result={version,operation,revisions};await appendFile(${JSON.stringify(trace)},JSON.stringify(result)+'\\n');
  return 'STATE_TERMINAL_RESULT '+JSON.stringify(result);
}});};`;
await writeFile(entry,body(1));
const records=async()=>(await readFile(trace,'utf8').catch(()=> '')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
let terminal,exited,output='';
const visible=()=>stripVTControlCharacters(output);
const waitFor=async(predicate,label)=>{
  const end=Date.now()+5_000;
  while(!await predicate()){
    if(Date.now()>=end||exited)throw new Error(`${scenario}/${label}: ${visible()}`);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
};
async function open(){
  output='';exited=undefined;
  const command=process.env.AIH_STATE_COMMAND;
  terminal=pty.spawn(command??process.execPath,[...(command?[]:[process.env.AIH_STATE_CLI??'/app/packages/cli/dist/index.js']),
    '--offline','--approve','--no-context-files','--no-extensions','-e',agent,'--model','mock/mock-model','--verbose',
    '--session-dir',sessions,'--session-id','state-terminal-primary','--name','state-probe','--tui-mode',mode,'--theme','dark',
    ...(!durable?['--no-session']:[])],{cwd,cols:200,rows:40,env:{PATH:process.env.PATH,HOME:path.join(root,'home'),AI_HARNESS_AGENT_DIR:agent,TERM:'xterm-256color',NO_COLOR:'1'}});
  terminal.onData(value=>{output+=value;});terminal.onExit(value=>{exited=value;});
  await waitFor(()=>visible().includes('editor ready · Enter send'),'initial editor');
}
async function command(operation,version,expected){
  const count=(await records()).length;
  output='';terminal.write(`/state-probe ${operation}\r`);
  await waitFor(async()=>(await records()).length===count+1,`settled ${operation}`);
  assert.deepEqual((await records()).at(-1),{version,operation,revisions:expected});
  await waitFor(()=>{const text=visible(),start=text.lastIndexOf('STATE_TERMINAL_RESULT');return start>=0&&text.indexOf('editor ready · Enter send',start)>=0;},'editor after command result');
  assert.ok(!visible().includes('PRIVATE_SESSION_STATE'));assert.ok(!visible().includes('PRIVATE_SESSION_DETAILS'));
  assert.ok(!visible().includes('[Mock AI Response]'));
}
async function reload(failed=false,expectedCount=3){
  output='';terminal.write('/reload\r');
  // Fullscreen redraws old transcript lines. A distinct complete-generation count
  // is a new acknowledgement, unlike an old generic "Reloaded" line.
  await waitFor(()=>failed?visible().includes('Unexpected token'):visible().includes(`Reloaded ${expectedCount} extension(s).`),failed?'original generation retained after syntax failure':'new executable generation acknowledgement');
  await waitFor(()=>visible().includes('editor ready · Enter send'),'editor after reload');
  assert.ok(!visible().includes('PRIVATE_BAD_MODULE_BODY'));
}
async function close(){
  terminal.write('\u0004');await waitFor(()=>exited!==undefined,'direct Ctrl-D settlement');assert.equal(exited.exitCode,0);
  terminal=undefined;
}
try{
  await open();await command('setup',1,[1]);
  await writeFile(entry,body(2));await writeFile(path.join(agent,'second.mjs'),'export default () => {};');
  await command('read',1,[1]);await reload();await command('read',2,[1]);
  await writeFile(entry,'export default api=>{ const PRIVATE_BAD_MODULE_BODY = ; };');await reload(true);await command('read',2,[1]);
  await writeFile(entry,body(3));await writeFile(path.join(agent,'third.mjs'),'export default () => {};');
  await reload(false,4);await command('read',3,[1]);await close();
  await open();await command(durable?'read':'empty',3,durable?[1]:[]);await close();
  await rm(root,{recursive:true,force:true});
  console.log(JSON.stringify({result:'EXTENSION_SESSION_TERMINAL_OK',scenario,commands:6,generations:[1,2,3],failedGenerationRetained:true,restart:true}));
}finally{if(terminal&&!exited)terminal.kill();}
