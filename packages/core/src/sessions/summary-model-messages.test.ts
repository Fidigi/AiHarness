import { describe, expect, it } from 'vitest';
import type { Message } from '../types/index.js';
import { getSummaryModelMessages } from './summary-model-messages.js';
import { prepareBranchSummary } from './branch-summarization.js';
import type { SessionEntry } from './session-manager.js';
const message = (changes: Partial<Message> = {}): Message => ({ id:'m', role:'assistant', content:'PUBLIC_ANSWER', timestamp:new Date(0), ...changes });

describe('summary-provider projection, distinct from canonical context', () => {
  it('omits private replay/metadata/reasoning while preserving public tool JSON literally', () => {
    const input=[message({ metadata:{signature:'PRIVATE_SIGNATURE',internal:'PRIVATE_STATE'},blocks:[
      {type:'reasoning',text:'PRIVATE_THINKING'}, {type:'text',text:'PUBLIC_ANSWER'},
      {type:'tool_call',id:'call',name:'lookup',input:{reasoning:'PUBLIC_REASONING_FIELD',signature:'PUBLIC_SIGNATURE_FIELD',toJSON:'PUBLIC_DATA'}},
    ]})];
    const before=structuredClone(input), projected=getSummaryModelMessages(input), text=JSON.stringify(projected);
    for(const marker of ['PRIVATE_SIGNATURE','PRIVATE_STATE','PRIVATE_THINKING'])expect(text).not.toContain(marker);
    for(const marker of ['PUBLIC_ANSWER','PUBLIC_REASONING_FIELD','PUBLIC_SIGNATURE_FIELD','PUBLIC_DATA'])expect(text).toContain(marker);
    expect(input).toEqual(before);expect(projected[0].blocks?.map(block=>block.type)).toEqual(['text','tool_call']);
  });
  it('omits retained full results/download links but keeps public results, commands and outcomes', () => {
    const projected=getSummaryModelMessages([message({role:'tool',toolCallId:'call',name:'lookup',isError:true,blocks:[
      {type:'tool_result',toolCallId:'call',content:'PUBLIC_RESULT',fullContent:'PRIVATE_FULL',downloadUrl:'/private/download',isError:true,truncated:true},
      {type:'command',command:'public command',cwd:'/public',output:'PUBLIC_OUTPUT',status:'failed',exitCode:7,downloadUrl:'/private/command'},
    ]})]);
    const text=JSON.stringify(projected);expect(text).toContain('PUBLIC_RESULT');expect(text).toContain('PUBLIC_OUTPUT');
    expect(text).not.toContain('PRIVATE_FULL');expect(text).not.toContain('/private');
    expect(projected[0]).toMatchObject({role:'tool',toolCallId:'call',name:'lookup',isError:true});
  });
  it.each([['','rich','rich'],['same','same','same'],['compat','rich','compat\nrich'],['prefix','prefix rich','prefix rich'],['prefix rich','prefix','prefix rich']])('preserves compatibility/rich text %s/%s', (content,rich,expected) => {
    expect(getSummaryModelMessages([message({content,blocks:[{type:'text',text:rich}]})])[0].content).toBe(expected);
  });
  it('returns independently owned public arrays, dates and nested input', () => {
    const input=[message({toolCalls:[{id:'call',name:'lookup',input:{path:'requested'}}]})];
    const projected=getSummaryModelMessages(input);(projected[0].toolCalls![0].input as {path:string}).path='changed';projected[0].timestamp.setFullYear(2030);
    expect(input[0].toolCalls![0].input).toEqual({path:'requested'});expect(input[0].timestamp.getTime()).toBe(0);
  });
  it('keeps original canonical admission even when omitted reasoning would otherwise hide oversize data', () => {
    expect(()=>getSummaryModelMessages([message({blocks:[{type:'reasoning',text:'x'.repeat(2_000_001)}]})])).toThrow('Compaction transcript is invalid');
  });
  it('validates the projected result after retaining differing rich/compatibility views', () => {
    expect(()=>getSummaryModelMessages([message({content:'c'.repeat(750_000),blocks:[{type:'text',text:'b'.repeat(750_000)}]})])).toThrow('Compaction transcript is invalid');
  });
  it('does not execute getters or serializers in a caller-supplied canonical prefix', () => {
    let reads=0;const source=message();Object.defineProperty(source,'metadata',{enumerable:true,get(){reads++;return {signature:'PRIVATE'};}});
    expect(()=>getSummaryModelMessages([source])).toThrow('Compaction transcript is invalid');expect(reads).toBe(0);
  });
  it('preserves public images without promoting unknown provider-private fields', () => {
    const block={type:'image' as const,mediaType:'image/png',url:'data:image/png;base64,PUBLIC',signature:'PRIVATE_IMAGE_SIGNATURE'};
    const projected=getSummaryModelMessages([message({blocks:[block]})]);expect(projected[0].blocks?.[0]).toMatchObject({type:'image',url:block.url});
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_IMAGE_SIGNATURE');
  });
});

describe('inert branch-summary text', () => {
  it('preserves rich/public-custom text and tool input without reading reasoning/private source details', () => {
    const entries:SessionEntry[]=[
      {type:'message',id:'m',timestamp:0,role:'assistant',content:'PUBLIC_COMPAT',blocks:[{type:'text',text:'PUBLIC_RICH'},{type:'reasoning',text:'PRIVATE_THINKING'.repeat(200_000)}],toolCalls:[{id:'call',name:'lookup',input:{signature:'PUBLIC_TOOL'}}],metadata:{signature:'PRIVATE_SIGNATURE'}},
      {type:'custom_message',id:'c',timestamp:1,customType:'notice',content:'PUBLIC_CUSTOM',display:false,details:{private:'PRIVATE_DETAILS'}},
      {type:'custom',id:'private',timestamp:2,customType:'state',data:{private:'PRIVATE_STATE'}},
    ];
    const request=prepareBranchSummary(entries,'from','target',{contextWindow:4096,reserveTokens:1024});
    expect(request).toBeDefined();const text=JSON.stringify(request!.messages);
    for(const marker of ['PUBLIC_COMPAT','PUBLIC_RICH','PUBLIC_CUSTOM','PUBLIC_TOOL'])expect(text).toContain(marker);
    for(const marker of ['PRIVATE_THINKING','PRIVATE_SIGNATURE','PRIVATE_DETAILS','PRIVATE_STATE'])expect(text).not.toContain(marker);
    expect(JSON.stringify(request!.entries)).toContain('PRIVATE_THINKING'); // Privileged source snapshots are not provider messages.
    expect(Buffer.byteLength(request!.messages[0].content)).toBeLessThan(4096-1024);
  });
});
