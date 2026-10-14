import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionRegistry, loadAgentSettings, ThemeManager } from '@ai-harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { completeCliOptions, parseCliArguments } from './args.js';
import { configuredThemeSelection, configuredThemeSources } from './theme-sources.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-theme-composition-[literal]-')); roots.push(root);
  const cwd = path.join(root, 'project'), agent = path.join(root, 'agent');
  const file = async (target: string, value: unknown) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(value)); return target; };
  const theme = (target: string, name: string) => file(target, { name, appearance: 'dark', colors: { accent: '#123456' } });
  await mkdir(cwd); await mkdir(agent);
  const settings = (projectTrusted = true) => loadAgentSettings({ cwd, projectTrusted, agentDir: agent, homeDir: path.join(root, 'home') });
  return { root, cwd, agent, file, theme, settings };
}

describe('CLI theme composition', () => {
  it('parses repeatable literal sources, strict suppression and option termination', () => {
    expect(parseCliArguments(['--theme-source', '[literal].json', '--theme-source=+name.json', '--no-themes', '--theme', 'ocean']))
      .toMatchObject({ themeSources: ['[literal].json', '+name.json'], noThemes: true, theme: 'ocean' });
    expect(parseCliArguments(['--', '--no-themes'])).toMatchObject({ noThemes: false, messages: ['--no-themes'] });
    expect(parseCliArguments(['Hello', '--theme-source', 'file.json'])).toMatchObject({ themeSources: [], messages: ['Hello', '--theme-source', 'file.json'] });
    expect(() => parseCliArguments(['--no-themes=false'])).toThrow('--no-themes does not accept a value.');
    expect(() => parseCliArguments(['--theme-source'])).toThrow('--theme-source requires a value.');
    expect(() => parseCliArguments(['--theme-source='])).toThrow('--theme-source requires a non-empty value.');
    expect(completeCliOptions('--theme-', [])).toEqual(['--theme-source']);
  });

  it.each(['theme-source', 'no-themes'])('reserves %s against extension shadowing', async name => {
    await expect(new ExtensionRegistry().load('shadow', api => {
      api.registerOption(name, { type: 'boolean', description: 'Probe' });
    })).rejects.toThrow('Invalid extension startup option metadata.');
  });

  it('selects CLI over environment over trusted settings, with automatic fallback', async () => {
    const test = await fixture(); await test.file(path.join(test.agent, 'settings.json'), { theme: 'global' });
    await test.file(path.join(test.cwd, '.ai-harness/settings.json'), { theme: 'project' });
    const settings = await test.settings();
    expect(configuredThemeSelection(settings, { theme: 'explicit' }, { AI_HARNESS_THEME: 'environment' })).toBe('explicit');
    expect(configuredThemeSelection(settings, {}, { AI_HARNESS_THEME: 'environment' })).toBe('environment');
    expect(configuredThemeSelection(settings, {}, {})).toBe('project');
    expect(configuredThemeSelection(await test.settings(false), {}, {})).toBe('global');
    await test.file(path.join(test.agent, 'settings.json'), {});
    expect(configuredThemeSelection(await test.settings(false), {}, {})).toBe('auto');
  });

  it('composes auto, package and settings layers with project and final literal CLI precedence', async () => {
    const test = await fixture();
    await test.theme(path.join(test.agent, 'themes/ocean.json'), 'user-auto');
    const globalPackage = await test.theme(path.join(test.root, 'global-package/ocean.json'), 'user-package');
    await test.theme(path.join(test.agent, 'configured/nested/ocean.json'), 'user-settings');
    await test.file(path.join(test.agent, 'settings.json'), { themes: ['configured/**/*.json'] });
    await test.theme(path.join(test.cwd, '.ai-harness/themes/ocean.json'), 'project-auto');
    const projectPackage = await test.theme(path.join(test.root, 'project-package/ocean.json'), 'project-package');
    const projectSettings = await test.theme(path.join(test.cwd, '.ai-harness/configured/ocean.json'), 'project-settings');
    await test.file(path.join(test.cwd, '.ai-harness/settings.json'), { themes: ['configured/*.json'] });
    const explicit = await test.theme(path.join(test.root, '[explicit]/ocean.json'), 'cli');
    const settings = await test.settings(); const packages = { global: [globalPackage], project: [projectPackage] };
    const sources = await configuredThemeSources(settings, test.cwd, packages, {});
    expect(sources).toHaveLength(6);
    expect(sources[0]).toEqual({ path: projectSettings, scope: 'project', source: 'settings', trusted: true });
    expect((await ThemeManager.load('ocean', sources)).name).toBe('project-settings');
    expect((await ThemeManager.load('ocean', await configuredThemeSources(settings, test.cwd, packages, { themeSources: [explicit] }))).name).toBe('cli');
    const refused = await configuredThemeSources(await test.settings(false), test.cwd, packages, {});
    expect(refused).toHaveLength(3);
    expect((await ThemeManager.load('ocean', refused)).name).toBe('user-settings');
  });

  it('suppresses automatic arrays and packages without reading them, retaining explicit literal paths', async () => {
    const test = await fixture(); const explicit = await test.theme(path.join(test.root, '[explicit]/ocean.json'), 'cli');
    const settings = await test.settings();
    Object.defineProperty(settings, 'globalSettings', { get() { throw new Error('Suppressed settings read'); } });
    Object.defineProperty(settings, 'projectSettings', { get() { throw new Error('Suppressed settings read'); } });
    const packages = { get global(): string[] { throw new Error('Suppressed package read'); }, get project(): string[] { throw new Error('Suppressed package read'); } };
    expect(await configuredThemeSources(settings, test.cwd, packages, { noThemes: true })).toEqual([]);
    expect(await configuredThemeSources(settings, test.cwd, packages, { noThemes: true, themeSources: [explicit, explicit] }))
      .toEqual([{ path: explicit, scope: 'temporary', source: 'cli', trusted: true }]);
  });

  it('lets trusted project selectors remove global candidates and reinclude one exact file', async () => {
    const test = await fixture(); const selected = await test.theme(path.join(test.agent, 'themes/[literal].json'), 'selected');
    await test.theme(path.join(test.agent, 'themes/other.json'), 'excluded');
    await test.file(path.join(test.cwd, '.ai-harness/settings.json'), { themes: [`-${path.join(test.agent, 'themes')}`, `+${selected}`] });
    expect(await configuredThemeSources(await test.settings(), test.cwd, { global: [], project: [] }, {}))
      .toEqual([{ path: selected, scope: 'project', source: 'settings', trusted: true }]);
  });
});
