import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { BedrockProfileCredentials } from './bedrock-profile.js';
import type { CredentialRedactor } from './credentials.js';
export interface BedrockCredentialIdentity { fingerprint: string }
export interface BedrockVendedCredentials { credentials: BedrockProfileCredentials; expiresAt: number; region?: string }
interface Cached extends BedrockVendedCredentials { identity: string; sequence: number }
const invalid = () => new Error('Invalid AWS credential source.');
export async function bedrockCredentialFile(file: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted(); const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal.throwIfAborted(); const metadata = await handle.stat(); if (!metadata.isFile() || metadata.size > maximum) throw invalid();
    const buffer = Buffer.alloc(maximum + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); signal.throwIfAborted(); if (bytesRead > maximum) throw invalid();
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
export function bedrockVendedCredentials(body: Record<string, unknown>, redactor?: Pick<CredentialRedactor, 'add'>): BedrockVendedCredentials {
  const accessKeyId = body.AccessKeyId, secretAccessKey = body.SecretAccessKey, sessionToken = body.Token;
  for (const value of [accessKeyId, secretAccessKey, sessionToken]) if (typeof value === 'string') redactor?.add(value);
  const expiresAt = typeof body.Expiration === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(body.Expiration) ? Date.parse(body.Expiration) : NaN;
  if (typeof accessKeyId !== 'string' || !/^[A-Za-z0-9]{1,128}$/u.test(accessKeyId)
    || typeof secretAccessKey !== 'string' || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(secretAccessKey)
    || typeof sessionToken !== 'string' || !/^[A-Za-z0-9/+=]{1,61440}$/u.test(sessionToken) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw invalid();
  return { credentials: Object.freeze({ accessKeyId, secretAccessKey, sessionToken }), expiresAt };
}
/** Shared only by the two foreground AWS vending mechanisms; identity/acquisition authorities stay in each source. */
export abstract class BedrockRefreshingCredentials<T extends BedrockCredentialIdentity> {
  private cached?: Cached;
  private sequence = 0;
  constructor(private readonly errorMessage: string, private readonly lifetime?: AbortSignal, protected readonly redactor?: Pick<CredentialRedactor, 'add'>) {}
  protected abstract identity(signal: AbortSignal): Promise<T>;
  protected abstract acquire(identity: T, signal: AbortSignal): Promise<BedrockVendedCredentials>;
  invalidate(credentials: BedrockProfileCredentials, status: number): void {
    if ((status === 401 || status === 403) && this.cached?.credentials === credentials) this.cached = undefined;
  }
  async resolve(caller: AbortSignal): Promise<{ credentials: BedrockProfileCredentials; region?: string; signal: AbortSignal; assertCurrent(): Promise<void> }> {
    const signal = this.lifetime ? AbortSignal.any([caller, this.lifetime]) : caller;
    try {
      signal.throwIfAborted(); const authSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]), identity = await this.identity(authSignal);
      let cached = this.cached;
      if (!cached || cached.identity !== identity.fingerprint || cached.expiresAt <= Date.now() + 300000) {
        const sequence = ++this.sequence, result = await this.acquire(identity, authSignal);
        if ((await this.identity(authSignal)).fingerprint !== identity.fingerprint) throw invalid(); authSignal.throwIfAborted();
        cached = { ...result, identity: identity.fingerprint, sequence }; if (!this.cached || sequence > this.cached.sequence) this.cached = cached;
      }
      const admitted = cached;
      const assertCurrent = async () => {
        try { signal.throwIfAborted(); if (admitted.expiresAt <= Date.now() || (await this.identity(signal)).fingerprint !== admitted.identity) throw invalid(); signal.throwIfAborted(); }
        catch { throw new Error(this.errorMessage); }
      };
      return { credentials: admitted.credentials, ...(admitted.region ? { region: admitted.region } : {}), signal, assertCurrent };
    } catch { throw new Error(this.errorMessage); }
  }
}
