import { expect, test, type Page, type Route } from '@playwright/test';
import type { AgentRunSnapshot, ExtensionInteractionSnapshot } from '@ai-harness/core';
import { installMockApi, mockSession } from './fixtures/mock-api';

const sessionId = 'interaction-assets';
const request = (id: string): ExtensionInteractionSnapshot => ({ id, kind: 'input', title: `Request ${id}`,
  message: 'Plain-text approval', createdAt: '2026-01-01T00:00:00Z' });
async function product(page: Page, heads: string[] = []) {
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
    version: 4, theme: 'light', sidebarVisible: false, filesOpen: false, sound: false,
  })));
  const session = mockSession(sessionId, 'Lazy interaction assets');
  await installMockApi(page, { sessions: [session, mockSession('other', 'Other session')], holdAgentRun: true });
  let run: AgentRunSnapshot = { id: 'asset-run', sessionId, cwd: '/workspace', phase: 'tool', provider: 'mock',
    lastSequence: 1, steerQueue: [], followUpQueue: [], extensionRequest: heads[0] ? request(heads[0]) : undefined };
  let pendingHeads = [...heads];
  let stream: Route | undefined;
  const replies: unknown[] = [];
  const json = (route: Route, data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/api/agent/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/agent/sessions/${sessionId}/state`) await json(route, { sessionId, session, lastSequence: run.lastSequence, run });
    else if (path === `/api/agent/sessions/${sessionId}/events`) stream = route;
    else if (path.includes(`/sessions/${sessionId}/interactions/`)) {
      replies.push(route.request().postDataJSON());
      run = { ...run, lastSequence: run.lastSequence + 1, extensionRequest: pendingHeads.shift() ? (pendingHeads[0] ? request(pendingHeads[0]) : undefined) : undefined };
      await json(route, run);
    } else if (path === '/api/agent/runs/asset-run/stop') {
      run = { ...run, lastSequence: run.lastSequence + 1, phase: 'stopped', extensionRequest: undefined };
      await json(route, run);
    } else if (path === '/api/agent/runs') await json(route, [run]);
    else if (path === '/api/agent/runs/asset-run') await json(route, run);
    else await route.fallback();
  });
  return { replies, async update(heads: string[], phase: AgentRunSnapshot['phase'] = 'tool') {
    await expect.poll(() => Boolean(stream)).toBe(true);
    pendingHeads = [...heads];
    run = { ...run, phase, lastSequence: run.lastSequence + 1, extensionRequest: heads[0] ? request(heads[0]) : undefined };
    const route = stream!; stream = undefined;
    await route.fulfill({ contentType: 'text/event-stream', body: `event: connection.ready\ndata: ${JSON.stringify({
      snapshot: { sessionId, lastSequence: run.lastSequence, run }, reset: true,
    })}\n\n` });
  } };
}
const url = `/chat/${sessionId}?cwd=%2Fworkspace`;
const js = /\/assets\/ExtensionInteractionDialog-[^/]+\.js$/;
const css = /\/assets\/ExtensionInteractionDialog-[^/]+\.css$/;

test('production JS/CSS stay absent without a head, load once on demand and keep the form across heads', async ({ page }) => {
  const api = await product(page);
  const assets: string[] = [];
  page.on('request', req => { if (js.test(req.url()) || css.test(req.url())) assets.push(req.url()); });
  await page.goto(url);
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  expect(assets).toEqual([]);
  await api.update(['a', 'b']);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Request a');
  await expect(dialog).toHaveCSS('display', 'grid');
  expect(assets.filter(asset => js.test(asset))).toHaveLength(1);
  expect(assets.filter(asset => css.test(asset))).toHaveLength(1);
  await dialog.evaluate(el => el.setAttribute('data-identity', 'stable'));
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveAccessibleName('Request b');
  await expect(dialog).toHaveAttribute('data-identity', 'stable');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await api.update(['c']);
  await expect(dialog).toHaveAccessibleName('Request c');
  expect(assets.filter(asset => js.test(asset))).toHaveLength(1);
});

test('delayed production chunk keeps waiting/cancel/Stop usable and mounts the latest head only', async ({ page }) => {
  let held: Route | undefined;
  await page.route(js, route => { held = route; });
  const api = await product(page, ['a', 'b']);
  await page.goto(url);
  const waiting = page.getByRole('region', { name: 'Request a', exact: true });
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText('Plain-text approval');
  await expect(waiting.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await expect(page.locator('.stop-button')).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await waiting.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Request b', exact: true })).toBeVisible();
  await expect.poll(() => Boolean(held)).toBe(true);
  await held!.continue();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Request b');
  await expect(page.getByRole('dialog').getByRole('textbox')).toBeFocused();
  expect(api.replies).toEqual([{ cancelled: true }]);
});

for (const [kind, asset] of [['JS', js], ['CSS', css]] as const) {
 test(`failed production ${kind} presents bounded error with working cancellation`, async ({ page }) => {
  await page.route(asset, route => route.abort('failed'));
  const api = await product(page, ['a']);
  await page.goto(url);
  const waiting = page.getByRole('region', { name: 'Request a', exact: true });
  await expect(waiting.getByRole('status')).toHaveText('The extension interaction could not be completed.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await waiting.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(waiting).toHaveCount(0);
  expect(api.replies).toEqual([{ cancelled: true }]);
 });
}

for (const end of ['stop', 'terminal', 'navigation'] as const) {
  test(`late production chunk after ${end} cannot reopen or steal focus`, async ({ page }) => {
    let held: Route | undefined;
    await page.route(js, route => { held = route; });
    const api = await product(page, ['a']);
    await page.goto(url);
    await expect(page.getByRole('region', { name: 'Request a', exact: true })).toBeVisible();
    await expect.poll(() => Boolean(held)).toBe(true);
    if (end === 'stop') await page.locator('.stop-button').click();
    else if (end === 'terminal') await api.update([], 'completed');
    else await page.evaluate(() => { history.pushState(null, '', '/chat/other?cwd=%2Fworkspace'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await expect(page.getByRole('region', { name: 'Request a', exact: true })).toHaveCount(0);
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    await composer.focus();
    const loaded = page.waitForResponse(response => js.test(response.url()));
    await held!.continue();
    await loaded;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(composer).toBeFocused();
  });
}

test('delayed CSS is real and Close cancels without mounting or moving composer focus', async ({ page }) => {
  let held: Route | undefined;
  await page.route(css, route => { held = route; });
  const api = await product(page, ['a']);
  await page.goto(url);
  const region = page.getByRole('region', { name: 'Request a' });
  await expect(region).toBeVisible();
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await region.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(region).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await composer.focus();
  const loaded = page.waitForResponse(response => css.test(response.url()));
  await held!.continue(); await loaded;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(composer).toBeFocused();
  expect(api.replies).toEqual([{ cancelled: true }]);
});

test('failed imports stay cached on reopen and French loading/error/reload is never transient English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'fr'));
  let attempted = 0;
  await page.route(js, route => { attempted++; return route.abort('failed'); });
  const api = await product(page, ['a']);
  await page.goto(url);
  const region = page.getByRole('region', { name: 'Request a' });
  await expect(region.getByRole('status')).toHaveText('L’interaction de l’extension n’a pas pu aboutir.');
  await expect(region).toContainText('Copiez votre texte non envoyé');
  await expect(region.getByRole('button', { name: 'Recharger et réessayer' })).toBeVisible();
  await region.getByRole('button', { name: 'Annuler', exact: true }).click();
  await api.update(['b']);
  const reopened = page.getByRole('region', { name: 'Request b' });
  await expect(reopened.getByRole('status')).toHaveText('L’interaction de l’extension n’a pas pu aboutir.');
  expect(attempted).toBe(1);
  await expect(reopened).not.toContainText('Reload and retry');
});

test('same-ID updates retain form identity and draft; no composer bounce before final invoker restoration', async ({ page }) => {
  const api = await product(page, ['a']);
  await page.goto(url);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Request a');
  await dialog.evaluate(el => el.setAttribute('data-identity', 'same-id'));
  await dialog.getByRole('textbox').fill('Keep this exact draft');
  await page.evaluate(() => {
    (window as unknown as { composerFocuses: number }).composerFocuses = 0;
    document.querySelector('.input-container textarea')?.addEventListener('focus', () => {
      (window as unknown as { composerFocuses: number }).composerFocuses++;
    });
  });
  await api.update(['a']);
  await expect(dialog).toHaveAttribute('data-identity', 'same-id');
  await expect(dialog.getByRole('textbox')).toHaveValue('Keep this exact draft');
  await api.update(['b']);
  await expect(dialog).toHaveAccessibleName('Request b');
  await expect(dialog).toHaveAttribute('data-identity', 'same-id');
  expect(await page.evaluate(() => (window as unknown as { composerFocuses: number }).composerFocuses)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeFocused();
});

for (const end of ['head', 'stop', 'navigation'] as const) {
  test(`held submit after ${end} is aborted and cannot publish stale state`, async ({ page }) => {
    const api = await product(page, ['a']);
    let held: Route | undefined;
    let failed = false;
    page.on('requestfailed', request => { if (request.url().includes('/interactions/a')) failed = true; });
    await page.route('**/api/agent/sessions/interaction-assets/interactions/a', route => { held = route; });
    await page.goto(url);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAccessibleName('Request a');
    await dialog.getByRole('textbox').fill('Do not replay');
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect.poll(() => Boolean(held)).toBe(true);
    if (end === 'head') { await api.update(['b']); await expect(dialog).toHaveAccessibleName('Request b'); }
    else if (end === 'stop') { await page.locator('.stop-button').dispatchEvent('click'); await expect(dialog).toHaveCount(0); }
    else { await page.evaluate(() => { history.pushState(null, '', '/chat/other?cwd=%2Fworkspace'); window.dispatchEvent(new PopStateEvent('popstate')); }); await expect(dialog).toHaveCount(0); }
    await expect.poll(() => failed).toBe(true);
    await held!.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'asset-run', sessionId,
      phase: 'tool', lastSequence: 1, steerQueue: [], followUpQueue: [], extensionRequest: request('a') }) }).catch(() => {});
    if (end === 'head') await expect(dialog).toHaveAccessibleName('Request b');
    else await expect(dialog).toHaveCount(0);
  });
}

test('explicit reload after cached asset refusal loads the genuine styled form again', async ({ page }) => {
  await page.route(js, route => route.abort('failed'));
  await product(page, ['a']);
  await page.goto(url);
  const region = page.getByRole('region', { name: 'Request a' });
  await expect(region).toContainText('Copy unsent text before reloading');
  await expect(region.getByRole('button', { name: 'Reload and retry' })).toBeVisible();
  await page.unroute(js);
  await region.getByRole('button', { name: 'Reload and retry' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request a' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('display', 'grid');
});

test('coarse form mounts without editable autofocus and keeps a non-editable invoker across heads', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    const api = await product(page);
    await page.goto(url);
    const invoker = page.locator('.stop-button');
    await expect(invoker).toBeVisible();
    await invoker.focus();
    await api.update(['a']);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAccessibleName('Request a');
    await expect(dialog).toBeFocused();
    await expect(dialog.getByRole('textbox')).not.toBeFocused();
    await dialog.evaluate(el => el.setAttribute('data-identity', 'coarse'));
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Submit' })).toBeFocused();
    await api.update(['b']);
    await expect(dialog).toHaveAccessibleName('Request b');
    await expect(dialog).toHaveAttribute('data-identity', 'coarse');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(invoker).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).not.toBeFocused();
  } finally { await context.close(); }
});


test('mounted dialog retirement respects explicit navigation focus and cannot return to an old invoker', async ({ page }) => {
  await product(page, ['a']);
  await page.goto(url);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Request a');
  await page.evaluate(() => { history.pushState(null, '', '/chat/other?cwd=%2Fworkspace'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(dialog).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await composer.focus();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(composer).toBeFocused();
});


test('dialog return is retired by newer close-commit focus even if it blurs before the return frame', async ({ page }) => {
  const api = await product(page, ['a']);
  await page.goto(url);
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Request a');
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (document.querySelector('.extension-interaction')) return;
      observer.disconnect();
      const newer = document.querySelector<HTMLTextAreaElement>('.input-container textarea')!;
      newer.focus(); newer.blur();
      document.documentElement.dataset.dialogNewerFocus = 'retired';
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await api.update([], 'completed');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-dialog-newer-focus', 'retired');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).not.toBeFocused();
});

test('dialog does not intercept Escape owned by a newer active modal', async ({ page }) => {
  const api = await product(page, ['a']);
  await page.goto(url);
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Request a');
  await page.evaluate(() => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Newer modal'); modal.tabIndex = -1;
    const button = document.createElement('button'); button.textContent = 'Newer destination';
    modal.append(button); document.body.append(modal); button.focus();
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') modal.remove(); });
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Newer modal' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Request a' })).toBeVisible();
  expect(api.replies).toEqual([]);
});

for (const state of ['loading', 'mounted'] as const) {
  test(`same-session fallback-key address change retires ${state} interaction lifetime`, async ({ page }) => {
    let held: Route | undefined;
    if (state === 'loading') await page.route(js, route => { held = route; });
    await product(page, ['a']);
    await page.goto(url);
    if (state === 'loading') {
      await expect(page.getByRole('region', { name: 'Request a' })).toBeVisible();
      await page.getByRole('region', { name: 'Request a' }).evaluate(el => el.setAttribute('data-retired-identity', 'old-route'));
      await expect.poll(() => Boolean(held)).toBe(true);
    } else {
      await expect(page.getByRole('dialog')).toHaveAccessibleName('Request a');
      await page.getByRole('dialog').evaluate(el => el.setAttribute('data-retired-identity', 'old-route'));
    }
    await page.evaluate(() => { history.pushState(null, '', location.pathname + location.search + '#replacement'); window.dispatchEvent(new PopStateEvent('popstate')); });
    if (state === 'loading') {
      const loaded = page.waitForResponse(response => js.test(response.url()));
      await held!.continue(); await loaded;
    }
    await expect(page.locator('[data-retired-identity="old-route"]')).toHaveCount(0);
    // The new route may independently present the still-pending server request.
    // It must never restore focus to the retired route's invoker.
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    await composer.focus();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(composer).toBeFocused();
  });
}

test('pending optional form leaves IME composer and genuine Stop usable without global suspension', async ({ page }) => {
  let held: Route | undefined;
  await page.route(js, route => { held = route; });
  await product(page, ['a']);
  const writes: string[] = [];
  page.on('request', req => { if (req.method() === 'POST' && /\/api\/agent\/(runs$|runs\/asset-run\/queue$)/.test(new URL(req.url()).pathname)) writes.push(req.url()); });
  await page.goto(url);
  await expect(page.getByRole('region', { name: 'Request a' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await composer.fill('未送信の入力');
  await composer.focus();
  await composer.evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await expect(composer).toHaveValue('未送信の入力');
  expect(writes).toEqual([]);
  await page.locator('.stop-button').click();
  await expect(page.getByRole('region', { name: 'Request a' })).toHaveCount(0);
  await expect.poll(() => Boolean(held)).toBe(true);
  const loaded = page.waitForResponse(response => js.test(response.url()));
  await held!.continue(); await loaded;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(composer).toHaveValue('未送信の入力');
});


for (const legacy229 of [false, true]) {
  test(`owning IME Escape ${legacy229 ? 'legacy 229' : 'native composition'} is inert in the ready optional form`, async ({ page }) => {
    const api = await product(page, ['a']);
    await page.goto(url);
    const dialog = page.getByRole('dialog', { name: 'Request a' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('textbox');
    await input.fill('未確定の承認');
    await input.focus();
    const prevented = await input.evaluate((element, legacy) => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true,
        cancelable: true, isComposing: !legacy, keyCode: legacy ? 229 : 27 });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, legacy229);
    expect(prevented).toBe(false);
    await expect(dialog).toBeVisible();
    await expect(input).toHaveValue('未確定の承認');
    await expect(input).toBeFocused();
    expect(api.replies).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(api.replies).toEqual([{ cancelled: true }]);
  });
}

test('owning newer modal successor keeps focus when the ready request head changes', async ({ page }) => {
  const api = await product(page, ['a']);
  await page.goto(url);
  await expect(page.getByRole('dialog', { name: 'Request a' })).toBeVisible();
  await page.evaluate(() => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Newer successor');
    const button = document.createElement('button'); button.textContent = 'Newer destination';
    modal.append(button); document.body.append(modal); button.focus();
  });
  const newer = page.getByRole('dialog', { name: 'Newer successor' }).getByRole('button', { name: 'Newer destination' });
  await expect(newer).toBeFocused();
  await api.update(['b']);
  await expect(page.getByRole('dialog', { name: 'Request b' })).toBeVisible();
  await expect(newer).toBeFocused();
  expect(api.replies).toEqual([]);
});


test('owning composition lifetime keeps Enter from acknowledging the ready form until compositionend', async ({ page }) => {
  const api = await product(page, ['a']);
  await page.goto(url);
  const dialog = page.getByRole('dialog', { name: 'Request a' });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('textbox');
  await input.fill('未確定の承認');
  await input.focus();
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue('未確定の承認');
  await expect(input).toBeFocused();
  expect(api.replies).toEqual([]);
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(api.replies).toEqual([{ cancelled: false, value: '未確定の承認' }]);
});


test('owning same-ID schema refresh preserves the composing draft until its real compositionend', async ({ page }) => {
  const api = await product(page, ['a']);
  let stream: Route | undefined;
  await page.route('**/api/agent/sessions/interaction-assets/events*', route => { stream = route; });
  await page.goto(url);
  const dialog = page.getByRole('dialog', { name: 'Request a' });
  await expect(dialog).toBeVisible();
  const input = page.locator('.extension-interaction').getByRole('textbox');
  await input.fill('編集途中の承認');
  await input.focus();
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await expect.poll(() => Boolean(stream)).toBe(true);
  const run: AgentRunSnapshot = { id: 'asset-run', sessionId, cwd: '/workspace', phase: 'tool', provider: 'mock',
    lastSequence: 2, steerQueue: [], followUpQueue: [], extensionRequest: { ...request('a'), title: 'Renamed same-ID approval' } };
  await stream!.fulfill({ contentType: 'text/event-stream', body: `event: connection.ready\ndata: ${JSON.stringify({
    snapshot: { sessionId, lastSequence: run.lastSequence, run }, reset: true,
  })}\n\n` });
  await expect(page.getByRole('dialog', { name: 'Renamed same-ID approval' })).toBeVisible();
  await expect(input).toHaveValue('編集途中の承認');
  await expect(input).toBeFocused();
  await page.keyboard.press('Enter');
  expect(api.replies).toEqual([]);
  await expect(input).toHaveValue('編集途中の承認');
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(api.replies).toEqual([{ cancelled: false, value: '編集途中の承認' }]);
});


for (const destination of ['composer', 'newer-modal', 'blurred'] as const) {
  test(`focus admission keeps ${destination} intent through the delayed renderer mount`, async ({ page }) => {
    let held: Route | undefined;
    await page.route(js, route => { held = route; });
    const api = await product(page, ['a']);
    await page.goto(url);
    await expect(page.getByRole('region', { name: 'Request a' })).toBeVisible();
    await expect.poll(() => Boolean(held)).toBe(true);
    await page.evaluate(mode => {
      const newer = document.createElement('div');
      newer.id = 'newer-admission-focus';
      if (mode === 'newer-modal') {
        newer.setAttribute('role', 'dialog'); newer.setAttribute('aria-modal', 'true');
        newer.setAttribute('aria-label', 'Newer admission dialog');
      }
      const button = document.createElement('button'); button.textContent = 'Newer admission destination';
      newer.append(button); document.body.append(newer); button.focus();
      if (mode === 'composer') document.querySelector<HTMLTextAreaElement>('.input-container textarea')!.focus();
      if (mode === 'blurred') button.blur();
    }, destination);
    const target = destination === 'composer' ? page.getByRole('textbox', { name: 'Message composer', exact: true })
      : destination === 'newer-modal' ? page.getByRole('button', { name: 'Newer admission destination' }) : page.locator('body');
    await expect(target).toBeFocused();
    const loaded = page.waitForResponse(response => js.test(response.url()));
    await held!.continue(); await loaded;
    await expect(page.getByRole('dialog', { name: 'Request a' })).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(target).toBeFocused();
    expect(api.replies).toEqual([]);
  });
}


test('fresh interaction keeps ordinary autofocus after the genuine renderer delay', async ({ page }) => {
  let held: Route | undefined;
  await page.route(js, route => { held = route; });
  const api = await product(page, ['a']);
  await page.goto(url);
  await expect(page.getByRole('region', { name: 'Request a' })).toBeVisible();
  await expect.poll(() => Boolean(held)).toBe(true);
  const loaded = page.waitForResponse(response => js.test(response.url()));
  await held!.continue(); await loaded;
  const dialog = page.getByRole('dialog', { name: 'Request a' });
  await expect(dialog.getByRole('textbox')).toBeFocused();
  expect(api.replies).toEqual([]);
});


for (const edited of [false, true]) {
  test(`coarse return ${edited ? 'preserves manual editor intent' : 'does not invent editable focus'}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      const api = await product(page, ['a']);
      await page.goto(url);
      const dialog = page.getByRole('dialog', { name: 'Request a' });
      await expect(dialog).toBeVisible();
      await dialog.focus();
      await expect(dialog).toBeFocused();
      const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
      if (edited) {
        await dialog.getByRole('textbox').fill('Manually edited native control');
        await expect(dialog.getByRole('textbox')).toBeFocused();
      }
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (edited) await expect(composer).toBeFocused();
      else await expect(composer).not.toBeFocused();
      expect(api.replies).toEqual([{ cancelled: true }]);
    } finally { await context.close(); }
  });
}
