import { executeProcess } from '../tools/process-execution.js';
import type { CredentialRedactor } from './credentials.js';
import type { BedrockVendedCredentials } from './bedrock-credentials.js';
const failure = () => new Error('Bedrock profile authentication failed.');
const MAX_OUTPUT = 128 * 1024;
export const validBedrockProcessCommand = (value: unknown): value is string => typeof value === 'string' && !!value && Buffer.byteLength(value) <= 8192 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
/** Only an already-authorized profile caller may invoke this foreground helper. Never logs raw output. */
export async function executeBedrockCredentialProcess(command: string, signal: AbortSignal, redactor?: Pick<CredentialRedactor, 'add'>): Promise<BedrockVendedCredentials> {
  let output = '', bytes = 0;
  const windows = process.platform === 'win32';
  const result = await executeProcess({ executable: windows ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh',
    args: windows ? ['/d', '/s', '/c', command] : ['-c', command], cwd: process.cwd(), signal, timeoutMs: 15000,
    detached: true, maxCaptureBytes: MAX_OUTPUT, onOutput(chunk, stream) {
      if ((bytes += Buffer.byteLength(chunk)) > MAX_OUTPUT || stream === 'stdout' && chunk.includes('\uFFFD')) throw failure();
      if (stream === 'stdout') output += chunk;
    } });
  if (result.exitCode !== 0 || result.captureTruncated || result.timedOut) throw failure();
  signal.throwIfAborted();
  const value: unknown = JSON.parse(output); if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  const data = value as Record<string, unknown>, accessKeyId = data.AccessKeyId, secretAccessKey = data.SecretAccessKey, sessionToken = data.SessionToken;
  for (const value of [accessKeyId, secretAccessKey, sessionToken]) if (typeof value === 'string') redactor?.add(value);
  const expiresAt = data.Expiration === undefined ? Number.MAX_SAFE_INTEGER : typeof data.Expiration === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(data.Expiration) ? Date.parse(data.Expiration) : NaN;
  if (data.Version !== 1 || typeof accessKeyId !== 'string' || !/^[A-Za-z0-9]{1,128}$/u.test(accessKeyId)
    || typeof secretAccessKey !== 'string' || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(secretAccessKey)
    || sessionToken !== undefined && (typeof sessionToken !== 'string' || !/^[A-Za-z0-9/+=]{1,61440}$/u.test(sessionToken))
    || data.CredentialScope !== undefined && typeof data.CredentialScope !== 'string' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw failure();
  return { credentials: Object.freeze({ accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }), expiresAt };
}
