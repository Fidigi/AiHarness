import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTrustManager } from '@ai-harness/core';
import { createApp, start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

const roots: string[] = [];
afterEach(async () => {
  await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
interface Execution { executable: string; args: string[]; cwd: string; env: Record<string, string>; }
async function fixture(restricted = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-server-npm-')); roots.push(root);
  const dataDir = path.join(root, 'data'); const defaultCwd = path.join(root, 'default');
  const cwd = path.join(root, 'source'); const local = path.join(cwd, '.ai-harness'); const bin = path.join(root, 'path');
  const log = path.join(root, 'executions.jsonl'); const version = path.join(root, 'version');
  const globalSettings = path.join(dataDir, 'settings.json'); const projectSettings = path.join(local, 'settings.json');
  const literal = `$(touch ${path.join(root, 'shell-marker')}); --private-literal`;
  for (const dir of [dataDir, defaultCwd, local, bin]) await mkdir(dir, { recursive: true });
  await writeFile(log, ''); await writeFile(version, '1.0.0');
  const script = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const raw = process.argv.slice(2); const action = raw.findIndex(arg => arg === 'install' || arg === 'view');
const args = raw.slice(action);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ executable: process.argv[1], args: raw, cwd: process.cwd(), env: process.env }) + '\\n');
const version = fs.readFileSync(${JSON.stringify(version)}, 'utf8');
if (args[0] === 'view') console.log(JSON.stringify(version));
else {
  const name = args.at(-1); const dest = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', ...name.split('/'));
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name, version }));
}
`;
  // All executable locations are disposable. No fallback can ever reach system npm.
  for (const executable of [path.join(dataDir, 'bin', 'npm fake'), path.join(local, 'bin', 'npm fake'), path.join(bin, 'npm')]) {
    await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, script); await chmod(executable, 0o700);
  }
  const command = ['./bin/npm fake', '--literal', literal];
  await writeFile(globalSettings, JSON.stringify({ npmCommand: command }));
  // A startup-cwd command must never be selected for the requested source workspace.
  await mkdir(path.join(defaultCwd, '.ai-harness'));
  await writeFile(path.join(defaultCwd, '.ai-harness', 'settings.json'), JSON.stringify({ npmCommand: ['/missing-default-command'] }));
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'npm-admin'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'npm-admin');
  vi.stubEnv('AI_HARNESS_PROVIDER_RENAME_EXCLUSIVE_HOST', '');
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv('NPM_CONFIG_USERCONFIG', '/private-must-not-inherit');
  let servicesPromise!: Promise<RuntimeServices>;
  createApp({ dataDir, defaultCwd, allowedRoots: [cwd, defaultCwd], port: 0, host: '127.0.0.1', providerRenameExclusiveHost: restricted,
    runtimeServicesFactory: (proxy, options) => (servicesPromise = createRuntimeServices(proxy, options)),
  });
  const { port } = await start(); const services = await servicesPromise;
  const base = `http://127.0.0.1:${port}/api/plugins`;
  const request = async (route: string, body?: Record<string, unknown>) => {
    const response = await fetch(`${base}${route}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer npm-admin', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify({ cwd: path.join(cwd, '..', 'source'), ...body }) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const executions = async (): Promise<Execution[]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const trust = async (decision: boolean) => {
    // Independent persisted writer: admission must refresh, not use startup trust.
    const writer = new ProjectTrustManager(path.join(dataDir, 'trust.json')); await writer.load();
    await writer.setDecision(cwd, decision);
  };
  const install = (source: string, scope = 'global') => request('', { action: 'install', source, scope });
  return { root, cwd, defaultCwd, local, dataDir, bin, log, version, literal, command, globalSettings, projectSettings, services, request, executions, trust, install };
}

async function noResidue(dataDir: string): Promise<void> {
  expect((await readdir(path.join(dataDir, 'plugins'))).filter(name => /staging|backup|lock/.test(name))).toEqual([]);
  expect((await readdir(dataDir)).filter(name => /plugins.*(?:lock|tmp)/.test(name))).toEqual([]);
}

describe('real HTTP npm settings admission (disposable executables, no network)', () => {
  it('uses source-relative literal global/project argv, fresh trust/settings, filtered env and scoped check/update-all', async () => {
    const f = await fixture();
    await f.trust(true);
    const first = await f.install('npm:server-global'); expect(first.status).toBe(200);
    const globalKey = first.body.packages[0].key;
    expect((await f.executions())[0]).toMatchObject({ executable: path.join(f.dataDir, 'bin', 'npm fake') });
    await writeFile(f.projectSettings, JSON.stringify({ npmCommand: f.command }));
    const second = await f.install('npm:server-project', 'project'); expect(second.status).toBe(200);
    const projectKey = second.body.packages.find((pkg: { scope: string }) => pkg.scope === 'project').key;
    await writeFile(f.version, '2.0.0');
    for (const scope of ['global', 'project']) {
      const check = await f.request('/check', { scope }); expect(check.status).toBe(200);
      expect(check.body.updates).toHaveLength(1); expect(check.body.updates[0]).toMatchObject({ scope, state: 'update-available' });
    }
    expect((await f.request('/check', { scope: 'project', key: globalKey })).status).toBe(404);
    const scoped = await f.request('', { action: 'update', scope: 'project' }); expect(scoped.status).toBe(200);
    expect(scoped.body.packages.find((pkg: { scope: string }) => pkg.scope === 'global').version).toBe('1.0.0');
    expect(scoped.body.packages.find((pkg: { key: string }) => pkg.key === projectKey).version).toBe('2.0.0');
    expect((await f.request('', { action: 'update', key: globalKey, scope: 'global' })).status).toBe(200);
    await writeFile(f.version, '3.0.0');
    const all = await f.request('', { action: 'update' }); expect(all.status).toBe(200);
    expect(all.body.packages.map((pkg: { version: string }) => pkg.version)).toEqual(['3.0.0', '3.0.0']);
    const entries = await f.executions();
    for (const [index, entry] of entries.entries()) {
      expect(entry.executable).toBe(path.join(index === 0 ? f.dataDir : f.local, 'bin', 'npm fake'));
      expect(entry.args.slice(0, 2)).toEqual(['--literal', f.literal]);
      const args = entry.args.slice(2);
      if (args[0] === 'install') {
        expect(args).toEqual(['install', '--prefix', entry.cwd, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--omit=dev', args.at(-1)]);
        expect(entry.cwd).toMatch(/\/plugins\/\.staging-/);
      } else {
        expect(args).toEqual(['view', args[1], 'version', '--json']); expect(entry.cwd).toBe(f.dataDir);
      }
      expect(entry.env.NPM_CONFIG_USERCONFIG).toBeUndefined(); expect(entry.env.AI_HARNESS_AUTH_TOKEN).toBeUndefined();
      expect(entry.env.npm_config_ignore_scripts).toBe('true');
    }
    expect(await readdir(f.root)).not.toContain('shell-marker');
    // Revocation selects global even though the project has a command; subsequent
    // persisted allow plus a changed command takes effect without runtime restart.
    await f.trust(false);
    expect((await f.install('npm:server-revoked')).status).toBe(200);
    expect((await f.executions()).at(-1)?.executable).toBe(path.join(f.dataDir, 'bin', 'npm fake'));
    await f.trust(true);
    await writeFile(f.projectSettings, JSON.stringify({ npmCommand: [path.join(f.bin, 'npm')] }));
    expect((await f.request('/check', { scope: 'global' })).status).toBe(200);
    expect((await f.executions()).at(-1)?.executable).toBe(path.join(f.bin, 'npm'));
    await noResidue(f.dataDir);
  });

  it('clean project replacement supersedes rejected global; absence selects PATH; untrusted body is never opened', async () => {
    const f = await fixture();
    await writeFile(f.globalSettings, '{malformed global');
    await writeFile(f.projectSettings, JSON.stringify({ npmCommand: f.command })); await f.trust(true);
    expect((await f.install('npm:server-project-replacement')).status).toBe(200);
    expect((await f.executions()).at(-1)?.executable).toBe(path.join(f.local, 'bin', 'npm fake'));
    await f.trust(false); await rm(f.globalSettings);
    // On this Linux Docker filesystem, force atime older than mtime/ctime so
    // even relatime records a body read. The later trusted read is the positive
    // control; no filesystem/loader/process mock can hide an actual read.
    await writeFile(f.projectSettings, '{private invalid untrusted body');
    const old = new Date('2000-01-01T00:00:00Z'); await utimes(f.projectSettings, old, old);
    const atime = (await stat(f.projectSettings)).atimeMs;
    expect((await f.request(`?cwd=${encodeURIComponent(f.cwd)}&refresh=1`)).status).toBe(200);
    expect((await f.request('/reload', {})).status).toBe(200);
    expect((await f.request('', { action: 'install', source: 'npm:server-default', scope: 'global', projectTrusted: true })).status).toBe(200);
    expect((await f.executions()).at(-1)?.executable).toBe(path.join(f.bin, 'npm'));
    expect((await stat(f.projectSettings)).atimeMs).toBe(atime);
    await f.trust(true);
    const before = await readFile(f.log, 'utf8');
    expect((await f.install('npm:server-newly-trusted-invalid')).body).toMatchObject({ code: 'INVALID_PLUGIN_NPM_COMMAND' });
    expect((await stat(f.projectSettings)).atimeMs).toBeGreaterThan(atime);
    expect(await readFile(f.log, 'utf8')).toBe(before);
    await rm(f.projectSettings);
    expect((await f.install('npm:server-absent')).status).toBe(200);
  });

  it.each([
    { name: 'global string', global: JSON.stringify({ npmCommand: 'private string' }) },
    { name: 'global null', global: JSON.stringify({ npmCommand: null }) },
    { name: 'global empty', global: JSON.stringify({ npmCommand: [] }) },
    { name: 'global invalid JSON', global: '{private invalid' },
    { name: 'project string', project: JSON.stringify({ npmCommand: 'private override' }) },
    { name: 'project null', project: JSON.stringify({ npmCommand: null }) },
    { name: 'project empty', project: JSON.stringify({ npmCommand: [] }) },
    { name: 'project invalid item', project: JSON.stringify({ npmCommand: ['npm', false] }) },
    { name: 'project invalid JSON', project: '{private invalid' },
    { name: 'project root', project: '[]' },
    { name: 'project unknown diagnostic', project: JSON.stringify({ futurePrivatePolicy: true }) },
    { name: 'project unrelated diagnostic', project: JSON.stringify({ defaultThinkingLevel: 42 }) },
    { name: 'project nonregular', kind: 'directory' },
    { name: 'project linked', kind: 'linked' },
    { name: 'project invalid UTF8', kind: 'utf8' },
    { name: 'project oversized', kind: 'oversized' },
    { name: 'project process-invalid executable', project: JSON.stringify({ npmCommand: ['-private-executable'] }) },
    { name: 'project process-invalid argv', project: JSON.stringify({ npmCommand: ['npm', 'private\u001bvalue'] }) },
    { name: 'invalid project over default', global: 'absent', project: JSON.stringify({ npmCommand: null }) },
    { name: 'saturation over clean replacement', global: JSON.stringify({ modelThinkingLevels: Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`model${index}`, false])) }), project: 'valid' },
  ])('refuses $name without fallback, staging, state publication or eager passive npm validation', async testCase => {
    const f = await fixture(); await f.trust(true);
    const seed = await f.install('npm:server-seed'); expect(seed.status).toBe(200);
    const key = seed.body.packages[0].key;
    if (testCase.global === 'absent') await rm(f.globalSettings);
    else if (testCase.global !== undefined) await writeFile(f.globalSettings, testCase.global);
    if (testCase.project !== undefined) await writeFile(f.projectSettings, testCase.project === 'valid' ? JSON.stringify({ npmCommand: f.command }) : testCase.project);
    if (testCase.kind === 'directory') await mkdir(f.projectSettings);
    if (testCase.kind === 'linked') await symlink(f.globalSettings, f.projectSettings);
    if (testCase.kind === 'utf8') await writeFile(f.projectSettings, Buffer.from([0xff, 0xfe]));
    if (testCase.kind === 'oversized') await writeFile(f.projectSettings, ' '.repeat(300 * 1024));
    const beforeLog = await readFile(f.log, 'utf8');
    expect((await f.request(`?cwd=${encodeURIComponent(f.cwd)}&refresh=1`)).status).toBe(200);
    expect((await f.services.pluginService.getEnabledResourceLocations('extension', { cwd: f.cwd })).length).toBe(0);
    expect((await f.request('/reload', {})).status).toBe(200);
    const state = await readFile(path.join(f.dataDir, 'plugins.json'), 'utf8');
    for (const body of [
      { action: 'install', source: 'npm:server-refused', scope: 'global' },
      { action: 'install', source: 'git:https://github.com/demo/private-repository', scope: 'global' },
      { action: 'update', scope: 'global', key },
      { action: 'update', scope: 'global' },
      { action: 'update' },
    ]) {
      const refused = await f.request('', body); expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: 'INVALID_PLUGIN_NPM_COMMAND' });
      expect(JSON.stringify(refused.body)).not.toMatch(/private|future|settings\.json/);
    }
    const check = await f.request('/check', { scope: 'global', key }); expect(check.status).toBe(200);
    expect(check.body.updates).toHaveLength(1);
    expect(check.body.updates[0]).toMatchObject({ state: 'error', message: 'Configuration npmCommand invalide.' });
    expect(await readFile(f.log, 'utf8')).toBe(beforeLog);
    expect(await readFile(path.join(f.dataDir, 'plugins.json'), 'utf8')).toBe(state);
    expect((await f.request(`?cwd=${encodeURIComponent(f.cwd)}&refresh=1`)).body.packages).toHaveLength(1);
    await noResidue(f.dataDir);
  });

  it('concurrent source workspaces retain operation-local commands and share the existing Core state lock', async () => {
    const f = await fixture(); await f.trust(true);
    const other = path.join(f.defaultCwd, '.ai-harness');
    await mkdir(path.join(other, 'bin'));
    const otherExecutable = path.join(other, 'bin', 'npm fake');
    await writeFile(otherExecutable, await readFile(path.join(f.local, 'bin', 'npm fake'))); await chmod(otherExecutable, 0o700);
    await writeFile(path.join(other, 'settings.json'), JSON.stringify({ npmCommand: f.command }));
    const writer = new ProjectTrustManager(path.join(f.dataDir, 'trust.json')); await writer.load(); await writer.trust(f.defaultCwd);
    await writeFile(f.projectSettings, JSON.stringify({ npmCommand: f.command }));
    const results = await Promise.all([
      f.install('npm:server-source-one'),
      f.request('', { action: 'install', scope: 'global', source: 'npm:server-source-two', cwd: f.defaultCwd }),
    ]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    const entries = await f.executions(); expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.args.at(-1) === 'server-source-one')?.executable).toBe(path.join(f.local, 'bin', 'npm fake'));
    expect(entries.find(entry => entry.args.at(-1) === 'server-source-two')?.executable).toBe(otherExecutable);
    const catalog = await f.request(`?cwd=${encodeURIComponent(f.cwd)}&refresh=1`);
    expect(catalog.body.packages.map((pkg: { packageName: string }) => pkg.packageName).sort()).toEqual(['server-source-one', 'server-source-two']);
    await noResidue(f.dataDir);
  });

  it('captures immutable options at admission without mutating the passive singleton', async () => {
    const f = await fixture(); await f.trust(true);
    const admitted = await f.services.resolvePluginOperation({ cwd: f.cwd });
    await writeFile(f.globalSettings, JSON.stringify({ npmCommand: ['-private-invalid-after-admission'] }));
    expect((await admitted.service.install({ ...admitted.context, scope: 'global', source: 'npm:server-admitted' })).packages).toHaveLength(1);
    const entries = await f.executions(); expect(entries).toHaveLength(1);
    expect(entries[0].executable).toBe(path.join(f.dataDir, 'bin', 'npm fake'));
    expect((await f.install('npm:server-new-admission')).status).toBe(400);
    expect((await f.services.pluginService.getCatalog({ cwd: f.cwd, refresh: true })).packages).toHaveLength(1);
    expect(await f.executions()).toEqual(entries);
  });

  it('admitted project policy refuses global install/check/update after independent persisted revocation', async () => {
    const f = await fixture(); await f.trust(true);
    await writeFile(f.projectSettings, JSON.stringify({ npmCommand: f.command }));
    const seed = await f.install('npm:server-seed'); expect(seed.status).toBe(200);
    const key = seed.body.packages[0].key;
    const statePath = path.join(f.dataDir, 'plugins.json');
    const files = [statePath, f.globalSettings, f.projectSettings, path.join(f.local, 'bin', 'npm fake')];
    const bytes = await Promise.all(files.map(file => readFile(file)));
    const entries = await f.executions();
    const admission = f.services.resolvePluginOperation.bind(f.services);
    // Real admission and Core service; only timing is controlled here. The independent
    // writer revokes AFTER settings capture, not before the request's eligibility read.
    vi.spyOn(f.services, 'resolvePluginOperation').mockImplementation(async input => {
      const operation = await admission(input);
      await f.trust(false);
      return operation;
    });
    for (const body of [
      { action: 'install', source: 'npm:server-refused', scope: 'global', projectTrusted: true },
      { action: 'update', key, scope: 'global' },
      { action: 'update', scope: 'global' },
    ]) {
      await f.trust(true);
      const result = await f.request('', body);
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    }
    await f.trust(true);
    const check = await f.request('/check', { key, scope: 'global', projectTrusted: true });
    expect(check.status).toBe(200);
    expect(check.body.updates[0]).toMatchObject({ state: 'error', message: 'Vérification impossible.' });
    expect(await f.executions()).toEqual(entries);
    expect(await Promise.all(files.map(file => readFile(file)))).toEqual(bytes);
    await noResidue(f.dataDir);
  });

  it('missing selected executable never falls back and leaves existing package/state intact', async () => {
    const f = await fixture(); await f.trust(true);
    const seed = await f.install('npm:server-seed'); const key = seed.body.packages[0].key;
    const state = await readFile(path.join(f.dataDir, 'plugins.json'), 'utf8'); const log = await readFile(f.log, 'utf8');
    await writeFile(f.projectSettings, JSON.stringify({ npmCommand: ['./private-missing', 'private-prefix'] }));
    for (const body of [{ action: 'install', scope: 'global', source: 'npm:server-failed' }, { action: 'update', key, scope: 'global' }]) {
      const failure = await f.request('', body); expect(failure.status).toBe(502);
      expect(failure.body).toEqual({ error: 'Internal server error' }); expect(JSON.stringify(failure.body)).not.toContain('private');
    }
    expect((await f.request('/check', { key })).body.updates[0]).toMatchObject({ state: 'error', message: 'Vérification impossible.' });
    expect(await readFile(f.log, 'utf8')).toBe(log); expect(await readFile(path.join(f.dataDir, 'plugins.json'), 'utf8')).toBe(state);
    await noResidue(f.dataDir);
  });

  it('restricted provider administration still refuses every package/executable operation and import', async () => {
    const f = await fixture(true);
    for (const [route, body] of [
      ['', { action: 'install', scope: 'global', source: 'npm:server-forbidden' }],
      ['', { action: 'update' }], ['/check', {}], ['/reload', {}],
    ] as const) {
      const result = await f.request(route, body); expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ code: 'PROVIDER_REFERENCE_OWNER_UNAVAILABLE' });
    }
    await expect(f.services.resolvePluginOperation({ cwd: f.cwd })).rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_OWNER_UNAVAILABLE' });
    expect(await readFile(f.log, 'utf8')).toBe('');
    // A real arbitrary extension must not be imported on restricted reload.
    const extensions = path.join(f.dataDir, 'extensions'); await mkdir(extensions);
    const marker = path.join(f.root, 'import-marker');
    await writeFile(path.join(extensions, 'forbidden.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); export default () => {};`);
    expect((await f.services.reloadResources({ cwd: f.cwd })).loadedExtensions).toEqual([]);
    expect(await readdir(f.root)).not.toContain('import-marker');
  });
});
