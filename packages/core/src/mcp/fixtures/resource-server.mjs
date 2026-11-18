import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLesAAAAASUVORK5CYII=';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let r; try { r = JSON.parse(line); } catch { return; }
  if (r.id === undefined) return;
  if (process.env.MCP_RESOURCE_LOG && r.method !== 'initialize') appendFileSync(process.env.MCP_RESOURCE_LOG, JSON.stringify({ method: r.method, ...r.params }) + '\n');
  let result;
  switch (r.method) {
    case 'initialize': result = { protocolVersion: r.params.protocolVersion, capabilities: { resources: {}, ...(process.env.MCP_RICH_TOOL ? { tools: {} } : {}) }, serverInfo: { name: 'resource-fixture', version: '1' } }; break;
    case 'tools/list': result = { tools: [{ name: 'rich', description: 'Returns a rich result', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }; break;
    case 'resources/list': result = r.params?.cursor ? { resources: [{ uri: 'fixture://image', name: 'Image', mimeType: 'image/png' }] }
      : { resources: [{ uri: 'fixture://text', name: 'Text', mimeType: 'text/plain' }, { uri: 'ui://app', name: 'App', mimeType: 'text/html' }], nextCursor: 'page2' }; break;
    case 'resources/templates/list': result = { resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'By id' }] }; break;
    case 'resources/read': {
      const uri = r.params?.uri;
      if (uri === 'fixture://held') return;
      const content = uri === 'fixture://image' ? { mimeType: 'image/png', blob: png }
        : uri === 'fixture://audio' ? { mimeType: 'audio/wav', blob: Buffer.from('disposable-audio').toString('base64') }
        : uri === 'fixture://app' ? { mimeType: 'text/html;profile=mcp-app', text: '<script>unsafe()</script>' }
        : { mimeType: 'text/plain', text: `Resource text ${process.env.MCP_LABEL || 'docs'} ${process.env.MCP_SECRET || ''}` };
      result = { contents: [{ uri, ...content }] }; break;
    }
    case 'tools/call': result = { content: [{ type: 'text', text: 'rich text <script>globalThis.mcpAppRan=1</script>' }, { type: 'image', data: png, mimeType: 'image/png' },
      { type: 'audio', data: Buffer.from('disposable-audio').toString('base64'), mimeType: 'audio/wav' }], structuredContent: { answer: 42, secret: process.env.MCP_SECRET || '' }, _meta: { ui: { resourceUri: 'ui://app' } } }; break;
    case 'ping': result = {}; break;
    default: send({ jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'Method unavailable' } }); return;
  }
  send({ jsonrpc: '2.0', id: r.id, result });
});
input.on('close', () => process.exit(0));
