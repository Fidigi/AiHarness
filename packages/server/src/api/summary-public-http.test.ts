import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, WorkspacePathError, type Message } from '@ai-harness/core';
import { getProxy, start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';
let root:string,base:string,services:RuntimeServices;
beforeAll(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'aih-summary-http-'));const cwd=path.join(root,'work');await mkdir(cwd);const server=await start({host:'127.0.0.1',port:0,dataDir:path.join(root,'agent'),allowedRoots:[cwd],defaultCwd:cwd,enableMockProvider:true,runtimeServicesFactory:async(proxy,options)=>{services=await createRuntimeServices(proxy,options);return services;}});base=`http://127.0.0.1:${server.port}`;expect((await fetch(base+'/api/sessions')).status).toBe(200);});
afterEach(()=>vi.restoreAllMocks());afterAll(async()=>{await stop();await rm(root,{recursive:true,force:true});});
const source=()=>[
  {role:'user',content:'PUBLIC_USER'},
  {role:'assistant',content:'PUBLIC_ANSWER',blocks:[{type:'text',text:'PUBLIC_RICH'},{type:'reasoning',text:'PRIVATE_THINKING'}],toolCalls:[{id:'lookup',name:'lookup',input:{reasoning:'PUBLIC_TOOL_REASONING',signature:'PUBLIC_TOOL_SIGNATURE'}}],metadata:{signature:'PRIVATE_SIGNATURE'}},
  {role:'tool',toolCallId:'lookup',name:'lookup',content:'PUBLIC_RESULT'},
  {role:'assistant',content:'PUBLIC_DONE'},
];
const request=(route:string,messages:unknown)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'mock',messages})});
it('the summary-only legacy projection preserves public tool traces and rich text, never private replay',async()=>{
  let captured:Message[]=[];const chat=vi.spyOn(MockProvider.prototype,'chat').mockImplementation(async(messages,options)=>{captured=structuredClone(messages);expect(options?.tools).toEqual([]);return{content:'PUBLIC_SUMMARY'};});
  const response=await request('/api/chat/compact',source());expect(response.status).toBe(200);expect(await response.json()).toEqual({summary:'PUBLIC_SUMMARY'});expect(chat).toHaveBeenCalledOnce();
  const text=JSON.stringify(captured);for(const marker of ['PUBLIC_USER','PUBLIC_ANSWER','PUBLIC_RICH','PUBLIC_TOOL_REASONING','PUBLIC_TOOL_SIGNATURE','PUBLIC_RESULT'])expect(text).toContain(marker);
  expect(text).not.toContain('PRIVATE_');expect(captured[1].toolCalls?.[0].input).toEqual({reasoning:'PUBLIC_TOOL_REASONING',signature:'PUBLIC_TOOL_SIGNATURE'});
});
it('does not broaden ordinary legacy chat: its existing role/content-only sanitizer stays unchanged',async()=>{
  let captured:Message[]=[];vi.spyOn(MockProvider.prototype,'streamChat').mockImplementation(async(messages,onChunk,onComplete)=>{captured=structuredClone(messages);await onChunk('Done');onComplete?.({content:'Done'});});
  const response=await request('/api/chat',source());expect(response.status).toBe(200);expect(await response.text()).toContain('Done');expect(captured).toHaveLength(4);
  const text=JSON.stringify(captured);expect(text).toContain('PUBLIC_ANSWER');for(const marker of ['PUBLIC_RICH','PUBLIC_TOOL_REASONING','PUBLIC_TOOL_SIGNATURE','PRIVATE_'])expect(text).not.toContain(marker);
  expect(captured.every(message=>message.blocks===undefined&&message.toolCalls===undefined&&message.metadata===undefined)).toBe(true);
});
it.each(['claude-haiku-4-5','claude-haiku-4-5-20251001','claude-opus-4-5',
  'claude-opus-4-5-20251101','claude-sonnet-4-5','claude-sonnet-4-5-20250929'])(
  'owns compact numeric budgets for %s without caller policy or private summary history',async model=>{
  const cwd=path.join(root,'work'),globalFile=path.join(root,'agent','settings.json'),projectFile=path.join(cwd,'.ai-harness','settings.json');
  const projectId=(await services.workspaceManager.describe(cwd,false)).id,cacheId='summary-provider-cache';
  const previousThinking=services.configurationStore.get('global').thinking,calls:Array<Record<string,unknown>>=[];
  const actualFetch=globalThis.fetch.bind(globalThis);
  const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const url=input instanceof Request?input.url:String(input);
    if(url.startsWith(base+'/'))return actualFetch(input,init);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    calls.push(JSON.parse(String(init?.body)) as Record<string,unknown>);
    return Response.json({id:'summary-budget',type:'message',role:'assistant',model,
      content:[{type:'text',text:'PUBLIC_SUMMARY'}],stop_reason:'end_turn',usage:{input_tokens:3,output_tokens:2}});
  });
  const compact=async(budget:number|'off'|'omitted'|'refused',thinking='low',maxTokens=typeof budget==='number'?Math.min(64000,4096+budget):4096)=>{
    const before=calls.length;
    const response=await fetch(base+'/api/chat/compact',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({provider:'anthropic',messages:source(),cwd:'/caller-cannot-select',projectId:'caller-project',sessionId:cacheId,
        thinkingBudgets:{low:999999},options:{model,maxTokens:64000,...(budget==='omitted'?{}:{thinking}),sessionId:cacheId,
          thinkingBudgets:{low:999999,high:999999}}})});
    if(budget==='refused'){
      expect(response.status).toBe(500);expect(await response.json()).toEqual({error:'Internal server error'});
      expect(calls).toHaveLength(before);return;
    }
    expect(response.status).toBe(200);expect(await response.json()).toEqual({summary:'PUBLIC_SUMMARY'});
    expect(calls).toHaveLength(before+1);
    const call=calls.at(-1)!;expect(call).toMatchObject({model,max_tokens:maxTokens,stream:false});
    if(budget==='omitted')expect(call).not.toHaveProperty('thinking');
    else expect(call.thinking).toEqual(budget==='off'?{type:'disabled'}:{type:'enabled',budget_tokens:budget,display:'summarized'});
    expect(call).not.toHaveProperty('tools');expect(JSON.stringify(call)).not.toContain('PRIVATE_');
    const history=JSON.stringify(call.messages);
    for(const marker of ['PUBLIC_USER','PUBLIC_RICH','PUBLIC_TOOL_REASONING','PUBLIC_TOOL_SIGNATURE','PUBLIC_RESULT','PUBLIC_DONE'])expect(history).toContain(marker);
    expect(history).not.toContain('PUBLIC_ANSWER'); // Native rich text replaces the duplicate plain-content channel.
    expect(JSON.stringify(call.system)).toContain('You are a conversation summarizer.');
  };
  try{
    getProxy().setApiKey('anthropic','disposable-summary-budget-key',undefined,model);
    await services.configurationStore.patch('global',{thinking:'high'});
    await services.trustManager.trust(cwd);await mkdir(path.dirname(projectFile),{recursive:true});
    await writeFile(globalFile,JSON.stringify({thinkingBudgets:{low:1600}}));
    await writeFile(projectFile,JSON.stringify({thinkingBudgets:{low:3000}}));
    await services.configurationStore.patch('session',{thinkingBudgets:{low:9000}},cacheId);
    await compact(3000);
    await services.configurationStore.patch('global',{thinkingBudgets:{low:2200}});
    await services.configurationStore.patch('project',{thinkingBudgets:{high:3500}},projectId);
    await compact(2048);await compact(3500,'high');await compact(3500,'xhigh');await compact(3500,'max');await compact('omitted');
    await services.configurationStore.patch('project',{thinkingBudgets:{high:999999}},projectId);await compact(62976,'high');
    await services.configurationStore.patch('project',{thinkingBudgets:{high:0}},projectId);await compact(1024,'high',4096);
    await services.configurationStore.patch('project',{thinkingBudgets:{low:1}},projectId);await compact('refused');
    await services.configurationStore.patch('project',{thinkingBudgets:{}},projectId);await compact(2048);
    await services.configurationStore.patch('project',{thinkingBudgets:null},projectId);await compact(2200);
    await services.configurationStore.patch('global',{thinkingBudgets:null});await compact(3000);
    await writeFile(projectFile,JSON.stringify({thinkingBudgets:{low:4000}}));await compact(4000);
    await services.trustManager.refuse(cwd);await compact(1600);
    await services.configurationStore.patch('project',{thinkingBudgets:{low:4500}},projectId);await compact(4500);
    await services.configurationStore.patch('project',{thinkingBudgets:null},projectId);
    await services.trustManager.trust(cwd);await compact(4000);
    const unavailable=vi.spyOn(services.workspaceManager,'getDefaultCwd').mockRejectedValue(new WorkspacePathError('OUTSIDE_ALLOWED_ROOTS','Unavailable default'));
    try{await compact(1600);}finally{unavailable.mockRestore();}
    await compact('off','off');expect(calls).toHaveLength(17);
  }finally{
    transport.mockRestore();await services.trustManager.refuse(cwd);
    await rm(globalFile,{force:true});await rm(projectFile,{force:true});
    await services.configurationStore.patch('global',{thinkingBudgets:null,thinking:previousThinking??null});
    await services.configurationStore.patch('project',{thinkingBudgets:null},projectId);
    await services.configurationStore.patch('session',{thinkingBudgets:null},cacheId);
  }
});
it('retains the canonical two-million-byte ceiling before stripping oversized private metadata',async()=>{
  const messages=source();messages[1].metadata={signature:'x'.repeat(2_000_001)};const chat=vi.spyOn(MockProvider.prototype,'chat');
  const response=await request('/api/chat/compact',messages);expect(response.status).toBe(500);expect(await response.json()).toEqual({error:'Internal server error'});expect(chat).not.toHaveBeenCalled();
});
