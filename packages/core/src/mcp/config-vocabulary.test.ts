import { describe, expect, it } from 'vitest';
import { describeMcpConfigEntry } from './config-inventory.js';
import { previewMcpImport } from './config-import.js';
import { mcpRequestTimeout } from './server-test.js';

const oauth = { clientId: 'registered', clientName: 'Native operator', scope: 'tools.read tools.write',
  callbackUrl: 'http://127.0.0.1/custom/callback', callbackPort: 8765,
  authServerMetadataUrl: 'https://issuer.example/.well-known/openid-configuration' };

describe('MCP-01 native configuration vocabulary', () => {
  it('validates registered OAuth, preserves it through paste/reparse, and keeps values out of inventory', () => {
    const config = { url: 'https://mcp.example/api', timeout: 2.5, oauth };
    const entry = describeMcpConfigEntry('docs', config);
    expect(entry.valid).toBe(true);
    expect(JSON.stringify(entry)).not.toContain('Native operator');
    expect(JSON.stringify(entry)).not.toContain('custom/callback');
    const preview = previewMcpImport(JSON.stringify({ mcpServers: { docs: config } }), { syntax: 'aiharness' });
    expect(preview.entries[0]?.persisted.valid).toBe(true);
    expect(preview.entries[0]?.notes).not.toContainEqual(expect.objectContaining({ code: 'dropped-properties' }));
    expect(mcpRequestTimeout(config, 15_000)).toBe(2_500);
    expect(mcpRequestTimeout({ ...config, timeout: 300 }, 15_000)).toBe(15_000);
  });

  it('supports operator-owned CIMD without borrowing another client identity', () => {
    expect(describeMcpConfigEntry('docs', { url: 'https://mcp.example', oauth: {
      clientRegistration: 'cimd', clientMetadataUrl: 'https://operator.example/oauth/client.json',
    } }).valid).toBe(true);
  });

  it.each([
    { callbackUrl: 'https://127.0.0.1/callback' }, { callbackUrl: 'http://remote.example/callback' },
    { callbackUrl: 'http://127.0.0.1/callback?code=secret' }, { callbackUrl: 'http://user:secret@localhost/callback' },
    { callbackPort: 0 }, { callbackPort: 65536 }, { callbackPort: 1.5 },
    { callbackUrl: 'http://127.0.0.1:8000/callback', callbackPort: 8001 },
    { scope: 'read', scopes: ['write'] }, { scope: 'read\nwrite' }, { clientName: '\u001b[31m' },
    { authServerMetadataUrl: 'http://remote.example/metadata' },
    { clientRegistration: 'cimd' }, { clientRegistration: 'cimd', clientMetadataUrl: 'https://operator.example/' },
    { clientRegistration: 'cimd', clientMetadataUrl: 'https://operator.example/client.json', clientId: 'other' },
  ])('rejects unsafe or ambiguous OAuth settings %j without echoing values', invalid => {
    const entry = describeMcpConfigEntry('docs', { url: 'https://mcp.example', oauth: invalid });
    expect(entry.valid).toBe(false); expect(entry.problemReasons).toContain('oauth');
    expect(entry.problems).toEqual(['OAuth settings do not match the supported schema.']);
  });

  it.each([0, -1, 301, '10', null])('rejects invalid per-server timeout %j', timeout => {
    expect(describeMcpConfigEntry('docs', { command: 'node', timeout }).valid).toBe(false);
  });
});
