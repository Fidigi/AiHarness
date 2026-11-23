import http, { type IncomingMessage } from 'node:http';
import net, { type Socket } from 'node:net';

export interface RelayWrite { method: string; pathname: string; body: string }
export interface NativeFrontendRelay {
  url: string;
  startRead(): void;
  stopRead(): void;
  writes: RelayWrite[];
  quota: string[];
  evidence: Array<{ pathname: string; method: string; status: number; document: boolean; base?: string }>;
  errors: string[];
  close(): Promise<void>;
}

/** Real HTTP forward proxy for an owned frontend fixture. Never invent API
 * responses, change browser Origin/CSRF/authentication, or rewrite app bytes.
 * Unlike page interception this also transports first background navigations. */
export async function nativeFrontendRelay(canonical: string, prefixServer: string): Promise<NativeFrontendRelay> {
  const origin = new URL(canonical), prefix = new URL(prefixServer);
  if (origin.protocol !== 'http:' || prefix.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname)
    || prefix.hostname !== '127.0.0.1' || prefix.pathname !== '/navigation') throw new Error('Invalid owned relay endpoints.');
  let armed = false, closing = false;
  const agent = new http.Agent({ keepAlive: true });
  const sockets = new Set<Socket>();
  const writes: RelayWrite[] = [], quota: string[] = [], evidence: NativeFrontendRelay['evidence'] = [], errors: string[] = [];
  const own = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const headers = (request: IncomingMessage) => {
    const result = { ...request.headers }; delete result['proxy-connection']; delete result['proxy-authorization']; return result;
  };
  const target = (request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', origin);
    if (url.origin !== origin.origin || request.headers.host !== origin.host) throw new Error('Foreign relay authority.');
    return { url, upstream: url.pathname === '/navigation' || url.pathname.startsWith('/navigation/') ? prefix : origin };
  };
  const failure = (error: unknown) => {
    if (!closing && errors.length < 16) errors.push(typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code).slice(0, 64) : 'RELAY_TRANSPORT_FAILURE');
  };
  const server = http.createServer((request, response) => {
    let route: ReturnType<typeof target>;
    try { route = target(request); } catch { request.socket.destroy(); return; }
    const { url, upstream } = route;
    const method = request.method ?? 'GET';
    if (armed && method !== 'GET' && url.pathname.startsWith('/api/')) {
      const entry = { method, pathname: url.pathname, body: '' };
      if (writes.length < 64) writes.push(entry);
      else if (writes.length === 64) writes.push({ method: 'OVERFLOW', pathname: '/api/', body: '' });
      let bytes = 0; const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 16_384) chunks.push(chunk); });
      request.once('end', () => { entry.body = bytes > 16_384 ? '[oversized fixture write]' : Buffer.concat(chunks).toString('utf8'); });
    }
    const outgoing = http.request({ agent, hostname: upstream.hostname, port: upstream.port, method, path: url.pathname + url.search, headers: headers(request) }, incoming => {
      const status = incoming.statusCode!;
      const isDocument = request.headers['sec-fetch-dest'] === 'document';
      const index = url.pathname.endsWith('/src/index.tsx');
      const item = { pathname: url.pathname, method, status, document: isDocument } as NativeFrontendRelay['evidence'][number];
      if ((isDocument || index || status >= 400) && evidence.length < 128) evidence.push(item);
      if (armed && status === 429 && url.pathname.startsWith('/api/') && quota.length < 64) quota.push(url.pathname);
      if (index) {
        let first = Buffer.alloc(0);
        incoming.on('data', (chunk: Buffer) => { if (first.length < 8192) first = Buffer.concat([first, chunk.subarray(0, 8192 - first.length)]); });
        incoming.once('end', () => { const text = first.toString('utf8'); item.base = /"BASE_URL":\s*"([^"]*)"/.exec(text)?.[1] ?? /navigationBasename\(\s*"([^"]*)"/.exec(text)?.[1] ?? 'not-readable'; });
      }
      response.writeHead(status, incoming.statusMessage, incoming.headers); incoming.pipe(response);
      incoming.on('error', error => { if (!response.destroyed) { failure(error); response.destroy(); } });
    });
    outgoing.on('error', error => { if (!request.aborted && !response.destroyed) { failure(error); response.destroy(); } });
    request.once('aborted', () => outgoing.destroy());
    response.once('close', () => { if (!response.writableEnded) outgoing.destroy(); });
    request.pipe(outgoing);
  });
  server.on('connection', own);
  server.on('upgrade', (request, socket, head) => {
    let route: ReturnType<typeof target>;
    try { route = target(request); } catch { socket.destroy(); return; }
    const upstream = own(net.connect(Number(route.upstream.port), route.upstream.hostname));
    upstream.once('connect', () => {
      const lines = Object.entries(headers(request)).flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`));
      upstream.write(`${request.method} ${route.url.pathname + route.url.search} HTTP/${request.httpVersion}\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.once('error', () => upstream.destroy()); upstream.once('error', error => { if (!socket.destroyed) { failure(error); socket.destroy(); } });
    socket.once('close', () => upstream.destroy()); upstream.once('close', () => { if (!socket.writableEnded) socket.end(); });
  });
  // Chromium may tunnel WebSockets even to an HTTP origin. Re-enter this owned
  // relay, then route the real origin-form upgrade by its actual pathname.
  server.on('connect', (request, socket, head) => {
    if (request.url !== origin.host) { socket.destroy(); return; }
    const address = server.address(); if (!address || typeof address === 'string') { socket.destroy(); return; }
    const tunnel = own(net.connect(address.port, '127.0.0.1'));
    tunnel.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) tunnel.write(head); socket.pipe(tunnel); tunnel.pipe(socket);
    });
    socket.once('error', () => tunnel.destroy()); tunnel.once('error', error => { if (!socket.destroyed) { failure(error); socket.destroy(); } });
    socket.once('close', () => tunnel.destroy()); tunnel.once('close', () => { if (!socket.writableEnded) socket.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned relay did not listen.');
  return { url: `http://127.0.0.1:${address.port}`, writes, quota, evidence, errors,
    startRead() { writes.length = 0; quota.length = 0; armed = true; }, stopRead() { armed = false; },
    async close() { if (closing) return; closing = true; for (const socket of sockets) socket.destroy(); agent.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
