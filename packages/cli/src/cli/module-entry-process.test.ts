import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';
const cli=fileURLToPath(new URL('../../dist/index.js',import.meta.url));const core=fileURLToPath(new URL('../../../core/dist/index.js',import.meta.url));
type Source='global'|'project'|'settings'|'environment'|'explicit';type Resolution='main'|'suffix';
async function fixture(source:Source,resolution:Resolution){
  const root=await mkdtemp(path.join(os.tmpdir(),'aih-module-entry-cli-'));const cwd=path.join(root,'project');const agent=path.join(root,'agent');const trace=path.join(root,'trace');
  const pkg=source==='global'?path.join(agent,'extensions/pkg'):source==='project'?path.join(cwd,'.ai-harness/extensions/pkg'):source==='settings'?path.join(agent,'configured [literal]'):path.join(root,'explicit');
  const file=async(name:string,body:string)=>{await mkdir(path.dirname(name),{recursive:true});await writeFile(name,body);};await mkdir(cwd,{recursive:true});await mkdir(agent,{recursive:true});
  const directory=resolution==='main'?path.join(pkg,'module'):pkg;const manifest=path.join(directory,'package.json');
  const select=async(name:string)=>{if(resolution==='main')await file(path.join(pkg,'package.json'),JSON.stringify({aiHarness:{extensions:['module']}}));await file(manifest,JSON.stringify(resolution==='main'?{main:`src/${name}.js`}:{aiHarness:{extensions:[`src/${name}.js`]}}));};
  for(const value of ['first','second','third'])await file(path.join(directory,`src/${value}.ts`),`import{BUILTIN_EXTENSION_NAMES}from'@ai-harness/core';import{appendFileSync}from'node:fs';const record=(value:unknown)=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');record({kind:'import',value:${JSON.stringify(value)}});export default api=>{record({kind:'factory'});api.registerOption('entry-probe',{type:'boolean',description:'Entry',default:false});api.before('before:provider',data=>record({kind:'turn',value:${JSON.stringify(value)},host:Object.isFrozen(BUILTIN_EXTENSION_NAMES),flag:api.getOption('entry-probe'),tools:data.options.tools.map(tool=>tool.name)}));};`);
  await file(path.join(pkg,'index.mjs'),'throw new Error("Resource fallback must not run");');if(resolution==='main')await file(path.join(directory,'index.mjs'),'throw new Error("Main fallback must not run");');await select('first');
  if(source==='settings')await file(path.join(agent,'settings.json'),JSON.stringify({extensions:['+configured [literal]']}));
  const env={...process.env,HOME:path.join(root,'home'),AI_HARNESS_AGENT_DIR:agent,AI_HARNESS_EXTENSIONS:source==='environment'?pkg:'',NO_COLOR:'1'};
  const records=async():Promise<Array<{kind:string;value?:string;host?:boolean;flag?:boolean;tools?:string[]}>>=>(await readFile(trace,'utf8').catch(()=> '')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));return{root,cwd,agent,pkg,manifest,trace,file,select,env,records};
}
function run(args:string[],cwd:string,env:NodeJS.ProcessEnv,input=''){
  return new Promise<{code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}>((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),20_000);child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});child.stdin.end(input);});
}
async function invoke(test:Awaited<ReturnType<typeof fixture>>,mode:'print'|'json'|'rpc',flags:string[],trusted=true){
  const result=await run([cli,trusted?'--approve':'--no-approve','--no-session','--model','mock/mock-model',...flags,...(mode==='print'?['--print']:['--mode',mode]),...(mode==='rpc'?[]:['Hello.'])],test.cwd,test.env,mode==='rpc'?JSON.stringify({type:'prompt',id:'entry',message:'Hello.'})+'\n':'');
  expect(result,result.stderr).toMatchObject({code:0,signal:null});expect(result.stdout.trim()).not.toBe('');if(mode!=='print')for(const line of result.stdout.trim().split('\n'))expect(JSON.parse(line)).toHaveProperty('type');return test.records();
}
describe('actual emitted module-entry resolution',()=>{
  for(const resolution of ['main','suffix'] as const)for(const source of ['global','project','settings','environment','explicit'] as const)for(const mode of ['print','json','rpc'] as const)for(const contributed of [false,true]){
    it(`${mode}: ${source} ${resolution}, ${contributed?'contributed':'ordinary'} startup`,async()=>{
      const test=await fixture(source,resolution);try{const records=await invoke(test,mode,[...(source==='explicit'?['-e',test.pkg]:[]),...(contributed?['--entry-probe']:[])]);expect(records.filter(record=>record.kind==='import')).toEqual([{kind:'import',value:'first'}]);expect(records.filter(record=>record.kind==='factory')).toHaveLength(1);const turns=records.filter(record=>record.kind==='turn');expect(turns).toHaveLength(1);expect(turns[0]).toMatchObject({value:'first',host:true,flag:contributed});expect(turns[0]?.tools).toContain('read');}finally{await rm(test.root,{recursive:true,force:true});}
    },30_000);
  }
  for(const mode of ['print','json','rpc'] as const)for(const [output,source] of [['','.ts'],['.js','.ts'],['.mjs','.mts'],['.cjs','.cts'],['.jsx','.tsx']])it(`${mode}: direct ${output||'suffixless'} entry to ${source} with exact-source deduplication`,async()=>{
    const test=await fixture('explicit','suffix');try{const base=path.join(test.pkg,'src/first');if(source!=='.ts')await rename(base+'.ts',base+source);for(const extras of [[],['-e',base+source]]){await test.file(test.trace,'');const records=await invoke(test,mode,['-e',base+output,...extras,'--entry-probe']);expect(records.filter(record=>record.kind==='import')).toHaveLength(1);expect(records.filter(record=>record.kind==='factory')).toHaveLength(1);expect(records.filter(record=>record.kind==='turn')).toEqual([expect.objectContaining({value:'first',flag:true,host:true})]);}}finally{await rm(test.root,{recursive:true,force:true});}
  },30_000);
  for(const mode of ['print','json','rpc'] as const)for(const contributed of [false,true])it(`${mode}: custom agent automatic directory never becomes a sibling module (${contributed})`,async()=>{
    const test=await fixture('explicit','main');try{
      await test.file(path.join(test.agent,'extensions.ts'),'throw new Error("Automatic agent directory became a module");');await test.file(path.join(test.cwd,'.ai-harness/extensions.ts'),'throw new Error("Automatic project directory became a module");');
      const records=await invoke(test,mode,['-e',path.join(test.pkg,'module/src/first.ts'),...(contributed?['--entry-probe']:[])]);expect(records.filter(record=>record.kind==='turn')).toEqual([expect.objectContaining({value:'first',flag:contributed,host:true})]);
    }finally{await rm(test.root,{recursive:true,force:true});}
  },30_000);
  it.each(['print','json','rpc'] as const)('%s refuses project main metadata and preserves explicit module selection under automatic suppression',async mode=>{
    const test=await fixture('project','main');try{
      await test.file(test.manifest,'{ private-source');expect(await invoke(test,mode,[],false)).toEqual([]);await test.select('first');
      expect(await invoke(test,mode,['--no-extensions'])).toEqual([]);const records=await invoke(test,mode,['--no-extensions','-e',test.pkg,'-e',test.pkg,'--entry-probe']);expect(records.filter(record=>record.kind==='import')).toHaveLength(1);expect(records.filter(record=>record.kind==='turn')).toEqual([expect.objectContaining({value:'first',flag:true,host:true})]);
    }finally{await rm(test.root,{recursive:true,force:true});}
  },30_000);
  it('genuine PTY reload reselects main only on reload, retains the previous entry after an escape, and recovers',async()=>{
    const test=await fixture('explicit','main');let terminal:ReturnType<typeof spawnPty>|undefined;let exited:{exitCode:number;signal?:number}|undefined;
    try{terminal=spawnPty(process.execPath,[cli,'--approve','--no-session','--model','mock/mock-model','-e',test.pkg,'--entry-probe','--tui-mode','regular','--theme','dark','--name','entry-probe'],{cwd:test.cwd,env:test.env,cols:100,rows:30});let output='';terminal.onData(text=>{output+=text;});terminal.onExit(value=>{exited=value;});await vi.waitFor(()=>expect(output).toContain('entry-probe: '),{timeout:10_000});
      // Correlate readiness with this response/reload, not an earlier buffered status frame.
      const prompt=async(count:number)=>{output='';terminal!.write('Hello.\r');await vi.waitFor(async()=>expect((await test.records()).filter(record=>record.kind==='turn')).toHaveLength(count),{timeout:10_000});await vi.waitFor(()=>expect(output).toMatch(/└──────────────[\s\S]*editor ready · Enter send/),{timeout:10_000});await vi.waitFor(()=>expect(output).toContain('entry-probe: '),{timeout:10_000});};
      const reload=async(failed=false)=>{output='';terminal!.write('/reload\r');await vi.waitFor(()=>expect(output).toContain(failed?'Extension manifest is invalid or exceeds its limits.':'Reloaded '),{timeout:10_000});await vi.waitFor(()=>{expect(output).toMatch(failed?/Extension manifest is invalid or exceeds its limits\.[\s\S]*editor ready · Enter send/:/Reloaded [\s\S]*editor ready · Enter send/);expect(output).toContain('entry-probe: ');},{timeout:10_000});};
      await prompt(1);await test.select('second');await prompt(2);await reload();await prompt(3);await test.file(test.manifest,JSON.stringify({main:'../private-source.ts'}));await reload(true);expect(output).not.toContain('private-source');await prompt(4);await test.select('third');await reload();await prompt(5);
      const turns=(await test.records()).filter(record=>record.kind==='turn');expect(turns.map(record=>record.value)).toEqual(['first','first','second','second','third']);expect(turns.every(record=>record.flag&&record.host)).toBe(true);terminal.write('/quit\r');await vi.waitFor(()=>expect(exited).toMatchObject({exitCode:0}),{timeout:10_000});
    }finally{if(terminal&&!exited)terminal.kill();await rm(test.root,{recursive:true,force:true});}
  },45_000);
  it.runIf(process.platform==='linux')('public Core refuses nested main metadata replacement between admission and descriptor open',async()=>{
    const test=await fixture('explicit','main');const ready=path.join(test.root,'ready');const release=path.join(test.root,'release');const replacement=path.join(test.root,'replacement.json');let pending:ReturnType<typeof run>|undefined;
    try{const script=path.join(test.root,'race.mjs');await test.file(script,`import fs from'node:fs/promises';import{syncBuiltinESMExports}from'node:module';import{ExtensionModuleLoader,ExtensionRegistry}from ${JSON.stringify(core)};const original=fs.open;let count=0;fs.open=async function(filename,...args){if(String(filename).startsWith('/proc/self/fd/')&&String(filename).endsWith('/package.json')&&++count===2){await fs.writeFile(${JSON.stringify(ready)},'ready');while(true){try{if(await fs.readFile(${JSON.stringify(release)},'utf8')==='go')break;}catch{}await new Promise(resolve=>setTimeout(resolve,5));}}return original.call(this,filename,...args);};syncBuiltinESMExports();try{const loader=new ExtensionModuleLoader(new ExtensionRegistry(),{cwd:${JSON.stringify(test.root)},paths:[${JSON.stringify(test.pkg)}],includeGlobalLocation:false,includeProjectLocation:false,includeEnvironmentPaths:false});const result=await loader.loadAll();console.log(JSON.stringify({committed:result.committed,error:result.errors[0]?.error.message,count}));}finally{fs.open=original;syncBuiltinESMExports();}`);
      pending=run([script],test.root,test.env);await vi.waitFor(async()=>expect(await readFile(ready,'utf8')).toBe('ready'),{timeout:10_000});await test.file(replacement,JSON.stringify({main:'src/second.js'}));await rename(replacement,test.manifest);await test.file(release,'go');const result=await pending;expect(result,result.stderr).toMatchObject({code:0,signal:null});expect(JSON.parse(result.stdout)).toEqual({committed:false,error:'Extension manifest is invalid or exceeds its limits.',count:2});expect(await test.records()).toEqual([]);
    }finally{await test.file(release,'go');await pending?.catch(()=>undefined);await rm(test.root,{recursive:true,force:true});}
  },30_000);
});
