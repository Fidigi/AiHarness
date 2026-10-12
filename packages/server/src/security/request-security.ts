import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { CredentialRedactor } from '@ai-harness/core';

export type ApiRole = 'anonymous' | 'user' | 'admin';
export type ApiCapability =
  | 'chat'
  | 'sessions'
  | 'workspace:read'
  | 'workspace:write'
  | 'files:read'
  | 'files:write'
  | 'terminal'
  | 'configuration'
  | 'credentials'
  | 'packages';

export interface AuthContext {
  role: ApiRole;
  capabilities: ReadonlySet<ApiCapability>;
}

const USER_CAPABILITIES = new Set<ApiCapability>([
  'chat', 'sessions', 'workspace:read', 'files:read',
]);
const ADMIN_CAPABILITIES = new Set<ApiCapability>([
  ...USER_CAPABILITIES,
  'workspace:write', 'files:write', 'terminal', 'configuration', 'credentials', 'packages',
]);
const contexts = new WeakMap<Request, AuthContext>();
const WEB_SESSION_COOKIE = 'aih_session';
const MAX_WEB_SESSIONS = 10_000;
const MAX_RATE_BUCKETS = 10_000;
const webSessions = new Map<string, { role: 'user' | 'admin'; expiresAt: number }>();

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      const encoded = value.join('=');
      if (!encoded || encoded.length > 4_096) return undefined;
      try { return decodeURIComponent(encoded); }
      catch { return undefined; }
    }
  }
  return undefined;
}

function webSession(header: string | undefined): { token: string; role: 'user' | 'admin'; expiresAt: number } | undefined {
  const token = cookieValue(header, WEB_SESSION_COOKIE);
  if (!token) return undefined;
  const session = webSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    webSessions.delete(token);
    return undefined;
  }
  return { token, ...session };
}

export function webAuthenticationStatus(request: Request): {
  required: boolean;
  authenticated: boolean;
  role?: ApiRole;
  expiresAt?: string;
} {
  const required = Boolean(process.env.AI_HARNESS_AUTH_TOKEN || process.env.AI_HARNESS_ADMIN_TOKEN);
  if (!required) return { required: false, authenticated: true, role: 'admin' };
  const session = webSession(request.headers.cookie);
  return session
    ? { required: true, authenticated: true, role: session.role, expiresAt: new Date(session.expiresAt).toISOString() }
    : { required: true, authenticated: false };
}

export function createWebSession(providedToken: string): { token: string; role: 'user' | 'admin'; expiresAt: Date } | undefined {
  const userToken = process.env.AI_HARNESS_AUTH_TOKEN || undefined;
  const adminToken = process.env.AI_HARNESS_ADMIN_TOKEN || userToken;
  const role = equalsSecret(providedToken, adminToken) ? 'admin'
    : equalsSecret(providedToken, userToken) ? 'user' : undefined;
  if (!role) return undefined;
  const now = Date.now();
  if (webSessions.size >= MAX_WEB_SESSIONS) {
    for (const [existing, session] of webSessions) {
      if (session.expiresAt <= now) webSessions.delete(existing);
    }
    while (webSessions.size >= MAX_WEB_SESSIONS) {
      const oldest = webSessions.keys().next().value as string | undefined;
      if (!oldest) break;
      webSessions.delete(oldest);
    }
  }
  const token = randomBytes(32).toString('base64url');
  const ttlMs = Math.max(5 * 60_000, Math.min(7 * 24 * 60 * 60_000,
    Number(process.env.AI_HARNESS_WEB_SESSION_TTL_MS) || 8 * 60 * 60_000));
  const expiresAt = new Date(now + ttlMs);
  webSessions.set(token, { role, expiresAt: expiresAt.getTime() });
  return { token, role, expiresAt };
}

export function revokeWebSession(request: Request): void {
  const token = cookieValue(request.headers.cookie, WEB_SESSION_COOKIE);
  if (token) webSessions.delete(token);
}

/** Invalidate process-local browser sessions when a Server composition root is replaced. */
export function clearWebSessions(): void {
  webSessions.clear();
}

export { WEB_SESSION_COOKIE };

function equalsSecret(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function bearer(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function requestOrigin(request: Request | IncomingMessage): string | undefined {
  const value = request.headers.origin;
  return Array.isArray(value) ? value[0] : value;
}

function canonicalHttpOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname !== '/') return undefined;
    return parsed.origin;
  } catch { return undefined; }
}

function loopbackHost(host: string | undefined): string | undefined {
  if (!host || host.length > 255 || /[\u0000-\u0020\u007f]/u.test(host)) return undefined;
  try {
    const parsed = new URL(`http://${host}`);
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return undefined;
    return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
      ? parsed.host
      : undefined;
  } catch { return undefined; }
}

function expectedOrigins(request: Request | IncomingMessage): Set<string> {
  const source = process.env.AI_HARNESS_ALLOWED_ORIGINS;
  const configured = source && source.length <= 64 * 1024
    ? source.split(',').slice(0, 128)
      .map(value => canonicalHttpOrigin(value.trim()))
      .filter((value): value is string => value !== undefined)
    : [];
  const host = loopbackHost(request.headers.host);
  if (host) configured.push(`http://${host}`, `https://${host}`);
  return new Set(configured);
}

/** Resolve an operator-configured public base URL or a direct loopback request origin. */
export function publicRequestOrigin(request: Request | IncomingMessage): string | undefined {
  const configured = process.env.AI_HARNESS_PUBLIC_URL?.trim();
  if (configured && configured.length <= 2_048) {
    try {
      const parsed = new URL(configured);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
        return configured.replace(/\/+$/u, '');
      }
    } catch { /* Invalid operator configuration is ignored rather than reflected. */ }
  }
  const host = loopbackHost(request.headers.host);
  if (!host) return undefined;
  const forwarded = process.env.AI_HARNESS_TRUST_PROXY === '1' ? request.headers['x-forwarded-proto'] : undefined;
  const forwardedProtocol = typeof forwarded === 'string' && /^(?:http|https)$/u.test(forwarded)
    ? forwarded : undefined;
  const encrypted = Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted);
  return `${forwardedProtocol ?? (encrypted ? 'https' : 'http')}://${host}`;
}

export function isAllowedOrigin(request: Request | IncomingMessage): boolean {
  const origin = requestOrigin(request);
  if (!origin) return true; // Non-browser and same-origin requests commonly omit Origin.
  if (origin.length > 2_048 || canonicalHttpOrigin(origin) !== origin) return false;
  return expectedOrigins(request).has(origin);
}

export function authenticationMiddleware(): RequestHandler {
  return (request, response, next) => {
    const userToken = process.env.AI_HARNESS_AUTH_TOKEN || undefined;
    const adminToken = process.env.AI_HARNESS_ADMIN_TOKEN || userToken;
    const token = bearer(request.headers.authorization);
    const browserSession = webSession(request.headers.cookie);
    let context: AuthContext;
    if (!userToken && !adminToken) context = { role: 'admin', capabilities: ADMIN_CAPABILITIES };
    else if (browserSession?.role === 'admin' || equalsSecret(token, adminToken)) context = { role: 'admin', capabilities: ADMIN_CAPABILITIES };
    else if (browserSession?.role === 'user' || equalsSecret(token, userToken)) context = { role: 'user', capabilities: USER_CAPABILITIES };
    else {
      response.status(401).json({ error: 'Authentification requise' });
      return;
    }
    contexts.set(request, context);
    next();
  };
}

export function originMiddleware(): RequestHandler {
  return (request, response, next) => {
    if (isAllowedOrigin(request)) {
      next();
      return;
    }
    response.status(403).json({ error: 'Origin non autorisée' });
  };
}

export function requireCapability(capability: ApiCapability): RequestHandler {
  return (request, response, next) => {
    const context = contexts.get(request);
    if (!context?.capabilities.has(capability)) {
      response.status(403).json({ error: 'Permission insuffisante' });
      return;
    }
    next();
  };
}

export function getAuthContext(request: Request): AuthContext {
  return contexts.get(request) ?? { role: 'anonymous', capabilities: new Set() };
}

interface RateBucket {
  resetAt: number;
  count: number;
}

/** Small in-process limiter; deployments with multiple replicas should also limit at the proxy. */
export function rateLimit(options: { windowMs?: number; max?: number } = {}): RequestHandler {
  const windowMs = Number.isFinite(options.windowMs)
    ? Math.max(1_000, Math.min(60 * 60_000, Math.floor(options.windowMs!))) : 60_000;
  const max = Number.isFinite(options.max)
    ? Math.max(1, Math.min(100_000, Math.floor(options.max!))) : 300;
  const buckets = new Map<string, RateBucket>();
  return (request, response, next) => {
    const now = Date.now();
    // Express derives `request.ip` according to its explicit `trust proxy` setting.
    // Never trust a caller-supplied X-Forwarded-For header directly here.
    const key = `${request.ip}:${request.method}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= MAX_RATE_BUCKETS) {
        for (const [existing, candidate] of buckets) {
          if (candidate.resetAt <= now) buckets.delete(existing);
        }
        while (buckets.size >= MAX_RATE_BUCKETS) {
          const oldest = buckets.keys().next().value as string | undefined;
          if (!oldest) break;
          buckets.delete(oldest);
        }
      }
      buckets.set(key, { resetAt: now + windowMs, count: 1 });
      next();
      return;
    }
    bucket.count = Math.min(max + 1, bucket.count + 1);
    response.setHeader('RateLimit-Limit', max);
    response.setHeader('RateLimit-Remaining', Math.max(0, max - bucket.count));
    response.setHeader('RateLimit-Reset', Math.ceil(bucket.resetAt / 1_000));
    if (bucket.count > max) {
      response.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)));
      response.status(429).json({ error: 'Trop de requêtes' });
      return;
    }
    next();
  };
}

function decodeProtocolToken(header: string | string[] | undefined): string | undefined {
  const source = Array.isArray(header) ? header.join(',') : header ?? '';
  if (source.length > 16 * 1024) return undefined;
  const protocols = source.split(',').map(value => value.trim());
  const encoded = protocols.find(value => value.startsWith('aih.bearer.'))?.slice('aih.bearer.'.length);
  if (!encoded || encoded.length > 14_000 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length > 10_000 || bytes.toString('base64url') !== encoded) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function authenticateUpgrade(request: IncomingMessage): AuthContext | undefined {
  if (!isAllowedOrigin(request)) return undefined;
  let requestUrl: URL;
  try { requestUrl = new URL(request.url || '/', 'http://localhost'); }
  catch { return undefined; }
  // The WebSocket endpoint has no query contract; rejecting all query parameters keeps
  // bearer values out of access logs even when another credential would authenticate.
  if (requestUrl.search) return undefined;
  const userToken = process.env.AI_HARNESS_AUTH_TOKEN || undefined;
  const adminToken = process.env.AI_HARNESS_ADMIN_TOKEN || userToken;
  if (!userToken && !adminToken) return { role: 'admin', capabilities: ADMIN_CAPABILITIES };
  const browserSession = webSession(request.headers.cookie);
  // Credentials are accepted only in non-reflected headers/cookies; URL query strings
  // are routinely retained by access logs and must never carry a bearer token.
  const token = bearer(request.headers.authorization)
    ?? decodeProtocolToken(request.headers['sec-websocket-protocol'])
    ?? undefined;
  if (browserSession?.role === 'admin' || equalsSecret(token, adminToken)) return { role: 'admin', capabilities: ADMIN_CAPABILITIES };
  if (browserSession?.role === 'user' || equalsSecret(token, userToken)) return { role: 'user', capabilities: USER_CAPABILITIES };
  return undefined;
}

/** Redact every JSON response before Express serializes it for HTTP/browser consumers. */
export function credentialRedactionMiddleware(redactor: CredentialRedactor): RequestHandler {
  return (_request, response, next) => {
    const json = response.json.bind(response);
    response.json = ((body: unknown) => json(redactor.redactJson(body))) as Response['json'];
    next();
  };
}

export function safeErrorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
  redactor?: CredentialRedactor,
): void {
  let candidateStatus: number | undefined;
  try {
    const candidate = typeof error === 'object' && error && 'status' in error
      ? (error as { status?: unknown }).status : undefined;
    if (typeof candidate === 'number') candidateStatus = candidate;
  } catch { /* Hostile error objects do not control the public response. */ }
  const explicitStatus = Number.isSafeInteger(candidateStatus)
    && candidateStatus! >= 400 && candidateStatus! <= 599 ? candidateStatus : undefined;
  let code = '';
  try {
    const candidate = typeof error === 'object' && error && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (typeof candidate === 'string' && /^[A-Z0-9_:-]{1,64}$/u.test(candidate)) code = candidate;
  } catch { /* Hostile error objects do not control the public response. */ }
  const status = explicitStatus ?? ({
    INVALID_PATH: 400,
    OUTSIDE_ALLOWED_ROOTS: 403,
    NOT_FOUND: 404,
    WRONG_KIND: 400,
    GIT_ERROR: 409,
  } as Record<string, number>)[code] ?? 500;
  let rawMessage = 'Request failed';
  try { rawMessage = error instanceof Error ? error.message : String(error ?? rawMessage); }
  catch { /* Keep the stable fallback. */ }
  const redactedMessage = redactor?.redact(rawMessage) ?? rawMessage;
  const message = redactedMessage
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, ' ')
    .slice(0, 4_096);
  if (status >= 500) console.error('[Server] Request failed.');
  if (!response.headersSent) {
    response.status(status).json({
      error: status >= 500 ? 'Internal server error' : message,
      ...(status < 500 && code ? { code } : {}),
    });
  } else {
    response.destroy();
  }
}
