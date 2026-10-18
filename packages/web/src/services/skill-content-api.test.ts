import { afterEach, expect, it, vi } from 'vitest';
import { setAuthToken } from './api';
import { getSkillContent } from './skill-content';
afterEach(() => { setAuthToken(''); vi.unstubAllGlobals(); });

it('fetches only the fixed authenticated same-origin endpoint; hostile href/identities remain encoded query data', async () => {
  const input = { key: 'global:__proto__:owned', cwd: '/tmp/[literal]/你好', projectId: 'workspace?#', href: 'https://invalid.example/doc.md?token=disposable', from: 'docs/100% notes.md' };
  const controller = new AbortController();
  const fetcher = vi.fn(async () => Response.json({ key: input.key, relativePath: 'SKILL.md', markdown: '# Public', fragment: 'public' }));
  vi.stubGlobal('fetch', fetcher); setAuthToken('disposable-skill-api-token');
  expect(await getSkillContent(input, controller.signal)).toMatchObject({ success: true, data: { key: input.key, markdown: '# Public' } });
  expect(fetcher).toHaveBeenCalledOnce();
  const [destination, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(destination.startsWith('/api/skills/content?')).toBe(true);
  const parsed = new URL(destination, 'https://same-origin.invalid');
  for (const [field, value] of Object.entries(input)) expect(parsed.searchParams.get(field)).toBe(value);
  expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin', signal: controller.signal, headers: { Authorization: 'Bearer disposable-skill-api-token' } });
});
it('forwards cancellation and reports it as failure without a fallback fetch', async () => {
  const controller = new AbortController(); controller.abort();
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => { expect(init.signal).toBe(controller.signal); throw new DOMException('Aborted', 'AbortError'); });
  vi.stubGlobal('fetch', fetcher);
  expect((await getSkillContent({ key: 'owned' }, controller.signal)).success).toBe(false); expect(fetcher).toHaveBeenCalledOnce();
});
it.each([null, [], { key: 'other', relativePath: 'SKILL.md', markdown: 'body' }, { key: 'owned', relativePath: 4, markdown: 'body' }, { key: 'owned', relativePath: 'SKILL.md', markdown: 4 }, { key: 'owned', relativePath: 'SKILL.md', markdown: 'body', fragment: true }])('refuses malformed or substituted response %#', async value => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(value)));
  expect((await getSkillContent({ key: 'owned' })).success).toBe(false);
});
it('keeps an explicit server refusal as failure without replaying or following a link', async () => {
  const fetcher = vi.fn(async () => Response.json({ error: 'Skill content is unavailable.', code: 'SKILL_CONTENT_UNAVAILABLE' }, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  expect(await getSkillContent({ key: 'owned', href: '../not-owned.md' })).toEqual({ success: false, error: 'Skill content is unavailable.' }); expect(fetcher).toHaveBeenCalledOnce();
});
