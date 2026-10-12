import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from './fixtures/test-budget';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRunSnapshot, Message, ToolProgressSnapshot } from '@ai-harness/core';

// A real on-disk extension executes in Core, behind the production Express API.
// Only the upstream model endpoint is deterministic. No intercepted product API,
// fake React renderer, fake run snapshot, SSE fixture or browser progress cache.
const extension = `import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
export default function(api) {
  api.registerTool({ name: 'arbitrary_custom', description: 'Real generic progress probe', parameters: {
    type: 'object', properties: { token: { type: 'string' }, mode: { type: 'string' } }, required: ['token', 'mode'] },
    execute: async (input, context, signal) => {
      const file = name => path.join(context.cwd, input.token + '-' + name);
      // Core deliberately omits the optional generic sink for code-mode nested
      // calls. Ordinary host-issued invocations must still report through it.
      const report = update => context.toolCallId === undefined ? Promise.resolve() : context.onProgress(update);
      const wait = async name => { while (!signal?.aborted) { try { await access(file(name)); return; } catch {} await new Promise(r => setTimeout(r, 25)); } };
      if (input.mode === 'legacy') return { content: 'Legacy custom result without progress' };
      await report({ version: 2, content: 'UNKNOWN VERSION MUST NOT APPEAR' });
      await report({ version: 1, content: 'Preparing custom work', details: { phase: 'prepare' } });
      await wait('latest');
      if (!signal?.aborted) {
        await report({ version: 1, details: { oversized: 'x'.repeat(100000), many: Array(1000).fill(true) } });
        await report({ version: 1, content: '<img src=x onerror="window.__progressExecuted=1"> **plain tool text**', details: {
          phase: 'scan', step: 2, usage: { costUsd: 999 }, activatedTools: ['hidden'], store: { injected: true },
          toolCallId: 'forged-nested', nestedCalls: [{ id: context.toolCallId + ':1', parentId: context.toolCallId }] } });
      }
      await wait('finish');
      if (signal?.aborted) {
        await report({ version: 1, content: 'LATE UPDATE MUST NOT APPEAR' });
        await writeFile(file('late-attempted'), 'yes');
        return { content: 'LATE RESULT MUST NOT APPEAR' };
      }
      if (input.mode === 'clear') await report({ version: 1, content: '', details: null });
      if (input.mode === 'failure') throw new Error('Real custom tool failure');
      return { content: 'Custom tool finished' };
    }
  });
}`;
let root: string;
const probes = new WeakMap<Page, string>();
let modelServer: Server;
let modelPort: number;
const provider = `generic-progress-probe-${process.pid}`;

test.describe.configure({ mode: 'default', timeout: 60_000 });
test.beforeAll(async ({ request }) => {
  root = await mkdtemp(path.join(process.cwd(), '.generic-progress-e2e-'));
  await mkdir(path.join(root, '.ai-harness', 'extensions'), { recursive: true });
  await writeFile(path.join(root, '.ai-harness', 'extensions', 'progress.js'), extension);
  expect((await request.post('/api/workspaces/trust', { data: { cwd: root, confirm: true } })).ok()).toBe(true);
  const reload = await request.post('/api/agent/reload', { data: { cwd: root } });
  expect(reload.ok()).toBe(true);
  expect((await reload.json()).errors).toEqual([]);
  modelServer = createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'progress-model' }] })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Array<{ role: string; content?: string }> };
    const prompt = body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
    const [mode, token] = prompt.split(':');
    const toolCount = body.messages.filter(message => message.role === 'tool').length;
    const calls = mode === 'siblings' ? ['host-first', 'host-sibling'] : ['host-outer'];
    const delta = toolCount > 0 ? { content: 'Real progress probe complete' } : { tool_calls: calls.map((id, index) => ({
      index, id, type: 'function', function: mode === 'codemode'
        ? { name: 'codemode', arguments: JSON.stringify({ code: `text(await tools.arbitrary_custom(${JSON.stringify({ mode: 'success', token })}));` }) }
        : { name: 'arbitrary_custom', arguments: JSON.stringify({ mode: mode === 'siblings' && index === 1 ? 'clear' : mode, token }) },
    })) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  modelPort = (modelServer.address() as { port: number }).port;
  const registered = await request.post('/api/provider-registry/custom', { data: {
    id: provider, name: 'Generic progress probe', dialect: 'openai-completions', baseUrl: `http://127.0.0.1:${modelPort}/v1`,
    apiKey: 'disposable-generic-progress-test-key',
  } });
  expect(registered.ok()).toBe(true);
});
test.afterAll(async ({ request }) => {
  await request.delete(`/api/provider-registry/custom/${provider}`);
  if (modelServer) await new Promise<void>(resolve => { modelServer.closeAllConnections(); modelServer.close(() => resolve()); });
  if (root) {
    await rm(root, { recursive: true, force: true });
    // Drop our generation, never modify another test's extension files.
    const defaultWorkspace = await (await request.get('/api/workspaces/default')).json() as { cwd: string };
    await request.post('/api/agent/reload', { data: { cwd: defaultWorkspace.cwd } });
  }
});

test.afterEach(async ({ page }, testInfo) => {
  const sessionId = probes.get(page);
  if (testInfo.status !== testInfo.expectedStatus && sessionId) {
    await testInfo.attach('actual-public-agent-state', {
      body: JSON.stringify(await state(page.request, sessionId), null, 2), contentType: 'application/json',
    });
  }
});

async function begin(page: Page, mode: string) {
  const token = `probe-${Date.now()}-${mode}`;
  const created = await page.request.post('/api/sessions', { data: { cwd: root, title: 'Generic tool progress' } });
  expect(created.status()).toBe(201);
  const session = await created.json() as { id: string };
  probes.set(page, session.id);
  await page.goto(`/chat/${session.id}?cwd=${encodeURIComponent(root)}`);
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  await expect(page.locator('.generic-tool-progress')).toHaveCount(0);
  const started = await page.request.post('/api/agent/runs', { data: { sessionId: session.id, cwd: root,
    provider, model: 'progress-model', input: `${mode}:${token}`, toolPreset: 'full', autoCompaction: false, maxRetries: 0 } });
  expect(started.status(), await started.text()).toBe(202);
  const { run } = await started.json() as { run: AgentRunSnapshot };
  return { sessionId: session.id, runId: run.id, token, gate: (name: string) => writeFile(path.join(root, `${token}-${name}`), 'go') };
}
async function state(request: APIRequestContext, sessionId: string) {
  return await (await request.get(`/api/agent/sessions/${sessionId}/state`)).json() as {
    run: AgentRunSnapshot; session: { messages: Message[] }; lastSequence: number;
  };
}
async function accessible(page: Page, card: Locator, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const result = await new AxeBuilder({ page }).include('.generic-tool-progress').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
  const summary = card.locator('summary');
  await summary.focus(); await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card.locator('details')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => (window as unknown as { __progressExecuted?: number }).__progressExecuted)).toBeUndefined();
  await expect(card.locator('img, script, input, textarea, iframe')).toHaveCount(0);
}
async function capture(card: Locator, name: string) {
  // Assert real host duration separately; its wall-clock value is inherently variable.
  await expect(card.locator('small')).toContainText(/Host duration: \d+\.\d{2}s/);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveScreenshot(name, { animations: 'disabled', caret: 'hide', mask: [card.locator('small')] });
}

for (const scenario of [
  { name: 'desktop-light', width: 1440, theme: 'light' }, { name: 'desktop-dark', width: 1440, theme: 'dark' },
  { name: 'mobile-light', width: 390, theme: 'light' }, { name: 'mobile-dark', width: 390, theme: 'dark' },
] as const) {
  test(`${scenario.name}: genuine live phase, snapshot and durable terminal reload`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
      version: 4, theme, sidebarVisible: false, filesOpen: false, sound: false,
    })), scenario.theme);
    const probe = await begin(page, 'success');
    const card = page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true });
    await expect(card).toContainText('Preparing custom work');
    const start = (await state(page.request, probe.sessionId)).run.activeTool!.progress!;
    expect(start).toMatchObject({ version: 1, toolCallId: 'host-outer', toolName: 'arbitrary_custom', status: 'running', sequence: 1 });
    await capture(card, `generic-progress-preparing-${scenario.name}.png`);
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    await composer.focus();
    await probe.gate('latest');
    await expect(card).toContainText('**plain tool text**'); // actual live SSE update, not a fake fixture
    await expect(composer).toBeFocused(); // no automatic/native keyboard focus
    const latest = (await state(page.request, probe.sessionId)).run.activeTool!.progress!;
    expect(latest.sequence).toBe(3); expect(latest.durationMs).toBeGreaterThanOrEqual(start.durationMs);
    await accessible(page, card, scenario.width);
    await expect(card).toContainText('costUsd'); await expect(card).not.toContainText('$999');
    await capture(card, `generic-progress-running-${scenario.name}.png`);
    await page.reload(); // genuine current running snapshot restores the same public shape
    await expect(card).toContainText('**plain tool text**');
    expect((await state(page.request, probe.sessionId)).run.activeTool!.progress).toEqual(latest);
    await probe.gate('finish');
    await expect(card).toHaveAttribute('data-status', 'completed');
    await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
    const completed = await state(page.request, probe.sessionId);
    expect(completed.run.activeTool).toBeUndefined();
    const results = completed.session.messages.filter(message => message.role === 'tool');
    expect(results).toHaveLength(1); expect(results[0]!.usage).toBeUndefined();
    const terminal = results[0]!.metadata!.toolProgress as ToolProgressSnapshot;
    expect(terminal).toMatchObject({ ...latest, status: 'completed', sequence: 4, durationMs: expect.any(Number) });
    expect(terminal.durationMs).toBeGreaterThanOrEqual(latest.durationMs);
    await page.reload();
    await expect(card).toHaveAttribute('data-status', 'completed');
    await expect(page.locator('.message.tool')).toHaveCount(1);
    await accessible(page, card, scenario.width);
    await capture(card, `generic-progress-terminal-${scenario.name}.png`);
    expect((await state(page.request, probe.sessionId)).session.messages.filter(message => message.role === 'tool')[0]!.metadata!.toolProgress).toEqual(terminal);

    const cancelled = await begin(page, 'stop');
    await expect(card).toContainText('Preparing custom work');
    await cancelled.gate('latest'); await expect(card).toContainText('plain tool text');
    await page.getByRole('button', { name: 'Stop tool', exact: true }).click();
    await expect.poll(async () => (await state(page.request, cancelled.sessionId)).run.phase).toBe('stopped');
    await page.reload(); await expect(card).toHaveAttribute('data-status', 'cancelled');
    await accessible(page, card, scenario.width);
    await capture(card, `generic-progress-cancelled-${scenario.name}.png`);

    const cleared = await begin(page, 'clear');
    await expect(card).toContainText('Preparing custom work');
    await cleared.gate('latest'); await expect(card).toContainText('plain tool text');
    await cleared.gate('finish');
    await expect(card).toHaveAttribute('data-status', 'completed');
    await page.reload(); await expect(card).toContainText('No progress text reported.');
    await expect(card.locator('details')).toHaveCount(0);
    expect((await state(page.request, cleared.sessionId)).session.messages.filter(message => message.role === 'tool')[0]!.metadata!.toolProgress)
      .toMatchObject({ content: '', details: null, status: 'completed' });
    await capture(card, `generic-progress-cleared-${scenario.name}.png`);
  });
}

test('stop durably cancels, ignores real late extension updates/results and reload never resurrects running activity', async ({ page }) => {
  const probe = await begin(page, 'stop');
  const card = page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true });
  await expect(card).toContainText('Preparing custom work');
  await probe.gate('latest'); await expect(card).toContainText('plain tool text');
  await page.getByRole('button', { name: 'Stop tool', exact: true }).click();
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('stopped');
  expect(await readFile(path.join(root, `${probe.token}-late-attempted`), 'utf8')).toBe('yes');
  await expect(card).toHaveAttribute('data-status', 'cancelled');
  const stopped = await state(page.request, probe.sessionId);
  expect(stopped.run.activeTool).toBeUndefined();
  expect(stopped.session.messages.filter(message => message.role === 'tool')).toHaveLength(1);
  expect(JSON.stringify(stopped)).not.toMatch(/LATE UPDATE MUST NOT APPEAR|LATE RESULT MUST NOT APPEAR/);
  await page.reload(); await expect(card).toHaveAttribute('data-status', 'cancelled');
  await expect(page.locator('.message.tool')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop tool', exact: true })).toHaveCount(0);
});

test('siblings keep host IDs independent, clear content/details are authoritative, and legacy tools load no progress card', async ({ page }) => {
  const probe = await begin(page, 'siblings');
  const card = page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true });
  await expect(card).toContainText('Preparing custom work');
  await probe.gate('latest'); await expect(card).toContainText('plain tool text');
  await probe.gate('finish');
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
  await expect(card).toHaveCount(2);
  const results = (await state(page.request, probe.sessionId)).session.messages.filter(message => message.role === 'tool');
  expect(results.map(message => message.toolCallId)).toEqual(['host-first', 'host-sibling']);
  expect(results[1]!.metadata!.toolProgress).toMatchObject({ toolCallId: 'host-sibling', content: '', details: null });
  await page.reload(); await expect(card).toHaveCount(2);
  await expect(card.last()).toContainText('No progress text reported.');
  const legacy = await begin(page, 'legacy');
  await expect.poll(async () => (await state(page.request, legacy.sessionId)).run.phase).toBe('completed');
  await expect(page.locator('.message.tool')).toContainText('Legacy custom result without progress');
  await expect(page.locator('.generic-tool-progress')).toHaveCount(0);
});

for (const scenario of [
  { name: 'desktop-light', width: 1440, theme: 'light' }, { name: 'desktop-dark', width: 1440, theme: 'dark' },
  { name: 'mobile-light', width: 390, theme: 'light' }, { name: 'mobile-dark', width: 390, theme: 'dark' },
] as const) {
  test(`${scenario.name}: French leaf copy and genuine failed terminal persist after reload`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
      version: 4, theme, sidebarVisible: false, filesOpen: false, sound: false,
    })), scenario.theme);
    const probe = await begin(page, 'failure');
    await page.evaluate(() => localStorage.setItem('ai-harness-locale', 'fr'));
    await page.reload();
    const card = page.getByRole('region', { name: 'Progression de l’outil: arbitrary_custom', exact: true });
    await expect(card).toContainText('en cours');
    await expect(card).toContainText('Phase de l’outil · mise à jour');
    await probe.gate('latest');
    await expect(card).toContainText('plain tool text');
    await accessible(page, card, scenario.width);
    await expect(card).toContainText('Détails déclarés par l’outil (autodéclarés)');
    await expect(card).toContainText('utilisation, coût et permissions non vérifiés');
    await probe.gate('finish');
    await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
    await expect(card).toHaveAttribute('data-status', 'failed');
    const failed = (await state(page.request, probe.sessionId)).session.messages.filter(message => message.role === 'tool');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ isError: true, content: 'Real custom tool failure', metadata: { toolProgress: { status: 'failed' } } });
    await page.reload();
    await expect(card).toHaveAttribute('data-status', 'failed');
    await expect(card).toContainText('échec');
    await accessible(page, card, scenario.width);
    await expect(card.locator('small')).toContainText(/Durée mesurée par l’hôte: \d+\.\d{2}s/);
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveScreenshot(`generic-progress-failed-fr-${scenario.name}.png`, {
      animations: 'disabled', caret: 'hide', mask: [card.locator('small')],
    });
  });
}

const cardScript = /\/(?:src\/components\/ToolProgressCard\.tsx|assets\/ToolProgressCard-[^/]+\.js)(?:\?.*)?$/u;
const cardStyle = /\/(?:src\/components\/tool-progress-card\.css|assets\/ToolProgressCard-[^/]+\.css)(?:\?.*)?$/u;

test('legacy tools leave progress JS/CSS unloaded; a genuine delayed leaf has nonblank loading and never steals focus', async ({ page }) => {
  const assets: string[] = [];
  page.on('request', request => { if (cardScript.test(request.url()) || cardStyle.test(request.url())) assets.push(request.url()); });
  const legacy = await begin(page, 'legacy');
  await expect.poll(async () => (await state(page.request, legacy.sessionId)).run.phase).toBe('completed');
  await expect(page.locator('.message.tool')).toContainText('Legacy custom result without progress');
  expect(assets).toEqual([]);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(cardScript, async route => { await held; await route.continue(); });
  const probe = await begin(page, 'success');
  const region = page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true });
  await expect(region.getByRole('status')).toHaveText('Loading tool progress…');
  await expect(region).toContainText('Preparing custom work');
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await composer.focus(); release();
  await expect(page.locator('.generic-tool-progress')).toContainText('Preparing custom work');
  await expect(composer).toBeFocused();
  expect(assets.some(asset => cardScript.test(asset))).toBe(true);
  expect(assets.some(asset => cardStyle.test(asset))).toBe(true);
  await probe.gate('latest'); await probe.gate('finish');
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
});

test('failed genuine leaf import shows progress/error text while product Stop remains usable', async ({ page }) => {
  await page.route(cardScript, route => route.abort('failed'));
  const probe = await begin(page, 'stop');
  const region = page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true });
  await expect(region.getByRole('status')).toHaveText('Progress display could not load. Tool execution is unaffected.');
  await expect(region).toContainText('Preparing custom work');
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop tool', exact: true }).click();
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('stopped');
  await expect(region).toContainText('cancelled');
});

test('real code-mode nested progress retains specialized live and durable cards without generic promotion', async ({ page }) => {
  const settings = await page.request.patch('/api/tools', { data: {
    cwd: root, enabledTools: ['arbitrary_custom', 'codemode'], toolPreset: 'full', powershellEnabled: false,
    codemodeEnabled: true, codemodeMode: 'on',
  } });
  expect(settings.ok(), await settings.text()).toBe(true);
  const probe = await begin(page, 'codemode');
  const card = page.getByRole('region', { name: 'Code mode · QuickJS', exact: true });
  await expect(card.getByRole('list', { name: 'Nested calls' })).toContainText('arbitrary_custom');
  const running = await state(page.request, probe.sessionId);
  expect(running.run.activeTool).toMatchObject({ id: 'host-outer', name: 'codemode', nestedCalls: [
    { id: 'host-outer:1', parentId: 'host-outer', name: 'arbitrary_custom', state: 'running' },
  ] });
  expect(running.run.activeTool!.progress).toBeUndefined();
  await expect(page.locator('.generic-tool-progress')).toHaveCount(0);
  await probe.gate('latest');
  await probe.gate('finish');
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
  const results = (await state(page.request, probe.sessionId)).session.messages.filter(message => message.role === 'tool');
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ name: 'codemode', toolCallId: 'host-outer', metadata: { codemode: {
    engine: 'QuickJS', parentId: 'host-outer', nestedCalls: [
      { id: 'host-outer:1', parentId: 'host-outer', name: 'arbitrary_custom', state: 'completed' },
    ],
  } } });
  expect(results[0]!.metadata!.toolProgress).toBeUndefined();
  expect(results[0]!.usage).toBeUndefined();
  await page.reload();
  await expect(card).toContainText('arbitrary_custom');
  await expect(page.locator('.message.tool')).toHaveCount(1);
  await expect(page.locator('.generic-tool-progress')).toHaveCount(0);
});

test('ready watermark gap: actual running GET then completed readiness restores canonical transcript', async ({ page }, testInfo) => {
  const probe = await begin(page, 'success');
  const card = page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true });
  await expect(card).toContainText('Preparing custom work');
  await probe.gate('latest');
  await expect(card).toContainText('plain tool text');

  // Observe the actual response; do not construct or rewrite a transport record.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    (window as unknown as { __actualReadyFrames: string[] }).__actualReadyFrames = [];
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (response.url.includes('/api/agent/sessions/') && response.url.includes('/events?') && response.body) {
        const reader = response.clone().body!.getReader();
        void (async () => {
          const decoder = new TextDecoder();
          let text = '';
          try {
            while (text.length <= 1024 * 1024) {
              const next = await reader.read();
              if (next.done) break;
              text += decoder.decode(next.value, { stream: true });
              const end = text.indexOf('\n\n');
              if (end >= 0) {
                (window as unknown as { __actualReadyFrames: string[] }).__actualReadyFrames.push(text.slice(0, end));
                break;
              }
            }
          } finally { void reader.cancel().catch(() => undefined); }
        })().catch(() => undefined);
      }
      return response;
    };
  });

  let release!: () => void;
  const transportGate = new Promise<void>(resolve => { release = resolve; });
  const heldAfter: number[] = [];
  const events = `**/api/agent/sessions/${probe.sessionId}/events?*`;
  await page.route(events, async route => {
    heldAfter.push(Number(new URL(route.request().url()).searchParams.get('after')));
    await transportGate;
    await route.continue(); // Only delay forwarding. Express generates every byte.
  });
  try {
    const baselineReply = page.waitForResponse(response => response.url().includes(`/api/agent/sessions/${probe.sessionId}/state?`));
    await page.reload();
    const baseline = await (await baselineReply).json() as Awaited<ReturnType<typeof state>>;
    expect(baseline.run.phase).toBe('tool');
    expect(baseline.session.messages.filter(message => message.role === 'tool')).toHaveLength(0);
    await expect(card).toContainText('plain tool text');
    await expect.poll(() => heldAfter.length).toBeGreaterThan(0);
    expect(heldAfter[0]).toBeGreaterThanOrEqual(baseline.lastSequence);
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    await composer.fill('Preserve unsent draft');
    await composer.focus();
    await probe.gate('finish');
    await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
    const terminal = await state(page.request, probe.sessionId);
    expect(terminal.lastSequence).toBeGreaterThan(baseline.lastSequence);
    expect(terminal.session.messages.filter(message => message.role === 'tool')).toHaveLength(1);
    await expect(page.locator('.message.tool')).toHaveCount(0);
    release();
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __actualReadyFrames: string[] }).__actualReadyFrames)).length).toBeGreaterThan(0);
    const frames = await page.evaluate(() => (window as unknown as { __actualReadyFrames: string[] }).__actualReadyFrames);
    const frame = frames.find(value => value.includes('event: connection.ready'))!;
    expect(frame).toBeTruthy();
    const ready = JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6)) as {
      snapshot: { lastSequence: number; run: AgentRunSnapshot }; reset: boolean;
    };
    expect(ready.snapshot.lastSequence).toBe(terminal.lastSequence);
    expect(ready.snapshot.run.id).toBe(probe.runId);
    expect(ready.snapshot.run.phase).toBe('completed');
    expect(ready.reset).toBe(false); // Ordinary replay gap, not a synthetic reset.
    await testInfo.attach('actual-ready-ordering', { body: JSON.stringify({ baseline, heldAfter, frames, terminal }, null, 2), contentType: 'application/json' });
    await expect(card).toHaveAttribute('data-status', 'completed');
    await expect(page.locator('.message.tool')).toHaveCount(1);
    await expect(page.getByText('Real progress probe complete', { exact: true })).toBeVisible();
    await expect(composer).toHaveValue('Preserve unsent draft');
    await expect(composer).toBeFocused();
    await expect(page.getByRole('button', { name: 'Stop tool', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(card).toHaveAttribute('data-status', 'completed');
    await expect(page.locator('.message.tool')).toHaveCount(1);
  } finally {
    release();
    await page.unroute(events);
  }
});
