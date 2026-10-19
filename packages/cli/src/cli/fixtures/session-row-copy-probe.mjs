import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SessionManager,JsonlSessionStore,SessionBranchCancelledError,AI_HARNESS_CORE_API_VERSION} from '@ai-harness/core';
const scenario=process.argv[2]??'all';
assert.equal(AI_HARNESS_CORE_API_VERSION,1);
assert.ok(['all','memory','durable','external','policy','group','title'].includes(scenario));
const root=await mkdtemp(path.join(os.tmpdir(),'aih-public-row-copy-'));
try {
 for(const mode of ['memory','durable','external','policy','group','title'].filter(value=>scenario==='all'||scenario===value)){
  const store=mode==='memory'?undefined:new JsonlSessionStore(path.join(root,mode));
  const writer=new SessionManager({store});
  const source=await writer.create({cwd:'/workspace',workspaceId:'displayed-workspace',title:'Displayed source',
   messages:[{id:'root',role:'user',content:'Public root',timestamp:new Date(1)}],metadata:{independent:{value:'source'}}});
  const command=await writer.addCommand(source.id,{command:'inert',cwd:'/workspace',status:'completed',output:'Saved output'});
  const custom=await writer.appendCustomEntry(source.id,'public:state',{value:1});
  await writer.addMessage(source.id,{role:'assistant',content:'Later reply'});
  const manager=mode==='external'?new SessionManager({store}):writer;
  const snapshot=structuredClone(source),bytes=store?await readFile(store.getSessionFilePath(source.id)):undefined;
  const options=mode==='external'?{sourceStore:store,expectedCwd:'/workspace'}:{expectedCwd:'/workspace'};
  let admissions=0;manager.onBeforeBranch(event=>{admissions++;assert.equal(event.operation,'clone');if(mode==='external')assert.equal(event.externalSource,true);});
  if(mode==='external')manager.loadFromStore=()=>{throw new Error('Unexpected source runtime/import work.');};
  if(mode==='group'){
   const incomplete=await writer.create({cwd:'/workspace',messages:[
    {id:'calls',role:'assistant',content:'',timestamp:new Date(1),toolCalls:[{id:'one',name:'work',input:{}},{id:'two',name:'work',input:{}}]},
    {id:'result',role:'tool',content:'one result',toolCallId:'one',timestamp:new Date(2)},
   ]});
   const count=manager.list().length;
   assert.equal(await manager.cloneSessionAtEntry(incomplete.id,incomplete.activeLeafId),null);
   assert.equal(manager.list().length,count);
   assert.ok(await manager.cloneSession(incomplete.id),'Unrelated generic clone compatibility remains unchanged.');
  }else if(mode==='policy'){
   const remove=manager.onBeforeBranch(event=>{assert.equal(event.operation,'clone');assert.equal(event.entryId,custom.id);return false;});
   await assert.rejects(manager.cloneSessionAtEntry(source.id,custom.id),SessionBranchCancelledError);remove();
   const controller=new AbortController();controller.abort();
   await assert.rejects(manager.cloneSessionAtEntry(source.id,custom.id,undefined,{signal:controller.signal}),SessionBranchCancelledError);
  }else if(mode==='title'){
   await writer.update(source.id,{title:'🙂'.repeat(1024)});
   const copy=await manager.cloneSessionAtEntry(source.id,custom.id);
   assert.equal(Buffer.byteLength(copy.title),4096);assert.equal(copy.title,'🙂'.repeat(1022)+' (clone)');
   assert.equal(source.title,'🙂'.repeat(1024));
   continue;
  }
  const expected=mode==='durable'?command.id:custom.id;
  assert.equal(await manager.cloneSessionAtEntry(source.id,expected,undefined,{...options,expectedCwd:'/wrong'}),null);
  const copy=await manager.cloneSessionAtEntry(source.id,expected,undefined,options);
  assert.ok(copy);assert.ok(admissions>0);assert.notEqual(copy.id,source.id);assert.equal(copy.cwd,'/workspace');assert.equal(copy.workspaceId,'displayed-workspace');
  assert.equal(copy.title,'Displayed source (clone)');assert.equal(copy.parentId,undefined);assert.equal(copy.branchId,undefined);
  assert.equal(copy.metadata.clonedFromSessionId,source.id);assert.equal(copy.metadata.clonedFromEntryId,expected);
  const entries=(await manager.getActiveBranchEntries(copy.id)).filter(entry=>entry.type!=='metadata');
  assert.equal(entries.at(-1).type,mode==='durable'?'command':'custom');assert.equal(copy.activeLeafId,entries.at(-1).id);assert.notEqual(copy.activeLeafId,expected);
  assert.equal(copy.messages.some(message=>message.content==='Later reply'),false);
  if(mode==='external')assert.equal(manager.get(source.id),undefined);
  if(store){const reload=new SessionManager({store});await reload.loadFromStore(copy.id);assert.deepEqual(await reload.getActiveBranchEntries(copy.id),await manager.getActiveBranchEntries(copy.id));}
  await manager.addMessage(copy.id,{role:'user',content:'Copy only'});copy.metadata.independent.value='copy';
  assert.deepEqual(source,snapshot);if(store)assert.deepEqual(await readFile(store.getSessionFilePath(source.id)),bytes);
 }
 process.stdout.write('session row copy OK\n');
}finally{await rm(root,{recursive:true,force:true});}
