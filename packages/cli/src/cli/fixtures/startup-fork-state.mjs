import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
const [mode,selector]=process.argv.slice(2);
assert.ok(['print','json','rpc'].includes(mode));assert.ok(['id','prefix','file'].includes(selector));
const root=await mkdtemp(path.join(os.tmpdir(),'startup-fork-native-'));
console.log(JSON.stringify({root,mode,selector,node:process.versions.node}));
const cwd=path.join(root,'work'),agent=path.join(root,'agent'),sessions=path.join(root,'sessions'),destination=path.join(root,'destination'),trace=path.join(root,'trace.jsonl'),entry=path.join(agent,'state.mjs');
await mkdir(cwd);await mkdir(agent);await writeFile(path.join(agent,'settings.json'),JSON.stringify({quietStartup:true}));
await writeFile(entry,`import assert from 'node:assert/strict';import {appendFile} from 'node:fs/promises';
import {MockProvider,SessionManager,AI_HARNESS_CORE_API_VERSION} from '@ai-harness/core';
const record=async value=>appendFile(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');
class FixtureProvider extends MockProvider {
  calls=0;
  async streamChat(messages,onChunk,onComplete,onError,options){
    try{
      assert.ok(!options?.signal?.aborted);assert.equal(AI_HARNESS_CORE_API_VERSION,1);
      assert.ok(!JSON.stringify(messages).includes('STARTUP_FORK_PRIVATE'));
      const step=this.calls++;
      await record({kind:'provider',step,literal:messages.filter(message=>message.role==='user').at(-1)?.content});
      if(step===0){
        assert.ok(options.tools.some(tool=>tool.name==='state_probe'));
        await onChunk('',{type:'message_start',data:{fixture:true}});
        onComplete?.({content:'',model:'fixture-model',toolCalls:[{id:'fixture-state-call',name:'state_probe',input:{}}],usage:{promptTokens:2,completionTokens:1,totalTokens:3}});
      }else{
        assert.equal(messages.filter(message=>message.role==='tool'&&message.toolCallId==='fixture-state-call').at(-1)?.content,'STATE_TOOL_RESULT');
        await onChunk('STARTUP_FORK_FINISH',{type:'text_delta',data:{fixture:true}});
        onComplete?.({content:'STARTUP_FORK_FINISH',model:'fixture-model',usage:{promptTokens:3,completionTokens:1,totalTokens:4}});
      }
    }catch(error){onError?.(error);}
  }
}
export default api=>{
  assert.equal(api.version,1);
  api.registerProvider('statefixture',{defaultConfig:{model:'fixture-model'},create:config=>new FixtureProvider(config)});
  api.registerTool({name:'state_probe',description:'Read startup fork private state',parameters:{type:'object'},execute:async(_input,context)=>{
    const manager=context.sessionManager,id=context.currentSessionId;
    assert.ok(manager instanceof SessionManager);assert.ok(['startup-native-source','startup-native-fork'].includes(id));
    assert.ok(context.provider instanceof FixtureProvider);assert.equal(context.provider.getProviderType(),'mock');assert.equal(context.providerName,${JSON.stringify(mode==='rpc'?'statefixture':'mock')});assert.equal(context.toolCallId,'fixture-state-call');
    const select=entries=>entries.filter(entry=>entry.type==='custom'&&entry.customType==='fixture:startup').map(entry=>entry.data.revision);
    const rawPrior=select(await manager.getRawEntries(id));
    assert.deepEqual(rawPrior,id==='startup-native-source'?[]:[1],'Startup copy must retain selected raw private state before consulting the active reader.');
    const prior=select(await manager.getActiveBranchEntries(id));assert.deepEqual(prior,rawPrior);
    if(!prior.length)await manager.appendCustomEntry(id,'fixture:startup',{revision:1,private:'STARTUP_FORK_PRIVATE'});
    assert.deepEqual(select(await manager.getActiveBranchEntries(id)),[1]);
    assert.ok(!JSON.stringify(manager.getEffectiveContext(id)).includes('STARTUP_FORK_PRIVATE'));
    await record({kind:'tool',id,prior,revisions:[1],providerName:context.providerName,providerType:context.provider.getProviderType()});
    return {content:'STATE_TOOL_RESULT',details:{selectedState:true}};
  }});
};`);
let active;
async function invoke(round){
  const command=process.env.AIH_STATE_COMMAND;
  const sourceFile=path.join(sessions,'startup-native-source.jsonl');
  const selected=selector==='file'?sourceFile:selector==='prefix'?'startup-native-sou':'startup-native-source';
  const prompt=mode==='rpc'?'state-probe literal':'/state-probe literal';
  const child=spawn(command??process.execPath,[...(command?[]:[process.env.AIH_STATE_CLI??'/app/packages/cli/dist/index.js']),
    '--offline','--approve','--no-context-files','--no-extensions','-e',entry,'--no-builtin-tools','--model','statefixture/fixture-model',
    '--session-dir',round&&selector==='file'?destination:sessions,'--session-id',round?'startup-native-fork':'startup-native-source',
    ...(round?['--fork',selected]:[]),...(mode==='print'?['--print',prompt]:['--mode',mode,...(mode==='json'?[prompt]:[])])],
    {cwd,env:{PATH:process.env.PATH,HOME:path.join(root,'home'),AI_HARNESS_AGENT_DIR:agent,NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
  active=child;let stdout='',stderr='';
  child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});
  const lines=mode==='rpc'?createInterface({input:child.stdout}):undefined;
  lines?.on('line',line=>{const value=JSON.parse(line);if(value.type==='agent_end')child.stdin.end();});
  if(mode==='rpc')child.stdin.write(JSON.stringify({type:'prompt',id:`startup-fork-${round}`,message:prompt})+'\n');else child.stdin.end();
  const timer=setTimeout(()=>child.kill('SIGKILL'),5_000);
  const result=await new Promise(resolve=>child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});}));active=undefined;lines?.close();
  assert.deepEqual(result,{code:0,signal:null},JSON.stringify({result,stdout,stderr}));
  if(mode==='print')assert.equal(stdout.trim(),'STARTUP_FORK_FINISH');
  else{assert.ok(stdout.endsWith('\n'));for(const line of stdout.trim().split('\n'))assert.equal(typeof JSON.parse(line).type,'string');assert.ok(stdout.includes('STARTUP_FORK_FINISH'));}
  assert.ok(!stdout.includes('STARTUP_FORK_PRIVATE'));assert.ok(!stderr.includes('STARTUP_FORK_PRIVATE'));
}
try{
  await invoke(0);
  const sourceFile=path.join(sessions,'startup-native-source.jsonl'),sourceBytes=await readFile(sourceFile),sourceInfo=await stat(sourceFile,{bigint:true});
  await invoke(1);
  const records=(await readFile(trace,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.deepEqual(records.filter(value=>value.kind==='provider').map(value=>value.step),[0,1,0,1]);
  assert.ok(records.filter(value=>value.kind==='provider').every(value=>value.literal===(mode==='rpc'?'state-probe literal':'/state-probe literal')));
  assert.deepEqual(records.filter(value=>value.kind==='tool').map(value=>({id:value.id,prior:value.prior})),[{id:'startup-native-source',prior:[]},{id:'startup-native-fork',prior:[1]}]);
  assert.ok(records.filter(value=>value.kind==='tool').every(value=>value.providerType==='mock'&&value.providerName===(mode==='rpc'?'statefixture':'mock')));
  if(selector==='file'){
    assert.deepEqual(await readFile(sourceFile),sourceBytes);assert.equal((await stat(sourceFile,{bigint:true})).mtimeNs,sourceInfo.mtimeNs);
    assert.ok(!(await readFile(path.join(destination,'startup-native-fork.jsonl'),'utf8')).includes('Session ancestry is incomplete.'));
  }
  await rm(root,{recursive:true,force:true});
  console.log(JSON.stringify({result:'STARTUP_FORK_SESSION_STATE_OK',mode,selector,providerTurns:4,toolCalls:2,sourceAndDestination:true}));
}finally{active?.kill('SIGKILL');}
