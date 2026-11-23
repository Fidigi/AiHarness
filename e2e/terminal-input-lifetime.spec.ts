import { expect, test } from './fixtures/test-budget';
import { installTerminalControls } from './fixtures/terminal-controls';

test('serializes native terminal input and never replays an uncertain write', async ({ page }) => {
  await installTerminalControls(page);
  let release!: () => void, entered!: () => void;
  let enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let held = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  await page.route('**/api/terminals/*/input', async route => {
    const data = (route.request().postDataJSON() as { data: string }).data;
    seen.push(data);
    if (data === 'a' || data === 'c') {
      entered(); await held;
      if (data === 'c') return route.fulfill({ status: 500, json: { error: 'PRIVATE-INPUT-DETAIL' } });
    }
    await route.fallback();
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open workspace terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Terminal', exact: true });
    await expect(panel.locator('.xterm-rows')).toContainText('TERMINAL_CONTROLS_READY');
    const textarea = panel.locator('.xterm-helper-textarea'); await textarea.focus();
    await page.keyboard.type('a'); await enteredPromise; await page.keyboard.type('b');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(seen).toEqual(['a']); release();
    await expect.poll(() => [...seen]).toEqual(['a', 'b']);
    enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    held = new Promise<void>(resolve => { release = resolve; });
    await page.keyboard.type('c'); await enteredPromise; await page.keyboard.type('d'); release();
    await expect(panel.getByRole('alert')).toContainText('Hide and reopen');
    await expect(panel).not.toContainText('PRIVATE-INPUT-DETAIL');
    expect(seen).toEqual(['a', 'b', 'c']);
    await page.keyboard.type('z'); expect(seen).toEqual(['a', 'b', 'c']);
    await panel.getByRole('button', { name: 'Hide terminal', exact: true }).click();
    await page.getByRole('button', { name: 'Open workspace terminal', exact: true }).click();
    await expect(panel.locator('.xterm-rows')).toContainText('TERMINAL_CONTROLS_READY');
    await panel.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('e');
    await expect.poll(() => [...seen]).toEqual(['a', 'b', 'c', 'e']);
  } finally { release(); }
});

test('clears expired output, resumes retained UTF-8 boundaries and does not duplicate replay', async ({ page }) => {
  const fixture = await installTerminalControls(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open workspace terminal', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Terminal', exact: true });
  await expect(panel.locator('.xterm-rows')).toContainText('TERMINAL_CONTROLS_READY');
  fixture.expire();
  await expect(panel.locator('.xterm-rows')).toContainText('Terminal history incomplete');
  await expect(panel.locator('.xterm-rows')).toContainText('REPLAY_RETAINED_é😀');
  await expect(panel.locator('.xterm-rows')).not.toContainText('TERMINAL_CONTROLS_READY');
  const requests = fixture.counts().eventRequests;
  await expect.poll(() => fixture.counts().eventRequests).toBeGreaterThan(requests);
  expect((await panel.locator('.xterm-rows').innerText()).split('REPLAY_RETAINED_é😀')).toHaveLength(2);
  expect(fixture.counts().created).toBe(1);
});

test('refuses oversized restoration metadata before mounting or spawning a terminal', async ({ page }) => {
  const fixture = await installTerminalControls(page);
  await page.goto('/');
  await expect(page.locator('.workspace-button small')).not.toBeEmpty();
  await page.evaluate(async () => {
    const workspace = await fetch('/api/workspaces/default').then(response => response.json()) as { id: string };
    sessionStorage.setItem(`ai-harness-terminals-v1:${workspace.id}`,
      JSON.stringify({ version: 1, open: true, ids: ['terminal-controls'], padding: 'x'.repeat(32_768) }));
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open workspace terminal', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Terminal', exact: true })).toHaveCount(0);
  expect(fixture.counts().created).toBe(0);
});
