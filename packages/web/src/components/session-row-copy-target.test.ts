import { describe, expect, it } from 'vitest';
import type { WorkspaceDescriptor } from '@ai-harness/core';
import { captureDisplayedSessionCopyTarget } from './session-row-copy-target';

const workspace = () => ({ id: 'workspace-id', cwd: '/workspace', trusted: false } as WorkspaceDescriptor);
const source = () => ({ id: 'saved-source', activeLeafId: 'custom:displayed', cwd: '/workspace', metadata: {} });

describe('captured displayed session/workspace/journal identity', () => {
  it('captures explicit canonical entry, including in an untrusted workspace without granting trust', () => {
    const view = workspace(), item = source();
    expect(captureDisplayedSessionCopyTarget(item, view)).toEqual({ sessionId: item.id, entryId: 'custom:displayed', cwd: '/workspace', workspaceId: view.id });
    expect(view.trusted).toBe(false);
  });
  it.each(['unavailable', 'draft', 'child', 'no-leaf', 'no-cwd', 'other-cwd'] as const)('refuses%s, never substitutes current workspace or a later message', kind => {
    const item = { ...source(), draft: false, activeLeafId: source().activeLeafId as string | undefined, cwd: source().cwd as string | undefined, metadata: {} as Record<string, unknown> };
    if (kind === 'draft') item.draft = true;
    if (kind === 'child') item.metadata.subagent = true;
    if (kind === 'no-leaf') item.activeLeafId = undefined;
    if (kind === 'no-cwd') item.cwd = undefined;
    if (kind === 'other-cwd') item.cwd = '/other';
    expect(captureDisplayedSessionCopyTarget(item, workspace(), kind === 'unavailable')).toBeNull();
  });
  it('owns immutable primitives before callers change source leaf/project state', () => {
    const item = source(), view = workspace(), target = captureDisplayedSessionCopyTarget(item, view)!;
    item.activeLeafId = 'later'; item.cwd = '/later'; view.id = 'other'; view.cwd = '/other';
    expect(Object.isFrozen(target)).toBe(true);
    expect(target).toEqual({ sessionId: 'saved-source', entryId: 'custom:displayed', cwd: '/workspace', workspaceId: 'workspace-id' });
  });
  it('uses only canonical child metadata, never a child-looking ID', () => {
    expect(captureDisplayedSessionCopyTarget({ ...source(), id: 'child-looking-id' }, workspace())).not.toBeNull();
  });
  it('does not invent a leaf from available message/history data', () => {
    const item = { ...source(), activeLeafId: undefined, messages: [{ id: 'last-message' }] };
    expect(captureDisplayedSessionCopyTarget(item, workspace())).toBeNull();
    expect(captureDisplayedSessionCopyTarget(source(), null)).toBeNull();
  });
});
