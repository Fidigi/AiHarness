import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const scrypt = promisify(scryptCallback);

interface EncryptedDocument {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/** AES-256-GCM credential persistence protected by an operator master key. */
export class EncryptedCredentialStore {
  private credentials: Record<string, string> = {};
  private loaded = false;

  constructor(private readonly filePath: string, private readonly masterKey: string) {
    if (masterKey.length < 16) throw new Error('AI_HARNESS_MASTER_KEY doit contenir au moins 16 caractères.');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const document = JSON.parse(await readFile(this.filePath, 'utf8')) as EncryptedDocument;
      const salt = Buffer.from(document.salt, 'base64');
      const key = await scrypt(this.masterKey, salt, 32) as Buffer;
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(document.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(document.tag, 'base64'));
      const clear = Buffer.concat([
        decipher.update(Buffer.from(document.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      this.credentials = JSON.parse(clear) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get(name: string): string | undefined {
    return this.credentials[name];
  }

  list(): string[] {
    return Object.keys(this.credentials).sort();
  }

  async set(name: string, value: string): Promise<void> {
    await this.load();
    this.credentials[name] = value;
    await this.save();
  }

  async delete(name: string): Promise<boolean> {
    await this.load();
    if (!(name in this.credentials)) return false;
    delete this.credentials[name];
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await scrypt(this.masterKey, salt, 32) as Buffer;
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(this.credentials), 'utf8'),
      cipher.final(),
    ]);
    const document: EncryptedDocument = {
      version: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(document), { mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
