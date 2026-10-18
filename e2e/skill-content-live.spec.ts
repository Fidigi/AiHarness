import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from './fixtures/test-budget';

async function fixture(page: Page, locale = 'en', theme = 'dark') {
  const cwd = await mkdtemp(path.join(process.cwd(), 'e2e', '.skill-content-live-'));
  const directory = path.join(cwd, '.agents', 'skills', 'review-guide'), file = path.join(directory, 'SKILL.md');
  const body = '# Main instructions\n[Guide](docs/guide.md#details) · [Local anchor](#tail) · [External](https://invalid.example/reference.md)\n\n'
    + Array.from({ length: 30 }, (_, i) => `Full paragraph ${i}: these instructions must not be replaced by catalogue metadata.\n\n`).join('')
    + '## Tail\nFULL_INSTRUCTION_TAIL\n';
  const source = `---\nname: review-guide\ndescription: Metadata only\ndisable-model-invocation: true\n---\n${body}`;
  await mkdir(path.join(directory, 'docs'), { recursive: true }); await writeFile(file, source);
  await writeFile(path.join(directory, 'docs', 'guide.md'), '# Referenced guide\n## Details\nNESTED_MARKDOWN_BODY\n[Back](../SKILL.md) · [Bad traversal](../../../outside.md) · [Executable](file:///etc/passwd)\n\n<script>globalThis.SKILL_EXECUTED = true</script>\n');
  const alternate = path.join(cwd, '.agents', 'skills', 'alternate', 'SKILL.md'); await mkdir(path.dirname(alternate), { recursive: true });
  await writeFile(alternate, '---\nname: alternate\ndescription: Other source\ndisable-model-invocation: true\n---\n# Alternate instructions\nALTERNATE_SOURCE_ONLY\n');
  expect((await page.request.post('/api/workspaces/trust', { data: { cwd, confirm: true } })).status()).toBe(200);
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem('ai-harness-locale', locale);
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme, lastSettingsSection: 'skills' }));
  }, { locale, theme });
  await page.goto(`/settings?cwd=${encodeURIComponent(cwd)}#skills`);
  const skills = page.locator('#skills');
  await expect(skills.locator('fieldset[data-scope="project"]')).toContainText('review-guide');
  return { cwd, file, source, skills, trigger: skills.getByRole('button', { name: /^(Read instructions for|Lire les instructions de) review-guide$/ }), pane: page.locator('#skill-content-detail') };
}

for (const locale of ['en', 'fr']) for (const scenario of [
  { name: 'desktop-light', width: 1440, theme: 'light' },
  { name: 'desktop-dark', width: 1440, theme: 'dark' },
  { name: 'mobile-light', width: 390, theme: 'light' },
  { name: 'mobile-dark', width: 390, theme: 'dark' },
]) {
  test(`${locale} ${scenario.name}: actual skill instructions and confined references never navigate or activate resources`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 1000 });
    const f = await fixture(page, locale, scenario.theme);
    try {
      const currentUrl = page.url(), reads: string[] = [], mutations: string[] = [];
      let mainNavigations = 0;
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) mainNavigations++; });
      page.on('request', request => {
        if (request.url().includes('/api/skills/content?')) reads.push(request.url());
        if (request.method() !== 'GET' && /\/api\/(?:skills|agent|chat|mcp|commands|terminals|plugins)/u.test(request.url())) mutations.push(request.url());
      });
      const checkbox = f.skills.getByRole('checkbox', { name: /review-guide/ }); await expect(checkbox).not.toBeChecked();
      await f.trigger.focus(); await page.keyboard.press('Enter');
      await expect(f.pane.getByRole('heading', { name: 'Main instructions', exact: true })).toBeVisible();
      await expect(f.pane).toContainText('FULL_INSTRUCTION_TAIL');
      await expect(f.trigger).toHaveAttribute('aria-expanded', 'true');
      const count = reads.length;
      await f.pane.getByRole('button', { name: 'Local anchor', exact: true }).click();
      expect(reads.length).toBe(count); expect(page.url()).toBe(currentUrl);
      await expect(f.pane.getByRole('link', { name: 'External', exact: true })).toHaveAttribute('target', '_blank');
      await expect(f.pane.getByRole('link', { name: 'External', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
      await f.pane.getByRole('button', { name: 'Guide', exact: true }).click();
      await expect(f.pane.getByRole('heading', { name: 'Referenced guide', exact: true })).toBeVisible(); await expect(f.pane).toContainText('NESTED_MARKDOWN_BODY');
      expect(await page.evaluate(() => Reflect.get(window, 'SKILL_EXECUTED'))).toBeUndefined();
      await f.pane.getByRole('button', { name: 'Bad traversal', exact: true }).click();
      await expect(f.pane.getByRole('alert')).toHaveText(locale === 'en' ? 'Skill content is unavailable or not permitted.' : 'Le contenu du skill est indisponible ou non autorisé.');
      await expect(f.pane).toContainText('NESTED_MARKDOWN_BODY');
      await f.pane.getByRole('button', { name: 'Executable', exact: true }).click(); await expect(f.pane.getByRole('alert')).toBeVisible();
      await f.pane.getByRole('button', { name: 'Back', exact: true }).click(); await expect(f.pane).toContainText('FULL_INSTRUCTION_TAIL');
      await expect(checkbox).not.toBeChecked(); expect(await readFile(f.file, 'utf8')).toBe(f.source);
      expect(page.url()).toBe(currentUrl); expect(mainNavigations).toBe(0); expect(mutations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      const accessibility = await new AxeBuilder({ page }).include('#skill-content-detail').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(accessibility.violations).toEqual([]);
      await f.pane.getByRole('button', { name: locale === 'en' ? 'Close' : 'Fermer', exact: true }).click(); await expect(f.pane).toHaveCount(0); await expect(f.trigger).toBeFocused();
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });
}

for (const retirement of ['close', 'source', 'workspace'] as const) {
  test(`actual body with controlled transport delay cannot resurrect a retired ${retirement} detail`, async ({ page }) => {
    const f = await fixture(page);
    let release!: () => void, held!: () => void, delivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { held = resolve; });
    const finished = new Promise<void>(resolve => { delivered = resolve; });
    // Only response timing is injected: the Server receives the real request,
    // enforces authorization and returns its own unmodified body/status.
    await page.route('**/api/skills/content?**', async route => {
      if (new URL(route.request().url()).searchParams.get('href') !== 'docs/guide.md#details') { await route.continue(); return; }
      const actual = await route.fetch(); expect(actual.status()).toBe(200); expect(await actual.text()).toContain('NESTED_MARKDOWN_BODY');
      held(); await gate;
      try { await route.fulfill({ response: actual }); }
      catch (error) { if (route.request().failure()?.errorText !== 'net::ERR_ABORTED') throw error; }
      finally { delivered(); }
    });
    try {
      await f.trigger.click(); await expect(f.pane).toContainText('FULL_INSTRUCTION_TAIL');
      await f.pane.getByRole('button', { name: 'Guide', exact: true }).click(); await reached;
      if (retirement === 'source') {
        await f.skills.getByRole('button', { name: 'Read instructions for alternate', exact: true }).click(); await expect(f.pane).toContainText('ALTERNATE_SOURCE_ONLY');
      } else if (retirement === 'close') {
        await f.pane.getByRole('button', { name: 'Close', exact: true }).click(); await expect(f.pane).toHaveCount(0);
      } else {
        const next = path.join(f.cwd, 'next'); await mkdir(next); await mkdir(path.join(next, 'workspace-marker'));
        await page.locator('.workspace-button').click(); const picker = page.locator('.directory-picker');
        // Wait for the actual opening browse, then use its owned child action;
        // never race a typed path against that still-pending initial response.
        await expect(picker.getByRole('button', { name: '📁 next', exact: true })).toBeVisible();
        await picker.getByRole('button', { name: '📁 next', exact: true }).click();
        await expect(picker.getByRole('button', { name: '📁 workspace-marker', exact: true })).toBeVisible();
        await picker.getByRole('button', { name: 'Use this workspace', exact: true }).click(); await expect(f.pane).toHaveCount(0);
      }
      release(); await finished;
      if (retirement === 'source') { await expect(f.pane).toContainText('ALTERNATE_SOURCE_ONLY'); await expect(f.pane).not.toContainText('NESTED_MARKDOWN_BODY'); }
      else await expect(f.pane).toHaveCount(0);
      expect(await readFile(f.file, 'utf8')).toBe(f.source);
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await rm(f.cwd, { recursive: true, force: true }); }
  });
}

test('real skill labels still own their checkbox while the peer instructions action stays read-only', async ({ page }) => {
  const f = await fixture(page);
  const writes: Array<{ changes: Array<{ enabled: boolean }> }> = [];
  page.on('request', request => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/skills/enabled/batch') writes.push(request.postDataJSON());
  });
  try {
    const label = f.skills.locator('label').filter({ hasText: 'Metadata only' });
    const checkbox = label.getByRole('checkbox', { name: /review-guide/ });
    await expect(checkbox).not.toBeChecked();
    expect(await checkbox.evaluate(element => (element as HTMLInputElement).labels?.length)).toBe(1);
    await expect(label.locator('button')).toHaveCount(0);
    await f.trigger.click(); await expect(f.pane).toContainText('FULL_INSTRUCTION_TAIL');
    await expect(checkbox).not.toBeChecked(); expect(writes).toEqual([]); expect(await readFile(f.file, 'utf8')).toBe(f.source);
    await f.pane.getByRole('button', { name: 'Close', exact: true }).click(); await expect(f.trigger).toBeFocused();
    await label.getByText('Metadata only', { exact: true }).click();
    await expect(checkbox).toBeChecked(); await expect(checkbox).toBeEnabled();
    expect(writes.map(body => body.changes.map(change => change.enabled))).toEqual([[true]]);
    await label.getByText('Metadata only', { exact: true }).click();
    await expect(checkbox).not.toBeChecked(); await expect(checkbox).toBeEnabled();
    expect(writes.map(body => body.changes.map(change => change.enabled))).toEqual([[true], [false]]);
    expect(await readFile(f.file, 'utf8')).toBe(f.source);
  } finally { await rm(f.cwd, { recursive: true, force: true }); }
});
