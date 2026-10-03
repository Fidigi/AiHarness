import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { ResourceManager } from './resource-manager';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-resources-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ResourceManager', () => {
  it('discovers and parses Agent Skills from user and project directories', async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    await mkdir(path.join(home, '.agents', 'skills', 'review'), { recursive: true });
    await mkdir(path.join(cwd, '.agents', 'skills', 'deploy'), { recursive: true });
    await writeFile(path.join(home, '.agents', 'skills', 'review', 'SKILL.md'), [
      '---', 'name: review', 'description: Revoir le code', 'version: 1.2.0', '---', 'Inspecte chaque fichier.',
    ].join('\n'));
    await writeFile(path.join(cwd, '.agents', 'skills', 'deploy', 'SKILL.md'), [
      '---', 'description: Déployer', 'disable-model-invocation: true', '---', 'Déploie prudemment.',
    ].join('\n'));

    const manager = new ResourceManager({ cwd, homeDir: home, projectTrusted: true });
    const result = await manager.loadAll();

    expect(result).toMatchObject({ skills: 2, prompts: 0, errors: [] });
    expect(manager.getSkill('review')).toMatchObject({ version: '1.2.0', instructions: 'Inspecte chaque fichier.' });
    expect(manager.getSkill('deploy')?.disableModelInvocation).toBe(true);
    expect(manager.getModelInvocableSkills().map(skill => skill.name)).toEqual(['review']);
    expect(manager.invokeSkill('review', 'src/index.ts')).toContain('src/index.ts');
  });

  it('lets project skills override user skills with the same name', async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    for (const base of [home, cwd]) await mkdir(path.join(base, '.agents', 'skills', 'shared'), { recursive: true });
    await writeFile(path.join(home, '.agents', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\n---\nUtilisateur');
    await writeFile(path.join(cwd, '.agents', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\n---\nProjet');

    const manager = new ResourceManager({ cwd, homeDir: home, projectTrusted: true });
    await manager.loadAll();

    expect(manager.getSkill('shared')?.instructions).toBe('Projet');
  });

  it('discovers prompts and expands positional, all-argument, and default variables', async () => {
    const root = await temporaryDirectory();
    const prompts = path.join(root, '.ai-harness', 'prompts');
    await mkdir(prompts, { recursive: true });
    await writeFile(path.join(prompts, 'explain.md'), [
      '---', 'name: explain', 'description: Expliquer un sujet', '---',
      'Sujet=$1; niveau=${2:-simple}; tout=$@; défaut=${@:-aucun}',
    ].join('\n'));

    const manager = new ResourceManager({ cwd: root, homeDir: path.join(root, 'home'), projectTrusted: true });
    const result = await manager.loadAll();

    expect(result.prompts).toBe(1);
    expect(manager.expandPrompt('explain', ['TypeScript'])).toBe(
      'Sujet=TypeScript; niveau=simple; tout=TypeScript; défaut=TypeScript',
    );
    expect(manager.expandPrompt('explain', [])).toContain('défaut=aucun');
  });

  it('loads Pi agent resources while trust-gating project resource directories', async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    const agentDir = path.join(root, 'pi-agent');
    await mkdir(path.join(agentDir, 'skills', 'user'), { recursive: true });
    await mkdir(path.join(cwd, '.pi', 'skills', 'project'), { recursive: true });
    await writeFile(path.join(agentDir, 'skills', 'user', 'SKILL.md'), '---\nname: user\n---\nUser instructions');
    await writeFile(path.join(cwd, '.pi', 'skills', 'project', 'SKILL.md'), '---\nname: project\n---\nProject instructions');

    const untrusted = new ResourceManager({ cwd, homeDir: home, agentDir, projectTrusted: false });
    await untrusted.loadAll();
    expect(untrusted.listSkills().map(skill => skill.name)).toEqual(['user']);

    const trusted = new ResourceManager({ cwd, homeDir: home, agentDir, projectTrusted: true });
    await trusted.loadAll();
    expect(trusted.listSkills().map(skill => skill.name)).toEqual(['project', 'user']);
  });

  it('applies ordered Pi resource globs, exclusions, and project precedence', async () => {
    const root = await temporaryDirectory();
    const globalPrompts = path.join(root, 'configured-prompts');
    const globalSkills = path.join(root, 'global-skills');
    const projectSkills = path.join(root, 'project-skills');
    await mkdir(globalPrompts, { recursive: true });
    await mkdir(path.join(globalSkills, 'shared'), { recursive: true });
    await mkdir(path.join(projectSkills, 'shared'), { recursive: true });
    await writeFile(path.join(globalPrompts, 'public.md'), 'Public prompt');
    await writeFile(path.join(globalPrompts, 'private.md'), 'Private prompt');
    await writeFile(path.join(globalSkills, 'shared', 'SKILL.md'), 'Global skill');
    await writeFile(path.join(projectSkills, 'shared', 'SKILL.md'), 'Project skill');

    const manager = new ResourceManager({
      cwd: root,
      homeDir: path.join(root, 'home'),
      projectTrusted: true,
      globalPromptPaths: [path.join(globalPrompts, '*.md'), `!${path.join(globalPrompts, 'private.md')}`],
      globalSkillPaths: [globalSkills],
      projectSkillPaths: [projectSkills],
    });
    const result = await manager.loadAll();

    expect(result).toMatchObject({ prompts: 1, skills: 1, errors: [] });
    expect(manager.listPrompts().map(prompt => prompt.name)).toEqual(['public']);
    expect(manager.getSkill('shared')?.instructions).toBe('Project skill');
  });

  it('reports malformed or empty resources without blocking valid files', async () => {
    const root = await temporaryDirectory();
    const skills = path.join(root, '.agents', 'skills');
    await mkdir(path.join(skills, 'empty'), { recursive: true });
    await mkdir(path.join(skills, 'valid'), { recursive: true });
    await writeFile(path.join(skills, 'empty', 'SKILL.md'), '---\nname: empty\n---\n');
    await writeFile(path.join(skills, 'valid', 'SKILL.md'), 'Instructions valides');

    const manager = new ResourceManager({ cwd: root, homeDir: path.join(root, 'home'), projectTrusted: true });
    const result = await manager.loadAll();

    expect(result.skills).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});
