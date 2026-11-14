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
  const redirect = new URL(redirectUri), state = new URL(flow.authorizationUrl).searchParams.get('state');
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const callback = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); void callback.catch(() => undefined);
  let accepting = true;
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Connection', 'close');
    let target: URL;
    try {
      if (request.method !== 'GET' || !request.url || Buffer.byteLength(request.url) > 8192
        || ![`localhost:${redirect.port}`, `127.0.0.1:${redirect.port}`].includes(request.headers.host ?? '')
        || request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0') throw new Error();
      target = new URL(request.url, redirect.origin);
      if (target.origin !== redirect.origin || target.pathname !== redirect.pathname || target.hash || target.username || target.password
        || target.searchParams.getAll('state').length !== 1 || target.searchParams.get('state') !== state
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
  const abort = () => { flow.cancel(); reject(new Error(`${provider} authentication cancelled.`)); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await Promise.race([new Promise<void>((done, fail) => { server.once('error', fail); server.listen({ host: '127.0.0.1', port: Number(redirect.port), signal }, done); }), callback]);
    signal.throwIfAborted(); instructions(flow.authorizationUrl);
    const credential = await callback;
    signal.throwIfAborted(); await publish(credential); signal.throwIfAborted();
    return credential;
  } finally {
    signal.removeEventListener('abort', abort); flow.cancel(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}
