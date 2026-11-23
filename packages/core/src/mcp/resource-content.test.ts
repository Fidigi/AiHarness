import { describe, expect, it, vi } from 'vitest';
import { formatMcpResult, McpContentStore, MCP_CONTENT_LIMITS, resourceUri } from './resource-content.js';
import { callMcpResource, type McpResourceConnection } from './resource-tools.js';
const redact = (text: string) => text.replaceAll('disposable-secret', '[redacted]');
const connection = (): McpResourceConnection => ({ listResources: vi.fn(async () => ({ resources: [] })),
  listTemplates: vi.fn(async () => ({ resourceTemplates: [] })), readResource: vi.fn(async () => ({ contents: [] })) });

describe('MCP content admission and retention', () => {
  it('copies and redacts structured/text content before escaping, without accessors or UI execution', () => {
    const structured = { 'disposable-secret': 'disposable-secret', list: [42] };
    const result = formatMcpResult({ content: [{ type: 'text', text: 'disposable-secret <script>inert</script>' }], structuredContent: structured, _meta: { ui: { resourceUri: 'ui://app' } } }, redact, () => 'unused');
    expect(result.structuredContent).toEqual({ '[redacted]': '[redacted]', list: [42] });
    structured.list.push(3); expect(result.structuredContent).toEqual({ '[redacted]': '[redacted]', list: [42] });
    expect(result.content).toBe('[redacted] <script>inert</script>'); expect(JSON.stringify(result)).not.toContain('ui://app');
    expect(formatMcpResult({ content: [], structuredContent: { value: 123456 } }, text => text.replaceAll('123456', '•••'), () => '').structuredContent).toEqual({ value: '•••' });
    const get = vi.fn(); expect(() => formatMcpResult(Object.defineProperty({}, 'content', { get, enumerable: true }), redact, () => '')).toThrow(); expect(get).not.toHaveBeenCalled();
  });
  it.each([
    { type: 'image', mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') },
    { type: 'audio', mimeType: 'audio/wav', data: 'not-base64' },
    { type: 'audio', mimeType: 'audio/disposable-secret', data: 'eA==' },
    { type: 'audio', mimeType: 'audio/wav', data: Buffer.from('disposable-secret').toString('base64') },
    { type: 'resource', resource: { uri: 'ui://app', text: '<script>app</script>', mimeType: 'text/html' } },
    { type: 'resource', resource: { uri: 'fixture://app', blob: 'eA==', mimeType: 'text/html;profile=mcp-app' } },
  ])('refuses invalid, secret-bearing or executable media %# before retention', content => {
    const retain = vi.fn(); expect(() => formatMcpResult({ content: [content] }, redact, retain)).toThrow(); expect(retain).not.toHaveBeenCalled();
  });
  it('enforces total result, binary and structured ceilings', () => {
    const retain = vi.fn();
    expect(() => formatMcpResult({ content: [{ type: 'text', text: 'x'.repeat(MCP_CONTENT_LIMITS.resultBytes) }] }, redact, retain)).toThrow();
    expect(() => formatMcpResult({ content: [], structuredContent: { text: 'x'.repeat(128 * 1024) } }, redact, retain)).toThrow();
    expect(() => formatMcpResult({ content: [{ type: 'audio', mimeType: 'audio/wav', data: Buffer.alloc(MCP_CONTENT_LIMITS.binaryBytes + 1).toString('base64') }] }, redact, retain)).toThrow();
    expect(retain).not.toHaveBeenCalled();
  });
  it('keeps usable references after text clipping, including a valid empty remote blob', () => {
    const store = new McpContentStore();
    const result = formatMcpResult({ content: [{ type: 'text', text: 'x'.repeat(MCP_CONTENT_LIMITS.textChars + 100) },
      { type: 'resource', resource: { uri: 'fixture://empty', mimeType: 'application/octet-stream', blob: '' } }] }, redact,
      (data, mime) => store.put('owner', data, mime));
    const id = /mcp-content:([a-f0-9-]{36})/u.exec(result.content)![1]!;
    expect(result.content.length).toBeLessThanOrEqual(MCP_CONTENT_LIMITS.textChars);
    expect(store.get('owner', id)?.size).toBe(0);
  });
  it('bounds count/bytes/TTL, copies bytes and separates owners', () => {
    let now = 0; const store = new McpContentStore(() => now), bytes = Buffer.from('safe');
    const id = store.put('one', bytes, 'audio/wav'); bytes[0] = 0;
    expect(store.get('one', id)?.data.toString()).toBe('safe'); expect(store.get('two', id)).toBeUndefined();
    const copy = store.get('one', id)!; copy.data[0] = 0; expect(store.get('one', id)?.data.toString()).toBe('safe');
    now = MCP_CONTENT_LIMITS.ttlMs; expect(store.get('one', id)).toBeUndefined();
    const first = store.put('one', Buffer.alloc(1), 'application/octet-stream');
    for (let i = 0; i < MCP_CONTENT_LIMITS.retainedItems; i++) store.put('one', Buffer.alloc(1), 'application/octet-stream');
    expect(store.get('one', first)).toBeUndefined(); store.removeOwner('one');
    const large = store.put('one', Buffer.alloc(MCP_CONTENT_LIMITS.binaryBytes), 'application/octet-stream');
    for (let i = 0; i < 8; i++) store.put('two', Buffer.alloc(MCP_CONTENT_LIMITS.binaryBytes), 'application/octet-stream');
    expect(store.get('one', large)).toBeUndefined();
  });
});

describe('MCP resource pagination and URI boundary', () => {
  it('dispatches exactly one page, whitelists metadata and refuses loops/oversized pages', async () => {
    const peer = connection(), signal = new AbortController().signal;
    peer.listResources = vi.fn(async () => ({ resources: [{ uri: 'file:///remote-only', name: 'disposable-secret', _meta: { executable: true } }], nextCursor: 'next' }));
    const result = await callMcpResource(peer, 'resources/list', {}, signal, redact) as { structuredContent: unknown };
    expect(result.structuredContent).toEqual({ resources: [{ uri: 'file:///remote-only', name: '[redacted]' }], nextCursor: 'next' });
    expect(peer.listResources).toHaveBeenCalledTimes(1);
    peer.listResources = async () => ({ resources: [], nextCursor: 'next' });
    await expect(callMcpResource(peer, 'resources/list', { cursor: 'next' }, signal, redact)).rejects.toThrow('pagination');
    peer.listResources = async () => ({ resources: Array.from({ length: 1001 }, () => ({ uri: 'fixture://one', name: 'One' })) });
    await expect(callMcpResource(peer, 'resources/list', {}, signal, redact)).rejects.toThrow('limit');
  });
  it('rejects URI/cursor/unknown argument authority before a peer call; file URIs stay opaque', async () => {
    const peer = connection(), signal = new AbortController().signal;
    expect(resourceUri('file:///only-on-peer')).toBe('file:///only-on-peer');
    expect(resourceUri('{+baseUri}/item/{id}{?query}', true)).toBe('{+baseUri}/item/{id}{?query}');
    expect(() => resourceUri('ui://app/{id}', true)).toThrow();
    expect(() => resourceUri('{unclosed', true)).toThrow();
    for (const uri of ['ui://app', 'https://user:password@example.test/a', 'fixture://a\nsecret', 'relative']) await expect(callMcpResource(peer, 'resources/read', { uri }, signal, redact)).rejects.toThrow();
    await expect(callMcpResource(peer, 'resources/list', { cursor: 'x'.repeat(4097) }, signal, redact)).rejects.toThrow();
    await expect(callMcpResource(peer, 'resources/read', { uri: 'fixture://one', server: 'other' }, signal, redact)).rejects.toThrow();
    expect(peer.readResource).not.toHaveBeenCalled(); expect(peer.listResources).not.toHaveBeenCalled();
  });
});
