import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { signAwsRequest } from './aws-sigv4.js';
import { awsStsEndpoint, readAwsStsCredentials, validIamRoleArn, type AwsStsSend } from './aws-sts.js';
import { BedrockWebIdentityCredentials, type BedrockWebIdentityConfig } from './bedrock-web-identity.js';
import { BedrockEcsCredentials, type BedrockEcsConfig } from './bedrock-ecs.js';
import { BedrockImdsCredentials, bedrockImdsEndpoint, type BedrockImdsConfig } from './bedrock-imds.js';
import { BedrockSsoCredentials, bedrockSsoCacheFile, type BedrockSsoConfig } from './bedrock-sso.js';
import { BedrockRefreshingCredentials, bedrockCredentialFile, bedrockVendedCredentials, type BedrockCredentialIdentity, type BedrockVendedCredentials } from './bedrock-credentials.js';
import { fetchOAuthResponse } from './oauth-device.js';
import { disableProviderNetworkRetries } from './provider-network.js';
import { executeBedrockCredentialProcess, validBedrockProcessCommand } from './bedrock-process.js';
import type { BedrockProviderConfig } from './index.js';
import path from 'node:path';
import type { CredentialRedactor } from './credentials.js';

/** Explicit trusted INI files only. Native hosts own environment/default-path admission. */
export interface BedrockProfileConfig {
  profile: string;
  credentialsFile?: string;
  configFile?: string;
  /** Read-only selected SSO token cache; defaults to captured HOME/.aws/sso/cache. */
  ssoCacheDirectory?: string;
  allowNetwork?: boolean;
  /** Trusted operator permission, default false; INI files cannot enable execution. */
  allowProcess?: boolean;
  signal?: AbortSignal;
  redactor?: Pick<CredentialRedactor, 'add'>;
}
export interface BedrockProfileCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
/** Original constructor snapshot, not an ambient lookup during file resolution. */
interface ProfileEnvironment { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; expiration?: string; credentialScope?: string; ecs?: BedrockEcsConfig; imds?: BedrockImdsConfig }
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
const ssoIntent = (data: Record<string, string>) => ['sso_session', 'sso_start_url', 'sso_region', 'sso_account_id', 'sso_role_name'].some(key => Object.hasOwn(data, key));
function selectedSso(data: Record<string, string>, input: Buffer | undefined, cacheDirectory: string, signal?: AbortSignal, redactor?: Pick<CredentialRedactor, 'add'>): BedrockSsoConfig {
  if (['aws_access_key_id', 'aws_secret_access_key', 'aws_session_token', 'role_arn', 'source_profile', 'credential_source', 'credential_process', 'web_identity_token_file', 'mfa_serial', 'aws_credential_scope'].some(key => Object.hasOwn(data, key))) throw failure();
  const sessionName = data.sso_session;
  if (sessionName !== undefined && (!sessionName || sessionName !== sessionName.trim() || Buffer.byteLength(sessionName) > 128 || /[\u0000-\u001f\u007f-\u009f\[\]]/u.test(sessionName))) throw failure();
  const source = sessionName === undefined ? data : section(input, 'sso-session ' + sessionName);
  if (sessionName !== undefined && ['sso_start_url', 'sso_region'].some(key => data[key] !== undefined && data[key] !== source[key])) throw failure();
  const config: BedrockSsoConfig = { startUrl: source.sso_start_url, region: source.sso_region, accountId: data.sso_account_id, roleName: data.sso_role_name, cacheDirectory, sessionName, signal, redactor };
  bedrockSsoCacheFile(config); return config;
}

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
    bedrockProfile: { profile, credentialsFile: files[0], configFile: files[1], ssoCacheDirectory: path.resolve(home, '.aws', 'sso', 'cache'), ...(env.AI_HARNESS_ALLOW_CREDENTIAL_EXECUTION === '1' ? { allowProcess: true } : {}), signal } } : undefined;
}

/** Static keys stay file-bound; selected-root WebIdentity and role vending keep private foreground current-file caches. */
export class BedrockProfile {
  private readonly profile: string;
  private readonly credentialsFile?: string;
  private readonly configFile?: string;
  private readonly lifetime?: AbortSignal;
  private readonly redactor?: Pick<CredentialRedactor, 'add'>;
  private role?: BedrockProfileRole;
  private web?: { fingerprint: string; source: BedrockWebIdentityCredentials };
  private sso?: { fingerprint: string; source: BedrockSsoCredentials };
  private readonly ssoCacheDirectory: string;
  private readonly allowNetwork?: boolean;
  private readonly allowProcess: boolean;
  private processSource?: BedrockProfileProcess;
  private readonly environment?: ProfileEnvironment;
  constructor(config: BedrockProfileConfig, private readonly parentRegion?: string, private readonly send: AwsStsSend = (url, init) => Promise.resolve().then(() => fetch(url, init)), environment?: ProfileEnvironment) {
    if (typeof config.profile !== 'string' || !config.profile || config.profile !== config.profile.trim() || Buffer.byteLength(config.profile) > 128
      || /[\u0000-\u001f\u007f-\u009f\[\]]/u.test(config.profile)
      || !config.credentialsFile && !config.configFile || config.credentialsFile !== undefined && !safePath(config.credentialsFile)
      || config.configFile !== undefined && !safePath(config.configFile) || config.ssoCacheDirectory !== undefined && !safePath(config.ssoCacheDirectory)) throw failure();
    this.ssoCacheDirectory = path.resolve(config.ssoCacheDirectory ?? path.join(homedir(), '.aws', 'sso', 'cache'));
    this.profile = config.profile; this.credentialsFile = config.credentialsFile ? path.resolve(config.credentialsFile) : undefined;
    this.configFile = config.configFile ? path.resolve(config.configFile) : undefined; this.lifetime = config.signal; this.redactor = config.redactor; this.allowNetwork = config.allowNetwork; this.allowProcess = config.allowProcess === true;
    this.environment = environment ? { ...environment, ecs: environment.ecs ? { ...environment.ecs } : undefined, imds: environment.imds ? { ...environment.imds } : undefined } : undefined;
  }
  invalidate(credentials: BedrockProfileCredentials, status: number): void { this.role?.invalidate(credentials, status); this.web?.source.invalidate(credentials, status); this.processSource?.invalidate(credentials, status); this.sso?.source.invalidate(credentials, status); }
  async resolve(caller: AbortSignal): Promise<{ credentials: BedrockProfileCredentials; region?: string; signal: AbortSignal; assertCurrent(): Promise<void> }> {
    const signal = this.lifetime ? AbortSignal.any([caller, this.lifetime]) : caller;
    try {
      signal.throwIfAborted(); const load = async (currentSignal = signal) => ({ credentials: await bytes(this.credentialsFile, currentSignal), config: await bytes(this.configFile, currentSignal) }), current = await load();
      const config = section(current.config, this.profile === 'default' ? 'default' : 'profile ' + this.profile), credentials = { ...config, ...section(current.credentials, this.profile) };
      for (const key of ['aws_access_key_id', 'aws_secret_access_key', 'aws_session_token']) if (credentials[key]) this.redactor?.add(credentials[key]);
      if (Object.hasOwn(credentials, 'role_arn') && (Object.hasOwn(credentials, 'source_profile') || Object.hasOwn(credentials, 'credential_source'))) {
        this.role ??= new BedrockProfileRole({ profile: this.profile, credentialsFile: this.credentialsFile, configFile: this.configFile, ssoCacheDirectory: this.ssoCacheDirectory, allowNetwork: this.allowNetwork, allowProcess: this.allowProcess, signal: this.lifetime, redactor: this.redactor }, this.parentRegion, this.send, this.environment);
        return await this.role.resolve(signal);
      }
      const region = credentials.region; if (region !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(region)) throw failure();
      const assertCurrent = async (currentSignal = signal) => { currentSignal.throwIfAborted(); const latest = await load(currentSignal); if (!same(current.credentials, latest.credentials) || !same(current.config, latest.config)) throw failure(); currentSignal.throwIfAborted(); };
      if (ssoIntent(credentials)) {
        if (this.allowNetwork === false) throw failure();
        const selected = selectedSso(credentials, current.config, this.ssoCacheDirectory, this.lifetime, this.redactor), hash = createHash('sha256');
        for (const value of [Buffer.from(this.profile), current.credentials, current.config]) { hash.update(value === undefined ? 'missing:' : value.length + ':'); if (value !== undefined) hash.update(value); }
        const fingerprint = hash.digest('hex');
        if (this.sso?.fingerprint !== fingerprint) this.sso = { fingerprint, source: new BedrockSsoCredentials(selected, assertCurrent, this.send) };
        const result = await this.sso.source.resolve(signal); await assertCurrent();
        return { ...result, ...(region ? { region } : {}), assertCurrent: async () => { try { await assertCurrent(); await result.assertCurrent(); await assertCurrent(); } catch { throw failure(); } } };
      }
      const webIdentity = Object.hasOwn(credentials, 'web_identity_token_file') && Object.hasOwn(credentials, 'role_arn');
      if (webIdentity && ['source_profile', 'credential_source', 'credential_process', 'sso_session', 'sso_start_url', 'mfa_serial', 'aws_credential_scope'].some(key => Object.hasOwn(credentials, key))) throw failure();
      if (webIdentity && !(typeof credentials.aws_access_key_id === 'string' && typeof credentials.aws_secret_access_key === 'string')) {
        if (this.allowNetwork === false) throw failure();
        const hash = createHash('sha256');
        for (const value of [Buffer.from(this.profile), Buffer.from(this.parentRegion ?? ''), current.credentials, current.config]) {
          hash.update(value === undefined ? 'missing:' : value.length + ':'); if (value !== undefined) hash.update(value);
        }
        const fingerprint = hash.digest('hex');
        if (this.web?.fingerprint !== fingerprint) this.web = { fingerprint, source: new BedrockWebIdentityCredentials({
          tokenFile: credentials.web_identity_token_file, roleArn: credentials.role_arn, roleSessionName: credentials.role_session_name,
          region: this.parentRegion ?? region, signal: this.lifetime, redactor: this.redactor,
        }, undefined, async (url, init) => { if (!init.signal) throw failure(); await assertCurrent(init.signal); return this.send(url, init); }) };
        const result = await this.web.source.resolve(signal); await assertCurrent();
        return { ...result, ...(region ? { region } : {}), assertCurrent: async () => {
          try { await assertCurrent(); await result.assertCurrent(); await assertCurrent(); } catch { throw failure(); }
        } };
      }
      if (Object.hasOwn(credentials, 'credential_process')) {
        if (!this.allowProcess || this.allowNetwork === false) throw failure();
        this.processSource ??= new BedrockProfileProcess(async currentSignal => {
          const latest = await load(currentSignal), data = { ...section(latest.config, this.profile === 'default' ? 'default' : 'profile ' + this.profile), ...section(latest.credentials, this.profile) };
          if (['aws_access_key_id', 'aws_secret_access_key', 'aws_session_token', 'role_arn', 'source_profile', 'credential_source', 'sso_session', 'sso_start_url', 'web_identity_token_file', 'aws_credential_scope', 'mfa_serial'].some(key => Object.hasOwn(data, key))
            || !validBedrockProcessCommand(data.credential_process)
            || data.region !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(data.region)) throw failure();
          const hash = createHash('sha256');
          for (const value of [Buffer.from(this.profile), Buffer.from(process.cwd()), latest.credentials, latest.config]) { hash.update(value === undefined ? 'missing:' : value.length + ':'); if (value !== undefined) hash.update(value); }
          this.redactor?.add(data.credential_process); currentSignal.throwIfAborted();
          return { fingerprint: hash.digest('hex'), command: data.credential_process, ...(data.region ? { region: data.region } : {}) };
        }, this.lifetime, this.redactor);
        return await this.processSource.resolve(signal);
      }
      if (['role_arn', 'source_profile', 'credential_source', 'credential_process', 'sso_session', 'sso_start_url', 'web_identity_token_file', 'aws_credential_scope']
        .some(key => Object.hasOwn(credentials, key) && !(webIdentity && ['role_arn', 'web_identity_token_file'].includes(key)))) throw failure();
      const accessKeyId = credentials.aws_access_key_id, secretAccessKey = credentials.aws_secret_access_key, sessionToken = credentials.aws_session_token;
      if (!/^[A-Za-z0-9]{1,128}$/u.test(accessKeyId ?? '') || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(secretAccessKey ?? '')
        || sessionToken !== undefined && !/^[A-Za-z0-9/+=]{1,61440}$/u.test(sessionToken)) throw failure();
      return { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }, ...(region ? { region } : {}), signal, assertCurrent };
    } catch { throw failure(); }
  }
}
interface ProcessIdentity extends BedrockCredentialIdentity { command: string; region?: string }
class BedrockProfileProcess extends BedrockRefreshingCredentials<ProcessIdentity> {
  constructor(private readonly read: (signal: AbortSignal) => Promise<ProcessIdentity>, lifetime?: AbortSignal, redactor?: Pick<CredentialRedactor, 'add'>) { super('Bedrock profile authentication failed.', lifetime, redactor); }
  protected identity(signal: AbortSignal): Promise<ProcessIdentity> { return this.read(signal); }
  protected async acquire(identity: ProcessIdentity, signal: AbortSignal): Promise<BedrockVendedCredentials> {
    if ((await this.identity(signal)).fingerprint !== identity.fingerprint) throw failure();
    const result = await executeBedrockCredentialProcess(identity.command, signal, this.redactor);
    return { ...result, ...(identity.region ? { region: identity.region } : {}) };
  }
}
type RoleSource = { credentials: BedrockProfileCredentials; sourceExpiresAt?: number; web?: undefined; ecs?: undefined; imds?: undefined; process?: undefined; sso?: undefined }
  | { credentials?: undefined; sourceExpiresAt?: undefined; web: BedrockWebIdentityConfig; ecs?: undefined; imds?: undefined; process?: undefined; sso?: undefined }
  | { credentials?: undefined; sourceExpiresAt?: undefined; web?: undefined; ecs: BedrockEcsConfig; imds?: undefined; process?: undefined; sso?: undefined }
  | { credentials?: undefined; sourceExpiresAt?: undefined; web?: undefined; ecs?: undefined; imds: BedrockImdsConfig; process?: undefined; sso?: undefined }
  | { credentials?: undefined; sourceExpiresAt?: undefined; web?: undefined; ecs?: undefined; imds?: undefined; process: string; sso?: undefined }
  | { credentials?: undefined; sourceExpiresAt?: undefined; web?: undefined; ecs?: undefined; imds?: undefined; process?: undefined; sso: BedrockSsoConfig };
interface RoleIdentity extends BedrockCredentialIdentity { credentials?: BedrockProfileCredentials; sourceExpiresAt?: number; web?: BedrockWebIdentityConfig; ecs?: BedrockEcsConfig; imds?: BedrockImdsConfig; process?: string; sso?: BedrockSsoConfig; steps: Record<string, string>[]; region?: string; sts: string }
/** Bounded role chains use static, explicit named sources or file WebIdentity, never inferred execution. */
class BedrockProfileRole extends BedrockRefreshingCredentials<RoleIdentity> {
  private readonly sessionName = 'ai-harness-' + randomUUID();
  private readonly webSessionName = 'ai-harness-' + randomUUID();
  private sso?: { fingerprint: string; source: BedrockSsoCredentials };
  constructor(private readonly config: BedrockProfileConfig, private readonly parentRegion: string | undefined, private readonly send: AwsStsSend, private readonly environment?: ProfileEnvironment) {
    super('Bedrock profile authentication failed.', config.signal, config.redactor);
  }
  protected async identity(signal: AbortSignal): Promise<RoleIdentity> {
    const current = { credentials: await bytes(this.config.credentialsFile, signal), config: await bytes(this.config.configFile, signal) };
    const selected = (name: string) => ({ ...section(current.config, name === 'default' ? 'default' : 'profile ' + name), ...section(current.credentials, name) });
    const root = selected(this.config.profile), region = root.region, steps: Record<string, string>[] = [], visited = new Set<string>(); let roles = 0;
    if (region !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(region)) throw failure();
    const environment = (): RoleSource => {
      const { accessKeyId, secretAccessKey, sessionToken, expiration, credentialScope } = this.environment ?? {};
      for (const value of [accessKeyId, secretAccessKey, sessionToken]) if (value) this.redactor?.add(value);
      const sourceExpiresAt = expiration ? Date.parse(expiration) : undefined;
      if (!/^[A-Za-z0-9]{1,128}$/u.test(accessKeyId ?? '') || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(secretAccessKey ?? '')
        || sessionToken !== undefined && !/^[A-Za-z0-9/+=]{1,61440}$/u.test(sessionToken) || credentialScope
        || sourceExpiresAt !== undefined && !Number.isFinite(sourceExpiresAt)) throw failure();
      return { credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, ...(sessionToken ? { sessionToken } : {}) },
        ...(sourceExpiresAt === undefined ? {} : { sourceExpiresAt }) };
    };
    const namedSource = (kind: string): RoleSource => {
      if (kind === 'Environment') return environment();
      if (this.config.allowNetwork === false) throw failure();
      if (kind === 'Ec2InstanceMetadata') {
        const imds = { ...this.environment?.imds, endpoint: this.environment?.imds?.endpoint ?? root.ec2_metadata_service_endpoint,
          endpointMode: this.environment?.imds?.endpointMode ?? root.ec2_metadata_service_endpoint_mode, signal: this.config.signal, redactor: this.redactor };
        bedrockImdsEndpoint(imds); return { imds }; // Pure descriptor admission, no metadata token/GET.
      }
      if (!this.environment?.ecs) throw failure();
      const ecs = { ...this.environment.ecs, signal: this.config.signal, redactor: this.redactor };
      new BedrockEcsCredentials(ecs); // Descriptor admission only; secret/GET remain foreground below.
      return { ecs };
    };
    const walk = (name: string, recursive: boolean): RoleSource => {
      if (!name || name !== name.trim() || Buffer.byteLength(name) > 128 || /[\u0000-\u001f\u007f-\u009f\[\]]/u.test(name)) throw failure();
      const data = selected(name), isStatic = typeof data.aws_access_key_id === 'string' && typeof data.aws_secret_access_key === 'string';
      if (recursive && !isStatic && ssoIntent(data)) {
        if (this.config.allowNetwork === false) throw failure();
        return { sso: selectedSso(data, current.config, this.config.ssoCacheDirectory!, this.config.signal, this.redactor) };
      }
      if (recursive && !isStatic && ['Environment', 'EcsContainer', 'Ec2InstanceMetadata'].includes(data.credential_source) && data.role_arn === undefined) {
        if (['source_profile', 'credential_process', 'web_identity_token_file', 'sso_session', 'sso_start_url', 'mfa_serial', 'aws_credential_scope'].some(key => Object.hasOwn(data, key))) throw failure();
        return namedSource(data.credential_source);
      }
      if (recursive && !isStatic && Object.hasOwn(data, 'web_identity_token_file') && Object.hasOwn(data, 'role_arn')) {
        if (this.config.allowNetwork === false || !safePath(data.web_identity_token_file)
          || ['source_profile', 'credential_source', 'credential_process', 'sso_session', 'sso_start_url', 'mfa_serial', 'aws_credential_scope'].some(key => Object.hasOwn(data, key))) throw failure();
        const web: BedrockWebIdentityConfig = { tokenFile: path.resolve(data.web_identity_token_file), roleArn: data.role_arn,
          roleSessionName: data.role_session_name ?? this.webSessionName, region: this.parentRegion ?? region ?? 'us-east-1', signal: this.config.signal, redactor: this.redactor };
        new BedrockWebIdentityCredentials(web); // Descriptor admission only; JWT/network remain foreground below.
        return { web };
      }
      if (recursive && !isStatic && data.credential_process !== undefined) {
        if (this.config.allowProcess !== true || this.config.allowNetwork === false || !validBedrockProcessCommand(data.credential_process)
          || ['role_arn', 'source_profile', 'credential_source', 'web_identity_token_file', 'sso_session', 'sso_start_url', 'mfa_serial', 'aws_credential_scope'].some(key => Object.hasOwn(data, key))) throw failure();
        this.redactor?.add(data.credential_process); return { process: data.credential_process };
      }
      if (!(recursive && isStatic) && data.role_arn !== undefined) {
        const fromNamedSource = ['Environment', 'EcsContainer', 'Ec2InstanceMetadata'].includes(data.credential_source) && data.source_profile === undefined;
        if (visited.has(name) || ++roles > 4 || !validIamRoleArn(data.role_arn) || !data.source_profile && !fromNamedSource
          || data.source_profile !== undefined && data.credential_source !== undefined
          || ['credential_process', 'web_identity_token_file', 'sso_session', 'sso_start_url', 'mfa_serial', 'aws_credential_scope'].some(key => Object.hasOwn(data, key))) throw failure();
        visited.add(name); const source = fromNamedSource ? namedSource(data.credential_source) : walk(data.source_profile, true), sessionName = data.role_session_name || this.sessionName, duration = data.duration_seconds ?? '3600';
        if (!/^[A-Za-z0-9+=,.@_-]{2,64}$/u.test(sessionName) || !/^[1-9]\d*$/u.test(duration) || Number(duration) < 900 || Number(duration) > 43200
          || data.external_id !== undefined && !/^[A-Za-z0-9_+=,.@:/-]{2,1224}$/u.test(data.external_id)) throw failure();
        steps.push({ RoleArn: data.role_arn, RoleSessionName: sessionName, DurationSeconds: duration, ...(data.external_id !== undefined ? { ExternalId: data.external_id } : {}) }); return source;
      }
      if (!isStatic || Object.hasOwn(data, 'aws_credential_scope') || !recursive && Object.hasOwn(data, 'source_profile')) throw failure();
      const accessKeyId = data.aws_access_key_id, secretAccessKey = data.aws_secret_access_key, sessionToken = data.aws_session_token;
      for (const value of [accessKeyId, secretAccessKey, sessionToken]) if (value) this.redactor?.add(value);
      if (!/^[A-Za-z0-9]{1,128}$/u.test(accessKeyId) || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(secretAccessKey)
        || sessionToken !== undefined && !/^[A-Za-z0-9/+=]{1,61440}$/u.test(sessionToken)) throw failure();
      return { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } };
    };
    const source = walk(this.config.profile, false), hash = createHash('sha256');
    for (const value of [Buffer.from(this.config.profile), Buffer.from(this.parentRegion ?? ''), Buffer.from(this.sessionName), current.credentials, current.config,
      ...(source.web ? [Buffer.from(source.web.tokenFile), Buffer.from(this.webSessionName), await bedrockCredentialFile(source.web.tokenFile, 20000, signal)] : []),
      ...(source.ecs ? [Buffer.from(source.ecs.relativeUri ?? ''), Buffer.from(source.ecs.fullUri ?? ''), Buffer.from(source.ecs.authorizationToken ?? ''), Buffer.from(source.ecs.authorizationTokenFile ?? ''),
        ...(source.ecs.authorizationTokenFile ? [await bedrockCredentialFile(source.ecs.authorizationTokenFile, 65536, signal)] : [])] : []),
      ...(source.imds ? [Buffer.from(bedrockImdsEndpoint(source.imds))] : []),
      ...(source.sso ? [Buffer.from(bedrockSsoCacheFile(source.sso)), await bedrockCredentialFile(bedrockSsoCacheFile(source.sso), MAX_FILE, signal)] : []), ...(source.process ? [Buffer.from(process.cwd())] : [])]) {
      hash.update(value === undefined ? 'missing:' : value.length + ':'); if (value !== undefined) hash.update(value);
    }
    signal.throwIfAborted(); return { fingerprint: hash.digest('hex'), ...source, steps, ...(region ? { region } : {}), sts: awsStsEndpoint(region ?? this.parentRegion ?? 'us-east-1') };
  }
  protected async acquire(identity: RoleIdentity, signal: AbortSignal): Promise<BedrockVendedCredentials> {
    if (this.config.allowNetwork === false) throw failure();
    let credentials = identity.credentials, sourceExpiresAt = identity.sourceExpiresAt, result: BedrockVendedCredentials | undefined, sourceCurrent: (() => Promise<void>) | undefined; disableProviderNetworkRetries(signal);
    if (identity.process) {
      if ((await this.identity(signal)).fingerprint !== identity.fingerprint) throw failure();
      const source = await executeBedrockCredentialProcess(identity.process, signal, this.redactor); credentials = source.credentials; sourceExpiresAt = source.expiresAt;
    }
    if (identity.web || identity.ecs || identity.imds || identity.sso) {
      const current = async (signal: AbortSignal) => { if ((await this.identity(signal)).fingerprint !== identity.fingerprint) throw failure(); };
      if (identity.sso && this.sso?.fingerprint !== identity.fingerprint) this.sso = { fingerprint: identity.fingerprint, source: new BedrockSsoCredentials(identity.sso, current, this.send) };
      const child = identity.web ? new BedrockWebIdentityCredentials(identity.web, undefined, async (url, init) => {
        if (!init.signal) throw failure(); await current(init.signal); return this.send(url, init);
      }) : identity.ecs ? new BedrockEcsCredentials(identity.ecs, current) : identity.sso ? this.sso!.source : new BedrockImdsCredentials(identity.imds!, current);
      const source = await child.resolve(signal); credentials = source.credentials; sourceCurrent = source.assertCurrent;
    }
    if (!credentials) throw failure();
    const region = identity.region ?? this.parentRegion ?? 'us-east-1';
    for (const step of identity.steps) {
      if (result && result.expiresAt <= Date.now() || (await this.identity(signal)).fingerprint !== identity.fingerprint) throw failure();
      await sourceCurrent?.(); sourceCurrent = undefined;
      if (!result && sourceExpiresAt !== undefined && sourceExpiresAt <= Date.now()) throw failure();
      const body = new URLSearchParams({ Action: 'AssumeRole', Version: '2011-06-15', ...step }).toString(), headers = signAwsRequest(new URL(identity.sts), body, 'sts', credentials, region, { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/xml' });
      const request: RequestInit = { method: 'POST', redirect: 'manual', signal, headers, body }, response = await fetchOAuthResponse(identity.sts, request, signal, () => this.send(identity.sts, request));
      if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw failure(); }
      const data = await readAwsStsCredentials(response, signal, 'AssumeRole'); result = bedrockVendedCredentials({ ...data, Token: data.SessionToken }, this.redactor);
      if (result.expiresAt > Date.now() + 43200000) throw failure(); credentials = result.credentials;
    }
    if (!result) throw failure(); return { ...result, ...(identity.region ? { region: identity.region } : {}) };
  }
}
