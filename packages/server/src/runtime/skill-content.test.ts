import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { ConfigurationStore } from '../config/config-store.js';
import { SkillCatalogService } from './skill-catalog.js';
import * as markdownReader from './skill-markdown.js';
const temporary: string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await Promise.all(temporary.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(scope='global') {
  const root=await mkdtemp(path.join(os.tmpdir(),'aih-skill-content-'));temporary.push(root);
  const project=path.join(root,'project'),data=path.join(root,'data'),configured=path.join(root,'configured'),pkg=path.join(root,'package');
  await mkdir(project,{recursive:true});
  const directory=path.join(scope==='project'?path.join(project,'.agents','skills'):scope==='path'?configured:scope==='package'?pkg:path.join(data,'skills'),'review');
  await mkdir(path.join(directory,'docs'),{recursive:true});
  const main=path.join(directory,'SKILL.md');
  const source='---\nname: review\ndescription: Reviewed data\ndisable-model-invocation: true\n---\nFull instructions. [Guide](docs/intro.md)\n';
  await writeFile(main,source);await writeFile(path.join(directory,'docs','intro.md'),'# Intro\n[Back](../SKILL.md)\n<script>NOT_EXECUTABLE</script>\n');
  vi.stubEnv('AI_HARNESS_SKILL_PATHS',scope==='path'?configured:'');
  const workspaces=new WorkspaceManager({allowedRoots:[root],defaultCwd:project});await workspaces.initialize();
  const trust=new ProjectTrustManager(path.join(data,'trust.json'));await trust.load();if(scope==='project')await trust.trust(project);
  const configuration=new ConfigurationStore(path.join(data,'config.json'));await configuration.load();let packageEnabled=true;
  const service=new SkillCatalogService(workspaces,trust,configuration,data,async()=>packageEnabled?[{directory:pkg,source:'owned package',displayRoot:'package',trusted:true}]:[]);
  const catalog=await service.getCatalog({cwd:project});const entry=catalog.skills.find(skill=>skill.scope===scope)!;
  expect(entry).toBeDefined();return {root,project,data,directory,main,source,trust,service,catalog,entry,disablePackage:()=>{packageEnabled=false;service.invalidate();}};
}
describe('explicit skill content without model activation or generic file authority',()=>{
  it.each(['global','project','path','package'])('reads complete %s instructions while leaving metadata and invocation flags unchanged',async scope=>{
    const f=await fixture(scope);expect(f.entry.modelInvocable).toBe(false);expect(JSON.stringify(f.catalog)).not.toContain('Full instructions.');
    const result=await f.service.getContent({key:f.entry.key,cwd:f.project,projectId:f.catalog.projectId});
    expect(result).toEqual({key:f.entry.key,relativePath:'SKILL.md',markdown:'Full instructions. [Guide](docs/intro.md)'});
    expect(await readFile(f.main,'utf8')).toBe(f.source);expect((await f.service.getCatalog({cwd:f.project})).skills.find(s=>s.key===f.entry.key)?.modelInvocable).toBe(false);
  });
  it('resolves nested Markdown from its declaring page and treats script-looking content as literal data',async()=>{
    const f=await fixture();const first=await f.service.getContent({key:f.entry.key,cwd:f.project,href:'docs/intro.md#intro'});
    expect(first).toMatchObject({relativePath:'docs/intro.md',fragment:'intro',markdown:expect.stringContaining('<script>NOT_EXECUTABLE</script>')});
    const back=await f.service.getContent({key:f.entry.key,cwd:f.project,href:'../SKILL.md',from:first.relativePath});expect(back.relativePath).toBe('SKILL.md');expect(back.markdown).toContain('Full instructions.');expect(back.markdown).not.toContain('disable-model-invocation');
  });
  it('rejects a cached project key immediately after trust revocation, without falling back to another source',async()=>{
    const f=await fixture('project');await f.trust.untrust(f.project);await expect(f.service.getContent({key:f.entry.key,cwd:f.project})).rejects.toMatchObject({code:'SKILL_CONTENT_UNAVAILABLE'});
  });
  it('rejects an old key after its package root is disabled',async()=>{
    const f=await fixture('package');f.disablePackage();await expect(f.service.getContent({key:f.entry.key,cwd:f.project})).rejects.toMatchObject({code:'SKILL_CONTENT_UNAVAILABLE'});
  });
  it('rechecks trust after the owned read and does not return the completed body after revocation',async()=>{
    const f=await fixture('project'),original=markdownReader.readSkillMarkdown;
    vi.spyOn(markdownReader,'readSkillMarkdown').mockImplementation(async file=>{const value=await original(file);if(file.endsWith('intro.md'))await f.trust.untrust(f.project);return value;});
    await expect(f.service.getContent({key:f.entry.key,cwd:f.project,href:'docs/intro.md'})).rejects.toMatchObject({code:'PROJECT_TRUST_REQUIRED'});
  });
  it('refuses an invalidated eligible-root generation after the read',async()=>{
    const f=await fixture(),original=markdownReader.readSkillMarkdown;
    vi.spyOn(markdownReader,'readSkillMarkdown').mockImplementation(async file=>{const value=await original(file);if(file.endsWith('intro.md'))f.service.invalidate();return value;});
    await expect(f.service.getContent({key:f.entry.key,cwd:f.project,href:'docs/intro.md'})).rejects.toMatchObject({code:'SKILL_CONTENT_CHANGED'});
  });
  it.each(['file','directory','hardlink'])('does not follow a %s alias into another root',async kind=>{
    const f=await fixture(),outside=path.join(f.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'secret.md'),'OUTSIDE_SECRET');
    if(kind==='directory')await symlink(outside,path.join(f.directory,'alias'));
    else if(kind==='file')await symlink(path.join(outside,'secret.md'),path.join(f.directory,'alias.md'));
    else await link(path.join(outside,'secret.md'),path.join(f.directory,'alias.md'));
    await expect(f.service.getContent({key:f.entry.key,cwd:f.project,href:kind==='directory'?'alias/secret.md':'alias.md'})).rejects.toMatchObject({code:'SKILL_CONTENT_UNAVAILABLE',message:'Skill content is unavailable.'});
  });
  it('refuses oversized references rather than truncating or returning another document',async()=>{
    const f=await fixture();await writeFile(path.join(f.directory,'large.md'),'x'.repeat(1024*1024+1));
    await expect(f.service.getContent({key:f.entry.key,cwd:f.project,href:'large.md'})).rejects.toMatchObject({code:'SKILL_CONTENT_UNAVAILABLE'});
  });
  it('does not let a cached key survive a renamed skill identity',async()=>{
    const f=await fixture();await writeFile(f.main,f.source.replace('name: review','name: replacement'));
    await expect(f.service.getContent({key:f.entry.key,cwd:f.project})).rejects.toMatchObject({code:'SKILL_CONTENT_UNAVAILABLE'});
  });
  it('rejects workspace/key substitution before returning content',async()=>{
    const f=await fixture();await expect(f.service.getContent({key:f.entry.key,cwd:f.project,projectId:'other'})).rejects.toMatchObject({code:'WORKSPACE_MISMATCH'});
    await expect(f.service.getContent({key:'__proto__',cwd:f.project})).rejects.toMatchObject({code:'SKILL_CONTENT_UNAVAILABLE'});
  });
});
