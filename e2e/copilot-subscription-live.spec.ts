import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, reserveReadBudget } from './fixtures/test-budget';
import { closeSettings, selectModelSettings, selectProviderConnection } from './fixtures/settings-navigation';
import { start, stop } from '../packages/server/dist/index.js';
import { EncryptedCredentialStore, ProviderCredentialService, type MessageContentBlock, type Session } from '../packages/core/dist/index.js';

// Real emitted Server/static Web and encrypted storage; only outbound vendor
// responses are synthetic. No real subscription or GitHub authorization claim.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const previous = Object.fromEntries(['AI_HARNESS_MASTER_KEY', 'AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN'].map(key => [key, process.env[key]]));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-copilot-browser-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), file = path.join(dataDir, 'credentials.enc');
  const master = 'disposable-copilot-browser-master', grant = 'PRIVATE_COPILOT_BROWSER_GRANT';
  const token = 'tid=PRIVATE_COPILOT_BROWSER_TOKEN;proxy-ep=proxy.business.githubcopilot.com';
  const rotatedToken = 'tid=PRIVATE_COPILOT_BROWSER_ROTATION;proxy-ep=proxy.enterprise.githubcopilot.com';
  let rotate = false, exchanges = 0;
  const device = { device_code: 'PRIVATE_COPILOT_DEVICE', user_code: 'WEB-CODE', verification_uri: 'https://github.com/login/device', expires_in: 600, interval: 1 };
  type Item = Record<string, unknown>;
  type Row = { model: string; api: string; lane: string; seed: { events: Item[]; blocks: MessageContentBlock[] }; cases: Array<{ name: string; body: Item }> };
  const reference = JSON.parse(await readFile(new URL('../tests/fixtures/github-copilot-continuation-reference.json', import.meta.url), 'utf8')) as { tools: Item[]; rows: Row[] };
  const routing = JSON.parse(await readFile(new URL('../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8')) as {
    rows: Array<{ model: string; case: string; responseEvents: Item[] }>;
  };
  const models = ['gpt-5-mini', 'claude-fable-5.1', 'gemini-3.5-flash'];
  const rows = models.map(model => reference.rows.find(row => row.model === model && (row.api !== 'openai-completions' || row.lane === 'details'))!);
  const catalogue = { data: [...models.map(id => ({ id, model_picker_enabled: true })), { id: 'claude-fable-5', model_picker_enabled: true, policy: { state: 'disabled' } }] };
  const payload = <T>(value: T, secret: string): T => JSON.parse(JSON.stringify(value)
    .replace(/opaque-copilot-(redacted|c-sensitive-one|sensitive-tail)/gu, (_match, suffix: string) => `opaque-${secret}-copilot-${suffix}`));
  const redact = <T>(value: T): T => payload(value, '[REDACTED]');
  const history = (body: Item, api: string): Item[] => {
    const items = body[api === 'openai-responses' ? 'input' : 'messages'] as Item[];
    if (api === 'anthropic-messages') return items;
    expect(items[0]).toMatchObject({ role: api === 'openai-responses' ? 'developer' : 'system', content: expect.any(String) });
    return items.slice(1);
  };
  const cases = rows.map(row => {
    const toolInput = redact(history(row.cases.find(item => item.name === 'same')!.body, row.api));
    const assistant = structuredClone(toolInput.find(item => item.role === 'assistant') ?? {});
    if (row.api === 'anthropic-messages') assistant.content = (assistant.content as Item[]).filter(item => item.type !== 'tool_use');
    else delete assistant.tool_calls;
    const finalInput = row.api === 'openai-responses' ? toolInput.slice(1, -1).filter(item => item.type !== 'function_call') : [assistant];
    const user = { ...toolInput[0], content: row.api === 'openai-responses' ? [{ type: 'input_text', text: 'continue' }] : 'continue' };
    const expected = (resume: boolean): Item[] => {
      const items = structuredClone(resume ? [...toolInput, ...finalInput, user] : toolInput);
      if (row.api === 'anthropic-messages') {
        const last = items.at(-1)!;
        if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
        (last.content as Item[]).at(-1)!.cache_control = { type: 'ephemeral' };
      }
      return items;
    };
    const finalEvents = row.seed.events.filter(event => row.api === 'anthropic-messages'
      ? event.index !== row.seed.blocks.findIndex(block => block.type === 'tool_call')
      : row.api !== 'openai-responses' || event.output_index !== row.seed.blocks.findIndex(block => block.type === 'tool_call'))
      .map(event => {
        if (event.type === 'message_delta') return { ...event, delta: { ...(event.delta as Item), stop_reason: 'end_turn' } };
        if (Array.isArray(event.choices)) return { ...event, choices: (event.choices as Item[]).map(choice => {
          const delta = { ...(choice.delta as Item) }; delete delta.tool_calls;
          return { ...choice, delta, finish_reason: choice.finish_reason === 'tool_calls' ? 'stop' : choice.finish_reason };
        }) };
        if (event.type === 'response.completed') return { ...event, response: { ...(event.response as Item),
          output: ((event.response as Item).output as Item[]).filter(item => item.type !== 'function_call') } };
        return event;
      });
    return { ...row, blocks: redact(row.seed.blocks), finalEvents, expected };
  });
  const turns = new Map<string, number>(), marker = path.join(cwd, 'echo-effects');
  const calls: Array<{ url: string; method: string; authorization: string | null; body?: Item }> = [];
  const originalFetch = globalThis.fetch;
  let hold: { target: 'device' | 'catalogue'; reached: ReturnType<typeof deferred<AbortSignal>>; response: ReturnType<typeof deferred<Response>> } | undefined;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    // Release checks share api.github.com, but are not subscription traffic.
    if (target === 'https://api.github.com/repos/Fidigi/AiHarness/releases/latest') return new Response(null, { status: 404 });
    if (!['github.com', 'api.github.com', 'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com'].includes(new URL(target).hostname)) return originalFetch(url, init);
    const currentToken = rotate ? rotatedToken : token, endpoint = rotate ? 'https://api.enterprise.githubcopilot.com' : 'https://api.business.githubcopilot.com';
    calls.push({ url: target, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization'),
      ...(init?.body && new URL(target).hostname.endsWith('.githubcopilot.com') ? { body: JSON.parse(String(init.body)) as Item } : {}) });
    if (target === 'https://github.com/login/device/code') {
      if (hold?.target === 'device') { hold.reached.resolve(init!.signal!); return hold.response.promise; }
      return Response.json(device);
    }
    if (target === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: grant });
    if (target === 'https://api.github.com/copilot_internal/v2/token') {
      expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + grant); exchanges++;
      return Response.json({ token: currentToken, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (target === endpoint + '/models') {
      expect(init?.method).toBe('GET'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + currentToken);
      if (hold?.target === 'catalogue') { hold.reached.resolve(init!.signal!); return hold.response.promise; }
      return Response.json(catalogue);
    }
    expect(new URL(target).hostname).toBe(new URL(endpoint).hostname);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + currentToken); expect(new Headers(init?.headers).get('x-api-key')).toBeNull();
    const body = calls.at(-1)!.body!, selected = cases.find(row => row.model === body.model)!;
    expect(new URL(target).pathname).toBe(selected.api === 'anthropic-messages' ? '/v1/messages' : selected.api === 'openai-completions' ? '/chat/completions' : '/responses');
    const turn = (turns.get(selected.model) ?? 0) + 1; turns.set(selected.model, turn);
    const events = turn === 1 ? payload(selected.seed.events, token) : turn === 2 ? payload(selected.finalEvents, token)
      : routing.rows.find(row => row.model === selected.model && row.case === 'user')!.responseEvents;
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (events[0].type ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  };
  process.env.AI_HARNESS_MASTER_KEY = master;
  process.env.AI_HARNESS_AUTH_TOKEN = 'copilot-browser-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'copilot-browser-admin';
  const reader = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
  const close = async () => {
    hold?.response.resolve(Response.json({ data: [] }));
    try { await stop(); await rm(root, { recursive: true, force: true }); }
    finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  };
  try {
    await mkdir(cwd); await mkdir(dataDir);
    const extensions = path.join(cwd, '.ai-harness', 'extensions'); await mkdir(extensions, { recursive: true });
    await writeFile(path.join(extensions, 'echo.mjs'), `import { appendFile } from 'node:fs/promises';
      export default api => api.registerTool({ ...${JSON.stringify(reference.tools[0])}, execute: async input => {
        if (input.x !== 1) throw new Error('Invalid fixture input.');
        await appendFile(${JSON.stringify(marker)}, 'effect\\n'); return { content: 'result' };
      } });`);
    const options = { host: '127.0.0.1', port: 0, dataDir, defaultCwd: cwd, allowedRoots: [root],
      webRoot: fileURLToPath(new URL('../packages/web/dist/', import.meta.url)), enableMockProvider: true };
    const server = await start(options);
    return { base: `http://localhost:${server.port}`, file, token, rotatedToken, grant, calls, reader, close, models, cases, history, marker, cwd, dataDir,
      get exchanges() { return exchanges; },
      async restart() {
        await stop();
        const credentials = reader(); await credentials.load();
        const current = await credentials.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot', now: 0 });
        expect(current?.credential).toMatchObject({ type: 'oauth', accessToken: token, refreshToken: grant });
        if (current?.credential.type !== 'oauth') throw new Error('Missing fixture credential.');
        await credentials.setOAuth('github-copilot', { ...current.credential, expiresAt: 1 });
        rotate = true; await start({ ...options, port: server.port });
      },
      hold(target: 'device' | 'catalogue') {
        const current = { target, reached: deferred<AbortSignal>(), response: deferred<Response>() }; hold = current;
        return { reached: current.reached.promise, release: () => {
          hold = undefined; current.response.resolve(Response.json(target === 'device' ? device : catalogue));
        } };
      } };
  } catch (error) { await close(); throw error; }
}

for (const locale of ['en', 'fr'] as const) test(`native Copilot Settings ${locale}: encrypted login, private A/C/R restart/replay, cancellation and logout`, async ({ page }) => {
  const f = await fixture();
  const copy = locale === 'fr'
    ? { connect: 'Connecter', reconnect: 'Reconnecter', disconnect: 'Déconnecter', cancel: 'Annuler', connected: 'Fournisseur connecté.', select: 'Sélectionner le Provider IA', model: 'Sélectionner le modèle', newChat: 'Nouvelle conversation', compose: 'Zone de rédaction', send: 'Envoyer' }
    : { connect: 'Connect', reconnect: 'Reconnect', disconnect: 'Disconnect', cancel: 'Cancel', connected: 'Provider connected.', select: 'Select the AI Provider', model: 'Select the model', newChat: 'New chat', compose: 'Message composer', send: 'Send' };
  try {
    expect((await page.request.post(f.base + '/api/auth/login', { headers: { Origin: f.base }, data: { token: 'copilot-browser-admin' } })).status()).toBe(200);
    await reserveReadBudget(page.request, f.base);
    await page.addInitScript(locale => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: 'light', lastSettingsSection: 'provider-lifecycle' }));
    }, locale);
    const mutations: string[] = [];
    page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) mutations.push(new URL(request.url()).pathname); });
    await page.goto(f.base + '/settings#provider-lifecycle');
    await selectProviderConnection(page, 'builtin', 'github-copilot');
    const section = page.locator('#provider-lifecycle'), panel = section.locator('.oauth-device-flow');
    const card = section.locator('article[data-settings-selection="github-copilot"]');
    await expect(card.getByRole('button', { name: copy.connect, exact: true })).toBeVisible();
    const selection = await page.getByLabel(copy.select, { exact: true }).inputValue();
    expect(f.calls).toEqual([]);

    // Cancel before the Server can return a flow ID; HTTP disconnect owns this start.
    const device = f.hold('device');
    await card.getByRole('button', { name: copy.connect, exact: true }).click();
    const deviceSignal = await device.reached;
    await expect(panel.getByRole('button', { name: copy.cancel, exact: true })).toBeVisible();
    await panel.getByRole('button', { name: copy.cancel, exact: true }).click();
    await expect.poll(() => deviceSignal.aborted).toBe(true);
    device.release();
    await expect(panel).toHaveCount(0);
    expect(f.calls).toHaveLength(1);

    // Cancel after the GitHub grant, with account discovery held before publication.
    const catalogue = f.hold('catalogue');
    await card.getByRole('button', { name: copy.connect, exact: true }).click();
    await expect(panel).toContainText('WEB-CODE');
    await expect(panel.locator('a')).toHaveAttribute('href', 'https://github.com/login/device');
    await catalogue.reached;
    const cancelled = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/auth/oauth/'));
    await panel.getByRole('button', { name: copy.cancel, exact: true }).click();
    expect((await cancelled).status()).toBe(200);
    catalogue.release();
    const absent = f.reader(); await absent.load();
    expect(await absent.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' })).toBeUndefined();

    await card.getByRole('button', { name: copy.connect, exact: true }).click();
    await expect(panel).toContainText(copy.connected);
    await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();
    expect(await page.getByLabel(copy.select, { exact: true }).inputValue()).toBe(selection);
    const stored = f.reader(); await stored.load();
    expect((await stored.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' }))?.credential).toMatchObject({
      accessToken: f.token, refreshToken: f.grant, subscription: { provider: 'github-copilot', availableModelIds: f.models },
    });
    const encrypted = await readFile(f.file, 'utf8');
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    const visible = await page.locator('body').innerText();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of [f.token, f.grant, 'PRIVATE_COPILOT_DEVICE']) {
      expect(encrypted).not.toContain(secret); expect(visible).not.toContain(secret); expect(storage).not.toContain(secret);
    }
    await page.reload();
    await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();

    expect(mutations.some(path => path.includes('/models/enabled') || path.includes('/configuration/'))).toBe(false);
    expect((await page.request.post(f.base + '/api/workspaces/trust', { data: { cwd: f.cwd, confirm: true } })).status()).toBe(200);
    expect((await page.request.post(f.base + '/api/plugins/reload', { data: { cwd: f.cwd } })).status()).toBe(200);
    const sessions = new Map<string, string>();
    const bodies = (model: string) => f.calls.filter(call => call.body?.model === model).map(call => call.body!);
    const assistants = async (id: string) => readFile(path.join(f.dataDir, 'sessions', id + '.jsonl'), 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message' && entry.role === 'assistant'));
    const send = async (input: string) => {
      await page.getByRole('textbox', { name: copy.compose, exact: true }).fill(input);
      const accepted = page.waitForResponse(response => response.url().endsWith('/api/agent/runs') && response.request().method() === 'POST');
      await page.getByRole('button', { name: copy.send, exact: true }).click();
      const response = await accepted; expect(response.status()).toBe(202);
      const result = await response.json() as { run: { id: string }; session: { id: string } };
      await expect.poll(async () => (await page.request.get(f.base + '/api/agent/runs/' + result.run.id).then(response => response.json()) as { phase: string }).phase).toBe('completed');
      return result.session.id;
    };
    for (const row of f.cases) {
      // Explicit fixture-owner defaults initialize new drafts only after the no-selection login check.
      expect((await page.request.patch(f.base + '/api/configuration/scope', { data: { scope: 'global', values: {
        provider: 'github-copilot', model: row.model, thinking: 'off', toolPreset: 'default', autoCompaction: false,
      } } })).status()).toBe(200);
      await page.goto(f.base + '/settings#provider-lifecycle'); await page.reload();
      await selectModelSettings(page, 'providers');
      await page.getByLabel(copy.select, { exact: true }).selectOption('github-copilot');
      await selectModelSettings(page, 'model');
      await page.getByLabel(copy.model, { exact: true }).selectOption(row.model);
      await closeSettings(page);
      await page.getByRole('button', { name: copy.newChat, exact: true }).click();
      const id = await send('probe'); sessions.set(row.model, id);
      await expect(page.locator('.message.assistant .message-output').last()).toHaveText(row.blocks.filter(block => block.type === 'text').map(block => block.text).join(''));
      expect(bodies(row.model)).toHaveLength(2); expect(f.history(bodies(row.model)[1]!, row.api)).toEqual(row.expected(false));
      expect((await assistants(id)).map(message => message.blocks)).toEqual([row.blocks, row.blocks.filter(block => block.type !== 'tool_call')]);
      const sessionFile = path.join(f.dataDir, 'sessions', id + '.jsonl'), journal = await readFile(sessionFile, 'utf8');
      expect(journal).not.toContain(f.token); expect(journal).toContain('opaque-[REDACTED]-copilot'); expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
      for (const complete of [false, true]) {
        const exported = await page.request.get(f.base + '/api/sessions/' + id + '/export?format=json' + (complete ? '&includeOpaqueContinuations=true' : ''));
        expect(exported.status()).toBe(200); expect(exported.headers()['cache-control']).toBe('no-store'); expect(Boolean(exported.headers()['x-aiharness-export-warning'])).toBe(!complete);
        const text = await exported.text(); expect(text).not.toContain(f.token); expect(text.includes('opaque-')).toBe(complete);
        expect(text.includes('thinkingSignature')).toBe(complete); if (row.api === 'openai-responses') expect(text.includes('textSignature')).toBe(complete);
        expect(await readFile(sessionFile, 'utf8')).toBe(journal);
      }
    }
    expect(await readFile(f.marker, 'utf8')).toBe('effect\neffect\neffect\n');
    expect(f.exchanges).toBe(2);
    await page.goto('about:blank'); await f.restart();
    expect(f.exchanges).toBe(2); // Cold startup does not initialize credentials.
    expect((await page.request.post(f.base + '/api/auth/login', { headers: { Origin: f.base }, data: { token: 'copilot-browser-admin' } })).status()).toBe(200);
    expect(f.exchanges).toBe(2);
    await page.goto(f.base + '/settings#provider-lifecycle');
    await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();
    await expect.poll(() => f.exchanges).toBe(3);
    // The first real browser admission owns refresh, not this helper's protected API read.
    await reserveReadBudget(page.request, f.base);
    const refreshed = f.reader(); await refreshed.load();
    const durable = await refreshed.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot', now: 0 });
    expect(durable?.credential).toMatchObject({ type: 'oauth', accessToken: f.rotatedToken, refreshToken: f.grant,
      subscription: { provider: 'github-copilot', availableModelIds: f.models } });
    if (durable?.credential.type !== 'oauth') throw new Error('Missing refreshed fixture credential.');
    expect(Number.isFinite(durable.credential.expiresAt)).toBe(true); expect(durable.credential.expiresAt!).toBeGreaterThan(Date.now());
    for (const row of f.cases) {
      const id = sessions.get(row.model)!;
      const loaded = await page.request.get(f.base + '/api/sessions/' + id).then(response => response.json()) as Session;
      expect(loaded.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([row.blocks, row.blocks.filter(block => block.type !== 'tool_call')]);
      await page.goto(f.base + '/settings#provider-lifecycle');
      await selectModelSettings(page, 'providers');
      await page.getByLabel(copy.select, { exact: true }).selectOption('github-copilot');
      await selectModelSettings(page, 'model');
      await page.getByLabel(copy.model, { exact: true }).selectOption(row.model);
      await closeSettings(page);
      await page.locator(`a.session-main[href*="${id}"]`).click();
      // Earlier drafts inherited changing global defaults; pin this conversation's physical target explicitly.
      await page.getByLabel(copy.model, { exact: true }).fill(row.model);
      await expect.poll(async () => (await page.request.get(f.base + '/api/sessions/' + id).then(response => response.json()) as Session).model).toBe(row.model);
      expect(await send('continue')).toBe(id);
      await expect(page.locator('.message.assistant .message-output').last()).toHaveText('ok');
      expect(bodies(row.model)).toHaveLength(3); expect(f.history(bodies(row.model)[2]!, row.api)).toEqual(row.expected(true));
      const saved = await assistants(id); expect(saved.slice(0, 2).map(message => message.blocks)).toEqual([row.blocks, row.blocks.filter(block => block.type !== 'tool_call')]);
      expect(saved).toHaveLength(3); expect(saved.at(-1)).toMatchObject({ content: 'ok', provider: 'github-copilot', api: row.api, model: row.model });
      expect(JSON.stringify(saved)).not.toContain(f.token); expect(JSON.stringify(saved)).not.toContain(f.rotatedToken);
    }
    expect(f.exchanges).toBe(3);
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(f.marker, 'utf8')).toBe('effect\neffect\neffect\n');
    for (const secret of [f.token, f.rotatedToken, f.grant]) {
      expect(await readFile(f.file, 'utf8')).not.toContain(secret);
      await expect(page.locator('body')).not.toContainText(secret);
      expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret);
    }
    await expect(page.locator('body')).not.toContainText('opaque-');
    await page.goto(f.base + '/settings#provider-lifecycle'); await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();

    // The poll sampled a connected state before logout; its delayed browser response
    // must not restore retired presentation or start a replacement catalogue reload.
    const sampled = deferred<void>(), released = deferred<void>();
    await page.route('**/api/provider-registry/auth/oauth/*', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      expect((await response.json()).state).toBe('connected');
      sampled.resolve(); await released.promise;
      // Retirement can abort the request while its real response is held.
      if (!route.request().failure()) await route.fulfill({ response });
    });
    await card.getByRole('button', { name: copy.reconnect, exact: true }).click();
    await sampled.promise;
    const logout = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith('/auth/github-copilot'));
    await card.getByRole('button', { name: copy.disconnect, exact: true }).click();
    expect((await logout).status()).toBe(200);
    released.resolve();
    await expect(panel).toHaveCount(0);
    await expect(card.getByRole('button', { name: copy.connect, exact: true })).toBeVisible();
    const withdrawn = f.reader(); await withdrawn.load();
    expect(await withdrawn.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' })).toBeUndefined();
    expect(mutations.some(path => path.includes('/models/enabled') || path.includes('/configuration/'))).toBe(false);
    const count = f.calls.length;
    for (const row of f.cases) {
      const denied = await page.request.post(f.base + '/api/agent/runs', { data: { sessionId: sessions.get(row.model), cwd: f.cwd, provider: 'github-copilot', model: row.model, input: 'withdrawn', autoCompaction: false, maxRetries: 0 } });
      expect(denied.status()).toBe(500); expect(await denied.json()).toEqual({ error: 'Internal server error' });
      expect(await assistants(sessions.get(row.model)!)).toHaveLength(3);
    }
    expect(f.calls).toHaveLength(count); expect(await readFile(f.marker, 'utf8')).toBe('effect\neffect\neffect\n');
    expect(f.calls.filter(call => !call.body)).toHaveLength(15); expect(f.exchanges).toBe(4);
    expect(f.calls.filter(call => call.url === 'https://api.enterprise.githubcopilot.com/models')).toHaveLength(2);
    expect(f.calls.filter(call => call.body && new URL(call.url).hostname === 'api.enterprise.githubcopilot.com')).toHaveLength(3);
    expect(f.calls.filter(call => call.method !== 'GET' && !call.body).every(call => call.url.startsWith('https://github.com/login/'))).toBe(true);
  } finally {
    // Timeout closes Playwright's page before teardown. Still close the owned
    // Server and restore process-local fixtures; never replace the test failure.
    await page.goto('about:blank').catch(() => undefined);
    await f.close();
  }
});
