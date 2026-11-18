import { expect, test } from './fixtures/test-budget';
import { expectContrast as expectReaderContrast } from './fixtures/contrast';
import { installMockApi, mockSession } from './fixtures/mock-api';

test.describe('Explorer, Git et viewer', () => {
  test('affiche badges/diffs/aperçus, ouvre les liens file: à la ligne et importe un fichier', async ({ page }) => {
    const session = mockSession('files', 'Files', [{ role: 'assistant', content: '[Open implementation](file:src/app.ts#L2)' }]);
    session.messages[0]!.blocks = [
      { type: 'text', text: session.messages[0]!.content },
      { type: 'tool_call', id: 'write-1', name: 'write', input: { path: 'src/generated.ts', content: 'export {}' } },
    ];
    const api = await installMockApi(page, {
      sessions: [session],
      workspaceFiles: [
        {
          path: 'README.md', language: 'markdown', gitStatus: 'modified', additions: 2, deletions: 1,
          content: '---\ntitle: Fixture\n---\n# Fixture\n\nSafe **Markdown**.',
          diff: '@@ -1 +1 @@\n-old\n+new',
        },
        {
          path: 'src/app.ts', language: 'typescript', gitStatus: 'untracked', additions: 2, deletions: 0,
          content: 'const first = 1;\nexport const second = 2;\n',
          diff: '@@ -0,0 +1,2 @@\n+const first = 1;\n+export const second = 2;',
        },
        {
          path: 'deleted.txt', content: '', sourceUnavailable: true, gitStatus: 'deleted', additions: 0, deletions: 1,
          diff: '@@ -1 +0,0 @@\n-removed content',
        },
        { path: 'large.log', content: '', tooLarge: true, language: 'text' },
        { path: 'src/generated.ts', content: 'export {};\n', language: 'typescript' },
      ],
    });
    await page.goto('/chat/files');
    const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
    const readme = panel.locator('.file-name').filter({ hasText: 'README.md' });
    await expect(readme).toContainText('M');

    await readme.click();
    await expect(panel.locator('.viewer-meta')).toContainText('markdown');
    await panel.getByRole('button', { name: 'Preview' }).click();
    await expect(panel.locator('.frontmatter-card')).toContainText('title: Fixture');
    await expect(panel.locator('.markdown-preview h1#fixture')).toHaveText('Fixture');
    await panel.locator('.file-viewer > header').getByRole('button', { name: 'Close' }).click();
    await panel.locator('.file-name').filter({ hasText: 'large.log' }).click();
    await expect(panel.locator('.viewer-content')).toContainText('too large to preview');
    await expect(panel.locator('.file-viewer').getByRole('link', { name: 'Download' })).toBeVisible();
    await panel.locator('.file-viewer > header').getByRole('button', { name: 'Close' }).click();

    await panel.getByRole('button', { name: /Changes/ }).click();
    await expect(panel.locator('.git-summary')).toContainText('+4');
    await panel.locator('.change-row > button:first-child').filter({ hasText: 'README.md' }).click();
    await expect(panel.locator('.diff-view .added')).toContainText('+new');
    await expect(panel.locator('.diff-view .removed')).toContainText('-old');
    await panel.locator('.file-viewer > header').getByRole('button', { name: 'Close' }).click();
    await panel.locator('.change-row > button:first-child').filter({ hasText: 'deleted.txt' }).click();
    await expect(panel.locator('.diff-view .removed')).toContainText('-removed content');
    await panel.locator('.file-viewer > header').getByRole('button', { name: 'Close' }).click();

    await page.locator('.files-written').getByRole('button', { name: 'src/generated.ts' }).click();
    await expect(panel.locator('.file-viewer > header')).toContainText('generated.ts');
    await expect(panel.getByRole('button', { name: 'Files', exact: true })).toHaveClass(/active/);
    await panel.locator('.file-viewer > header').getByRole('button', { name: 'Close' }).click();

    await page.getByRole('link', { name: 'Open implementation' }).click();
    await expect(panel.locator('.file-viewer > header')).toContainText('app.ts');
    await expect(panel.locator('#source-line-2')).toHaveClass(/target-line/);
    const resizer = panel.getByRole('separator', { name: 'Resize file panel' });
    await panel.getByRole('button', { name: 'Files', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(resizer).toBeFocused();
    const width = Number(await resizer.getAttribute('aria-valuenow'));
    await resizer.press('ArrowLeft');
    await expect(resizer).toHaveAttribute('aria-valuenow', String(width + 20));
    await resizer.press('ArrowRight');
    await expect(resizer).toHaveAttribute('aria-valuenow', String(width));
    await panel.getByRole('button', { name: 'Maximize file viewer' }).click();
    await expect(panel).toHaveClass(/viewer-expanded/);
    await panel.getByRole('button', { name: 'Restore file viewer' }).click();
    await panel.locator('.file-viewer > header').getByRole('button', { name: 'Close' }).click();

    const upload = panel.getByRole('button', { name: 'Upload files', exact: true });
    await panel.getByRole('button', { name: 'Refresh files', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(upload).toBeFocused();
    const [cancelledChooser] = await Promise.all([page.waitForEvent('filechooser'), upload.press('Enter')]);
    await cancelledChooser.setFiles([]);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), upload.press('Space')]);
    await chooser.setFiles({ name: 'uploaded.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded') });
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(panel.locator('.file-name').filter({ hasText: 'uploaded.txt' })).toBeVisible();
    expect(api.requests.some(request => request.method === 'POST' && request.path === '/api/files/upload')).toBe(true);
    const mention = panel.getByRole('button', { name: 'Mention uploaded.txt', exact: true });
    await page.mouse.move(0, 0);
    await panel.locator('.file-name').filter({ hasText: 'uploaded.txt' }).focus();
    await page.keyboard.press('Tab');
    await expect(mention).toBeFocused();
    await expect(mention).toHaveCSS('opacity', '1');
    await mention.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toHaveValue('@uploaded.txt ');
  });
});

test('nested disclosures refresh canonical rows and retire older expansion responses', async ({ page }) => {
  const folder = 'src/deep/nested';
  const api = await installMockApi(page, {
    sessions: [mockSession('nested-files', 'Nested files', [{ role: 'assistant', content: `[Locate selected file](file:${folder}/keep.ts)` }])],
    workspaceFiles: [
      { path: `${folder}/keep.ts`, content: 'keep', language: 'typescript' },
      { path: `${folder}/removed.ts`, content: 'remove', language: 'typescript' },
    ],
  });
  let holdNext = false;
  let oldAdmitted = false;
  let releaseOld!: () => void;
  let deliveredOld!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const delivered = new Promise<void>(resolve => { deliveredOld = resolve; });
  await page.route('**/api/files?**', async route => {
    if (new URL(route.request().url()).searchParams.get('path') !== folder || !holdNext) { await route.fallback(); return; }
    holdNext = false;
    const entries = api.workspaceFiles.filter(file => file.path.startsWith(`${folder}/`)).map(file => ({
      path: file.path, name: file.path.split('/').at(-1), isDirectory: false, isSymbolicLink: false, hidden: false,
    }));
    oldAdmitted = true;
    await oldGate;
    await route.fulfill({ json: { cwd: '/workspace', path: folder, entries } });
    deliveredOld();
  });
  await page.goto('/chat/nested-files');
  const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
  const root = panel.getByRole('button', { name: 'src', exact: true });
  await root.focus();
  for (const name of ['src', 'deep', 'nested']) {
    const disclosure = panel.getByRole('button', { name, exact: true });
    await expect(disclosure).toBeFocused();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    if (name !== 'nested') {
      await expect(panel.getByRole('button', { name: name === 'src' ? 'deep' : 'nested', exact: true })).toBeVisible();
      await page.keyboard.press('Tab');
    }
  }
  const keep = panel.getByRole('button', { name: 'keep.ts', exact: true });
  await expect(keep).toBeVisible();
  let parentBox = await root.boundingBox();
  for (const name of ['deep', 'nested', 'keep.ts']) {
    const childBox = await panel.getByRole('button', { name, exact: true }).boundingBox();
    expect(childBox!.y).toBeGreaterThanOrEqual(parentBox!.y + parentBox!.height);
    expect(childBox!.x).toBeGreaterThan(parentBox!.x);
    parentBox = childBox;
  }
  await keep.click();
  await expect(panel.locator('.source-view')).toContainText('keep');
  const reads = api.requests.filter(request => request.path === '/api/files/content').length;
  await keep.focus(); await page.keyboard.press('Tab');
  const mention = panel.getByRole('button', { name: `Mention ${folder}/keep.ts`, exact: true });
  await expect(mention).toBeFocused(); await mention.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toHaveValue(`@${folder}/keep.ts `);
  holdNext = true;
  await panel.getByRole('button', { name: 'Refresh files', exact: true }).click();
  await expect.poll(() => oldAdmitted).toBe(true);
  await expect(panel.getByRole('button', { name: 'nested', exact: true })).toHaveAttribute('aria-busy', 'true');
  await expect(panel.getByRole('status').filter({ hasText: 'Loading nested…' })).toBeVisible();
  api.workspaceFiles.splice(1, 1, { path: `${folder}/added.ts`, content: 'added', language: 'typescript' });
  await panel.getByRole('button', { name: 'Refresh files', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'added.ts', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'removed.ts', exact: true })).toHaveCount(0);
  await expect(keep).toHaveAttribute('aria-current', 'true');
  await expect(panel.locator('.viewer-path')).toHaveText(`${folder}/keep.ts`);
  expect(api.requests.filter(request => request.path === '/api/files/content')).toHaveLength(reads);
  releaseOld(); await delivered;
  await expect(panel.getByRole('button', { name: 'added.ts', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'removed.ts', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  let releaseRead!: () => void, enterRead!: () => void;
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const readAdmitted = new Promise<void>(resolve => { enterRead = resolve; });
  await page.route('**/api/files/content?**', async route => {
    if (new URL(route.request().url()).searchParams.get('path') !== `${folder}/keep.ts`) return route.fallback();
    enterRead(); await readGate; await route.fallback();
  });
  try {
    await keep.click(); await readAdmitted;
    await expect(panel.locator('.source-view')).toHaveCount(0);
    await root.click(); releaseRead();
    await expect(panel.locator('.source-view')).toContainText('keep');
    await expect(root).toHaveAttribute('aria-expanded', 'false');
    await expect(keep).toBeHidden();
  } finally { releaseRead(); }
  await panel.getByRole('button', { name: 'Collapse workspace explorer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand workspace explorer', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Locate selected file', exact: true }).click();
  await expect(keep).toBeVisible();
  await expect(keep).toHaveAttribute('aria-current', 'true');
  await root.click();
  await panel.getByRole('searchbox', { name: 'Search files', exact: true }).fill('keep.ts');
  await panel.locator('.file-tree').getByRole('button', { name: `${folder}/keep.ts`, exact: true }).click();
  await panel.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(keep).toBeVisible();
  await expect(keep).toHaveAttribute('aria-current', 'true');
  await expect(panel.locator('.viewer-path')).toHaveText(`${folder}/keep.ts`);
});

for (const locale of ['en', 'fr']) test(`file search feedback and stale-result retirement: ${locale}`, async ({ page }) => {
  const fr = locale === 'fr';
  await page.addInitScript(locale => localStorage.setItem('ai-harness-locale', locale), locale);
  const api = await installMockApi(page, { sessions: [mockSession('file-search', 'File search')], workspaceFiles: [
    { path: 'stale.txt', content: 'stale' }, { path: 'fresh.txt', content: 'fresh' },
  ] });
  let releaseOld!: () => void;
  let admittedOld!: () => void;
  let deliveredOld!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const admitted = new Promise<void>(resolve => { admittedOld = resolve; });
  const delivered = new Promise<void>(resolve => { deliveredOld = resolve; });
  const queries: string[] = [];
  await page.route('**/api/files/index?**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q')!;
    queries.push(query);
    if (query === 'old') { admittedOld(); await oldGate; }
    if (query === 'fail') { await route.fulfill({ status: 500, json: { error: 'Synthetic search failure' } }); return; }
    const files = query === 'new' ? ['fresh.txt'] : query === 'missing' ? [] : ['stale.txt'];
    await route.fulfill({ json: { files, directories: [], total: files.length, directoryTotal: 0, truncated: false } });
    if (query === 'old') deliveredOld();
  });
  await page.goto('/chat/file-search');
  const panel = page.getByRole('complementary', { name: fr ? 'Explorateur du workspace' : 'Workspace explorer' });
  const search = panel.locator('input[type="search"]');
  await search.fill('ready');
  await expect(panel.locator('.file-tree').getByRole('button', { name: 'stale.txt', exact: true })).toBeVisible();
  await search.fill('old');
  await admitted;
  await expect(panel.getByRole('status')).toHaveText(fr ? 'Recherche de fichiers…' : 'Searching files…');
  await expect(panel.locator('.file-tree button')).toHaveCount(0);
  await search.fill(' new ');
  const fresh = panel.locator('.file-tree').getByRole('button', { name: 'fresh.txt', exact: true });
  await expect(fresh).toBeVisible();
  expect(queries.at(-1)).toBe('new');
  releaseOld(); await delivered;
  await expect(panel.locator('.file-tree').getByRole('button', { name: 'stale.txt', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: `${fr ? 'Mentionner' : 'Mention'} fresh.txt`, exact: true }).click();
  await expect(page.locator('.input-container textarea')).toHaveValue('@fresh.txt ');
  expect(api.requests.filter(request => request.path === '/api/files/content')).toHaveLength(0);
  await fresh.click();
  await expect(fresh).toHaveAttribute('aria-current', 'true');
  await expect(panel.locator('.viewer-path')).toHaveText('fresh.txt');
  await search.fill('missing');
  await expect(panel.getByRole('status')).toHaveText(fr ? 'Aucun fichier correspondant.' : 'No matching files.');
  await search.fill('fail');
  await expect(panel.getByRole('alert')).toHaveText(fr ? 'La recherche de fichiers a échoué.' : 'File search failed.');
  await expect(panel.locator('.file-tree button')).toHaveCount(0);
  const count = queries.length;
  await page.clock.install();
  await search.fill('   ');
  await expect(panel.getByRole('status')).toHaveText(fr ? 'Indiquez un nom de fichier à rechercher.' : 'Enter a file name to search.');
  await page.clock.fastForward(1000);
  expect(queries).toHaveLength(count);
  await panel.getByRole('button', { name: fr ? 'Effacer la recherche' : 'Clear search', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(panel.locator('.file-name')).toHaveCount(2);
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test.describe('touch file controls', () => {
  test.use({ viewport: { width: 390, height: 600 }, hasTouch: true });
  for (const theme of ['light', 'dark']) {
    test(`visible mention and reachable upload/viewer controls: ${theme}`, async ({ page }) => {
      await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
        version: 4, theme, filesOpen: true,
      })), theme);
      await installMockApi(page, { sessions: [mockSession('touch-files', 'Touch files')], workspaceFiles: [
        { path: 'example.ts', language: 'typescript', content: 'const label = "hello"; // readable\nconst count = 42;' },
      ] });
      await page.goto('/chat/touch-files');
      await page.getByRole('button', { name: 'Workspace explorer', exact: true }).tap();
      const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
      const mention = panel.getByRole('button', { name: 'Mention example.ts', exact: true });
      await expect(mention).toHaveCSS('opacity', '1');
      for (const control of [mention, panel.getByRole('button', { name: 'Upload files', exact: true }), panel.locator('.file-name')]) {
        const bounds = await control.boundingBox();
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
      await mention.tap();
      await panel.getByRole('button', { name: 'Close', exact: true }).tap();
      await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toHaveValue('@example.ts ');
      await page.getByRole('button', { name: 'Workspace explorer', exact: true }).tap();
      await panel.locator('.file-name').tap();
      await panel.getByRole('button', { name: 'Maximize file viewer' }).tap();
      await expect(panel).toHaveClass(/viewer-expanded/);
      for (const control of await panel.locator('.file-viewer footer button, .file-viewer footer a').all()) {
        const bounds = await control.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
      await expect(panel).toHaveScreenshot(`reader-touch-${theme}.png`);
      await panel.getByRole('button', { name: 'Restore file viewer' }).tap();
      await expect(panel.getByRole('button', { name: 'Upload files', exact: true })).toBeVisible();
    });
  }
});

for (const theme of ['light', 'dark', 'mist', 'rose', 'pine', 'system-light', 'system-dark']) {
  test(`reader semantic colors and text contrast: ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme.endsWith('dark') ? 'dark' : 'light' });
    await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
      version: 4, theme: theme.startsWith('system-') ? 'system' : theme, filesOpen: true,
    })), theme);
    await installMockApi(page, { sessions: [mockSession('reader-colors', 'Reader colors', [
      { role: 'assistant', content: '[Selected source](file:example.ts#L1)' },
    ])], workspaceFiles: [
      { path: 'example.ts', language: 'typescript', gitStatus: 'untracked', content: 'const label = "hello"; // readable comment\nconst count = 42;',
        diff: '@@ -1 +1 @@\n-old\n+new' },
      { path: 'README.md', language: 'markdown', gitStatus: 'modified', content: '---\ntitle: Reader\n---\n# Reader' },
    ] });
    await page.goto('/chat/reader-colors');
    const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
    await panel.locator('.file-name').filter({ hasText: 'example.ts' }).click();
    await expect(panel.locator('.syntax-string')).toBeVisible();
    for (const selector of ['.syntax-string', '.syntax-number', '.syntax-keyword', '.syntax-comment', '.source-view i', '.git-badge', '.viewer-meta', '.viewer-path']) {
      await expectReaderContrast(panel.locator(selector));
    }
    await page.getByRole('link', { name: 'Selected source' }).click();
    await expect(panel.locator('.target-line')).toBeVisible();
    await expectReaderContrast(panel.locator('.target-line .syntax-string, .target-line .syntax-keyword, .target-line .syntax-comment'));
    const search = panel.locator('input[type=search]');
    await search.focus();
    await expectReaderContrast(search, 'borderTopColor', 3);
    await expectReaderContrast(search, 'outlineColor', 3);
    await panel.locator('.file-name').filter({ hasText: 'example.ts' }).hover();
    await expectReaderContrast(panel.locator('.file-name, .file-mention'));
    await page.mouse.move(0, 0);
    const selectedRow = panel.locator('.file-name[aria-current="true"]');
    await expectReaderContrast(selectedRow);
    await expectReaderContrast(selectedRow, 'boxShadow', 3);
    const token = await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--surface-panel').trim());
    expect(token).not.toBe('');
    expect(await panel.locator('.file-viewer').evaluate((element, token) => {
      const probe = document.createElement('span'); probe.style.color = token; element.append(probe);
      const expected = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(element).backgroundColor === expected;
    }, token)).toBe(true);
    await expect(panel).toHaveScreenshot(`reader-source-${theme}.png`);
    await panel.locator('.file-viewer nav').getByRole('button', { name: 'Diff', exact: true }).click();
    await expect(panel.locator('.diff-view .added')).toBeVisible();
    await expectReaderContrast(panel.locator('.diff-view .added, .diff-view .removed, .diff-view .hunk'));
    await panel.locator('.file-name').filter({ hasText: 'README.md' }).click();
    await panel.locator('.file-viewer nav').getByRole('button', { name: 'Preview', exact: true }).click();
    await expectReaderContrast(panel.locator('.frontmatter-card summary'));
    await expectReaderContrast(panel.locator('.git-badge'));
    await expect(panel.locator('.markdown-preview h1')).toHaveText('Reader');
    await expect(panel).toHaveScreenshot(`reader-colors-${theme}.png`);
  });
}
