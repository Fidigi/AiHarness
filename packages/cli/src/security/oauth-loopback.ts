import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

interface BrowserLogin<T> {
  authorizationUrl: string;
  complete(redirectUrl: string, signal?: AbortSignal): Promise<T>;
  cancel(): void;
}
/** Internal CLI transport for the two fixed Core callback contracts; no operator bind override. */
export async function completeOAuthLoopback<T>(flow: BrowserLogin<T>, redirectUri: string, provider: 'OpenAI Codex' | 'Radius',
  instructions: (url: string) => void, signal: AbortSignal, publish: (credential: T) => Promise<unknown>): Promise<T> {
  if (!['http://localhost:1455/auth/callback', 'http://127.0.0.1:1456/oauth/callback'].includes(redirectUri)) throw new Error('Invalid OAuth callback endpoint.');
  return runLoopback(() => flow, () => redirectUri, Number(new URL(redirectUri).port), provider, true, instructions, signal, publish, flow);
}
/** OpenRouter has no returned state; a generated path plus PKCE owns its ephemeral callback. */
export async function completeOpenRouterLoopback<T>(createFlow: (callbackUrl: string) => BrowserLogin<T>,
  instructions: (url: string) => void, signal: AbortSignal, publish: (credential: T) => Promise<unknown>): Promise<T> {
  const nonce = randomUUID();
  return runLoopback(createFlow, port => `http://127.0.0.1:${port}/oauth/callback/${nonce}`, 0, 'OpenRouter', false, instructions, signal, publish);
}
async function runLoopback<T>(createFlow: (callbackUrl: string) => BrowserLogin<T>, callbackUrl: (port: number) => string, port: number, provider: string, stateRequired: boolean,
  instructions: (url: string) => void, signal: AbortSignal, publish: (credential: T) => Promise<unknown>, flow?: BrowserLogin<T>): Promise<T> {
  let redirect: URL | undefined, state: string | null = null;
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const callback = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); void callback.catch(() => undefined);
  let accepting = true;
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Connection', 'close');
    if (!flow || !redirect) { response.writeHead(409).end('Authorization is not pending.'); return; }
    let target: URL;
    try {
      if (request.method !== 'GET' || !request.url || Buffer.byteLength(request.url) > 8192
        || ![`localhost:${redirect.port}`, `127.0.0.1:${redirect.port}`].includes(request.headers.host ?? '')
        || request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0') throw new Error();
      target = new URL(request.url, redirect.origin);
      if (target.origin !== redirect.origin || target.pathname !== redirect.pathname || target.hash || target.username || target.password
        || stateRequired && (target.searchParams.getAll('state').length !== 1 || target.searchParams.get('state') !== state)
        || target.searchParams.getAll('code').length !== 1 || !target.searchParams.get('code') || target.searchParams.has('error')) throw new Error();
    } catch { response.writeHead(400).end('Invalid authorization callback.'); return; }
    if (!accepting || signal.aborted) { response.writeHead(409).end('Authorization is no longer pending.'); return; }
    accepting = false;
    void flow.complete(target.href, signal).then(credential => {
      response.end('Authorization received. Return to AiHarness.'); resolve(credential);
    }, () => { response.writeHead(400).end('Authorization failed.'); reject(new Error(`${provider} browser login failed.`)); });
  });
  server.maxConnections = 4; server.headersTimeout = 5000; server.requestTimeout = 5000;
  server.setTimeout(20_000, socket => socket.destroy());
  const abort = () => { flow?.cancel(); reject(new Error(`${provider} authentication cancelled.`)); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await Promise.race([new Promise<void>((done, fail) => { server.once('error', fail); server.listen({ host: '127.0.0.1', port, signal }, done); }), callback]);
    signal.throwIfAborted(); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Invalid OAuth listener.');
    redirect = new URL(callbackUrl(address.port)); flow ??= createFlow(redirect.href); state = new URL(flow.authorizationUrl).searchParams.get('state');
    signal.throwIfAborted(); instructions(flow.authorizationUrl);
    const credential = await callback;
    signal.throwIfAborted(); await publish(credential); signal.throwIfAborted();
    return credential;
  } finally {
    signal.removeEventListener('abort', abort); flow?.cancel(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}
