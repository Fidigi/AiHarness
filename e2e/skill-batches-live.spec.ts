import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// Actual Vite -> Express -> Core discovery/publication. No intercepted API.
test('real filtered skill groups publish Markdown, preserve hidden files and continue after an invalid sibling', async ({ page }) => {
  const cwd = await mkdtemp(path.join(process.cwd(), 'e2e', '.skill-batch-live-'));
  const file = (name: string) => path.join(cwd, '.agents', 'skills', name, 'SKILL.md');
  const source = (name: string, disabled = false) => `---\nname: ${name}\ndescription: Live skill ${name}\n# preserved\ndisable-model-invocation: ${disabled}\n---\n\nLiteral live body ${name}\n`;
  try {
    for (const name of ['visible-on', 'visible-off', 'hidden']) {
      await mkdir(path.dirname(file(name)), { recursive: true });
      await writeFile(file(name), source(name, name === 'visible-off'));
    }
    expect((await page.request.post('/api/workspaces/trust', { data: { cwd, confirm: true } })).status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    await page.goto(`/?cwd=${encodeURIComponent(cwd)}`);
    await expect(page.locator('.workspace-button')).toHaveAttribute('title', cwd);
    await page.getByRole('button', { name: 'Settings', exact: false }).click();
    const skills = page.locator('#skills');
    await skills.getByRole('searchbox').fill('visible');
    const group = skills.locator('fieldset[data-scope="project"]');
    const on = group.getByRole('checkbox', { name: 'Allow visible-on for autonomous model invocation' });
    const off = group.getByRole('checkbox', { name: 'Allow visible-off for autonomous model invocation' });
    await expect(on).toBeChecked(); await expect(off).not.toBeChecked();
    const disableResponse = page.waitForResponse(response => response.url().includes('/api/skills/enabled/batch'));
    await group.getByRole('button', { name: 'Disable displayed', exact: true }).click();
    const disabled = await disableResponse;
    expect(disabled.status()).toBe(200);
    expect((await disabled.json()).outcomes).toMatchObject([{ status: 'changed', enabled: false }]);
    await expect(on).not.toBeChecked();
    expect(await readFile(file('visible-on'), 'utf8')).toBe(source('visible-on', true));
    expect(await readFile(file('hidden'), 'utf8')).toBe(source('hidden'));
    const invalid = '---\nname: visible-off\nname: duplicate\n---\nInvalid sibling body\n';
    await writeFile(file('visible-off'), invalid);
    const enableResponse = page.waitForResponse(response => response.url().includes('/api/skills/enabled/batch'));
    await group.getByRole('button', { name: 'Enable displayed', exact: true }).click();
    const enabled = await enableResponse;
    expect(enabled.status()).toBe(200);
    expect((await enabled.json()).outcomes.map((outcome: { status: string }) => outcome.status)).toEqual(['failed', 'changed']);
    await expect(on).toBeChecked();
    await expect(skills.getByRole('list', { name: 'Batch outcomes' })).toContainText('visible-on: changed');
    expect(await readFile(file('visible-off'), 'utf8')).toBe(invalid);
    expect(await readFile(file('visible-on'), 'utf8')).toBe(source('visible-on'));
    expect(await readFile(file('hidden'), 'utf8')).toBe(source('hidden'));
    await page.reload();
    await expect(skills.getByRole('checkbox', { name: 'Allow visible-on for autonomous model invocation' })).toBeChecked();
    await expect(skills.getByRole('checkbox', { name: 'Allow hidden for autonomous model invocation' })).toBeChecked();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
