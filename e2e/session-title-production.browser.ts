import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
async function subscribedSession(page: Page, request: APIRequestContext) {
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, sidebarVisible: true, filesOpen: false, sound: false })));
  const { cwd } = JSON.parse(await readFile('.session-title-production.json', 'utf8')) as { cwd: string };
  const warmTitle = 'Bootstrap ' + test.info().testId;
  const initialTitle = 'Original ' + test.info().testId;
  const create = async (title: string) => {
    const reply = await request.post('http://127.0.0.1:3099/api/sessions', { data: { cwd, title } });
    expect(reply.status()).toBe(201); return await reply.json() as { id: string };
  };
  const warm = await create(warmTitle), session = await create(initialTitle);
  // Cold bootstrap may legitimately retire a pre-workspace stream. A rendered
  // real Sidebar row proves canonical workspace/session hydration has committed.
  await page.goto('/chat/' + warm.id + '?cwd=' + encodeURIComponent(cwd));
  const row = page.locator('.sidebar').getByText(initialTitle, { exact: true });
  await expect(row).toBeVisible();
  let connections = 0;
  page.on('request', request => { if (request.url().includes('/sessions/' + session.id + '/events')) connections++; });
  const connected = page.waitForResponse(response => response.status() === 200 && response.url().includes('/sessions/' + session.id + '/events'));
  await row.click(); await connected;
  await expect(page).toHaveURL(new RegExp('/chat/' + session.id));
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  expect(connections).toBe(1);
  return { session, warm, warmTitle, connections: () => connections };
}
test('real metadata producer retitles without retiring the live SSE subscription', async ({ page, request }, info) => {
  const { session, connections } = await subscribedSession(page, request);
  const address = page.url();
  const reply = await request.post('http://127.0.0.1:3099/api/agent/sessions/' + session.id + '/commands/metadata_retitle', { data: {} });
  expect(reply.status()).toBe(200);
  // No fabricated frames, stream holds, sleeps or fixture gate: this is the
  // original real command/context, metadata writer and compaction producer.
  await expect(page.getByText('Real canonical metadata title', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('REAL METADATA PRODUCER NOTICE', { exact: true })).toBeVisible();
  expect(page.url()).toBe(address);
  expect(connections()).toBe(1);
  await info.attach('metadata-subscription.json', { body: JSON.stringify({ session, connections: connections(), address }), contentType: 'application/json' });
});
test('real session navigation still retires the old subscription', async ({ page, request }) => {
  const { session, warm, warmTitle, connections } = await subscribedSession(page, request);
  const retired = page.waitForEvent('requestfailed', { predicate: request => request.url().includes('/sessions/' + session.id + '/events') });
  await page.locator('.sidebar').getByText(warmTitle, { exact: true }).click();
  await retired;
  await expect(page).toHaveURL(new RegExp('/chat/' + warm.id));
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  expect(connections()).toBe(1);
});
