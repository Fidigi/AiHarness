import { afterEach, describe, expect, it } from 'vitest';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type Socket } from 'node:net';
import { nativeFrontendRelay } from './native-frontend-relay.js';

// Transport-only unit servers; not product API/CSRF or browser qualification.
const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = http.createServer(handler), sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Unit server missing.');
  stops.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { server, url: `http://127.0.0.1:${address.port}` };
}
async function setup(rootHandler: Parameters<typeof upstream>[0], prefixHandler: Parameters<typeof upstream>[0]) {
  const root = await upstream(rootHandler), prefix = await upstream(prefixHandler);
  const relay = await nativeFrontendRelay(root.url, prefix.url + '/navigation'); stops.push(() => relay.close());
  return { relay, root, prefix };
}
function exchange(proxy: string, destination: string, method = 'GET', headers: Record<string, string> = {}, chunks: Buffer[] = []) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = http.request(proxy, { method, path: destination, headers: { host: new URL(destination).host, ...headers } }, response => {
      const body: Buffer[] = []; response.on('data', chunk => body.push(chunk)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(body) }));
    });
    request.once('error', reject);
    const send = (index: number) => { if (index === chunks.length) { request.end(); return; } request.write(chunks[index]); setImmediate(() => send(index + 1)); }; send(0);
  });
}
function tunnel(proxy: string, authority: string, wire: string) {
  return new Promise<string>((resolve, reject) => {
    const url = new URL(proxy), socket = net.connect(Number(url.port), url.hostname); let response = '', connected = false;
    socket.once('error', reject); socket.once('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('data', data => {
      response += data.toString('utf8');
      if (!connected && response.includes('\r\n\r\n')) { connected = true; socket.write(wire); }
    });
    socket.once('end', () => resolve(response));
  });
}

describe('owned native frontend HTTP relay', () => {
  it('preserves real prefix status, headers, query, canonical Host and arbitrary bytes', async () => {
    let seen: unknown;
    const bytes = Buffer.from([0, 255, 1, 240, 159, 152, 128]);
    const { relay, root } = await setup((_request, response) => response.end('WRONG_ROOT'), (request, response) => {
      seen = { url: request.url, host: request.headers.host }; response.writeHead(207, { 'x-actual-upstream': 'prefix' }); response.end(bytes);
    });
    const actual = await exchange(relay.url, root.url + '/navigation/file?cwd=%2Fx%20y&literal=%2525', 'GET', { 'sec-fetch-dest': 'document' });
    expect(actual.status).toBe(207); expect(actual.headers['x-actual-upstream']).toBe('prefix'); expect(actual.body).toEqual(bytes);
    expect(seen).toEqual({ url: '/navigation/file?cwd=%2Fx%20y&literal=%2525', host: new URL(root.url).host });
    expect(relay.evidence).toEqual([{ pathname: '/navigation/file', method: 'GET', status: 207, document: true }]); expect(relay.errors).toEqual([]);
  });
  it('passes API Origin/auth/CSRF and split UTF-8 body unchanged; observes without blocking writes', async () => {
    let seen: unknown;
    const { relay, root } = await setup((request, response) => {
      const bytes: Buffer[] = []; request.on('data', chunk => bytes.push(chunk)); request.once('end', () => {
        seen = { origin: request.headers.origin, auth: request.headers.authorization, csrf: request.headers['x-csrf-token'], body: Buffer.concat(bytes).toString('utf8') };
        response.writeHead(201, { 'x-actual-upstream': 'api' }); response.end('ACTUAL_API_BYTES');
      });
    }, (_request, response) => response.end('WRONG_PREFIX'));
    const body = Buffer.from(JSON.stringify({ cwd: '/é/😀' })), split = body.indexOf(0xc3) + 1; relay.startRead();
    const actual = await exchange(relay.url, root.url + '/api/workspaces/validate', 'POST', { origin: root.url, authorization: 'Bearer fixture-only', 'x-csrf-token': 'fixture-only', 'content-type': 'application/json' }, [body.subarray(0, split), body.subarray(split)]);
    expect(actual.status).toBe(201); expect(actual.body.toString()).toBe('ACTUAL_API_BYTES');
    expect(seen).toEqual({ origin: root.url, auth: 'Bearer fixture-only', csrf: 'fixture-only', body: body.toString() });
    expect(relay.writes).toEqual([{ method: 'POST', pathname: '/api/workspaces/validate', body: body.toString() }]); expect(relay.errors).toEqual([]);
    relay.stopRead();
  });
  it('never repairs a refused API Origin or status/body', async () => {
    const { relay, root } = await setup((request, response) => { response.writeHead(request.headers.origin === 'http://foreign.invalid' ? 403 : 200); response.end('ACTUAL_ORIGIN_REFUSAL'); }, (_request, response) => response.end('WRONG_PREFIX'));
    const actual = await exchange(relay.url, root.url + '/api/protected', 'POST', { origin: 'http://foreign.invalid' });
    expect(actual.status).toBe(403); expect(actual.body.toString()).toBe('ACTUAL_ORIGIN_REFUSAL');
  });
  it('observes actual index base without rewriting JavaScript', async () => {
    const source = 'const router = navigationBasename("/navigation/");';
    const { relay, root } = await setup((_request, response) => response.end('WRONG_ROOT'), (_request, response) => response.end(source));
    const actual = await exchange(relay.url, root.url + '/navigation/src/index.tsx'); expect(actual.body.toString()).toBe(source);
    expect(relay.evidence[0]?.base).toBe('/navigation/');
  });
  it('routes tunneled origin-form HTTP to the real prefix and closes owned sockets', async () => {
    const { relay, root } = await setup((_request, response) => response.end('WRONG_ROOT'), (_request, response) => response.end('TUNNELED_PREFIX'));
    const authority = new URL(root.url).host;
    const actual = await tunnel(relay.url, authority, `GET /navigation/file HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
    expect(actual).toContain('200 Connection Established'); expect(actual).toContain('TUNNELED_PREFIX'); expect(actual).not.toContain('WRONG_ROOT');
    await relay.close(); await relay.close();
  });
  it('preserves tunneled real WebSocket upgrade bytes and Origin', async () => {
    const { relay, root, prefix } = await setup((_request, response) => response.end('WRONG_ROOT'), (_request, response) => response.end('WRONG_HTTP'));
    let origin: string | undefined;
    prefix.server.on('upgrade', (request, socket) => { origin = request.headers.origin; socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nACTUAL_UPGRADE_BYTES'); });
    const authority = new URL(root.url).host;
    const actual = await tunnel(relay.url, authority, `GET /navigation/?token=fixture HTTP/1.1\r\nHost: ${authority}\r\nOrigin: ${root.url}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    expect(actual).toContain('101 Switching Protocols'); expect(actual).toContain('ACTUAL_UPGRADE_BYTES'); expect(origin).toBe(root.url); expect(relay.errors).toEqual([]);
  });
  it('refuses foreign proxy authority without synthesizing any API response', async () => {
    let calls = 0;
    const { relay } = await setup((_request, response) => { calls++; response.end('WRONG_ROOT'); }, (_request, response) => { calls++; response.end('WRONG_PREFIX'); });
    await expect(exchange(relay.url, 'http://foreign.invalid/api/anything')).rejects.toMatchObject({ code: 'ECONNRESET' }); expect(calls).toBe(0);
  });
});
