import assert from 'node:assert/strict';
import { AgentRuntime, AiProvider, ExtensionRegistry, SessionManager } from '@ai-harness/core';
const deferred=()=>Promise.withResolvers();
class Provider extends AiProvider {
  calls=[];
  constructor(){super({type:'mock',model:'virtual-chat'});}
  validateConfig(){return true;}
  async chat(){return{content:'unused'};}
  async streamChat(messages,_chunk,complete){this.calls.push(messages.filter(m=>m.role==='user').map(m=>m.content));complete?.({content:'native prestart reply'});}
}
const observations=[];
for(const phase of ['trust','hook','provider']){
  const manager=new SessionManager(),registry=new ExtensionRegistry(),provider=new Provider();
  const session=await manager.create({cwd:process.cwd()});registry.attachSessionManager(manager);
  const firstEntered=deferred(),bothEntered=deferred(),release=deferred();let entered=0;
  const barrier=async()=>{entered++;firstEntered.resolve();if(entered===2)bothEntered.resolve();await release.promise;};
  if(phase==='hook')await registry.load('native-prestart-gate',api=>{api.before('before:agent',async()=>{await barrier();});});
  const runtime=new AgentRuntime({sessionManager:manager,extensionRegistry:registry,isProjectTrusted:async()=>{if(phase==='trust')await barrier();return true;},resolveProvider:async()=>{if(phase==='provider')await barrier();return provider;}});
  const request=input=>({sessionId:session.id,cwd:process.cwd(),provider:'mock',input,allowedTools:[],codemode:{enabled:false},maxRetries:0});
  const first=runtime.start(request('first native prompt'));await firstEntered.promise;
  const second=runtime.start(request('second native prompt'));
  const secondSettled=second.then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason:String(reason)}));
  await Promise.race([bothEntered.promise,secondSettled]);
  const beforeRelease={entered,run:runtime.getSessionRun(session.id)??null,running:runtime.listRunning().length};
  release.resolve();const results=await Promise.allSettled([first,secondSettled]);
  const snapshots=results.flatMap(result=>result.status==='fulfilled'&&result.value?.id?[result.value]:result.status==='fulfilled'&&result.value?.value?.id?[result.value.value]:[]);
  const settled=await Promise.all(snapshots.map(snapshot=>runtime.wait(snapshot.id)));
  const observation={phase,beforeRelease,firstStatus:results[0].status,second:await secondSettled,providerCalls:provider.calls,persistedUsers:manager.get(session.id).messages.filter(message=>message.role==='user').map(message=>message.content),settled:settled.map(run=>({id:run.id,phase:run.phase})),selectedRun:runtime.getSessionRun(session.id)?.id};
  observations.push(observation);console.log('NATIVE_PRESTART_OBSERVATION '+JSON.stringify(observation));
  await registry.unloadAll();
}
// Contract RED only after every native effect/settlement is recorded and cleaned up.
assert.deepEqual(observations.map(o=>({phase:o.phase,secondStatus:o.second.status,providerCalls:o.providerCalls.length})),['trust','hook','provider'].map(phase=>({phase,secondStatus:'rejected',providerCalls:1})));
console.log('native prestart admission OK');
