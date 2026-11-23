import AxeBuilder from '@axe-core/playwright';
import { createServer, type ServerResponse } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager, type AgentRunSnapshot, type Message } from '@ai-harness/core';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, reserveReadBudget, test as budgetTest, type Page } from './fixtures/test-budget';

// Real emitted Web, Express, disk extensions, Core and JSONL. Only the upstream
// model is deterministic. Offline mode drops the browser transport, not the run.
const test = budgetTest.extend<{ ownedReadBudget: void }>({
  ownedReadBudget: [async ({ page }, use) => {
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'web02-disposable' } })).ok()).toBe(true);
    await reserveReadBudget(page.request, base);
    await use();
  }, { auto: true, timeout: 70_000 }],
});
test.describe.configure({ mode: 'default', timeout: 60_000 });
let root: string, cwd: string, base: string;
let host: Awaited<ReturnType<typeof start>>;
let upstream: ReturnType<typeof createServer>;
const calls = new Map<string, number>();
const envNames = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_MASTER_KEY', 'AI_HARNESS_AGENT_DIR'] as const;
const previous = envNames.map(name => process.env[name]);
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const rich = '## Durable answer\n\nOwned selection survives live updates.\n\n| Item | Result |\n| --- | --- |\n| Native | **Ready** |\n\n```json\n{"verified": true}\n```\n\n<img src=x onerror="window.__executed=1">';
const gate = (key: string) => writeFile(path.join(cwd, key), 'go');
async function wait(key: string, response: ServerResponse) {
  while (!response.destroyed) {
    try { await access(path.join(cwd, key)); return; } catch { /* Real upstream gate. */ }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
function delta(response: ServerResponse, content: string, finish: string | null = null) {
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`);
}

test.beforeAll(async ({ request }) => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-web02-')); cwd = path.join(root, 'work');
  await mkdir(path.join(cwd, '.ai-harness', 'extensions'), { recursive: true });
  await writeFile(path.join(cwd, '.ai-harness', 'extensions', 'reading.js'), `import { access } from 'node:fs/promises';
import path from 'node:path';
export default api => api.registerTool({ name: 'reading_probe', description: 'Native reading probe',
  parameters: { type: 'object', properties: { key: { type: 'string' }, dialog: { type: 'boolean' } }, required: ['key'] },
  execute: async (input, context, signal) => {
    await context.onProgress({ version: 1, content: 'Native tool in progress' });
    if (input.dialog) await context.requestInteraction({ kind: 'input', title: 'Native reading approval', signal });
    while (!signal?.aborted) { try { await access(path.join(context.cwd, input.key + '-tool')); break; } catch {} await new Promise(r => setTimeout(r, 15)); }
    return { content: 'Native structured result', structuredContent: { verified: true, count: 2 },
      blocks: [{ type: 'image', mediaType: 'image/png', name: 'reading.png', url: '${png}' }] };
  }
});`);
  process.env.AI_HARNESS_AUTH_TOKEN = 'web02-disposable'; process.env.AI_HARNESS_ADMIN_TOKEN = 'web02-disposable';
  process.env.AI_HARNESS_MASTER_KEY = '22'.repeat(32); process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
  upstream = createServer(async (request, response) => {
    if (request.url?.endsWith('/models')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'reading-model' }] })); return; }
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Array<{ role: string; content: unknown }> };
    const prompt = body.messages.filter(message => message.role === 'user' && typeof message.content === 'string' && /^\w+:[\w-]+$/.test(message.content)).at(-1)!.content as string;
    const [mode, key] = prompt.split(':'); const attempt = (calls.get(key) ?? 0) + 1; calls.set(key, attempt);
    if (mode === 'retry' && attempt === 1) {
      await wait(key + '-fail', response);
      response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Temporary reading outage' } })); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (['tool', 'dialog', 'rich'].includes(mode) && !body.messages.some(message => message.role === 'tool')) {
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'reading-call', type: 'function',
        function: { name: 'reading_probe', arguments: JSON.stringify({ key, dialog: mode === 'dialog' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`); return;
    }
    delta(response, mode === 'error' ? 'Durable partial answer.' : 'Live reading prefix. ');
    await wait(key + '-finish', response);
    if (response.destroyed) return;
    if (mode === 'error') { response.end('data: INVALID_PROVIDER_JSON\n\n'); return; }
    if (mode === 'large') for (let index = 0; index < 2_000; index++) delta(response, `Stream ${index}: ` + 'bounded '.repeat(20) + '\n');
    delta(response, mode === 'rich' ? '\n\n' + rich : 'Canonical reading complete.', 'stop'); response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  host = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), defaultCwd: cwd,
    allowedRoots: [root], webRoot: path.resolve('packages/web/dist') });
  base = `http://127.0.0.1:${host.port}`;
  expect((await request.post(`${base}/api/auth/login`, { data: { token: 'web02-disposable' } })).ok()).toBe(true);
  expect((await request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).ok()).toBe(true);
  const registered = await request.post(`${base}/api/provider-registry/custom`, { data: { id: 'reading-upstream', name: 'Reading upstream',
    dialect: 'openai-completions', baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKey: 'web02-model-disposable' } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const reload = await request.post(`${base}/api/agent/reload`, { data: { cwd } }); expect(reload.ok()).toBe(true);
  expect((await reload.json()).errors).toEqual([]);
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ai-harness-locale', 'en');
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, sidebarVisible: false, filesOpen: false, selectionActions: true }));
  });
});
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const id = /\/chat\/([^/?#]+)/.exec(page.url())?.[1];
  if (id) {
    const file = testInfo.outputPath('canonical-failure-state.json');
    await writeFile(file, JSON.stringify(await state(page, id), null, 2));
    await testInfo.attach('canonical-failure-state', { path: file, contentType: 'application/json' });
  }
});
test.afterAll(async () => {
  if (host) await stop(host);
  if (upstream) { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
  envNames.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  if (root) await rm(root, { recursive: true, force: true });
});
async function state(page: Page, id: string) {
  const response = await page.request.get(`${base}/api/agent/sessions/${id}/state`); expect(response.status(), await response.text()).toBe(200);
  return await response.json() as { run: AgentRunSnapshot; session: { messages: Message[] }; lastSequence: number };
}
async function create(page: Page, title = 'Native conversation') {
  const response = await page.request.post(`${base}/api/sessions`, { data: { cwd, title } }); expect(response.status()).toBe(201);
  return await response.json() as { id: string };
}
async function openNavigation(page: Page) {
  await page.locator('.main-content').focus();
  await page.keyboard.press('Control+Shift+S');
  await expect(page.locator('.sidebar')).toBeVisible();
}
async function begin(page: Page, mode: string) {
  const session = await create(page); const key = session.id;
  const connections: string[] = [];
  page.on('request', request => { if (request.url().includes(`/api/agent/sessions/${session.id}/events?`)) connections.push(request.url()); });
  await page.goto(`${base}/chat/${session.id}?cwd=${encodeURIComponent(cwd)}`);
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  const response = await page.request.post(`${base}/api/agent/runs`, { data: { sessionId: session.id, cwd,
    provider: 'reading-upstream', model: 'reading-model', input: `${mode}:${key}`, toolPreset: 'full', autoCompaction: false, maxRetries: mode === 'retry' ? 2 : 0 } });
  expect(response.status(), await response.text()).toBe(202);
  return { id: session.id, key, connections };
}

for (const phase of ['model', 'tool', 'dialog', 'retry']) test(`native offline/reconnect during ${phase} preserves draft, focus and exactly-once history`, async ({ page }) => {
  const { id, key, connections } = await begin(page, phase);
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  if (phase === 'tool') await expect(page.locator('.generic-tool-progress')).toContainText('Native tool in progress');
  else if (phase === 'dialog') await expect(page.getByRole('dialog', { name: 'Native reading approval' })).toBeVisible();
  else if (phase === 'model') await expect(page.getByRole('log')).toContainText('Live reading prefix.');
  else await expect.poll(() => calls.get(key)).toBe(1);
  if (phase !== 'dialog') { await composer.fill('Unsent reading draft'); await composer.focus(); }
  else await page.getByRole('dialog').getByRole('textbox').fill('Approval draft');
  const before = await state(page, id); await expect.poll(() => connections.length).toBeGreaterThan(0);
  const connected = connections.length;
  await page.context().setOffline(true);
  try {
    if (phase === 'retry') {
      await gate(key + '-fail');
      await expect.poll(async () => Boolean((await state(page, id)).run.retry)).toBe(true);
    } else if (phase === 'model') await gate(key + '-finish');
    else if (phase === 'tool') { await gate(key + '-tool'); await gate(key + '-finish'); }
    if (phase === 'model' || phase === 'tool') await expect.poll(async () => (await state(page, id)).run.phase).toBe('completed');
  } finally { await page.context().setOffline(false); }
  if (phase === 'dialog') {
    const dialog = page.getByRole('dialog', { name: 'Native reading approval' });
    await expect(dialog.getByRole('textbox')).toHaveValue('Approval draft');
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
    await gate(key + '-tool'); await gate(key + '-finish');
  } else if (phase === 'retry') await gate(key + '-finish');
  await expect(page.getByRole('log')).toContainText('Canonical reading complete.');
  await expect.poll(() => connections.length).toBeGreaterThan(connected);
  await expect.poll(async () => (await state(page, id)).run.phase).toBe('completed');
  const canonical = await state(page, id); expect(canonical.lastSequence).toBeGreaterThan(before.lastSequence);
  expect(canonical.session.messages.filter(message => message.role === 'user')).toHaveLength(1);
  expect(canonical.session.messages.filter(message => message.role === 'assistant' && message.content.includes('Canonical reading complete.'))).toHaveLength(1);
  await expect(page.locator('.message.assistant').filter({ hasText: 'Canonical reading complete.' })).toHaveCount(1);
  if (phase !== 'dialog') { await expect(composer).toHaveValue('Unsent reading draft'); await expect(composer).toBeFocused(); }
  expect(calls.get(key)).toBe(phase === 'model' ? 1 : 2);
  await page.reload(); await expect(page.getByRole('log')).toContainText('Canonical reading complete.');
  await expect(page.locator('.message.assistant').filter({ hasText: 'Canonical reading complete.' })).toHaveCount(1);
});

for (const mobile of [false, true]) for (const theme of ['light', 'dark']) test(`native rich reading ${mobile ? 'mobile' : 'desktop'} ${theme}`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
  const { id, key } = await begin(page, 'rich'); await gate(key + '-tool'); await gate(key + '-finish');
  await expect(page.getByRole('heading', { name: 'Durable answer', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, '__executed'))).toBeUndefined();
  await expect.poll(async () => (await state(page, id)).run.phase).toBe('completed');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Durable answer', exact: true })).toBeVisible();
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  const image = page.getByAltText('reading.png'); await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.getByRole('table')).toContainText('Ready');
  await expect(page.locator('.message.assistant pre.code-block')).toContainText('"verified": true');
  await expect(page.locator('.message.tool')).toContainText('[Structured result]');
  await expect(page.locator('.message.tool')).toContainText('"verified":true');
  await expect(page.locator('.generic-tool-progress[data-status="completed"]')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, '__executed'))).toBeUndefined();
  // Capture a defined cold-reader position, not a relative selection/composer scroll.
  const reading = page.locator('.messages-container');
  await reading.hover({ position: { x: 5, y: 5 } });
  await page.mouse.wheel(0, 10_000);
  await expect.poll(() => reading.evaluate(element => Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight))).toBeLessThan(1);
  await expect(reading).toHaveScreenshot(`reading-${mobile ? 'mobile' : 'desktop'}-${theme}.png`, { animations: 'disabled', caret: 'hide',
    mask: [page.locator('time'), page.locator('.process-summary')], maxDiffPixelRatio: 0.02 });
  expect((await new AxeBuilder({ page }).include('.messages-container').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1280);
  const paragraph = page.locator('.message.assistant p').filter({ hasText: 'Owned selection survives' });
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.closest('.messages-container')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  const toolbar = page.getByRole('toolbar', { name: 'Selected text actions' }); await expect(toolbar).toBeVisible();
  const ask = toolbar.getByRole('button', { name: 'Ask here', exact: true }); await ask.focus();
  // Genuine canonical reconnect must not replace equivalent reading nodes/ranges.
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/agent/sessions/${id}/state`);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const refreshedReply = await refreshed; expect(refreshedReply.status()).toBe(200); await refreshedReply.finished();
  await expect(ask).toBeFocused(); expect(await page.evaluate(() => getSelection()!.toString())).toBe('Owned selection survives live updates.');
  await ask.click(); await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toHaveValue('> Owned selection survives live updates.\n\n');
  expect((await state(page, id)).session.messages.some(message => message.blocks?.some(block => block.type === 'image'))).toBe(true);
});

test('native partial provider error remains durable after reconnect and reload', async ({ page }) => {
  const { id, key } = await begin(page, 'error'); await expect(page.getByRole('log')).toContainText('Durable partial answer.');
  await page.context().setOffline(true); await gate(key + '-finish');
  try { await expect.poll(async () => (await state(page, id)).run.phase).toBe('failed'); }
  finally { await page.context().setOffline(false); }
  await expect(page.locator('.reply-evidence.error')).toBeVisible();
  await page.reload(); await expect(page.getByRole('log')).toContainText('Durable partial answer.'); await expect(page.locator('.reply-evidence.error')).toBeVisible();
  expect((await state(page, id)).session.messages.filter(message => message.metadata?.outputError)).toHaveLength(1);
});

test('native large stream stays responsive and converges without duplicate output', async ({ page }, testInfo) => {
  const { id, key } = await begin(page, 'large');
  await expect(page.getByRole('log')).toContainText('Live reading prefix.');
  await page.evaluate(() => {
    Reflect.set(window, '__longTasks', []); Reflect.set(window, '__readingCommits', 0);
    new MutationObserver(() => Reflect.set(window, '__readingCommits', Reflect.get(window, '__readingCommits') + 1))
      .observe(document.querySelector('.messages-container')!, { subtree: true, childList: true, characterData: true });
    new PerformanceObserver(list => Reflect.get(window, '__longTasks').push(...list.getEntries().map(entry => entry.duration))).observe({ type: 'longtask', buffered: false });
  });
  const started = Date.now(); await gate(key + '-finish');
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true }); await composer.fill('Typing during a large stream');
  await expect(page.getByRole('log')).toContainText('Stream 1999:', { timeout: 15_000 });
  await expect(page.getByRole('log')).toContainText('Canonical reading complete.');
  await expect(composer).toHaveValue('Typing during a large stream');
  const durations = await page.evaluate(() => Reflect.get(window, '__longTasks') as number[]);
  const commits = await page.evaluate(() => Reflect.get(window, '__readingCommits') as number);
  await testInfo.attach('native-stream-performance', { body: JSON.stringify({ chunks: 2000, elapsedMs: Date.now() - started, longTasks: durations, commits }), contentType: 'application/json' });
  expect(Math.max(0, ...durations)).toBeLessThan(2_000); expect(commits).toBeLessThan(100);
  await expect.poll(async () => (await state(page, id)).run.phase).toBe('completed');
  const snapshot = await state(page, id); expect(snapshot.run.phase).toBe('completed');
  expect(snapshot.session.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
  await expect(page.locator('.message.assistant')).toHaveCount(1);
});

async function seedHistory() {
  // Public Core journal owner, before Server loads the session. No DTO fixture.
  const manager = new SessionManager({ store: new JsonlSessionStore(path.join(root, 'data', 'sessions')) });
  const source = await manager.create({ cwd, title: 'Searchable history' });
  for (let index = 0; index < 180; index++) await manager.addMessage(source.id, { role: index % 2 ? 'assistant' : 'user', content: `History row ${index} ${index === 12 ? 'UNIQUE_READING_TARGET' : 'native bounded history'}` });
  const target = manager.get(source.id)!.messages[12]!;
  const file = path.join(root, 'data', 'sessions', source.id + '.jsonl');
  return { source, target, file, original: await readFile(file, 'utf8') };
}

test('native history search, branch and cold anchor restoration preserve the source journal', async ({ page }) => {
  const { source, target, file, original } = await seedHistory();
  await page.goto(`${base}/chat/${source.id}?cwd=${encodeURIComponent(cwd)}`);
  await openNavigation(page);
  await page.getByRole('searchbox', { name: 'Search conversations', exact: true }).fill('UNIQUE_READING_TARGET');
  await page.locator('.search-results .session-search-link').click();
  const row = page.locator(`[id="${target.id}"]`); await expect(row).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#' + encodeURIComponent(target.id));
  await page.reload(); await expect(row).toBeVisible();
  // Explicit branching is a native new related session, never an in-place leaf edit.
  await row.getByRole('button', { name: 'Edit from here', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true }); await expect(composer).toHaveValue(target.content);
  await page.getByRole('button', { name: 'Cancel history edit', exact: true }).click();
  const fork = await page.request.post(`${base}/api/sessions/${source.id}/fork`, { data: { messageId: target.id, title: 'Reading branch' } });
  expect(fork.status(), await fork.text()).toBe(201); const branch = await fork.json() as { id: string };
  await page.goto(`${base}/chat/${branch.id}?cwd=${encodeURIComponent(cwd)}`); await expect(page.getByRole('log')).toContainText('UNIQUE_READING_TARGET');
  await page.reload(); await expect(page.getByRole('log')).toContainText('UNIQUE_READING_TARGET');
  expect(await readFile(file, 'utf8')).toBe(original);
});

for (const query of ['before', 'around']) test(`native late ${query} page is retired across an A/B/A view replacement`, async ({ page }) => {
  const { source, target } = await seedHistory(); const other = await create(page, 'Replacement conversation');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let received = false, delivered = false;
  const pattern = `**/api/sessions/${source.id}/messages?*`;
  await page.route(pattern, async route => {
    if (!new URL(route.request().url()).searchParams.has(query)) { await route.continue(); return; }
    // Fetch genuine Express output, then delay only delivery. No invented body.
    const response = await route.fetch(); received = true; await held;
    try { await route.fulfill({ response }); } catch { /* The retired client may have aborted transport. */ }
    delivered = true;
  });
  try {
    await page.goto(`${base}/chat/${source.id}?cwd=${encodeURIComponent(cwd)}${query === 'around' ? '#' + target.id : ''}`);
    if (query === 'before') {
      const button = page.getByRole('button', { name: 'Load earlier messages', exact: true });
      await button.scrollIntoViewIfNeeded(); await button.click();
    }
    await expect.poll(() => received).toBe(true);
    await openNavigation(page);
    await page.locator(`.sidebar-nav a.session-main[href^="/chat/${other.id}?"]`).click();
    await expect(page).toHaveURL(new RegExp('/chat/' + other.id));
    await page.locator(`.sidebar-nav a.session-main[href^="/chat/${source.id}?"]`).click();
    await expect(page).toHaveURL(new RegExp('/chat/' + source.id + '\\?'));
    await page.getByRole('button', { name: 'Conversation map', exact: true }).click();
    const count = page.locator('.conversation-minimap header'); const before = await count.textContent();
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true }); await composer.fill('New view intent'); await composer.focus();
    release(); await expect.poll(() => delivered).toBe(true);
    await expect(count).toHaveText(before!); await expect(composer).toHaveValue('New view intent'); await expect(composer).toBeFocused();
    await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toBeEnabled();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('native failed rich-reader asset retains readable text, draft and Stop without a global crash', async ({ page }) => {
  await page.route(/\/assets\/MarkdownContentRenderer-[^/]+\.js$/u, route => route.abort('failed'));
  const { key } = await begin(page, 'model');
  await expect(page.getByRole('log')).toContainText('Live reading prefix.');
  await expect(page.getByRole('button', { name: 'Stop model', exact: true })).toBeEnabled();
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true }); await composer.fill('Keep this unsent draft');
  await gate(key + '-finish'); await expect(page.getByRole('log')).toContainText('Canonical reading complete.');
  await expect(composer).toHaveValue('Keep this unsent draft');
});

test('native historical selection and its focused action survive new live output', async ({ page }) => {
  const session = await create(page);
  const text = 'This historical selection belongs to the reader.';
  for (const [role, content] of [['user', 'Read this history'], ['assistant', text]]) {
    const added = await page.request.post(`${base}/api/sessions/${session.id}/messages`, { data: { role, content } }); expect(added.status()).toBe(201);
  }
  await page.goto(`${base}/chat/${session.id}?cwd=${encodeURIComponent(cwd)}`);
  const paragraph = page.locator('.message.assistant p').filter({ hasText: text }); await expect(paragraph).toBeVisible();
  const run = await page.request.post(`${base}/api/agent/runs`, { data: { sessionId: session.id, cwd,
    provider: 'reading-upstream', model: 'reading-model', input: `model:${session.id}`, autoCompaction: false, maxRetries: 0 } }); expect(run.status()).toBe(202);
  await expect(page.getByRole('log')).toContainText('Live reading prefix.');
  await paragraph.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.closest('.messages-container')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  const action = page.getByRole('toolbar', { name: 'Selected text actions' }).getByRole('button', { name: 'Ask here', exact: true }); await action.focus();
  await gate(session.id + '-finish'); await expect(page.getByRole('log')).toContainText('Canonical reading complete.');
  await expect(action).toBeFocused(); expect(await page.evaluate(() => getSelection()!.toString())).toBe(text);
  await action.click(); await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toHaveValue(`> ${text}\n\n`);
});
