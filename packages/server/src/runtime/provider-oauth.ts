import crypto from 'node:crypto';
import { beginOpenAICodexBrowserLogin, type OpenAICodexBrowserLogin, beginOpenAICodexDeviceLogin, OPENAI_CODEX_MODELS, exchangeGitHubCopilotToken, getGitHubCopilotOAuthConfig, GITHUB_COPILOT_MODELS, type ProviderCredentialService } from '@ai-harness/core';
import { beginRadiusBrowserLogin, beginRadiusDeviceLogin, beginKimiCodingDeviceLogin, beginMetaDeviceLogin, MetaOAuthSetupRequiredError, beginOpenRouterLogin, beginAnthropicBrowserLogin, beginAnthropicCopyCodeLogin, type AnthropicLogin, type RadiusBrowserLogin, type OpenRouterLogin } from '@ai-harness/core';
import type { ProviderRegistryService } from './provider-registry.js';
import type { AiProxyServer } from '../api/proxy.js';
type RadiusContext = Awaited<ReturnType<ProviderRegistryService['prepareNativeOAuth']>>;
export function customRadiusOAuthContext(services: Promise<{ providerRegistry: ProviderRegistryService; modelCatalog: { invalidateProvider(provider: string): void } }>) {
  return async (provider: string, signal: AbortSignal): Promise<RadiusContext> => {
    const runtime = await services, context = await runtime.providerRegistry.prepareNativeOAuth(provider, signal);
    return { ...context, publish: async credential => {
      const admit = await context.publish(credential);
      return () => { admit(); runtime.modelCatalog.invalidateProvider(provider); };
    } };
  };
}
import { gitHubCopilotCredentialSource } from './github-copilot.js';
import { openAICodexCredentialSource } from './openai-codex.js';

const SUPPORTED = new Set(['openai', 'anthropic', 'google', 'azure', 'vertex', 'local']);
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const MAX_OAUTH_TOKEN_BYTES = 64 * 1024;
const MAX_OAUTH_POLLS = 600;

interface OAuthConfig {
  deviceUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
  subscription?: true;
  enterpriseDomain?: string;
}

interface OAuthFlow {
  id: string;
  provider: string;
  state: 'pending' | 'connected' | 'failed' | 'cancelled' | 'expired';
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  authorizationUrl?: string;
  browser?: OpenAICodexBrowserLogin | RadiusBrowserLogin | OpenRouterLogin | AnthropicLogin;
  radiusPublish?: RadiusContext['publish'];
  completing?: boolean;
  expiresAt: string;
  intervalSeconds: number;
  deviceCode: string;
  error?: string;
  controller: AbortController;
  credentials?: ProviderCredentialService;
  publish?: Awaited<ReturnType<ProviderCredentialService['prepareOAuthLogin']>>;
}

export interface PublicOAuthFlow {
  id: string;
  provider: string;
  state: OAuthFlow['state'];
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  authorizationUrl?: string;
  expiresAt: string;
  error?: string;
}

function prefix(provider: string): string {
  return `AI_HARNESS_OAUTH_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function safeEndpoint(value: string, label: string, status = 400): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2_000
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error(`${label} is too long.`), { status });
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw Object.assign(new Error(`${label} must use HTTPS without embedded credentials or fragments.`), { status }); }
  if (url.username || url.password || url.hash
    || (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.protocol === 'http:'))) {
    throw Object.assign(new Error(`${label} must use HTTPS without embedded credentials or fragments.`), { status });
  }
  return url.toString();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, abandon?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abandon?.(value);
      resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(contentLength)
    || Number(contentLength) > MAX_OAUTH_RESPONSE_BYTES)) {
    void response.body?.cancel('oauth-response-limit').catch(() => undefined);
    throw new Error('OAuth response is too large.');
  }
  if (!response.body?.getReader) throw new Error('OAuth response is invalid.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let completed = false;
  let text: string;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) { completed = true; break; }
      bytes += item.value.byteLength;
      if (bytes > MAX_OAUTH_RESPONSE_BYTES) {
        void reader.cancel('oauth-response-limit').catch(() => undefined);
        throw new Error('OAuth response is too large.');
      }
      chunks.push(item.value);
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks.map(chunk => Buffer.from(chunk))),
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof Error && error.message === 'OAuth response is too large.') throw error;
    throw new Error('OAuth response is invalid.');
  } finally {
    if (!completed) void reader.cancel('oauth-response-abandoned').catch(() => undefined);
    try { reader.releaseLock(); } catch { /* Pending hostile readers are already aborted. */ }
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('OAuth response is invalid.');
  }
}

function boundedRemoteValue(value: unknown, maxBytes: number): string | undefined {
  return typeof value === 'string' && value.length > 0
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && Buffer.byteLength(value) <= maxBytes ? value : undefined;
}

function config(provider: string): OAuthConfig | undefined {
  if (provider === 'github-copilot') {
    const issuer = getGitHubCopilotOAuthConfig(process.env.GITHUB_COPILOT_ENTERPRISE_DOMAIN);
    return { deviceUrl: issuer.deviceAuthorizationUrl, tokenUrl: issuer.tokenUrl,
      clientId: issuer.clientId, scope: issuer.scope, subscription: true,
      ...(issuer.enterpriseDomain === undefined ? {} : { enterpriseDomain: issuer.enterpriseDomain }) };
  }
  const key = prefix(provider);
  const deviceUrl = process.env[`${key}_DEVICE_URL`];
  const tokenUrl = process.env[`${key}_TOKEN_URL`];
  const clientId = process.env[`${key}_CLIENT_ID`];
  if (!deviceUrl || !tokenUrl || !clientId) return undefined;
  if (Buffer.byteLength(clientId) > 1_000 || /[\u0000-\u001f\u007f]/u.test(clientId)) {
    throw Object.assign(new Error('OAuth client id is invalid.'), { status: 400 });
  }
  const scope = process.env[`${key}_SCOPE`];
  if (scope && (Buffer.byteLength(scope) > 4_000 || /[\u0000-\u001f\u007f]/u.test(scope))) {
    throw Object.assign(new Error('OAuth scope is invalid.'), { status: 400 });
  }
  return {
    deviceUrl: safeEndpoint(deviceUrl, 'OAuth device endpoint'),
    tokenUrl: safeEndpoint(tokenUrl, 'OAuth token endpoint'),
    clientId,
    ...(scope ? { scope } : {}),
  };
}

/** Bounded in-memory OAuth device grants; access tokens go directly to the credential store/provider. */
export class ProviderOAuthService {
  private readonly flows = new Map<string, OAuthFlow>();
  private readonly starting = new Map<string, AbortController>();
  private readonly lifetime = new AbortController();

  private readonly requestTimeoutMs: number;

  constructor(
    private readonly proxy: AiProxyServer,
    private readonly credentials: () => ProviderCredentialService | undefined,
    private readonly fetcher: typeof fetch = fetch,
    requestTimeoutMs = 15_000,
    private readonly radius?: (provider: string, signal: AbortSignal) => Promise<RadiusContext>,
  ) {
    this.requestTimeoutMs = Number.isSafeInteger(requestTimeoutMs)
      ? Math.max(1, Math.min(60_000, requestTimeoutMs))
      : 15_000;
  }

  isSupported(provider: string): boolean {
    try { return provider === 'openai-codex' || (SUPPORTED.has(provider) || provider === 'github-copilot') && Boolean(config(provider)); } catch { return false; }
  }

  async start(providerValue: string, signal?: AbortSignal, method: 'device' | 'browser' | 'copy-code' = 'device'): Promise<PublicOAuthFlow> {
    if (typeof providerValue !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(providerValue)) {
      throw Object.assign(new Error('OAuth is unavailable for this provider.'), { status: 404 });
    }
    const provider = providerValue.trim().toLowerCase();
    if (!SUPPORTED.has(provider) && provider !== 'github-copilot' && provider !== 'openai-codex') return this.startRadius(provider, signal, method);
    if (this.lifetime.signal.aborted) throw Object.assign(new Error('OAuth service is closed.'), { status: 409 });
    const codex = provider === 'openai-codex';
    if (method !== 'device' && method !== 'browser' || method === 'browser' && !codex) {
      throw Object.assign(new Error('OAuth method is unavailable for this provider.'), { status: 400 });
    }
    const settings = codex ? undefined : config(provider);
    if (!settings && !codex) throw Object.assign(new Error('OAuth device flow is not configured for this provider.'), { status: 409 });
    const controller = new AbortController();
    const native = codex || settings?.subscription;
    const credentials = native ? this.credentials() : undefined;
    if (native && !credentials?.hasPersistentStore()) {
      throw Object.assign(new Error('OAuth credential storage is unavailable.'), { status: 409 });
    }
    // Reserve before the first remote request, including an unpublished device request.
    if (native) this.cancelProvider(provider);
    this.starting.set(provider, controller);
    const abort = (): void => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      const publish = credentials ? await credentials.prepareOAuthLogin(provider, controller.signal) : undefined;
      if (codex && method === 'browser') return this.startCodexBrowser(controller, credentials!, publish!);
      if (codex) return await this.startCodex(controller, credentials!, publish!);
      return await this.startFlow(provider, settings!, controller, credentials, publish);
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.starting.get(provider) === controller) this.starting.delete(provider);
    }
  }

  private async startRadius(provider: string, caller: AbortSignal | undefined, method: 'device' | 'browser' | 'copy-code'): Promise<PublicOAuthFlow> {
    if (!this.radius) throw Object.assign(new Error('OAuth is unavailable for this provider.'), { status: 404 });
    if (this.lifetime.signal.aborted) throw Object.assign(new Error('OAuth service is closed.'), { status: 409 });
    if (method !== 'device' && method !== 'browser' && method !== 'copy-code') throw Object.assign(new Error('OAuth method is unavailable for this provider.'), { status: 400 });
    caller?.throwIfAborted(); this.checkCapacity(); this.cancelProvider(provider);
    const controller = new AbortController(); this.starting.set(provider, controller);
    let signal = AbortSignal.any([controller.signal, this.lifetime.signal]); const abort = () => controller.abort();
    let registered = false;
    if (caller?.aborted) abort(); else caller?.addEventListener('abort', abort, { once: true });
    try {
      const context = await this.radius(provider, signal); signal = AbortSignal.any([signal, context.signal]); signal.throwIfAborted();
      if ((context.issuer === 'kimi-coding' || context.issuer === 'meta') && method !== 'device' || context.issuer === 'openrouter' && method !== 'browser' || context.issuer === 'radius' && method === 'copy-code' || context.issuer === 'anthropic' && method === 'device') throw Object.assign(new Error('OAuth method is unavailable for this provider.'), { status: 400 });
      const options = { signal, fetcher: this.fetcher, redactor: context.redactor };
      const device = method === 'device' ? context.issuer === 'meta' ? await beginMetaDeviceLogin(options) : context.issuer === 'kimi-coding' ? await beginKimiCodingDeviceLogin({ ...options, oauthHost: context.realm }) : await beginRadiusDeviceLogin({ ...options, gateway: context.realm }) : undefined;
      const browser = context.issuer === 'anthropic' ? method === 'copy-code' ? beginAnthropicCopyCodeLogin(options) : beginAnthropicBrowserLogin(options)
        : method === 'browser' ? context.issuer === 'openrouter' ? beginOpenRouterLogin(`http://127.0.0.1:1457/oauth/callback/${crypto.randomUUID()}`, options) : await beginRadiusBrowserLogin({ ...options, gateway: context.realm }) : undefined;
      const login = (device ?? browser)!; signal.throwIfAborted(); this.checkCapacity();
      const flow: OAuthFlow = { id: crypto.randomUUID(), provider, state: 'pending', userCode: device?.userCode ?? '', verificationUri: device?.verificationUri ?? '',
        ...(browser ? { authorizationUrl: browser.authorizationUrl, browser } : {}), radiusPublish: context.publish,
        expiresAt: new Date(login.expiresAt).toISOString(), intervalSeconds: 1, deviceCode: '', controller };
      this.flows.set(flow.id, flow); registered = true;
      const expiry = setTimeout(() => { if (flow.state === 'pending') { flow.state = 'expired'; controller.abort(); } }, Math.max(1, login.expiresAt - Date.now())); expiry.unref();
      signal.addEventListener('abort', () => { controller.abort(); if (flow.state === 'pending') flow.state = 'cancelled'; clearTimeout(expiry); login.cancel(); flow.browser = undefined; flow.authorizationUrl = undefined; }, { once: true });
      if (device) void (async () => {
        try {
          const credential = await device.complete(), admit = await context.publish(credential); signal.throwIfAborted();
          admit(); flow.state = 'connected';
        } catch (error) { if (flow.state === 'pending') { flow.state = 'failed'; flow.error = context.issuer === 'meta' && error instanceof MetaOAuthSetupRequiredError ? context.redactor.redact(error.message) : 'OAuth token exchange failed.'; } }
        finally { clearTimeout(expiry); device.cancel(); controller.abort(); }
      })();
      return this.public(flow);
    } finally { caller?.removeEventListener('abort', abort); if (!registered) controller.abort(); if (this.starting.get(provider) === controller) this.starting.delete(provider); }
  }

  private async startCodex(controller: AbortController, credentials: ProviderCredentialService,
    publish: NonNullable<OAuthFlow['publish']>): Promise<PublicOAuthFlow> {
    this.checkCapacity();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const device = await beginOpenAICodexDeviceLogin({ signal, fetcher: this.fetcher, redactor: credentials.redactor }).catch(() => {
      throw Object.assign(new Error('OAuth device authorization failed.'), { status: 502 });
    });
    if (signal.aborted) { device.cancel(); throw Object.assign(new Error('OAuth device authorization cancelled.'), { status: 409 }); }
    const flow: OAuthFlow = {
      id: crypto.randomUUID(), provider: 'openai-codex', state: 'pending', userCode: device.userCode,
      verificationUri: device.verificationUri, expiresAt: new Date(device.expiresAt).toISOString(),
      intervalSeconds: 1, deviceCode: '', controller,
    };
    this.flows.set(flow.id, flow);
    const expiry = setTimeout(() => {
      if (flow.state === 'pending') { flow.state = 'expired'; controller.abort(); }
    }, Math.max(1, device.expiresAt - Date.now()));
    void (async () => {
      try {
        const credential = await device.complete();
        await publish(credential);
        signal.throwIfAborted();
        // No await before runtime admission; the resolver borrows the host, not this login.
        this.proxy.setOpenAICodexSubscription(OPENAI_CODEX_MODELS[0]!.id, openAICodexCredentialSource(credentials, this.lifetime.signal));
        flow.state = 'connected';
      } catch {
        if (flow.state === 'pending') { flow.state = 'failed'; flow.error = 'OAuth token exchange failed.'; }
      } finally { clearTimeout(expiry); device.cancel(); }
    })();
    return this.public(flow);
  }

  private startCodexBrowser(controller: AbortController, credentials: ProviderCredentialService,
    publish: NonNullable<OAuthFlow['publish']>): PublicOAuthFlow {
    this.checkCapacity();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    signal.throwIfAborted();
    const browser = beginOpenAICodexBrowserLogin({ signal, fetcher: this.fetcher, redactor: credentials.redactor });
    const flow: OAuthFlow = { id: crypto.randomUUID(), provider: 'openai-codex', state: 'pending', userCode: '', verificationUri: '',
      authorizationUrl: browser.authorizationUrl, browser, expiresAt: new Date(browser.expiresAt).toISOString(),
      intervalSeconds: 1, deviceCode: '', controller, credentials, publish };
    this.flows.set(flow.id, flow);
    const expiry = setTimeout(() => { if (flow.state === 'pending') { flow.state = 'expired'; controller.abort(); } }, Math.max(1, browser.expiresAt - Date.now()));
    expiry.unref();
    signal.addEventListener('abort', () => { clearTimeout(expiry); browser.cancel(); flow.browser = undefined; flow.authorizationUrl = undefined; }, { once: true });
    return this.public(flow);
  }

  /** Owned redirect or explicit Anthropic copy-code only; no listener/client/endpoint authority from the caller. */
  async redirect(id: string, value: unknown, caller?: AbortSignal): Promise<PublicOAuthFlow> {
    this.prune();
    const flow = this.flows.get(id);
    if (!flow?.browser || flow.state !== 'pending' || flow.completing) throw Object.assign(new Error('OAuth browser flow is unavailable.'), { status: 409 });
    const browser = flow.browser;
    if (Date.now() >= Date.parse(flow.expiresAt)) {
      flow.state = 'expired'; flow.controller.abort(); throw Object.assign(new Error('OAuth browser flow is unavailable.'), { status: 409 });
    }
    if (typeof value !== 'string' || Buffer.byteLength(value) > 8192) throw Object.assign(new Error('Invalid OAuth redirect.'), { status: 400 });
    const abort = () => { this.cancel(id); };
    if (caller?.aborted) abort(); else caller?.addEventListener('abort', abort, { once: true });
    flow.completing = true;
    try {
      const credential = await browser.complete(value, flow.controller.signal);
      if (flow.radiusPublish) {
        const admit = await flow.radiusPublish(credential as Parameters<RadiusContext['publish']>[0]); flow.controller.signal.throwIfAborted();
        admit(); flow.state = 'connected'; return this.public(flow);
      }
      await flow.publish!(credential as Parameters<NonNullable<OAuthFlow['publish']>>[0]);
      flow.controller.signal.throwIfAborted();
      this.proxy.setOpenAICodexSubscription(OPENAI_CODEX_MODELS[0]!.id, openAICodexCredentialSource(flow.credentials!, this.lifetime.signal));
      flow.state = 'connected';
      return this.public(flow);
    } catch (error) {
      if (error instanceof Error && ['Invalid OpenAI Codex OAuth redirect.', 'Invalid Radius OAuth redirect.', 'Invalid OpenRouter OAuth redirect.', 'Invalid Anthropic OAuth redirect or code.'].includes(error.message) && flow.state === 'pending') {
        throw Object.assign(new Error('Invalid OAuth redirect.'), { status: 400 });
      }
      if (flow.state === 'pending') { flow.state = 'failed'; flow.error = 'OAuth token exchange failed.'; }
      throw Object.assign(new Error('OAuth browser completion failed.'), { status: flow.controller.signal.aborted ? 409 : 502 });
    } finally {
      caller?.removeEventListener('abort', abort); flow.completing = false;
      if (flow.state !== 'pending') { flow.controller.abort(); flow.browser = undefined; }
    }
  }

  private request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    return abortable(this.fetcher(url, init), signal, response => {
      void response.body?.cancel('oauth-response-abandoned').catch(() => undefined);
    });
  }

  private async startFlow(provider: string, settings: OAuthConfig, controller: AbortController,
    credentials?: ProviderCredentialService, publish?: OAuthFlow['publish']): Promise<PublicOAuthFlow> {
    this.checkCapacity();
    let response: Response;
    const requestSignal = AbortSignal.any([controller.signal, this.lifetime.signal, AbortSignal.timeout(this.requestTimeoutMs)]);
    try {
      if (requestSignal.aborted) throw requestSignal.reason;
      response = await this.request(settings.deviceUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
          ...(settings.subscription ? { 'User-Agent': 'GitHubCopilotChat/0.35.0' } : {}) },
        body: new URLSearchParams({ client_id: settings.clientId, ...(settings.scope ? { scope: settings.scope } : {}) }),
        signal: requestSignal,
      }, requestSignal);
    } catch {
      throw Object.assign(new Error('OAuth device authorization failed.'), { status: 502 });
    }
    if (!response.ok) {
      void response.body?.cancel('oauth-device-authorization-failed').catch(() => undefined);
      throw Object.assign(new Error('OAuth device authorization failed.'), { status: 502 });
    }
    let data: Record<string, unknown>;
    try { data = await boundedJson(response, requestSignal); }
    catch { throw Object.assign(new Error('OAuth response is invalid.'), { status: 502 }); }
    const deviceCode = boundedRemoteValue(data.device_code, 4_000);
    const userCode = boundedRemoteValue(data.user_code, 500);
    const verificationUri = boundedRemoteValue(data.verification_uri ?? data.verification_url, 2_000);
    const verificationUriComplete = data.verification_uri_complete === undefined
      ? undefined : boundedRemoteValue(data.verification_uri_complete, 2_000);
    if (!deviceCode || !userCode || !verificationUri
      || (data.verification_uri_complete !== undefined && !verificationUriComplete)) {
      throw Object.assign(new Error('OAuth response is invalid.'), { status: 502 });
    }
    let safeVerificationUri: string;
    let safeVerificationUriComplete: string | undefined;
    try {
      safeVerificationUri = safeEndpoint(verificationUri, 'OAuth verification URL', 502);
      safeVerificationUriComplete = verificationUriComplete
        ? safeEndpoint(verificationUriComplete, 'OAuth verification URL', 502)
        : undefined;
    } catch {
      throw Object.assign(new Error('OAuth response is invalid.'), { status: 502 });
    }
    const expiresIn = data.expires_in === undefined ? 900 : data.expires_in;
    const intervalSeconds = data.interval === undefined ? 5 : data.interval;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn < 1 || expiresIn > 3_600
      || typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds)
      || intervalSeconds < 1 || intervalSeconds > 30) {
      throw Object.assign(new Error('OAuth response is invalid.'), { status: 502 });
    }
    if (requestSignal.aborted) throw Object.assign(new Error('OAuth device authorization cancelled.'), { status: 409 });
    const flow: OAuthFlow = {
      id: crypto.randomUUID(), provider, state: 'pending',
      userCode,
      verificationUri: safeVerificationUri,
      ...(safeVerificationUriComplete ? { verificationUriComplete: safeVerificationUriComplete } : {}),
      expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
      intervalSeconds,
      deviceCode, controller, credentials, publish,
    };
    this.flows.set(flow.id, flow);
    const expiry = setTimeout(() => {
      if (flow.state === 'pending') {
        flow.state = 'expired';
        flow.deviceCode = '';
        controller.abort();
      }
    }, expiresIn * 1_000);
    void this.poll(flow, settings).finally(() => clearTimeout(expiry));
    return this.public(flow);
  }

  private checkCapacity(): void {
    this.prune();
    if (this.flows.size >= 100) {
      for (const [id, flow] of this.flows) {
        if (flow.state !== 'pending') this.flows.delete(id);
        if (this.flows.size < 100) break;
      }
    }
    if (this.flows.size >= 100) throw Object.assign(new Error('Too many active OAuth flows.'), { status: 429 });
  }

  get(id: string): PublicOAuthFlow | undefined {
    this.prune();
    const flow = this.flows.get(id);
    return flow ? this.public(flow) : undefined;
  }

  cancel(id: string): boolean {
    const flow = this.flows.get(id);
    if (!flow || flow.state !== 'pending') return false;
    flow.state = 'cancelled';
    flow.deviceCode = '';
    flow.controller.abort();
    return true;
  }

  cancelProvider(provider: string): void {
    this.starting.get(provider)?.abort();
    for (const flow of this.flows.values()) {
      if (flow.provider === provider) this.cancel(flow.id);
    }
  }

  close(): void {
    this.lifetime.abort();
    for (const controller of this.starting.values()) controller.abort();
    this.starting.clear();
    for (const flow of this.flows.values()) {
      flow.deviceCode = '';
      if (flow.state === 'pending') {
        flow.state = 'cancelled';
        flow.controller.abort();
      }
    }
    this.flows.clear();
  }

  private async poll(flow: OAuthFlow, settings: OAuthConfig): Promise<void> {
    let interval = flow.intervalSeconds * 1_000;
    let attempts = 0;
    while (flow.state === 'pending' && Date.now() < Date.parse(flow.expiresAt) && attempts < MAX_OAUTH_POLLS) {
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => {
            clearTimeout(timer);
            reject(new DOMException('Cancelled', 'AbortError'));
          };
          const timer = setTimeout(() => {
            flow.controller.signal.removeEventListener('abort', abort);
            resolve();
          }, interval);
          flow.controller.signal.addEventListener('abort', abort, { once: true });
          if (flow.controller.signal.aborted) abort();
        });
        attempts++;
        const requestSignal = AbortSignal.any([
          flow.controller.signal,
          AbortSignal.timeout(this.requestTimeoutMs),
        ]);
        if (requestSignal.aborted) throw requestSignal.reason;
        const response = await this.request(settings.tokenUrl, {
          method: 'POST', signal: requestSignal, redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
            ...(settings.subscription ? { 'User-Agent': 'GitHubCopilotChat/0.35.0' } : {}) },
          body: new URLSearchParams({
            client_id: settings.clientId, device_code: flow.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        }, requestSignal);
        const data = await boundedJson(response, requestSignal);
        const accessToken = boundedRemoteValue(data.access_token, MAX_OAUTH_TOKEN_BYTES);
        if (accessToken) {
          if (!response.ok) throw new Error('OAuth response is invalid.');
          if (settings.subscription) {
            const credentials = flow.credentials!;
            const exchanged = await exchangeGitHubCopilotToken(accessToken, {
              enterpriseDomain: settings.enterpriseDomain, signal: flow.controller.signal,
              fetcher: this.fetcher, redactor: credentials.redactor,
            });
            await flow.publish!({ accessToken: exchanged.accessToken, refreshToken: exchanged.refreshToken,
              expiresAt: exchanged.expiresAt, subscription: { provider: 'github-copilot',
                availableModelIds: exchanged.availableModelIds,
                ...(exchanged.enterpriseDomain === undefined ? {} : { enterpriseDomain: exchanged.enterpriseDomain }) } });
            flow.controller.signal.throwIfAborted();
            // No await before runtime admission: publication remains owner-bound.
            const model = GITHUB_COPILOT_MODELS.find(model => exchanged.availableModelIds.includes(model.id));
            if (model) this.proxy.setGitHubCopilotSubscription(model.id, gitHubCopilotCredentialSource(credentials, this.lifetime.signal));
            flow.state = 'connected';
            flow.deviceCode = '';
            return;
          }
          const refreshToken = data.refresh_token === undefined
            ? undefined : boundedRemoteValue(data.refresh_token, MAX_OAUTH_TOKEN_BYTES);
          const tokenType = data.token_type === undefined
            ? undefined : boundedRemoteValue(data.token_type, 32);
          if ((data.refresh_token !== undefined && !refreshToken)
            || (tokenType !== undefined && !/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(tokenType))
            || (data.token_type !== undefined && !tokenType)) {
            throw new Error('OAuth response is invalid.');
          }
          if (data.expires_in !== undefined && (typeof data.expires_in !== 'number'
            || !Number.isFinite(data.expires_in) || data.expires_in < 0
            || data.expires_in > 365 * 24 * 60 * 60)) {
            throw new Error('OAuth response is invalid.');
          }
          const expiresIn = data.expires_in as number | undefined;
          const credentialService = this.credentials();
          if (!(credentialService as (ProviderCredentialService & { hasPersistentStore?: () => boolean }) | undefined)
            ?.hasPersistentStore?.()) {
            throw new Error('OAuth credential storage is unavailable.');
          }
          await credentialService!.setOAuth(flow.provider, {
            accessToken,
            ...(refreshToken ? { refreshToken } : {}),
            ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + Math.floor(expiresIn * 1_000) }),
            ...(tokenType ? { tokenType } : {}),
          });
          this.proxy.setApiKey(flow.provider as Parameters<AiProxyServer['setApiKey']>[0], accessToken);
          flow.state = 'connected';
          flow.deviceCode = '';
          return;
        }
        if (data.access_token !== undefined) throw new Error('OAuth response is invalid.');
        if (data.error === 'authorization_pending') continue;
        if (data.error === 'slow_down') { interval = Math.min(60_000, interval + 5_000); continue; }
        flow.state = 'failed';
        flow.error = 'OAuth token exchange failed.';
        flow.deviceCode = '';
        return;
      } catch (error) {
        if (flow.controller.signal.aborted) { flow.deviceCode = ''; return; }
        flow.state = 'failed';
        flow.error = error instanceof DOMException && error.name === 'TimeoutError'
          ? 'OAuth token exchange timed out.' : 'OAuth token exchange failed.';
        flow.deviceCode = '';
        return;
      }
    }
    if (flow.state === 'pending') flow.state = 'expired';
    flow.deviceCode = '';
  }

  private public(flow: OAuthFlow): PublicOAuthFlow {
    return {
      id: flow.id, provider: flow.provider, state: flow.state, expiresAt: flow.expiresAt,
      ...(flow.state === 'pending' ? {
        ...(flow.authorizationUrl ? { authorizationUrl: flow.authorizationUrl } : { userCode: flow.userCode, verificationUri: flow.verificationUri }),
        ...(flow.verificationUriComplete ? { verificationUriComplete: flow.verificationUriComplete } : {}),
      } : {}),
      ...(flow.error ? { error: flow.error } : {}),
    };
  }

  private prune(): void {
    const threshold = Date.now() - 60 * 60_000;
    for (const [id, flow] of this.flows) {
      if (Date.parse(flow.expiresAt) < threshold) this.flows.delete(id);
    }
  }
}
