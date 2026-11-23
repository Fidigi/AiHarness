import assert from 'node:assert/strict';import{mkdtemp,readFile,rm}from'node:fs/promises';import os from'node:os';import path from'node:path';import{createHash}from'node:crypto';
import{AiProvider,createAgentSession,ExtensionRegistry,JsonlSessionStore}from'@ai-harness/core';
class Provider extends AiProvider{calls=0;constructor(){super({type:'mock',model:'virtual-chat'});}validateConfig(){return true;}async chat(){return{content:'unused'};}async streamChat(_messages,_chunk,complete){this.calls++;complete?.({content:'native SDK prestart reply'});}}
const observations=[];
for(const action of['stop','dispose']){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'aih-native-sdk-prestart-')),registry=new ExtensionRegistry(),provider=new Provider(),entered=Promise.withResolvers(),release=Promise.withResolvers();let api;
 try{
  await registry.load('native-sdk-prestart-gate',extension=>{extension.before('before:agent',async()=>{entered.resolve();await release.promise;});});
  const disk=new JsonlSessionStore(path.join(cwd,'sessions'));
  api=await createAgentSession({cwd,allowedRoots:[cwd],store:disk,extensionRegistry:registry,provider:{kind:'instance',name:'mock',provider},isProjectTrusted:()=>true,runDefaults:{allowedTools:[],codemode:{enabled:false},maxRetries:0}});
  const id=api.id,file=disk.getSessionFilePath(id),before=await readFile(file),events=[];api.subscribe(event=>{events.push(event.type);});
  const prompt=api.prompt('must not persist after prestart cancellation').then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',name:reason.name,message:reason.message}));
  await entered.promise;const cancellation=api[action]();release.resolve();
  const result=await prompt,cancelled=await cancellation;if(action==='stop')await api.wait();
  const saved=await disk.getSessionSnapshot(id),after=await readFile(file);
  const observation={action,prompt:result,cancellation:cancelled??null,providerCalls:provider.calls,persistedUsers:saved.session.messages.filter(message=>message.role==='user').map(message=>message.content),bytesUnchanged:before.equals(after),beforeSha:createHash('sha256').update(before).digest('hex'),afterSha:createHash('sha256').update(after).digest('hex'),events};
  observations.push(observation);console.log('NATIVE_SDK_PRESTART_OBSERVATION '+JSON.stringify(observation));
 }finally{release.resolve();await api?.dispose();await registry.unloadAll();await rm(cwd,{recursive:true,force:true});}
}
assert.deepEqual(observations.map(o=>({action:o.action,promptStatus:o.prompt.status,providerCalls:o.providerCalls,users:o.persistedUsers.length,bytesUnchanged:o.bytesUnchanged})),['stop','dispose'].map(action=>({action,promptStatus:'rejected',providerCalls:0,users:0,bytesUnchanged:true})));
console.log('native SDK prestart cancellation OK');
