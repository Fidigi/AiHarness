import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentToolLoadout, runCodemode, SessionManager, JsonlSessionStore } from '@ai-harness/core';

const [mode, scenario] = process.argv.slice(2);
assert.ok(['core','print','json','rpc'].includes(mode));
assert.ok(['freeze','globals','error','schema','options','output',...(mode==='core'?['deadline','abort']:[])].includes(scenario));
const root=await mkdtemp(path.join(os.tmpdir(),'aih-intrinsics-')), cwd=path.join(root,'work'), agent=path.join(root,'agent'), sessions=path.join(root,'sessions'), calls=path.join(root,'calls');
const schema={type:'object',required:['path'],properties:{path:{type:'string',enum:['requested','fail'],minLength:1,maxLength:100},optional:{type:'array',maxItems:2,items:{type:'integer',minimum:0,maximum:5}}},additionalProperties:false};
const sources={
  freeze:`for(const name of ['Object','Array','Function','Promise','JSON','Math','Reflect','Map','Set','Error']) { const value=globalThis[name]; if(!Object.isFrozen(value)||value.prototype&&!Object.isFrozen(value.prototype))throw new Error('Mutable intrinsic'); }
    if(Reflect.set(Object.prototype,'toJSON',()=>({path:'forged'})))throw new Error('Mutable prototype'); store('safe',42); return await tools.lookup({path:'requested'});`,
  globals:`globalThis.JSON={stringify:()=>'{}',parse:()=>'forged'}; globalThis.Object={keys:()=>[],assign:()=>({})}; globalThis.Error=function(){throw 'forged'}; store('safe',42); return await tools.lookup({path:'requested'});`,
  error:`store('rollback',1); await tools.lookup({path:'fail'});`,
  schema:`return (await describeTool('lookup')).parameters;`,
  options:`await tools.lookup({path:'requested'});`,
  output:`text('x'.repeat(66000));`,
  deadline:`store('rollback',1); /(a+)+$/.test('a'.repeat(10000)+'!');`,
  abort:`store('rollback',1); await tools.lookup({path:'requested'});`,
};
const input={code:sources[scenario],...(scenario==='options'?{options:{timeoutMs:1}}:{})};
let child;
try {
  await mkdir(cwd);await mkdir(agent);
  let result;
  if(mode==='core') {
    let started; const admission=new Promise(resolve=>{started=resolve;});
    let nestedSignal;
    const execute=async(_name,input,_context,signal)=>{
      nestedSignal=signal;await appendFile(calls,JSON.stringify(input)+'\n');started();
      if(scenario==='abort')return new Promise(()=>{});
      if(input.path==='fail')throw new Error('Controlled nested failure.');
      assert.deepEqual(input,{path:'requested'});return{content:'document'};
    };
    const tools=()=>[{name:'lookup',extensionId:'fixture',description:'Exact lookup',parameters:schema}];
    if(scenario==='options') {
      const loadout=createAgentToolLoadout({staticTools:tools(),codemode:{enabled:true}});
      await assert.rejects(loadout.executeCodemode(input,{},execute),/Invalid or disabled codemode input\./);
      result={isError:true,content:'Invalid or disabled codemode input.'};
    } else {
      const controller=new AbortController();
      const work=runCodemode({code:input.code,tools,execute,context:{},signal:controller.signal,...(scenario==='deadline'?{limits:{timeoutMs:200}}:{})});
      if(scenario==='abort') {await admission;controller.abort();}
      result=await work;
      if(scenario==='abort')assert.equal(nestedSignal.aborted,true);
    }
  } else {
    const extension=path.join(root,'provider.mjs');
    await writeFile(extension,`import { AiProvider } from ${JSON.stringify(import.meta.resolve('@ai-harness/core'))};import{appendFile}from'node:fs/promises';
      class FixtureProvider extends AiProvider {
        validateConfig(){return true;} async chat(){throw new Error('Unexpected chat');}
        async streamChat(messages,_chunk,complete,_error,options){
          if(options.tools.map(tool=>tool.name).join(',')!=='codemode')throw new Error('Unexpected direct declarations');
          if(messages.some(message=>message.role==='tool')){complete({content:'codemode checked'});return;}
          complete({content:'',toolCalls:[{id:'sandbox',name:'codemode',input:${JSON.stringify(input)}}]});
        }
      }
      export default api=>{
        api.registerTool({name:'lookup',description:'Exact lookup',exposure:'codemode',parameters:${JSON.stringify(schema)},execute:async input=>{
          await appendFile(${JSON.stringify(calls)},JSON.stringify(input)+'\\n');
          if(input.path==='fail')throw new Error('Controlled nested failure.');
          if(JSON.stringify(input)!=='{"path":"requested"}')throw new Error('Forged input');return{content:'document'};
        }});
        api.registerProvider('intrinsics-fixture',{defaultConfig:{model:'fixture'},create:config=>new FixtureProvider(config)});
      };`);
    const args=['--offline','--approve','--no-extensions','-e','builtin:codemode','-e',extension,'--no-context-files','--tools','codemode,lookup',
      '--model','intrinsics-fixture/fixture','--session-dir',sessions,'--session-id','intrinsics',...(mode==='print'?['--print']:['--mode',mode]),...(mode==='rpc'?[]:['Question'])];
    child=spawn(process.env.AIH_CODEMODE_INTRINSICS_COMMAND??process.execPath,process.env.AIH_CODEMODE_INTRINSICS_COMMAND?args:[fileURLToPath(new URL('../../../dist/index.js',import.meta.url)),...args],
      {cwd,env:{PATH:process.env.PATH,HOME:path.join(root,'home'),AI_HARNESS_AGENT_DIR:agent,NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',text=>{stdout+=text;});child.stderr.setEncoding('utf8').on('data',text=>{stderr+=text;});
    child.stdin.end(mode==='rpc'?JSON.stringify({type:'prompt',id:'turn',message:'Question'})+'\n':'');
    const timer=setTimeout(()=>child.kill('SIGKILL'),18_000);
    const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
    assert.deepEqual(exit,{code:0,signal:null},JSON.stringify({exit,stdout,stderr}));assert.equal(stderr,'');
    if(mode==='print')assert.equal(stdout,'codemode checked\n');
    else {const records=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.ok(records.every(record=>typeof record.type==='string'));
      assert.equal(records.filter(record=>record.type==='agent_settled').length,1);if(mode==='json')assert.equal(records[0].version,3);}
    const manager=new SessionManager({store:new JsonlSessionStore(sessions)});await manager.loadFromStore('intrinsics');
    const messages=(await manager.getRawEntries('intrinsics')).filter(entry=>entry.type==='message'&&entry.role==='tool');
    assert.equal(messages.length,1);result={...messages[0],details:messages[0].metadata?.codemode};
  }
  const failed=['error','options','output','deadline','abort'].includes(scenario);
  assert.equal(Boolean(result.isError),failed,JSON.stringify(result));
  if(!failed) {
    if(scenario==='schema')assert.deepEqual(JSON.parse(result.content.split('\n').slice(1).join('\n')),schema);
    else {assert.match(result.content,/\ndocument$/);assert.deepEqual(result.details.store,{safe:42});}
  } else {
    assert.equal(result.details?.store,undefined);
    const message={error:'Controlled nested failure.',options:'Invalid or disabled codemode input.',output:'Script output limit exceeded.',deadline:'Codemode deadline exceeded.',abort:'Codemode was aborted.'}[scenario];
    assert.ok(result.content.includes(message),JSON.stringify(result));
  }
  if(scenario!=='options') {assert.equal(result.details.engine,'QuickJS');assert.ok(result.details.durationMs>=0);}
  const invoked=(await readFile(calls,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.deepEqual(invoked,['freeze','globals','error','abort'].includes(scenario)?[{path:scenario==='error'?'fail':'requested'}]:[]);
  console.log('codemode intrinsics OK');
} finally {if(child&&child.exitCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
