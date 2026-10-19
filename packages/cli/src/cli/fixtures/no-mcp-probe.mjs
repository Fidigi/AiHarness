import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AI_HARNESS_CORE_API_VERSION } from '@ai-harness/core';

assert.equal(AI_HARNESS_CORE_API_VERSION, 1);
const mode=process.argv[2],scenario=process.argv[3]??'suppressed';
assert(['print','json','rpc','regular','fullscreen'].includes(mode));
assert(['suppressed','control','patterns','modifiers'].includes(scenario));
const selectionScenario=scenario==='patterns'||scenario==='modifiers';
const root=await mkdtemp(path.join(os.tmpdir(),'aih-no-mcp-')),cwd=path.join(root,'project'),agent=path.join(root,'agent'),trace=path.join(root,'trace.jsonl');
const cli=process.env.AIH_NO_MCP_CLI??fileURLToPath(new URL('../../../dist/index.js',import.meta.url));
const command=process.env.AIH_NO_MCP_COMMAND;
const environment={PATH:process.env.PATH,HOME:path.join(root,'home'),AI_HARNESS_AGENT_DIR:agent,AI_HARNESS_EXTENSIONS:'',NO_COLOR:'1',TERM:'xterm-256color'};
const put=async(file,body)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,body);};
const recordCode=`import {appendFileSync} from 'node:fs';const record=value=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');`;
const records=async()=>{const text=await readFile(trace,'utf8').catch(()=> '');return text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));};
let observation=async()=>({});
const wait=async(predicate,label)=>{const end=performance.now()+10_000;while(!await predicate()){if(performance.now()>=end)assert.fail('Native no-MCP fixture deadline: '+label+' '+JSON.stringify(await observation()));await pause(10);}};
let terminal,exited;
try{
 await mkdir(cwd,{recursive:true});
 const server=path.join(root,'mcp-server.mjs');
 await put(server,`${recordCode}
  import {createInterface} from 'node:readline';record({kind:'mcp',pid:process.pid});
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
  input.on('line',line=>{if(Buffer.byteLength(line)>65536)process.exit(2);const request=JSON.parse(line);
   if(request.id===undefined)return;
   if(request.method==='initialize')send(request.id,{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'no-mcp-fixture',version:'1'}});
   else if(request.method==='tools/list')send(request.id,{tools:[{name:'lookup',description:'Read fixture',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]});
   else if(request.method==='tools/call'){record({kind:'effect'});send(request.id,{content:[{type:'text',text:'Fixture result'}]});}
   else if(request.method==='ping')send(request.id,{});
   else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\\n');
  });input.on('close',()=>process.exit(0));`);
 const extension=path.join(root,'probe.mjs');
 await put(extension,`${recordCode}
  export default api=>{record({kind:'factory'});
   api.registerOption('native-probe',{type:'boolean',description:'Contributed flag control',default:false});
   api.registerTool({name:'deferred_docs',description:'Deferred reference docs',exposure:'deferred',parameters:{type:'object'},execute:()=>({content:'docs'})});
   api.registerTool({name:'mcp__ordinary',description:'Ordinary extension, not an MCP source',parameters:{type:'object'},execute:()=>({content:'ordinary'})});
   api.before('before:provider',data=>{record({kind:'turn',flag:api.getOption('native-probe'),tools:(data.options.tools??[]).map(tool=>tool.name).sort()});});
   api.on('agent:end',()=>{record({kind:'end'});});
  };`);
 const settings=enabled=>JSON.stringify({extensions:[`${enabled?'+':'-'}builtin:mcp`],codemode:{mode:'on'},
  ...(scenario==='modifiers'?{defaultTools:[enabled?'ls':'find']}:{}),});
 await put(path.join(agent,'settings.json'),settings(true));
 await put(path.join(cwd,'.ai-harness/settings.json'),settings(true));
 await put(path.join(agent,'mcp.json'),JSON.stringify({version:1,mcpServers:{fixture:{command:process.execPath,args:[server]}}}));
 const args=['--offline','--approve','--no-session','--model','mock/mock-model','--no-context-files','-e',extension,'-e','builtin:mcp',
  ...(scenario==='suppressed'?['--no-mcp']:[]),
  ...(scenario==='patterns'?['--tools','r*,mcp__*,tool_search,codemode,deferred_*','--exclude-tools','*ordinary']:[]),
  ...(scenario==='modifiers'?['--tools','+grep,-read,+read,-read,+mcp__ordinary','--exclude-tools','b*,*ordinary']:[]),'--native-probe'];
 const argv=extra=>[...(command?[]:[cli]),...args,...extra];
 if(mode==='regular'||mode==='fullscreen'){
  assert(scenario==='suppressed'||scenario==='modifiers');
  // Only the test's PTY driver may use the existing explicit harness path;
  // product Core and PATH-bin resolution still belong to the installed consumer.
  const {spawn:spawnPty}=process.env.AIH_TEST_MODULES_ROOT
    ? createRequire(path.join(process.env.AIH_TEST_MODULES_ROOT,'__no_mcp_probe__.cjs'))('node-pty')
    : await import('node-pty');let output='';
  observation=async()=>({exited,records:await records(),outputBytes:Buffer.byteLength(output),outputTail:output.slice(-8192)});
  terminal=spawnPty(command??process.execPath,argv(['--tui-mode',mode,'--theme','dark','--name','no-mcp-probe']),{cwd,env:environment,cols:100,rows:30});
  terminal.onData(text=>{output+=text;assert(Buffer.byteLength(output)<1024*1024,'bounded PTY observation');});terminal.onExit(value=>{exited=value;});
  // Fullscreen redraws include old command history. Observe the latest real
  // clear-screen frame, and require a newly displayed reload result, not an
  // earlier history line or readiness footer echoed while typing /reload.
  const shown=()=>mode==='fullscreen'?output.slice(Math.max(0,output.lastIndexOf('\x1b[2J\x1b[H'))):output;
  const reloadCount=()=>(shown().match(/Reloaded /g)??[]).length;
  const ready=()=>shown().includes('editor ready · Enter send');
  await wait(ready,'initial native readiness');
  const prompt=async count=>{output='';terminal.write('Hello.\r');await wait(async()=> (await records()).filter(row=>row.kind==='end').length===count,'settled native turn');await wait(ready,'settled native readiness');};
  const reload=async enabled=>{await put(path.join(agent,'settings.json'),settings(enabled));await put(path.join(cwd,'.ai-harness/settings.json'),settings(enabled));const previous=mode==='fullscreen'?reloadCount():0;output='';terminal.write('/reload\r');await wait(()=>reloadCount()>previous,'new native reload');await wait(ready,'reloaded native readiness');};
  await prompt(1);await reload(false);await prompt(2);await reload(true);await prompt(3);
  terminal.write('/quit\r');await wait(()=>exited!==undefined,'PTY shutdown');assert.equal(exited.exitCode,0);assert(!exited.signal);
 }else{
  const extra=mode==='print'?['--print','Hello.']:['--mode',mode,...(mode==='rpc'?[]:['Hello.'])];
  const result=await new Promise((resolve,reject)=>{const child=spawn(command??process.execPath,argv(extra),{cwd,env:environment,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
   const timer=setTimeout(()=>child.kill('SIGKILL'),20_000);
   child.stdout.setEncoding('utf8').on('data',text=>{stdout+=text;assert(Buffer.byteLength(stdout)<1024*1024,'bounded stdout');});
   child.stderr.setEncoding('utf8').on('data',text=>{stderr+=text;assert(Buffer.byteLength(stderr)<1024*1024,'bounded stderr');});
   child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
   child.stdin.end(mode==='rpc'?JSON.stringify({type:'prompt',id:'fixture',message:'Hello.'})+'\n':'');
  });
  assert.equal(result.code,0,result.stderr);assert.equal(result.signal,null);assert(result.stdout.trim());assert.equal(result.stderr,'');
  if(mode!=='print'){const rows=result.stdout.trim().split('\n').map(line=>JSON.parse(line));assert(rows.every(row=>typeof row.type==='string'));if(mode==='rpc')assert(rows.some(row=>row.type==='response'&&row.id==='fixture'&&row.success===true));}
 }
 const seen=await records(),turns=seen.filter(row=>row.kind==='turn');assert.equal(turns.length,mode==='regular'||mode==='fullscreen'?3:1);
 for(const [index,turn] of turns.entries()){
  assert.equal(turn.flag,true);
  if(selectionScenario){
   const expected=scenario==='patterns'?['read','codemode','tool_search','mcp__fixture__lookup']
    :['grep',index===1?'find':'ls','codemode','tool_search','mcp__fixture__lookup'];
   assert.deepEqual(turn.tools,[...expected].sort(),'concrete CLI selection after defaults/reload/exclusions');
  }else{for(const name of ['read','codemode','tool_search','mcp__ordinary'])assert(turn.tools.includes(name),name+' remains enabled');assert.equal(turn.tools.includes('mcp__fixture__lookup'),scenario==='control');}
 }
 const started=seen.filter(row=>row.kind==='mcp');assert.equal(started.length,scenario==='suppressed'?0:1);assert.equal(seen.filter(row=>row.kind==='effect').length,0);
 for(const row of started)await wait(()=>{try{process.kill(row.pid,0);return false;}catch{return true;}},'native MCP child cleanup');
 console.log(selectionScenario?'native tool selection OK':'native no-MCP OK');
}finally{if(terminal&&!exited)terminal.kill();await rm(root,{recursive:true,force:true});}
