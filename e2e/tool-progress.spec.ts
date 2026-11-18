import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from './fixtures/test-budget';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { JsonlSessionStore, getSessionAccounting, type AgentRunSnapshot, type Message, type ToolProgressSnapshot } from '@ai-harness/core';
import { fixture as rowCopyFixture, openMenu as openRowCopyMenu, openNavigation as openRowCopyNavigation } from './fixtures/session-row-copy';

// A real on-disk extension executes in Core, behind the production Express API.
// Only the upstream model endpoint is deterministic. No intercepted product API,
// fake React renderer, fake run snapshot, SSE fixture or browser progress cache.
const extension = `import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
export default function(api) {
  const batches = new Map();
  api.registerTool({ name: 'arbitrary_custom', description: 'Real generic progress probe', parameters: {
    type: 'object', properties: { token: { type: 'string' }, mode: { type: 'string' } }, required: ['token', 'mode'] },
    execute: async (input, context, signal) => {
      const file = name => path.join(context.cwd, input.token + '-' + name);
      // Core deliberately omits the optional generic sink for code-mode nested
      // calls. Ordinary host-issued invocations must still report through it.
      const report = update => context.toolCallId === undefined ? Promise.resolve() : context.onProgress(update);
      const wait = async name => { while (!signal?.aborted) { try { await access(file(name)); return; } catch {} await new Promise(r => setTimeout(r, 25)); } };
      if (input.mode === 'legacy') return { content: 'Legacy custom result without progress' };
      if (input.mode === 'truncation') {
        await writeFile(file('executed'), String(input.value));
        return { content: 'Safe retry executed' };
      }
      if (input.mode.startsWith('dialogs')) {
        const first = context.requestInteraction({ kind: 'input', title: 'Live first approval', signal });
        const second = context.requestInteraction({ kind: 'custom', title: 'Live custom approval', signal,
          output: '<img src=x onerror="window.__dialogExecuted=1"> is plain text',
          fields: [{ name: 'note', label: 'Approval note', type: 'textarea', required: true },
            { name: 'approved', label: 'Approved', type: 'checkbox' }] });
        const third = context.requestInteraction({ kind: 'confirm', title: 'Live third approval', signal });
        await wait('replace');
        const changed = first.update({ kind: 'select', title: 'Updated live first approval',
          options: [{ value: 'yes', label: 'Approve current schema' }] });
        third.close();
        await writeFile(file('updated'), JSON.stringify({ changed, ids: [first.id, second.id, third.id] }));
        return { content: JSON.stringify(await Promise.all([first, second, third])) };
      }
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
  api.registerTool({ name: 'parallel_read', description: 'Native bounded readonly batch', readOnly: true,
    execute: async (input, context, signal) => {
      const batch = batches.get(input.token) ?? { active: 0, completed: 0 }; batches.set(input.token, batch); batch.active++;
      await context.onProgress({ version: 1, content: 'Parallel ' + input.part });
      while (!signal?.aborted) { try { await access(path.join(context.cwd, input.token + '-finish')); break; } catch {} await new Promise(r => setTimeout(r, 25)); }
      batch.active--; batch.completed++; return { content: input.part };
    }
  });
  api.registerTool({ name: 'nested_child', description: 'Native nested child', execute: async (_input, context) => {
    await context.onProgress({ version: 1, content: 'Nested child progress' });
    return { content: 'Nested child output', structuredContent: { value: 'disposable-generic-progress-test-key' } };
  } });
  api.registerTool({ name: 'nested_parent', description: 'Native serial parent', execute: async (input, context) => {
    const batch = batches.get(input.token); if (batch.active !== 0 || batch.completed !== 2) throw new Error('Batch not joined');
    const child = await context.executeTool('nested_child', {}); if (child.isError) throw new Error('Nested child refused');
    return { content: 'Nested complete', structuredContent: child.structuredContent,
      blocks: [{ type: 'image', mediaType: 'image/png', name: 'native-tool.png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT6sAAAAASUVORK5CYII=' }] };
  } });
}`;
let root: string;
const probes = new WeakMap<Page, string>();
let modelServer: Server;
let modelPort: number;
const modelRequests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
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
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean; messages: Array<{ role: string; content?: unknown }> };
    modelRequests.push(body);
    if (body.stream === false) {
      if (body.messages.some(message => typeof message.content === 'string' && message.content.includes('HTTP_RECOVERY_HISTORY'))) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'HTTP summary preserves prior decisions.' } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })); return;
      }
      // A real Core automatic summary stays pending until product Stop cancels
      // its HTTP request. No fabricated compaction event or browser snapshot.
      while (!res.destroyed) {
        try { await readFile(path.join(root, 'phase-summary-finish')); break; } catch { /* Still held by the real upstream gate. */ }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!res.destroyed) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'Actual summary' } }] })); }
      return;
    }
    const prompt = body.messages.flatMap(message => message.role === 'user' && typeof message.content === 'string' ? [message.content] : []).at(-1) ?? '';
    const [mode, token] = prompt.split(':');
    if (mode === 'truncated-tools') {
      const attempt = modelRequests.filter(request => request.messages.some(message => message.content === prompt)).length;
      let delta: unknown, finish: string;
      if (attempt === 1) {
        delta = { content: 'Partial truncated tool answer.', reasoning_content: 'Partial truncated thought.', tool_calls:
          ['complete', 'partial'].map((part, index) => ({ index, id: `cut-${part}`, type: 'function', function: { name: 'arbitrary_custom',
            arguments: JSON.stringify({ token, mode: 'truncation', ...(part === 'complete' ? { value: 'unsafe' } : {}) }) } })) };
        finish = 'length';
      } else if (attempt === 2) {
        while (!res.destroyed) {
          try { await readFile(path.join(root, `${token}-reissue`)); break; } catch { /* Browser verifies nonexecution before allowing retry. */ }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (res.destroyed) return;
        delta = { tool_calls: [{ index: 0, id: 'safe-retry', type: 'function', function: { name: 'arbitrary_custom',
          arguments: JSON.stringify({ token, mode: 'truncation', value: 'safe' }) } }] };
        finish = 'tool_calls';
      } else { delta = { content: 'HTTP_TRUNCATED_TOOLS_OK' }; finish = 'stop'; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`); return;
    }
    if (mode.startsWith('recover-')) {
      const first = modelRequests.filter(request => request.messages.some(message => message.content === prompt)).length === 1;
      if (first && mode === 'recover-overflow') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'disposable-generic-progress-test-key private diagnostic' } })); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: first ? 'Partial recovery answer.' : 'HTTP_RECOVERY_OK' }, finish_reason: first ? 'length' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`); return;
    }
    const toolCount = body.messages.filter(message => message.role === 'tool').length;
    if (mode === 'length' || mode === 'emptylength' || mode === 'provider-error' || mode === 'background-error' && toolCount > 0) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const content = mode === 'emptylength' ? '' : mode === 'length' ? 'Partial length answer.'
        : 'Partial visible output. disposable-generic-progress-test-key ' + 'safe tail '.repeat(20);
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: mode.endsWith('error') ? null : 'length' }] })}\n\n`
        + (mode.endsWith('error') ? 'data: INVALID_PROVIDER_JSON\n\n' : 'data: [DONE]\n\n'));
      return;
    }
    if (mode === 'parallel') {
      const delta = toolCount ? { content: 'Real progress probe complete' } : { tool_calls: ['one', 'two', 'parent'].map((part, index) => ({
        index, id: `parallel-${part}`, type: 'function', function: { name: part === 'parent' ? 'nested_parent' : 'parallel_read', arguments: JSON.stringify({ token, part }) },
      })) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: toolCount ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`); return;
    }
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

async function begin(page: Page, mode: string, seed?: string) {
  const token = `probe-${Date.now()}-${mode}`;
  const created = await page.request.post('/api/sessions', { data: { cwd: root, title: 'Generic tool progress' } });
  expect(created.status()).toBe(201);
  const session = await created.json() as { id: string };
  probes.set(page, session.id);
  // Meet the existing four-message compaction minimum before the overflow;
  // a length response must not be what makes the seeded history eligible.
  if (seed) for (const [role, content] of [['user', seed], ['assistant', 'Prior answer.'], ['user', 'Prior follow-up.'], ['assistant', 'Prior conclusion.']]) {
    const added = await page.request.post(`/api/sessions/${session.id}/messages`, { data: { role, content } }); expect(added.ok()).toBe(true);
  }
  await page.goto(`/chat/${session.id}?cwd=${encodeURIComponent(root)}`);
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  await expect(page.locator('.generic-tool-progress')).toHaveCount(0);
  const started = await page.request.post('/api/agent/runs', { data: { sessionId: session.id, cwd: root,
    provider, model: 'progress-model', input: `${mode}:${token}`, toolPreset: 'full', autoCompaction: mode.startsWith('recover-'), maxRetries: 0 } });
  expect(started.status(), await started.text()).toBe(202);
  const { run } = await started.json() as { run: AgentRunSnapshot };
  return { sessionId: session.id, runId: run.id, token, gate: (name: string) => writeFile(path.join(root, `${token}-${name}`), 'go') };
}
async function state(request: APIRequestContext, sessionId: string) {
  return await (await request.get(`/api/agent/sessions/${sessionId}/state`)).json() as {
    run: AgentRunSnapshot; session: { messages: Message[]; messagePage?: { total: number } }; lastSequence: number;
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
async function positionCapture(card: Locator) {
  const page = card.page(), log = page.locator('.messages-container');
  // Retire saved-scroll settling with user intent, then use one complete origin.
  await log.hover({ position: { x: 5, y: 5 } });
  await page.mouse.wheel(0, 10_000);
  await log.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(() => log.evaluate(element => Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight))).toBeLessThan(1);
  await card.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(card).toBeInViewport({ ratio: 1 });
}
async function capture(card: Locator, name: string) {
  // Assert real host duration separately; its wall-clock value is inherently variable.
  await expect(card.locator('small')).toContainText(/Host duration: \d+\.\d{2}s/);
  await positionCapture(card);
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
    await positionCapture(card);
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

  // Reconnect from a hydrated sibling view, not a cold bootstrap whose initial
  // after=0 subscription can precede route metadata admission.
  const created = await page.request.post('/api/sessions', { data: { cwd: root, title: 'Watermark sibling' } });
  expect(created.status()).toBe(201); const sibling = await created.json() as { id: string };
  await page.goto(`/chat/${sibling.id}?cwd=${encodeURIComponent(root)}`);
  await openRowCopyNavigation(page);
  const sourceLink = page.locator(`.sidebar-nav a.session-main[href*="${probe.sessionId}"]`).first();
  await expect(sourceLink).toBeVisible();

  // Observe the actual response; do not construct or rewrite a transport record.
  const observeReady = (sessionId: string) => {
    const original = window.fetch.bind(window);
    (window as unknown as { __actualReadyFrames: string[] }).__actualReadyFrames = [];
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (response.url.includes(`/api/agent/sessions/${sessionId}/events?`) && response.body) {
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
  };
  await page.evaluate(observeReady, probe.sessionId);
  await page.addInitScript(observeReady, probe.sessionId);
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
    await sourceLink.click();
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
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const width of [1440, 390]) test(`real concurrent approvals at ${width}px: ordered replacement, individual close, sound and cold replay`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, sound: true,
      soundEvents: { completion: false, attention: true }, sidebarVisible: false, filesOpen: false }));
    let count = 0;
    Object.defineProperty(window, '__realAttentionCount', { get: () => count });
    const Original = window.AudioContext;
    window.AudioContext = class extends Original { constructor() { super(); count++; } };
  });
  const sounds = () => page.evaluate(() => (window as unknown as { __realAttentionCount: number }).__realAttentionCount);
  const probe = await begin(page, 'dialogs');
  const first = page.getByRole('dialog', { name: 'Live first approval', exact: true });
  await expect(first).toBeVisible();
  await expect(first.getByRole('status')).toContainText('2');
  await expect.poll(sounds).toBe(1);
  const before = (await state(page.request, probe.sessionId)).run.extensionRequests!;
  expect(before.map(request => request.kind)).toEqual(['input', 'custom', 'confirm']);
  await first.getByRole('textbox').fill('old schema draft');
  await probe.gate('replace');
  const updated = page.getByRole('dialog', { name: 'Updated live first approval', exact: true });
  await expect(updated).toBeVisible();
  await expect(updated.getByRole('status')).toContainText('1');
  const replacing = (await state(page.request, probe.sessionId)).run.extensionRequests!;
  expect(replacing.map(request => request.id)).toEqual(before.slice(0, 2).map(request => request.id));
  expect(replacing[0]!.kind).toBe('select');
  expect(await sounds()).toBe(1);
  const stale = await page.request.post(`/api/agent/sessions/${probe.sessionId}/interactions/${before[0]!.id}`, { data: { cancelled: false, value: 'old schema draft' } });
  expect(stale.status()).toBe(400);
  expect((await state(page.request, probe.sessionId)).run.extensionRequests).toHaveLength(2);
  await updated.getByRole('combobox').selectOption('yes');
  await updated.getByRole('button', { name: 'Submit', exact: true }).click();
  const custom = page.getByRole('dialog', { name: 'Live custom approval', exact: true });
  await expect(custom).toBeVisible();
  await expect.poll(sounds).toBe(2);
  await expect(custom.locator('img, script, iframe')).toHaveCount(0);
  await expect(custom).toContainText('<img src=x');
  const violations = await new AxeBuilder({ page }).include('.extension-interaction').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(violations.violations).toEqual([]);
  await page.reload();
  await expect(custom).toBeVisible(); expect(await sounds()).toBe(0);
  expect((await state(page.request, probe.sessionId)).run.extensionRequests!.map(request => request.id)).toEqual([before[1]!.id]);
  await custom.getByRole('textbox', { name: 'Approval note', exact: true }).fill('approved through real renderer');
  await custom.getByRole('checkbox', { name: 'Approved', exact: true }).check();
  await custom.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
  const final = await state(page.request, probe.sessionId);
  expect(final.run.extensionRequests).toEqual([]);
  const result = final.session.messages.find(message => message.role === 'tool')!;
  expect(JSON.parse(result.content)).toEqual([{ cancelled: false, value: 'yes' },
    { cancelled: false, value: { note: 'approved through real renderer', approved: true } }, { cancelled: true }]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __dialogExecuted?: number }).__dialogExecuted)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});

test('real Stop and executable rebuild revoke every pending approval and old handles cannot republish', async ({ page }) => {
  const stopped = await begin(page, 'dialogs-stop');
  await expect(page.getByRole('dialog', { name: 'Live first approval', exact: true })).toBeVisible();
  const ids = (await state(page.request, stopped.sessionId)).run.extensionRequests!.map(request => request.id);
  expect((await page.request.post(`/api/agent/runs/${stopped.runId}/stop`, { data: {} })).ok()).toBe(true);
  await expect.poll(async () => (await state(page.request, stopped.sessionId)).run.phase).toBe('stopped');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await page.request.post(`/api/agent/sessions/${stopped.sessionId}/interactions/${ids[0]}`, { data: { cancelled: true } })).status()).toBe(404);
  const rebuilt = await begin(page, 'dialogs-rebuild');
  await expect(page.getByRole('dialog', { name: 'Live first approval', exact: true })).toBeVisible();
  const before = (await state(page.request, rebuilt.sessionId)).run.extensionRequests!;
  const reload = await page.request.post('/api/agent/reload', { data: { cwd: root } });
  expect(reload.ok()).toBe(true); expect((await reload.json()).errors).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await state(page.request, rebuilt.sessionId)).run.extensionRequests).toEqual([]);
  await rebuilt.gate('replace');
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(path.join(root, `${rebuilt.token}-updated`), 'utf8')).changed; }
    catch { return 'not yet written'; }
  }).toBe(false);
  await expect.poll(async () => (await state(page.request, rebuilt.sessionId)).run.phase).toBe('completed');
  expect((await page.request.post(`/api/agent/sessions/${rebuilt.sessionId}/interactions/${before[0]!.id}`, { data: { cancelled: false, value: 'late' } })).status()).toBe(404);
  await page.reload(); await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const mode of ['length', 'emptylength']) test(`real ${mode}: durable follow-up notice and reachable explicit compaction action`, async ({ page }) => {
  const probe = await begin(page, mode);
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
  const actual = await state(page.request, probe.sessionId);
  const reply = actual.session.messages.at(-1)!;
  expect(reply.role).toBe('assistant'); expect(reply.metadata!.stopReason).toBe('length');
  expect(reply.content).toBe(mode === 'length' ? 'Partial length answer.' : '');
  await page.reload();
  const notice = page.locator('.message.assistant [role="note"]');
  await expect(notice).toContainText('Output limit reached');
  await expect(notice.getByRole('button', { name: 'Compact context', exact: true })).toBeEnabled();
  // The action invokes the existing real API; it may truthfully report that a
  // two-message conversation is too short. No synthetic success is substituted.
  const compact = page.waitForResponse(response => response.url().includes(`/api/agent/sessions/${probe.sessionId}/compact`) && response.request().method() === 'POST');
  await notice.getByRole('button', { name: 'Compact context', exact: true }).click();
  await compact;
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await expect(composer).toBeEnabled(); await composer.fill('Please continue the previous answer.');
  const sent = page.waitForResponse(response => response.url().endsWith('/api/agent/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const next = await (await sent).json() as { run: AgentRunSnapshot };
  await expect.poll(async () => { const snapshot = await state(page.request, probe.sessionId); return snapshot.run.id === next.run.id && snapshot.run.phase === 'completed'; }).toBe(true);
  await expect(notice).toContainText('Output limit reached');
  await expect(page.getByRole('button', { name: 'Compact context', exact: true })).toHaveCount(0);
  await page.reload(); await expect(notice).toContainText('Output limit reached');
});

test('real provider failure retains scrubbed partial output and its adjacent error through terminal resync/reload', async ({ page }) => {
  const probe = await begin(page, 'provider-error');
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('failed');
  const actual = await state(page.request, probe.sessionId);
  expect(actual.session.messages).toHaveLength(2);
  expect(actual.session.messages[1]!.metadata!.outputError).toBe('The provider streaming response was invalid.');
  expect(JSON.stringify(actual)).not.toContain('disposable-generic-progress-test-key');
  await page.reload();
  const reply = page.locator('.message.assistant');
  await expect(reply).toContainText('Partial visible output.');
  await expect(reply.getByRole('note')).toContainText('provider streaming response was invalid');
  await expect(reply).not.toContainText('disposable-generic-progress-test-key');
  await expect(reply.locator('img, script, iframe')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeEnabled();
});

test('real loaded turns share process ownership and one live/terminal tool presentation', async ({ page }) => {
  const probe = await begin(page, 'success');
  const card = page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true });
  await expect(card).toContainText('Preparing custom work');
  await expect(card).toHaveCount(1);
  await probe.gate('latest'); await probe.gate('finish');
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
  await page.reload();
  const actual = await state(page.request, probe.sessionId);
  const call = actual.session.messages.find(message => message.toolCalls?.length)!;
  const result = actual.session.messages.find(message => message.role === 'tool')!;
  await expect(page.locator(`[id="${call.id}"]`)).toHaveAttribute('data-process-turn', call.id);
  await expect(page.locator(`[id="${result.id}"]`)).toHaveAttribute('data-process-turn', call.id);
  await expect(page.locator('.agent-process > header:visible')).toHaveCount(1);
  await expect(page.locator('.agent-process > header:visible')).toContainText('2');
  await expect(card).toHaveCount(1); await expect(card).toHaveAttribute('data-status', 'completed');
});

const processScript = /\/assets\/ProcessBlock-[^/]+\.js(?:\?.*)?$/u;
test('optional process controls are unloaded for plain replies; delayed genuine controls retain native text and focus', async ({ page }) => {
  const assets: string[] = [];
  page.on('request', request => { if (processScript.test(request.url())) assets.push(request.url()); });
  const plain = await begin(page, 'length');
  await expect.poll(async () => (await state(page.request, plain.sessionId)).run.phase).toBe('completed');
  await expect(page.getByText('Partial length answer.', { exact: true })).toBeVisible();
  expect(assets).toEqual([]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(processScript, async route => { await gate; await route.continue(); });
  const probe = await begin(page, 'success');
  await expect(page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true })).toContainText('Preparing custom work');
  // Cold authoritative history includes the already persisted assistant call.
  await page.reload();
  const block = page.locator('.tool-block');
  await expect(block.locator('summary')).toContainText('arbitrary_custom');
  await block.locator('summary').click();
  await expect(block.locator('pre[aria-busy="true"]')).toContainText(probe.token);
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await composer.focus(); release();
  await expect(page.getByRole('toolbar', { name: 'Process block actions', exact: true })).toHaveCount(1);
  await expect(block).toHaveAttribute('open', '');
  await expect(block.locator('pre')).toContainText(probe.token);
  await expect(composer).toBeFocused();
  await probe.gate('latest'); await probe.gate('finish');
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
});

test('cached-failed genuine process controls retain native output and never disable product Stop', async ({ page }) => {
  await page.route(processScript, route => route.abort('failed'));
  const probe = await begin(page, 'stop');
  await expect(page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true })).toContainText('Preparing custom work');
  await page.reload();
  const block = page.locator('.tool-block');
  await expect(block.locator('[role="status"]')).toContainText('Progress display could not load');
  await block.locator('summary').click();
  await expect(block.locator('pre')).toContainText(probe.token);
  await page.getByRole('button', { name: 'Stop tool', exact: true }).click();
  await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('stopped');
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeEnabled();
});

test('real automatic compaction snapshot keeps policy/cancel reachable and blocks Send after reload', async ({ page }) => {
  const created = await page.request.post('/api/sessions', { data: { cwd: root, title: 'Actual pending automatic compaction' } });
  expect(created.status()).toBe(201); const session = await created.json() as { id: string }; probes.set(page, session.id);
  for (let index = 0; index < 4; index++) {
    const added = await page.request.post(`/api/sessions/${session.id}/messages`, { data: {
      role: index % 2 === 0 ? 'user' : 'assistant', content: `prior context ${index} ` + 'context detail '.repeat(6_000),
    } });
    expect(added.ok(), await added.text()).toBe(true);
  }
  // The default provider may already compact the seeded prefix. Capture the
  // real retained context; do not pretend its projection is the full JSONL tree.
  const seeded = await state(page.request, session.id);
  const seededTotal = seeded.session.messagePage!.total;
  expect(seededTotal).toBeGreaterThan(0);
  expect(seeded.session.messages.at(-1)?.content).toContain('prior context 3');
  await page.goto(`/chat/${session.id}?cwd=${encodeURIComponent(root)}`);
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await expect(composer).toBeVisible(); await composer.fill('Preserve this unsent draft');
  const started = await page.request.post('/api/agent/runs', { data: { sessionId: session.id, cwd: root,
    provider, model: 'progress-model', input: 'auto-phase:actual', autoCompaction: true, maxRetries: 0 } });
  expect(started.status(), await started.text()).toBe(202);
  const run = (await started.json() as { run: AgentRunSnapshot }).run;
  // The shared loop checks automatic compaction after a completed tool result.
  await expect.poll(async () => (await state(page.request, session.id)).run.phase).toBe('tool');
  await writeFile(path.join(root, 'actual-latest'), 'go');
  await writeFile(path.join(root, 'actual-finish'), 'go');
  await expect.poll(async () => (await state(page.request, session.id)).run.phase).toBe('compacting');
  const pending = await state(page.request, session.id);
  expect(pending.session.messagePage!.total).toBe(seededTotal + 3);
  expect(pending.session.messages.at(-1)).toMatchObject({ role: 'tool', content: 'Custom tool finished' });
  expect(pending.session.messages.at(-2)?.toolCalls?.[0]?.id).toBe('host-outer');
  await expect(composer).toHaveValue('Preserve this unsent draft');
  // Remote-session unsent drafts are view-local; cold reload qualifies the
  // authoritative pending phase/controls, not unsupported draft durability.
  await page.reload();
  await expect(composer).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel compaction', exact: true })).toBeEnabled();
  const policy = page.getByRole('combobox', { name: 'Auto-compaction', exact: true });
  await expect(policy).toBeEnabled(); await policy.selectOption('false');
  await page.getByRole('button', { name: 'Cancel compaction', exact: true }).click();
  await expect.poll(async () => (await state(page.request, session.id)).run.phase).toBe('stopped');
  const actual = await state(page.request, session.id);
  expect(actual.run.id).toBe(run.id);
  // Large content is byte-paged; prove the full total and exact loaded tail,
  // rather than treating the bounded state page as the complete transcript.
  expect(actual.session.messagePage!.total).toBe(seededTotal + 3);
  expect(actual.session.messages).toEqual(pending.session.messages);
  await expect(composer).toBeEnabled();
});

// Reuse this suite's already-declared encrypted real-upstream runtime; do not
// repair authentication/Origin or add a master key to the standard lifetime.
test('real active source continues independently after row copy, without a second provider request or interrupted output', async ({ page }) => {
  const f = await rowCopyFixture(page), provider = `row-copy-${crypto.randomUUID()}`;
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const upstream = createServer(async (request, response) => {
    if (request.url?.endsWith('/models')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'row-copy-model' }] })); return; }
    for await (const _chunk of request) { /* Consume actual provider input without response repair. */ }
    calls++; response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ACTIVE_SOURCE_PREFIX' }, finish_reason: null }] })}\n\n`);
    await gate;
    if (!response.destroyed) response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ACTIVE_SOURCE_FINISHED' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const sourceState = async () => await (await page.request.get(`/api/agent/sessions/${f.source.id}/state`)).json() as {
    run: { phase: string; partialMessage?: { content: string } }; session: { activeLeafId: string; messages: Array<{ content: string }> };
  };
  try {
    const registered = await page.request.post('/api/provider-registry/custom', { data: { id: provider, name: 'Row active source', dialect: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKey: 'disposable-row-copy-key' } });
    expect(registered.status(), (await registered.text()).slice(0, 2_048)).toBe(201);
    const started = await page.request.post('/api/agent/runs', { data: { sessionId: f.source.id, cwd: f.cwd, provider, model: 'row-copy-model', input: 'ACTIVE_SOURCE_INPUT' } }); expect(started.status()).toBe(202);
    await expect.poll(() => calls).toBe(1);
    await expect.poll(async () => (await sourceState()).run.partialMessage?.content, { timeout: 10_000 }).toBe('ACTIVE_SOURCE_PREFIX');
    await page.reload(); await expect(page.getByRole('log')).toContainText('ROW_VIEW_BODY'); await openRowCopyNavigation(page);
    const before = await sourceState(), entryId = before.session.activeLeafId, bytes = await readFile(f.file);
    expect(before.run.phase).toBe('streaming'); expect(before.session.messages.at(-1)?.content).toBe('ACTIVE_SOURCE_INPUT');
    expect(before.session.messages.some(message => message.content.includes('ACTIVE_SOURCE_PREFIX'))).toBe(false);
    const { item } = await openRowCopyMenu(f, page), response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/sessions/${f.source.id}/clone`);
    await item.click(); const actual = await response; expect(actual.status()).toBe(201); const copy = await actual.json() as { id: string };
    await expect(page).toHaveURL(new RegExp(`/chat/${copy.id}\\?cwd=`)); await expect(page.getByRole('log')).toContainText('ACTIVE_SOURCE_INPUT');
    await expect(page.getByRole('log')).not.toContainText('ACTIVE_SOURCE_PREFIX');
    const saved = await f.store.getSessionSnapshot(copy.id); expect(saved!.session.metadata).toMatchObject({ clonedFromSessionId: f.source.id, clonedFromEntryId: entryId });
    expect(saved!.session.messages.at(-1)?.content).toBe('ACTIVE_SOURCE_INPUT'); expect(JSON.stringify(saved)).not.toContain('ACTIVE_SOURCE_PREFIX');
    const stillRunning = await sourceState(); expect(stillRunning.run.phase).toBe('streaming'); expect(stillRunning.run.partialMessage?.content).toBe('ACTIVE_SOURCE_PREFIX');
    expect(calls).toBe(1); expect(await readFile(f.file)).toEqual(bytes);
    release(); await expect.poll(async () => (await sourceState()).run.phase, { timeout: 10_000 }).toBe('completed');
    expect((await sourceState()).session.messages.at(-1)?.content).toBe('ACTIVE_SOURCE_PREFIXACTIVE_SOURCE_FINISHED');
    await expect(page.getByRole('log')).not.toContainText('ACTIVE_SOURCE_FINISHED'); expect(JSON.stringify(await f.store.getSessionSnapshot(copy.id))).not.toContain('ACTIVE_SOURCE_FINISHED');
    expect(calls).toBe(1); expect(f.quota).toEqual([]);
  } finally {
    release(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    await f.cleanup(); await page.request.delete(`/api/provider-registry/custom/${provider}`);
  }
});

test.describe('native RUN behavior', () => {
  test.beforeEach(async ({ request }) => {
    // Earlier row-copy coverage intentionally changes the server's executable
    // generation. Admit this fixture again, through the real reload endpoint.
    const response = await request.post('/api/agent/reload', { data: { cwd: root } }); expect(response.ok()).toBe(true);
    expect((await response.json()).errors).toEqual([]);
    // The code-mode control also persists a narrow global tool selection.
    // Select this fixture's native tools through the actual configuration API.
    const selection = await request.patch('/api/tools', { data: { cwd: root,
      enabledTools: ['arbitrary_custom', 'parallel_read', 'nested_child', 'nested_parent'], toolPreset: 'full', powershellEnabled: false, codemodeEnabled: false,
    } });
    expect(selection.ok(), await selection.text()).toBe(true);
  });

test('native parallel batch reconnects both tools, joins before the nested parent and renders its real image', async ({ page }) => {
  const probe = await begin(page, 'parallel');
  try {
    const cards = page.getByRole('region', { name: 'Tool progress: parallel_read', exact: true });
    await expect(cards).toHaveCount(2); await expect(cards.nth(0)).toContainText('Parallel one'); await expect(cards.nth(1)).toContainText('Parallel two');
    expect((await state(page.request, probe.sessionId)).run.activeTools!.map(tool => tool.id)).toEqual(['parallel-one', 'parallel-two']);
    await page.reload(); await expect(cards).toHaveCount(2); await expect(cards.nth(1)).toContainText('Parallel two');
    await probe.gate('finish'); await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
    const result = await state(page.request, probe.sessionId); expect(result.run.activeTools).toBeUndefined();
    const tools = result.session.messages.filter(message => message.role === 'tool');
    expect(tools.map(message => message.toolCallId)).toEqual(['parallel-one', 'parallel-two', 'parallel-parent']);
    expect(tools[2].metadata!.nestedTools).toEqual([expect.objectContaining({ name: 'nested_child', parentId: 'parallel-parent', isError: false })]);
    const image = page.getByAltText('native-tool.png'); await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
    const request = modelRequests.find(body => body.messages.some(message => message.content === `parallel:${probe.token}`) && body.messages.some(message => message.role === 'tool'))!;
    expect(JSON.stringify(request)).toContain('image_url'); expect(JSON.stringify(request)).not.toContain('disposable-generic-progress-test-key');
    await page.reload(); await expect(page.getByAltText('native-tool.png')).toBeVisible();
  } finally { await page.request.post(`/api/agent/runs/${probe.runId}/stop`); }
});

for (const steeringMode of ['all', 'one-at-a-time']) for (const followUpMode of ['all', 'one-at-a-time']) {
  test(`live queue ${steeringMode}/${followUpMode}: recall, clear, draft/reconnect and exactly-once provider delivery`, async ({ page }) => {
    const settings = path.join(root, '.ai-harness', 'settings.json');
    await writeFile(settings, JSON.stringify({ steeringMode, followUpMode }));
    const created = await page.request.post('/api/sessions', { data: { cwd: root, title: 'Queue draft control' } });
    expect(created.status()).toBe(201); const other = await created.json() as { id: string };
    const probe = await begin(page, 'success');
    try {
      await expect(page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true })).toContainText('Preparing custom work');
      const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
      const enqueue = async () => {
        for (const kind of ['steer', 'follow-up']) {
          await page.getByRole('combobox', { name: 'Queue mode', exact: true }).selectOption(kind);
          for (let i = 1; i <= 3; i++) {
            const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/agent/runs/${probe.runId}/queue`);
            await composer.fill(`${kind}-${i}`); await composer.press('Enter'); expect((await response).status()).toBe(202);
            await expect(composer).toHaveValue('');
          }
        }
      };
      await enqueue(); const queue = page.getByRole('region', { name: 'Pending agent messages', exact: true });
      await queue.getByRole('button', { name: 'steer-1', exact: true }).click(); await expect(composer).toHaveValue('steer-1');
      await queue.locator('.clear-queues').click(); await expect(queue).toHaveCount(0); await expect(composer).toHaveValue('steer-1');
      await enqueue(); await composer.fill('unsent draft survives reconnect'); await openRowCopyNavigation(page);
      await page.locator(`.sidebar-nav a.session-main[href*="${other.id}"]`).first().click();
      await expect(composer).toHaveValue('');
      const connected = page.waitForRequest(request => new URL(request.url()).pathname === `/api/agent/sessions/${probe.sessionId}/events`);
      await page.locator(`.sidebar-nav a.session-main[href*="${probe.sessionId}"]`).first().click(); await connected;
      await expect(composer).toHaveValue('unsent draft survives reconnect'); await expect(queue.getByRole('button', { name: 'follow-up-3', exact: true })).toBeVisible();
      await probe.gate('latest'); await probe.gate('finish');
      await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
      const expected = [[`success:${probe.token}`]];
      for (const [kind, mode] of [['steer', steeringMode], ['follow-up', followUpMode]]) for (const batch of mode === 'all' ? [[1, 2, 3]] : [[1], [2], [3]]) {
        expected.push([...expected.at(-1)!, ...batch.map(i => `${kind}-${i}`)]);
      }
      const calls = modelRequests.filter(body => body.messages.some(message => message.content === `success:${probe.token}`));
      expect(calls.map(body => body.messages.filter(message => message.role === 'user').map(message => message.content))).toEqual(expected);
      expect((await state(page.request, probe.sessionId)).session.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(expected.at(-1));
      await expect(queue).toHaveCount(0); await expect(composer).toHaveValue('unsent draft survives reconnect');
    } finally { await page.request.post(`/api/agent/runs/${probe.runId}/stop`); await rm(settings, { force: true }); }
  });
}

test('real background failure marks attention without stealing another session draft', async ({ page }) => {
  const probe = await begin(page, 'background-error');
  try {
    await expect(page.getByRole('region', { name: 'Tool progress: arbitrary_custom', exact: true })).toContainText('Preparing custom work');
    const created = await page.request.post('/api/sessions', { data: { cwd: root, title: 'BACKGROUND_DRAFT_CONTROL' } });
    expect(created.status()).toBe(201); const other = await created.json() as { id: string };
    await page.goto(`/chat/${other.id}?cwd=${encodeURIComponent(root)}`); await openRowCopyNavigation(page);
    const source = page.locator('.sidebar-nav .session-row').filter({ has: page.locator(`a.session-main[href*="${probe.sessionId}"]`) });
    await expect(source.getByLabel('Agent running')).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true }); await composer.fill('background draft must survive');
    await probe.gate('latest'); await probe.gate('finish');
    await expect(source.getByLabel('Needs attention')).toBeVisible({ timeout: 10_000 }); await expect(composer).toHaveValue('background draft must survive');
    await source.locator('a.session-main').first().click(); await expect(page.getByRole('log')).toContainText('Partial visible output.');
    await expect(source.getByLabel('Needs attention')).toHaveCount(0);
    await page.locator('.sidebar-nav a.session-main').filter({ hasText: 'BACKGROUND_DRAFT_CONTROL' }).click();
    await expect(composer).toHaveValue('background draft must survive');
  } finally { await page.request.post(`/api/agent/runs/${probe.runId}/stop`); }
});

test('actual HTTP length-truncated tool calls have no effects and recover through durable browser reload', async ({ page }) => {
  const probe = await begin(page, 'truncated-tools');
  try {
    await expect.poll(async () => (await state(page.request, probe.sessionId)).session.messages.filter(message => message.role === 'tool').length).toBe(2);
    await expect(page.getByRole('log')).toContainText('Partial truncated tool answer.');
    expect(await readFile(path.join(root, `${probe.token}-executed`), 'utf8').catch(error => error.code)).toBe('ENOENT');
    const partial = (await state(page.request, probe.sessionId)).session.messages;
    expect(partial[1]).toMatchObject({ content: 'Partial truncated tool answer.', metadata: { stopReason: 'length' },
      blocks: expect.arrayContaining([{ type: 'reasoning', text: 'Partial truncated thought.' }]), usage: { totalTokens: 5 } });
    expect(partial.filter(message => message.role === 'tool')).toEqual(['cut-complete', 'cut-partial'].map(toolCallId =>
      expect.objectContaining({ toolCallId, isError: true, content: expect.stringContaining('output token limit') })));
    await probe.gate('reissue');
    await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
    await expect(page.getByRole('log')).toContainText('HTTP_TRUNCATED_TOOLS_OK');
    expect(await readFile(path.join(root, `${probe.token}-executed`), 'utf8')).toBe('safe');
    const calls = modelRequests.filter(request => request.messages.some(message => message.content === `truncated-tools:${probe.token}`));
    expect(calls).toHaveLength(3);
    expect(calls[1].messages.filter(message => message.role === 'tool')).toEqual(['cut-complete', 'cut-partial'].map(tool_call_id =>
      expect.objectContaining({ tool_call_id, content: expect.stringContaining('Re-issue the tool call with complete arguments') })));
    await page.reload(); await expect(page.getByRole('log')).toContainText('HTTP_TRUNCATED_TOOLS_OK');
    const snapshot = await new JsonlSessionStore(path.join(process.env.AI_HARNESS_E2E_PROGRESS_DATA_DIR!, 'sessions')).getSessionSnapshot(probe.sessionId);
    const raw = snapshot!.entries!;
    expect(raw.filter(entry => entry.type === 'message' && entry.role === 'tool').map(entry => [entry.toolCallId, entry.isError]))
      .toEqual([['cut-complete', true], ['cut-partial', true], ['safe-retry', false]]);
    expect(raw.some(entry => entry.type === 'compaction' || entry.type === 'context_edit')).toBe(false);
    expect(getSessionAccounting(raw, raw.at(-1)!.id).active.usage.totalTokens).toBe(15);
  } finally { await probe.gate('reissue'); await page.request.post(`/api/agent/runs/${probe.runId}/stop`); }
});

for (const reason of ['overflow', 'length']) test(`actual HTTP ${reason} recovers once with smaller input, immutable raw history and authentic usage`, async ({ page }) => {
  const seed = 'HTTP_RECOVERY_HISTORY ' + 'prior decision '.repeat(500);
  const probe = await begin(page, `recover-${reason}`, seed);
  try {
    await expect.poll(async () => (await state(page.request, probe.sessionId)).run.phase).toBe('completed');
    await expect(page.getByText('HTTP_RECOVERY_OK', { exact: true })).toBeVisible();
    const calls = modelRequests.filter(request => request.messages.some(message => message.content === `recover-${reason}:${probe.token}`));
    expect(calls).toHaveLength(2); expect(JSON.stringify(calls[1]).length).toBeLessThan(JSON.stringify(calls[0]).length);
    expect(JSON.stringify(calls[1])).not.toContain(seed); expect(JSON.stringify(calls[1])).not.toContain('Partial recovery answer.');
    const snapshot = await new JsonlSessionStore(path.join(process.env.AI_HARNESS_E2E_PROGRESS_DATA_DIR!, 'sessions')).getSessionSnapshot(probe.sessionId);
    expect(snapshot).toBeDefined(); const raw = snapshot!.entries!;
    expect(raw.some(entry => entry.type === 'message' && entry.content === seed)).toBe(true);
    expect(raw.filter(entry => entry.type === 'compaction')).toHaveLength(1);
    if (reason === 'length') {
      expect(raw.some(entry => entry.type === 'message' && entry.content === 'Partial recovery answer.')).toBe(true);
      expect(raw.some(entry => entry.type === 'context_edit')).toBe(true);
    }
    expect(getSessionAccounting(raw, raw.at(-1)!.id).active.usage.totalTokens).toBe(reason === 'length' ? 13 : 8);
    expect(JSON.stringify(raw)).not.toContain('disposable-generic-progress-test-key');
  } finally { await page.request.post(`/api/agent/runs/${probe.runId}/stop`); }
});
});
