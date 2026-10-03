import { expect, test } from '@playwright/test';
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
    await panel.getByRole('button', { name: 'Maximize file viewer' }).click();
    await expect(panel).toHaveClass(/viewer-expanded/);
    await panel.getByRole('button', { name: 'Restore file viewer' }).click();
    await panel.locator('.file-viewer > header').getByRole('button', { name: 'Close' }).click();

    const upload = panel.locator('input[type=file]');
    await upload.setInputFiles({ name: 'uploaded.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded') });
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(panel.locator('.file-name').filter({ hasText: 'uploaded.txt' })).toBeVisible();
    expect(api.requests.some(request => request.method === 'POST' && request.path === '/api/files/upload')).toBe(true);
  });
});
