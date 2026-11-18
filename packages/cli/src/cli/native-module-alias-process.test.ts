import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';
const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
async function fixture(suffix: 'js'|'mjs'|'cjs', project = false) {
  const root=await mkdtemp(path.join(os.tmpdir(),'aih-native-cli-'));const cwd=path.join(root,'project');const agent=path.join(root,'agent');const trace=path.join(root,'trace');
  const directory=project?path.join(cwd,'.ai-harness/extensions'):path.join(root,'extensions');const entry=path.join(directory,'entry.'+suffix);
  await mkdir(cwd,{recursive:true});await mkdir(agent);await mkdir(directory,{recursive:true});
  const helper=path.join(directory,'helper.'+(suffix==='cjs'?'cjs':'mjs'));
  const helperBody=(value:string)=>suffix==='cjs'?`exports.value=${JSON.stringify(value)};exports.late=()=>require('@ai-harness/core').ExtensionRegistry;`:`export const value=${JSON.stringify(value)};export const late=async()=>(await import('@ai-harness/core')).ExtensionRegistry;`;
  await writeFile(helper,helperBody('first'));
  const source=(value:string)=>`${suffix==='cjs'?`const {ExtensionRegistry:Class,BUILTIN_EXTENSION_NAMES}=require('@ai-harness/core');const {late,value:dependency}=require('./helper.cjs');const {appendFileSync}=require('node:fs');`:`import {ExtensionRegistry as Class,BUILTIN_EXTENSION_NAMES} from '@ai-harness/core';import{late,value as dependency}from'./helper.mjs';import{appendFileSync}from'node:fs';`}
    const record=value=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');record({kind:'import'});
    ${suffix==='cjs'?'module.exports=':'export default '}api=>{record({kind:'factory'});api.registerOption('native-probe',{type:'boolean',description:'Native',default:false});
      api.before('before:provider',async data=>record({kind:'turn',entry:${JSON.stringify(value)},dependency,flag:api.getOption('native-probe'),identity:Class===await late()&&Class===(await import('@ai-harness/core')).ExtensionRegistry&&Object.isFrozen(BUILTIN_EXTENSION_NAMES),tools:data.options.tools.map(tool=>tool.name)}));
      return async()=>record({kind:'cleanup',identity:Class===(await import('@ai-harness/core')).ExtensionRegistry});};`;
  await writeFile(entry,source('first'));
  const env={...process.env,HOME:path.join(root,'home'),AI_HARNESS_AGENT_DIR:agent,AI_HARNESS_EXTENSIONS:'',NO_COLOR:'1'};
  const records=async():Promise<Array<{kind:string;entry?:string;dependency?:string;flag?:boolean;identity?:boolean;tools?:string[]}>>=>(await readFile(trace,'utf8').catch(()=> '')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {root,cwd,entry,helper,helperBody,source,env,records};
}
async function invoke(test:Awaited<ReturnType<typeof fixture>>,mode:'print'|'json'|'rpc',contributed:boolean,trusted=true){
  const child=spawn(process.execPath,[cli,trusted?'--approve':'--no-approve','--no-session','--model','mock/mock-model','-e',test.entry,...(contributed?['--native-probe']:[]),...(mode==='print'?['--print']:['--mode',mode]),...(mode==='rpc'?[]:['Hello.'])],{cwd:test.cwd,env:test.env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});const timer=setTimeout(()=>child.kill('SIGKILL'),20_000);
  child.stdin.end(mode==='rpc'?JSON.stringify({type:'prompt',id:'native',message:'Hello.'})+'\n':'');
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer);
  expect(result,stderr).toEqual({code:0,signal:null});expect(stdout.trim()).not.toBe('');if(mode!=='print')for(const line of stdout.trim().split('\n'))expect(JSON.parse(line)).toHaveProperty('type');return test.records();
}
describe('native public Core aliases in the emitted CLI',()=>{
  for(const suffix of ['js','mjs','cjs'] as const)for(const mode of ['print','json','rpc'] as const)for(const contributed of [false,true]){
    it(`${mode}: ${suffix} host namespace with ${contributed?'contributed':'ordinary'} startup`,async()=>{
      const test=await fixture(suffix);try{
        const records=await invoke(test,mode,contributed);expect(records.filter(record=>record.kind==='import')).toHaveLength(1);expect(records.filter(record=>record.kind==='factory')).toHaveLength(1);
        const turns=records.filter(record=>record.kind==='turn');expect(turns).toHaveLength(1);expect(turns[0]).toMatchObject({entry:'first',dependency:'first',flag:contributed,identity:true});expect(turns[0]?.tools).toContain('read');
      }finally{await rm(test.root,{recursive:true,force:true});}
    },30_000);
  }
  it.each(['print','json','rpc'] as const)('%s refuses project native code before registering aliases or factories',async mode=>{
    const test=await fixture('mjs',true);try{expect(await invoke(test,mode,false,false)).toEqual([]);}finally{await rm(test.root,{recursive:true,force:true});}
  },30_000);
  it.each(['mjs','cjs'] as const)('real PTY %s entry reload retains native dependency cache and alias ownership after failed imports',async suffix=>{
    const test=await fixture(suffix);let terminal:ReturnType<typeof spawnPty>|undefined;let exited:{exitCode:number;signal?:number}|undefined;
    try{
      terminal=spawnPty(process.execPath,[cli,'--approve','--no-session','--model','mock/mock-model','-e',test.entry,'--native-probe','--tui-mode','regular','--theme','dark','--name','native-probe'],{cwd:test.cwd,env:test.env,cols:100,rows:30});let output='';terminal.onData(text=>{output+=text;});terminal.onExit(value=>{exited=value;});await vi.waitFor(()=>expect(output).toContain('native-probe: '),{timeout:10_000});
      const prompt=async(count:number)=>{output='';terminal!.write('Hello.\r');await vi.waitFor(async()=>expect((await test.records()).filter(record=>record.kind==='turn')).toHaveLength(count),{timeout:10_000});await vi.waitFor(()=>expect(output).toMatch(/└──────────────[\s\S]*editor ready · Enter send/),{timeout:10_000});await vi.waitFor(()=>expect(output).toContain('native-probe: '),{timeout:10_000});};
      const reload=async(failed=false)=>{output='';terminal!.write('/reload\r');await vi.waitFor(()=>expect(output).toContain(failed?'native-candidate-refused':'Reloaded '),{timeout:10_000});await vi.waitFor(()=>expect(output).toMatch(failed?/native-candidate-refused[\s\S]*editor ready · Enter send/:/Reloaded [\s\S]*editor ready · Enter send/),{timeout:10_000});await vi.waitFor(()=>expect(output).toContain('native-probe: '),{timeout:10_000});};
      await prompt(1);await writeFile(test.entry,test.source('second'));await writeFile(test.helper,test.helperBody('changed-on-disk'));await prompt(2);await reload();await prompt(3);
      await writeFile(test.entry,'throw new Error("native-candidate-refused");');await reload(true);await prompt(4);await writeFile(test.entry,test.source('third'));await reload();await prompt(5);
      const turns=(await test.records()).filter(record=>record.kind==='turn');expect(turns.map(record=>record.entry)).toEqual(['first','first','second','second','third']);expect(turns.every(record=>record.dependency==='first'&&record.identity&&record.flag)).toBe(true);
      terminal.write('/quit\r');await vi.waitFor(()=>expect(exited).toMatchObject({exitCode:0}),{timeout:10_000});const cleanups=(await test.records()).filter(record=>record.kind==='cleanup');expect(cleanups.length).toBeGreaterThanOrEqual(2);expect(cleanups.every(record=>record.identity)).toBe(true);
    }finally{if(terminal&&!exited)terminal.kill();await rm(test.root,{recursive:true,force:true});}
  },45_000);
});
