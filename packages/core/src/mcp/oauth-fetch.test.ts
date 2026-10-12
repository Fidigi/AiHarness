import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { boundedMcpOAuthFetch } from './oauth-fetch.js';

const servers: Server[] = [];
const controllers: AbortController[] = [];

async function fixture(): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === '/no-headers') return;
    const stream = request.url === '/notifications' || request.url === '/oauth-stream';
    response.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
    response.write(stream ? 'data: pending\n\n' : '{"pending":');
    // Intentionally never finish the response body.
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not listen');
  return `http://127.0.0.1:${address.port}`;
}

function controller(): AbortController {
  const value = new AbortController();
  controllers.push(value);
  return value;
}

afterEach(async () => {
  for (const value of controllers.splice(0)) value.abort();
  await Promise.all(servers.splice(0).map(server => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  }));
});

describe('bounded MCP OAuth fetch', () => {
  it('bounds a response that never sends headers', async () => {
    const base = await fixture();
    await expect(boundedMcpOAuthFetch(controller().signal, 100)(`${base}/no-headers`))
      .rejects.toThrow();
  });

  it.each(['/json', '/oauth-stream'])('keeps the deadline after headers for %s', async endpoint => {
    const base = await fixture();
    const response = await boundedMcpOAuthFetch(controller().signal, 100)(`${base}${endpoint}`);
    await expect(response.text()).rejects.toThrow();
  });

  it.each(['connection', 'request'])('keeps %s cancellation linked after headers', async kind => {
    const base = await fixture();
    const connection = controller();
    const request = controller();
    const response = await boundedMcpOAuthFetch(connection.signal, 1_000)(`${base}/json`, { signal: request.signal });
    const reading = response.text();
    (kind === 'connection' ? connection : request).abort();
    await expect(reading).rejects.toThrow();
  });

  it('preserves long-lived MCP GET notifications while keeping shutdown linked', async () => {
    const base = await fixture();
    const connection = controller();
    const url = `${base}/notifications`;
    const response = await boundedMcpOAuthFetch(connection.signal, 100, url)(url);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    let settled = false;
    const pending = reader.read();
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    connection.abort();
    await expect(pending).rejects.toThrow();
  });
});
