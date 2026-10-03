import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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

  it('rejects unknown keys, malformed values, and every secret-shaped key', () => {
    expect(() => validateConfigurationValues({ apiKey: 'secret' })).toThrow(/secrets/i);
    expect(() => validateConfigurationValues({ session_token: 'secret' })).toThrow(/secrets/i);
    expect(() => validateConfigurationValues({ unknown: true })).toThrow(/inconnue/i);
    expect(() => validateConfigurationValues({ thinking: 'unlimited' })).toThrow(/réflexion/i);
    expect(() => validateConfigurationValues({ enabledPlugins: [42] })).toThrow(/invalide/i);
  });
});
