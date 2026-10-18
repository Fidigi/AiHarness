import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import * as Core from '@ai-harness/core';
const [mode,kind]=process.argv.slice(2);
const modes=['core-branch','sdk-auto','print-auto','json-auto','rpc-manual','rpc-auto','rpc-branch','regular','fullscreen','server-agent','server-proxy','server-auto'];
assert.ok(modes.includes(mode));assert.ok(['private','ordinary'].includes(kind));
const root=await mkdtemp(path.join(os.tmpdir(),'aih-summary-wire-')),cwd=path.join(root,'work'),agent=path.join(root,'agent'),sessions=path.join(agent,'sessions');
await mkdir(cwd);await mkdir(agent);
const requests=[],sockets=new Set();let child,terminal,terminalExit,serverApi,fixtureError;
const transport=createServer(async(req,res)=>{try{
  let text='';for await(const chunk of req){text+=chunk;assert.ok(Buffer.byteLength(text)<=8_000_000);}
  assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');const body=JSON.parse(text);requests.push(body);
  const usage={prompt_tokens:23,completion_tokens:3,total_tokens:26};
  res.writeHead(200,{'content-type':body.stream?'text/event-stream':'application/json'});
  if(body.stream)res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:'Done'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage})}\n\ndata: [DONE]\n\n`);
  else res.end(JSON.stringify({id:'summary',model:'fixture-model',choices:[{index:0,message:{role:'assistant',content:'PUBLIC_SUMMARY'},finish_reason:'stop'}],usage}));
}catch(error){fixtureError=error;if(!res.headersSent)res.writeHead(500);res.end('Fixture rejected request');}});
transport.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
const wait=async (predicate,timeoutMs=10_000)=>{const until=Date.now()+timeoutMs;while(Date.now()<until){const result=await predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('New summary fixture observation deadline exceeded.');};
try{
  await new Promise(resolve=>transport.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${transport.address().port}/v1`;
  const settings={quietStartup:true,sessionDir:sessions,enabledModels:['local/*'],compaction:{enabled:true,reserveTokens:30000,keepRecentTokens:4000,modelOverrides:{'local/fixture-model':{reserveTokens:30000,keepRecentTokens:4000}}}};
  await writeFile(path.join(agent,'settings.json'),JSON.stringify(settings));
  const store=new Core.JsonlSessionStore(sessions),manager=new Core.SessionManager({store});
  const session=await manager.create({cwd,title:'summary-source',autoCompaction:true,model:'fixture-model',providerConfig:{type:'local',model:'fixture-model',baseUrl}});
  const automatic=mode.endsWith('-auto'),branch=mode.endsWith('-branch'),bulk=branch?1000:120000;
  const answer='PUBLIC_ANSWER '+ 'a'.repeat(branch?1000:110000), source=[
    {role:'user',content:'PUBLIC_USER '+ 'u'.repeat(bulk)},
    {role:'assistant',content:answer,blocks:[{type:'text',text:kind==='private'?'PUBLIC_RICH_BLOCK':answer},...(kind==='private'?[{type:'reasoning',text:'PRIVATE_THINKING'}]:[])],toolCalls:[{id:'lookup',name:'lookup',input:{path:'PUBLIC_PATH',reasoning:'PUBLIC_TOOL_REASONING',signature:'PUBLIC_TOOL_SIGNATURE'}}],...(kind==='private'?{metadata:{signature:'PRIVATE_SIGNATURE',replayPayload:{thought:'PRIVATE_SIGNED_PAYLOAD'}}}:{})},
    {role:'tool',name:'lookup',toolCallId:'lookup',content:'PUBLIC_RESULT '+ 'r'.repeat(bulk),blocks:[{type:'tool_result',toolCallId:'lookup',content:'PUBLIC_RESULT',...(kind==='private'?{fullContent:'PRIVATE_FULL_RESULT',downloadUrl:'/private/PRIVATE_DOWNLOAD'}:{})}]},
    {role:'assistant',content:'PUBLIC_AFTER_TOOL '+ 'f'.repeat(bulk)},
    {role:'user',content:'RETAINED_USER '+ 'k'.repeat(5000)},
    {role:'assistant',content:'RETAINED_ANSWER '+ 'k'.repeat(5000)},
  ];
  for(const message of source)await manager.addMessage(session.id,message,{skipAutoCompaction:true});
  manager.setCompactionSettings(settings.compaction);
  const before=await manager.getRawEntries(session.id),first=manager.get(session.id).messages[0].id;
  const provider=new Core.LocalProvider({type:'local',baseUrl,model:'fixture-model'});
  if(!branch){const expected=Core.prepareCompactionContext(manager,session.id,'manual');assert.ok(expected);const kept=JSON.stringify(expected.keptMessages);assert.ok(kept.includes('RETAINED_USER'));assert.ok(kept.includes('RETAINED_ANSWER'));}
  if(mode==='core-branch'){
    const adapter=Core.createProviderBranchSummarizer(provider);
    await manager.navigateTree(session.id,first,{summarize:true,...adapter});
  }else if(mode==='sdk-auto'){
    const {createAgentSession}=Core;let callbacks=0;
    const handle=await createAgentSession({cwd,allowedRoots:[cwd],provider:{kind:'instance',name:'local',provider},store,session:{kind:'resume',id:session.id},isProjectTrusted:async()=>true,
      compaction:{settings:settings.compaction,summarize:async(_id,entries,_kept,signal)=>{
        callbacks++;if(kind==='private')assert.ok(JSON.stringify(entries).includes('PRIVATE_THINKING')); // The existing trusted callback still owns canonical context.
        const messages=Core.getSummaryModelMessages(Core.compactionMessagesFromEntries(entries));
        const response=await provider.chat(messages,{tools:[],maxTokens:4096,signal});return response.content;
      }}});
    try{assert.equal(handle.capabilities.mcpHosting,false);assert.equal((await handle.promptAndWait('Next')).phase,'completed');assert.equal(callbacks,1);}finally{await handle.dispose();}
  }else if(mode.startsWith('server-')){
    process.env.AI_HARNESS_AGENT_DIR=agent;process.env.LOCAL_BASE_URL=baseUrl;process.env.LOCAL_MODEL='fixture-model';
    serverApi=await import(process.env.AIH_SUMMARY_SERVER_ENTRY??new URL('../../../../server/dist/index.js',import.meta.url).href);
    const server=await serverApi.start({port:0,host:'127.0.0.1',dataDir:agent,allowedRoots:[cwd],defaultCwd:cwd});
    const request=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${server.port}${route}`,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const text=await response.text();assert.ok(response.ok,JSON.stringify({route,status:response.status,text}));return JSON.parse(text);};
    await request('/api/sessions');
    await request('/api/config',{type:'local',baseUrl,model:'fixture-model'});
    if(mode==='server-agent')await request(`/api/agent/sessions/${session.id}/compact`,{provider:'local',model:'fixture-model'});
    else if(mode==='server-proxy'){
      const messages=Core.compactionMessagesFromEntries(manager.getEffectiveContext(session.id)).slice(0,4);
      assert.equal((await request('/api/chat/compact',{provider:'local',messages})).summary,'PUBLIC_SUMMARY');
    }else{
      await request('/api/workspaces/trust',{cwd,confirm:true});
      const {run}=await request('/api/agent/runs',{sessionId:session.id,cwd,provider:'local',model:'fixture-model',input:'Next',toolPreset:'chat-only',autoCompaction:true});
      const settled=await wait(async()=>{const value=await request(`/api/agent/runs/${run.id}`);return ['completed','failed','stopped'].includes(value.phase)&&value;});
      assert.equal(settled.phase,'completed',JSON.stringify(settled));
    }
  }else{
    const env={PATH:process.env.PATH,HOME:path.join(root,'home'),AI_HARNESS_AGENT_DIR:agent,LOCAL_BASE_URL:baseUrl,LOCAL_MODEL:'fixture-model',NO_COLOR:'1'};
    const executable=process.env.AIH_SUMMARY_COMMAND??process.execPath;
    const args=['--offline','--no-approve','--no-extensions','--no-context-files','--no-tools','--model','local/fixture-model','--session-id',session.id];
    const cli=process.env.AIH_SUMMARY_COMMAND?[]:[fileURLToPath(new URL('../../../dist/index.js',import.meta.url))];
    if(['regular','fullscreen'].includes(mode)){
      const {spawn:spawnPty}=await import(process.env.AIH_TEST_PTY_MODULE??'node-pty');let output='';
      terminal=spawnPty(executable,[...cli,...args,'--verbose','--tui-mode',mode],{cwd,env:{...env,TERM:'xterm-256color'},cols:240,rows:45});terminal.onData(text=>{output+=text;});terminal.onExit(value=>{terminalExit=value;});
      const visible=()=>stripVTControlCharacters(output);
      await wait(()=>visible().includes(mode==='regular'?'summary-source: ':'editor ready · Enter send'));
      output='';terminal.write('/compact\r');await wait(()=>visible().includes('Compacted'));
      terminal.write('/quit\r');await wait(()=>terminalExit);assert.equal(terminalExit.exitCode,0,JSON.stringify({terminalExit,output}));assert.equal(terminalExit.signal??0,0);
    }else{
      const rpc=mode.startsWith('rpc-'),records=[];let stdout='',stderr='',buffer='',problem;
      child=spawn(executable,[...cli,...args,...(mode==='print-auto'?['--print']:['--mode',rpc?'rpc':'json']),...(rpc?[]:['Next'])],{cwd,env,stdio:['pipe','pipe','pipe']});
      child.stdout.setEncoding('utf8').on('data',text=>{stdout+=text;if(!rpc)return;buffer+=text;
        while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{
          const record=JSON.parse(line);records.push(record);
          if(record.type==='response'&&record.id==='work'){assert.equal(record.success,true,JSON.stringify(record));if(!automatic)child.stdin.write(JSON.stringify({type:'get_messages',id:'barrier'})+'\n');}
          if(record.type==='agent_settled')child.stdin.write(JSON.stringify({type:'get_messages',id:'barrier'})+'\n');
          if(record.type==='response'&&record.id==='barrier')child.stdin.end();
        }catch(error){problem=error;child.stdin.end();}}
      });
      child.stderr.setEncoding('utf8').on('data',text=>{stderr+=text;});child.stdin.on('error',error=>{if(error.code!=='EPIPE')problem=error;});
      if(rpc)child.stdin.write(JSON.stringify(mode==='rpc-manual'?{type:'compact',id:'work'}:branch?{type:'navigate_tree',id:'work',entryId:first,summarize:true}:{type:'prompt',id:'work',message:'Next'})+'\n');else child.stdin.end();
      const timer=setTimeout(()=>child.kill('SIGKILL'),18_000);
      const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
      assert.deepEqual(exit,{code:0,signal:null},JSON.stringify({exit,stdout,stderr}));assert.equal(problem,undefined);assert.equal(stderr,'');
      if(mode==='print-auto')assert.equal(stdout,'Done\n');else{const lines=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.ok(lines.every(record=>typeof record.type==='string'));if(mode==='json-auto')assert.equal(lines[0].version,3);}
    }
  }
  assert.equal(fixtureError,undefined);const summaries=requests.filter(request=>!request.stream);
  assert.equal(summaries.length,1,JSON.stringify({mode,count:summaries.length}));assert.equal(requests.filter(request=>request.stream).length,automatic?1:0);
  const transcript=JSON.stringify(summaries[0]);
  for(const marker of ['PUBLIC_ANSWER','PUBLIC_PATH','PUBLIC_TOOL_REASONING','PUBLIC_TOOL_SIGNATURE','PUBLIC_RESULT',...(!branch?['PUBLIC_USER']:[]),...(kind==='private'?['PUBLIC_RICH_BLOCK']:[])])assert.ok(transcript.includes(marker),marker);
  for(const marker of ['PRIVATE_THINKING','PRIVATE_SIGNATURE','PRIVATE_SIGNED_PAYLOAD','PRIVATE_FULL_RESULT','PRIVATE_DOWNLOAD',...(!branch?['RETAINED_USER','RETAINED_ANSWER']:[])])assert.ok(!transcript.includes(marker),marker);
  assert.deepEqual(summaries[0].tools??[],[]);
  assert.equal(summaries[0].max_tokens??summaries[0].max_completion_tokens,4096);
  // Keep this synthetic ASCII request below the CLI's 128k reference window
  // minus its actual requested output, rather than relying on an unlimited stub.
  assert.ok(Buffer.byteLength(JSON.stringify(summaries[0].messages))<=4*(128000-4096));
  const restored=new Core.SessionManager({store:new Core.JsonlSessionStore(sessions)});await restored.loadFromStore(session.id);const after=await restored.getRawEntries(session.id);
  assert.ok(before.every(entry=>after.some(value=>value.id===entry.id&&JSON.stringify(value)===JSON.stringify(entry))));
  if(branch)assert.ok(after.some(entry=>entry.type==='branch_summary'&&entry.summary==='PUBLIC_SUMMARY'));
  else if(mode==='server-proxy')assert.deepEqual(after,before);
  else assert.equal(after.filter(entry=>entry.type==='compaction').length,1);
  console.log('summary transcript OK');
}finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;}
  if(terminal&&!terminalExit){terminal.kill();await wait(()=>terminalExit,2000);}if(serverApi)await serverApi.stop();
  for(const socket of sockets)socket.destroy();await new Promise(resolve=>transport.close(resolve));await rm(root,{recursive:true,force:true});
}
