import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, reserveReadBudget } from './fixtures/test-budget';
import { start, stop } from '../packages/server/dist/index.js';
import { EncryptedCredentialStore, ProviderCredentialService, type Session } from '../packages/core/dist/index.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
async function fixture() {
  const previous = Object.fromEntries(['AI_HARNESS_MASTER_KEY', 'AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN'].map(key => [key, process.env[key]]));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-codex-browser-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const file = path.join(dataDir, 'credentials.enc'), master = 'disposable-codex-browser-master';
  const token = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'codex-browser-account' } })).toString('base64url') + '.c2ln';
  const grant = 'PRIVATE_CODEX_BROWSER_REFRESH', device = { device_auth_id: 'PRIVATE_CODEX_DEVICE', user_code: 'WEB-CODE', interval: 1 };
  const replay = JSON.parse(await readFile(new URL('../tests/fixtures/codex-continuation-reference.json', import.meta.url), 'utf8')) as {
    events: Array<Record<string, unknown>>; finalEvents: Array<Record<string, unknown>>; items: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>>;
    rows: Array<{ model: string; firstObserved: { content: Array<Record<string, unknown>> }; projections: Array<{ case: string; expected: Array<Record<string, unknown>> }> }>;
  };
  const model = 'gpt-6.1-sol', row = replay.rows.find(row => row.model === model)!;
  const redact = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('opaque-sensitive-tail', 'opaque-[REDACTED]-tail'));
  const exact = redact(row.projections.find(vector => vector.case === 'exact')!.expected), toolInput = exact.slice(0, -1);
  const finalInput = exact.slice(1, -2).filter(item => item.type !== 'function_call');
  const blocks = redact(row.firstObserved.content.map(block => block.type === 'thinking'
    ? { type: 'reasoning', text: block.thinking, thinkingSignature: block.thinkingSignature }
    : block.type === 'text' ? block : { type: 'tool_call', id: block.id, name: block.name, input: block.arguments }));
  const finalEvents = replay.events.filter(event => !String(event.type).includes('function_call_arguments') && (event.item as { type?: string } | undefined)?.type !== 'function_call')
    .map(event => event.type === 'response.completed' ? { ...event, response: { ...(event.response as object), output: replay.items.filter(item => item.type !== 'function_call') } } : event);
  let turns = 0;
  const marker = path.join(cwd, 'echo-effects');
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [], originalFetch = globalThis.fetch;
  let hold: { target: 'device' | 'token'; reached: ReturnType<typeof deferred<AbortSignal>>; response: ReturnType<typeof deferred<Response>> } | undefined;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === 'https://api.github.com/repos/Fidigi/AiHarness/releases/latest') return new Response(null, { status: 404 });
    if (!['auth.openai.com', 'chatgpt.com'].includes(new URL(target).hostname)) return originalFetch(url, init);
    calls.push({ url: target, method: init?.method ?? 'GET', ...(target.endsWith('/responses') ? { body: JSON.parse(String(init?.body)) as Record<string, unknown> } : {}) });
    if (target.endsWith('/usercode')) {
      if (hold?.target === 'device') { hold.reached.resolve(init!.signal!); return hold.response.promise; }
      return Response.json(device);
    }
    if (target.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'PRIVATE_CODEX_CODE', code_verifier: 'PRIVATE_CODEX_VERIFIER' });
    if (target === 'https://auth.openai.com/oauth/token') {
      if (hold?.target === 'token') { hold.reached.resolve(init!.signal!); return hold.response.promise; }
      return Response.json({ access_token: token, refresh_token: grant, expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + token);
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('codex-browser-account');
    expect(new Headers(init?.headers).get('x-api-key')).toBeNull();
    if (target === 'https://chatgpt.com/backend-api/codex/models?client_version=0.167.2') return Response.json({ models: [{ slug: model, visibility: 'list' }] });
    expect(target).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(calls.at(-1)?.body).toMatchObject({ model, stream: true, store: false });
    const selected = ++turns === 1 ? replay.events : turns === 2 ? finalEvents : replay.finalEvents;
    const frames = JSON.parse(JSON.stringify(selected).replaceAll('opaque-sensitive-tail', 'opaque-' + token + '-tail')) as unknown[];
    return new Response(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  process.env.AI_HARNESS_MASTER_KEY = master;
  process.env.AI_HARNESS_AUTH_TOKEN = 'codex-browser-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'codex-browser-admin';
  const reader = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
  const close = async () => {
    hold?.response.resolve(Response.json({}));
    try { await stop(); await rm(root, { recursive: true, force: true }); }
    finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  };
  try {
    await mkdir(cwd); await mkdir(dataDir);
    const extensions = path.join(cwd, '.ai-harness', 'extensions'); await mkdir(extensions, { recursive: true });
    await writeFile(path.join(extensions, 'echo.mjs'), `import { appendFile } from 'node:fs/promises';
      export default api => api.registerTool({ ...${JSON.stringify(replay.tools[0])}, execute: async input => {
        if (input.x !== 1) throw new Error('Invalid fixture input.');
        await appendFile(${JSON.stringify(marker)}, 'effect\\n'); return { content: 'result' };
      } });`);
    const options: NonNullable<Parameters<typeof start>[0]> = { host: '127.0.0.1', port: 0, dataDir, defaultCwd: cwd, allowedRoots: [root], enableMockProvider: true,
      webRoot: fileURLToPath(new URL('../packages/web/dist/', import.meta.url)) };
    const server = await start(options);
    return { base: `http://localhost:${server.port}`, file, token, grant, calls, reader, close, cwd, dataDir, marker, model, blocks, toolInput, finalInput, exact,
      async restart() { await stop(); await start({ ...options, port: server.port }); },
      hold(target: 'device' | 'token') {
        const current = { target, reached: deferred<AbortSignal>(), response: deferred<Response>() }; hold = current;
        return { reached: current.reached.promise, release: () => {
          hold = undefined; current.response.resolve(Response.json(target === 'device' ? device : { access_token: token, refresh_token: grant, expires_in: 3600 }));
        } };
      } };
  } catch (error) { await close(); throw error; }
}

for (const locale of ['en', 'fr'] as const) test(`native Codex Settings ${locale}: device/PKCE login, private CX restart/replay, cancellation and logout`, async ({ page }) => {
  const f = await fixture();
  const copy = locale === 'fr'
    ? { browser: 'Connexion par navigateur (PKCE)', paste: 'Coller l’adresse complète de retour OAuth', pasteSubmit: 'Envoyer l’adresse de retour', pasteCancel: 'Annuler la connexion', connect: 'Connecter', reconnect: 'Reconnecter', disconnect: 'Déconnecter', cancel: 'Annuler', connected: 'Fournisseur connecté.', select: 'Sélectionner le Provider IA', model: 'Sélectionner le modèle', newChat: 'Nouvelle conversation', compose: 'Zone de rédaction', send: 'Envoyer' }
    : { browser: 'Browser sign-in (PKCE)', paste: 'Paste the full OAuth callback address', pasteSubmit: 'Submit callback', pasteCancel: 'Cancel sign-in', connect: 'Connect', reconnect: 'Reconnect', disconnect: 'Disconnect', cancel: 'Cancel', connected: 'Provider connected.', select: 'Select the AI Provider', model: 'Select the model', newChat: 'New chat', compose: 'Message composer', send: 'Send' };
  try {
    expect((await page.request.post(f.base + '/api/auth/login', { headers: { Origin: f.base }, data: { token: 'codex-browser-admin' } })).status()).toBe(200);
    await reserveReadBudget(page.request, f.base);
    await page.addInitScript(locale => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: 'light', lastSettingsSection: 'provider-lifecycle' }));
    }, locale);
    const mutations: string[] = [];
    page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) mutations.push(new URL(request.url()).pathname); });
    await page.goto(f.base + '/settings#provider-lifecycle');
    const section = page.locator('#provider-lifecycle'), panel = section.locator('.oauth-device-flow'), card = section.locator('article[data-settings-selection="openai-codex"]');
    await expect(card.getByRole('button', { name: copy.connect, exact: true })).toBeVisible();
    const selected = await page.getByLabel(copy.select, { exact: true }).inputValue(); expect(f.calls).toEqual([]);
    const device = f.hold('device');
    await card.getByRole('button', { name: copy.connect, exact: true }).click(); const deviceSignal = await device.reached;
    await panel.getByRole('button', { name: copy.cancel, exact: true }).click(); await expect.poll(() => deviceSignal.aborted).toBe(true);
    device.release(); await expect(panel).toHaveCount(0); expect(f.calls).toHaveLength(1);
    const token = f.hold('token');
    await card.getByRole('button', { name: copy.connect, exact: true }).click(); await token.reached;
    await expect(panel).toContainText('WEB-CODE'); await expect(panel.locator('a')).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
    const cancelled = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/auth/oauth/'));
    await panel.getByRole('button', { name: copy.cancel, exact: true }).click(); expect((await cancelled).status()).toBe(200); token.release();
    const absent = f.reader(); await absent.load(); expect(await absent.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' })).toBeUndefined();
    await card.getByRole('button', { name: copy.connect, exact: true }).click(); await expect(panel).toContainText(copy.connected);
    await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();
    expect(await page.getByLabel(copy.select, { exact: true }).inputValue()).toBe(selected);
    const stored = f.reader(); await stored.load(); expect((await stored.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' }))?.credential).toMatchObject({
      accessToken: f.token, refreshToken: f.grant, subscription: { provider: 'openai-codex', accountId: 'codex-browser-account' } });
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    const encrypted = await readFile(f.file, 'utf8'), visible = await page.locator('body').innerText();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of [f.token, f.grant, 'PRIVATE_CODEX_DEVICE', 'PRIVATE_CODEX_CODE', 'PRIVATE_CODEX_VERIFIER']) {
      expect(encrypted + visible + storage).not.toContain(secret);
    }
    await page.reload(); await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();
    const startBrowser = async () => {
      await card.getByRole('button', { name: copy.browser, exact: true }).click();
      const url = new URL((await panel.locator('a').getAttribute('href'))!);
      expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      return 'http://localhost:1455/auth/callback?code=PRIVATE_WEB_PKCE_CODE&state=' + url.searchParams.get('state');
    };
    const pasteBrowser = async (value: string) => {
      await panel.getByLabel(copy.paste, { exact: true }).fill(value);
      await panel.getByRole('button', { name: copy.pasteSubmit, exact: true }).click();
    };
    const returned = await startBrowser(), beforeInvalid = f.calls.length;
    const refused = page.waitForResponse(response => response.url().endsWith('/redirect') && response.request().method() === 'POST');
    await pasteBrowser(returned.replace('state=', 'state=wrong')); expect((await refused).status()).toBe(400);
    await expect(panel.getByLabel(copy.paste, { exact: true })).toHaveValue(''); expect(f.calls).toHaveLength(beforeInvalid);
    const pkceToken = f.hold('token'); await pasteBrowser(returned); const pkceSignal = await pkceToken.reached;
    const pkceCancelled = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/auth/oauth/'));
    await panel.getByRole('button', { name: copy.pasteCancel, exact: true }).click(); expect((await pkceCancelled).status()).toBe(200);
    await expect.poll(() => pkceSignal.aborted).toBe(true); pkceToken.release(); await expect(panel).toHaveCount(0);
    // Retiring an unpublished reconnect must not revoke the already committed device login.
    const previous = f.reader(); await previous.load(); expect((await previous.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' }))?.credential).toMatchObject({ accessToken: f.token });
    const valid = await startBrowser(); await pasteBrowser(valid); await expect(panel).toContainText(copy.connected);
    await expect(panel.locator('strong')).toHaveText('PKCE');
    expect(await page.getByLabel(copy.select, { exact: true }).inputValue()).toBe(selected);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('PRIVATE_WEB_PKCE_CODE');
    await expect(page.locator('body')).not.toContainText('PRIVATE_WEB_PKCE_CODE');
    expect((await page.request.post(f.base + '/api/workspaces/trust', { data: { cwd: f.cwd, confirm: true } })).status()).toBe(200);
    expect((await page.request.post(f.base + '/api/plugins/reload', { data: { cwd: f.cwd } })).status()).toBe(200);
    expect(mutations.some(path => path.includes('/models/enabled') || path.includes('/configuration/'))).toBe(false);
    // Explicit fixture-owner defaults initialize the new draft; login itself never selects them.
    expect((await page.request.patch(f.base + '/api/configuration/scope', { data: { scope: 'global',
      values: { provider: 'openai-codex', model: f.model, thinking: 'off', toolPreset: 'default', autoCompaction: false } } })).status()).toBe(200);
    await page.reload();
    await page.getByLabel(copy.select, { exact: true }).selectOption('openai-codex');
    await page.getByLabel(copy.model, { exact: true }).selectOption(f.model);
    await page.getByRole('button', { name: copy.newChat, exact: true }).click();
    const send = async (input: string) => {
      await page.getByRole('textbox', { name: copy.compose, exact: true }).fill(input);
      const accepted = page.waitForResponse(response => response.url().endsWith('/api/agent/runs') && response.request().method() === 'POST');
      await page.getByRole('button', { name: copy.send, exact: true }).click();
      const response = await accepted; expect(response.status()).toBe(202);
      const result = await response.json() as { run: { id: string }; session: { id: string } };
      await expect.poll(async () => (await page.request.get(f.base + '/api/agent/runs/' + result.run.id).then(response => response.json()) as { phase: string }).phase).toBe('completed');
      return result;
    };
    const first = await send('probe');
    await expect(page.locator('.message.assistant .message-output').last()).toHaveText('leftright');
    const bodies = () => f.calls.filter(call => call.url.endsWith('/responses')).map(call => call.body!);
    expect(bodies()).toHaveLength(2); expect(bodies()[0]!.tools).toContainEqual(expect.objectContaining({ type: 'function', name: 'echo' }));
    expect(bodies()[1]!.input).toEqual(f.toolInput); expect(await readFile(f.marker, 'utf8')).toBe('effect\n');
    const journalFile = path.join(f.dataDir, 'sessions', first.session.id + '.jsonl'), journal = await readFile(journalFile, 'utf8');
    expect(journal).not.toContain(f.token); expect(journal).toContain('opaque-[REDACTED]-tail'); expect((await stat(journalFile)).mode & 0o777).toBe(0o600);
    const assistantBlocks = () => readFile(journalFile, 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message' && entry.role === 'assistant').map(message => message.blocks));
    expect(await assistantBlocks()).toEqual([f.blocks, f.blocks.filter(block => block.type !== 'tool_call')]);
    for (const complete of [false, true]) {
      const response = await page.request.get(f.base + '/api/sessions/' + first.session.id + '/export?format=json' + (complete ? '&includeOpaqueContinuations=true' : ''));
      expect(response.status()).toBe(200); expect(Boolean(response.headers()['x-aiharness-export-warning'])).toBe(!complete);
      const text = await response.text(); expect(text).not.toContain(f.token); expect(text.includes('opaque-')).toBe(complete); expect(text.includes('textSignature')).toBe(complete);
      expect(text).toContain('visible thought'); expect(await readFile(journalFile, 'utf8')).toBe(journal);
    }
    await page.goto('about:blank'); await f.restart();
    expect((await page.request.post(f.base + '/api/auth/login', { headers: { Origin: f.base }, data: { token: 'codex-browser-admin' } })).status()).toBe(200);
    await reserveReadBudget(page.request, f.base);
    const loaded = await page.request.get(f.base + '/api/sessions/' + first.session.id).then(response => response.json()) as Session;
    expect(loaded.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([f.blocks, f.blocks.filter(block => block.type !== 'tool_call')]);
    await page.goto(f.base + '/settings#provider-lifecycle');
    await page.getByLabel(copy.select, { exact: true }).selectOption('openai-codex'); await page.getByLabel(copy.model, { exact: true }).selectOption(f.model);
    await page.locator(`a.session-main[href*="${first.session.id}"]`).click();
    const resumed = await send('continue'); expect(resumed.session.id).toBe(first.session.id);
    await expect(page.locator('.message.assistant .message-output').last()).toHaveText('ok');
    expect(bodies()).toHaveLength(3); expect(bodies()[2]!.input).toEqual([...f.toolInput, ...f.finalInput, f.exact.at(-1)]);
    expect((await assistantBlocks()).slice(0, 2)).toEqual([f.blocks, f.blocks.filter(block => block.type !== 'tool_call')]); expect(await assistantBlocks()).toHaveLength(3);
    expect(await readFile(f.marker, 'utf8')).toBe('effect\n');
    for (const secret of [f.token, f.grant]) {
      await expect(page.locator('body')).not.toContainText(secret);
      expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret);
    }
    await expect(page.locator('body')).not.toContainText('opaque-');
    await page.goto(f.base + '/settings#provider-lifecycle'); await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();
    const sampled = deferred<void>(), released = deferred<void>();
    await page.route('**/api/provider-registry/auth/oauth/*', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(); expect((await response.json()).state).toBe('connected'); sampled.resolve(); await released.promise;
      if (!route.request().failure()) await route.fulfill({ response });
    });
    await card.getByRole('button', { name: copy.reconnect, exact: true }).click(); await sampled.promise;
    const logout = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith('/auth/openai-codex'));
    await card.getByRole('button', { name: copy.disconnect, exact: true }).click(); expect((await logout).status()).toBe(200); released.resolve();
    await expect(panel).toHaveCount(0); await expect(card.getByRole('button', { name: copy.connect, exact: true })).toBeVisible();
    const withdrawn = f.reader(); await withdrawn.load(); expect(await withdrawn.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' })).toBeUndefined();
    expect(mutations.some(path => path.includes('/models/enabled') || path.includes('/configuration/'))).toBe(false);
    await page.unroute('**/api/provider-registry/auth/oauth/*');
    const callbackCommitted = deferred<void>(), callbackReleased = deferred<void>();
    await page.route('**/api/provider-registry/auth/oauth/*/redirect', async route => {
      const response = await route.fetch(); expect((await response.json()).state).toBe('connected'); callbackCommitted.resolve(); await callbackReleased.promise;
      if (!route.request().failure()) await route.fulfill({ response });
    });
    await pasteBrowser(await startBrowser()); await callbackCommitted.promise;
    const lateLogout = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith('/auth/openai-codex'));
    await card.getByRole('button', { name: copy.disconnect, exact: true }).click(); expect((await lateLogout).status()).toBe(200); callbackReleased.resolve();
    await expect(panel).toHaveCount(0); await expect(card.getByRole('button', { name: copy.connect, exact: true })).toBeVisible();
    const afterCallback = f.reader(); await afterCallback.load(); expect(await afterCallback.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' })).toBeUndefined();
    const count = f.calls.length;
    const denied = await page.request.post(f.base + '/api/agent/runs', { data: { sessionId: first.session.id, cwd: f.cwd, provider: 'openai-codex', model: f.model, input: 'withdrawn', maxRetries: 0, autoCompaction: false } });
    expect(denied.status()).toBe(500); expect(await denied.json()).toEqual({ error: 'Internal server error' });
    expect(f.calls).toHaveLength(count); expect(await readFile(f.marker, 'utf8')).toBe('effect\n');
    expect((await assistantBlocks()).slice(0, 2)).toEqual([f.blocks, f.blocks.filter(block => block.type !== 'tool_call')]); expect(await assistantBlocks()).toHaveLength(3);
    expect(f.calls.filter(call => call.method !== 'GET' && !call.url.endsWith('/responses')).every(call => call.url.startsWith('https://auth.openai.com/'))).toBe(true);
  } finally { await page.goto('about:blank').catch(() => undefined); await f.close(); }
});
