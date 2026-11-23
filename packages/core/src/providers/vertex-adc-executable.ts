import path from 'node:path';
import { executeProcess } from '../tools/process-execution.js';
import type { CredentialRedactor } from './credentials.js';
const failure = () => new Error('Vertex ADC authentication failed.');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safe = (value: unknown, max: number): value is string => typeof value === 'string' && !!value && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export interface VertexExecutable { command: string; parts: string[]; timeout: number; outputFile?: string }
/** Caller permission is checked before this descriptor is admitted; no file/command can grant it. */
export function vertexExecutable(value: unknown): VertexExecutable {
  if (!record(value) || Object.keys(value).some(key => !['command', 'timeout_millis', 'output_file'].includes(key)) || !safe(value.command, 8192)
    || (value.command.match(/"/gu)?.length ?? 0) % 2 !== 0 || value.output_file !== undefined && !safe(value.output_file, 4096)) throw failure();
  const timeout = value.timeout_millis ?? 30000;
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 5000 || timeout > 120000) throw failure();
  // Match the reference's double-quoted direct argv contract, not shell expansion.
  const parts = value.command.match(/(?:[^\s"]+|"[^"]*")+/gu)?.map(part => part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part);
  if (!parts?.length || !parts[0]) throw failure();
  return { command: value.command, parts, timeout: Math.min(timeout, 15000), ...(value.output_file !== undefined ? { outputFile: path.resolve(value.output_file) } : {}) };
}
export function vertexExecutableSubject(bytes: Buffer, type: string, outputFile: boolean, redactor?: Pick<CredentialRedactor, 'add'>, cached = false): string | undefined {
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes), data: unknown = JSON.parse(raw);
  if (!record(data) || data.version !== 1 || typeof data.success !== 'boolean') throw failure();
  if (!data.success) { if (cached && safe(data.code, 4096) && safe(data.message, 65536)) return undefined; throw failure(); }
  if (data.token_type !== type || outputFile && data.expiration_time === undefined || data.expiration_time !== undefined
    && (typeof data.expiration_time !== 'number' || !Number.isSafeInteger(data.expiration_time) || data.expiration_time < 1)) throw failure();
  const token = type.endsWith(':saml2') ? data.saml_response : data.id_token;
  if (typeof token !== 'string' || !token.trim() || Buffer.byteLength(token) > 65536 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(token)) throw failure();
  redactor?.add(token);
  if (typeof data.expiration_time === 'number' && data.expiration_time <= Date.now() / 1000) { if (cached) return undefined; throw failure(); }
  return token;
}
/** Foreground direct execution with filtered inheritance and only the validated Google protocol environment. */
export async function runVertexExecutable(recipe: VertexExecutable, type: string, audience: string, email: string | undefined, signal: AbortSignal, redactor?: Pick<CredentialRedactor, 'add'>): Promise<string> {
  let output = '', bytes = 0;
  const result = await executeProcess({ executable: recipe.parts[0]!, args: recipe.parts.slice(1), cwd: process.cwd(), signal, detached: true,
    timeoutMs: recipe.timeout, maxCaptureBytes: 128 * 1024,
    environment: { GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE: audience, GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE: type, GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE: '0',
      GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE: recipe.outputFile, GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL: email, GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: undefined },
    onOutput(chunk, stream) { if ((bytes += Buffer.byteLength(chunk)) > 128 * 1024 || stream === 'stdout' && chunk.includes('\uFFFD')) throw failure(); if (stream === 'stdout') output += chunk; } });
  if (result.exitCode !== 0 || result.timedOut || result.captureTruncated) throw failure(); signal.throwIfAborted();
  return vertexExecutableSubject(Buffer.from(output), type, !!recipe.outputFile, redactor)!;
}
