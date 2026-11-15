import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { BedrockProviderConfig } from './index.js';
import path from 'node:path';
import type { CredentialRedactor } from './credentials.js';

/** Explicit trusted INI files only. Native hosts own environment/default-path admission. */
export interface BedrockProfileConfig {
  profile: string;
  credentialsFile?: string;
  configFile?: string;
  signal?: AbortSignal;
  redactor?: Pick<CredentialRedactor, 'add'>;
}
export interface BedrockProfileCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
const failure = () => new Error('Bedrock profile authentication failed.');
const MAX_FILE = 256 * 1024;
const safePath = (value: unknown): value is string => typeof value === 'string' && !!value && Buffer.byteLength(value) <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

/** Auth-header intent must be checked before common header filtering. */
export function hasBedrockAuthHeaders(config: object): boolean {
  try {
    const slot = Object.getOwnPropertyDescriptor(config, 'customHeaders'); if (!slot) return false; if (!('value' in slot)) return true;
    if (!slot.value || typeof slot.value !== 'object') return false;
    return Object.getOwnPropertyNames(slot.value).some(name => {
      if (!['authorization', 'x-amz-security-token'].includes(name.toLowerCase())) return false;
      const value = Object.getOwnPropertyDescriptor(slot.value, name); return !value || !('value' in value) || typeof value.value === 'string' && !!value.value.trim();
    });
  } catch { return true; }
}

async function bytes(file: string | undefined, signal: AbortSignal): Promise<Buffer | undefined> {
  if (!file) return undefined;
  signal.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw failure(); });
  if (!handle) return undefined;
  try {
    signal.throwIfAborted(); const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_FILE) throw failure();
    const buffer = Buffer.alloc(MAX_FILE + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); signal.throwIfAborted(); if (bytesRead > MAX_FILE) throw failure();
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
function section(input: Buffer | undefined, name: string): Record<string, string> {
  const selected: Record<string, string> = Object.create(null); if (!input) return selected;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(input); let active = false;
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim(); if (!value || /^[#;]/u.test(value)) continue;
    const header = /^\[([^\[\]\r\n]+)\]$/u.exec(value); if (header) { active = header[1].trim() === name; continue; }
    if (!active) continue;
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(value); if (!pair) throw failure();
    const key = pair[1].toLowerCase(); if (Object.hasOwn(selected, key)) throw failure(); selected[key] = pair[2];
  }
  return selected;
}
const same = (left: Buffer | undefined, right: Buffer | undefined) => left === undefined ? right === undefined : right !== undefined && left.equals(right);

/** Trusted native-host admission: named profile plus bounded existing INI metadata, never file contents. */
export async function resolveBedrockProfileEnvironment(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<BedrockProviderConfig | undefined> {
  signal?.throwIfAborted();
  const profile = env.AWS_PROFILE;
  if (!profile || profile !== profile.trim() || Buffer.byteLength(profile) > 128 || /[\u0000-\u001f\u007f-\u009f\[\]]/u.test(profile)
    || env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return undefined;
  const home = env.HOME || homedir(), credentialsFile = env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws', 'credentials'), configFile = env.AWS_CONFIG_FILE || path.join(home, '.aws', 'config');
  if (!safePath(credentialsFile) || !safePath(configFile)) return undefined;
  const files = [path.resolve(credentialsFile), path.resolve(configFile)]; let present = false;
  for (const file of files) {
    const metadata = await stat(file).catch(() => undefined); signal?.throwIfAborted();
    if (!metadata) continue;
    if (!metadata.isFile() || metadata.size > MAX_FILE) return undefined;
    present = true;
  }
  return present ? { type: 'bedrock', model: env.BEDROCK_MODEL, baseUrl: env.BEDROCK_BASE_URL, region: env.AWS_REGION || env.AWS_DEFAULT_REGION,
    bedrockProfile: { profile, credentialsFile: files[0], configFile: files[1], signal } } : undefined;
}

/** No token cache/store, ambient scans, process execution or network. Each call binds both current file bytes. */
export class BedrockProfile {
  private readonly profile: string;
  private readonly credentialsFile?: string;
  private readonly configFile?: string;
  private readonly lifetime?: AbortSignal;
  private readonly redactor?: Pick<CredentialRedactor, 'add'>;
  constructor(config: BedrockProfileConfig) {
    if (typeof config.profile !== 'string' || !config.profile || config.profile !== config.profile.trim() || Buffer.byteLength(config.profile) > 128
      || /[\u0000-\u001f\u007f-\u009f\[\]]/u.test(config.profile)
      || !config.credentialsFile && !config.configFile || config.credentialsFile !== undefined && !safePath(config.credentialsFile)
      || config.configFile !== undefined && !safePath(config.configFile)) throw failure();
    this.profile = config.profile; this.credentialsFile = config.credentialsFile ? path.resolve(config.credentialsFile) : undefined;
    this.configFile = config.configFile ? path.resolve(config.configFile) : undefined; this.lifetime = config.signal; this.redactor = config.redactor;
  }
  async resolve(caller: AbortSignal): Promise<{ credentials: BedrockProfileCredentials; region?: string; signal: AbortSignal; assertCurrent(): Promise<void> }> {
    const signal = this.lifetime ? AbortSignal.any([caller, this.lifetime]) : caller;
    try {
      signal.throwIfAborted(); const load = async () => ({ credentials: await bytes(this.credentialsFile, signal), config: await bytes(this.configFile, signal) }), current = await load();
      const config = section(current.config, this.profile === 'default' ? 'default' : 'profile ' + this.profile), credentials = { ...config, ...section(current.credentials, this.profile) };
      for (const key of ['aws_access_key_id', 'aws_secret_access_key', 'aws_session_token']) if (credentials[key]) this.redactor?.add(credentials[key]);
      if (['role_arn', 'source_profile', 'credential_source', 'credential_process', 'sso_session', 'sso_start_url', 'web_identity_token_file', 'aws_credential_scope'].some(key => Object.hasOwn(credentials, key))) throw failure();
      const accessKeyId = credentials.aws_access_key_id, secretAccessKey = credentials.aws_secret_access_key, sessionToken = credentials.aws_session_token;
      if (!/^[A-Za-z0-9]{1,128}$/u.test(accessKeyId ?? '') || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(secretAccessKey ?? '')
        || sessionToken !== undefined && !/^[A-Za-z0-9/+=]{1,61440}$/u.test(sessionToken)) throw failure();
      const region = credentials.region; if (region !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(region)) throw failure();
      const assertCurrent = async () => { signal.throwIfAborted(); const latest = await load(); if (!same(current.credentials, latest.credentials) || !same(current.config, latest.config)) throw failure(); signal.throwIfAborted(); };
      return { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }, ...(region ? { region } : {}), signal, assertCurrent };
    } catch { throw failure(); }
  }
}
