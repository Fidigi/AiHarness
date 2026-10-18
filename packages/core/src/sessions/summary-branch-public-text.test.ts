import { describe, expect, it } from 'vitest';
import type { SessionEntry } from './session-manager.js';
import { prepareBranchSummary } from './branch-summarization.js';

describe('A3-CLI-19 existing inert branch summary rendering', () => {
  it.each([
    {name:'block-only',content:'',rich:'PUBLIC_RICH'},
    {name:'differing views',content:'PUBLIC_COMPAT',rich:'PUBLIC_RICH'},
    {name:'identical views',content:'PUBLIC_RICH',rich:'PUBLIC_RICH'},
    {name:'legacy content',content:'PUBLIC_COMPAT',rich:''},
  ])('$name preserves all useful text and no private source payload', ({content,rich}) => {
    const entries:SessionEntry[]=[{type:'message',id:'answer',timestamp:0,role:'assistant',content,
      blocks:[...(rich?[{type:'text' as const,text:rich}]:[]),{type:'reasoning',text:'PRIVATE_THINKING'}],
      toolCalls:[{id:'call',name:'lookup',input:{signature:'PUBLIC_TOOL_SIGNATURE',reasoning:'PUBLIC_TOOL_REASONING'}}],
      metadata:{signature:'PRIVATE_SIGNATURE'}},
      {type:'message',id:'result',timestamp:1,role:'tool',toolCallId:'call',content:'PUBLIC_RESULT'},
      {type:'custom_message',id:'custom',timestamp:2,customType:'notice',content:'PUBLIC_CUSTOM',display:false,details:{private:'PRIVATE_DETAILS'}},
    ];
    const before=structuredClone(entries), request=prepareBranchSummary(entries,'from','target',{});
    expect(request).toBeDefined();const text=JSON.stringify(request!.messages);
    for(const marker of [content,rich,'PUBLIC_TOOL_SIGNATURE','PUBLIC_TOOL_REASONING','PUBLIC_RESULT','PUBLIC_CUSTOM'].filter(Boolean))expect(text).toContain(marker);
    for(const marker of ['PRIVATE_THINKING','PRIVATE_SIGNATURE','PRIVATE_DETAILS'])expect(text).not.toContain(marker);
    expect(entries).toEqual(before);
  });
});
