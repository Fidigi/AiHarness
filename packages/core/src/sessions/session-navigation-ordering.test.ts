import { expect, it } from 'vitest';
import { SessionManager } from '@ai-harness/core';

for (const kind of ['custom_message', 'branch_summary'] as const) {
  it(`orders a ${kind} after its known root parent despite clock regression`, async () => {
    const manager = new SessionManager();
    const session = await manager.create({ messages: [{ id: 'future-root', role: 'user', content: 'Root',
      timestamp: new Date(Date.now() + 3_600_000) }] });
    if (kind === 'custom_message') {
      await manager.appendCustomEntry(session.id, 'state', { private: true });
      await manager.appendCustomMessage(session.id, 'notice', 'Useful context', { display: false });
    } else await manager.addBranchSummary(session.id, 'Useful context', 'Named');
    expect(manager.getEffectiveContext(session.id).map(entry => entry.type === 'message' ? entry.content : ''))
      .toEqual(['Root', kind === 'custom_message' ? '[Custom Message: notice]\nUseful context' : '[Branch Summary: Named]\nUseful context']);
  });
}
