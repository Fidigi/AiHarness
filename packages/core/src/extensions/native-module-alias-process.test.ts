import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const core = pathToFileURL(path.resolve('packages/core/dist/index.js')).href;
async function probe(body: string) {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import Module from 'node:module';import{pathToFileURL}from'node:url';
    const {ExtensionModuleLoader,ExtensionRegistry}=await import(${JSON.stringify(core)});
    const root=await fs.mkdtemp('/tmp/aih-native-public-');
    const file=async(name,body)=>{const target=path.join(root,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,body);return target;};
    const loader=(registry,entry,extra={})=>new ExtensionModuleLoader(registry,{cwd:root,paths:[entry],includeGlobalLocation:false,includeProjectLocation:false,includeEnvironmentPaths:false,...extra});
    try{${body};console.log('NATIVE_ALIAS_OK');}finally{await fs.rm(root,{recursive:true,force:true});}
  `], { timeout: 20_000, maxBuffer: 256_000 });
  expect(stderr).toBe(''); expect(stdout).toContain('NATIVE_ALIAS_OK');
}

it.each(['js', 'mjs', 'cjs'])('public native %s static/late/dependency Core imports retain exact host identity and ordinary foreign resolution', async suffix => {
  await probe(`
    await file('node_modules/@ai-harness/core/package.json',JSON.stringify({type:'module',exports:{'.':'./index.js'}}));
    await file('node_modules/@ai-harness/core/index.js','export class ExtensionRegistry {};export const foreign=true;');
    await file('helper.mjs','export const late=async()=>(await import("@ai-harness/core")).ExtensionRegistry;');
    await file('helper.cjs','exports.late=()=>require("@ai-harness/core").ExtensionRegistry;');
    const source=${JSON.stringify(suffix === 'cjs'
      ? `const {ExtensionRegistry:Class}=require('@ai-harness/core');const {late}=require('./helper.cjs');module.exports=api=>api.registerCommand('alias',{description:'Alias',handler:async()=>({Class,late:await late(),direct:(await import('@ai-harness/core')).ExtensionRegistry})});`
      : `import {ExtensionRegistry as Class} from '@ai-harness/core';import{late}from'./helper.mjs';export default api=>api.registerCommand('alias',{description:'Alias',handler:async()=>({Class,late:await late(),direct:(await import('@ai-harness/core')).ExtensionRegistry})});`)};
    const require=Module.createRequire(root+'/unrelated.cjs');const foreign=require('@ai-harness/core');assert.equal(foreign.foreign,true);
    const entry=await file('entry.${suffix}',source);const registry=new ExtensionRegistry();const modules=loader(registry,entry);
    assert.deepEqual((await modules.loadAll()).errors,[]);const result=await registry.getCommand('alias').handler('',{});
    assert.equal(result.Class,ExtensionRegistry);assert.equal(result.late,ExtensionRegistry);assert.equal(result.direct,ExtensionRegistry);
    const other=await file('unrelated.mjs','export {foreign} from "@ai-harness/core";');assert.equal((await import(pathToFileURL(other))).foreign,true);
    assert.equal(require('@ai-harness/core'),foreign);
    await assert.rejects(import(pathToFileURL(await file('private.mjs','import "@ai-harness/core/private";'))),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    await modules.clear();assert.equal(require('@ai-harness/core').foreign,true);
  `);
}, 25_000);

it.each(['mjs', 'cjs'])('cached transitive %s dependencies acquire a new owner after complete retirement without cache replacement', async suffix => {
  await probe(`
    const cjs=${JSON.stringify(suffix === 'cjs')};
    await file('nested.${suffix}',cjs?'exports.late=()=>require("@ai-harness/core").ExtensionRegistry;':'export const late=async()=>(await import("@ai-harness/core")).ExtensionRegistry;');
    const helper=await file('helper.${suffix}',cjs?'module.exports=require("./nested.cjs");':'export {late} from "./nested.mjs";');
    const source=cjs?'const {late}=require("./helper.cjs");module.exports=api=>api.registerCommand("alias",{description:"Alias",handler:late});':'import{late}from"./helper.mjs";export default api=>api.registerCommand("alias",{description:"Alias",handler:late});';
    const registry=new ExtensionRegistry();const first=loader(registry,await file('first.${suffix}',source));assert.deepEqual((await first.loadAll()).errors,[]);
    const require=Module.createRequire(root+'/consumer.cjs');const cached=cjs?require.cache[helper]:await import(pathToFileURL(helper));assert(cached);
    await first.clear();const second=loader(registry,await file('second.${suffix}',source));assert.deepEqual((await second.loadAll()).errors,[]);
    assert.equal(await registry.getCommand('alias').handler('',{}),ExtensionRegistry);
    assert.equal(cjs?require.cache[helper]:await import(pathToFileURL(helper)),cached);await second.clear();
  `);
}, 25_000);

it('retains pending import aliases until the complete candidate generation reaches factory registration', async () => {
  await probe(`
    const marker=root+'/ready';
    await file('pending.mjs','import{writeFile}from"node:fs/promises";export const ready=new Promise(resolve=>setTimeout(async()=>{const Class=(await import("@ai-harness/core")).ExtensionRegistry;await writeFile('+JSON.stringify(marker)+',"ready");resolve(Class);},50));');
    const first=await file('a.mjs','import{ready}from"./pending.mjs";export default api=>api.registerCommand("alias",{description:"Alias",handler:()=>ready});');
    const second=await file('b.mjs','import{readFile}from"node:fs/promises";while(true){try{if(await readFile('+JSON.stringify(marker)+',"utf8")==="ready")break;}catch{}await new Promise(resolve=>setTimeout(resolve,5));}export default()=>{};');
    const registry=new ExtensionRegistry();const modules=loader(registry,first,{paths:[first,second]});assert.deepEqual((await modules.loadAll()).errors,[]);assert.equal(await registry.getCommand('alias').handler('',{}),ExtensionRegistry);await modules.clear();
  `);
}, 25_000);

it('does not adopt the host Core cache graph when an extension explicitly requires the host entry', async () => {
  await probe(`
    const require=Module.createRequire(root+'/consumer.cjs');const hostPath=${JSON.stringify(path.resolve('packages/core/dist/index.js'))};require(hostPath);const cached=require.cache[hostPath];assert(cached);
    const descriptor=Object.getOwnPropertyDescriptor(cached,'children');assert(descriptor);const children=cached.children;let reads=0;
    Object.defineProperty(cached,'children',{configurable:true,get(){reads++;return children;}});
    try{
      const entry=await file('entry.cjs','const {ExtensionRegistry:Class}=require('+JSON.stringify(hostPath)+');module.exports=api=>api.registerCommand("alias",{description:"Alias",handler:()=>Class});');
      const registry=new ExtensionRegistry();const modules=loader(registry,entry);assert.deepEqual((await modules.loadAll()).errors,[]);assert.equal(await registry.getCommand('alias').handler('',{}),ExtensionRegistry);assert.equal(reads,0);await modules.clear();
    }finally{Object.defineProperty(cached,'children',descriptor);}
  `);
}, 25_000);

const observe = `
  const original=Module.registerHooks;const originalRequire=Module.prototype.require;let live=0;
  Module.registerHooks=function(options){const hook=original(options);live++;let active=true;return {deregister(){if(active){active=false;live--;}return hook.deregister();}};};Module.syncBuiltinESMExports();
`;
it('resolver hooks follow registry disposal, failed imports/factories, rollback and multiple loaders without consuming foreign hooks', async () => {
  await probe(`
    ${observe}
    const foreign=Module.registerHooks({resolve:(specifier,context,next)=>next(specifier,context)});assert.equal(live,1);
    const cleanupFile=root+'/cleanups';
    const source='import {ExtensionRegistry as Class} from "@ai-harness/core";import{appendFile}from"node:fs/promises";export default api=>{api.registerCommand("alias",{description:"Alias",handler:async()=>(await import("@ai-harness/core")).ExtensionRegistry});return async()=>{if((await import("@ai-harness/core")).ExtensionRegistry!==Class)throw new Error("wrong cleanup namespace");await appendFile('+JSON.stringify(cleanupFile)+',"c");};};';
    const entry=await file('entry.mjs',source);const registry=new ExtensionRegistry();const modules=loader(registry,entry);
    assert.deepEqual((await modules.loadAll()).errors,[]);assert.equal(live,2);const retained=registry.getCommand('alias');
    await fs.writeFile(entry,'import "@ai-harness/core";throw new Error("candidate import failed");export default()=>{};');
    assert.equal((await modules.reload()).committed,false);assert.equal(live,2);assert.equal(registry.getCommand('alias'),retained);
    await fs.writeFile(entry,'import "@ai-harness/core";export default()=>{throw new Error("candidate factory failed");};');
    assert.equal((await modules.reload()).committed,false);assert.equal(live,2);assert.equal(await registry.getCommand('alias').handler('',{}),ExtensionRegistry);
    const otherRegistry=new ExtensionRegistry();const otherEntry=await file('other.mjs',source);const other=loader(otherRegistry,otherEntry);assert.equal((await other.loadAll()).committed,true);assert.equal(live,2);
    await registry.unload(entry);assert.equal(live,2);assert.equal(await otherRegistry.getCommand('alias').handler('',{}),ExtensionRegistry);
    await other.clear();assert.equal(live,1);assert.equal(await fs.readFile(cleanupFile,'utf8'),'ccc');
    await modules.clear();assert.equal(live,1);foreign.deregister();assert.equal(live,0);assert.equal(Module.prototype.require,originalRequire);Module.registerHooks=original;Module.syncBuiltinESMExports();
  `);
}, 25_000);

it('untrusted paths and candidates abandoned before registry replacement release every temporary alias hook', async () => {
  await probe(`
    ${observe}
    const entry=await file('a.mjs','import "@ai-harness/core";export default()=>{};');const invalid=await file('z.mjs','throw new Error("abandoned");export default()=>{};');
    const registry=new ExtensionRegistry();assert.equal((await loader(registry,entry,{isProjectTrusted:()=>false}).loadAll()).committed,true);assert.equal(live,0);
    const modules=loader(registry,entry,{paths:[entry,invalid]});assert.equal((await modules.loadAll()).committed,false);assert.equal(live,0);
    const throwing=await file('cleanup.mjs','import "@ai-harness/core";export default()=>()=>{throw new Error("cleanup");};');
    const cleanup=loader(registry,throwing);assert.equal((await cleanup.loadAll()).committed,true);assert.equal(live,1);
    const log=console.error;let reported=0;console.error=message=>{assert.equal(message,'[ExtensionRegistry] Extension cleanup failed.');reported++;};
    try{await cleanup.clear();}finally{console.error=log;}assert.equal(reported,1);assert.equal(live,0);assert.equal(Module.prototype.require,originalRequire);Module.registerHooks=original;Module.syncBuiltinESMExports();
  `);
}, 25_000);

it('bounds native resolution graph growth without leaving resolver hooks or replacing native dependency cache ownership', async () => {
  await probe(`
    ${observe}
    const dependency=await file('dependency.cjs','module.exports={owned:true};');const require=Module.createRequire(root+'/consumer.cjs');const value=require(dependency);const cached=require.cache[dependency];
    const entry=await file('entry.mjs','for(let i=0;i<1005;i++)import.meta.resolve("./dependency.cjs?attempt="+i);export default()=>{};');
    const result=await loader(new ExtensionRegistry(),entry).loadAll();assert.equal(result.committed,false);assert.equal(result.errors[0].error.message,'Extension module resolution exceeds its limits.');assert.equal(live,0);assert.equal(require.cache[dependency],cached);assert.equal(require(dependency),value);
    assert.equal(Module.prototype.require,originalRequire);Module.registerHooks=original;Module.syncBuiltinESMExports();
  `);
}, 25_000);

it.each(['url', 'bytes', 'edges'])('bounds retained native dependency %s metadata independently of active graph size', async limit => {
  await probe(`
    ${observe}
    await file('dependency.mjs','export const value=1;');let completed=0;let failure;
    const limit=${JSON.stringify(limit)};
    for(let turn=0;turn<(limit==='edges'?27:1);turn++){
      const query=limit==='url'?'x'.repeat(32_769):limit==='bytes'?'x'.repeat(30_000):'';
      const source='for(let i=0;i<800;i++)import.meta.resolve('+JSON.stringify('./dependency.mjs?'+query+'t'+turn+'-')+'+i);export default()=>{};';
      const entry=await file('entry-'+turn+'.mjs',source);const modules=loader(new ExtensionRegistry(),entry);const result=await modules.loadAll();
      if(!result.committed){failure=result;break;}completed++;await modules.clear();
    }
    assert(failure);assert.equal(failure.errors[0].error.message,'Extension module resolution exceeds its limits.');assert.equal(completed,limit==='edges'?25:0);assert.equal(live,0);assert.equal(Module.prototype.require,originalRequire);Module.registerHooks=original;Module.syncBuiltinESMExports();
  `);
}, 25_000);

it.each(['contexts', 'associations'])('bounds active alias %s across owners and releases partial admissions', async limit => {
  const helper = pathToFileURL(path.resolve('packages/core/dist/extensions/native-module-alias.js')).href;
  await probe(`
    ${observe}
    const {acquireNativeModuleAlias}=await import(${JSON.stringify(helper)});const releases=[];let failure;
    try{for(let index=0;index<10_001;index++){
      const id=${JSON.stringify(limit === 'contexts')}?String(index):'shared';
      try{releases.push((await acquireNativeModuleAlias('file:///tmp/entry-'+id+'.mjs','file:///tmp/entry-'+id+'.mjs?attempt')).release);}catch(error){failure=error;break;}
    }assert.equal(releases.length,${JSON.stringify(limit === 'contexts' ? 5_000 : 10_000)});assert.equal(failure?.message,'Extension module resolution exceeds its limits.');}
    finally{for(const release of releases)release();}
    assert.equal(live,0);assert.equal(Module.prototype.require,originalRequire);Module.registerHooks=original;Module.syncBuiltinESMExports();
  `);
}, 25_000);

it('bounds retained parent metadata even when each native owner is promptly retired', async () => {
  const helper = pathToFileURL(path.resolve('packages/core/dist/extensions/native-module-alias.js')).href;
  await probe(`
    ${observe}
    const {acquireNativeModuleAlias}=await import(${JSON.stringify(helper)});const dependency=await file('dependency.cjs','module.exports=7;');const anchor=await acquireNativeModuleAlias('file:///tmp/anchor.mjs','file:///tmp/anchor.mjs?attempt');let completed=0;let failure;
    try{for(let index=0;index<10_001;index++){
      const filename=root+'/owner-'+index+'.cjs';const url=pathToFileURL(filename).href;const owner=await acquireNativeModuleAlias(url,url+'?attempt');
      try{assert.equal(Module.createRequire(filename)(dependency),7);completed++;}catch(error){failure=error;break;}finally{owner.release();}
    }assert.equal(completed,10_000);assert.equal(failure?.message,'Extension module resolution exceeds its limits.');}
    finally{anchor.release();}
    assert.equal(live,0);assert.equal(Module.prototype.require,originalRequire);Module.registerHooks=original;Module.syncBuiltinESMExports();
  `);
}, 25_000);

it('preserves earlier virtual require adapters and later foreign wrappers across repeated native generations', async () => {
  await probe(`
    const original=Module.prototype.require;const token={virtual:true};
    const earlier=function(id){return id==='virtual:fixture'?token:original.call(this,id);};Module.prototype.require=earlier;
    try{
      const entry=await file('entry.cjs','const virtual=require("virtual:fixture");const {ExtensionRegistry:Class}=require("@ai-harness/core");module.exports=api=>api.registerCommand("alias",{description:"Alias",handler:()=>({virtual,Class})});');
      const registry=new ExtensionRegistry();const modules=loader(registry,entry);assert.deepEqual((await modules.loadAll()).errors,[]);
      const result=await registry.getCommand('alias').handler('',{});assert.equal(result.virtual,token);assert.equal(result.Class,ExtensionRegistry);
      const adapter=Module.prototype.require;const later=function(id){return adapter.call(this,id);};Module.prototype.require=later;
      await modules.clear();assert.equal(Module.prototype.require,later);assert.equal(Module.createRequire(root+'/other.cjs')('virtual:fixture'),token);
      assert.deepEqual((await modules.loadAll()).errors,[]);assert.equal((await registry.getCommand('alias').handler('',{})).Class,ExtensionRegistry);
      await modules.clear();assert.equal(Module.prototype.require,later);
    }finally{Module.prototype.require=original;}
  `);
}, 25_000);
