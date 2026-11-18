import { expect, test, type Locator } from './fixtures/test-budget';
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

// Contrast must be measured on the rendered reader, not just palette constants.
async function expectReaderContrast(elements: Locator, property: 'color' | 'borderTopColor' | 'outlineColor' = 'color', minimum = 4.5): Promise<void> {
  const results = await elements.evaluateAll((nodes, property) => nodes.map(node => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (values: number[]) => values.map(v => v / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, index) => sum + v * [.2126, .7152, .0722][index]!, 0);
    let ancestor: Element | null = node;
    let background = 'rgba(0, 0, 0, 0)';
    while (ancestor && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(ancestor).backgroundColor;
      ancestor = ancestor.parentElement;
    }
    const [low, high] = [luminance(rgb(getComputedStyle(node)[property])), luminance(rgb(background))].sort((a, b) => a - b);
    return { selector: node.className, ratio: (high! + .05) / (low! + .05) };
  }), property);
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) expect(result.ratio, result.selector).toBeGreaterThanOrEqual(minimum);
}

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
    for (const selector of ['.syntax-string', '.syntax-number', '.syntax-keyword', '.syntax-comment', '.source-view i', '.git-badge', '.viewer-meta']) {
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
    await expect(panel.locator('.markdown-preview h1')).toHaveText('Reader');
    await expect(panel).toHaveScreenshot(`reader-colors-${theme}.png`);
  });
}
