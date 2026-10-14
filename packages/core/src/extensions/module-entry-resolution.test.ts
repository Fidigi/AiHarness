import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionModuleLoader } from './module-loader.js';
import { ExtensionRegistry } from './extension-registry.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'aih-entry-resolution-'));roots.push(root);const cwd=path.join(root,'project');const pkg=path.join(root,'package [literal]');await mkdir(cwd);await mkdir(pkg);const registry=new ExtensionRegistry();
  const file=async(name:string,body:string)=>{await mkdir(path.dirname(name),{recursive:true});await writeFile(name,body);return name;};
  const json=(directory:string,value:unknown)=>file(path.join(directory,'package.json'),JSON.stringify(value));
  const factory=(name:string,suffix='.ts')=>`${suffix==='.cjs'||suffix==='.cts'?'module.exports=':'export default '}api=>api.registerCommand(${JSON.stringify(name)},{description:'Entry',handler:()=>${JSON.stringify(name)}});`;
  const loader=(paths:string[],selectors:string[]=[],trusted=true)=>new ExtensionModuleLoader(registry,{cwd,paths,selectors,isProjectTrusted:()=>trusted,includeGlobalLocation:false,includeProjectLocation:false,includeEnvironmentPaths:false});
  return{root,cwd,pkg,registry,file,json,factory,loader};
}
const diagnostic='Extension manifest is invalid or exceeds its limits.';
describe('bounded literal module-entry resolution',()=>{
  it.each(['.mjs','.js','.cjs','.ts','.mts','.cts','.tsx'])('resolves an explicit suffixless path to %s',async suffix=>{
    const test=await fixture();const requested=path.join(test.pkg,'entry');const entry=await test.file(requested+suffix,test.factory('chosen',suffix));
    expect(await test.loader([requested]).loadAll()).toMatchObject({committed:true,loaded:[entry],errors:[]});expect(test.registry.getCommand('chosen')).toBeDefined();
  });
  it.each([['.js','.ts'],['.mjs','.mts'],['.cjs','.cts'],['.jsx','.tsx']])('resolves missing output %s to source %s',async(output,source)=>{
    const test=await fixture();const base=path.join(test.pkg,'entry');const entry=await test.file(base+source,test.factory('source',source));
    const paths=[base+output];const loader=test.loader(paths);expect(await loader.loadAll()).toMatchObject({committed:true,loaded:[entry]});expect(test.registry.getCommand('source')).toBeDefined();
    paths.push(entry);expect(await loader.reload()).toMatchObject({committed:true,loaded:[entry]});
  });
  it.each([['.js','.tsx'],['.mjs','.ts'],['.cjs','.ts']])('does not invent unsupported output %s to source %s mappings',async(output,source)=>{
    const test=await fixture();const base=path.join(test.pkg,'entry');await test.file(base+source,'throw new Error("Unsupported suffix fallback ran");');expect(await test.loader([base+output]).loadAll()).toMatchObject({committed:true,loaded:[],errors:[]});
  });
  it('prefers an existing explicit file and conserves JS-first suffix ordering',async()=>{
    const test=await fixture();const base=path.join(test.pkg,'entry');const js=await test.file(base+'.js',test.factory('js','.js'));await test.file(base+'.ts','throw new Error("Source fallback must not run");');
    const loader=test.loader([base+'.js',base]);expect((await loader.loadAll()).loaded).toEqual([js]);
    const mjs=await test.file(base+'.mjs',test.factory('mjs','.mjs'));expect((await test.loader([base]).loadAll()).loaded).toEqual([mjs]);expect(test.registry.getCommand('mjs')).toBeDefined();await loader.clear();
  });
  it.each([['.d.js','.d.ts'],['.d.mjs','.d.mts'],['.d.cjs','.d.cts']])('never evaluates declaration fallback %s → %s',async(output,source)=>{
    const test=await fixture();const base=path.join(test.pkg,'types');await test.file(base+source,'throw new Error("Declaration must not run");');expect(await test.loader([base+output]).loadAll()).toMatchObject({committed:true,loaded:[],errors:[]});
  });
  it('never replaces an existing safe nonexecutable literal with a sibling module',async()=>{
    const test=await fixture();const entry=await test.file(path.join(test.pkg,'notes'),'not executable');await test.file(entry+'.mjs','throw new Error("Sibling must not run");');expect((await test.loader([entry]).loadAll()).loaded).toEqual([]);
  });
  it.each(['literal','source','directory'])('resolves a declared directory main %s before indexes, without interpreting nested resource arrays',async kind=>{
    const test=await fixture();const directory=path.join(test.pkg,'nested');const relative=kind==='literal'?'src/entry.cjs':kind==='source'?'src/entry.ts':'src/index.ts';const entry=await test.file(path.join(directory,relative),test.factory('main',kind==='literal'?'.cjs':'.ts'));
    await test.json(test.pkg,{pi:{extensions:['nested']}});await test.json(directory,{main:kind==='literal'?relative:kind==='source'?'src\\entry.js':'src',aiHarness:{extensions:[]},pi:{extensions:['../forbidden.ts']}});
    await test.file(path.join(directory,'index.mjs'),'throw new Error("Index fallback must not run");');await test.file(path.join(test.pkg,'index.mjs'),'throw new Error("Sibling fallback must not run");');
    expect(await test.loader([test.pkg]).loadAll()).toMatchObject({committed:true,loaded:[entry],errors:[]});expect(test.registry.getCommand('main')).toBeDefined();
  });
  it('deduplicates resolved declarations and keeps selectors tied to actual admitted files',async()=>{
    const test=await fixture();const entry=await test.file(path.join(test.pkg,'src/entry.ts'),test.factory('chosen'));await test.json(test.pkg,{aiHarness:{extensions:['src/entry','src/entry.js','src/entry.ts']}});
    expect((await test.loader([test.pkg],[`-${entry}`]).loadAll()).loaded).toEqual([]);expect((await test.loader([test.pkg],[`-${entry}`,`+${entry.replace(/\.ts$/u,'.js')}`]).loadAll()).loaded).toEqual([entry]);
  });
  it('does not treat main as an automatic resource selector or recursively interpret a module directory manifest',async()=>{
    const test=await fixture();const index=await test.file(path.join(test.pkg,'index.mjs'),test.factory('ordinary','.mjs'));await test.file(path.join(test.pkg,'src/other.ts'),'throw new Error("Main is not an automatic resource selector");');await test.json(test.pkg,{main:'src/other.ts'});
    expect((await test.loader([test.pkg]).loadAll()).loaded).toEqual([index]);await test.json(test.pkg,{aiHarness:{extensions:['src']}});await test.json(path.join(test.pkg,'src'),{pi:{extensions:['other.ts']},exports:'./other.ts'});
    const result=await test.loader([test.pkg]).loadAll();expect(result.committed).toBe(false);expect(result.errors.map(item=>item.error.message)).toEqual([diagnostic]);
  });
  it('does not infer module siblings for missing automatic directories or import refused project source',async()=>{
    const test=await fixture();const home=path.join(test.root,'home');const marker=path.join(test.root,'marker');const body=`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');export default()=>{};`;
    await test.file(path.join(home,'.ai-harness/extensions.ts'),body);await test.file(path.join(test.cwd,'.ai-harness/extensions.ts'),body);const project=await test.file(path.join(test.cwd,'entry.ts'),body);
    const automatic=new ExtensionModuleLoader(test.registry,{cwd:test.cwd,homeDir:home,includeEnvironmentPaths:false});expect((await automatic.loadAll()).loaded).toEqual([]);expect((await test.loader([project.replace(/\.ts$/u,'.js')],[],false).loadAll()).loaded).toEqual([]);await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
  });
  for(const via of ['path','selector'] as const)for(const requested of ['entry','entry.ts'])it(`preserves trailing directory intent for ${via} ${requested}`,async()=>{
    const test=await fixture();await test.file(path.join(test.pkg,'entry.ts'),'throw new Error("A directory request must not evaluate a file");');const target=path.join(test.pkg,requested)+path.sep;
    const result=await test.loader(via==='path'?[target]:[],via==='selector'?['+'+target]:[]).loadAll();expect(result).toMatchObject({committed:true,loaded:[],errors:[]});
  });
  it.each(['../escape.ts','/outside.ts','C:/outside.ts','.','','bad\n.ts','x'.repeat(32_769),null,{},7])('refuses invalid main %# without index fallback and preserves the previous generation',async main=>{
    const test=await fixture();const directory=path.join(test.pkg,'nested');const entry=await test.file(path.join(directory,'entry.ts'),test.factory('retained'));await test.json(test.pkg,{aiHarness:{extensions:['nested']}});await test.json(directory,{main:'entry.ts'});
    const loader=test.loader([test.pkg]);expect((await loader.loadAll()).committed).toBe(true);const previous=test.registry.getCommand('retained');await test.file(path.join(directory,'index.mjs'),'throw new Error("Invalid main must not fall back");');await test.json(directory,{main});
    const result=await loader.reload();expect(result).toMatchObject({committed:false,generation:1,loaded:[entry]});expect(result.errors.map(item=>item.error.message)).toEqual([diagnostic]);expect(test.registry.getCommand('retained')).toBe(previous);
  });
  it.each(['symlink','hardlink','oversized','directory'])('refuses unsafe %s source fallback before importing any prefix',async kind=>{
    const test=await fixture();const entry=path.join(test.pkg,'entry.ts');const outside=await test.file(path.join(test.root,'outside.ts'),test.factory('never'));
    if(kind==='symlink')await symlink(outside,entry);else if(kind==='hardlink')await link(outside,entry);else if(kind==='directory')await mkdir(entry);else{await test.file(entry,'');await truncate(entry,5*1024*1024+1);}
    const result=await test.loader([entry.replace(/\.ts$/u,'.js')]).loadAll();expect(result.committed).toBe(false);expect(result.errors.map(item=>item.error.message)).toEqual([diagnostic]);expect(test.registry.getCommand('never')).toBeUndefined();
  });
  it.each(['syntax','symlink','hardlink'])('applies stable metadata admission to nested %s main manifests',async kind=>{
    const test=await fixture();const directory=path.join(test.pkg,'nested');await test.file(path.join(directory,'index.mjs'),'throw new Error("Unsafe main metadata must block fallback");');await test.json(test.pkg,{aiHarness:{extensions:['nested']}});const target=path.join(directory,'package.json');
    if(kind==='syntax')await test.file(target,'{ "private_source" :');else{const outside=await test.file(path.join(test.root,'metadata'),'{}');if(kind==='symlink')await symlink(outside,target);else await link(outside,target);}
    const result=await test.loader([test.pkg]).loadAll();expect(result.committed).toBe(false);expect(result.errors.map(item=>item.error.message)).toEqual([diagnostic]);
  });
  it.each([8,9])('bounds main indirections at eight (%i requested)',async depth=>{
    const test=await fixture();await test.json(test.pkg,{aiHarness:{extensions:['nested']}});let directory=path.join(test.pkg,'nested');for(let step=0;step<depth;step++){await test.json(directory,{main:step===depth-1?'entry.ts':'child'});if(step<depth-1)directory=path.join(directory,'child');}const entry=await test.file(path.join(directory,'entry.ts'),test.factory('deep'));
    const result=await test.loader([test.pkg]).loadAll();expect(result.committed).toBe(depth===8);if(depth===8)expect(result.loaded).toEqual([entry]);else expect(result.errors.map(item=>item.error.message)).toEqual([diagnostic]);
  });
  it('allows exactly 10,000 module candidate probes and refuses an incomplete next generation before import',async()=>{
    const test=await fixture();const directories:string[]=[];for(let group=0;group<10;group++){const directory=path.join(test.pkg,String(group));directories.push(directory);const names=Array.from({length:100},(_,index)=>'entry'+index);for(const name of names)await test.file(path.join(directory,name+'.tsx'),'throw new Error("Discovery must not evaluate entries");');await test.json(directory,{aiHarness:{extensions:names}});}
    const missing=(count:number)=>Array.from({length:count},(_,index)=>path.join(test.root,'missing-'+index));expect(await test.loader([...missing(125),...directories]).discover()).toHaveLength(1_000);
    const result=await test.loader([...missing(126),...directories]).loadAll();expect(result.committed).toBe(false);expect(result.errors.map(item=>item.error.message)).toEqual([diagnostic]);
  },25_000);
});
