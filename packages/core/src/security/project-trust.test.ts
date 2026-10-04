import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectProjectTrustResources,
  ProjectTrustManager,
  resolveProjectTrust,
} from './project-trust.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-core-trust-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ProjectTrustManager', () => {
  it('migrates allow-lists and resolves the nearest fresh allow/refusal across processes', async () => {
    const root = await temporaryDirectory();
    const parent = path.join(root, 'projects');
    const project = path.join(parent, 'child');
    const trustFile = path.join(root, 'agent', 'trust.json');
    await mkdir(path.join(project, '.ai-harness'), { recursive: true });
    await writeFile(path.join(project, '.ai-harness', 'settings.json'), '{}');
    await mkdir(path.dirname(trustFile), { recursive: true });
    await writeFile(trustFile, JSON.stringify({ version: 1, trustedProjects: [parent] }));

    const first = new ProjectTrustManager(trustFile);
    const second = new ProjectTrustManager(trustFile);
    await Promise.all([first.load(), second.load()]);
    await expect(first.getStatus(project)).resolves.toMatchObject({
      trusted: true,
      decision: true,
      decisionPath: parent,
      inherited: true,
      requiresTrust: true,
    });

    await first.refuse(project);
    await expect(second.getStatus(project)).resolves.toMatchObject({
      trusted: false,
      decision: false,
      decisionPath: project,
      inherited: false,
    });

    await first.forget(project);
    await expect(second.getStatus(project)).resolves.toMatchObject({
      trusted: true,
      decision: true,
      decisionPath: parent,
      inherited: true,
    });
    expect(JSON.parse(await readFile(trustFile, 'utf8'))).toMatchObject({
      version: 2,
      decisions: { [parent]: true },
    });
    expect((await stat(trustFile)).mode & 0o777).toBe(0o600);
  });

  it('detects only present project resources, reports unsafe links, and fails closed on an unsafe store', async () => {
    const root = await temporaryDirectory();
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside.json');
    const outsideDirectory = path.join(root, 'outside-directory');
    const trustFile = path.join(root, 'agent', 'trust.json');
    await mkdir(project);

    await expect(inspectProjectTrustResources(project, { homeDir: root })).resolves.toMatchObject({
      cwd: project,
      requiresTrust: false,
      resources: [],
    });
    const manager = new ProjectTrustManager(trustFile);
    await manager.load();
    await expect(manager.isTrusted(project)).resolves.toBe(false);
    await expect(manager.getStatus(project)).resolves.toMatchObject({
      trusted: true,
      requiresTrust: false,
      decision: null,
      resources: [],
    });
    await expect(resolveProjectTrust({ cwd: project, trustManager: manager })).resolves.toMatchObject({
      trusted: true,
      resourceTrusted: false,
      source: 'not-required',
    });

    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, path.join(project, '.ai-harness'));
    await expect(inspectProjectTrustResources(project, { homeDir: root })).resolves.toMatchObject({
      requiresTrust: true,
      resources: [expect.objectContaining({
        relativePath: '.ai-harness',
        symbolicLink: true,
        safeKind: false,
      })],
    });

    await rm(path.join(project, '.ai-harness'));
    await mkdir(path.join(project, '.ai-harness'));
    await writeFile(outside, '{}');
    await symlink(outside, path.join(project, '.ai-harness', 'settings.json'));
    const inspection = await inspectProjectTrustResources(project, { homeDir: root });
    expect(inspection).toMatchObject({ requiresTrust: true });
    expect(inspection.resources).toContainEqual(expect.objectContaining({
      relativePath: path.join('.ai-harness', 'settings.json'),
      symbolicLink: true,
      safeKind: false,
    }));
    await expect(manager.isTrusted(project)).resolves.toBe(false);

    await mkdir(path.dirname(trustFile), { recursive: true });
    await rm(trustFile, { force: true });
    await symlink(outside, trustFile);
    await expect(manager.getStatus(project)).resolves.toMatchObject({
      trusted: false,
      decision: null,
      decisionError: expect.stringMatching(/regular file|symbolic link/i),
    });
    await rm(path.join(project, '.ai-harness'), { recursive: true });
    await expect(resolveProjectTrust({ cwd: project, trustManager: manager })).resolves.toMatchObject({
      trusted: false,
      resourceTrusted: false,
      source: 'fallback',
      decisionError: expect.any(String),
    });
  });

  it('fails closed for malformed or oversized stores and rejects invalid mutation batches', async () => {
    const root = await temporaryDirectory();
    const project = path.join(root, 'project');
    const trustFile = path.join(root, 'agent', 'trust.json');
    await mkdir(project);
    await mkdir(path.dirname(trustFile), { recursive: true });
    const manager = new ProjectTrustManager(trustFile);
    await manager.load();

    await expect(manager.setMany([{
      path: project,
      decision: 'allow' as unknown as boolean,
    }])).rejects.toThrow('Trust decisions must be true, false, or null.');
    await expect(manager.setMany(Array.from({ length: 10_001 }, () => ({
      path: project,
      decision: true,
    })))).rejects.toThrow('Too many trust decisions in one update.');

    await writeFile(trustFile, JSON.stringify({ version: 2, decisions: { [project]: 'yes' } }));
    await expect(manager.getStatus(project, { includeContextFiles: false })).resolves.toMatchObject({
      trusted: false,
      decisionError: expect.stringMatching(/boolean/i),
    });

    await writeFile(trustFile, ' '.repeat((256 * 1024) + 1));
    await expect(manager.getStatus(project, { includeContextFiles: false })).resolves.toMatchObject({
      trusted: false,
      decisionError: expect.stringMatching(/byte limit/i),
    });
  });

  it('merges concurrent decisions from independent manager instances', async () => {
    const root = await temporaryDirectory();
    const trustFile = path.join(root, 'agent', 'trust.json');
    const first = new ProjectTrustManager(trustFile);
    const second = new ProjectTrustManager(trustFile);
    await Promise.all([first.load(), second.load()]);

    const allowed = path.join(root, 'allowed');
    const refused = path.join(root, 'refused');
    await Promise.all([first.trust(allowed), second.refuse(refused)]);

    const reloaded = new ProjectTrustManager(trustFile);
    await reloaded.load();
    expect(reloaded.listDecisions()).toEqual(expect.arrayContaining([
      { path: allowed, decision: true },
      { path: refused, decision: false },
    ]));
  });

  it('detects ancestor context and project skill/prompt roots without reading their content', async () => {
    const root = await temporaryDirectory();
    const project = path.join(root, 'repository', 'nested');
    await mkdir(path.join(project, '.agents', 'skills'), { recursive: true });
    await mkdir(path.join(project, 'prompts'));
    await writeFile(path.join(root, 'repository', 'AGENTS.md'), 'do not read me during trust inventory');

    const inspection = await inspectProjectTrustResources(project, { homeDir: root });
    expect(inspection.resources.map(resource => resource.source)).toEqual(expect.arrayContaining([
      'context', 'project-skill', 'project-prompt',
    ]));
    expect(inspection.resources.find(resource => resource.source === 'context')).toMatchObject({
      path: path.join(root, 'repository', 'AGENTS.md'),
      safeKind: true,
    });
    const withoutContext = await inspectProjectTrustResources(project, {
      homeDir: root,
      includeContextFiles: false,
    });
    expect(withoutContext.resources.some(resource => resource.source === 'context')).toBe(false);
  });

  it('applies override, saved decision, global fallback, and remembered prompt precedence', async () => {
    const root = await temporaryDirectory();
    const parent = path.join(root, 'projects');
    const project = path.join(parent, 'child');
    const trustFile = path.join(root, 'agent', 'trust.json');
    await mkdir(path.join(project, '.ai-harness'), { recursive: true });
    await writeFile(path.join(project, '.ai-harness', 'SYSTEM.md'), 'project prompt');
    const manager = new ProjectTrustManager(trustFile);
    await manager.load();

    await expect(resolveProjectTrust({
      cwd: project,
      trustManager: manager,
      defaultProjectTrust: 'never',
    })).resolves.toMatchObject({ trusted: false, source: 'default' });
    await expect(resolveProjectTrust({
      cwd: project,
      trustManager: manager,
      defaultProjectTrust: 'always',
    })).resolves.toMatchObject({ trusted: true, source: 'default' });
    await expect(resolveProjectTrust({
      cwd: project,
      trustManager: manager,
      override: false,
      defaultProjectTrust: 'always',
    })).resolves.toMatchObject({ trusted: false, source: 'override' });

    const prompt = vi.fn().mockResolvedValue('trust-parent');
    await expect(resolveProjectTrust({ cwd: project, trustManager: manager, prompt })).resolves.toMatchObject({
      trusted: true,
      source: 'prompt',
      decisionPath: parent,
      inherited: true,
    });
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      status: expect.objectContaining({ cwd: project, requiresTrust: true }),
      parentPath: parent,
    }));

    await manager.refuse(project);
    await expect(resolveProjectTrust({
      cwd: project,
      trustManager: manager,
      override: undefined,
      defaultProjectTrust: 'always',
    })).resolves.toMatchObject({ trusted: false, source: 'saved', decision: false });
  });
});
