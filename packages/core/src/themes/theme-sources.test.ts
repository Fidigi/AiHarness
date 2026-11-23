import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverThemeSources, ThemeManager, type ThemeSourceSelector } from '../index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-themes-[literal]-')); roots.push(root);
  const cwd = path.join(root, 'project'); const user = path.join(root, 'user');
  await Promise.all([mkdir(cwd), mkdir(user)]);
  const file = async (relative: string, accent = '#123456') => {
    const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ name: path.basename(target, '.json'), appearance: 'dark', colors: { accent } })); return target;
  };
  const selector = (pattern: string, overrides: Partial<ThemeSourceSelector> = {}): ThemeSourceSelector => ({
    pattern, baseDir: user, scope: 'user', source: 'settings', trusted: true, ...overrides,
  });
  return { root, cwd, user, file, selector, context: { cwd, projectTrusted: true } };
}

describe('bounded metadata-only theme discovery', () => {
  it('combines shallow directories, recursive selectors, exclusions and exact reinclusion in priority order', async () => {
    const test = await fixture();
    const plain = await test.file('user/plain.json');
    const nested = await test.file('user/nested/other.json');
    const literal = await test.file('user/[literal].json');
    await test.file('user/ignored.txt');
    const shallow = await discoverThemeSources([test.selector('+.')], test.context);
    expect(shallow.map(source => source.path).sort()).toEqual([plain, literal].sort());
    const selected = await discoverThemeSources([
      test.selector('**/*.json'), test.selector('!**/*.json'), test.selector('+[literal].json'),
      test.selector('+nested/other.json', { source: 'cli', scope: 'temporary' }),
    ], test.context);
    expect(selected).toEqual([
      { path: nested, scope: 'temporary', source: 'cli', trusted: true },
      { path: literal, scope: 'user', source: 'settings', trusted: true },
    ]);
  });

  it.each(['colors', 'export'] as const)('never reflects private %s keys in schema diagnostics', async field => {
    const test = await fixture(); const file = await test.file('user/private.json');
    const privateKey = `PRIVATE-PALETTE-KEY${String.fromCharCode(27)}]52;c;unsafe${String.fromCharCode(7)}`;
    await writeFile(file, JSON.stringify({ name: 'private', appearance: 'dark', colors: {},
      [field]: { [privateKey]: '#123456' } }));
    await expect(ThemeManager.load(file)).rejects.toThrow(field === 'colors' ? 'Unknown theme color token.' : 'Unknown theme export token.');
    try { await ThemeManager.load(file); } catch (error) {
      expect(String(error)).not.toContain('PRIVATE'); expect(String(error)).not.toContain('\u001b');
    }
  });

  it('keeps palette body parsing separate from discovery', async () => {
    const test = await fixture(); const invalid = await test.file('user/invalid.json');
    await writeFile(invalid, '{not-json');
    const sources = await discoverThemeSources([test.selector('*.json')], test.context);
    expect(sources).toEqual([{ path: invalid, scope: 'user', source: 'settings', trusted: true }]);
    await expect(ThemeManager.load('invalid', sources, {}, test.context)).rejects.toThrow();
  });

  it('makes later project and explicit sources win filename collisions without changing ThemeManager', async () => {
    const test = await fixture(); await test.file('user/ocean.json', '#111111');
    const project = await test.file('project/ocean.json', '#222222');
    const explicit = await test.file('explicit/ocean.json', '#333333');
    const selectors = [test.selector('+ocean.json'), test.selector(`+${project}`, { scope: 'project' })];
    const sources = await discoverThemeSources(selectors, test.context);
    expect((await ThemeManager.load('ocean', sources, {}, test.context)).colors.accent).toBe('#222222');
    expect((await ThemeManager.load('ocean', await discoverThemeSources([
      ...selectors, test.selector(`+${explicit}`, { scope: 'temporary', source: 'cli' }),
    ], test.context), {}, test.context)).colors.accent).toBe('#333333');
  });

  it('inventories built-in-looking filenames as actual palettes with their original provenance', async () => {
    const test = await fixture(); const file = await test.file('user/dark.json');
    const sources = await discoverThemeSources([test.selector('+.')], test.context);
    const inventory = await ThemeManager.inventory(sources, file, test.context);
    expect(inventory.filter(item => item.active)).toEqual([expect.objectContaining({
      name: 'dark', valid: true, provenance: { path: file, scope: 'user', source: 'settings', trusted: true, selector: file, origin: 'top-level' },
    })]);
    expect((await ThemeManager.load(file, sources, {}, test.context)).colors.accent).toBe('#123456');
    expect((await ThemeManager.load('dark', sources, {}, test.context)).provenance.path).toBe('builtin:dark');
  });

  it('uses exact active identity for same-name palettes across scopes', async () => {
    const test = await fixture(); await test.file('user/ocean.json'); const project = await test.file('project/ocean.json');
    const sources = await discoverThemeSources([test.selector('+.'), test.selector(`+${project}`, { scope: 'project' })], test.context);
    const inventory = await ThemeManager.inventory(sources, project, test.context);
    expect(inventory.filter(item => item.active)).toHaveLength(1);
    expect(inventory.find(item => item.active)?.provenance.path).toBe(project);
  });

  it('deduplicates actual paths and refreshes metadata after removal and readdition', async () => {
    const test = await fixture(); const file = await test.file('user/ocean.json');
    const sources = await discoverThemeSources([
      test.selector('+ocean.json'), test.selector('+ocean.json', { source: 'package' }),
      test.selector('-.'), test.selector('+ocean.json', { source: 'cli', scope: 'temporary' }),
    ], test.context);
    expect(sources).toEqual([{ path: file, scope: 'temporary', source: 'cli', trusted: true }]);
  });

  it('refuses project paths and ancestor scans before trust despite misleading user provenance', async () => {
    const test = await fixture(); await test.file('project/private.json');
    const outside = await test.file('user/allowed.json');
    const sources = await discoverThemeSources([
      test.selector('+allowed.json'), test.selector(`+${test.cwd}`), test.selector('**/*.json', { baseDir: test.root }),
    ], { cwd: test.cwd, projectTrusted: false });
    expect(sources.map(source => source.path)).toEqual([outside]);
  });

  it('does not invoke accessors, including suppressed project selectors', async () => {
    const test = await fixture(); let calls = 0;
    const value = { ...test.selector('*.json'), get pattern() { calls++; return '*.json'; } };
    await expect(discoverThemeSources([value], test.context)).rejects.toThrow('Theme sources are invalid or exceed their limits.');
    expect(await discoverThemeSources([{ ...test.selector('*.json'), scope: 'project', get pattern() { calls++; return '*.json'; } }],
      { cwd: test.cwd, projectTrusted: false })).toEqual([]);
    expect(calls).toBe(0);
  });

  it('preserves directory intent and ignores non-JSON, symlink and hardlink leaves', async () => {
    const test = await fixture(); const safe = await test.file('user/safe.json');
    await symlink(safe, path.join(test.user, 'linked.json'));
    const hard = await test.file('user/hard.json'); await link(hard, path.join(test.user, 'second.json'));
    await test.file('user/plain.txt');
    expect((await discoverThemeSources([test.selector('+.')], test.context)).map(source => source.path)).toEqual([safe]);
    expect(await discoverThemeSources([test.selector('+safe.json/')], test.context)).toEqual([]);
  });

  it('rejects symlink ancestors without returning a partial generation', async () => {
    const test = await fixture(); await test.file('user/safe.json'); await test.file('target/private.json');
    await symlink(path.join(test.root, 'target'), path.join(test.root, 'alias'));
    await expect(discoverThemeSources([test.selector('+safe.json'), test.selector('+../alias/private.json')], test.context))
      .rejects.toThrow('Theme sources are invalid or exceed their limits.');
  });

  it.each(['', 'bad\0path', 'x'.repeat(32_769)])('rejects invalid selector strings (%#)', async pattern => {
    const test = await fixture();
    await expect(discoverThemeSources([test.selector(pattern)], test.context)).rejects.toThrow('Theme sources are invalid or exceed their limits.');
  });

  it('bounds request count independently from the existing 200-extension policy', async () => {
    const test = await fixture();
    expect(await discoverThemeSources(Array.from({ length: 1_000 }, () => test.selector('-missing')), test.context)).toEqual([]);
    await expect(discoverThemeSources(Array.from({ length: 1_001 }, () => test.selector('-missing')), test.context)).rejects.toThrow('Theme sources are invalid or exceed their limits.');
  });

  it('snapshots caller-owned selectors before asynchronous metadata work', async () => {
    const test = await fixture(); const file = await test.file('user/first.json'); await test.file('user/second.json');
    const selector = test.selector('+first.json');
    const pending = discoverThemeSources([selector], test.context);
    Object.assign(selector, { pattern: '+second.json', source: 'cli' });
    expect(await pending).toEqual([{ path: file, scope: 'user', source: 'settings', trusted: true }]);
  });

  it('admits exactly the complete 512-palette inventory and refuses the next file', async () => {
    const test = await fixture();
    await Promise.all(Array.from({ length: 512 }, (_, index) => test.file(`user/theme-${index}.json`)));
    expect(await discoverThemeSources([test.selector('+.')], test.context)).toHaveLength(512);
    await test.file('user/overflow.json');
    await expect(discoverThemeSources([test.selector('+.')], test.context)).rejects.toThrow('Theme sources are invalid or exceed their limits.');
  });

  it('counts repeated directory scans at the exact 256-directory boundary', async () => {
    const test = await fixture(); await test.file('user/one.json');
    const selectors = Array.from({ length: 256 }, () => test.selector('+.'));
    expect(await discoverThemeSources(selectors, test.context)).toHaveLength(1);
    await expect(discoverThemeSources([...selectors, test.selector('+.')], test.context)).rejects.toThrow('Theme sources are invalid or exceed their limits.');
  });

  it('counts repeated non-palette entries at the exact 10,000-entry boundary', async () => {
    const test = await fixture();
    await Promise.all(Array.from({ length: 1_000 }, (_, index) => writeFile(path.join(test.user, `entry-${index}.txt`), '')));
    const selectors = Array.from({ length: 10 }, () => test.selector('+.'));
    expect(await discoverThemeSources(selectors, test.context)).toEqual([]);
    await expect(discoverThemeSources([...selectors, test.selector('+.')], test.context)).rejects.toThrow('Theme sources are invalid or exceed their limits.');
  }, 30_000);

  it('admits exactly 10,000 candidate probes before refusing a further request', async () => {
    const test = await fixture();
    await Promise.all(Array.from({ length: 499 }, (_, index) => test.file(`user/theme-${index}.json`)));
    // Each shallow discovery probes its root and the 499 palette candidates.
    const selectors = Array.from({ length: 20 }, () => test.selector('+.'));
    expect(await discoverThemeSources(selectors, test.context)).toHaveLength(499);
    await expect(discoverThemeSources([...selectors, test.selector('+missing.json')], test.context)).rejects.toThrow('Theme sources are invalid or exceed their limits.');
  }, 30_000);

  it('bounds directory entries instead of returning an arbitrary prefix', async () => {
    const test = await fixture();
    await Promise.all(Array.from({ length: 1_001 }, (_, index) => writeFile(path.join(test.user, `entry-${index}.txt`), '')));
    await expect(discoverThemeSources([test.selector('+.')], test.context)).rejects.toThrow('Theme sources are invalid or exceed their limits.');
  });
});
