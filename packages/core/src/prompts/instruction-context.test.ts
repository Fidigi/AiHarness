import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  composeInstructionSystemPrompt,
  resolveInstructionPrompt,
  resolveAgentDirectory,
} from './instruction-context.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-instructions-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function text(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('instruction context', () => {
  it('loads the agent directory and parent chain in order with same-directory overrides', async () => {
    const root = await temporaryDirectory();
    const agentDir = path.join(root, 'agent');
    const workspace = path.join(root, 'workspace');
    const cwd = path.join(workspace, 'packages', 'feature');
    await text(path.join(agentDir, 'AGENTS.md'), 'global instructions');
    await text(path.join(root, 'AGENTS.md'), 'root instructions');
    await text(path.join(workspace, 'AGENTS.md'), 'shadowed instructions');
    await text(path.join(workspace, 'AGENTS.override.md'), 'workspace override');
    await text(path.join(cwd, 'CLAUDE.MD'), 'leaf instructions');

    const resolved = await resolveInstructionPrompt({ cwd, agentDir, projectTrusted: true });
    const localFiles = resolved.contextFiles.filter(file => file.path.startsWith(root));

    expect(localFiles.map(file => file.content)).toEqual([
      'global instructions',
      'root instructions',
      'workspace override',
      'leaf instructions',
    ]);
    expect(resolved.systemPrompt).toContain('global instructions');
    expect(resolved.systemPrompt).toContain('workspace override');
    expect(resolved.systemPrompt).not.toContain('shadowed instructions');
    expect(resolved.contextFiles[0]).toMatchObject({ scope: 'agent' });

    const deduplicated = await resolveInstructionPrompt({ cwd, agentDir: cwd, projectTrusted: true });
    expect(deduplicated.contextFiles.filter(file => file.path === path.join(cwd, 'CLAUDE.MD'))).toHaveLength(1);
  });

  it('gates project system files on trust and gives each project file precedence over its global peer', async () => {
    const root = await temporaryDirectory();
    const agentDir = path.join(root, 'agent');
    const cwd = path.join(root, 'workspace');
    await text(path.join(agentDir, 'SYSTEM.md'), 'global base');
    await text(path.join(agentDir, 'APPEND_SYSTEM.md'), 'global addendum');
    await text(path.join(agentDir, 'AGENTS.md'), 'global context');
    await text(path.join(cwd, 'AGENTS.md'), 'project context');
    await text(path.join(cwd, '.pi', 'SYSTEM.md'), 'project base');
    await text(path.join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'project addendum');

    const untrusted = await resolveInstructionPrompt({ cwd, agentDir, projectTrusted: false });
    expect(untrusted.systemPrompt).toContain('global base');
    expect(untrusted.systemPrompt).toContain('global context');
    expect(untrusted.systemPrompt).not.toContain('project context');
    expect(untrusted.systemPrompt).toContain('global addendum');
    expect(untrusted.systemPrompt).not.toContain('project base');
    expect(untrusted.systemPromptSource).toEqual({ kind: 'file', path: path.join(agentDir, 'SYSTEM.md') });

    const trusted = await resolveInstructionPrompt({ cwd, agentDir, projectTrusted: true });
    expect(trusted.systemPrompt).toContain('project base');
    expect(trusted.systemPrompt).toContain('project addendum');
    expect(trusted.systemPrompt).toContain('project context');
    expect(trusted.systemPrompt).not.toContain('global base');
    expect(trusted.appendSystemPromptSources).toEqual([
      { kind: 'file', path: path.join(cwd, '.pi', 'APPEND_SYSTEM.md') },
    ]);
  });

  it('resolves CLI prompt values as text or existing files and preserves repeat order', async () => {
    const root = await temporaryDirectory();
    const agentDir = path.join(root, 'agent');
    await text(path.join(root, 'base.md'), '\ufefffile base');
    await text(path.join(root, 'append.md'), 'file addendum');
    await text(path.join(agentDir, 'APPEND_SYSTEM.md'), 'discovered addendum');

    const resolved = await resolveInstructionPrompt({
      cwd: root,
      agentDir,
      noContextFiles: true,
      systemPromptInput: './base.md',
      appendSystemPromptInputs: ['first literal\nline', './append.md', 'last literal'],
    });

    expect(resolved.systemPromptSource).toEqual({ kind: 'file', path: path.join(root, 'base.md') });
    expect(resolved.appendSystemPromptSources).toEqual([
      { kind: 'literal' },
      { kind: 'file', path: path.join(root, 'append.md') },
      { kind: 'literal' },
    ]);
    expect(resolved.systemPrompt).toContain('file base');
    expect(resolved.systemPrompt.indexOf('first literal')).toBeLessThan(resolved.systemPrompt.indexOf('file addendum'));
    expect(resolved.systemPrompt.indexOf('file addendum')).toBeLessThan(resolved.systemPrompt.indexOf('last literal'));
    expect(resolved.systemPrompt).not.toContain('discovered addendum');

    const literalApiValue = await resolveInstructionPrompt({
      cwd: root, agentDir, noContextFiles: true, systemPromptText: './base.md',
    });
    expect(literalApiValue.systemPrompt).toContain('./base.md');
    expect(literalApiValue.systemPrompt).not.toContain('file base');
  });

  it('bounds inputs and ignores unsafe discovered files without reading their targets', async () => {
    const root = await temporaryDirectory();
    const agentDir = path.join(root, 'agent');
    const cwd = path.join(root, 'workspace');
    const outside = path.join(root, 'outside.md');
    await text(outside, 'do not load this target');
    await mkdir(path.join(agentDir, 'AGENTS.override.md'), { recursive: true });
    await text(path.join(agentDir, 'AGENTS.md'), 'safe user fallback');
    await mkdir(cwd, { recursive: true });
    await symlink(outside, path.join(cwd, 'AGENTS.override.md'));
    await text(path.join(cwd, 'AGENTS.md'), 'safe fallback');

    const resolved = await resolveInstructionPrompt({ cwd, agentDir, projectTrusted: true });
    expect(resolved.systemPrompt).toContain('safe user fallback');
    expect(resolved.systemPrompt).toContain('safe fallback');
    expect(resolved.systemPrompt).not.toContain('do not load this target');
    expect(resolved.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: path.join(agentDir, 'AGENTS.override.md'), message: expect.stringMatching(/regular file/i) }),
      expect.objectContaining({ path: path.join(cwd, 'AGENTS.override.md'), message: expect.stringMatching(/symbolic link/i) }),
    ]));

    const disabled = await resolveInstructionPrompt({ cwd, agentDir, noContextFiles: true });
    expect(disabled.contextFiles).toEqual([]);
    expect(disabled.systemPrompt).not.toContain('safe fallback');

    await expect(resolveInstructionPrompt({
      cwd, agentDir, noContextFiles: true, systemPromptText: 'oversized', maxFileBytes: 2,
    })).rejects.toThrow(/limit/i);
    await expect(resolveInstructionPrompt({
      cwd,
      agentDir,
      noContextFiles: true,
      systemPromptText: 'base',
      appendSystemPromptTexts: ['append'],
      maxTotalBytes: 8,
    })).rejects.toThrow(/total limit/i);
    await expect(resolveInstructionPrompt({ cwd, maxTotalBytes: 0 })).rejects.toThrow(/positive safe integer/i);
  });

  it('escapes source paths and resolves the conventional agent directory', () => {
    const home = path.join(path.sep, 'home', 'tester');
    expect(resolveAgentDirectory(undefined, home)).toBe(path.join(home, '.pi', 'agent'));
    expect(resolveAgentDirectory('~/custom-agent', home)).toBe(path.join(home, 'custom-agent'));
    expect(composeInstructionSystemPrompt({
      cwd: home,
      contextFiles: [{ path: '/tmp/a&"b.md', content: 'instructions' }],
    })).toContain('path="/tmp/a&amp;&quot;b.md"');
  });
});
