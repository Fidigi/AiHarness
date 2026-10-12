import { afterEach, describe, expect, it } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CredentialStoreError, EncryptedCredentialStore } from './credential-store.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-core-credentials-'));
  temporaryDirectories.push(directory);
  return { directory, filePath: path.join(directory, 'credentials.enc') };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('EncryptedCredentialStore', () => {
  it('encrypts values, publishes only names, and uses owner-only atomic files', async () => {
    const { directory, filePath } = await fixture();
    const store = new EncryptedCredentialStore(filePath, 'correct horse battery staple');
    await store.set('Provider:OpenAI', 'short-secret');

    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).not.toContain('short-secret');
    expect(persisted).not.toContain('openai');
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(store.list()).toEqual(['provider:openai']);

    const reloaded = new EncryptedCredentialStore(filePath, 'correct horse battery staple');
    await reloaded.load();
    expect(reloaded.get('provider:openai')).toBe('short-secret');
    expect(await reloaded.delete('provider:openai')).toBe(true);
    expect(await reloaded.delete('provider:openai')).toBe(false);
    await reloaded.update({
      'provider:openai': 'replacement-secret',
      'provider:headers': 'header-secret',
    });
    await reloaded.update({ 'provider:openai': undefined, 'provider:other': 'other-secret' });
    expect(reloaded.get('provider:openai')).toBeUndefined();
    expect(reloaded.get('provider:headers')).toBe('header-secret');
    expect(reloaded.get('provider:other')).toBe('other-secret');
  });

  it('merges concurrent writers under the shared lock', async () => {
    const { filePath } = await fixture();
    const first = new EncryptedCredentialStore(filePath, 'correct horse battery staple');
    const second = new EncryptedCredentialStore(filePath, 'correct horse battery staple');

    await Promise.all([
      first.set('provider:first', 'first-secret'),
      second.set('provider:second', 'second-secret'),
    ]);

    const reloaded = new EncryptedCredentialStore(filePath, 'correct horse battery staple');
    await reloaded.load();
    expect(reloaded.list()).toEqual(['provider:first', 'provider:second']);
    expect(reloaded.get('provider:first')).toBe('first-secret');
    expect(reloaded.get('provider:second')).toBe('second-secret');
  });

  it('compares and swaps against fresh encrypted state across store instances', async () => {
    const { filePath } = await fixture();
    const first = new EncryptedCredentialStore(filePath, 'correct horse battery staple');
    await first.set('mcp-oauth:key', 'original');
    const stale = new EncryptedCredentialStore(filePath, 'correct horse battery staple');
    await stale.load();

    await expect(first.compareAndSet('mcp-oauth:key', 'original', 'winner')).resolves.toBe(true);
    await expect(stale.compareAndSet('mcp-oauth:key', 'original', 'loser')).resolves.toBe(false);
    await expect(stale.compareAndSet('mcp-oauth:key', 'wrong', undefined)).resolves.toBe(false);

    const reloaded = new EncryptedCredentialStore(filePath, 'correct horse battery staple');
    await reloaded.load();
    expect(reloaded.get('mcp-oauth:key')).toBe('winner');
    await expect(reloaded.compareAndSet('mcp-oauth:key', 'winner', undefined)).resolves.toBe(true);
    await expect(reloaded.compareAndSet('mcp-oauth:new', undefined, 'created')).resolves.toBe(true);
    expect(reloaded.get('mcp-oauth:key')).toBeUndefined();
    expect(reloaded.get('mcp-oauth:new')).toBe('created');
  });

  it('fails closed for weak keys, links, corruption, hard links, and oversized sources', async () => {
    const { directory, filePath } = await fixture();
    expect(() => new EncryptedCredentialStore(filePath, 'short')).toThrow(CredentialStoreError);

    const target = path.join(directory, 'target');
    await writeFile(target, '{}');
    await symlink(target, filePath);
    await expect(new EncryptedCredentialStore(filePath, 'correct horse battery staple').load())
      .rejects.toMatchObject({ code: 'unsafe-store' });

    await rm(filePath);
    await writeFile(filePath, '{"not":"encrypted"}', { mode: 0o600 });
    await expect(new EncryptedCredentialStore(filePath, 'correct horse battery staple').load())
      .rejects.toMatchObject({ code: 'invalid-store' });

    await writeFile(filePath, 'x'.repeat(1_025));
    await expect(new EncryptedCredentialStore(filePath, 'correct horse battery staple', { maxBytes: 1_024 }).load())
      .rejects.toMatchObject({ code: 'store-too-large' });
    await chmod(filePath, 0o644);
    await expect(new EncryptedCredentialStore(filePath, 'correct horse battery staple').load())
      .rejects.toMatchObject({ code: 'unsafe-store' });

    await rm(filePath);
    const valid = new EncryptedCredentialStore(filePath, 'correct horse battery staple');
    await valid.set('openai', 'private');
    const hardLink = path.join(directory, 'hard-link.enc');
    await link(filePath, hardLink);
    await expect(new EncryptedCredentialStore(hardLink, 'correct horse battery staple').load())
      .rejects.toMatchObject({ code: 'unsafe-store' });

    const realParent = path.join(directory, 'real-parent');
    const linkedParent = path.join(directory, 'linked-parent');
    await mkdir(realParent);
    await symlink(realParent, linkedParent, 'dir');
    const linkedParentStore = new EncryptedCredentialStore(
      path.join(linkedParent, 'credentials.enc'),
      'correct horse battery staple',
    );
    await expect(linkedParentStore.load()).rejects.toMatchObject({ code: 'unsafe-store' });
    await expect(linkedParentStore.set('openai', 'private')).rejects.toMatchObject({ code: 'unsafe-store' });

    const lockedPath = path.join(directory, 'locked.enc');
    const lockTarget = path.join(directory, 'lock-target');
    await writeFile(lockTarget, 'unsafe');
    await symlink(lockTarget, `${lockedPath}.lock`);
    await expect(new EncryptedCredentialStore(
      lockedPath,
      'correct horse battery staple',
    ).set('openai', 'private')).rejects.toMatchObject({ code: 'unsafe-store' });
  });

  it('never includes stored values or key material in decryption errors', async () => {
    const { filePath } = await fixture();
    const secret = 'tiny';
    const store = new EncryptedCredentialStore(filePath, 'correct horse battery staple');
    await store.set('openai', secret);

    const wrong = new EncryptedCredentialStore(filePath, 'different master key value');
    let failure: unknown;
    try { await wrong.load(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'invalid-store' });
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain('different master key value');
  });
});
