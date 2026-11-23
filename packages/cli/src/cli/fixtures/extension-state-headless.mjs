import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const scenario=process.argv[2];
assert.ok(['print-memory','print-durable','json-memory','json-durable'].includes(scenario));
const mode=scenario.startsWith('print')?'print':'json',durable=scenario.endsWith('durable');
const root=await mkdtemp(path.join(os.tmpdir(),'extension-state-headless-'));
console.log(JSON.stringify({root,scenario,node:process.versions.node}));
const cwd=path.join(root,'work'),agent=path.join(root,'agent'),sessions=path.join(root,'sessions'),trace=path.join(root,'trace.jsonl'),entry=path.join(agent,'state.mjs');
await mkdir(cwd);await mkdir(agent);await writeFile(path.join(agent,'settings.json'),JSON.stringify({quietStartup:true}));
await writeFile(entry,`import assert from 'node:assert/strict';import {appendFile} from 'node:fs/promises';
import {MockProvider,SessionManager,AI_HARNESS_CORE_API_VERSION} from '@ai-harness/core';
const record=async value=>appendFile(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');
class FixtureProvider extends MockProvider {
  calls=0;
  async streamChat(messages,onChunk,onComplete,onError,options){
    try{
      assert.ok(!options?.signal?.aborted);assert.equal(AI_HARNESS_CORE_API_VERSION,2);
      const body=JSON.stringify(messages);assert.ok(!body.includes('HEADLESS_PRIVATE_STATE'));
      const step=this.calls++;
      await record({kind:'provider',step,literal:messages.filter(message=>message.role==='user').at(-1)?.content});
      if(step===0){
        assert.ok(options.tools.some(tool=>tool.name==='state_probe'));
        await onChunk('',{type:'message_start',data:{fixture:true}});
        onComplete?.({content:'',model:'fixture-model',toolCalls:[{id:'fixture-state-call',name:'state_probe',input:{}}],usage:{promptTokens:2,completionTokens:1,totalTokens:3}});
      }else{
        assert.equal(messages.filter(message=>message.role==='tool'&&message.toolCallId==='fixture-state-call').at(-1)?.content,'STATE_TOOL_RESULT');
        await onChunk('STATE_HEADLESS_FINISH',{type:'text_delta',data:{fixture:true}});
        onComplete?.({content:'STATE_HEADLESS_FINISH',model:'fixture-model',usage:{promptTokens:3,completionTokens:1,totalTokens:4}});
      }
    }catch(error){onError?.(error);}
  }
}
export default api=>{
  assert.equal(api.version,1);
  api.registerProvider('statefixture',{defaultConfig:{model:'fixture-model'},create:config=>new FixtureProvider(config)});
  api.registerTool({name:'state_probe',description:'Read and append private session state',parameters:{type:'object'},execute:async(_input,context)=>{
    const manager=context.sessionManager,id=context.currentSessionId;
    assert.ok(manager instanceof SessionManager);assert.equal(id,'headless-state-primary');assert.ok(context.provider instanceof FixtureProvider);assert.equal(context.providerName,context.provider.getProviderType());assert.equal(context.providerName,'mock');assert.equal(context.toolCallId,'fixture-state-call');
    const select=entries=>entries.filter(entry=>entry.type==='custom'&&entry.customType==='fixture:headless').map(entry=>entry.data.revision);
    const prior=select(await manager.getActiveBranchEntries(id));assert.ok(prior.length===0||JSON.stringify(prior)==='[1]');
    if(!prior.length)await manager.appendCustomEntry(id,'fixture:headless',{revision:1,private:'HEADLESS_PRIVATE_STATE'});
    assert.deepEqual(select(await manager.getActiveBranchEntries(id)),[1]);
    assert.ok(!JSON.stringify(manager.getEffectiveContext(id)).includes('HEADLESS_PRIVATE_STATE'));
    await record({kind:'tool',prior,revisions:[1]});
    return {content:'STATE_TOOL_RESULT',details:{selectedState:true}};
  }});
};`);
let active;
async function invoke(){
  const command=process.env.AIH_STATE_COMMAND;
  const child=spawn(command??process.execPath,[...(command?[]:[process.env.AIH_STATE_CLI??'/app/packages/cli/dist/index.js']),
    '--offline','--approve','--no-context-files','--no-extensions','-e',entry,'--no-builtin-tools','--model','statefixture/fixture-model',
    '--session-dir',sessions,'--session-id','headless-state-primary',...(!durable?['--no-session']:[]),...(mode==='print'?['--print']:['--mode','json']),'/state-probe literal'],
  {cwd,env:{PATH:process.env.PATH,HOME:path.join(root,'home'),AI_HARNESS_AGENT_DIR:agent,NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
  active=child;let stdout='',stderr='';
  child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});
  child.stdin.end(); // Headless startup consumes piped stdin before positional prompts.
  const timer=setTimeout(()=>child.kill('SIGKILL'),5_000);
  const result=await new Promise(resolve=>child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});}));active=undefined;
  assert.deepEqual(result,{code:0,signal:null},JSON.stringify({result,stdout,stderr}));
  if(mode==='print')assert.equal(stdout.trim(),'STATE_HEADLESS_FINISH');
  else{assert.ok(stdout.endsWith('\n'));for(const line of stdout.trim().split('\n'))assert.equal(typeof JSON.parse(line).type,'string');assert.ok(stdout.includes('STATE_HEADLESS_FINISH'));}
  assert.ok(!stdout.includes('HEADLESS_PRIVATE_STATE'));assert.ok(!stderr.includes('HEADLESS_PRIVATE_STATE'));
}
try{
  await invoke();await invoke();
  const records=(await readFile(trace,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.deepEqual(records.filter(value=>value.kind==='provider').map(value=>value.step),[0,1,0,1]);
  assert.ok(records.filter(value=>value.kind==='provider').every(value=>value.literal==='/state-probe literal'),'Print/JSON slash input remains literal provider input.');
  assert.deepEqual(records.filter(value=>value.kind==='tool').map(value=>value.prior),[[],durable?[1]:[]]);
  await rm(root,{recursive:true,force:true});
  console.log(JSON.stringify({result:'EXTENSION_SESSION_HEADLESS_OK',scenario,providerTurns:4,toolCalls:2,restart:true}));
}finally{active?.kill('SIGKILL');}
