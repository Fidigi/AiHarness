import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnPty } from 'node-pty';
import { PluginService, ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
type Source = 'global' | 'project' | 'settings' | 'environment' | 'package' | 'explicit';
type Record = { kind: string; value?: string; flag?: boolean; tools?: string[]; core?: boolean };
async function fixture(source: Source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-typed-process-'));
  const cwd = path.join(root, 'project'); const agent = path.join(root, 'agent'); const trace = path.join(root, 'trace');
  const directory = source === 'global' ? path.join(agent, 'extensions') : source === 'project' ? path.join(cwd, '.ai-harness/extensions')
    : source === 'settings' ? path.join(agent, 'configured') : source === 'package' ? path.join(cwd, 'package/src') : path.join(root, 'explicit');
  const entry = path.join(directory, 'entry.ts'); const helper = path.join(directory, 'support/value.ts');
  const file = async (name: string, body: string) => { await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, body); };
  await mkdir(cwd, { recursive: true }); await mkdir(agent, { recursive: true });
  const body = `import type { ExtensionAPI } from '@ai-harness/core';
    import { BUILTIN_EXTENSION_NAMES } from '@ai-harness/core'; import { value } from './support/value';
    import { appendFileSync } from 'node:fs';
    const record = (value: unknown) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value)+'\\n');
    enum Phase { Ready = 7 } class Box { constructor(public text: string) {} }
    record({kind:'import'});
    export default (api: ExtensionAPI) => {
      record({kind:'factory'}); api.registerOption('typed-probe', {type:'boolean',description:'Typed probe',default:false});
      api.registerTool({name:'typed_docs',description:'Typed documentation',parameters:{type:'object'},execute:()=>({content:String(Phase.Ready)})});
      api.before('before:provider', data => {record({kind:'turn',value:new Box(value).text,flag:api.getOption('typed-probe'),core:Object.isFrozen(BUILTIN_EXTENSION_NAMES),tools:(data.options.tools??[]).map(tool=>tool.name)});});
    };`;
  await file(entry, body); await file(helper, 'export const value: string = "first";');
  await file(path.join(directory, 'entry.d.ts'), 'declare const api: unknown;');
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: source === 'environment' ? entry : '', NO_COLOR: '1' };
  if (source === 'settings') await file(path.join(agent, 'settings.json'), JSON.stringify({ extensions: ['configured/**/entry.ts'] }));
  if (source === 'package') {
    const pkg = path.join(cwd, 'package');
    await file(path.join(pkg, 'package.json'), JSON.stringify({name:'@fixture/typed-extension',version:'1.0.0',type:'module',aiHarness:{extensions:['src/entry.ts','src/entry.d.ts']}}));
    const workspaces = new WorkspaceManager({allowedRoots:[cwd],defaultCwd:cwd}); await workspaces.initialize();
    const trust = new ProjectTrustManager(path.join(agent, 'trust.json')); await trust.load(); await trust.trust(cwd);
    const plugins = new PluginService(workspaces, trust, path.join(agent, 'plugins.json'), agent); await plugins.load();
    const installed = await plugins.install({cwd,scope:'global',source:pkg}); expect(installed.packages[0]?.counts.extensions).toBe(1);
    expect(await plugins.getEnabledExtensionFiles({cwd})).toEqual([entry]);
  }
  const records = async (): Promise<Record[]> => (await readFile(trace,'utf8').catch(()=> '')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record);
  return { root,cwd,agent,entry,helper,env,records,file,body };
}
function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, input = '') {
  return new Promise<{code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd,env,stdio:['pipe','pipe','pipe']});let stdout='';let stderr='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),20_000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});child.stdin.end(input);
  });
}
async function invoke(test: Awaited<ReturnType<typeof fixture>>, mode: 'print'|'json'|'rpc', flags: string[], trusted=true) {
  const result=await run([cli,trusted?'--approve':'--no-approve','--no-session','--model','mock/mock-model',...flags,
    ...(mode==='print'?['--print']:['--mode',mode]),...(mode==='rpc'?[]:['Hello.'])],test.cwd,test.env,
  mode==='rpc'?JSON.stringify({type:'prompt',id:'typed',message:'Hello.'})+'\n':'');
  expect(result,result.stderr).toMatchObject({code:0,signal:null});expect(result.stdout.trim()).not.toBe('');
  if(mode!=='print') for(const line of result.stdout.trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('type');
  return test.records();
}

describe('emitted TypeScript extension startup and ownership',()=>{
  for(const mode of ['print','json','rpc'] as const) for(const source of ['global','project','settings','environment','package','explicit'] as const) for(const contributed of [false,true]) {
    it(`${mode}: ${source} TypeScript with ${contributed?'contributed':'ordinary'} startup`,async()=>{
      const test=await fixture(source);
      try {
        const records=await invoke(test,mode,[...(source==='explicit'?['-e',test.entry]:[]),...(contributed?['--typed-probe']:[])]);
        expect(records.filter(record=>record.kind==='import')).toHaveLength(1);expect(records.filter(record=>record.kind==='factory')).toHaveLength(1);
        const turns=records.filter(record=>record.kind==='turn');expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({value:'first',flag:contributed,core:true});expect(turns[0]?.tools).toContain('typed_docs');expect(turns[0]?.tools).toContain('read');
      } finally {await rm(test.root,{recursive:true,force:true});}
    },30_000);
  }
  for(const mode of ['print','json','rpc'] as const) {
    it(`${mode}: refuses project TypeScript before any import`,async()=>{
      const test=await fixture('project');try {expect(await invoke(test,mode,[],false)).toEqual([]);}finally{await rm(test.root,{recursive:true,force:true});}
    },30_000);
    it(`${mode}: no-extensions suppresses typed discovery but preserves explicit deduplicated code`,async()=>{
      const test=await fixture('global');try {
        expect(await invoke(test,mode,['--no-extensions'])).toEqual([]);
        const records=await invoke(test,mode,['--no-extensions','-e',test.entry,'-e',test.entry,'--typed-probe']);
        expect(records.filter(record=>record.kind==='import')).toHaveLength(1);expect(records.find(record=>record.kind==='turn')).toMatchObject({value:'first',flag:true,core:true});
      }finally{await rm(test.root,{recursive:true,force:true});}
    },30_000);
  }
  it('real PTY reload refreshes TypeScript dependencies and retains the preceding factory after syntax failure',async()=>{
    const test=await fixture('explicit');let terminal:ReturnType<typeof spawnPty>|undefined;let exited:{exitCode:number;signal?:number}|undefined;
    try {
      terminal=spawnPty(process.execPath,[cli,'--approve','--no-session','--model','mock/mock-model','-e',test.entry,'--typed-probe','--tui-mode','regular','--theme','dark','--name','typed-probe'],{cwd:test.cwd,env:test.env,cols:100,rows:30});
      let output='';terminal.onData(text=>{output+=text;});terminal.onExit(value=>{exited=value;});
      await vi.waitFor(()=>expect(output).toContain('typed-probe: '),{timeout:10_000});
      const prompt=async(count:number)=>{output='';terminal!.write('Hello.\r');await vi.waitFor(async()=>expect((await test.records()).filter(record=>record.kind==='turn')).toHaveLength(count),{timeout:10_000});await vi.waitFor(()=>expect(output).toContain('editor ready · Enter send'),{timeout:10_000});await vi.waitFor(()=>expect(output).toContain('typed-probe: '),{timeout:10_000});};
      const reload=async(failed=false)=>{output='';terminal!.write('/reload\r');await vi.waitFor(()=>expect(output).toContain(failed?'TypeScript extension evaluation failed.':'Reloaded '),{timeout:10_000});await vi.waitFor(()=>expect(output).toContain('typed-probe: '),{timeout:10_000});};
      await prompt(1);await test.file(test.helper,'export const value: string = "second";');await prompt(2);await reload();await prompt(3);
      await test.file(test.entry,'const source_secret: = "private-source-body"');await reload(true);expect(output).not.toContain('source_secret');expect(output).not.toContain('private-source-body');await prompt(4);
      await test.file(test.entry,test.body);await test.file(test.helper,'export const value: string = "third";');await reload();await prompt(5);
      const turns=(await test.records()).filter(record=>record.kind==='turn');expect(turns.map(record=>record.value)).toEqual(['first','first','second','second','third']);expect(turns.map(record=>record.flag)).toEqual([true,true,true,true,true]);
      terminal.write('/quit\r');await vi.waitFor(()=>expect(exited).toMatchObject({exitCode:0}),{timeout:10_000});
    }finally{if(terminal&&!exited)terminal.kill();await rm(test.root,{recursive:true,force:true});}
  },45_000);
  it('actual public emitted Core evaluates all TypeScript formats and late Core imports outside the checkout',async()=>{
    const test=await fixture('explicit');try {
      const script=path.join(test.root,'consumer.mjs');await test.file(script,`import assert from 'node:assert/strict'; import {writeFile} from 'node:fs/promises';
        import {ExtensionModuleLoader,ExtensionRegistry,resolveBuiltinExtensionPolicy} from ${JSON.stringify(core)};
        const root=${JSON.stringify(test.root)};
        for(const suffix of ['ts','mts','cts','tsx']) {
          const file=root+'/entry.'+suffix;
          await writeFile(file, 'enum Value { Ready=7 }; export default api=>api.registerCommand("typed",{description:"Typed",handler:async()=>({value:Value.Ready,fn:(await import("@ai-harness/core")).resolveBuiltinExtensionPolicy})});');
          const registry=new ExtensionRegistry();const loader=new ExtensionModuleLoader(registry,{cwd:root,paths:[file],includeGlobalLocation:false,includeProjectLocation:false,includeEnvironmentPaths:false});
          const loaded=await loader.loadAll();assert.deepEqual(loaded.errors,[]);assert.equal(loaded.committed,true);
          const value=await registry.getCommand('typed').handler('',{});assert.equal(value.value,7);assert.equal(value.fn,resolveBuiltinExtensionPolicy);await loader.clear();
        }
        console.log('public-typescript-ok');`);
      const result=await run([script],test.root,test.env);expect(result,result.stderr).toMatchObject({code:0,signal:null});expect(result.stdout).toContain('public-typescript-ok');
    }finally{await rm(test.root,{recursive:true,force:true});}
  },30_000);
  it.runIf(process.platform==='linux')('keeps TypeScript entry descriptor identity while a pathname is replaced during evaluation',async()=>{
    const test=await fixture('explicit');const ready=path.join(test.root,'ready');const release=path.join(test.root,'release');const marker=path.join(test.root,'marker');const replacement=path.join(test.root,'replacement.ts');
    let pending: ReturnType<typeof run> | undefined;
    try {
      await test.file(test.entry,`import {readFile,writeFile} from 'node:fs/promises'; enum Value { Ready=1 };
        await writeFile(${JSON.stringify(ready)},String(Value.Ready));
        while(true){try{if(await readFile(${JSON.stringify(release)},'utf8')==='go')break;}catch{} await new Promise(resolve=>setTimeout(resolve,5));}
        await writeFile(${JSON.stringify(marker)},'original');export default()=>{};`);
      await test.file(replacement,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'replacement');export default()=>{};`);
      const script=path.join(test.root,'race.mjs');await test.file(script,`import {ExtensionModuleLoader,ExtensionRegistry} from ${JSON.stringify(core)};const loader=new ExtensionModuleLoader(new ExtensionRegistry(),{cwd:${JSON.stringify(test.root)},paths:[${JSON.stringify(test.entry)}],includeGlobalLocation:false,includeProjectLocation:false,includeEnvironmentPaths:false});const result=await loader.loadAll();console.log(JSON.stringify({committed:result.committed,error:result.errors[0]?.error.message}));`);
      pending=run([script],test.root,test.env);await vi.waitFor(async()=>expect(await readFile(ready,'utf8')).toBe('1'),{timeout:10_000});
      await rename(replacement,test.entry);await test.file(release,'go');const result=await pending;expect(result,result.stderr).toMatchObject({code:0,signal:null});
      expect(JSON.parse(result.stdout)).toEqual({committed:false,error:'Extension module changed while it was being imported'});expect(await readFile(marker,'utf8')).toBe('original');
    }finally{await test.file(release,'go');await pending?.catch(()=>undefined);await rm(test.root,{recursive:true,force:true});}
  },30_000);
});
