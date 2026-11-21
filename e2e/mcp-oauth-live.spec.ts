import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures/test-budget';
import { nativeMcpInheritance } from './fixtures/mcp-inheritance';
import { selectMcpServer } from './fixtures/mcp-navigation';

// Disposable real issuer/MCP peer. No route interception or external credentials.
async function issuer() {
  let base = '', redirect = '', challenge = '', fixtureError: unknown;
  const calls: string[] = [];
  const json = (response: import('node:http').ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', base); calls.push(url.pathname);
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 65536) throw new Error('fixture request bound'); }
      if (url.pathname === '/metadata') return json(response, 200, {
        issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'], code_challenge_methods_supported: ['S256'],
      });
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(response, 200, {
        resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['tools.read'],
      });
      if (url.pathname === '/register') {
        const registration = JSON.parse(body); redirect = registration.redirect_uris[0];
        expect(registration.client_name).toBe('Native browser operator');
        expect(new URL(redirect).pathname).toBe('/native/browser/callback');
        return json(response, 201, { ...registration, client_id: 'browser-client', client_secret: 'BROWSER_CLIENT_SECRET', token_endpoint_auth_method: 'client_secret_post' });
      }
      if (url.pathname === '/authorize') {
        expect(url.searchParams.get('client_id')).toBe('browser-client');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        challenge = url.searchParams.get('code_challenge')!;
        const callback = new URL(redirect); callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('code', 'browser-code');
        response.writeHead(302, { Location: callback.href }).end(); return;
      }
      if (url.pathname === '/token') {
        const values = new URLSearchParams(body);
        expect(values.get('code')).toBe('browser-code'); expect(values.get('redirect_uri')).toBe(redirect);
        expect(createHash('sha256').update(values.get('code_verifier')!).digest('base64url')).toBe(challenge);
        return json(response, 200, { access_token: 'BROWSER_ACCESS_SECRET', refresh_token: 'BROWSER_REFRESH_SECRET', token_type: 'Bearer', scope: 'tools.read' });
      }
      if (url.pathname === '/mcp') {
        if (request.headers.authorization !== 'Bearer BROWSER_ACCESS_SECRET') {
          response.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
        }
        if (request.method === 'GET') { response.writeHead(405).end(); return; }
        const message = JSON.parse(body);
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} }, serverInfo: { name: 'browser-native-oauth', version: '1' } }
          : message.method === 'tools/list' ? { tools: [{ name: 'lookup', description: 'Protected docs', inputSchema: { type: 'object' } }] } : {};
        return json(response, 200, { jsonrpc: '2.0', id: message.id, result });
      }
      response.writeHead(404).end();
    } catch (error) { fixtureError = error; response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  base = `http://127.0.0.1:${address.port}`;
  return { base, calls, error: () => fixtureError, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test('native MCP HTTP Test stays passive; explicit browser OAuth persists encrypted state and signs out', async ({ page }) => {
  const previous = process.env.AI_HARNESS_MASTER_KEY;
  process.env.AI_HARNESS_MASTER_KEY = 'disposable-native-browser-master-key';
  const peer = await issuer();
  let f: Awaited<ReturnType<typeof nativeMcpInheritance>> | undefined;
  try {
    f = await nativeMcpInheritance(page.request);
    const config = JSON.parse(await readFile(f.globalFile, 'utf8'));
    config.mcpServers.protected = { url: peer.base + '/mcp', timeout: 2, oauth: {
      clientName: 'Native browser operator', scope: 'tools.read', callbackUrl: 'http://127.0.0.1/native/browser/callback', authServerMetadataUrl: peer.base + '/metadata',
    } };
    await writeFile(f.globalFile, JSON.stringify(config));
    await page.addInitScript(() => {
      localStorage.setItem('ai-harness-locale', 'en');
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: 'light', filesOpen: false, lastSettingsSection: 'mcp' }));
    });
    await page.goto(f.base + '/settings#mcp');
    await selectMcpServer(page, 'global', 'protected');
    const card = page.locator('#mcp .mcp-server-card').filter({ has: page.getByRole('region', { name: 'Server details: Global configuration / protected', exact: true }) });
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(peer.calls).toEqual([]);
    await card.getByRole('button', { name: 'Test protected', exact: true }).click();
    await expect(card.getByRole('region', { name: 'Last connection test for protected', exact: true })).toContainText('Authentication required');
    expect(peer.calls).not.toContain('/register'); expect(peer.calls).not.toContain('/token');
    await card.getByRole('button', { name: 'Sign in', exact: true }).click();
    const link = card.getByRole('link', { name: 'Open the authorization page', exact: true });
    await expect(link).toBeVisible();
    const popupPromise = page.waitForEvent('popup'); await link.click(); const popup = await popupPromise;
    await expect(popup.locator('body')).toContainText('MCP sign-in received'); await popup.close();
    await expect(card.locator('.mcp-oauth-panel')).toContainText('OAuth sign-in completed.');
    const encrypted = await readFile(path.join(path.dirname(f.globalFile), 'credentials.enc'), 'utf8');
    const visible = await page.locator('body').innerText();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of ['BROWSER_ACCESS_SECRET', 'BROWSER_REFRESH_SECRET', 'BROWSER_CLIENT_SECRET']) {
      expect(encrypted).not.toContain(secret); expect(visible).not.toContain(secret); expect(storage).not.toContain(secret);
    }
    await card.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(card.locator('.mcp-oauth-panel')).toContainText('Not signed in');
    expect(peer.calls.filter(value => value === '/register')).toHaveLength(1);
    expect(peer.calls.filter(value => value === '/token')).toHaveLength(1);
    expect(peer.error()).toBeUndefined();
  } finally {
    try { await page.goto('about:blank'); await f?.close(); await peer.close(); }
    finally { if (previous === undefined) delete process.env.AI_HARNESS_MASTER_KEY; else process.env.AI_HARNESS_MASTER_KEY = previous; }
  }
});
