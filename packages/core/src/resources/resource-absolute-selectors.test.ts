import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverThemeSources, loadAgentSettings, resolveAgentResourcePaths,
  ResourceManager, ThemeManager, type ResourceManagerOptions } from '../index.js';
import { selectResourceFiles } from './file-selectors.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const variants = [['[literal]', 'l'], ['?literal', 'Xliteral'], ['*literal', 'BAITliteral'], ['{left,right}', 'left']] as const;
const fields = ['skills', 'prompts'] as const;
async function fixture(suffix = '[literal]') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-absolute-resources-')); roots.push(root);
  const cwd = path.join(root, `work${suffix}`), agentDir = path.join(root, `agent${suffix}`), homeDir = path.join(root, `home${suffix}`);
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(homeDir)]);
  const options = { cwd, agentDir, homeDir, projectTrusted: true, strictSkills: true } satisfies ResourceManagerOptions;
  const file = async (target: string, content = 'LITERAL BODY') => {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `---\nname: review\ndescription: Absolute selector fixture\n---\n${content}`); return target;
  };
  return { root, cwd, agentDir, homeDir, options, file };
}
function relative(field: typeof fields[number]): string { return field === 'skills' ? 'review/SKILL.md' : 'review.md'; }
function pattern(field: typeof fields[number]): string { return field === 'skills' ? '**/SKILL.md' : '*.md'; }
function content(manager: ResourceManager, field: typeof fields[number]): string | undefined {
  return field === 'skills' ? manager.getSkill('review')?.instructions : manager.getPrompt('review')?.content;
}

describe('absolute resource selectors preserve known literal roots', () => {
  for (const field of fields) for (const context of ['global', 'project', 'home'] as const) for (const [literal, bait] of variants) {
    it(`legacy ${field}/${context}/${literal}: unchanged public string helper cannot select sibling bait`, async () => {
      const test = await fixture(literal);
      const base = context === 'global' ? test.agentDir : context === 'project' ? path.join(test.cwd, '.ai-harness') : test.homeDir;
      const exact = await test.file(path.join(base, 'configured', relative(field)));
      await test.file(exact.replace(literal, bait), 'UNREQUESTED BASE GLOB MATCH');
      const value = `${context === 'home' ? '~/' : ''}configured/${pattern(field)}`;
      const settingsFile = path.join(context === 'project' ? base : test.agentDir, 'settings.json');
      await mkdir(path.dirname(settingsFile), { recursive: true });
      await writeFile(settingsFile, JSON.stringify({ [field]: [value] }));
      const settings = await loadAgentSettings(test.options);
      const scope = context === 'project' ? 'project' : 'global';
      const paths = resolveAgentResourcePaths(settings, field, test.homeDir, scope);
      // Compatibility guard: do not fix the consumer by changing public strings.
      expect(paths).toEqual([path.join(base, 'configured', pattern(field))]);
      const option = `${scope}${field === 'skills' ? 'Skill' : 'Prompt'}Paths`;
      const manager = new ResourceManager({ ...test.options, [option]: paths });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(manager.listInventory().map(item => item.provenance.path)).toEqual([exact]);
      expect(content(manager, field)).toBe('LITERAL BODY');
    });
  }
  for (const field of fields) for (const scope of ['global', 'project'] as const) for (const [literal, bait] of variants) {
    it(`scoped ${field}/${scope}/${literal}: absolute pattern does not reinterpret its own base`, async () => {
      const test = await fixture(literal);
      const baseDir = scope === 'global' ? test.agentDir : path.join(test.cwd, '.ai-harness');
      const exact = await test.file(path.join(baseDir, 'configured', relative(field)));
      await test.file(exact.replace(literal, bait), 'BAIT');
      const option = `${scope}${field === 'skills' ? 'Skill' : 'Prompt'}Selectors`;
      const manager = new ResourceManager({ ...test.options, [option]: [{ baseDir, pattern: path.join(baseDir, 'configured', pattern(field)) }] });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(manager.listInventory().map(item => item.provenance.path)).toEqual([exact]);
      expect(content(manager, field)).toBe('LITERAL BODY');
    });
  }
  for (const field of fields) {
    it(`${field}: absolute exclusions, exact removal and readdition preserve order and literal identity`, async () => {
      const test = await fixture(); const base = path.join(test.agentDir, 'configured');
      const exact = await test.file(path.join(base, relative(field)));
      await test.file(exact.replace('[literal]', 'l'), 'BAIT');
      const option = `global${field === 'skills' ? 'Skill' : 'Prompt'}Paths`;
      const glob = path.join(base, pattern(field));
      const manager = new ResourceManager({ ...test.options, [option]: [glob, '!' + glob, '+' + exact, '-' + base, '+' + exact] });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(manager.listInventory().map(item => item.provenance.path)).toEqual([exact]);
      expect(content(manager, field)).toBe('LITERAL BODY');
    });
    it(`${field}: only the known root is literal, nested directory patterns keep glob semantics`, async () => {
      const test = await fixture();
      const a = await test.file(path.join(test.agentDir, 'configured/a', relative(field)));
      const b = await test.file(path.join(test.agentDir, 'configured/b', relative(field)));
      await test.file(path.join(test.agentDir, 'configured/[ab]', relative(field)), 'LITERAL NESTED BAIT');
      const option = `global${field === 'skills' ? 'Skill' : 'Prompt'}Paths`;
      const manager = new ResourceManager({ ...test.options, [option]: [path.join(test.agentDir, 'configured/[ab]', pattern(field))] });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(manager.listInventory().map(item => item.provenance.path).sort()).toEqual([a, b].sort());
    });
    it(`${field}: absolute legacy project selectors remain blocked before trust`, async () => {
      const test = await fixture();
      await test.file(path.join(test.cwd, '.ai-harness/configured', relative(field)));
      const option = `global${field === 'skills' ? 'Skill' : 'Prompt'}Paths`;
      const manager = new ResourceManager({ ...test.options, projectTrusted: false,
        [option]: [path.join(test.cwd, '.ai-harness/configured', pattern(field))] });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(manager.listInventory()).toEqual([]);
    });
    it(`${field}: an absolute directory remains a recursive directory request, not an empty glob`, async () => {
      const test = await fixture(); const base = path.join(test.agentDir, 'configured');
      const exact = await test.file(path.join(base, relative(field)));
      await test.file(exact.replace('[literal]', 'l'), 'BAIT');
      const option = `global${field === 'skills' ? 'Skill' : 'Prompt'}Paths`;
      const manager = new ResourceManager({ ...test.options, [option]: [base + path.sep] });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(manager.listInventory().map(item => item.provenance.path)).toEqual([exact]);
    });
  }
  for (const field of fields) {
    it(`${field}: most specific known root wins over its literal home ancestor`, async () => {
      const test = await fixture(); const agentDir = path.join(test.homeDir, 'nested[literal]');
      const exact = await test.file(path.join(agentDir, 'configured', relative(field)));
      await test.file(exact.replace('nested[literal]', 'nestedl'), 'NESTED ROOT BAIT');
      const option = `global${field === 'skills' ? 'Skill' : 'Prompt'}Paths`;
      const manager = new ResourceManager({ ...test.options, agentDir, [option]: [path.join(agentDir, 'configured', pattern(field))] });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(manager.listInventory().map(item => item.provenance.path)).toEqual([exact]);
    });
    it(`${field}: outside-base absolute directory patterns are not guessed to be literal`, async () => {
      const test = await fixture();
      const a = await test.file(path.join(test.root, 'external-a', relative(field)));
      const b = await test.file(path.join(test.root, 'external-b', relative(field)));
      await test.file(path.join(test.root, 'external-[ab]', relative(field)), 'LITERAL DIRECTORY BAIT');
      const option = `global${field === 'skills' ? 'Skill' : 'Prompt'}Selectors`;
      const manager = new ResourceManager({ ...test.options, [option]: [{ baseDir: test.agentDir,
        pattern: path.join(test.root, 'external-[ab]', pattern(field)) }] });
      expect(await manager.loadAll()).toMatchObject({ errors: [] });
      expect(manager.listInventory().map(item => item.provenance.path).sort()).toEqual([a, b].sort());
    });
  }
  it('preserves normalized Windows trailing-directory intent using delegated native win32 path operations', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const target = ${JSON.stringify(new URL('../../dist/resources/file-selectors.js', import.meta.url).href)};
      const adapter = 'data:text/javascript,' + encodeURIComponent("import path from 'node:path';export default path.win32;");
      const hook = registerHooks({ resolve(specifier, context, next) {
        return specifier === 'node:path' && context.parentURL === target
          ? { url: adapter, shortCircuit: true } : next(specifier, context);
      } });
      try {
        const { selectResourceFiles } = await import(target);
        for (const ending of ['/', '//', '\\\\']) {
          const seen = [], baseDir = 'C:\\\\agent[literal]';
          await selectResourceFiles([], [{ baseDir, pattern: 'C:/agent[literal]/bundle.mjs' + ending }], {
            cwd: baseDir, allowed: () => true,
            discover: async (candidate, directoryOnly) => { seen.push({ candidate, directoryOnly }); return []; },
          });
          assert.deepEqual(seen, [{ candidate: 'C:\\\\agent[literal]\\\\bundle.mjs', directoryOnly: true }]);
        }
      } finally { hook.deregister(); }
    `], { encoding: 'utf8', timeout: 5_000 });
    expect({ status: result.status, signal: result.signal, error: result.error, stdout: result.stdout, stderr: result.stderr })
      .toEqual({ status: 0, signal: null, error: undefined, stdout: '', stderr: '' });
  });
  for (const [literal, bait] of variants) {
    it(`actual extension/${literal}: evaluates only the literal-base module, never sibling code`, async () => {
      const test = await fixture(literal); const exact = path.join(test.agentDir, 'configured/entry.mjs');
      await test.file(exact, 'placeholder'); await writeFile(exact, 'export default () => {};');
      await test.file(exact.replace(literal, bait), 'placeholder');
      await writeFile(exact.replace(literal, bait), 'throw new Error("UNREQUESTED EXECUTABLE BASE GLOB MATCH");');
      // Exercise native file-URL resolution outside Vitest's import interception,
      // including its encoded ? directory, through the real emitted Core entry.
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { ExtensionModuleLoader, ExtensionRegistry } from ${JSON.stringify(new URL('../../dist/index.js', import.meta.url).href)};
        const loader = new ExtensionModuleLoader(new ExtensionRegistry(), ${JSON.stringify({ cwd: test.cwd,
          includeGlobalLocation: false, includeProjectLocation: false, includeEnvironmentPaths: false,
          selectors: [{ baseDir: test.agentDir, pattern: path.join(test.agentDir, 'configured/*.mjs') }] })});
        const result = await loader.loadAll();
        assert.deepEqual(result.loaded, [${JSON.stringify(exact)}]);
        assert.deepEqual(result.errors, []); assert.equal(result.committed, true);
      `], { encoding: 'utf8', timeout: 5_000 });
      expect({ status: result.status, signal: result.signal, error: result.error, stdout: result.stdout, stderr: result.stderr })
        .toEqual({ status: 0, signal: null, error: undefined, stdout: '', stderr: '' });
    });
    it(`actual theme/${literal}: discovers and loads only the literal-base palette`, async () => {
      const test = await fixture(literal); const exact = path.join(test.agentDir, 'configured/palette.json');
      await test.file(exact, 'placeholder');
      await writeFile(exact, JSON.stringify({ name: 'palette', appearance: 'dark', colors: { accent: '#123456' } }));
      await test.file(exact.replace(literal, bait), 'placeholder');
      await writeFile(exact.replace(literal, bait), JSON.stringify({ name: 'palette', appearance: 'dark', colors: { accent: '#badbad' } }));
      const context = { cwd: test.cwd, projectTrusted: true };
      const sources = await discoverThemeSources([{ baseDir: test.agentDir,
        pattern: path.join(test.agentDir, 'configured/*.json'), scope: 'user', source: 'settings', trusted: true }], context);
      expect(sources.map(source => source.path)).toEqual([exact]);
      expect((await ThemeManager.load('palette', sources, {}, context)).colors.accent).toBe('#123456');
    });
    it(`shared extension/theme selector/${literal}: absolute patterns honor the literal declaring base`, async () => {
      const test = await fixture(literal); const baseDir = test.agentDir;
      const exact = await test.file(path.join(baseDir, 'configured/entry.ts'));
      await test.file(exact.replace(literal, bait), 'BAIT');
      const files = await selectResourceFiles([], [{ baseDir, pattern: path.join(baseDir, 'configured/*.ts') }], {
        cwd: test.cwd, allowed: () => true, discover: async file => [file],
      });
      expect(files).toEqual([exact]);
    });
  }
});
