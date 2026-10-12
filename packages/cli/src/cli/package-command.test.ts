import { describe, expect, it } from 'vitest';
import { loadAgentSettings, ProjectTrustManager } from '@ai-harness/core';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  formatPackageCommandHelp,
  PackageCommandArgumentError,
  parsePackageCommandArguments,
  resolvePackageNpmOptions,
} from './package-command.js';

async function commandBoundaryFixture(): Promise<{
  root: string; agent: string; local: string; wrapper: string; log: string;
  run: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-npm-boundary-'));
  const project = path.join(root, 'project');
  const agent = path.join(root, 'agent');
  const local = path.join(project, '.ai-harness');
  const bin = path.join(root, 'bin');
  const wrapper = path.join(bin, 'wrapper');
  const log = path.join(root, 'executions.jsonl');
  for (const directory of [agent, local, bin]) await mkdir(directory, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ executable: process.argv[1], args }) + '\\n');
if (args[0] === 'view') console.log('"1.0.0"');
else {
  const spec = args.at(-1); const name = spec.startsWith('@demo/') ? spec : '@demo/plugin';
  const dest = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', ...name.split('/'));
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
}
`;
  for (const executable of [wrapper, path.join(bin, 'npm')]) {
    await writeFile(executable, script);
    await chmod(executable, 0o700);
  }
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ npmCommand: [wrapper] }));
  const adapter = pathToFileURL(fileURLToPath(new URL('./package-command.ts', import.meta.url))).href;
  const launcher = path.join(root, 'adapter.mjs');
  await writeFile(launcher, `import { runPackageCommand } from ${JSON.stringify(adapter)}; process.exitCode = await runPackageCommand(process.argv.slice(2));`);
  const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), launcher, ...args], {
    cwd: project, timeout: 10000, maxBuffer: 1024 * 1024,
    env: { ...process.env, HOME: root, AI_HARNESS_AGENT_DIR: agent, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  return { root, agent, local, wrapper, log, run };
}

describe('package command arguments', () => {
  it('parses aliases, scopes, trust, JSON output, and resource filters', () => {
    expect(parsePackageCommandArguments([
      'config', '@demo/plugin', '--project', '--approve', '--json',
      '--extensions=src/*.js,!src/legacy.js', '--skills=', '--prompts', '+prompts/review.md',
      '--themes', '-themes/legacy.json',
    ])).toEqual({
      action: 'configure',
      help: false,
      json: true,
      scope: 'project',
      selector: '@demo/plugin',
      projectTrust: true,
      resetFilters: false,
      filters: {
        extensions: ['src/*.js', '!src/legacy.js'],
        skills: [],
        prompts: ['+prompts/review.md'],
        themes: ['-themes/legacy.json'],
      },
    });
    expect(parsePackageCommandArguments(['uninstall', 'npm:@demo/plugin'])).toMatchObject({ action: 'remove' });
  });

  it('rejects unknown actions, conflicts, missing selectors, and misplaced filters', () => {
    expect(() => parsePackageCommandArguments(['unknown'])).toThrow(PackageCommandArgumentError);
    expect(() => parsePackageCommandArguments(['install'])).toThrow(/requires a source/i);
    expect(() => parsePackageCommandArguments(['remove'])).toThrow(/requires a package selector/i);
    expect(() => parsePackageCommandArguments(['list', '--global', '--project'])).toThrow(/conflict/i);
    expect(() => parsePackageCommandArguments(['list', '--skills', 'skills'])).toThrow(/only to package configure/i);
    expect(() => parsePackageCommandArguments(['configure', 'one'])).toThrow(/filter or --reset/i);
    expect(() => parsePackageCommandArguments(['configure', 'one', '--reset', '--themes=night.json']))
      .toThrow(/cannot be combined/i);
    expect(() => parsePackageCommandArguments(['list', 'unexpected'])).toThrow(/does not accept/i);
  });

  it('runs the real CLI adapter with settings-relative npm executables and trust-gated precedence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-npm-'));
    try {
      const project = path.join(root, 'project');
      const agent = path.join(root, 'agent');
      const local = path.join(project, '.ai-harness');
      const log = path.join(root, 'npm-log.jsonl');
      const marker = path.join(root, 'no-shell-marker');
      const literal = `$(touch ${marker});echo not-a-shell`;
      for (const [base, version] of [[agent, '1.0.0'], [local, '2.0.0']] as const) {
        await mkdir(path.join(base, 'bin'), { recursive: true });
        const fake = path.join(base, 'bin', 'npm fake');
        await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const [log, literal, ...args] = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ version: '${version}', args, literal, env: process.env }) + '\\n');
if (args[0] === 'view') console.log('"${version}"');
else {
if (!args.includes('--ignore-scripts')) process.exit(10);
const dest = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', '@demo', 'plugin');
fs.mkdirSync(dest, { recursive: true });
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: '@demo/plugin', version: '${version}' }));
}
`);
        await chmod(fake, 0o700);
        await writeFile(path.join(base, 'settings.json'), JSON.stringify({ npmCommand: ['./bin/npm fake', log, literal] }));
      }
      const adapter = pathToFileURL(fileURLToPath(new URL('./package-command.ts', import.meta.url))).href;
      const launcher = path.join(root, 'adapter.mjs');
      await writeFile(launcher, `import { runPackageCommand } from ${JSON.stringify(adapter)}; process.exitCode = await runPackageCommand(process.argv.slice(2));`);
      const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), launcher, ...args], {
        cwd: project, timeout: 10000, maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: root, AI_HARNESS_AGENT_DIR: agent, OPENAI_API_KEY: 'disposable-cli-secret' },
      });
      const installed = await run(['install', 'npm:@demo/plugin', '--json', '--no-approve']);
      expect(JSON.parse(installed.stdout).packages[0].version).toBe('1.0.0');
      await run(['list', '--json']);
      await run(['check', '@demo/plugin', '--json', '--no-approve']);
      const updated = await run(['update', '@demo/plugin', '--json', '--approve']);
      expect(JSON.parse(updated.stdout).packages[0].version).toBe('2.0.0');
      const all = await run(['update', '--json', '--no-approve']);
      expect(JSON.parse(all.stdout).packages[0].version).toBe('1.0.0');
      const entries = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(entries.map(entry => [entry.version, entry.args[0]])).toEqual([
        ['1.0.0', 'install'], ['1.0.0', 'view'], ['2.0.0', 'install'], ['1.0.0', 'install'],
      ]);
      for (const entry of entries) {
        expect(entry.literal).toBe(literal);
        expect(entry.env.OPENAI_API_KEY).toBeUndefined();
        expect(entry.env.npm_config_ignore_scripts).toBe('true');
      }
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ npmCommand: ['./private-missing-executable', 'private-prefix'] }));
      await expect(run(['update', '@demo/plugin'])).rejects.toMatchObject({
        stderr: 'Error: npm a échoué (ENOENT).\n',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  it.each([
    { name: 'global string', global: JSON.stringify({ npmCommand: 'private malformed command' }) },
    { name: 'global null', global: JSON.stringify({ npmCommand: null }) },
    { name: 'global empty array', global: JSON.stringify({ npmCommand: [] }) },
    { name: 'global invalid item', global: JSON.stringify({ npmCommand: ['npm', 42] }) },
    { name: 'project string over global', project: JSON.stringify({ npmCommand: 'private override' }) },
    { name: 'project null over global', project: JSON.stringify({ npmCommand: null }) },
    { name: 'project empty array over global', project: JSON.stringify({ npmCommand: [] }) },
    { name: 'project invalid item over global', project: JSON.stringify({ npmCommand: ['npm', false] }) },
    { name: 'project broken JSON', project: '{private invalid JSON' },
    { name: 'project invalid root', project: '[]' },
    { name: 'project nonregular source', project: 'directory' },
    { name: 'project linked source', project: 'symlink' },
    { name: 'project future diagnostic', project: JSON.stringify({ futureCommandPolicy: 'private value' }) },
    { name: 'global broken JSON', global: '{private invalid JSON' },
    { name: 'project override over default', global: 'missing', project: JSON.stringify({ npmCommand: null }) },
    { name: 'project invalid executable over global', project: JSON.stringify({ npmCommand: ['-private-executable'] }) },
    { name: 'project control argv over global', project: JSON.stringify({ npmCommand: ['npm', 'private\nargument'] }) },
    { name: 'project oversized source', project: ' '.repeat(256 * 1024 + 1) },
    { name: 'project non-UTF8 source', project: Buffer.from([0xff]) },
    { name: 'project root schema invalid', project: JSON.stringify(Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`unknown${i}`, false]))) },
    {
      name: 'diagnostic truncation hides a project rejection',
      global: JSON.stringify({ modelThinkingLevels: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`model${i}`, false])), npmCommand: null }),
      project: JSON.stringify({ npmCommand: null }),
    },
  ])('fails closed at the real CLI settings boundary: $name', async ({ global, project: projectSource }) => {
    const fixture = await commandBoundaryFixture();
    try {
      const { agent, local, log, run } = fixture;
      // Seed an installed npm record through the real runner, then invalidate settings.
      await run(['install', 'npm:@demo/plugin', '--json', '--no-approve']);
      if (global === 'missing') await rm(path.join(agent, 'settings.json'));
      else if (global !== undefined) await writeFile(path.join(agent, 'settings.json'), global);
      if (projectSource === 'directory') await mkdir(path.join(local, 'settings.json'));
      else if (projectSource === 'symlink') await symlink(path.join(agent, 'settings.json'), path.join(local, 'settings.json'));
      else if (projectSource !== undefined) await writeFile(path.join(local, 'settings.json'), projectSource);
      const trust = projectSource === undefined ? '--no-approve' : '--approve';
      const beforeLog = await readFile(log, 'utf8');
      // Passive paths must neither reject npm policy nor execute it.
      await run(['list', '--json', trust]);
      await run(['reload', '--json', trust]);
      const beforeState = await readFile(path.join(agent, 'plugins.json'), 'utf8');
      for (const args of [
        ['install', 'npm:@demo/another'], ['update', '@demo/plugin'], ['update'],
      ]) {
        await expect(run([...args, '--json', trust])).rejects.toMatchObject({
          stderr: 'Error: Invalid npmCommand: expected bounded executable and literal argv.\n',
        });
      }
      const check = await run(['check', '@demo/plugin', '--json', trust]);
      expect(JSON.parse(check.stdout)[0]).toMatchObject({ state: 'error', message: 'Configuration npmCommand invalide.' });
      expect(await readFile(log, 'utf8')).toBe(beforeLog);
      expect(await readFile(path.join(agent, 'plugins.json'), 'utf8')).toBe(beforeState);
      expect((await readdir(path.join(agent, 'plugins'))).filter(name => /^\.(?:staging|backup|lock)/.test(name))).toEqual([]);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }, 30000);

  it('allows a valid trusted project replacement over rejected global data, but never reads an untrusted override', async () => {
    const fixture = await commandBoundaryFixture();
    try {
      await writeFile(path.join(fixture.agent, 'settings.json'), JSON.stringify({ npmCommand: null }));
      await writeFile(path.join(fixture.local, 'settings.json'), JSON.stringify({ npmCommand: [fixture.wrapper] }));
      const installed = await fixture.run(['install', 'npm:@demo/plugin', '--json', '--approve']);
      expect(JSON.parse(installed.stdout).packages[0].version).toBe('1.0.0');
      await writeFile(path.join(fixture.agent, 'settings.json'), JSON.stringify({ npmCommand: [fixture.wrapper] }));
      await writeFile(path.join(fixture.local, 'settings.json'), '{private invalid JSON');
      await fixture.run(['update', '@demo/plugin', '--no-approve']);
      expect((await readFile(fixture.log, 'utf8')).trim().split('\n')).toHaveLength(2);
      // Missing sources are absence, not an attempted override: PATH default is allowed.
      await rm(path.join(fixture.agent, 'settings.json'));
      await rm(path.join(fixture.local, 'settings.json'));
      await fixture.run(['update', '@demo/plugin', '--approve']);
      const entries = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(entries.map(entry => path.basename(entry.executable))).toEqual(['wrapper', 'wrapper', 'npm']);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }, 30000);

  it.each(['none', 'exact', 'inherited'])('explicit --approve/-a beats %s saved refusal without persisting approval', async saved => {
    const f = await commandBoundaryFixture();
    try {
      const project = path.dirname(f.local);
      const projectWrapper = path.join(f.local, 'project-wrapper');
      await writeFile(projectWrapper, await readFile(f.wrapper)); await chmod(projectWrapper, 0o700);
      await writeFile(path.join(f.local, 'settings.json'), JSON.stringify({ npmCommand: [projectWrapper] }));
      const writer = new ProjectTrustManager(path.join(f.agent, 'trust.json')); await writer.load();
      if (saved !== 'none') await writer.setDecision(saved === 'exact' ? project : f.root, false);
      const before = await readFile(path.join(f.agent, 'trust.json')).catch(() => undefined);
      for (const flag of ['--approve', '-a']) {
        const args = flag === '--approve' ? ['install', 'npm:@demo/plugin'] : ['update', '@demo/plugin'];
        expect(JSON.parse((await f.run([...args, '--json', flag])).stdout).packages[0].version).toBe('1.0.0');
      }
      expect(await readFile(path.join(f.agent, 'trust.json')).catch(() => undefined)).toEqual(before);
      expect((await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line).executable)).toEqual([projectWrapper, projectWrapper]);
      await writer.setDecision(project, true);
      const allowed = await readFile(path.join(f.agent, 'trust.json'));
      await f.run(['update', '@demo/plugin', '--no-approve']);
      expect(JSON.parse((await readFile(f.log, 'utf8')).trim().split('\n').at(-1)!).executable).toBe(f.wrapper);
      expect(await readFile(path.join(f.agent, 'trust.json'))).toEqual(allowed);
      expect(() => parsePackageCommandArguments(['list', '-a', '--no-approve'])).toThrow(/conflicts/);
      expect(() => parsePackageCommandArguments(['list', '--no-approve', '--approve'])).toThrow(/conflicts/);
      expect((await readdir(f.agent)).filter(name => /lock|tmp/.test(name))).toEqual([]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 30000);

  it('uses flag before explicit session-only choice for initial/refresh options, never promotes resolved trust', async () => {
    const f = await commandBoundaryFixture();
    try {
      const project = path.dirname(f.local);
      await writeFile(path.join(f.local, 'settings.json'), JSON.stringify({ npmCommand: [f.wrapper] }));
      const resolved = await loadAgentSettings({ cwd: project, agentDir: f.agent, projectTrusted: true });
      expect(resolvePackageNpmOptions(resolved, project).npmCommandSourceTrustOverride).toBeUndefined();
      for (const [flag, session, expected] of [[undefined, true, true], [undefined, false, false], [true, false, true], [false, true, false]] as const) {
        const options = resolvePackageNpmOptions(resolved, project, flag, session);
        expect(options.npmCommandSourceTrustOverride).toEqual({ cwd: project, trusted: expected });
        expect(Object.isFrozen(options.npmCommandSourceTrustOverride)).toBe(true);
      }
      expect(JSON.stringify(resolvePackageNpmOptions(resolved, project, undefined, true)))
        .not.toBe(JSON.stringify(resolvePackageNpmOptions(resolved, project, undefined, false)));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('provides command-specific help', () => {
    expect(formatPackageCommandHelp()).toContain('package install');
    expect(formatPackageCommandHelp()).toContain('--extensions');
    expect(formatPackageCommandHelp()).toContain('never contact npm/Git');
  });
});
