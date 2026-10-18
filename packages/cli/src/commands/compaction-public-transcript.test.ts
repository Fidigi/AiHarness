import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, MockProvider, SessionManager, type Message } from '@ai-harness/core';
import { CommandHandler } from './handler.js';
import type { TerminalUI } from '../tui/terminal-ui.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
describe('A3-CLI-19 actual manual summary provider transcript', () => {
  it.each(['reasoning', 'private-metadata', 'ordinary'])('conserves public context but excludes %s from summary work', async kind => {
    const root=await mkdtemp(path.join(os.tmpdir(),'aih-summary-public-')); roots.push(root);
    const store=new JsonlSessionStore(root), manager=new SessionManager({store});
    const session=await manager.create({title:'Summary source'});
    await manager.addMessage(session.id,{role:'user',content:'PUBLIC_USER '.repeat(1000)},{skipAutoCompaction:true});
    await manager.addMessage(session.id,{role:'assistant',content:'PUBLIC_ANSWER',blocks:[{type:'text',text:'PUBLIC_ANSWER'},...(kind==='reasoning'?[{type:'reasoning' as const,text:'PRIVATE_THINKING'}]:[])],
      toolCalls:[{id:'lookup',name:'read',input:{path:'PUBLIC_PATH',reasoning:'PUBLIC_TOOL_REASONING',signature:'PUBLIC_TOOL_SIGNATURE'}}],
      ...(kind==='private-metadata'?{metadata:{signature:'PRIVATE_SIGNATURE',internalState:'PRIVATE_STATE'}}:{})},{skipAutoCompaction:true});
    await manager.addMessage(session.id,{role:'tool',toolCallId:'lookup',name:'read',content:'PUBLIC_RESULT'},{skipAutoCompaction:true});
    await manager.addMessage(session.id,{role:'user',content:'RETAINED_USER'},{skipAutoCompaction:true});
    manager.setCompactionSettings({enabled:false,keepRecentTokens:1});
    const before=await manager.getRawEntries(session.id), calls: Message[][]=[];
    class SummaryProvider extends MockProvider {
      override validateConfig(){return true;}
      override async chat(messages:Message[]){calls.push(structuredClone(messages));return{content:'PUBLIC_SUMMARY'};}
    }
    const provider=new SummaryProvider({type:'mock'});
    const errors=vi.fn(), output=vi.fn();
    const terminal={showError:errors,writeOutput:output} as unknown as TerminalUI;
    const handler=new CommandHandler(manager,store,terminal,undefined,undefined,{cwd:root,providers:new Map([['mock',provider]])});
    handler.getContext().currentSessionId=session.id;
    await handler.execute('/compact');
    expect(errors).not.toHaveBeenCalled();expect(calls).toHaveLength(1);
    const transcript=JSON.stringify(calls[0]);
    for(const text of ['PUBLIC_USER','PUBLIC_ANSWER','PUBLIC_PATH','PUBLIC_TOOL_REASONING','PUBLIC_TOOL_SIGNATURE','PUBLIC_RESULT'])expect(transcript).toContain(text);
    for(const text of ['PRIVATE_THINKING','PRIVATE_SIGNATURE','PRIVATE_STATE','RETAINED_USER'])expect(transcript).not.toContain(text);
    const after=await manager.getRawEntries(session.id);
    expect(after.slice(0,before.length)).toEqual(before);expect(after.some(entry=>entry.type==='compaction')).toBe(true);
  });
});
