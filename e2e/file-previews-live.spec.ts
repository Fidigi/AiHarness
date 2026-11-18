import AxeBuilder from '@axe-core/playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { start, stop } from '../packages/server/dist/index.js';
import { docxDocument, pdfDocument } from '../tests/fixtures/web04-documents';
import { expect, test, reserveReadBudget } from './fixtures/test-budget';

const exec = promisify(execFile);
for (const scenario of [
  { locale: 'en', theme: 'light', width: 1280 }, { locale: 'en', theme: 'dark', width: 390 },
  { locale: 'fr', theme: 'light', width: 390 }, { locale: 'fr', theme: 'dark', width: 1280 },
] as const) test(`native file previews ${scenario.locale}/${scenario.theme}/${scenario.width}`, async ({ page }) => {
  test.setTimeout(60_000);
  const { locale, theme, width } = scenario;
  const copy = locale === 'fr' ? { explorer: 'Explorateur du workspace', preview: 'Aperçu', download: 'Télécharger', next: 'Page suivante', pageText: 'Texte de la page', failed: 'Aperçu indisponible', changes: 'Modifications' }
    : { explorer: 'Workspace explorer', preview: 'Preview', download: 'Download', next: 'Next page', pageText: 'Page text', failed: 'Preview unavailable', changes: 'Changes' };
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-web04-live-'));
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'web04-live-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'web04-live-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
  try {
    await writeFile(path.join(cwd, 'AGENTS.md'), 'Explicit project trust required.');
    const csv = 'name,value\r\n"a,b","line one\nline two"\r\nformula,=1+1\r\nliteral,<script>not executable</script>\r\n';
    await writeFile(path.join(cwd, 'data.csv'), csv);
    await writeFile(path.join(cwd, 'data.tsv'), 'name\tvalue\nTSV\t=SUM(1,2)\n');
    await writeFile(path.join(cwd, 'report.docx'), docxDocument());
    await writeFile(path.join(cwd, 'report.pdf'), pdfDocument());
    await writeFile(path.join(cwd, 'bad.docx'), 'PRIVATE-DOCX-PARSER-DETAIL');
    await writeFile(path.join(cwd, 'tracked.txt'), 'before\n');
    await exec('git', ['init', '-q', cwd]);
    await exec('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '.']);
    await exec('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    await writeFile(path.join(cwd, 'tracked.txt'), 'before\nafter\n');
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), defaultCwd: cwd,
      allowedRoots: [root], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'web04-live-admin' } })).status()).toBe(200);
    await reserveReadBudget(page.request, base);
    const selector = new URLSearchParams({ cwd, path: 'report.docx' });
    expect((await page.request.get(`${base}/api/files/preview?${selector}`)).status()).toBe(409);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    const session = await page.request.post(`${base}/api/sessions`, { data: { cwd, title: 'File previews' } }).then(response => response.json());
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme, filesOpen: true, sound: false }));
    }, { locale, theme });
    const external: string[] = [];
    page.on('request', request => { if (request.url().startsWith('https://external.invalid/')) external.push(request.url()); });
    await page.goto(`${base}/chat/${session.id}?cwd=${encodeURIComponent(cwd)}`);
    await expect(page.getByRole('textbox', { name: locale === 'fr' ? 'Zone de rédaction' : 'Message composer', exact: true })).toBeVisible();
    const panel = page.getByRole('complementary', { name: copy.explorer });
    if (!await panel.isVisible()) await page.keyboard.press('Control+Shift+F');
    await expect(panel.locator('.file-name').filter({ hasText: 'data.csv' })).toBeVisible();
    const open = async (name: string) => {
      await panel.locator('.file-name').filter({ hasText: name }).click();
      await expect(panel.locator('.file-viewer > header')).toContainText(name);
      await panel.locator('.file-viewer nav').getByRole('button', { name: copy.preview, exact: true }).click();
    };
    await open('data.csv');
    await expect(panel.getByRole('cell', { name: 'a,b', exact: true })).toBeVisible();
    await expect(panel.getByRole('cell', { name: '=1+1', exact: true })).toBeVisible();
    await expect(panel.locator('table')).toContainText('line one\nline two');
    await expect(panel.locator('table script')).toHaveCount(0);
    await open('data.tsv'); await expect(panel.getByRole('cell', { name: '=SUM(1,2)', exact: true })).toBeVisible();
    await open('report.docx'); await expect(panel.locator('.docx-preview pre')).toHaveText('Read-only DOCX <script>literal</script>');
    await expect(panel.locator('.docx-preview script, .docx-preview a, .docx-preview iframe')).toHaveCount(0);
    await open('report.pdf');
    await expect(panel.locator('.pdf-preview canvas')).toBeVisible();
    await panel.getByText(copy.pageText, { exact: true }).click();
    await expect(panel.locator('.pdf-preview pre')).toContainText('Read-only PDF page 1');
    await panel.getByRole('button', { name: copy.next, exact: true }).click();
    await expect(panel.locator('.pdf-preview pre')).toContainText('Read-only PDF page 2');
    expect(await page.evaluate(() => 'web04Executed' in globalThis)).toBe(false); expect(external).toEqual([]);
    await open('bad.docx'); await expect(panel.getByRole('alert')).toContainText(copy.failed);
    await expect(panel).not.toContainText('PRIVATE-DOCX-PARSER-DETAIL');
    // Inactive tabs cache no document bytes: returning requires a fresh native read.
    const fresh = csv + 'fresh,canonical read\r\n'; await writeFile(path.join(cwd, 'data.csv'), fresh);
    await panel.getByRole('tab', { name: 'data.csv', exact: true }).click();
    await expect(panel.getByRole('cell', { name: 'canonical read', exact: true })).toBeVisible();
    await expect(panel.getByRole('tab')).toHaveCount(5);
    expect((await new AxeBuilder({ page }).include('.workspace-panel').analyze()).violations).toEqual([]);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(panel).toHaveScreenshot(`file-previews-${locale}-${theme}-${width}.png`);
    const download = page.waitForEvent('download');
    await panel.getByRole('link', { name: copy.download, exact: true }).click();
    expect(await readFile((await (await download).path())!, 'utf8')).toBe(fresh);
    // Real collision refusal must not overwrite; rename is a distinct explicit action.
    const upload = panel.locator('input[type=file]');
    const rejected = page.waitForResponse(response => response.url().endsWith('/api/files/upload'));
    await upload.setInputFiles({ name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('new,value\n') });
    expect((await rejected).status()).toBe(409); expect(await readFile(path.join(cwd, 'data.csv'), 'utf8')).toBe(fresh);
    await expect(upload).toBeEnabled();
    await panel.locator('.upload-options select').selectOption('rename');
    const renamed = page.waitForResponse(response => response.url().endsWith('/api/files/upload'));
    await upload.setInputFiles({ name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('new,value\n') });
    expect((await renamed).status()).toBe(201);
    expect(await readFile(path.join(cwd, 'data (1).csv'), 'utf8')).toBe('new,value\n');
    await panel.getByRole('button', { name: new RegExp(`^${copy.changes}`) }).click();
    await panel.locator('.change-row > button:first-child').filter({ hasText: 'tracked.txt' }).click();
    await expect(panel.locator('.diff-view .added')).toContainText('+after');

    if (locale === 'en' && width === 1280) {
      // Genuine Sidebar -> Git worktree -> fresh trust -> rekeyed files, not mocked DTOs.
      const checkout = path.join(root, 'checkout');
      await page.getByRole('button', { name: 'Create a worktree', exact: true }).click();
      const form = page.locator('.worktree-form');
      await form.getByPlaceholder('Destination path').fill(checkout);
      await form.getByPlaceholder('Branch name').fill('web04-preview');
      await form.getByRole('button', { name: 'Create worktree', exact: true }).click();
      const trust = page.getByRole('alertdialog'); await expect(trust).toBeVisible();
      expect((await page.request.get(`${base}/api/files/preview?${new URLSearchParams({ cwd: checkout, path: 'report.docx' })}`)).status()).toBe(409);
      await trust.getByRole('button', { name: 'Trust project', exact: true }).click();
      await expect(page.locator('.worktree-switcher select')).toHaveValue(checkout);
      await expect(panel.getByRole('tab')).toHaveCount(0);
      await open('data.csv'); await expect(panel.locator('table')).not.toContainText('canonical read');
      await page.locator('.worktree-switcher select').selectOption(cwd);
      await expect(panel.getByRole('tab')).toHaveCount(0);
      await writeFile(path.join(checkout, 'dirty.txt'), 'keep unless explicitly forced');
      await page.getByRole('button', { name: 'Create a worktree', exact: true }).click();
      const remove = page.locator('.worktree-form button.danger').filter({ hasText: 'web04-preview' });
      let dialogs = 0;
      const declineForce = async (dialog: import('@playwright/test').Dialog) => { dialogs++; if (dialogs === 1) await dialog.accept(); else await dialog.dismiss(); };
      page.on('dialog', declineForce);
      await remove.click(); await expect.poll(() => dialogs).toBe(2);
      expect(await readFile(path.join(checkout, 'dirty.txt'), 'utf8')).toContain('keep');
      page.off('dialog', declineForce);
      const accept = async (dialog: import('@playwright/test').Dialog) => { await dialog.accept(); };
      page.on('dialog', accept);
      const removed = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith('/api/workspaces/worktrees') && response.status() === 200);
      await remove.click(); await removed; page.off('dialog', accept);
      await expect(remove).toHaveCount(0); expect(await readFile(path.join(cwd, 'data.csv'), 'utf8')).toBe(fresh);
    }
  } finally {
    await stop(); await rm(root, { recursive: true, force: true });
    names.forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]);
  }
});
