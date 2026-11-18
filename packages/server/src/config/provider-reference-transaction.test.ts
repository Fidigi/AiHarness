import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationStore } from './config-store.js';
import { ProviderRegistryService } from '../runtime/provider-registry.js';
import { AiProxyServer } from '../api/proxy.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-reference-')); roots.push(root);
  const file = path.join(root, 'config.json');
  const store = new ConfigurationStore(file); await store.load();
  return { root, file, store };
}

describe('whole-file provider reference transaction', () => {
  it('rebinds fresh global/project/session qualified references, never bare IDs or inheritance', async () => {
    const { file, store } = await fixture();
    const other = new ConfigurationStore(file); await other.load();
    await other.patch('global', { provider: 'acme', model: 'acme:org:model', enabledModels: ['acme:a', 'bare', 'other:acme:a'], systemPrompt: 'acme:a' });
    await other.patch('project', { model: 'bare', enabledModels: ['acme:b'] }, 'p');
    await other.patch('session', { provider: 'other', model: 'acme:c', thinking: 'high' }, 's');
    const commit = vi.fn(async () => {
      expect(JSON.parse(await readFile(file, 'utf8')).global.provider).toBe('renamed');
    });
    await store.rebindProvider('acme', 'renamed', commit);
    await store.finishProviderRebind();
    await new ConfigurationStore(file).load();
    expect(commit).toHaveBeenCalledOnce();
    expect(store.get('global')).toEqual({ provider: 'renamed', model: 'renamed:org:model', enabledModels: ['renamed:a', 'bare', 'other:acme:a'], systemPrompt: 'acme:a' });
    expect(store.get('project', 'p')).toEqual({ model: 'bare', enabledModels: ['renamed:b'] });
    expect(store.get('project', 'absent')).toEqual({});
    expect(store.get('session', 's')).toEqual({ provider: 'other', model: 'renamed:c', thinking: 'high' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  it('keeps exact no-ops byte/inode stable and calls the callback once', async () => {
    const { file, store } = await fixture();
    const commit = vi.fn(async () => undefined);
    await store.rebindProvider('acme', 'acme', commit);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${file}.provider-intent.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.patch('global', { provider: 'other', model: 'bare' });
    const before = await stat(file); const source = await readFile(file, 'utf8');
    await store.rebindProvider('acme', 'renamed', commit);
    expect(await readFile(file, 'utf8')).toBe(source); expect((await stat(file)).ino).toBe(before.ino);
    expect(commit).toHaveBeenCalledTimes(2);
  });
  it('restores exact prior bytes on callback failure and quarantines even a rolled-back intent', async () => {
    const { file, store } = await fixture(); await store.patch('global', { provider: 'acme' });
    const before = await readFile(file, 'utf8');
    await expect(store.rebindProvider('acme', 'renamed', async () => { throw new Error('registry failed'); })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
    const restarted = new ConfigurationStore(file);
    await expect(restarted.load()).rejects.toMatchObject({ code: 'PROVIDER_TRANSACTION_QUARANTINED', uncertain: true });
    await expect(store.patch('global', { thinking: 'high' })).rejects.toMatchObject({ code: 'PROVIDER_TRANSACTION_QUARANTINED' });
  });
  it('refuses rollback over intervening writes including identical-byte replacement (ABA)', async () => {
    for (const identical of [false, true]) {
      const { file, store } = await fixture(); await store.patch('global', { provider: 'acme' });
      let external = '';
      await expect(store.rebindProvider('acme', 'renamed', async () => {
        external = identical ? await readFile(file, 'utf8') : JSON.stringify({ version: 1, global: { model: 'external' }, projects: {}, sessions: {} });
        const { rename } = await import('node:fs/promises');
        await writeFile(`${file}.external`, external); await rename(`${file}.external`, file);
        throw new Error('failed');
      })).rejects.toMatchObject({ code: 'PROVIDER_RENAME_UNCERTAIN', uncertain: true });
      expect(await readFile(file, 'utf8')).toBe(external);
    }
  });
  it('quarantines a successful callback if an external config writer intervened', async () => {
    const { file, store } = await fixture(); await store.patch('global', { provider: 'acme' });
    await expect(store.rebindProvider('acme', 'renamed', async () => {
      await writeFile(file, '{"version":1,"global":{"model":"external"}}');
    })).rejects.toMatchObject({ uncertain: true });
    expect(await readFile(file, 'utf8')).toContain('external');
  });
  it('refuses unreadable schema and unsafe journals before callback or writes', async () => {
    const { file, store } = await fixture(); const commit = vi.fn(async () => undefined);
    await writeFile(file, '{"version":1,"global":{"modelThinkingLevels":{}}}');
    await expect(store.rebindProvider('acme', 'renamed', commit)).rejects.toMatchObject({ code: 'CONFIGURATION_UNREADABLE' });
    expect(commit).not.toHaveBeenCalled();
    await writeFile(`${file}.provider-intent.json`, ' '.repeat(2049));
    await expect(store.load()).rejects.toMatchObject({ code: 'PROVIDER_TRANSACTION_QUARANTINED' });
  });
  it('holds pathname serialization until the awaited callback actually settles', async () => {
    const { file, store } = await fixture(); await store.patch('global', { provider: 'acme' });
    const other = new ConfigurationStore(file); await other.load();
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    const rename = store.rebindProvider('acme', 'renamed', async () => { enter(); await pending; });
    await entered;
    const patch = expect(other.patch('global', { thinking: 'high' })).rejects.toMatchObject({ code: 'PROVIDER_TRANSACTION_QUARANTINED' });
    release(); await rename; await patch;
    // Even after the callback, the pending intent protects the registry's
    // outer rollback/reconciliation window until the host success handshake.
    await store.finishProviderRebind(); await store.load();
    expect(store.get('global')).toEqual({ provider: 'renamed' });
  });
  it('validates expanded string/file bounds before writing an intent or invoking commit', async () => {
    const { file, store } = await fixture();
    await store.patch('global', { enabledModels: [`ab:${'x'.repeat(497)}`] });
    const before = await readFile(file, 'utf8'); const commit = vi.fn(async () => undefined);
    await expect(store.rebindProvider('ab', 'destination', commit)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(commit).not.toHaveBeenCalled(); expect(await readFile(file, 'utf8')).toBe(before);
    await expect(stat(`${file}.provider-intent.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses rollback over a real external process write', async () => {
    const { file, store } = await fixture(); await store.patch('global', { provider: 'acme' });
    const external = '{"version":1,"global":{"model":"external-process"}}';
    await expect(store.rebindProvider('acme', 'renamed', async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { writeFile } from 'node:fs/promises';
        await writeFile(${JSON.stringify(file)}, ${JSON.stringify(external)});
      `]);
      const [code] = await once(child, 'exit'); expect(code).toBe(0);
      throw new Error('registry failed');
    })).rejects.toMatchObject({ code: 'PROVIDER_RENAME_UNCERTAIN', uncertain: true });
    expect(await readFile(file, 'utf8')).toBe(external);
  });
  it.each(['before-registry', 'after-registry', 'after-registry-return', 'before-registry-rollback'])('real SIGKILL %s leaves durable quarantine on restart', async stage => {
    const { root, file, store } = await fixture(); await store.patch('global', { provider: 'acme' });
    // Build ONLY the server in the Docker validation command; Node runs real emitted code.
    const moduleUrl = new URL('../../dist/config/config-store.js', import.meta.url).href;
    const registry = path.join(root, 'providers.json');
    const registryModule = new URL('../../dist/runtime/provider-registry.js', import.meta.url).href;
    const proxyModule = new URL('../../dist/api/proxy.js', import.meta.url).href;
    const service = new ProviderRegistryService(registry, new AiProxyServer(), path.join(root, 'secrets.enc'));
    await service.load();
    await service.upsertProvider({ id: 'acme', name: 'Acme', baseUrl: 'http://127.0.0.1:1', dialect: 'openai-completions' });
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { ConfigurationStore } from ${JSON.stringify(moduleUrl)};
      import { ProviderRegistryService } from ${JSON.stringify(registryModule)};
      import { AiProxyServer } from ${JSON.stringify(proxyModule)};
      const store = new ConfigurationStore(${JSON.stringify(file)}); await store.load();
      const registry = new ProviderRegistryService(${JSON.stringify(registry)}, new AiProxyServer(), ${JSON.stringify(path.join(root, 'secrets.enc'))});
      await registry.load();
      const hold = async () => { process.stdout.write('READY\\n'); await new Promise(() => { setInterval(() => {}, 1000); }); };
      await registry.renameProvider('acme', 'renamed', registry.getRevision(), async commit => {
        try {
          await store.rebindProvider('acme', 'renamed', async () => {
            ${stage === 'before-registry' ? 'await hold();' : ''}
            await commit();
            ${stage === 'after-registry' ? 'await hold();' : ''}
            ${stage === 'before-registry-rollback' ? 'throw new Error("injected failure");' : ''}
          });
        } catch (error) {
          ${stage === 'before-registry-rollback' ? 'await hold();' : ''}
          throw error;
        }
      });
      ${stage === 'after-registry-return' ? 'await hold();' : ''}
      await store.finishProviderRebind();
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', chunk => { if (String(chunk).includes('READY')) resolve(); });
      child.once('exit', code => reject(new Error(`child exited ${code}: ${stderr}`)));
    });
    try { await ready; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    finally { if (child.exitCode === null) child.kill('SIGKILL'); }
    expect(JSON.parse(await readFile(file, 'utf8')).global.provider).toBe(stage === 'before-registry-rollback' ? 'acme' : 'renamed');
    expect(JSON.parse(await readFile(registry, 'utf8')).providers[0].id).toBe(stage === 'before-registry' ? 'acme' : 'renamed');
    await expect(new ConfigurationStore(file).load()).rejects.toMatchObject({ code: 'PROVIDER_TRANSACTION_QUARANTINED', uncertain: true });
  }, 15_000);
});

it.each([
  { scope: 'global', values: { provider: 'ACME' } },
  { scope: 'project', values: { provider: ' acme ' } },
  { scope: 'session', values: { model: 'ACME:org:model' } },
  { scope: 'global', values: { enabledModels: ['ACME:a', 'bare'] } },
  { scope: 'global', values: { model: 'acme/org:model' } },
] as const)('refuses non-canonical scoped aliases before intent or callback ($scope/$values)', async ({ scope, values }) => {
  const { file, store } = await fixture();
  await store.patch(scope, { ...values, ...('enabledModels' in values ? { enabledModels: [...values.enabledModels] } : {}) }, scope === 'global' ? undefined : 'scope-id');
  const before = await readFile(file, 'utf8');
  const commit = vi.fn(async () => undefined);
  await expect(store.rebindProvider('acme', 'renamed', commit)).rejects.toMatchObject({ status: 409, code: 'PROVIDER_UNSUPPORTED_REFERENCES', uncertain: false });
  expect(commit).not.toHaveBeenCalled();
  expect(await readFile(file, 'utf8')).toBe(before);
  await expect(readFile(file + '.provider-intent.json')).rejects.toMatchObject({ code: 'ENOENT' });
  await store.assertProviderTransactionSafe();
});
