import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourceManager, type ResourceManagerOptions } from '../index.js';

const observation = vi.hoisted(() => ({ enabled: false, opened: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (observation.enabled && (await handle.stat()).isFile()) observation.opened.push(await actual.realpath(`/proc/self/fd/${handle.fd}`));
    return handle;
  } };
});
const roots: string[] = [];
afterEach(async () => { observation.enabled = false; observation.opened.length = 0; await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
type Kind = 'skill' | 'prompt';
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-resource-discovery-')); roots.push(root);
  const cwd = path.join(root, 'work[literal]'), agentDir = path.join(root, 'agent[literal]'), homeDir = path.join(root, 'home[literal]');
  await Promise.all([fs.mkdir(cwd), fs.mkdir(agentDir), fs.mkdir(homeDir)]);
  const options: ResourceManagerOptions = { cwd, agentDir, homeDir, projectTrusted: true, strictSkills: true };
  const paths = { skill: { global: [] as string[], project: [] as string[], explicit: [] as string[] }, prompt: { global: [] as string[], project: [] as string[], explicit: [] as string[] } };
  async function file(kind: Kind, base: string, name: string) {
    const target = path.join(base, kind === 'skill' ? `${name}/SKILL.md` : `${name}.md`);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, `---\nname: ${name}\ndescription: Discovery policy fixture\n---\nBODY ${name}`); return target;
  }
  for (const kind of ['skill', 'prompt'] as const) {
    const title = kind === 'skill' ? 'Skill' : 'Prompt', plural = kind === 'skill' ? 'skills' : 'prompts';
    paths[kind].global.push(await file(kind, path.join(agentDir, plural), 'user-auto'));
    if (kind === 'skill') paths[kind].global.push(await file(kind, path.join(homeDir, '.agents/skills'), 'home-auto'));
    paths[kind].project.push(await file(kind, path.join(cwd, '.ai-harness', plural), 'project-auto'));
    paths[kind].project.push(await file(kind, path.join(cwd, kind === 'skill' ? '.agents/skills' : 'prompts'), 'project-fallback'));
    for (const scope of ['global', 'project'] as const) {
      const packageFile = await file(kind, path.join(root, `${scope}-package[literal]`), `${scope}-package`);
      const legacyFile = await file(kind, path.join(root, `${scope}-legacy[literal]`), `${scope}-legacy`);
      const scopedFile = await file(kind, path.join(root, `${scope}-scoped[literal]`), `${scope}-scoped`);
      options[`${scope}Package${title}Paths`] = [packageFile];
      options[`${scope}${title}Paths`] = ['+' + legacyFile];
      options[`${scope}${title}Selectors`] = [{ pattern: kind === 'skill' ? '**/SKILL.md' : '*.md', baseDir: path.join(root, `${scope}-scoped[literal]`) }];
      paths[kind][scope === 'global' ? 'global' : 'project'].push(packageFile, legacyFile, scopedFile);
    }
    paths[kind].explicit.push(await file(kind, path.join(root, 'explicit'), 'explicit-user'));
    paths[kind].explicit.push(await file(kind, path.join(cwd, '..private'), 'explicit-project'));
    options[kind === 'skill' ? 'skillPaths' : 'promptPaths'] = paths[kind].explicit.map(value => '+' + value);
  }
  return { root, cwd, options, paths, file };
}
function observeBodyOpens() { observation.enabled = true; return observation.opened; }
function files(manager: ResourceManager, kind: Kind) { return (kind === 'skill' ? manager.listSkills() : manager.listPrompts()).map(value => value.filePath).sort(); }

describe('separate Markdown discovery and explicit loading policy', () => {
  for (const kind of ['skill', 'prompt'] as const) for (const discover of [false, true]) for (const trusted of [false, true]) {
    it(`${kind}/discover=${discover}/trusted=${trusted}: suppresses only automatic/settings/package candidates`, async () => {
      const test = await fixture(), opened = observeBodyOpens();
      const manager = new ResourceManager({ ...test.options, projectTrusted: trusted, discoverSkills: kind === 'skill' ? discover : false, discoverPrompts: kind === 'prompt' ? discover : false,
        disableSkills: kind !== 'skill', disablePrompts: kind !== 'prompt' });
      const expected = [...test.paths[kind].explicit.slice(0, trusted ? 2 : 1), ...(discover ? [...test.paths[kind].global, ...(trusted ? test.paths[kind].project : [])] : [])].sort();
      expect(await manager.loadAll()).toMatchObject({ errors: [] }); expect(files(manager, kind)).toEqual(expected); expect(opened.sort()).toEqual(expected);
      for (const item of manager.listInventory().filter(item => item.provenance.source === 'cli')) expect(item.provenance.trusted).toBe(true);
      opened.length = 0; expect(await manager.loadAll()).toMatchObject({ errors: [] }); expect(files(manager, kind)).toEqual(expected); expect(opened.sort()).toEqual(expected);
    });
  }
  for (const kind of ['skill', 'prompt'] as const) for (const discover of [false, true]) {
    it(`${kind}/discover=${discover}: preserves legacy all-loading disable authority`, async () => {
      const test = await fixture(), opened = observeBodyOpens();
      const manager = new ResourceManager({ ...test.options, discoverSkills: discover, discoverPrompts: discover, disableSkills: true, disablePrompts: true });
      expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 0, errors: [] }); expect(manager.listInventory()).toEqual([]); expect(opened).toEqual([]);
    });
  }
  for (const kind of ['skill', 'prompt'] as const) for (const scope of ['global', 'project'] as const) for (const suffix of ['Paths', 'Selectors', 'PackagePaths'] as const) {
    it(`${kind}/${scope}/${suffix}: never reads suppressed automatic source fields`, async () => {
      const test = await fixture(), title = kind === 'skill' ? 'Skill' : 'Prompt'; let calls = 0;
      const field = suffix === 'PackagePaths' ? `${scope}Package${title}Paths` : `${scope}${title}${suffix}`;
      const options: ResourceManagerOptions = { ...test.options, discoverSkills: false, discoverPrompts: false };
      Object.defineProperty(options, field, { get() { calls++; throw new Error('Suppressed field must remain unread'); } });
      const manager = new ResourceManager(options); expect(await manager.loadAll()).toEqual({ skills: 2, prompts: 2, errors: [] }); expect(calls).toBe(0);
    });
  }
  for (const kind of ['skill', 'prompt'] as const) {
    it(`${kind}: independently captures discovery choice without changing the other kind`, async () => {
      const test = await fixture(); const options: ResourceManagerOptions = { ...test.options, discoverSkills: kind !== 'skill', discoverPrompts: kind !== 'prompt' };
      const manager = new ResourceManager(options); options.discoverSkills = !options.discoverSkills; options.discoverPrompts = !options.discoverPrompts;
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      for (const current of ['skill', 'prompt'] as const) expect(files(manager, current)).toEqual([...test.paths[current].explicit, ...(current === kind ? [] : [...test.paths[current].global, ...test.paths[current].project])].sort());
    });
    it(`${kind}: retains ordered exact explicit exclusion/reinclusion with discovery suppressed`, async () => {
      const test = await fixture(), [first, second] = test.paths[kind].explicit;
      const manager = new ResourceManager({ ...test.options, discoverSkills: false, discoverPrompts: false, [kind === 'skill' ? 'skillPaths' : 'promptPaths']: ['+' + first, '+' + second, '-' + second, '-' + first, '+' + first] });
      expect(await manager.loadAll()).toMatchObject({ errors: [] }); expect(files(manager, kind)).toEqual([first]);
      expect(manager.listInventory().filter(item => item.kind === kind)).toEqual([expect.objectContaining({ provenance: expect.objectContaining({ source: 'cli', path: first }) })]);
    });
  }
});
