import { expect, test } from './fixtures/test-budget';
import { installMockApi, mockSession } from './fixtures/mock-api';

// Frontend-only admission/lifetime controls; real parsing/storage is covered in
// file-previews-live.spec.ts and the owning HTTP/parser tests.
test('file tabs are bounded, keyboard navigable and distinguish identical basenames', async ({ page }) => {
  const api = await installMockApi(page, { sessions: [mockSession('file-tabs', 'File tabs')], workspaceFiles: [
    ...Array.from({ length: 9 }, (_, index) => ({ path: `file-${index + 1}.csv`, content: index ? 'name,value\ncurrent,data' : Array(501).fill('too many rows').join('\n') })),
    { path: 'left/same.csv', content: 'name,value\nleft,one' }, { path: 'right/same.csv', content: 'name,value\nright,two' },
  ] });
  await page.goto('/chat/file-tabs');
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
  if (!await panel.isVisible()) await page.keyboard.press('Control+Shift+F');
  await panel.locator('.file-name').filter({ hasText: 'file-1.csv' }).click();
  await panel.locator('.file-viewer nav').getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Table preview limit exceeded');
  await expect(panel.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
  await panel.locator('.file-viewer nav').getByRole('button', { name: 'Source', exact: true }).click();
  await expect(panel.locator('.source-view')).toContainText('too many rows');
  for (let index = 2; index <= 8; index++) {
    await panel.locator('.file-name').filter({ hasText: `file-${index}.csv` }).click();
    await expect(panel.locator('.file-viewer > header')).toContainText(`file-${index}.csv`);
  }
  const reads = api.requests.filter(request => request.path === '/api/files/content').length;
  await panel.locator('.file-name').filter({ hasText: 'file-9.csv' }).click();
  await expect(panel.getByRole('alert')).toContainText('At most 8 files');
  await expect(panel.getByRole('tab')).toHaveCount(8);
  expect(api.requests.filter(request => request.path === '/api/files/content')).toHaveLength(reads);
  await panel.getByRole('tab', { name: 'file-1.csv', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'file-2.csv', exact: true })).toBeFocused();
  await expect(panel.locator('.file-viewer > header')).toContainText('file-2.csv');
  await panel.getByRole('tab', { name: 'file-7.csv', exact: true }).focus(); await page.keyboard.press('Delete');
  await panel.getByRole('tab', { name: 'file-8.csv', exact: true }).focus(); await page.keyboard.press('Delete');
  await expect(panel.getByRole('tab', { name: 'file-2.csv', exact: true })).toBeFocused();
  for (const folder of ['left', 'right']) {
    await panel.locator('.file-name').filter({ hasText: folder }).click();
    await panel.locator(`button[title="${folder}/same.csv"]`).click();
    await expect(panel.locator('.file-viewer > header')).toContainText('same.csv');
  }
  await expect(panel.getByRole('tab', { name: 'left/same.csv', exact: true })).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'right/same.csv', exact: true })).toBeVisible();
  await expect(panel.locator('button.file-name[title="right/same.csv"]')).toHaveAttribute('aria-current', 'true');
  await expect(panel.locator('.viewer-path')).toHaveText('right/same.csv');
  await panel.getByRole('tab', { name: 'left/same.csv', exact: true }).click();
  await expect(panel.locator('button.file-name[title="left/same.csv"]')).toHaveAttribute('aria-current', 'true');
  await expect(panel.locator('button.file-name[title="right/same.csv"]')).not.toHaveAttribute('aria-current', 'true');
  await expect(panel.locator('.viewer-path')).toHaveText('left/same.csv');
});

for (const scene of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'short-mobile', width: 390, height: 480 },
]) for (const theme of ['light', 'dark']) test(`maximized file viewer restores reading space ${scene.name}-${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: scene.width, height: scene.height });
  await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
    version: 4, theme, filesOpen: true,
  })), theme);
  const api = await installMockApi(page, { sessions: [mockSession('file-reading', 'File reading')], workspaceFiles: [
    { path: 'first.md', content: '# First\n\nRead without the explorer taking up the screen.' },
    { path: 'second.md', content: '# Second\n\nKeep file tabs available while reading.' },
  ] });
  await page.goto('/chat/file-reading');
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await composer.fill('Keep my draft');
  const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
  if (!await panel.isVisible()) await page.keyboard.press('Control+Shift+F');
  for (const file of ['second.md', 'first.md']) {
    await panel.locator('.file-name').filter({ hasText: file }).click();
    await expect(panel.locator('.file-viewer > header')).toContainText(file);
  }
  const tree = panel.locator('.file-tree');
  await expect(tree).toBeVisible();
  const normalHeight = await panel.locator('.viewer-content').evaluate(element => element.clientHeight);
  const reads = api.requests.filter(request => request.path === '/api/files/content').length;
  await panel.getByRole('button', { name: 'Maximize file viewer', exact: true }).click();
  await expect(tree).toBeHidden();
  await expect(panel.locator('.panel-linked-directories')).toBeHidden();
  await expect(panel.locator('.file-toolbar')).toBeHidden();
  await expect(panel.getByRole('tab')).toHaveCount(2);
  await expect(panel.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
  const readingHeight = await panel.locator('.viewer-content').evaluate(element => element.clientHeight);
  expect(readingHeight).toBeGreaterThan(normalHeight + 100);
  expect(readingHeight).toBeGreaterThan(scene.height / 2);
  expect(api.requests.filter(request => request.path === '/api/files/content')).toHaveLength(reads);
  for (const file of ['second.md', 'first.md']) {
    await panel.getByRole('tab', { name: file, exact: true }).click();
    await expect(panel.locator('.file-viewer > header')).toContainText(file);
  }
  await test.info().attach('maximized-file-viewer', { body: await page.screenshot({ caret: 'hide' }), contentType: 'image/png' });
  await panel.getByRole('tab', { name: 'first.md', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'second.md', exact: true })).toBeFocused();
  await expect(panel.locator('.file-viewer > header')).toContainText('second.md');
  await panel.getByRole('button', { name: 'Restore file viewer', exact: true }).click();
  await expect(tree).toBeVisible();
  await expect(panel.locator('.file-toolbar')).toBeVisible();
  await expect(panel.locator('.panel-linked-directories')).toBeVisible();
  expect(await panel.locator('.viewer-content').evaluate(element => element.clientHeight)).toBe(normalHeight);
  await expect(composer).toHaveValue('Keep my draft');
  await panel.getByRole('button', { name: 'Maximize file viewer', exact: true }).click();
  for (const file of ['second.md', 'first.md']) {
    await expect(panel.locator('.file-viewer > header')).toContainText(file);
    await panel.locator('.file-viewer > header').getByRole('button', { name: 'Close', exact: true }).click();
  }
  await expect(panel.getByRole('tab')).toHaveCount(0);
  await expect(tree).toBeVisible();
  await expect(panel.locator('.file-toolbar')).toBeVisible();
});

for (const kind of ['content', 'preview'] as const) test(`retired ${kind} read cannot recreate tabs or replace a newer file`, async ({ page }) => {
  await installMockApi(page, { sessions: [mockSession('file-tabs', 'File tabs')], workspaceFiles: [
    { path: kind === 'content' ? 'held.csv' : 'held.docx', content: 'metadata', binary: kind === 'preview' },
    { path: 'new.csv', content: 'name,value\ncurrent,canonical' },
  ] });
  let release!: () => void, entered!: () => void, resumed!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const completed = new Promise<void>(resolve => { resumed = resolve; });
  await page.route(`**/api/files/${kind}?**`, async route => {
    if (!new URL(route.request().url()).searchParams.get('path')?.startsWith('held.')) return route.fallback();
    entered(); await held;
    try {
      await route.fulfill({ json: kind === 'preview' ? { kind: 'docx', text: 'OLD-CONTENT' }
        : { path: 'held.csv', name: 'held.csv', size: 11, modifiedAt: '', language: 'text', binary: false, content: 'OLD-CONTENT' } });
    } finally { resumed(); }
  });
  try {
    await page.goto('/chat/file-tabs');
    await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
    const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
    if (!await panel.isVisible()) await page.keyboard.press('Control+Shift+F');
    await panel.locator('.file-name').filter({ hasText: 'held.' }).click();
    if (kind === 'preview') await panel.locator('.file-viewer nav').getByRole('button', { name: 'Preview', exact: true }).click();
    await pending;
    await page.keyboard.press('Control+Shift+F'); await expect(panel).toHaveCount(0);
    await page.keyboard.press('Control+Shift+F');
    await panel.locator('.file-name').filter({ hasText: 'new.csv' }).click();
    await expect(panel.locator('.source-view')).toContainText('current,canonical');
    release(); await completed;
    await page.evaluate(async () => { await fetch('/api/auth/status'); await new Promise(requestAnimationFrame); });
    await expect(panel.getByRole('tab')).toHaveCount(1);
    await expect(panel.getByRole('tab', { name: 'new.csv', exact: true })).toBeVisible();
    await expect(panel.locator('.source-view')).toContainText('current,canonical');
    await expect(panel).not.toContainText('OLD-CONTENT');
  } finally { release(); }
});
