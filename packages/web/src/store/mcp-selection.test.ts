import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerInventoryEntry } from '@ai-harness/core';
import { readMcpSelection, selectedMcpServer, writeMcpSelection } from './mcp-selection.js';

const key = 'ai-harness-mcp-selection-v1';
const values = new Map<string, string>();
const global = { scope: 'global', name: 'shared' } as const;
const project = { scope: 'project', name: 'shared' } as const;
const row = (scope: 'global' | 'project', name: string): McpServerInventoryEntry => ({
  scope, name, sourcePath: '/redacted/mcp.json', configKey: 'new-revision', valid: true,
  enabled: true, exposure: 'direct', envNames: [], headerNames: [], commandFields: [],
  variableReferences: [], masked: true, shadowedByProject: false, replacesGlobal: false, problems: [],
});

beforeEach(() => {
  values.clear();
  vi.stubGlobal('window', { localStorage: {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('bounded MCP detail selection', () => {
  it('separates no-project, project cwd and scope/name identities', () => {
    writeMcpSelection(undefined, global);
    writeMcpSelection('/one', project);
    writeMcpSelection('/two', global);
    expect(readMcpSelection()).toEqual(global);
    expect(readMcpSelection('/one')).toEqual(project);
    expect(readMcpSelection('/two')).toEqual(global);
    expect(readMcpSelection('/unknown')).toBeUndefined();
    writeMcpSelection('/one', global);
    expect(readMcpSelection('/one')).toEqual(global);
    expect(JSON.parse(values.get(key)!).entries).toHaveLength(3);
  });

  it('stores only literal selector metadata, not caller inventory or OAuth data', () => {
    const source = { ...row('global', 'docs'), url: 'https://private-target',
      token: 'private-token', testStatus: { error: 'private-report' } };
    writeMcpSelection('/one', source);
    expect(JSON.parse(values.get(key)!)).toEqual({ version: 1, entries: [
      { cwd: '/one', scope: 'global', name: 'docs' },
    ] });
    source.name = 'changed';
    const selection = readMcpSelection('/one')!;
    selection.name = 'changed again';
    expect(readMcpSelection('/one')).toEqual({ scope: 'global', name: 'docs' });
  });

  it.each(['__proto__', 'constructor', 'toString', 'global\u0000shared', 'a/b', 'global'])('keeps %s literal', name => {
    writeMcpSelection('/one', { scope: 'project', name });
    expect(readMcpSelection('/one')).toEqual({ scope: 'project', name });
    expect(readMcpSelection()).toBeUndefined();
  });

  it('persists bounded escaped invalid-row labels as presentation metadata', () => {
    const name = `${'\\u0000'.repeat(256)}…`;
    writeMcpSelection('/one', { scope: 'global', name });
    expect(readMcpSelection('/one')).toEqual({ scope: 'global', name });
  });

  it('persists bounded non-BMP escaped diagnostic labels', () => {
    const name = `${'\\u{e007f}'.repeat(256)}…`;
    writeMcpSelection('/one', { scope: 'global', name });
    expect(readMcpSelection('/one')).toEqual({ scope: 'global', name });
  });

  it.each(['{bad', 'null', '[]', 'true', '{"version":2,"entries":[]}',
    '{"version":1,"entries":{}}', ' '.repeat(65_537)])('ignores malformed/unsupported state %#', text => {
    values.set(key, text);
    expect(readMcpSelection()).toBeUndefined();
  });

  it('filters invalid entries and strips unknown cached fields on the next write', () => {
    values.set(key, JSON.stringify({ version: 1, entries: [null, 1, {},
      { cwd: null, scope: 'global', name: 'ok', token: 'must-not-survive' },
      { cwd: '', ...project }, { cwd: '/one', scope: 'unknown', name: 'bad' },
      { cwd: '/one', scope: 'project', name: '' }, { cwd: '/one', scope: 'project', name: 'x'.repeat(4_097) },
    ] }));
    expect(readMcpSelection()).toEqual({ scope: 'global', name: 'ok' });
    writeMcpSelection('/two', project);
    expect(values.get(key)).not.toContain('must-not-survive');
    expect(JSON.parse(values.get(key)!).entries).toHaveLength(2);
  });

  it('bounds recent contexts and refreshes an explicitly revisited context', () => {
    for (let index = 0; index < 24; index++) writeMcpSelection(`/project-${index}`, global);
    writeMcpSelection('/project-0', project);
    writeMcpSelection('/new', global);
    expect(readMcpSelection('/project-0')).toEqual(project);
    expect(readMcpSelection('/project-1')).toBeUndefined();
    expect(JSON.parse(values.get(key)!).entries).toHaveLength(24);
  });

  it('bounds encoded document size independently of entry count', () => {
    for (let index = 0; index < 24; index++) writeMcpSelection(`/${index}${'a'.repeat(8_000)}`, global);
    expect(values.get(key)!.length).toBeLessThanOrEqual(65_536);
    expect(readMcpSelection(`/23${'a'.repeat(8_000)}`)).toEqual(global);
    expect(readMcpSelection(`/0${'a'.repeat(8_000)}`)).toBeUndefined();
    values.set(key, JSON.stringify({ version: 1, entries: Array.from({ length: 25 }, () => ({ cwd: null, ...global })) }));
    expect(readMcpSelection()).toBeUndefined();
  });

  it('survives denied reads and denied writes without inventing cached state', () => {
    vi.stubGlobal('window', { localStorage: {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('full'); },
    } });
    expect(readMcpSelection('/one')).toBeUndefined();
    expect(() => writeMcpSelection('/one', project)).not.toThrow();
  });

  it('rejects invalid write selectors rather than clobbering another context', () => {
    writeMcpSelection('/one', project);
    const saved = values.get(key);
    writeMcpSelection('', global);
    writeMcpSelection('x'.repeat(8_193), global);
    writeMcpSelection('/one', { scope: 'global', name: '' });
    writeMcpSelection('/one', { scope: 'global', name: 'x'.repeat(4_097) });
    expect(values.get(key)).toBe(saved);
  });

  it('disambiguates explicit fresh rows without persisting a revision or borrowing stale pins', () => {
    const first = { ...row('project', 'shared'), configKey: 'first' };
    const second = { ...row('project', 'shared'), configKey: 'second' };
    expect(selectedMcpServer([first, second], project)).toBeUndefined();
    expect(selectedMcpServer([first, second], project, 'second')).toBe(second);
    expect(selectedMcpServer([first, second], project, 'obsolete')).toBeUndefined();
    expect(selectedMcpServer([first, first], project, 'first')).toBeUndefined();
    expect(selectedMcpServer([second], project, 'obsolete')).toBe(second);
    writeMcpSelection('/one', second);
    expect(readMcpSelection('/one')).toEqual(project);
    expect(values.get(key)).not.toContain('configKey');
  });

  it('restores only a fresh exact row and never borrows the same-name other scope', () => {
    const rows = [row('global', 'shared'), row('project', 'shared')];
    expect(selectedMcpServer(rows, undefined)).toBe(rows[0]);
    expect(selectedMcpServer(rows, project)).toBe(rows[1]);
    expect(selectedMcpServer([rows[0]!], project)).toBeUndefined();
    expect(selectedMcpServer([row('project', 'shared'), row('project', 'shared')], project)).toBeUndefined();
    expect(selectedMcpServer([], project)).toBeUndefined();
    expect(selectedMcpServer([], undefined)).toBeUndefined();
    const replacement = row('project', 'shared');
    expect(selectedMcpServer([replacement], project)).toBe(replacement);
  });
});
