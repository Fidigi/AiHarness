import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

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
const webSessions = new Map<string, { role: 'user' | 'admin'; expiresAt: number }>();

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
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
  const token = randomBytes(32).toString('base64url');
  const ttlMs = Math.max(5 * 60_000, Math.min(7 * 24 * 60 * 60_000,
    Number(process.env.AI_HARNESS_WEB_SESSION_TTL_MS) || 8 * 60 * 60_000));
  const expiresAt = new Date(Date.now() + ttlMs);
  webSessions.set(token, { role, expiresAt: expiresAt.getTime() });
  return { token, role, expiresAt };
}

export function revokeWebSession(request: Request): void {
  const token = cookieValue(request.headers.cookie, WEB_SESSION_COOKIE);
  if (token) webSessions.delete(token);
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

function expectedOrigins(request: Request | IncomingMessage): Set<string> {
  const configured = process.env.AI_HARNESS_ALLOWED_ORIGINS
    ?.split(',')
    .map(value => value.trim())
    .filter(Boolean) ?? [];
  const host = request.headers.host;
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const protocol = typeof forwardedProtocol === 'string'
    ? forwardedProtocol.split(',')[0].trim()
    : 'http';
  if (host) {
    configured.push(`${protocol}://${host}`);
    if (protocol === 'http') configured.push(`https://${host}`);
  }
  return new Set(configured);
}

export function isAllowedOrigin(request: Request | IncomingMessage): boolean {
  const origin = requestOrigin(request);
  if (!origin) return true; // Non-browser and same-origin requests commonly omit Origin.
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
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || isAllowedOrigin(request)) {
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
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 300;
  const buckets = new Map<string, RateBucket>();
  return (request, response, next) => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
    }
    // Express derives `request.ip` according to its explicit `trust proxy` setting.
    // Never trust a caller-supplied X-Forwarded-For header directly here.
    const key = `${request.ip}:${request.path.split('/').slice(0, 3).join('/')}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { resetAt: now + windowMs, count: 1 });
      next();
      return;
    }
    bucket.count++;
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
  const protocols = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(value => value.trim());
  const encoded = protocols.find(value => value.startsWith('aih.bearer.'))?.slice('aih.bearer.'.length);
  if (!encoded) return undefined;
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

export function authenticateUpgrade(request: IncomingMessage): AuthContext | undefined {
  if (!isAllowedOrigin(request)) return undefined;
  const userToken = process.env.AI_HARNESS_AUTH_TOKEN || undefined;
  const adminToken = process.env.AI_HARNESS_ADMIN_TOKEN || userToken;
  if (!userToken && !adminToken) return { role: 'admin', capabilities: ADMIN_CAPABILITIES };
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const browserSession = webSession(request.headers.cookie);
  const token = bearer(request.headers.authorization)
    ?? decodeProtocolToken(request.headers['sec-websocket-protocol'])
    // Kept for old clients; new browser clients use Sec-WebSocket-Protocol.
    ?? url.searchParams.get('token')
    ?? undefined;
  if (browserSession?.role === 'admin' || equalsSecret(token, adminToken)) return { role: 'admin', capabilities: ADMIN_CAPABILITIES };
  if (browserSession?.role === 'user' || equalsSecret(token, userToken)) return { role: 'user', capabilities: USER_CAPABILITIES };
  return undefined;
}

export function safeErrorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  const explicitStatus = typeof error === 'object' && error && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined;
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  const status = explicitStatus ?? ({
    INVALID_PATH: 400,
    OUTSIDE_ALLOWED_ROOTS: 403,
    NOT_FOUND: 404,
    WRONG_KIND: 400,
    GIT_ERROR: 409,
  } as Record<string, number>)[code] ?? 500;
  if (status >= 500) console.error('[Server] Request failed:', error);
  if (!response.headersSent) response.status(status).json({
    error: status >= 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Request failed',
    ...(status < 500 && code ? { code } : {}),
  });
}
