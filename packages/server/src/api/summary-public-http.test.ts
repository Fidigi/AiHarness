import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, type Message } from '@ai-harness/core';
import { start, stop } from '../index.js';
let root:string,base:string;
beforeAll(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'aih-summary-http-'));const cwd=path.join(root,'work');await mkdir(cwd);const server=await start({host:'127.0.0.1',port:0,dataDir:path.join(root,'agent'),allowedRoots:[cwd],defaultCwd:cwd,enableMockProvider:true});base=`http://127.0.0.1:${server.port}`;expect((await fetch(base+'/api/sessions')).status).toBe(200);});
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
it('retains the canonical two-million-byte ceiling before stripping oversized private metadata',async()=>{
  const messages=source();messages[1].metadata={signature:'x'.repeat(2_000_001)};const chat=vi.spyOn(MockProvider.prototype,'chat');
  const response=await request('/api/chat/compact',messages);expect(response.status).toBe(500);expect(await response.json()).toEqual({error:'Internal server error'});expect(chat).not.toHaveBeenCalled();
});
