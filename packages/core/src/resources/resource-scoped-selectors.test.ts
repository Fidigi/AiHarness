import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentSettings, resolveAgentResourcePaths, resolveAgentResourceSelectors, ResourceManager,
  type ResourceFileSelector, type ResourceManagerOptions } from '../index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-scoped-resources-')); roots.push(root);
  const cwd = path.join(root, 'work[literal]'), agentDir = path.join(root, 'agent[literal]'), homeDir = path.join(root, 'home[literal]');
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(homeDir)]);
  const options = { cwd, agentDir, homeDir, projectTrusted: true, strictSkills: true } satisfies ResourceManagerOptions;
  const file = async (target: string, body = 'EXACT') => {
    await mkdir(path.dirname(target), { recursive: true });
    const name = path.basename(target) === 'SKILL.md' ? path.basename(path.dirname(target)) : path.basename(target, '.md');
    await writeFile(target, `---\nname: ${name}\ndescription: Scoped fixture\n---\n${body}`); return target;
  };
  return { root, cwd, agentDir, homeDir, options, file };
}

describe('literal Markdown declaring directories', () => {
  for (const field of ['globalSkillSelectors', 'projectSkillSelectors', 'globalPromptSelectors', 'projectPromptSelectors'] as const) {
    for (const [literal, bait] of [['sources[literal]', 'sourcesl'], ['sources?literal', 'sourcesXliteral'], ['sources*literal', 'sourcesBAITliteral'], ['sources{a,b}', 'sourcesa']]) {
    it(`${field}/${literal}: keeps a frozen declaring directory literal while expanding its pattern`, async () => {
      const test = await fixture(); const skill = field.includes('Skill');
      const relative = skill ? 'review/SKILL.md' : 'review.md';
      const baseDir = path.join(test.root, literal); const exact = await test.file(path.join(baseDir, relative));
      await test.file(path.join(test.root, bait, relative), 'BAIT');
      const selectors: readonly ResourceFileSelector[] = Object.freeze([Object.freeze({ baseDir, pattern: skill ? '**/SKILL.md' : '*.md' })]);
      const manager = new ResourceManager({ ...test.options, [field]: selectors });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(manager.listInventory()).toEqual([expect.objectContaining({ provenance: expect.objectContaining({ path: exact, source: 'settings', scope: field.startsWith('project') ? 'project' : 'user' }) })]);
      expect(skill ? manager.getSkill('review')?.instructions : manager.getPrompt('review')?.content).toBe('EXACT');
    });
    }
  }
  it.each(['skills', 'prompts'] as const)('preserves global/project/home %s settings and keeps the legacy string helper unchanged', async field => {
    const test = await fixture(); const skill = field === 'skills';
    const relative = skill ? 'review/SKILL.md' : 'review.md';
    const pattern = skill ? 'configured/**/SKILL.md' : 'configured/*.md';
    const global = await test.file(path.join(test.agentDir, 'configured', relative), 'GLOBAL');
    await test.file(path.join(test.root, 'agentl/configured', relative), 'GLOBAL BAIT');
    const project = await test.file(path.join(test.cwd, '.ai-harness/configured', relative), 'PROJECT');
    const home = await test.file(path.join(test.homeDir, 'configured', relative), 'HOME');
    await writeFile(path.join(test.agentDir, 'settings.json'), JSON.stringify({ [field]: [pattern, '!configured/**/skip.md'] }));
    await mkdir(path.join(test.cwd, '.ai-harness'), { recursive: true });
    await writeFile(path.join(test.cwd, '.ai-harness/settings.json'), JSON.stringify({ [field]: [pattern] }));
    const settings = await loadAgentSettings({ ...test.options });
    expect(resolveAgentResourcePaths(settings, field, test.homeDir, 'global')).toEqual([
      path.join(test.agentDir, pattern), '!' + path.join(test.agentDir, 'configured/**/skip.md'),
    ]);
    const globalSelectors = resolveAgentResourceSelectors(settings, field, test.homeDir, 'global');
    const projectSelectors = resolveAgentResourceSelectors(settings, field, test.homeDir, 'project');
    expect(globalSelectors[0]).toEqual({ pattern, baseDir: test.agentDir });
    expect(projectSelectors[0]).toEqual({ pattern, baseDir: path.join(test.cwd, '.ai-harness') });
    const manager = new ResourceManager({ ...test.options,
      [skill ? 'globalSkillSelectors' : 'globalPromptSelectors']: globalSelectors,
      [skill ? 'projectSkillSelectors' : 'projectPromptSelectors']: projectSelectors });
    expect(await manager.loadAll()).toMatchObject({ errors: [] });
    expect(manager.listInventory().map(value => value.provenance.path).sort()).toEqual([global, project].sort());
    expect(manager.listInventory().find(value => value.active)?.provenance.path).toBe(project);
    settings.globalSettings[field] = ['~/configured/' + (skill ? '**/SKILL.md' : '*.md')];
    const homeManager = new ResourceManager({ ...test.options, [skill ? 'globalSkillSelectors' : 'globalPromptSelectors']: resolveAgentResourceSelectors(settings, field, test.homeDir, 'global') });
    expect(await homeManager.loadAll()).toMatchObject({ errors: [] });
    expect(homeManager.listInventory().map(value => value.provenance.path)).toEqual([home]);
  });
  it.each(['skill', 'prompt'] as const)('keeps automatic %s roots literal under agent/home/project directories', async kind => {
    const test = await fixture(); const skill = kind === 'skill';
    const user = await test.file(path.join(test.agentDir, skill ? 'skills/user/SKILL.md' : 'prompts/user.md'));
    const project = await test.file(path.join(test.cwd, skill ? '.ai-harness/skills/project/SKILL.md' : '.ai-harness/prompts/project.md'));
    const home = skill ? await test.file(path.join(test.homeDir, '.agents/skills/home/SKILL.md')) : undefined;
    if (home) await test.file(home.replace('home[literal]', 'homel'), 'BAIT');
    await test.file(user.replace('agent[literal]', 'agentl'), 'BAIT');
    await test.file(project.replace('work[literal]', 'workl'), 'BAIT');
    const manager = new ResourceManager(test.options);
    expect(await manager.loadAll()).toMatchObject({ errors: [] });
    expect(manager.listInventory().map(value => value.provenance.path).sort()).toEqual([user, project, ...(home ? [home] : [])].sort());
    const refused = new ResourceManager({ ...test.options, projectTrusted: false });
    expect(await refused.loadAll()).toMatchObject({ errors: [] });
    expect(refused.listInventory().map(value => value.provenance.path).sort()).toEqual([user, ...(home ? [home] : [])].sort());
  });
  it.each(['skill', 'prompt'] as const)('keeps relative explicit %s selectors anchored to literal cwd', async kind => {
    const test = await fixture(); const skill = kind === 'skill'; const relative = skill ? 'ad-hoc/review/SKILL.md' : 'ad-hoc/review.md';
    const exact = await test.file(path.join(test.cwd, relative)); await test.file(path.join(test.root, 'workl', relative), 'BAIT');
    const manager = new ResourceManager({ ...test.options, [skill ? 'skillPaths' : 'promptPaths']: [skill ? 'ad-hoc/**/SKILL.md' : 'ad-hoc/*.md'] });
    expect(await manager.loadAll()).toMatchObject({ errors: [] });
    expect(manager.listInventory().map(value => value.provenance.path)).toEqual([exact]);
  });
  for (const kind of ['skill', 'prompt'] as const) for (const scope of ['global', 'project'] as const) {
    it(`${scope} package ${kind} paths are literal and not new glob selectors`, async () => {
      const test = await fixture(); const relative = kind === 'skill' ? 'review/SKILL.md' : 'review.md';
      const exact = await test.file(path.join(test.root, 'package[literal]', relative));
      await test.file(path.join(test.root, 'packagel', relative), 'BAIT');
      const field = `${scope}Package${kind === 'skill' ? 'Skill' : 'Prompt'}Paths`;
      const manager = new ResourceManager({ ...test.options, [field]: [exact] });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(manager.listInventory()).toEqual([expect.objectContaining({ provenance: expect.objectContaining({ path: exact, source: 'package' }) })]);
    });
  }
  it('preserves scoped exclusion/removal/reinclusion and legacy-before-scoped layer order', async () => {
    const test = await fixture(); const baseDir = path.join(test.root, 'configured[literal]');
    const exact = await test.file(path.join(baseDir, 'review.md'));
    await test.file(path.join(baseDir, 'removed.md'));
    await test.file(path.join(test.root, 'configuredl/review.md'), 'BAIT');
    const manager = new ResourceManager({ ...test.options, globalPromptPaths: ['+' + exact], globalPromptSelectors: [
      { baseDir, pattern: '*.md' }, { baseDir, pattern: '!*.md' }, { baseDir, pattern: '+review.md' },
    ] });
    expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 1, errors: [] });
    expect(manager.listInventory().map(value => value.provenance.path)).toEqual([exact]);
  });
  it('snapshots scoped selectors at construction without invoking selector-field getters', async () => {
    const test = await fixture(); const exact = await test.file(path.join(test.root, 'one/review.md'));
    const selector = { pattern: '*.md', baseDir: path.dirname(exact) };
    const manager = new ResourceManager({ ...test.options, globalPromptSelectors: [selector] });
    selector.baseDir = test.cwd;
    expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 1, errors: [] });
    expect(manager.listInventory()[0].provenance.path).toBe(exact);
    let calls = 0;
    expect(() => new ResourceManager({ ...test.options, globalPromptSelectors: [{ baseDir: test.root, get pattern() { calls++; return '*.md'; } }] })).toThrow('Resource selectors are invalid or exceed their limits.');
    expect(calls).toBe(0);
    const accessorArray: ResourceFileSelector[] = [];
    Object.defineProperty(accessorArray, '0', { get() { calls++; return selector; } });
    expect(() => new ResourceManager({ ...test.options, globalPromptSelectors: accessorArray })).toThrow('Resource selectors are invalid or exceed their limits.');
    expect(() => new ResourceManager({ ...test.options, globalPromptSelectors: new Array<ResourceFileSelector>(1) })).toThrow('Resource selectors are invalid or exceed their limits.');
    expect(calls).toBe(0);
    expect(() => new ResourceManager({ ...test.options, projectTrusted: false, get projectPromptSelectors(): readonly ResourceFileSelector[] { calls++; throw new Error('Refused field read'); } })).not.toThrow();
    expect(calls).toBe(0);
  });
  it('bounds scoped requests and pattern/base bytes without silently dropping a suffix', async () => {
    const test = await fixture(); const selectors = Array.from({ length: 512 }, () => ({ pattern: '-missing', baseDir: test.root }));
    expect(await new ResourceManager({ ...test.options, globalPromptSelectors: selectors }).loadAll()).toMatchObject({ errors: [] });
    for (const extra of [[...selectors, selectors[0]], [{ baseDir: 'relative', pattern: '*.md' }], [{ baseDir: test.root, pattern: 'x'.repeat(32_769) }]]) {
      expect(() => new ResourceManager({ ...test.options, globalPromptSelectors: extra })).toThrow('Resource selectors are invalid or exceed their limits.');
    }
    expect(() => new ResourceManager({ ...test.options, globalPromptPaths: ['-missing'], globalPromptSelectors: selectors })).toThrow('Resource selectors are invalid or exceed their limits.');
  });
  it('does not turn explicit file/directory intent into a different request', async () => {
    const test = await fixture(); const exact = await test.file(path.join(test.root, 'review.md'));
    const manager = new ResourceManager({ ...test.options, globalPromptSelectors: [{ baseDir: test.root, pattern: '+review.md/' }] });
    expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 0, errors: [] });
    const direct = new ResourceManager({ ...test.options, globalPromptSelectors: [{ baseDir: test.root, pattern: '+' + exact }] });
    expect(await direct.loadAll()).toEqual({ skills: 0, prompts: 1, errors: [] });
  });
});
