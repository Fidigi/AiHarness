import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResourceManager } from './resource-manager.js';

const fields = ['skillPaths', 'globalSkillPaths', 'projectSkillPaths', 'promptPaths', 'globalPromptPaths', 'projectPromptPaths'] as const;
describe('home prefixes in legacy Markdown selector strings', () => {
  for (const field of fields) for (const refused of [false, true]) for (const projectHome of [false, true]) {
    it(`${field}/refused=${refused}/project-home=${projectHome}: home expansion never grants trust`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-home-selectors-'));
      try {
        const cwd = path.join(root, 'cwd'), home = path.join(projectHome ? cwd : root, 'home[literal]');
        const skill = field.toLowerCase().includes('skill');
        const relative = skill ? 'review/SKILL.md' : 'review.md';
        const target = path.join(home, 'kit', relative);
        await mkdir(path.dirname(target), { recursive: true }); await mkdir(cwd, { recursive: true });
        await writeFile(target, '---\nname: review\ndescription: Home fixture\n---\nHOME');
        const pattern = skill ? '**/SKILL.md' : '*.md';
        const manager = new ResourceManager({ cwd, homeDir: home, agentDir: path.join(root, 'agent'), projectTrusted: !refused,
          [field]: ['~/kit/' + pattern, '-~/kit', '+~/kit/' + relative, '!~/kit/' + pattern, '+~/kit/' + relative] });
        const admitted = !refused || (!projectHome && !field.startsWith('project'));
        expect(await manager.loadAll()).toEqual({ errors: [], skills: admitted && skill ? 1 : 0, prompts: admitted && !skill ? 1 : 0 });
        expect(manager.listInventory().map(item => item.provenance.path)).toEqual(admitted ? [target] : []);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
  it('supports the bare home directory, but does not expand usernames or an interior tilde', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-home-literal-'));
    try {
      const cwd = path.join(root, 'cwd'), home = path.join(root, 'home[literal]');
      for (const target of [path.join(home, 'review.md'), path.join(cwd, '~alice/user.md'), path.join(cwd, 'part/~/nested.md')]) {
        await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, 'BODY');
      }
      const manager = new ResourceManager({ cwd, homeDir: home, agentDir: path.join(root, 'agent'), projectTrusted: true,
        promptPaths: ['+~', '~alice/*.md', 'part/~/*.md'] });
      expect(await manager.loadAll()).toEqual({ skills: 0, prompts: 3, errors: [] });
      expect(manager.listPrompts().map(item => item.name)).toEqual(['nested', 'review', 'user']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
