import type { CredentialRedactor } from './credentials.js';

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const HEADERS = Object.freeze({
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
});
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_BYTES = 64 * 1024;
const UNSAFE_TEXT = /[\u0000-\u0020\u007f-\u009f]/u;

export interface GitHubCopilotOAuthCredential {
  accessToken: string;
  /** GitHub's durable grant, not an OAuth refresh_token grant. */
  refreshToken: string;
  expiresAt: number;
  baseUrl: string;
  availableModelIds: string[];
  enterpriseDomain?: string;
}

function domain(value?: string): string {
  if (value === undefined) return 'github.com';
  if (typeof value !== 'string' || value.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/iu.test(value)) {
    throw new Error('Invalid GitHub Copilot enterprise domain.');
  }
  return value.toLowerCase();
}

/** Enterprise domains are explicit operator configuration, never discovered from a token. */
export function getGitHubCopilotOAuthConfig(enterpriseDomain?: string) {
  const host = domain(enterpriseDomain);
  return Object.freeze({
    clientId: CLIENT_ID, scope: 'read:user', responseProfile: 'github-copilot' as const,
    ...(enterpriseDomain === undefined ? {} : { enterpriseDomain: host }),
    deviceAuthorizationUrl: `https://${host}/login/device/code`,
    tokenUrl: `https://${host}/login/oauth/access_token`,
    exchangeUrl: `https://api.${host}/copilot_internal/v2/token`,
  });
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_TOKEN_BYTES && !UNSAFE_TEXT.test(value);
}

/** A response token may select a Copilot account tier, not an arbitrary outbound host. */
export function getGitHubCopilotBaseUrl(accessToken: string, enterpriseDomain?: string): string {
  if (!token(accessToken)) throw new Error('Invalid GitHub Copilot token.');
  const host = domain(enterpriseDomain);
  const proxies = accessToken.split(';').filter(part => part.startsWith('proxy-ep='));
  if (proxies.length) {
    if (proxies.length !== 1 || !/^proxy-ep=proxy\.(individual|business|enterprise)\.githubcopilot\.com$/u.test(proxies[0])) {
      throw new Error('Invalid GitHub Copilot token endpoint.');
    }
    return `https://${proxies[0].slice('proxy-ep='.length).replace(/^proxy\./u, 'api.')}`;
  }
  return host === 'github.com' ? 'https://api.individual.githubcopilot.com' : `https://copilot-api.${host}`;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal, abandon?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('GitHub Copilot authentication cancelled.'));
    operation.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abandon?.(value);
      resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function requestJson(url: string, bearer: string, signal: AbortSignal, fetcher: typeof fetch, catalogue = false): Promise<Record<string, unknown>> {
  if (signal.aborted) throw new Error('GitHub Copilot authentication cancelled.');
  const response = await abortable(fetcher(url, {
    method: 'GET', redirect: 'manual', signal,
    headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}`, ...HEADERS,
      ...(catalogue ? { 'X-GitHub-Api-Version': '2026-06-01' } : {}) },
  }), signal, response => {
    void response.body?.cancel('oauth-response-abandoned').catch(() => undefined);
  });
  const length = response.headers.get('content-length');
  if (!response.ok || length !== null && (!/^(0|[1-9]\d*)$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('GitHub Copilot authentication failed.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid GitHub Copilot response.');
  const chunks: Uint8Array[] = []; let bytes = 0, complete = false;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) { complete = true; break; }
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Invalid GitHub Copilot response.');
      chunks.push(item.value);
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid GitHub Copilot response.');
    return parsed as Record<string, unknown>;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A cancelled hostile reader may still be pending. */ }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function availableModels(body: Record<string, unknown>, baseUrl: string): string[] {
  if (!Array.isArray(body.data) || body.data.length > 2048) throw new Error('Invalid GitHub Copilot models response.');
  const models = body.data.flatMap(value => {
    const item = record(value), id = item?.id;
    if (!item || typeof id !== 'string' || !id || id.length > 256 || UNSAFE_TEXT.test(id)) return [];
    if (record(record(item.capabilities)?.supports)?.tool_calls === false) return [];
    return [{ id, picker: item.model_picker_enabled === true, state: record(item.policy)?.state }];
  });
  const selected = models.filter(model => model.picker && model.state !== 'disabled');
  // The pinned Individual endpoint permits a policy fallback when every picker flag is false.
  const available = selected.length || baseUrl !== 'https://api.individual.githubcopilot.com'
    ? selected : models.filter(model => model.state === 'enabled');
  return [...new Set(available.map(model => model.id))];
}

/** Exchange/refresh only. Never enables model policies or persists a partial result. */
export async function exchangeGitHubCopilotToken(githubToken: string, options: {
  enterpriseDomain?: string; signal?: AbortSignal; fetcher?: typeof fetch; now?: number; redactor?: CredentialRedactor;
} = {}): Promise<GitHubCopilotOAuthCredential> {
  if (!token(githubToken)) throw new Error('Invalid GitHub Copilot GitHub token.');
  options.redactor?.add(githubToken);
  const config = getGitHubCopilotOAuthConfig(options.enterpriseDomain);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const fetcher = options.fetcher ?? fetch;
  try {
    const body = await requestJson(config.exchangeUrl, githubToken, signal, fetcher);
    options.redactor?.add(typeof body.token === 'string' ? body.token : undefined);
    const expiresAt = typeof body.expires_at === 'number' ? body.expires_at * 1000 - 300_000 : NaN;
    if (!token(body.token) || !Number.isSafeInteger(expiresAt) || expiresAt <= (options.now ?? Date.now())) throw new Error('Invalid GitHub Copilot token response.');
    const baseUrl = getGitHubCopilotBaseUrl(body.token, options.enterpriseDomain);
    const catalogue = await requestJson(`${baseUrl}/models`, body.token, signal, fetcher, true);
    if (signal.aborted) throw new Error('GitHub Copilot authentication cancelled.');
    return { accessToken: body.token, refreshToken: githubToken, expiresAt, baseUrl,
      availableModelIds: availableModels(catalogue, baseUrl),
      ...(options.enterpriseDomain === undefined ? {} : { enterpriseDomain: domain(options.enterpriseDomain) }) };
  } catch {
    throw new Error(signal.aborted ? 'GitHub Copilot authentication cancelled.' : 'GitHub Copilot authentication failed.');
  }
}
