import { expect, it, vi } from 'vitest';
import { SessionManager } from '@ai-harness/core';

async function fixture(content: string) {
  const manager = new SessionManager();
  const session = await manager.create();
  await manager.addMessage(session.id, { role: 'user', content: 'Common' });
  const target = session.activeLeafId!;
  await manager.addMessage(session.id, { role: 'assistant', content });
  return { manager, session, target, source: session.activeLeafId! };
}

it('does not undercount multi-byte transcripts as one token per four UTF-16 characters', async () => {
  const f = await fixture('界'.repeat(700));
  const summarizer = vi.fn(async () => ({ summary: 'Summary' }));
  await expect(f.manager.navigateTree(f.session.id, f.target, { summarize: true, summarizer,
    contextWindow: 2_048, reserveTokens: 512 })).rejects.toThrow('Branch summary has no content within the token budget.');
  expect(summarizer).not.toHaveBeenCalled();
  expect(f.session.activeLeafId).toBe(f.source);
  expect(await f.manager.getBranchSummaries(f.session.id)).toEqual([]);
});

it('keeps only whole recent entries within the conservative serialized input budget', async () => {
  const f = await fixture('X'.repeat(2_000));
  await f.manager.addMessage(f.session.id, { role: 'user', content: 'Recent useful outcome' });
  const result = await f.manager.navigateTree(f.session.id, f.target, { summarize: true,
    contextWindow: 2_048, reserveTokens: 512, summarizer: async request => {
      expect(request.entries).toHaveLength(1);
      expect(request.entries[0]).toMatchObject({ type: 'message', content: 'Recent useful outcome' });
      expect(Buffer.byteLength(request.messages[0].content)).toBeLessThanOrEqual(2_048 - 512);
      return { summary: 'Recent summary' };
    } });
  expect(result.status).toBe('navigated');
});

it('rejects generated output beyond the admitted byte reserve before publishing navigation', async () => {
  const f = await fixture('Abandoned');
  const summarizer = vi.fn(async () => ({ summary: 'X'.repeat(16_385) }));
  await expect(f.manager.navigateTree(f.session.id, f.target, { summarize: true, summarizer }))
    .rejects.toThrow('Branch summary result is invalid.');
  expect(summarizer).toHaveBeenCalledOnce();
  expect(f.session.activeLeafId).toBe(f.source);
  expect(await f.manager.getBranchSummaries(f.session.id)).toEqual([]);
});
