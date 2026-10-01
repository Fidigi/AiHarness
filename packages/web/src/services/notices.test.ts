import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearNotices,
  dismissNotice,
  getNoticesSnapshot,
  publishNotice,
  subscribeNotices,
} from './notices';

afterEach(() => {
  clearNotices();
  vi.restoreAllMocks();
});

describe('status notice store', () => {
  it('updates a stable notice and clamps progress without duplicating it', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
    const id = publishNotice('Preparing', { level: 'info', progress: -1 });
    publishNotice('Ready', { id, level: 'success', progress: 2, timeoutMs: 0 });

    expect(getNoticesSnapshot()).toEqual([expect.objectContaining({
      id: '00000000-0000-4000-8000-000000000000', message: 'Ready', level: 'success', progress: 1, timeoutMs: 0,
    })]);
  });

  it('notifies subscribers, supports dismissal, and remains bounded', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotices(listener);
    for (let index = 0; index < 25; index++) publishNotice(`Notice ${index}`);
    expect(getNoticesSnapshot()).toHaveLength(20);
    const id = getNoticesSnapshot()[0]!.id;
    dismissNotice(id);
    expect(getNoticesSnapshot()).toHaveLength(19);
    expect(listener).toHaveBeenCalledTimes(26);
    unsubscribe();
  });
});
