import { createServer } from 'node:http';
import { beginOpenAICodexBrowserLogin, beginOpenAICodexDeviceLogin, getOpenAICodexOAuthConfig,
  type OpenAICodexOAuthCredential, type ProviderCredentialService } from '@ai-harness/core';
import { terminalText } from '../tui/terminal-text.js';

/** Explicit issuer login. Reserve durable publication before any OpenAI request. */
export async function loginOpenAICodex(
  credentials: ProviderCredentialService,
  label: string,
  instructions: (uri: string, code: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const publish = await credentials.prepareOAuthLogin(label, signal);
  const flow = await beginOpenAICodexDeviceLogin({ signal, redactor: credentials.redactor });
  try {
    signal.throwIfAborted();
    if (terminalText(flow.userCode) !== flow.userCode || credentials.redactor.redact(flow.userCode) !== flow.userCode) throw new Error('Invalid OAuth code.');
    instructions(flow.verificationUri, flow.userCode);
    const credential = await flow.complete(signal);
    signal.throwIfAborted();
    await publish(credential);
    signal.throwIfAborted();
  } finally { flow.cancel(); }
}

/** Node CLI loopback only; no browser opener, pasted code, endpoint or bind-address override. */
export async function loginOpenAICodexBrowser(
  credentials: ProviderCredentialService,
  label: string,
  instructions: (url: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const publish = await credentials.prepareOAuthLogin(label, signal);
  const flow = beginOpenAICodexBrowserLogin({ signal, redactor: credentials.redactor });
  const redirect = new URL(getOpenAICodexOAuthConfig().browserRedirectUri);
  const state = new URL(flow.authorizationUrl).searchParams.get('state');
  let resolve!: (value: OpenAICodexOAuthCredential) => void, reject!: (error: Error) => void;
  const callback = new Promise<OpenAICodexOAuthCredential>((done, fail) => { resolve = done; reject = fail; });
  void callback.catch(() => undefined);
  let accepting = true;
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Connection', 'close');
    let target: URL;
    try {
      if (request.method !== 'GET' || !request.url || Buffer.byteLength(request.url) > 8192
        || !['localhost:1455', '127.0.0.1:1455'].includes(request.headers.host ?? '')
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
    }, () => { response.writeHead(400).end('Authorization failed.'); reject(new Error('OpenAI Codex browser login failed.')); });
  });
  server.maxConnections = 4; server.headersTimeout = 5000; server.requestTimeout = 5000;
  server.setTimeout(20_000, socket => socket.destroy());
  const abort = () => { flow.cancel(); reject(new Error('OpenAI Codex authentication cancelled.')); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await Promise.race([new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen({ host: '127.0.0.1', port: 1455, signal }, done);
    }), callback]);
    signal.throwIfAborted(); instructions(flow.authorizationUrl);
    const credential = await callback;
    signal.throwIfAborted(); await publish(credential); signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort); flow.cancel(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}
