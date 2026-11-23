import { describe, expect, it } from 'vitest';
import type { McpEntryProblemReason, McpServerInventoryEntry } from '../index.js';
import { describeMcpConfigEntry } from './config-inventory.js';

const cases: Array<[McpEntryProblemReason, string, unknown, string]> = [
  ['entry-shape', 'server', 42, 'The server entry must be an object.'],
  ['server-name', 'bad\u202ename', { command: 'node' }, 'The server name is empty, too long, or contains hidden characters.'],
  ['unsupported-properties', 'server', { command: 'node', privateField: 'PRIVATE-LITERAL' }, 'The server entry contains unsupported properties.'],
  ['target', 'server', {}, 'The server entry must define exactly one command or URL.'],
  ['command', 'server', { command: '' }, 'The command must be a non-empty bounded string.'],
  ['url', 'server', { url: 'ftp://example.test/PRIVATE-LITERAL' }, 'The URL must be a bounded HTTP or HTTPS URL.'],
  ['transport', 'server', { command: 'node', type: 'PRIVATE-LITERAL' }, 'The transport type is unsupported.'],
  ['stdio-transport', 'server', { command: 'node', type: 'http' }, 'The transport type does not match the command transport.'],
  ['http-transport', 'server', { url: 'https://example.test', type: 'stdio' }, 'The transport type does not match the URL transport.'],
  ['args', 'server', { command: 'node', args: [17] }, 'Arguments must be a bounded array of strings.'],
  ['cwd', 'server', { command: 'node', cwd: 17 }, 'The working directory must be a bounded string.'],
  ['description', 'server', { command: 'node', description: 17 }, 'The description must be a bounded string.'],
  ['env', 'server', { command: 'node', env: { TOKEN: 17 } }, 'Environment entries must be a bounded string map.'],
  ['headers', 'server', { url: 'https://example.test', headers: { Authorization: 17 } }, 'Header entries must be a bounded string map.'],
  ['stdio-fields', 'server', { command: 'node', headers: {} }, 'Standard-input servers cannot declare HTTP headers or OAuth settings.'],
  ['http-fields', 'server', { url: 'https://example.test', env: {} }, 'HTTP servers cannot declare command arguments, a working directory, or process environment.'],
  ['enabled', 'server', { command: 'node', enabled: 'PRIVATE-LITERAL' }, 'Enabled must be a boolean.'],
  ['exposure', 'server', { command: 'node', exposure: 'PRIVATE-LITERAL' }, 'Exposure must be direct, codemode, deferred, or hidden.'],
  ['tool-exposure', 'server', { command: 'node', toolExposure: { tool: 'PRIVATE-LITERAL' } }, 'Per-tool exposure must be a bounded map of tool names or * patterns and exposure modes.'],
  ['oauth', 'server', { url: 'https://example.test', oauth: { extra: 'PRIVATE-LITERAL' } }, 'OAuth settings do not match the supported schema.'],
];

describe('typed MCP entry diagnostics', () => {
  it.each(cases)('emits %s with its fixed message without exposing a literal', (reason, name, value, message) => {
    const before = JSON.stringify(value);
    const entry = describeMcpConfigEntry(name, value);
    expect(entry.valid).toBe(false);
    const index = entry.problemReasons!.indexOf(reason);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(entry.problems[index]).toBe(message);
    expect(entry.problemReasons).toHaveLength(entry.problems.length);
    expect(entry.problemReasons!.length).toBeLessThanOrEqual(20);
    expect(new Set(entry.problemReasons).size).toBe(entry.problemReasons!.length);
    expect(JSON.stringify({ reasons: entry.problemReasons, problems: entry.problems })).not.toContain('PRIVATE-LITERAL');
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([{ command: 'node' }, { url: 'https://example.test' }, { command: 'node', enabled: false }])(
    'keeps valid DTOs unchanged and omits the optional codes: %j', value => {
      const entry = describeMcpConfigEntry('valid', value);
      expect(entry).toMatchObject({ valid: true, problems: [] });
      expect(Object.hasOwn(entry, 'problemReasons')).toBe(false);
    },
  );

  it('does not alias calls or copy caller-supplied diagnostic authority', () => {
    const first = describeMcpConfigEntry('server', { command: 'node', enabled: 17 });
    first.problemReasons!.push('oauth');
    first.problems.push('caller detail');
    const second = describeMcpConfigEntry('server', { command: 'node', enabled: 17 });
    expect(second.problemReasons).toEqual(['enabled']);
    expect(second.problems).toEqual(['Enabled must be a boolean.']);
    const supplied = describeMcpConfigEntry('server', { command: 'node', problemReasons: ['oauth'] });
    expect(supplied.problemReasons).toEqual(['unsupported-properties']);
    expect(supplied.problems).toEqual(['The server entry contains unsupported properties.']);
  });

  it('preserves source-compatible legacy descriptors without the additive field', () => {
    const legacy: Pick<McpServerInventoryEntry, 'problems' | 'problemReasons'> = { problems: ['legacy technical detail'] };
    expect(legacy.problemReasons).toBeUndefined();
    expect(legacy.problems).toEqual(['legacy technical detail']);
    expect(cases.map(([reason]) => reason)).toHaveLength(20);
    expect(new Set(cases.map(([reason]) => reason)).size).toBe(20);
  });
});
