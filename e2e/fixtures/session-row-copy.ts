import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';
import { expect, type Page } from './test-budget';

export const action = /^(Copy through displayed entry|Copier jusqu’à l’entrée affichée)$/;
export const menuName = /^(Conversation actions|Actions de conversation)$/;
export async function openNavigation(page: Page) {
  const toggle = page.getByRole('button', { name: /^(Toggle navigation|Afficher ou masquer la navigation)$/ });
  if (page.viewportSize()!.width < 960 && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(page.locator('.workspace-button')).toBeVisible();
}
async function nativeStore(probe: { id: string; cwd: string }) {
  // Observe the actual canonical Server data directory through the API-created
  // probe's native saved journal, never a supplied or fabricated storage DTO.
  const candidates = (await readdir(os.tmpdir())).filter(name => name.startsWith('aiharness-playwright-'));
  expect(candidates.length).toBeLessThanOrEqual(8);
  const found: JsonlSessionStore[] = [];
  for (const name of candidates) {
    const directory = path.join(os.tmpdir(), name, 'sessions');
    try { await access(path.join(directory, probe.id + '.jsonl')); } catch { continue; }
    const store = new JsonlSessionStore(directory), snapshot = await store.getSessionSnapshot(probe.id);
    if (snapshot?.session.id === probe.id && snapshot.session.cwd === probe.cwd) found.push(store);
  }
  expect(found).toHaveLength(1); return found[0]!;
}
export async function fixture(page: Page, locale = 'en', theme = 'light', width = 1440, fixedPresentationTime = false) {
  const cwd = await mkdtemp(path.join(process.cwd(), 'e2e', '.row-copy-live-'));
  expect((await page.request.post('/api/workspaces/trust', { data: { cwd, confirm: true } })).status()).toBe(200);
  const response = await page.request.post('/api/sessions', { data: { cwd, title: 'ROW_VIEW' } }); expect(response.status()).toBe(201);
  const probe = await response.json() as { id: string; cwd: string; workspaceId: string };
  const appended = await page.request.post(`/api/sessions/${probe.id}/messages`, { data: { role: 'user', content: 'ROW_VIEW_BODY' } });
  expect(appended.status()).toBe(201); const viewEntry = await appended.json() as { id: string };
  expect(typeof viewEntry.id).toBe('string'); expect(viewEntry.id).not.toBe('');
  const store = await nativeStore(probe), writer = new SessionManager({ store });
  const source = await writer.create({ title: 'ROW_TARGET', cwd, workspaceId: probe.workspaceId });
  await writer.addMessage(source.id, { role: 'user', content: 'ROW_FIRST_BODY' });
  const entry = await writer.appendCustomEntry(source.id, 'row-copy:state', { publicMarker: 'ROW_CUSTOM_BODY' });
  await writer.addMessage(source.id, { role: 'assistant', content: 'ROW_LATER_BODY' });
  expect(await writer.navigateTree(source.id, entry!.id)).toMatchObject({ status: 'navigated', entryId: entry!.id });
  expect(source.activeLeafId).toBe(entry!.id);
  // Explicit fixture admission is not evidence copy itself loads no runtime.
  expect((await page.request.get(`/api/sessions/${source.id}`)).status()).toBe(200);
  const file = store.getSessionFilePath(source.id)!, bytes = await readFile(file);
  let presentationTime: number | undefined;
  if (fixedPresentationTime) {
    // Only the four new visual journeys fix Date from their native saved data.
    // Timers/performance keep running; Server/store time and all other cases stay real.
    const view = await store.getSessionSnapshot(probe.id); expect(view).not.toBeNull();
    presentationTime = Math.max(source.updatedAt.getTime(), view!.session.updatedAt.getTime());
    expect(Number.isFinite(presentationTime)).toBe(true);
    await page.clock.setFixedTime(new Date(presentationTime));
  }
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem('ai-harness-locale', locale);
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme, filesOpen: false, sidebarVisible: true }));
  }, { locale, theme });
  await page.goto(`/chat/${probe.id}?cwd=${encodeURIComponent(cwd)}&token=MUST_NOT_COPY#${encodeURIComponent(viewEntry.id)}`);
  await expect(page.getByRole('log')).toContainText('ROW_VIEW_BODY'); await openNavigation(page);
  const row = page.locator('.sidebar-nav .session-row').filter({ has: page.locator('a.session-main', { hasText: 'ROW_TARGET' }) });
  await expect(row).toHaveCount(1);
  const mutations: Array<{ pathname: string; body: unknown }> = [], quota: string[] = [];
  const record = (request: { method(): string; url(): string; postDataJSON(): unknown }) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && pathname.startsWith('/api/') && pathname !== '/api/workspaces/validate') mutations.push({ pathname, body: request.postDataJSON() });
  };
  const refused = (response: { status(): number; url(): string }) => { if (response.status() === 429 && new URL(response.url()).pathname.startsWith('/api/')) quota.push(response.url()); };
  page.context().on('request', record); page.context().on('response', refused);
  return { cwd, source, probe, store, writer, target: entry!.id, file, bytes, row, mutations, quota, presentationTime,
    async cleanup(extraCwds: string[] = []) {
      page.context().off('request', record); page.context().off('response', refused);
      for (const directory of [cwd, ...extraCwds]) {
        const list = await page.request.get(`/api/sessions?cwd=${encodeURIComponent(directory)}`);
        if (list.ok()) for (const session of await list.json() as Array<{ id: string }>) await page.request.delete(`/api/sessions/${session.id}`);
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
export async function openMenu(f: Awaited<ReturnType<typeof fixture>>, page: Page) {
  await f.row.getByRole('link', { name: /ROW_TARGET/ }).first().focus();
  const invoker = f.row.getByRole('button', { name: menuName }); await invoker.focus(); await page.keyboard.press('Enter');
  const item = page.getByRole('menuitem', { name: action }); await expect(item).toBeVisible();
  expect(await item.evaluate(element => ({ inSidebar: Boolean(element.closest('.sidebar')), inActions: Boolean(element.closest('.session-actions')) })))
    .toEqual({ inSidebar: true, inActions: false });
  return { invoker, item };
}
export async function assertCopy(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const copy = await f.store.getSessionSnapshot(id); expect(copy).not.toBeNull();
  expect(copy!.session).toMatchObject({ title: 'ROW_TARGET (clone)', cwd: f.cwd, workspaceId: f.probe.workspaceId,
    metadata: { clonedFromSessionId: f.source.id, clonedFromEntryId: f.target } });
  expect(copy!.session.parentId).toBeUndefined(); expect(copy!.session.branchId).toBeUndefined();
  const entries = copy!.entries.filter(entry => entry.type !== 'metadata');
  expect(entries.map(entry => entry.type)).toEqual(['message', 'custom']);
  expect(entries.at(-1)).toMatchObject({ type: 'custom', data: { publicMarker: 'ROW_CUSTOM_BODY' } });
  expect(copy!.session.activeLeafId).toBe(entries.at(-1)!.id); expect(copy!.session.activeLeafId).not.toBe(f.target);
  expect(JSON.stringify(copy)).not.toContain('ROW_LATER_BODY');
}
