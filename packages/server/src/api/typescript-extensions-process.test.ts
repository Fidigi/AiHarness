import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('emitted Server trust, HTTP reload, real agent tools and workspace retirement share TypeScript admission', async () => {
  const entry = pathToFileURL(path.resolve('packages/server/dist/index.js')).href;
  const servicesEntry = pathToFileURL(path.resolve('packages/server/dist/runtime/services.js')).href;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'; import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
    import os from 'node:os';import path from 'node:path';
    import {ExtensionRegistry} from '@ai-harness/core';
    import {start,stop} from ${JSON.stringify(entry)};import {createRuntimeServices} from ${JSON.stringify(servicesEntry)};
    process.env.AI_HARNESS_AUTH_TOKEN='typed-admin';process.env.AI_HARNESS_ADMIN_TOKEN='typed-admin';
    const root=await mkdtemp(path.join(os.tmpdir(),'aih-typed-server-'));const cwd=path.join(root,'workspace');const next=path.join(root,'next');const data=path.join(root,'data');const marker=path.join(root,'marker');
    const file=workspace=>path.join(workspace,'.ai-harness/extensions/entry.ts');const helper=path.join(cwd,'.ai-harness/extensions/support/value.ts');
    let services;
    try {
      for(const workspace of [cwd,next])await mkdir(path.dirname(file(workspace)),{recursive:true});await mkdir(path.dirname(helper),{recursive:true});
      await writeFile(helper,'export const value: string = "first";');
      await writeFile(file(cwd), 'import type {ExtensionAPI} from "@ai-harness/core"; import {BUILTIN_EXTENSION_NAMES} from "@ai-harness/core"; import {value} from "./support/value"; import {appendFileSync} from "node:fs"; enum Phase {Ready=7}; appendFileSync('+JSON.stringify(marker)+',"imported"); export default (api:ExtensionAPI)=>api.registerTool({name:"typed_server_tool",description:value,parameters:{type:"object"},execute:()=>({content:value+":"+Phase.Ready+":"+Object.isFrozen(BUILTIN_EXTENSION_NAMES)})});');
      const server=await start({port:0,host:'127.0.0.1',dataDir:data,defaultCwd:cwd,allowedRoots:[cwd,next],runtimeServicesFactory:async(proxy,options)=>(services=await createRuntimeServices(proxy,options))});
      assert(services.extensionRegistry instanceof ExtensionRegistry);
      const base='http://127.0.0.1:'+server.port;const headers={Authorization:'Bearer typed-admin','Content-Type':'application/json'};
      const post=(url,body)=>fetch(base+'/api/'+url,{method:'POST',headers,body:JSON.stringify(body)});
      assert.equal(services.extensionRegistry.getTools().some(tool=>tool.name==='typed_server_tool'),false);
      assert.equal((await fetch(base+'/api/plugins?cwd='+encodeURIComponent(cwd),{headers})).status,200);await assert.rejects(readFile(marker),{code:'ENOENT'});
      assert.equal((await fetch(base+'/api/plugins/reload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cwd})})).status,401);await assert.rejects(readFile(marker),{code:'ENOENT'});
      await services.trustManager.trust(cwd);await services.trustManager.trust(next);
      let response=await post('plugins/reload',{cwd});assert.equal(response.status,200);assert.deepEqual((await response.json()).reload.errors,[]);
      assert.equal(await readFile(marker,'utf8'),'imported');
      services.resolveProvider('mock').streamChat=async(messages,_chunk,complete)=>complete(messages.some(message=>message.role==='tool')?{content:'done'}:{content:'',toolCalls:[{id:'typed-call',name:'typed_server_tool',input:{}}]});
      const ask=async(expected)=>{const result=await post('agent/runs',{cwd,provider:'mock',input:'Use the typed tool.',toolPreset:'full',autoCompaction:false});assert.equal(result.status,202);const {run}=await result.json();assert.equal((await services.agentRuntime.wait(run.id)).phase,'completed');const tools=services.sessionManager.get(run.sessionId).messages.filter(message=>message.role==='tool');assert.equal(tools.length,1);assert.equal(tools[0].content,expected);};
      await ask('first:7:true');
      await writeFile(helper,'export const value: string = "second";');response=await post('plugins/reload',{cwd});assert.deepEqual((await response.json()).reload.errors,[]);await ask('second:7:true');
      const previous=services.extensionRegistry.getTools().find(tool=>tool.name==='typed_server_tool');
      await writeFile(file(cwd),'const private_source_secret: = "private-value"');response=await post('plugins/reload',{cwd});const failed=await response.json();assert.equal(response.status,200);assert(failed.reload.errors.some(error=>error.message==='TypeScript extension evaluation failed.'));assert(!JSON.stringify(failed).includes('private_source_secret'));assert(!JSON.stringify(failed).includes('private-value'));const retained=services.extensionRegistry.getTools().find(tool=>tool.name==='typed_server_tool');assert.deepEqual(retained,previous);assert.equal(retained.execute,previous.execute);await ask('second:7:true');
      await writeFile(file(next),'const invalid: = 1');response=await post('plugins/reload',{cwd:next});assert.equal(response.status,200);assert((await response.json()).reload.errors.length>0);assert.equal(services.extensionRegistry.getTools().some(tool=>tool.name==='typed_server_tool'),false);assert(services.extensionRegistry.getTools().some(tool=>tool.name==='read'));
      console.log('PUBLIC_TYPESCRIPT_SERVER_OK');
    } finally {await stop();await rm(root,{recursive:true,force:true});}
  `], { timeout: 30_000, maxBuffer: 256_000 });
  expect(stderr).toBe(''); expect(stdout).toContain('PUBLIC_TYPESCRIPT_SERVER_OK');
}, 35_000);
