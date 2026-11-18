import { SessionManager } from '@ai-harness/core';
import { expect, it, vi } from 'vitest';
import { cliCacheNotices } from './cache-notices.js';

it('omits optional notices on unavailable ancestry without guessing from raw history', async () => {
  const manager = new SessionManager();
  const session = await manager.create({ cwd: process.cwd() });
  vi.spyOn(manager, 'getActiveBranchEntries').mockRejectedValue(new Error('Session ancestry is incomplete.'));
  const raw = vi.spyOn(manager, 'getRawEntries');
  expect(await cliCacheNotices(manager, session.id)).toEqual([]);
  expect(raw).not.toHaveBeenCalled();
});
