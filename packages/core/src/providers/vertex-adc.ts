import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { vertexCertificate, vertexCertificateEnvironment } from './vertex-adc-certificate.js';
import { readOAuthJson } from './oauth-device.js';
import { disableProviderNetworkRetries } from './provider-network.js';
import type { CredentialRedactor } from './credentials.js';
import { vertexExecutable, vertexExecutableSubject, runVertexExecutable, type VertexExecutable } from './vertex-adc-executable.js';
import { vertexAwsEnvironment, vertexAwsSource, vertexAwsSubject, resolveVertexAwsSource, type VertexAwsSource } from './vertex-adc-aws.js';

/** Explicit trusted file only; host admission owns standard-path/environment selection. */
export interface VertexAdcConfig {
  credentialsFile: string;
  quotaProjectId?: string;
  /** Trusted operator permission, default false; credentials files cannot enable execution. */
  allowExecutable?: boolean;
  signal?: AbortSignal;
  redactor?: Pick<CredentialRedactor, 'add'>;
}
type Send = (url: string | URL, init: RequestInit, dispatcher?: Dispatcher) => Promise<Response>;
const TOKEN = 'https://oauth2.googleapis.com/token', STS = 'https://sts.googleapis.com/v1/token', MTLS_STS = 'https://sts.mtls.googleapis.com/v1/token', WORKFORCE = 'https://sts.googleapis.com/v1/oauthtoken', SCOPE = 'https://www.googleapis.com/auth/cloud-platform', MAX_FILE = 256 * 1024;
const failure = () => new Error('Vertex ADC authentication failed.');
const text = (value: unknown, max = 64 * 1024): value is string => typeof value === 'string' && !!value && Buffer.byteLength(value) <= max
  && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;

/** Descriptor-only auth intent; filtered configured headers must not promote a fallback. */
export function hasVertexAuthHeaders(config: object): boolean {
  try {
    const slot = Object.getOwnPropertyDescriptor(config, 'customHeaders'); if (!slot) return false; if (!('value' in slot)) return true;
    const headers: unknown = slot.value; if (!headers || typeof headers !== 'object') return false;
    return Object.getOwnPropertyNames(headers).some(name => {
      if (!['authorization', 'x-goog-api-key'].includes(name.toLowerCase())) return false;
      const value = Object.getOwnPropertyDescriptor(headers, name); return !value || !('value' in value) || typeof value.value === 'string' && !!value.value.trim();
    });
  } catch { return true; }
}
async function observed<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(failure()); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(work), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

function impersonation(data: Record<string, unknown>, external = false) {
  const url = data.service_account_impersonation_url;
  const target = typeof url === 'string' ? /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/([A-Za-z0-9._@%-]+):(?:generateAccessToken|generateIdToken)$/u.exec(url) : null;
  if (!text(url, 256) || !target
    || data.endpoint !== undefined && data.endpoint !== 'https://iamcredentials.googleapis.com'
    || data.universe_domain !== undefined && data.universe_domain !== 'googleapis.com') throw failure();
  const principal = decodeURIComponent(target[1]); if (!/^[A-Za-z0-9._@-]+$/u.test(principal)) throw failure();
  const options = data.service_account_impersonation;
  if (external && options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw failure();
  const lifetime = (external ? (options as Record<string, unknown> | undefined)?.token_lifetime_seconds : data.lifetime) ?? 3600;
  if (typeof lifetime !== 'number' || !Number.isInteger(lifetime) || lifetime < 1 || lifetime > 43200) throw failure();
  const delegates = external ? undefined : data.delegates ?? [];
  if (delegates !== undefined && (!Array.isArray(delegates) || delegates.length > 10 || !delegates.every(value => text(value, 256)))) throw failure();
  const sourceQuota = external ? undefined : (data.source_credentials as Record<string, unknown> | undefined)?.quota_project_id;
  if (sourceQuota !== undefined) { if (!text(sourceQuota, 500)) throw failure(); new Headers({ 'x-goog-user-project': sourceQuota }); }
  return { sourceQuota, url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${principal}:generateAccessToken`, body: { scope: [SCOPE], lifetime: `${lifetime}s`, ...(delegates ? { delegates } : {}) } };
}

async function fileBytes(file: string, signal: AbortSignal): Promise<Buffer> {
  if (typeof file !== 'string' || !file || Buffer.byteLength(file) > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(file)) throw failure();
  signal.throwIfAborted(); const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal.throwIfAborted(); const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_FILE) throw failure();
    const buffer = Buffer.alloc(MAX_FILE + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); signal.throwIfAborted(); if (bytesRead > MAX_FILE) throw failure();
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

function subjectToken(bytes: Buffer, format: Record<string, unknown> | undefined, redactor?: Pick<CredentialRedactor, 'add'>): string {
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); let token: unknown = raw;
  if (format?.type === 'json') {
    const parsed: unknown = JSON.parse(raw), field = format.subject_token_field_name as string;
    token = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, field) ? (parsed as Record<string, unknown>)[field] : undefined;
  }
  if (typeof token !== 'string' || !token.trim() || Buffer.byteLength(token) > 64 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(token)) throw failure();
  redactor?.add(token); if (token.trim() !== token) redactor?.add(token.trim()); return token;
}

async function subjectResponse(response: Response, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (!response.ok || length !== null && (!/^(?:0|[1-9]\d*)$/u.test(length) || Number(length) > MAX_FILE)) {
    void response.body?.cancel().catch(() => undefined); throw failure();
  }
  const reader = response.body?.getReader(); if (!reader) throw failure(); let completed = false;
  try {
    return await observed(async () => {
      const chunks: Uint8Array[] = []; let total = 0;
      while (true) {
        signal.throwIfAborted(); const item = await reader.read(); signal.throwIfAborted();
        if (item.done) { completed = true; return Buffer.concat(chunks); }
        total += item.value.byteLength; if (total > MAX_FILE) throw failure(); chunks.push(item.value);
      }
    }, signal);
  } finally { if (!completed) void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* Hostile pending read. */ } }
}

/** Per-instance cache bound to the exact current file bytes, never a global/persisted token cache. */
export class VertexAdc {
  private readonly file: string;
  private readonly lifetime?: AbortSignal;
  private readonly redactor?: Pick<CredentialRedactor, 'add'>;
  private readonly quota?: string;
  private readonly allowExecutable: boolean;
  private readonly awsEnvironment = vertexAwsEnvironment(process.env);
  private readonly certificateEnvironment = vertexCertificateEnvironment(process.env);
  private cached?: { fingerprint: string; token: string; expiresAt: number };
  private sequence = 0;
  private published = 0;
  private workforceRefresh?: { fingerprint: string; token: string; sequence: number };
  constructor(config: VertexAdcConfig) {
    if (!config || typeof config.credentialsFile !== 'string' || !config.credentialsFile || Buffer.byteLength(config.credentialsFile) > 4096
      || /[\u0000-\u001f\u007f-\u009f]/u.test(config.credentialsFile) || config.quotaProjectId !== undefined && !text(config.quotaProjectId, 500)) throw failure();
    this.file = config.credentialsFile; this.lifetime = config.signal; this.redactor = config.redactor; this.quota = config.quotaProjectId; this.allowExecutable = config.allowExecutable === true;
  }
  private async document(signal: AbortSignal) {
    const bytes = await fileBytes(this.file, signal), value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(); const root = value as Record<string, unknown>;
    let data = root; const iam: ReturnType<typeof impersonation>[] = [];
    while (data.type === 'impersonated_service_account') {
      if (iam.length >= 4) throw failure(); iam.unshift(impersonation(data));
      const source = data.source_credentials;
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw failure(); data = source as Record<string, unknown>;
    }
    if (data.type === 'external_account' && data.service_account_impersonation_url !== undefined) {
      if (iam.length >= 4) throw failure(); iam.unshift(impersonation(data, true));
    }
    for (const field of ['client_secret', 'refresh_token', 'private_key']) this.redactor?.add(typeof data[field] === 'string' ? data[field] as string : undefined);
    const selfSigned = data.type === 'service_account' && data.universe_domain !== undefined && data.universe_domain !== 'googleapis.com';
    if (data.universe_domain !== undefined && data.universe_domain !== 'googleapis.com'
      && ((!selfSigned && data.type !== 'authorized_user') || !text(data.universe_domain, 253) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u.test(data.universe_domain))) throw failure();
    if (selfSigned && data.private_key_id !== undefined && !text(data.private_key_id, 4096)) throw failure();
    if (data.type === 'authorized_user' || data.type === 'external_account_authorized_user') {
      if (!text(data.client_id, 4096) || !text(data.client_secret) || !text(data.refresh_token)
        || data.type === 'external_account_authorized_user' && data.token_url !== undefined && data.token_url !== WORKFORCE) throw failure();
    }
    else if (data.type === 'service_account') { if (!text(data.client_email, 4096) || typeof data.private_key !== 'string' || !data.private_key || Buffer.byteLength(data.private_key) > 128 * 1024) throw failure(); }
    else if (data.type === 'external_account') {
      if (data.token_url !== undefined && data.token_url !== STS && !(data.subject_token_type === 'urn:ietf:params:oauth:token-type:mtls' && data.token_url === MTLS_STS) || data.service_account_impersonation !== undefined && data.service_account_impersonation_url === undefined
        || !text(data.audience, 4096) || !/^\/\/iam\.googleapis\.com\/(?:projects\/[^/?#]+\/locations\/[^/?#]+\/workloadIdentityPools|locations\/[^/?#]+\/workforcePools)\/[^/?#]+\/providers\/[^/?#]+$/u.test(data.audience)
        || !['urn:ietf:params:oauth:token-type:jwt', 'urn:ietf:params:oauth:token-type:id_token', 'urn:ietf:params:oauth:token-type:saml2', 'urn:ietf:params:aws:token-type:aws4_request', 'urn:ietf:params:oauth:token-type:mtls'].includes(data.subject_token_type as string)
        || data.client_id !== undefined && (!text(data.client_id, 4096) || data.client_secret !== undefined && !text(data.client_secret))
        || data.client_secret !== undefined && data.client_id === undefined
        || data.workforce_pool_user_project !== undefined && (!text(data.workforce_pool_user_project, 500) || !data.audience.startsWith('//iam.googleapis.com/locations/'))) throw failure();
    }
    else throw failure();
    let aws: VertexAwsSource | undefined, certificate: Awaited<ReturnType<typeof vertexCertificate>> | undefined;
    let subject: string | undefined, subjectBytes: Buffer | undefined, executable: VertexExecutable | undefined, executableBytes: Buffer | undefined, remote: { url: string; headers: Headers; format?: Record<string, unknown> } | undefined;
    if (data.type === 'external_account' && data.subject_token_type === 'urn:ietf:params:aws:token-type:aws4_request') aws = vertexAwsSource(data.credential_source, this.awsEnvironment, this.redactor);
    if (data.type === 'external_account' && data.subject_token_type === 'urn:ietf:params:oauth:token-type:mtls') {
      const source = data.credential_source;
      if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length !== 1 || !Object.hasOwn(source, 'certificate')) throw failure();
      certificate = await vertexCertificate((source as Record<string, unknown>).certificate, this.certificateEnvironment, signal, fileBytes, this.redactor);
    }
    if (data.type === 'external_account' && !aws && !certificate) {
      const source = data.credential_source as Record<string, unknown> | undefined;
      if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['file', 'url', 'headers', 'format', 'executable'].includes(key))
        || [source.file, source.url, source.executable].filter(value => value !== undefined).length !== 1) throw failure();
      const format = source.format as Record<string, unknown> | undefined;
      if (format !== undefined && (!format || typeof format !== 'object' || Array.isArray(format)
        || format.type !== undefined && format.type !== 'text' && format.type !== 'json' || format.type === 'json' && !text(format.subject_token_field_name, 500))) throw failure();
      if (source.executable !== undefined) {
        if (!this.allowExecutable || Object.keys(source).length !== 1) throw failure(); executable = vertexExecutable(source.executable); this.redactor?.add(executable.command);
        if (executable.outputFile) executableBytes = await fileBytes(executable.outputFile, signal).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      } else if (source.url !== undefined) {
        if (!text(source.url, 4096)) throw failure(); const url = new URL(source.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw failure();
        this.redactor?.add(url.href); for (const value of url.searchParams.values()) this.redactor?.add(value);
        const configured = source.headers;
        if (configured !== undefined && (!configured || typeof configured !== 'object' || Array.isArray(configured))) throw failure();
        const entries = Object.entries(configured ?? {}); if (entries.length > 32) throw failure(); let headerBytes = 0; const headers = new Headers();
        for (const [name, value] of entries) {
          if (typeof value !== 'string' || Buffer.byteLength(name) > 256 || (headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value)) > 16384
            || ['host', 'content-length', 'connection', 'transfer-encoding', 'proxy-authorization'].includes(name.toLowerCase())) throw failure();
          this.redactor?.add(value); headers.set(name, value); const normalized = headers.get(name)!; this.redactor?.add(normalized);
          if (name.toLowerCase() === 'authorization') this.redactor?.add(/^(?:Bearer|Basic)\s+(\S+)$/iu.exec(normalized)?.[1]);
        }
        remote = { url: url.href, headers, format };
      } else {
        if (source.headers !== undefined) throw failure(); subjectBytes = await fileBytes(source.file as string, signal);
        subject = subjectToken(subjectBytes, format, this.redactor);
      }
    }
    const quota = this.quota ?? root.quota_project_id; if (quota !== undefined && !text(quota, 500)) throw failure(); if (quota) new Headers({ 'x-goog-user-project': quota });
    const authFingerprint = createHash('sha256').update(String(bytes.length) + ':').update(bytes).update(executable ? process.cwd() : '').digest('hex');
    const fingerprint = createHash('sha256').update(authFingerprint).update(subjectBytes ?? Buffer.alloc(0)).update(executable?.outputFile ?? '').update(executableBytes ?? Buffer.alloc(0)).update(certificate?.fingerprint ?? '').digest('hex');
    return { data, iam, subject, remote, executable, executableBytes, aws, certificate, selfSigned, authFingerprint, fingerprint, quota };
  }
  private async credential(send: Send, parent: AbortSignal, proxy?: string) {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]); disableProviderNetworkRetries(signal);
    let dispatcher: Dispatcher | undefined; const dispose = () => { void dispatcher?.destroy().catch(() => undefined); };
    signal.addEventListener('abort', dispose, { once: true });
    try { return await observed(async () => {
      let document = await this.document(signal); const sequence = ++this.sequence;
      if (this.cached?.fingerprint === document.fingerprint && this.cached.expiresAt > Date.now() + 300_000) return { ...document, token: this.cached.token };
      if (document.certificate) {
        signal.throwIfAborted(); if (document.certificate.validFrom > Date.now() || document.certificate.validTo <= Date.now()) throw failure();
        const tls = { cert: document.certificate.cert, key: document.certificate.key };
        dispatcher = proxy ? new ProxyAgent({ uri: proxy, requestTls: tls }) : new Agent({ connect: tls });
        if ((await this.document(signal)).fingerprint !== document.fingerprint) throw failure(); signal.throwIfAborted();
      }
      let subject = document.certificate?.subject ?? document.subject;
      if (document.aws) {
        const source = await resolveVertexAwsSource(document.aws, signal, async currentSignal => { if ((await this.document(currentSignal)).fingerprint !== document.fingerprint) throw failure(); currentSignal.throwIfAborted(); }, this.redactor);
        subject = vertexAwsSubject(source, document.data.audience as string, this.redactor);
      }
      if (document.executable) {
        const recipe = document.executable, type = document.data.subject_token_type as string;
        subject = document.executableBytes?.length ? vertexExecutableSubject(document.executableBytes, type, true, this.redactor, true) : undefined;
        if (!subject) {
          if ((await this.document(signal)).fingerprint !== document.fingerprint) throw failure();
          const url = document.data.service_account_impersonation_url as string | undefined;
          const email = url ? decodeURIComponent(/serviceAccounts\/([^:]+):/u.exec(url)![1]) : undefined;
          subject = await runVertexExecutable(recipe, type, document.data.audience as string, email, signal, this.redactor);
          const latest = await this.document(signal); if (latest.authFingerprint !== document.authFingerprint) throw failure();
          // The helper may publish its own cache, but not a different currently valid subject identity.
          if (latest.executableBytes?.length && !latest.executableBytes.equals(document.executableBytes ?? Buffer.alloc(0))) {
            const cached = vertexExecutableSubject(latest.executableBytes, type, true, this.redactor, true); if (cached !== undefined && cached !== subject) throw failure();
          }
          document = latest;
        }
        if ((await this.document(signal)).fingerprint !== document.fingerprint) throw failure(); signal.throwIfAborted();
      }
      if (document.remote) {
        const response = await send(document.remote.url, { method: 'GET', redirect: 'manual', signal, headers: document.remote.headers });
        subject = subjectToken(await subjectResponse(response, signal), document.remote.format, this.redactor);
        if ((await this.document(signal)).fingerprint !== document.fingerprint) throw failure(); signal.throwIfAborted();
      }
      const data = document.data; let fields: Record<string, string>, authorization: string | undefined, direct: string | undefined, directExpiresAt: number | undefined;
      if (data.type === 'external_account' || data.type === 'external_account_authorized_user') {
        fields = data.type === 'external_account_authorized_user'
          ? { grant_type: 'refresh_token', refresh_token: this.workforceRefresh?.fingerprint === document.fingerprint ? this.workforceRefresh.token : data.refresh_token as string }
          : { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', audience: data.audience as string, scope: SCOPE,
          requested_token_type: 'urn:ietf:params:oauth:token-type:access_token', subject_token: subject!, subject_token_type: data.subject_token_type as string };
        if (data.client_id) { const encoded = Buffer.from(`${data.client_id}:${data.client_secret ?? ''}`).toString('base64'); authorization = 'Basic ' + encoded; if (Buffer.byteLength(authorization) > 64 * 1024) throw failure(); this.redactor?.add(encoded); this.redactor?.add(authorization); }
        else if (data.workforce_pool_user_project) fields.options = JSON.stringify({ userProject: data.workforce_pool_user_project });
      }
      else if (data.type === 'authorized_user') fields = { grant_type: 'refresh_token', client_id: data.client_id as string, client_secret: data.client_secret as string, refresh_token: data.refresh_token as string };
      else {
        const key = createPrivateKey(data.private_key as string); if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw failure();
        const now = Math.floor(Date.now() / 1000), header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(document.selfSigned && data.private_key_id ? { kid: data.private_key_id } : {}) })).toString('base64url');
        const claims = document.selfSigned ? { iss: data.client_email, sub: data.client_email, scope: SCOPE, exp: now + 3600, iat: now } : { iss: data.client_email, scope: SCOPE, aud: TOKEN, iat: now, exp: now + 3600 };
        const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'), unsigned = `${header}.${payload}`;
        const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`; this.redactor?.add(assertion);
        fields = { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion };
        if (document.selfSigned) { direct = assertion; directExpiresAt = (now + 3600) * 1000; }
      }
      let body: Record<string, unknown>;
      if (direct !== undefined) body = { access_token: direct, expires_in: 3600, token_type: 'Bearer' };
      else {
        if ((document.aws || document.certificate) && (await this.document(signal)).fingerprint !== document.fingerprint) throw failure();
        signal.throwIfAborted(); const response = await send(data.type === 'external_account' ? (document.certificate ? (data.token_url as string | undefined) ?? STS : STS) : data.type === 'external_account_authorized_user' ? WORKFORCE : TOKEN, { method: 'POST', redirect: 'manual', signal, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(authorization ? { authorization } : {}) }, body: new URLSearchParams(fields) }, dispatcher);
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw failure(); } body = await readOAuthJson(response, signal);
      }
      this.redactor?.add(typeof body.access_token === 'string' ? body.access_token : undefined);
      if (!text(body.access_token) || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 31_536_000
        || body.token_type !== undefined && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')) throw failure();
      if (data.type === 'external_account_authorized_user') {
        this.redactor?.add(typeof body.refresh_token === 'string' ? body.refresh_token : undefined);
        if (body.refresh_token !== undefined && !text(body.refresh_token)) throw failure();
        new Headers({ authorization: `Bearer ${body.access_token}` });
        if ((await this.document(signal)).fingerprint !== document.fingerprint) throw failure(); signal.throwIfAborted();
        if (body.refresh_token !== undefined && sequence > (this.workforceRefresh?.sequence ?? 0)) {
          this.workforceRefresh = { fingerprint: document.fingerprint, token: body.refresh_token as string, sequence };
        }
      }
      let token = body.access_token, expiresAt = directExpiresAt ?? Date.now() + body.expires_in * 1000;
      for (const step of document.iam) {
        new Headers({ authorization: `Bearer ${token}` }); if ((await this.document(signal)).fingerprint !== document.fingerprint) throw failure(); signal.throwIfAborted();
        const response = await send(step.url, { method: 'POST', redirect: 'manual', signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', ...(step.sourceQuota ? { 'x-goog-user-project': step.sourceQuota } : {}) }, body: JSON.stringify(step.body) }, dispatcher);
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw failure(); }
        const result = await readOAuthJson(response, signal); this.redactor?.add(typeof result.accessToken === 'string' ? result.accessToken : undefined);
        const expiry = typeof result.expireTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(result.expireTime) ? Date.parse(result.expireTime) : NaN;
        if (!text(result.accessToken) || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 43200 * 1000) throw failure();
        token = result.accessToken; expiresAt = expiry;
      }
      new Headers({ authorization: `Bearer ${token}` }); if ((await this.document(signal)).fingerprint !== document.fingerprint) throw failure(); signal.throwIfAborted();
      if (sequence > this.published) { this.published = sequence; this.cached = { fingerprint: document.fingerprint, token, expiresAt }; }
      return { ...document, token };
    }, signal); } finally { signal.removeEventListener('abort', dispose); dispose(); }
  }
  async request(url: string | URL, init: RequestInit, parent: AbortSignal, send: Send, proxy?: string): Promise<Response> {
    const signal = this.lifetime ? AbortSignal.any([parent, this.lifetime]) : parent;
    try {
      const credential = await this.credential(send, signal, proxy); signal.throwIfAborted(); const headers = new Headers(init.headers); headers.delete('x-goog-api-key'); headers.set('authorization', `Bearer ${credential.token}`);
      if (credential.quota && !headers.has('x-goog-user-project')) headers.set('x-goog-user-project', credential.quota);
      if ((credential.executable || credential.aws || credential.certificate || credential.selfSigned) && (await this.document(signal)).fingerprint !== credential.fingerprint) throw failure(); signal.throwIfAborted();
      const response = await send(url, { ...init, headers, signal, redirect: 'manual' }); signal.throwIfAborted();
      if (response.status === 401 && this.cached?.token === credential.token) this.cached = undefined;
      return response;
    } catch { throw failure(); }
  }
}
