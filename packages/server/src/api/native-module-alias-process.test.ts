import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('actual emitted Server native extensions use the host Core root during HTTP-driven tools and disposal', async () => {
  const server = pathToFileURL(path.resolve('packages/server/dist/index.js')).href;
  const runtime = pathToFileURL(path.resolve('packages/server/dist/runtime/services.js')).href;
  const core = pathToFileURL(path.resolve('packages/core/dist/index.js')).href;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';import{mkdir,mkdtemp,readFile,rm,writeFile}from'node:fs/promises';import path from'node:path';
    import{ExtensionRegistry}from ${JSON.stringify(core)};import{start,stop}from ${JSON.stringify(server)};import{createRuntimeServices}from ${JSON.stringify(runtime)};
    const root=await mkdtemp('/tmp/aih-native-server-');const cwd=path.join(root,'workspace');const data=path.join(root,'data');const directory=path.join(cwd,'.ai-harness/extensions');const entry=path.join(directory,'entry.mjs');const disposed=path.join(root,'disposed');let services;
    process.env.AI_HARNESS_AUTH_TOKEN='native-admin';process.env.AI_HARNESS_ADMIN_TOKEN='native-admin';
    try{
      await mkdir(directory,{recursive:true});
      await writeFile(entry,'import{ExtensionRegistry as Class}from "@ai-harness/core";import{writeFile}from"node:fs/promises";import{ExtensionRegistry as Oracle}from '+JSON.stringify(${JSON.stringify(core)})+';export default api=>{api.registerTool({name:"native_core_tool",description:"Native",parameters:{type:"object"},execute:async()=>({content:String(Class===Oracle&&Class===(await import("@ai-harness/core")).ExtensionRegistry)})});return async()=>writeFile('+JSON.stringify(disposed)+',String((await import("@ai-harness/core")).ExtensionRegistry===Oracle));};');
      const live=await start({port:0,host:'127.0.0.1',dataDir:data,defaultCwd:cwd,allowedRoots:[cwd],runtimeServicesFactory:async(proxy,options)=>(services=await createRuntimeServices(proxy,options))});assert(services.extensionRegistry instanceof ExtensionRegistry);
      const base='http://127.0.0.1:'+live.port;const post=(url,body)=>fetch(base+'/api/'+url,{method:'POST',headers:{Authorization:'Bearer native-admin','Content-Type':'application/json'},body:JSON.stringify(body)});
      assert(!services.extensionRegistry.getTools().some(tool=>tool.name==='native_core_tool'));await services.trustManager.trust(cwd);
      const reload=await post('plugins/reload',{cwd});assert.equal(reload.status,200);assert.deepEqual((await reload.json()).reload.errors,[]);
      services.resolveProvider('mock').streamChat=async(messages,_chunk,complete)=>complete(messages.some(message=>message.role==='tool')?{content:'done'}:{content:'',toolCalls:[{id:'native',name:'native_core_tool',input:{}}]});
      const response=await post('agent/runs',{cwd,provider:'mock',input:'Call native Core.',toolPreset:'full',autoCompaction:false});assert.equal(response.status,202);const{run}=await response.json();assert.equal((await services.agentRuntime.wait(run.id)).phase,'completed');assert.equal(services.sessionManager.get(run.sessionId).messages.find(message=>message.role==='tool').content,'true');
      await services.extensionRegistry.unload(entry);assert.equal(await readFile(disposed,'utf8'),'true');assert(!services.extensionRegistry.getTools().some(tool=>tool.name==='native_core_tool'));console.log('NATIVE_SERVER_OK');
    }finally{await stop();await rm(root,{recursive:true,force:true});}
  `], { timeout: 30_000, maxBuffer: 256_000 });
  expect(stderr).toBe(''); expect(stdout).toContain('NATIVE_SERVER_OK');
}, 35_000);
