import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { CredentialRedactor } from '@ai-harness/core';
import {
  clearWebSessions,
  createWebSession,
  credentialRedactionMiddleware,
  isAllowedOrigin,
  originMiddleware,
  publicRequestOrigin,
  rateLimit,
  safeErrorHandler,
  webAuthenticationStatus,
} from './request-security.js';

afterEach(() => {
  clearWebSessions();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function responseRecorder() {
  const headers = new Map<string, string | number>();
  const response = {
    headersSent: false,
    statusCode: 200,
    body: undefined as unknown,
    setHeader: (name: string, value: string | number) => { headers.set(name, value); },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return { response: response as unknown as Response, state: response, headers };
}

describe('request security', () => {
  it('expires opaque Web sessions and never stores the bearer token in the cookie value', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-secret');
    vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin-secret');
    vi.stubEnv('AI_HARNESS_WEB_SESSION_TTL_MS', String(5 * 60_000));
    const session = createWebSession('user-secret')!;
    expect(session.token).not.toContain('user-secret');
    const request = { headers: { cookie: `aih_session=${session.token}` } } as Request;
    expect(webAuthenticationStatus(request)).toMatchObject({ authenticated: true, role: 'user' });
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(webAuthenticationStatus(request)).toEqual({ required: true, authenticated: false });
  });

  it('treats malformed or oversized session cookies as unauthenticated', () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-secret');
    expect(webAuthenticationStatus({ headers: { cookie: 'aih_session=%E0%A4%A' } } as Request))
      .toEqual({ required: true, authenticated: false });
    expect(webAuthenticationStatus({ headers: { cookie: `aih_session=${'x'.repeat(4_097)}` } } as Request))
      .toEqual({ required: true, authenticated: false });
  });

  it('accepts only configured or same-host browser origins', () => {
    const request = { headers: { host: 'localhost:3080', origin: 'http://localhost:3080' } } as Request;
    expect(isAllowedOrigin(request)).toBe(true);
    expect(isAllowedOrigin({ headers: { host: 'localhost:3080', origin: 'https://evil.invalid' } } as Request)).toBe(false);
    expect(isAllowedOrigin({ headers: { host: 'rebind.attacker:3080', origin: 'http://rebind.attacker:3080' } } as Request))
      .toBe(false);
    vi.stubEnv('AI_HARNESS_ALLOWED_ORIGINS', 'https://trusted.example,https://trusted.example/path');
    expect(isAllowedOrigin({ headers: { host: 'localhost:3080', origin: 'https://trusted.example' } } as Request)).toBe(true);
  });

  it('rate-limits by Express client IP without path or forwarded-address bypasses', () => {
    const limiter = rateLimit({ max: 2, windowMs: 60_000 });
    const next = vi.fn() as NextFunction;
    const first = responseRecorder();
    const second = responseRecorder();
    const blocked = responseRecorder();
    for (const [index, target] of [first, second, blocked].entries()) {
      limiter({
        ip: '127.0.0.1', method: 'GET', path: `/api/files/${index}`,
        headers: { 'x-forwarded-for': crypto.randomUUID() },
      } as unknown as Request, target.response, next);
    }
    expect(next).toHaveBeenCalledTimes(2);
    expect(blocked.state).toMatchObject({ statusCode: 429, body: { error: 'Trop de requêtes' } });
    expect(blocked.headers.get('Retry-After')).toBeDefined();
  });

  it('rejects hostile origins on safe methods and derives links only from configured or loopback origins', () => {
    const middleware = originMiddleware();
    const next = vi.fn();
    const rejected = responseRecorder();
    middleware({
      method: 'GET', headers: { host: 'localhost:3080', origin: 'https://evil.invalid' },
    } as Request, rejected.response, next);
    expect(rejected.state.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();

    const loopback = {
      headers: { host: '127.0.0.1:3080' }, socket: { encrypted: false },
    } as unknown as Request;
    expect(publicRequestOrigin(loopback)).toBe('http://127.0.0.1:3080');
    expect(publicRequestOrigin({
      headers: { host: 'rebind.attacker:3080' }, socket: { encrypted: false },
    } as unknown as Request)).toBeUndefined();

    vi.stubEnv('AI_HARNESS_PUBLIC_URL', 'https://public.example/base/');
    expect(publicRequestOrigin(loopback)).toBe('https://public.example/base');
    vi.stubEnv('AI_HARNESS_PUBLIC_URL', 'https://user:secret@public.example/');
    expect(publicRequestOrigin(loopback)).toBe('http://127.0.0.1:3080');
  });

  it('redacts nested JSON responses and safe client errors at the HTTP boundary', () => {
    const redactor = new CredentialRedactor(['runtime-secret']);
    const recorded = responseRecorder();
    const next = vi.fn();
    credentialRedactionMiddleware(redactor)({} as Request, recorded.response, next);
    recorded.response.json({ nested: { token: 'prefix runtime-secret' } });
    expect(recorded.state.body).toEqual({ nested: { token: 'prefix [REDACTED]' } });
    expect(next).toHaveBeenCalledOnce();

    const client = responseRecorder();
    safeErrorHandler(
      Object.assign(new Error('bad runtime-secret'), { status: 400 }),
      {} as Request,
      client.response,
      vi.fn(),
      redactor,
    );
    expect(client.state.body).toEqual({ error: 'bad [REDACTED]', code: undefined });
  });

  it('neutralizes internal errors while preserving safe client error codes', () => {
    const internal = responseRecorder();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    safeErrorHandler(new Error('database password leaked'), {} as Request, internal.response, vi.fn());
    expect(internal.state).toMatchObject({ statusCode: 500, body: { error: 'Internal server error' } });
    errorSpy.mockRestore();

    const client = responseRecorder();
    safeErrorHandler(Object.assign(new Error('Approval required'), { status: 409, code: 'PROJECT_TRUST_REQUIRED' }), {} as Request, client.response, vi.fn());
    expect(client.state).toMatchObject({
      statusCode: 409,
      body: { error: 'Approval required', code: 'PROJECT_TRUST_REQUIRED' },
    });
  });
});
