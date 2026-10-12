import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationStore, validateConfigurationValues } from './config-store.js';

const directories: string[] = [];
async function storePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-config-'));
  directories.push(directory);
  return path.join(directory, 'nested', 'configuration.json');
}
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

describe('ConfigurationStore', () => {
  it('merges scopes with explicit provenance and environment precedence', async () => {
    const store = new ConfigurationStore(await storePath());
    await store.load();
    await store.patch('global', { model: 'global-model', thinking: 'low', enabledSkills: ['a', 'a'] });
    await store.patch('project', { model: 'project-model', toolPreset: 'read-only' }, 'project-1');
    await store.patch('session', { thinking: 'high' }, 'session-1');

    expect(store.effective({
      projectId: 'project-1',
      sessionId: 'session-1',
      defaults: { provider: 'mock', model: 'default-model' },
      environment: { model: 'environment-model' },
    })).toEqual({
      values: {
        provider: 'mock', model: 'environment-model', thinking: 'high',
        enabledSkills: ['a'], toolPreset: 'read-only',
      },
      provenance: {
        provider: { value: 'mock', scope: 'default', source: 'built-in' },
        model: { value: 'environment-model', scope: 'environment', source: 'environment' },
        thinking: { value: 'high', scope: 'session', source: 'session-1' },
        enabledSkills: { value: ['a'], scope: 'global', source: 'global' },
        toolPreset: { value: 'read-only', scope: 'project', source: 'project-1' },
      },
    });
  });

  it('removes an explicit value with null so the lower scope is inherited', async () => {
    const store = new ConfigurationStore(await storePath());
    await store.load();
    await store.patch('global', { model: 'global-model' });
    await store.patch('project', { model: 'project-model', toolPreset: 'full' }, 'project-1');
    await store.patch('project', { model: null }, 'project-1');

    expect(store.get('project', 'project-1')).toEqual({ toolPreset: 'full' });
    expect(store.effective({ projectId: 'project-1' }).provenance.model).toEqual({
      value: 'global-model', scope: 'global', source: 'global',
    });
    await expect(store.patch('global', { apiToken: null })).rejects.toThrow(/inconnue/i);
  });

  it('serializes concurrent atomic updates and reloads the complete final state', async () => {
    const file = await storePath();
    const store = new ConfigurationStore(file);
    await store.load();
    await Promise.all([
      store.patch('global', { provider: 'mock' }),
      store.patch('project', { model: 'project-model' }, 'project-1'),
      store.patch('session', { toolPreset: 'full' }, 'session-1'),
    ]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, 'utf8')).trim().endsWith('}')).toBe(true);

    const reloaded = new ConfigurationStore(file);
    await reloaded.load();
    expect(reloaded.get('global')).toEqual({ provider: 'mock' });
    expect(reloaded.get('project', 'project-1')).toEqual({ model: 'project-model' });
    expect(reloaded.get('session', 'session-1')).toEqual({ toolPreset: 'full' });
  });

  it('merges independent default saves across stale store instances without clobbering keys', async () => {
    const file = await storePath();
    const first = new ConfigurationStore(file);
    const second = new ConfigurationStore(file);
    await Promise.all([first.load(), second.load()]);
    await first.patch('global', { provider: 'mock', model: 'old', thinking: 'minimal', toolPreset: 'read-only' });
    await Promise.all([first.patch('global', { model: 'new' }), second.patch('global', { thinking: 'high' })]);
    const reloaded = new ConfigurationStore(file);
    await reloaded.load();
    expect(reloaded.get('global')).toEqual({ provider: 'mock', model: 'new', thinking: 'high', toolPreset: 'read-only' });
  });

  it('applies relative changes to fresh inherited arrays without leaking callback mutations', async () => {
    const file = await storePath();
    const first = new ConfigurationStore(file);
    const second = new ConfigurationStore(file);
    await Promise.all([first.load(), second.load()]);
    await first.patch('global', { model: 'global-model', enabledModels: ['mock:a', 'mock:b'] });
    await Promise.all([
      first.update('project', (target, base) => {
        base.model = 'must-not-leak';
        return { ...target, enabledModels: (target.enabledModels ?? base.enabledModels ?? []).filter(key => key !== 'mock:a') };
      }, 'project-1'),
      second.update('project', (target, base) => ({ ...target,
        enabledModels: [...(target.enabledModels ?? base.enabledModels ?? []), 'mock:c'] }), 'project-1'),
    ]);
    await first.load();
    expect(first.get('global')).toEqual({ model: 'global-model', enabledModels: ['mock:a', 'mock:b'] });
    expect(first.get('project', 'project-1')).toEqual({ enabledModels: ['mock:b', 'mock:c'] });
    await expect(first.update('global', () => JSON.parse('{"thinking":"invalid"}'))).rejects.toMatchObject({ status: 400 });
    expect(first.get('global').model).toBe('global-model');
  });

  it('does not publish no-op writes or create empty scopes', async () => {
    const file = await storePath();
    const store = new ConfigurationStore(file);
    await store.load();
    await store.update('project', target => target, 'project-1');
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.patch('global', { model: 'unchanged' });
    const before = await stat(file);
    const source = await readFile(file, 'utf8');
    await store.update('global', target => target);
    expect((await stat(file)).ino).toBe(before.ino);
    expect(await readFile(file, 'utf8')).toBe(source);
  });

  it('refuses to replace unreadable settings and keeps the last committed memory unchanged', async () => {
    const file = await storePath();
    const store = new ConfigurationStore(file);
    await store.load();
    await store.patch('global', { model: 'committed', thinking: 'low' });
    for (const broken of ['{broken', '{"version":2}', '{"version":1,"global":{"thinking":"invalid"}}',
      '{"version":1,"projects":[]}', '{"version":1,"unexpected":"preserve-me"}']) {
      await writeFile(file, broken);
      await expect(store.patch('global', { thinking: 'high' })).rejects.toMatchObject({ code: 'CONFIGURATION_UNREADABLE' });
      expect(await readFile(file, 'utf8')).toBe(broken);
      expect(store.get('global')).toEqual({ model: 'committed', thinking: 'low' });
    }
  });

  it('never publishes a scoped record that its bounded reader would refuse', async () => {
    const file = await storePath();
    await mkdir(path.dirname(file), { recursive: true });
    const source = JSON.stringify({ version: 1, global: { thinking: 'low' },
      projects: Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`project-${index}`, {}])), sessions: {} });
    await writeFile(file, source);
    const store = new ConfigurationStore(file);
    await store.load();
    await expect(store.patch('project', { model: 'must-not-publish' }, 'overflow'))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CONFIGURATION' });
    expect(await readFile(file, 'utf8')).toBe(source);
    expect(store.get('project', 'overflow')).toEqual({});
    await store.patch('global', { thinking: 'high' });
    await store.load();
    expect(store.get('global').thinking).toBe('high');
  });

  it('rejects linked and over-budget settings without following or overwriting them', async () => {
    const file = await storePath();
    await mkdir(path.dirname(file), { recursive: true });
    const outside = path.join(path.dirname(file), 'outside.json');
    await writeFile(outside, '{"version":1,"global":{"thinking":"low"}}');
    await symlink(outside, file);
    const store = new ConfigurationStore(file);
    await expect(store.load()).rejects.toMatchObject({ code: 'CONFIGURATION_UNREADABLE' });
    expect(await readFile(outside, 'utf8')).toContain('low');
    await rm(file);
    await writeFile(file, ' '.repeat(4 * 1024 * 1024 + 1));
    await expect(store.load()).rejects.toMatchObject({ code: 'CONFIGURATION_UNREADABLE' });
  });

  it('rejects prototype/control scope selectors and invalid reasoning without changing defaults', async () => {
    const store = new ConfigurationStore(await storePath());
    await store.load();
    await store.patch('global', { model: 'unchanged', thinking: 'low' });
    for (const id of ['__proto__', 'constructor', 'prototype', 'bad\u0000id']) {
      await expect(store.patch('project', { model: 'polluted' }, id)).rejects.toMatchObject({ status: 400 });
    }
    await expect(store.patch('global', { thinking: 'unlimited' })).rejects.toMatchObject({ status: 400 });
    expect(store.get('global')).toEqual({ model: 'unchanged', thinking: 'low' });
  });

  it('rejects unknown keys, malformed values, and every secret-shaped key', () => {
    expect(() => validateConfigurationValues({ apiKey: 'secret' })).toThrow(/secrets/i);
    expect(() => validateConfigurationValues({ session_token: 'secret' })).toThrow(/secrets/i);
    expect(() => validateConfigurationValues({ unknown: true })).toThrow(/inconnue/i);
    expect(() => validateConfigurationValues(Promise.resolve({ model: 'must-not-clear' }))).toThrow(/invalide/i);
    expect(() => validateConfigurationValues(new Date())).toThrow(/invalide/i);
    expect(() => validateConfigurationValues({ thinking: 'unlimited' })).toThrow(/réflexion/i);
    expect(() => validateConfigurationValues({ enabledPlugins: [42] })).toThrow(/invalide/i);
  });
});
