import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadPiSettings,
  resolvePiCompactionSettings,
  resolvePiDefaultTools,
  resolvePiResourcePaths,
  resolvePiSettingsPath,
  resolvePiThinkingLevel,
  selectPiResourcePaths,
} from './pi-settings.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ root: string; cwd: string; agentDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-pi-settings-'));
  temporaryDirectories.push(root);
  const cwd = path.join(root, 'project');
  const agentDir = path.join(root, 'agent');
  await Promise.all([
    mkdir(path.join(cwd, '.pi'), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
  ]);
  return { root, cwd, agentDir };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('Pi settings resolution', () => {
  it('deep-merges trusted layers, combines resources/modifiers, and reports provenance', async () => {
    const { cwd, agentDir } = await fixture();
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'mock',
      defaultModel: 'mock-model',
      theme: 'dark',
      compaction: { enabled: true, reserveTokens: 100 },
      extensions: ['./global.mjs'],
      defaultTools: ['read', 'bash'],
      cacheWarming: 'idle',
      defaultProjectTrust: 'always',
      httpProxy: 'http://127.0.0.1:3128',
    }));
    await writeFile(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({
      theme: 'light',
      compaction: { keepRecentTokens: 50 },
      extensions: ['./project.mjs'],
      defaultTools: ['-bash', '+grep'],
      cacheWarming: 'off',
      defaultProjectTrust: 'never',
      httpProxy: 'http://project.invalid',
    }));

    const result = await loadPiSettings({ cwd, agentDir, projectTrusted: true });

    expect(result.settings).toMatchObject({
      defaultProvider: 'mock',
      defaultModel: 'mock-model',
      theme: 'light',
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 50 },
      extensions: ['./global.mjs', './project.mjs'],
      defaultTools: ['read', 'bash', '-bash', '+grep'],
      cacheWarming: 'idle',
      defaultProjectTrust: 'always',
      httpProxy: 'http://127.0.0.1:3128',
    });
    expect(resolvePiDefaultTools(result.settings.defaultTools, ['read', 'bash', 'edit', 'write']))
      .toEqual(['read', 'grep']);
    expect(result.diagnostics.map(diagnostic => diagnostic.setting)).toEqual(expect.arrayContaining([
      'cacheWarming', 'defaultProjectTrust', 'httpProxy',
    ]));
    expect(result.provenance.theme).toEqual({ scopes: ['project'], paths: [result.paths.project] });
    expect(result.provenance['compaction.reserveTokens']).toEqual({
      scopes: ['global'], paths: [result.paths.global],
    });
    expect(result.provenance['compaction.keepRecentTokens']).toEqual({
      scopes: ['project'], paths: [result.paths.project],
    });
    expect(result.provenance.extensions?.scopes).toEqual(['global', 'project']);
    expect(result.provenance.defaultTools?.scopes).toEqual(['global', 'project']);
  });

  it('reads only project sessionDir before trust and never exposes other project settings', async () => {
    const { cwd, agentDir } = await fixture();
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ theme: 'dark', sessionDir: 'global-sessions' }));
    await writeFile(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({
      theme: 'light',
      sessionDir: 'project-sessions',
      extensions: ['./untrusted.mjs'],
    }));

    const untrusted = await loadPiSettings({ cwd, agentDir, projectTrusted: false });
    expect(untrusted.projectSettings).toEqual({ sessionDir: 'project-sessions' });
    expect(untrusted.settings).toMatchObject({ theme: 'dark', sessionDir: 'project-sessions' });
    expect(untrusted.settings.extensions).toBeUndefined();
    expect(resolvePiResourcePaths(untrusted, 'extensions')).toEqual([]);

    const strict = await loadPiSettings({
      cwd, agentDir, projectTrusted: false, includeUntrustedProjectSessionDir: false,
    });
    expect(strict.settings.sessionDir).toBe('global-sessions');
  });

  it('migrates legacy keys and ignores invalid or unknown fields without dropping valid settings', async () => {
    const { cwd, agentDir } = await fixture();
    await writeFile(path.join(agentDir, 'settings.json'), `\uFEFF${JSON.stringify({
      queueMode: 'all',
      websockets: true,
      skills: { enableSkillCommands: false, customDirectories: ['./legacy-skills'] },
      retry: { maxRetries: 999, maxDelayMs: 1234, provider: { timeoutMs: 500 } },
      theme: 'dark',
      mysterySetting: true,
    })}`);

    const result = await loadPiSettings({ cwd, agentDir, projectTrusted: true });

    expect(result.settings).toMatchObject({
      steeringMode: 'all',
      transport: 'websocket',
      skills: ['./legacy-skills'],
      enableSkillCommands: false,
      retry: { provider: { timeoutMs: 500, maxRetryDelayMs: 1234 } },
      theme: 'dark',
    });
    expect(result.settings.retry?.maxRetries).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ setting: 'retry.maxRetries' }),
      expect.objectContaining({ setting: 'mysterySetting' }),
    ]));
    expect(result.diagnostics.map(item => item.message).join('\n')).not.toContain('999');
  });

  it('rejects malformed, linked, non-object, and oversized settings sources safely', async () => {
    const { root, cwd, agentDir } = await fixture();
    const target = path.join(root, 'target.json');
    await writeFile(target, JSON.stringify({ theme: 'light' }));
    await symlink(target, path.join(agentDir, 'settings.json'));
    await writeFile(path.join(cwd, '.pi', 'settings.json'), '[');

    const unsafe = await loadPiSettings({ cwd, agentDir, projectTrusted: true });
    expect(unsafe.settings).toEqual({});
    expect(unsafe.diagnostics.map(item => item.message)).toEqual(expect.arrayContaining([
      'Settings source must be a regular file and cannot be a symbolic link.',
      'Settings source is not valid JSON.',
    ]));

    await rm(path.join(agentDir, 'settings.json'));
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ theme: 'x'.repeat(100) }));
    const bounded = await loadPiSettings({ cwd, agentDir, projectTrusted: false, maxFileBytes: 32 });
    expect(bounded.diagnostics[0]?.message).toBe('Settings source exceeds the 32 byte limit.');
  });

  it('resolves model-aware defaults and layer-relative resource/session paths', async () => {
    const { root, cwd, agentDir } = await fixture();
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
      defaultThinkingLevel: 'low',
      modelThinkingLevels: { 'mock/mock-model-v1': 'high' },
      compaction: {
        enabled: false,
        reserveTokens: 100,
        keepRecentTokens: 200,
        modelOverrides: { 'mock/mock-model-v1': { reserveTokens: 5 } },
      },
      prompts: ['./prompts/*.md', '!./prompts/private.md'],
    }));
    await writeFile(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ prompts: ['+./team.md'] }));
    const result = await loadPiSettings({ cwd, agentDir, projectTrusted: true, homeDir: root });

    expect(resolvePiThinkingLevel(result.settings, 'mock', 'mock-model-v1')).toBe('high');
    expect(resolvePiThinkingLevel(result.settings, 'mock', 'other')).toBe('low');
    expect(resolvePiCompactionSettings(result.settings, 'mock', 'mock-model-v1')).toEqual({
      enabled: false, reserveTokens: 5, keepRecentTokens: 200,
    });
    expect(resolvePiResourcePaths(result, 'prompts', root)).toEqual([
      path.join(agentDir, 'prompts', '*.md'),
      `!${path.join(agentDir, 'prompts', 'private.md')}`,
      `+${path.join(cwd, '.pi', 'team.md')}`,
    ]);
    expect(resolvePiSettingsPath('~/sessions', cwd, root)).toBe(path.join(root, 'sessions'));
    expect(selectPiResourcePaths([
      '/one.mjs', '/two.mjs', '-/one.mjs', '!/t*.mjs', '+/three.mjs', '+/three.mjs',
    ])).toEqual(['/three.mjs']);
    expect(resolvePiSettingsPath('./sessions', cwd, root)).toBe(path.join(cwd, 'sessions'));
  });
});
