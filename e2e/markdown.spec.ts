import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures/test-budget';
import { installMockApi, mockSession } from './fixtures/mock-api';

const userText = '## Typed lines\n\nFirst line\nSecond line\n\n1. Question\nA. Option one\nB. Option two\n2. Next question\n\n**Membership $20/mo**\nWaives the $6 fee. Formula: $2 + 2 = 4$.\n\nhttps://example.com/docs，后面 5~7U';
const assistantText = '## Shared Markdown\n\n**Price: $20/month**\nPlus a $6 fee. Formula: $x + 1$.\n\nhttps://example.com/中文，说明\n\n```text\n$20 + $6 stays literal\nfirst\nsecond\n```\n\n<script>window.__markdownInjected = true</script>\n\nSafe **response**.';

for (const scenario of [
  { name: 'desktop-dark', width: 1440, theme: 'dark' },
  { name: 'desktop-light', width: 1440, theme: 'light' },
  { name: 'mobile-dark', width: 390, theme: 'dark' },
  { name: 'mobile-light', width: 390, theme: 'light' },
] as const) {
  test(`${scenario.name} preserves user lines and safe Markdown with visual and accessibility evidence`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 1400 });
    await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme })), scenario.theme);
    await installMockApi(page, { sessions: [mockSession('markdown', 'Markdown edges', [
      { role: 'user', content: userText }, { role: 'assistant', content: assistantText },
    ])] });
    await page.goto('/chat/markdown');
    const user = page.locator('.message.user .markdown-content');
    const assistant = page.locator('.message.assistant .markdown-content');
    await expect(assistant.locator('.katex')).toHaveCount(1);
    const assistantAccessibility = await new AxeBuilder({ page }).include('.message.assistant')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(assistantAccessibility.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
    await page.evaluate(() => document.fonts.ready);
    await expect(assistant).toHaveScreenshot(`markdown-renderer-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
    await expect(user.locator('p').filter({ hasText: 'First line' }).locator('br')).toHaveCount(1);
    await expect(user.locator('li').first().locator('br')).toHaveCount(2);
    await expect(user.locator('.katex')).toHaveCount(1);
    await expect(user.getByRole('link', { name: 'https://example.com/docs' })).toHaveAttribute('href', 'https://example.com/docs');
    await expect(assistant.getByRole('link', { name: 'https://example.com/中文' })).toHaveAttribute('href', 'https://example.com/%E4%B8%AD%E6%96%87');
    await expect(assistant.locator('.code-block')).toContainText('$20 + $6 stays literal');
    expect(await page.evaluate(() => '__markdownInjected' in window)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
    const accessibility = await new AxeBuilder({ page }).include('.messages-container')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    const messages = page.locator('.messages-container');
    await messages.evaluate(element => { element.scrollTop = 0; });
    await expect(messages).toHaveScreenshot(`markdown-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
  });
}

for (const operation of ['paste', 'list'] as const) {
  test(`${operation} caret restoration never crosses a session switch on a reused textarea`, async ({ page }) => {
    await installMockApi(page, { sessions: [mockSession('caret-source', 'Source'), mockSession('caret-target', 'Target')] });
    await page.goto('/chat/caret-source');
    const input = page.locator('.input-container textarea');
    await input.fill(operation === 'paste' ? 'before AFTER' : '- item');
    const result = await page.evaluate(async operation => {
      const modulePath = '/src/store/session-store.ts';
      const { useSessionStore } = await import(modulePath);
      const target = document.querySelector<HTMLTextAreaElement>('.input-container textarea')!;
      const original = window.requestAnimationFrame;
      const frames: FrameRequestCallback[] = [];
      window.requestAnimationFrame = callback => { frames.push(callback); return 123_456; };
      try {
        if (operation === 'paste') {
          target.setSelectionRange(7, 7);
          const clipboard = new DataTransfer();
          clipboard.setData('text/plain', 'insert'); clipboard.setData('text/html', '<div>insert</div>');
          target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
        } else target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
        const caretFrames = frames.slice();
        const nextDraft = operation === 'paste' ? 'before insertAFTER' : '- item\n- ';
        useSessionStore.getState().setDraft('caret-target', nextDraft);
        useSessionStore.setState({ activeSessionId: 'caret-target' });
        await new Promise(resolve => setTimeout(resolve, 0));
        const current = document.querySelector<HTMLTextAreaElement>('.input-container textarea')!;
        current.setSelectionRange(1, 1);
        for (const callback of caretFrames) callback(performance.now());
        return { frames: caretFrames.length, reused: current === target, value: current.value,
          selection: [current.selectionStart, current.selectionEnd], active: useSessionStore.getState().activeSessionId };
      } finally { window.requestAnimationFrame = original; }
    }, operation);
    expect(result.frames).toBeGreaterThan(0);
    expect(result.reused).toBe(true);
    expect(result.active).toBe('caret-target');
    expect(result.value).toBe(operation === 'paste' ? 'before insertAFTER' : '- item\n- ');
    expect(result.selection).toEqual([1, 1]);
  });
}

test('pasted wrapper HTML preserves plain-text lines, safe links and caret; lists continue only for newline keys', async ({ page }) => {
  const api = await installMockApi(page, { sessions: [mockSession('markdown-paste', 'Paste')] });
  await page.goto('/chat/markdown-paste');
  const input = page.locator('.input-container textarea');
  await expect(input).toBeVisible();
  await input.fill('before AFTER');
  await input.evaluate((node: HTMLTextAreaElement) => {
    node.setSelectionRange(7, 7);
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', 'one\ntwo\nDocs\n');
    clipboard.setData('text/html', '<div>one</div><div>two</div><div><a href="https://example.com/docs">Docs</a></div>');
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  const paste = 'before one\ntwo\n[Docs](https://example.com/docs)\nAFTER';
  await expect(input).toHaveValue(paste);
  await expect.poll(() => input.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(paste.length - 5);
  await expect.poll(() => input.evaluate((node: HTMLTextAreaElement) => node.selectionEnd)).toBe(paste.length - 5);
  await input.press('!');
  await expect(input).toHaveValue(paste.slice(0, -5) + '!AFTER');
  await input.fill('before REPLACE after');
  await input.evaluate((node: HTMLTextAreaElement) => {
    node.setSelectionRange(7, 14);
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', 'Docs Docs Docs');
    clipboard.setData('text/html', 'Docs <a href="https://example.com/one">Docs</a> <a href="https://example.com/two">Docs</a>');
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  const replacement = 'before Docs [Docs](https://example.com/one) [Docs](https://example.com/two) after';
  await expect(input).toHaveValue(replacement);
  await expect.poll(() => input.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(replacement.length - 6);
  await input.fill('- first second');
  await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(7, 7));
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('- first\n-  second');
  await expect.poll(() => input.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(10);
  await input.press('X');
  await expect(input).toHaveValue('- first\n- X second');
  await input.fill('- [x] completed');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('- [x] completed\n- [ ] ');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('- [x] completed\n');
  await input.fill('009. item');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('009. item\n010. ');
  await input.fill('```text\n- code');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('```text\n- code\n');
  expect(api.requests.some(request => request.path === '/api/agent/runs' && request.method === 'POST')).toBe(false);
});

test('clipboard metadata is inert before filtering and bounded without losing plaintext', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('clipboard.invalid')) requests.push(request.url()); });
  await page.route('https://clipboard.invalid/**', route => route.fulfill({ status: 200, body: '' }));
  await installMockApi(page, { sessions: [mockSession('markdown-security', 'Clipboard security')] });
  await page.goto('/chat/markdown-security');
  const input = page.locator('.input-container textarea');
  await expect(input).toBeVisible();
  const original = '  First\r\n\t第二\r\n\r\nlast  ';
  expect(await page.evaluate(async text => {
    const path = '/src/components/markdown-paste.ts';
    const helper = await import(path);
    return helper.clipboardTextToMarkdown(text, '<div>First</div><div>第二</div><div>last</div>');
  }, original)).toBe(original);
  await page.evaluate(() => {
    customElements.define('clipboard-probe', class extends HTMLElement {
      constructor() { super(); (window as Window & { __clipboardInjected?: boolean }).__clipboardInjected = true; }
    });
  });
  const paste = async (text: string, html: string) => {
    await input.fill('');
    await input.evaluate((node: HTMLTextAreaElement, payload) => {
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', payload.text);
      clipboard.setData('text/html', payload.html);
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
    }, { text, html });
  };
  await paste('one\r\nDocs\n\tlast  ', `
    <clipboard-probe></clipboard-probe>
    <img src="https://clipboard.invalid/img" onerror="window.__clipboardInjected=true">
    <iframe src="https://clipboard.invalid/frame"></iframe>
    <iframe srcdoc='<img src="https://clipboard.invalid/srcdoc">'></iframe>
    <object data="https://clipboard.invalid/object"></object><embed src="https://clipboard.invalid/embed">
    <link rel="stylesheet" href="https://clipboard.invalid/css">
    <style>@import url(https://clipboard.invalid/import); div { background: url(https://clipboard.invalid/bg); }</style>
    <svg><image href="https://clipboard.invalid/svg" /></svg>
    <video poster="https://clipboard.invalid/poster"><source src="https://clipboard.invalid/video"></video>
    <audio src="https://clipboard.invalid/audio"></audio>
    <script src="https://clipboard.invalid/script">window.__clipboardInjected=true</script>
    <div>one</div><div><a href="https://example.com/docs">Docs</a></div><div>last</div>`);
  // The textarea uses the browser's LF normalization, but the helper never rewrites plaintext.
  await expect(input).toHaveValue('one\n[Docs](https://example.com/docs)\n\tlast  ');
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => '__clipboardInjected' in window)).toBe(false);
  await paste('safe Docs unsafe', '<a href="javascript:alert(1)">unsafe</a><a href="https://example.com">Docs</a>');
  await expect(input).toHaveValue('safe [Docs](https://example.com) unsafe');
  // Every overflow discards only optional metadata, not any plain user text.
  const text = '  Docs\n\t原文  '.repeat(10_000);
  for (const html of [
    'x'.repeat(65_537),
    '<span></span>'.repeat(1_025) + '<a href="https://example.com">Docs</a>',
    '<a href="https://example.com">Docs</a>'.repeat(33),
    '<a href="https://example.com">' + 'x'.repeat(1_025) + '</a>',
    '<a href="https://example.com/' + 'x'.repeat(2_048) + '">Docs</a>',
  ]) {
    await paste(text, html);
    await expect(input).toHaveValue(text);
  }
  expect(requests).toEqual([]);
});

test('newline mode continues CJK lists at the caret while IME confirmation and sending never continue', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, sendMode: 'mod-enter' })));
  const api = await installMockApi(page, { sessions: [mockSession('markdown-ime', 'IME lists')] });
  await page.goto('/chat/markdown-ime');
  const input = page.locator('.input-container textarea');
  await expect(input).toBeVisible();
  await input.fill('1、项目');
  await input.press('Enter');
  await expect(input).toHaveValue('1、项目\n2、');
  await expect.poll(() => input.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(7);
  await input.fill('- composing');
  await input.evaluate((node: HTMLTextAreaElement) => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, isComposing: true, bubbles: true, cancelable: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '项目' }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await expect(input).toHaveValue('- composing');
  expect(api.requests.filter(request => request.path === '/api/agent/runs' && request.method === 'POST')).toHaveLength(0);
  await page.waitForTimeout(150);
  await input.fill('- selected tail');
  await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 10));
  await input.press('Enter');
  await expect(input).toHaveValue('- \n tail');
  await input.fill('- send item');
  await input.press('Control+Enter');
  await expect.poll(() => api.requests.filter(request => request.path === '/api/agent/runs' && request.method === 'POST').length).toBe(1);
  const sent = api.requests.find(request => request.path === '/api/agent/runs' && request.method === 'POST');
  expect(sent?.body).toMatchObject({ input: '- send item' });
});

test('file preview and noninteractive minimap share currency, CJK and math semantics', async ({ page }) => {
  const content = '**Price: $20/month**\nPlus a $6 fee. Formula: $2 + 2 = 4$.\n\nhttps://example.com/docs，后面';
  await installMockApi(page, { sessions: [mockSession('markdown-preview', 'Preview', [
    ...Array.from({ length: 8 }, (_, index) => ({ role: 'assistant' as const, content: `Earlier ${index}` })),
    { role: 'assistant', content },
  ])], workspaceFiles: [
    { path: 'README.md', language: 'markdown', content },
  ] });
  await page.goto('/chat/markdown-preview');
  const chat = page.locator('.message.assistant .markdown-content');
  await expect(chat.locator('.katex')).toHaveCount(1);
  await page.getByRole('button', { name: 'Conversation map', exact: true }).click();
  const minimap = page.locator('.conversation-minimap');
  await expect(minimap.locator('.markdown-compact').filter({ hasText: 'Price:' })).toContainText('Price: $20/month Plus a $6 fee. Formula: 2 + 2 = 4.');
  await expect(minimap.locator('.minimap-entry a, .minimap-entry button')).toHaveCount(0);
  await expect(minimap.locator('.markdown-compact').filter({ hasText: 'Price:' })).not.toContainText('**');
  const mapEntry = minimap.locator('.minimap-entry').filter({ hasText: 'Price:' });
  await expect(mapEntry).toHaveAccessibleName('assistant: Price: $20/month Plus a $6 fee. Formula: 2 + 2 = 4. https://example.com/docs，后面');
  expect(await mapEntry.getAttribute('title')).toBeNull();
  const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
  await panel.locator('.file-name').filter({ hasText: 'README.md' }).click();
  await panel.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = panel.locator('.markdown-preview .markdown-content');
  await expect(preview.locator('.katex')).toHaveCount(1);
  await expect(preview.getByRole('link', { name: 'https://example.com/docs' })).toHaveAttribute('href', 'https://example.com/docs');
  await expect(preview.locator('strong')).toHaveText('Price: $20/month');
});

test('raw-text blocks and executable URLs remain inert while later Markdown survives', async ({ page }) => {
  const content = 'Use a <textarea> here\nand a button\nplease\n\n<script>window.__markdownInjected=true</script>\n\n$20 <img src="x" onerror="window.__markdownInjected=true"> $6 [unsafe](javascript:alert(1))\n\n**safe end**';
  await installMockApi(page, { sessions: [mockSession('markdown-raw', 'Raw text', [{ role: 'user', content }])] });
  await page.goto('/chat/markdown-raw');
  const markdown = page.locator('.message.user .markdown-content');
  await expect(markdown.locator('strong')).toHaveText('safe end');
  await expect(markdown.locator('script, textarea, img, [onerror]')).toHaveCount(0);
  await expect(markdown.locator('p').filter({ hasText: 'Use a' }).locator('br')).toHaveCount(0);
  await expect(markdown.locator('.katex')).toHaveCount(0);
  expect(await page.evaluate(() => '__markdownInjected' in window)).toBe(false);
  await expect(markdown.getByRole('link')).toHaveCount(0);
});
