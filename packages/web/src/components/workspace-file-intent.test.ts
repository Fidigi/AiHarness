import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceFile } from './workspace-file-intent';

function fixture() {
  const events: CustomEvent[] = [];
  const tasks: (() => void)[] = [];
  const location = { href: 'http://localhost/chat/source?cwd=%2Fworkspace' };
  const origin = { isConnected: true };
  vi.stubGlobal('window', {
    location,
    dispatchEvent(event: CustomEvent) { events.push(event); return true; },
    setTimeout(task: () => void) { tasks.push(task); return 1; },
  });
  return { events, tasks, location, origin };
}

afterEach(() => vi.unstubAllGlobals());
describe('origin-owned delayed file intent', () => {
  it('shows the pane before delivering the unchanged file reference on the next task', () => {
    const f = fixture();
    openWorkspaceFile('src/app.ts#L2', f.origin as Element);
    expect(f.events.map(event => event.type)).toEqual(['aih-show-files']);
    expect(f.tasks).toHaveLength(1);
    f.tasks[0]();
    expect(f.events.map(event => event.type)).toEqual(['aih-show-files', 'aih-open-file']);
    expect(f.events[1].detail).toBe('src/app.ts#L2');
  });
  it('does not publish a source-link task into a different navigation address', () => {
    const f = fixture();
    openWorkspaceFile('src/app.ts#L2', f.origin as Element);
    f.location.href = 'http://localhost/chat/other?cwd=%2Fworkspace';
    f.tasks[0]();
    expect(f.events.map(event => event.type)).toEqual(['aih-show-files']);
  });
  it('does not publish after the originating link leaves the rendered view', () => {
    const f = fixture();
    openWorkspaceFile('src/app.ts#L2', f.origin as Element);
    f.origin.isConnected = false;
    f.tasks[0]();
    expect(f.events.map(event => event.type)).toEqual(['aih-show-files']);
  });
});
