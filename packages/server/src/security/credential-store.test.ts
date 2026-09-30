import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { EncryptedCredentialStore } from './credential-store';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(item => rm(item, { recursive: true, force: true }))));

describe('EncryptedCredentialStore', () => {
  it('encrypts credentials at rest and reloads them with the master key', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-credentials-'));
    directories.push(directory);
    const filePath = path.join(directory, 'credentials.enc');
    const store = new EncryptedCredentialStore(filePath, 'master-key-long-enough');

    await store.set('openai', 'sk-secret-value');

    expect(await readFile(filePath, 'utf8')).not.toContain('sk-secret-value');
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    const reloaded = new EncryptedCredentialStore(filePath, 'master-key-long-enough');
    await reloaded.load();
    expect(reloaded.get('openai')).toBe('sk-secret-value');
    expect(await reloaded.delete('openai')).toBe(true);
  });

  it('rejects weak master keys', () => {
    expect(() => new EncryptedCredentialStore('/tmp/test', 'short')).toThrow('16 caractères');
  });
});
