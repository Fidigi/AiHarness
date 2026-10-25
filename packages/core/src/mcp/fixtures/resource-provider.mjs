import { createServer } from 'node:http';
export async function resourceProvider() {
  const observed = []; let failure;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && /^(?:\/v1)?\/models\/?$/u.test(new URL(request.url, 'http://fixture.invalid').pathname)) {
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'fixture', object: 'model' }] })); return;
      }
      if (request.method !== 'POST') throw Error('Unexpected fixture request');
      let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 4 * 1024 * 1024) throw Error('Wire size limit'); }
      const body = JSON.parse(text); observed.push(body);
      const toolResults = body.messages.filter(message => message.role === 'tool');
      const call = (name, args = {}) => ({ name: `mcp__docs__${name}`, args });
      const calls = [call('list_mcp_resources'), call('list_mcp_resource_templates'),
        call('read_mcp_resource', { uri: 'fixture://image' }), call('read_mcp_resource', { uri: 'fixture://audio' }), call('rich')];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ delta: toolResults.length ? { content: 'MCP resources complete' } : {
        tool_calls: calls.map((entry, index) => ({ index, id: `resource-${index}`, type: 'function', function: { name: entry.name, arguments: JSON.stringify(entry.args) } })),
      }, finish_reason: toolResults.length ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
    } catch (error) { failure = error; response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, observed, failure: () => failure,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
