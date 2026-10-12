import { describe, expect, it } from 'vitest';
import { interactionEpochKey, interactionViewKey } from './interaction-scope.js';

describe('interaction view and run identity', () => {
  it('keeps cwd/session field boundaries when both can contain colons', () => {
    const a = { cwd: '/workspace:branch', sessionId: 'session' };
    const b = { cwd: '/workspace', sessionId: 'branch:session' };
    expect(`${a.cwd}:${a.sessionId}`).toBe(`${b.cwd}:${b.sessionId}`);
    expect(interactionViewKey('workspace', a.cwd, a.sessionId, 'route'))
      .not.toBe(interactionViewKey('workspace', b.cwd, b.sessionId, 'route'));
  });

  it('retires callbacks when workspace identity or route lifetime changes', () => {
    const view = interactionViewKey('first', '/workspace', 'session', 'route');
    expect(view).not.toBe(interactionViewKey('second', '/workspace', 'session', 'route'));
    expect(view).not.toBe(interactionViewKey('first', '/workspace', 'session', 'replacement'));
    expect(view).toBe(interactionViewKey('first', '/workspace', 'session', 'route'));
  });

  it('keeps view/run boundaries and absence distinct from string values', () => {
    expect('view:run' + ':' + 'id').toBe('view' + ':' + 'run:id');
    expect(interactionEpochKey('view:run', 'id')).not.toBe(interactionEpochKey('view', 'run:id'));
    expect(interactionEpochKey('view', undefined)).not.toBe(interactionEpochKey('view', ''));
    expect(interactionViewKey(undefined, '/workspace', undefined, 'route'))
      .not.toBe(interactionViewKey('', '/workspace', '', 'route'));
  });
});

it('binds every address field even when fallback route keys repeat', () => {
  const address = { pathname: '/chat/session', search: '?cwd=x', hash: '#a' };
  const key = interactionViewKey('workspace', '/workspace', 'session', 'default', address);
  for (const field of ['pathname', 'search', 'hash'] as const) {
    expect(interactionViewKey('workspace', '/workspace', 'session', 'default', { ...address, [field]: address[field] + ':changed' })).not.toBe(key);
  }
});

import { InteractionViewLifetime } from './interaction-scope.js';
describe('non-reusable view admission', () => {
  it('keeps repeated observations stable but retires address/key ABA', () => {
    const lifetime = new InteractionViewLifetime();
    const first = lifetime.enter('same-address-and-key');
    expect(lifetime.enter('same-address-and-key')).toBe(first);
    expect(lifetime.enter('other')).not.toBe(first);
    expect(lifetime.enter('same-address-and-key')).not.toBe(first);
  });
});
