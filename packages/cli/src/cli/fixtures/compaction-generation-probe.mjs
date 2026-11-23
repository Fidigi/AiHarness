import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {JsonlSessionStore,SessionManager,prepareCompactionContext} from '@ai-harness/core';
const cli=process.env.AIH_CLI_COMPACTION_CLI??fileURLToPath(new URL('../../../dist/index.js',import.meta.url));
const selected=process.argv[2],modes=['print','json'],kinds=['valid','exact-output-bound','length-capped','pending-tools','over-output-bound','over-input-bound'];
assert.ok(modes.some(mode=>kinds.some(kind=>selected===mode+'/'+kind)));
const root=await mkdtemp(path.join(os.tmpdir(),'cli-auto-compaction-generation-')),rows=[];
console.log(JSON.stringify({root,node:process.versions.node,phase:'setup'}));
const started=performance.now(),mark=phase=>console.log(JSON.stringify({phase,elapsedMs:Math.round(performance.now()-started)}));
const assertion='Real CLI print and JSON automatic owners must refuse incomplete/tool-producing or over-16384-byte summaries and over-2000000-byte canonical prefixes before summary provider work, conserving native history and complete exact-bound controls.';
for(const mode of modes)for(const kind of kinds){
 if(selected!==mode+'/'+kind)continue;
 const dir=path.join(root,`${mode}-${kind}`),cwd=path.join(dir,'work'),agent=path.join(dir,'agent'),sessions=path.join(dir,'sessions');
 await mkdir(cwd,{recursive:true});await mkdir(agent);const requests=[],sockets=new Set();let child,serverError,stdout='',stderr='';
 const content=kind==='exact-output-bound'?'X'.repeat(16384):kind==='over-output-bound'?'X'.repeat(16385):'CLI_AUTO_OWNED_SUMMARY';
 const server=createServer(async(req,res)=>{try{
  let wire='';for await(const chunk of req){wire+=chunk;assert.ok(Buffer.byteLength(wire)<=8_000_000);}
  assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');const body=JSON.parse(wire);requests.push(body);
  const usage={prompt_tokens:23,completion_tokens:3,total_tokens:26};
  if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta:{role:'assistant',content:'Done'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta:{},finish_reason:'stop'}],usage})}\n\ndata: [DONE]\n\n`);}
  else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'fixture',object:'chat.completion',model:'fixture-model',choices:[{index:0,message:{role:'assistant',content,...(kind==='pending-tools'?{tool_calls:[{id:'pending-summary-tool',type:'function',function:{name:'must_not_run',arguments:'{}'}}]}:{})},finish_reason:kind==='length-capped'?'length':kind==='pending-tools'?'tool_calls':'stop'}],usage}));}
 }catch(error){serverError=String(error);res.writeHead(500);res.end('Fixture rejected request');}});
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(path.join(agent,'settings.json'),JSON.stringify({quietStartup:true,sessionDir:sessions,enabledModels:['local/*'],compaction:{enabled:true,reserveTokens:30000,keepRecentTokens:1000,modelOverrides:{'local/fixture-model':{reserveTokens:30000,keepRecentTokens:1000}}}}));
  mark('seed-history');
  // Seed the same history in one public durable create; append throughput is not under test.
  const seedMessages=Array.from({length:kind==='over-input-bound'?50:4},(_,index)=>({id:`seed-${index}`,timestamp:new Date(index),...(index?{parentMessageId:`seed-${index-1}`}:{}),role:index%2?'assistant':'user',content:kind==='over-input-bound'?'PUBLIC_CONTEXT_'.repeat(3600):'x'.repeat(110000)}));
  const manager=new SessionManager({store:new JsonlSessionStore(sessions)}),session=await manager.create({title:'CLI automatic generation',cwd,messages:seedMessages});
  mark('prepare-context');
  manager.setCompactionSettings({enabled:true,reserveTokens:30000,keepRecentTokens:1000});
  const preparation=await prepareCompactionContext(manager,session.id,'threshold');assert.ok(preparation);const sourcePrefixBytes=Buffer.byteLength(JSON.stringify(preparation.toCompact));if(kind==='over-input-bound')assert.ok(sourcePrefixBytes>2000000);
  const before=await manager.getRawEntries(session.id);await writeFile(path.join(dir,'before.json'),JSON.stringify(before));
  mark('cli');
  child=spawn(process.execPath,[cli,...(mode==='print'?['--print']:['--mode','json']),'--offline','--no-approve','--no-context-files','--no-tools','--model','local/fixture-model','--session-id',session.id,'NextHeadless'],{cwd,env:{PATH:process.env.PATH,HOME:path.join(dir,'home'),AI_HARNESS_AGENT_DIR:agent,LOCAL_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,LOCAL_MODEL:'fixture-model',NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
  child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});child.stdin.end();
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);const exit=await new Promise(resolve=>child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});}));
  mark('verify-history');
  await writeFile(path.join(dir,'stdout.txt'),stdout);await writeFile(path.join(dir,'stderr.txt'),stderr);await writeFile(path.join(dir,'exit.json'),JSON.stringify(exit));await writeFile(path.join(dir,'requests.json'),JSON.stringify(requests));
  assert.deepEqual(exit,{code:0,signal:null},JSON.stringify({root,mode,kind,exit,stderr}));assert.equal(serverError,undefined);
  if(mode==='print')assert.equal(stdout,'Done\n');else{const events=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.ok(events.some(e=>e.type==='agent_end'));assert.ok(events.every(e=>typeof e.type==='string'));assert.ok(!events.some(e=>e.type==='error'));}
  const restored=new SessionManager({store:new JsonlSessionStore(sessions)});await restored.loadFromStore(session.id);const after=await restored.getRawEntries(session.id);await writeFile(path.join(dir,'after.json'),JSON.stringify(after));
  const rawConserved=before.every(entry=>after.some(value=>value.id===entry.id&&JSON.stringify(value)===JSON.stringify(entry))),published=after.filter(entry=>entry.type==='compaction').length,summaryCalls=requests.filter(request=>!request.stream),ordinaryCalls=requests.filter(request=>request.stream),valid=['valid','exact-output-bound'].includes(kind);
  if(kind==='over-input-bound')assert.ok(Buffer.byteLength(JSON.stringify(ordinaryCalls[0].messages))>2000000);
  const ok=rawConserved&&published===(valid?1:0)&&ordinaryCalls.length===1&&(kind==='over-input-bound'?summaryCalls.length===0:summaryCalls.length>=1);
  const row={node:process.versions.node,mode,kind,sourceMessages:before.filter(entry=>entry.type==='message').length,sourcePrefixBytes,outputBytes:Buffer.byteLength(content),summaryCalls:summaryCalls.length,summaryInputBytes:summaryCalls.map(request=>Buffer.byteLength(JSON.stringify(request.messages))),ordinaryCalls:ordinaryCalls.length,published,rawConserved,declaredTools:summaryCalls[0]?.tools?.length??0,maxTokens:summaryCalls[0]?.max_tokens,exit:exit.code,ok};rows.push(row);await writeFile(path.join(dir,'observation.json'),JSON.stringify(row,null,2));console.log(JSON.stringify(row));
 }finally{if(child&&child.exitCode===null)child.kill('SIGKILL');for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}
const bad=rows.filter(row=>!row.ok).length;await writeFile(path.join(root,'aggregate.json'),JSON.stringify({root,node:process.versions.node,observations:rows.length,bad,assertion,rows},null,2));console.log(JSON.stringify({root,node:process.versions.node,observations:rows.length,bad,assertion}));assert.equal(rows.length,1);assert.equal(bad,0,assertion);mark('cleanup');await rm(root,{recursive:true,force:true});
console.log(JSON.stringify({result:'CLI_AUTOMATIC_GENERATION_OK',scenario:selected,node:process.versions.node}));
