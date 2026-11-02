import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
type Source = 'global' | 'project' | 'settings' | 'environment' | 'explicit';
async function fixture(source: Source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-manifest-process-'));
  const cwd = path.join(root, 'project'); const agent = path.join(root, 'agent'); const trace = path.join(root, 'trace');
  const pkg = source === 'global' ? path.join(agent, 'extensions/pkg') : source === 'project' ? path.join(cwd, '.ai-harness/extensions/pkg')
    : source === 'settings' ? path.join(agent, 'configured [literal]') : path.join(root, 'explicit');
  const file = async (name: string, body: string) => { await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, body); };
  const manifest = path.join(pkg, 'package.json');
  const select = (name: string) => file(manifest, JSON.stringify({ aiHarness: { extensions: [`src/${name}.ts`] } }));
  await mkdir(cwd, { recursive: true }); await mkdir(agent, { recursive: true });
  for (const value of ['first', 'second', 'third']) await file(path.join(pkg, `src/${value}.ts`), `import {appendFileSync} from 'node:fs';
    const record = (value: unknown) => appendFileSync(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');
    record({kind:'import',value:${JSON.stringify(value)}});export default api => {
      record({kind:'factory'});api.registerOption('manifest-probe',{type:'boolean',description:'Manifest',default:false});
      api.before('before:provider',data=>record({kind:'turn',value:${JSON.stringify(value)},flag:api.getOption('manifest-probe'),tools:data.options.tools.map(tool=>tool.name)}));
    };`);
  await file(path.join(pkg, 'index.mjs'), 'throw new Error("Undeclared index ran");'); await select('first');
  if (source === 'settings') await file(path.join(agent, 'settings.json'), JSON.stringify({ extensions: ['+configured [literal]'] }));
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: source === 'environment' ? pkg : '', NO_COLOR: '1' };
  const records = async (): Promise<Array<{kind:string;value?:string;flag?:boolean;tools?:string[]}>> => (await readFile(trace, 'utf8').catch(()=> '')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return { root, cwd, agent, pkg, manifest, trace, file, select, env, records };
}
function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, input = '') {
  return new Promise<{code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd,env,stdio:['pipe','pipe','pipe']});let stdout='';let stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),20_000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});child.stdin.end(input);
  });
}
async function invoke(test: Awaited<ReturnType<typeof fixture>>, mode: 'print'|'json'|'rpc', flags: string[], trusted = true) {
  const result=await run([cli,trusted?'--approve':'--no-approve','--no-session','--model','mock/mock-model',...flags,
    ...(mode==='print'?['--print']:['--mode',mode]),...(mode==='rpc'?[]:['Hello.'])],test.cwd,test.env,mode==='rpc'?JSON.stringify({type:'prompt',id:'manifest',message:'Hello.'})+'\n':'');
  expect(result,result.stderr).toMatchObject({code:0,signal:null});expect(result.stdout.trim()).not.toBe('');
  if(mode!=='print')for(const line of result.stdout.trim().split('\n'))expect(JSON.parse(line)).toHaveProperty('type');
  return test.records();
}

describe('emitted directory-manifest extension resolution',()=>{
  for(const mode of ['print','json','rpc'] as const)for(const source of ['global','project','settings','environment','explicit'] as const)for(const contributed of [false,true]) {
    it(`${mode}: ${source} manifest with ${contributed?'contributed':'ordinary'} startup`,async()=>{
      const test=await fixture(source);try {
        const records=await invoke(test,mode,[...(source==='explicit'?['-e',test.pkg]:[]),...(contributed?['--manifest-probe']:[])]);
        expect(records.filter(record=>record.kind==='import')).toEqual([{kind:'import',value:'first'}]);expect(records.filter(record=>record.kind==='factory')).toHaveLength(1);
        const turns=records.filter(record=>record.kind==='turn');expect(turns).toHaveLength(1);expect(turns[0]).toMatchObject({value:'first',flag:contributed});expect(turns[0]?.tools).toContain('read');
      }finally{await rm(test.root,{recursive:true,force:true});}
    },30_000);
  }
  for(const mode of ['print','json','rpc'] as const){
    it(`${mode}: refusal does not parse project manifest bodies`,async()=>{
      const test=await fixture('project');try{await test.file(test.manifest,'{ private-source');expect(await invoke(test,mode,[],false)).toEqual([]);}finally{await rm(test.root,{recursive:true,force:true});}
    },30_000);
    it(`${mode}: automatic suppression and explicit duplicate preservation precede manifest resolution`,async()=>{
      const test=await fixture('global');try{
        await test.file(test.manifest,'{ private-source');expect(await invoke(test,mode,['--no-extensions'])).toEqual([]);
        await test.select('first');const records=await invoke(test,mode,['--no-extensions','-e',test.pkg,'-e',test.pkg,'--manifest-probe']);
        expect(records.filter(record=>record.kind==='import')).toHaveLength(1);expect(records.find(record=>record.kind==='turn')).toMatchObject({value:'first',flag:true});
      }finally{await rm(test.root,{recursive:true,force:true});}
    },30_000);
  }
  it('genuine PTY reload refreshes manifest selection only on reload and retains it after invalid metadata',async()=>{
    const test=await fixture('explicit');let terminal:ReturnType<typeof spawnPty>|undefined;let exited:{exitCode:number;signal?:number}|undefined;
    try{
      terminal=spawnPty(process.execPath,[cli,'--approve','--no-session','--model','mock/mock-model','-e',test.pkg,'--manifest-probe','--tui-mode','regular','--theme','dark','--name','manifest-probe'],{cwd:test.cwd,env:test.env,cols:100,rows:30});
      let output='';terminal.onData(text=>{output+=text;});terminal.onExit(value=>{exited=value;});await vi.waitFor(()=>expect(output).toContain('manifest-probe: '),{timeout:10_000});
      // PTY delivery can lag input: ready must follow this response/reload, not an older prompt.
      const prompt=async(count:number)=>{output='';terminal!.write('Hello.\r');await vi.waitFor(async()=>expect((await test.records()).filter(record=>record.kind==='turn')).toHaveLength(count),{timeout:10_000});await vi.waitFor(()=>expect(output).toMatch(/└──────────────[\s\S]*editor ready · Enter send/),{timeout:10_000});await vi.waitFor(()=>expect(output).toContain('manifest-probe: '),{timeout:10_000});};
      const reload=async(failed=false)=>{output='';terminal!.write('/reload\r');await vi.waitFor(()=>expect(output).toContain(failed?'Extension manifest is invalid or exceeds its limits.':'Reloaded '),{timeout:10_000});await vi.waitFor(()=>expect(output).toMatch(failed?/Extension manifest is invalid or exceeds its limits\.[\s\S]*editor ready · Enter send/:/Reloaded [\s\S]*editor ready · Enter send/),{timeout:10_000});await vi.waitFor(()=>expect(output).toContain('manifest-probe: '),{timeout:10_000});};
      await prompt(1);await test.select('second');await prompt(2);await reload();await prompt(3);
      await test.file(test.manifest,'{ "private_source_secret" :');await reload(true);expect(output).not.toContain('private_source_secret');await prompt(4);
      await test.select('third');await reload();await prompt(5);const turns=(await test.records()).filter(record=>record.kind==='turn');expect(turns.map(record=>record.value)).toEqual(['first','first','second','second','third']);expect(turns.every(record=>record.flag)).toBe(true);
      terminal.write('/quit\r');await vi.waitFor(()=>expect(exited).toMatchObject({exitCode:0}),{timeout:10_000});
    }finally{if(terminal&&!exited)terminal.kill();await rm(test.root,{recursive:true,force:true});}
  },45_000);
  it.runIf(process.platform==='linux')('actual public Core refuses manifest replacement between metadata admission and descriptor open',async()=>{
    const test=await fixture('explicit');const ready=path.join(test.root,'ready');const release=path.join(test.root,'release');const replacement=path.join(test.root,'replacement.json');let pending:ReturnType<typeof run>|undefined;
    try{
      const script=path.join(test.root,'race.mjs');await test.file(script,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {ExtensionModuleLoader,ExtensionRegistry} from ${JSON.stringify(core)};
        const original=fs.open;let held=false;fs.open=async function(filename,...args){if(!held&&String(filename).startsWith('/proc/self/fd/')&&String(filename).endsWith('/package.json')){held=true;await fs.writeFile(${JSON.stringify(ready)},'ready');while(true){try{if(await fs.readFile(${JSON.stringify(release)},'utf8')==='go')break;}catch{}await new Promise(resolve=>setTimeout(resolve,5));}}return original.call(this,filename,...args);};syncBuiltinESMExports();
        try{const loader=new ExtensionModuleLoader(new ExtensionRegistry(),{cwd:${JSON.stringify(test.root)},paths:[${JSON.stringify(test.pkg)}],includeGlobalLocation:false,includeProjectLocation:false,includeEnvironmentPaths:false});const result=await loader.loadAll();console.log(JSON.stringify({committed:result.committed,error:result.errors[0]?.error.message}));}finally{fs.open=original;syncBuiltinESMExports();}`);
      pending=run([script],test.root,test.env);await vi.waitFor(async()=>expect(await readFile(ready,'utf8')).toBe('ready'),{timeout:10_000});
      await test.file(replacement,JSON.stringify({aiHarness:{extensions:['src/second.ts']}}));await rename(replacement,test.manifest);await test.file(release,'go');
      const result=await pending;expect(result,result.stderr).toMatchObject({code:0,signal:null});expect(JSON.parse(result.stdout)).toEqual({committed:false,error:'Extension manifest is invalid or exceeds its limits.'});expect(await test.records()).toEqual([]);
    }finally{await test.file(release,'go');await pending?.catch(()=>undefined);await rm(test.root,{recursive:true,force:true});}
  },30_000);
});
