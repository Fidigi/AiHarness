import { describe, expect, it } from 'vitest';
import { resolveKeybindingSource } from './keybinding-source.js';
const base = { cwd: '/work/project', home: '/home/operator', agentDir: '/home/operator/.ai-harness', agentDirTrusted: true, projectTrusted: false };
describe('documented literal keybinding source selection', () => {
  it('defaults to the independent trusted agent-directory file', () => {
    expect(resolveKeybindingSource(base)).toEqual({ path: '/home/operator/.ai-harness/keybindings.json', kind: 'agent-directory', eligible: true });
  });
  it.each(['', '   '])('uses the default for an empty override %j', explicitPath => {
    expect(resolveKeybindingSource({ ...base, explicitPath }).kind).toBe('agent-directory');
  });
  it('expands only the current home and preserves glob metacharacters literally', () => {
    expect(resolveKeybindingSource({ ...base, explicitPath: '~/a[1]/*.json' })).toEqual({ path: '/home/operator/a[1]/*.json', kind: 'environment', eligible: true });
  });
  it('resolves a relative explicit path from the startup working directory', () => {
    expect(resolveKeybindingSource({ ...base, explicitPath: '../operator.json' })).toEqual({ path: '/work/operator.json', kind: 'environment', eligible: true });
  });
  it('never reads an ineligible agent directory or a project-located override without trust', () => {
    expect(resolveKeybindingSource({ ...base, agentDirTrusted: false }).reason).toBe('agent-directory');
    expect(resolveKeybindingSource({ ...base, explicitPath: '.ai-harness/keybindings.json' }).reason).toBe('project-trust');
    expect(resolveKeybindingSource({ ...base, explicitPath: '/work/project-sibling/keys.json' }).eligible).toBe(true);
    expect(resolveKeybindingSource({ ...base, explicitPath: '/work/project/keys.json', projectTrusted: true }).eligible).toBe(true);
  });
  it.each(['bad\nname', 'bad\u0000name', 'x'.repeat(32_769)])('refuses invalid path data without echoing it', explicitPath => {
    expect(resolveKeybindingSource({ ...base, explicitPath })).toEqual({ kind: 'environment', eligible: false, reason: 'path' });
  });
});
