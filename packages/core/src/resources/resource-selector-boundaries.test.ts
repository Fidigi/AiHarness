import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ResourceManager, type ResourceManagerOptions } from '../index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const selectors = [
  ['promptPaths', 'prompt'], ['globalPromptPaths', 'prompt'], ['projectPromptPaths', 'prompt'],
  ['skillPaths', 'skill'], ['globalSkillPaths', 'skill'], ['projectSkillPaths', 'skill'],
] as const;
const ingress = [
  ['promptPaths', 'prompt'], ['globalPromptPaths', 'prompt'], ['globalPackagePromptPaths', 'prompt'],
  ['skillPaths', 'skill'], ['globalSkillPaths', 'skill'], ['globalPackageSkillPaths', 'skill'],
] as const;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-resource-boundary-')); roots.push(root);
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  const options: ResourceManagerOptions = { cwd, homeDir: path.join(root, 'home'), agentDir: path.join(root, 'agent'), strictSkills: true };
  const file = async (directory: string, kind: 'prompt' | 'skill', body: string) => {
    const target = path.join(directory, kind === 'skill' ? 'review/SKILL.md' : 'review.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `---\nname: review\ndescription: Boundary fixture\n---\n${body}`);
    return target;
  };
  return { root, cwd, options, file };
}
function contents(manager: ResourceManager, kind: 'prompt' | 'skill') {
  return kind === 'prompt' ? manager.listPrompts().map(value => value.content) : manager.listSkills().map(value => value.instructions);
}

describe('Markdown exact selectors and project-path boundaries', () => {
  for (const [field, kind] of selectors) {
    for (const directory of [false, true]) {
      it(`${field}: + keeps a metacharacter ${directory ? 'directory' : 'file'} literal`, async () => {
        const test = await fixture(); const parent = path.join(test.root, 'resources/[literal]');
        const exact = await test.file(parent, kind, 'EXACT');
        await test.file(path.join(test.root, 'resources/l'), kind, 'UNREQUESTED GLOB MATCH');
        const manager = new ResourceManager({ ...test.options, projectTrusted: true, [field]: ['+' + (directory ? parent : exact)] });
        expect(await manager.loadAll()).toMatchObject({ errors: [] });
        expect(contents(manager, kind)).toEqual(['EXACT']);
        expect(manager.listInventory()).toEqual([expect.objectContaining({ provenance: expect.objectContaining({ path: exact }) })]);
      });
    }
  }
  for (const [field, kind] of ingress) {
    it(`${field}: refuses a project child beginning with two dots before body admission`, async () => {
      const test = await fixture(); const target = await test.file(path.join(test.cwd, '..private'), kind, 'REFUSED PROJECT BODY');
      const manager = new ResourceManager({ ...test.options, projectTrusted: false, [field]: [target] });
      expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 0, errors: [] });
      expect(manager.listInventory()).toEqual([]);
    });
    it(`${field}: classifies an admitted two-dot child as project scope`, async () => {
      const test = await fixture(); const target = await test.file(path.join(test.cwd, '..private'), kind, 'TRUSTED PROJECT BODY');
      const manager = new ResourceManager({ ...test.options, projectTrusted: true, [field]: [target] });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(contents(manager, kind)).toEqual(['TRUSTED PROJECT BODY']);
      expect(manager.listInventory()).toEqual([expect.objectContaining({ provenance: expect.objectContaining({ path: target, scope: 'project', trusted: true }) })]);
    });
  }
  it('retains exclusion and exact reinclusion order for literal paths', async () => {
    const test = await fixture(); const parent = path.join(test.root, '[literal]');
    const exact = await test.file(parent, 'prompt', 'EXACT');
    const removed = new ResourceManager({ ...test.options, globalPromptPaths: ['+' + parent, '-' + parent] });
    expect(await removed.loadAll()).toEqual({ skills: 0, prompts: 0, errors: [] });
    const manager = new ResourceManager({ ...test.options, globalPromptPaths: ['+' + parent, '-' + parent, '+' + exact] });
    expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 1, errors: [] });
    expect(manager.getPrompt('review')?.content).toBe('EXACT');
    expect(manager.getPrompt('review')?.provenance.selector).toBe('+' + exact);
  });
  for (const kind of ['prompt', 'skill'] as const) {
    for (const exclusion of ['exact', 'glob', 'root'] as const) {
      it(`${kind}: ${exclusion} exclusion can remove admitted files without permission to scan its ancestor`, async () => {
        const test = await fixture(); const parent = path.join(test.root, '[literal]');
        const target = await test.file(parent, kind, 'EXCLUDED');
        const selector = exclusion === 'exact' ? '-' + parent
          : exclusion === 'glob' ? '!' + path.join(test.root, '**/*.md') : '-' + path.parse(test.root).root;
        const manager = new ResourceManager({ ...test.options, projectTrusted: false,
          [kind === 'prompt' ? 'globalPromptPaths' : 'globalSkillPaths']: ['+' + target, selector] });
        expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 0, errors: [] });
        expect(manager.listInventory()).toEqual([]);
      });
    }
  }
  it('does not block genuinely outside siblings with similar names', async () => {
    const test = await fixture(); const target = await test.file(path.join(test.root, 'project-sibling/..private'), 'prompt', 'OUTSIDE');
    const manager = new ResourceManager({ ...test.options, projectTrusted: false, promptPaths: [target] });
    expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 1, errors: [] });
    expect(manager.getPrompt('review')).toMatchObject({ content: 'OUTSIDE', provenance: { scope: 'temporary' } });
  });
  it('keeps an ancestor scan blocked even when its pattern names a private descendant', async () => {
    const test = await fixture(); await test.file(path.join(test.cwd, '..private'), 'prompt', 'REFUSED');
    const manager = new ResourceManager({ ...test.options, projectTrusted: false, promptPaths: [path.join(test.root, '**/*.md')] });
    expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 0, errors: [] });
  });
  it('requires an operator assertion for an agent root whose first project component begins with two dots', async () => {
    const test = await fixture(); const agentDir = path.join(test.cwd, '..agent');
    await test.file(path.join(agentDir, 'prompts'), 'prompt', 'OPERATOR');
    for (const trusted of [false, true]) {
      const manager = new ResourceManager({ ...test.options, agentDir, agentDirTrusted: trusted });
      expect(await manager.loadAll()).toEqual({ skills: 0, prompts: trusted ? 1 : 0, errors: [] });
      if (trusted) expect(manager.getPrompt('review')?.provenance.scope).toBe('user');
    }
  });
  it('refuses project paths when the project is the filesystem root', async () => {
    const test = await fixture(); const target = await test.file(test.root, 'prompt', 'REFUSED');
    const manager = new ResourceManager({ ...test.options, cwd: path.parse(test.root).root, projectTrusted: false, promptPaths: [target] });
    expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 0, errors: [] });
  });
});
