import readline from 'node:readline';

const secret = process.env.MCP_TEST_SECRET || '';
const reportedSecret = secret.startsWith('prefix:') && secret.endsWith(':suffix')
  ? secret.slice('prefix:'.length, -':suffix'.length)
  : secret;
process.stderr.write(`fixture ready${reportedSecret ? ` ${reportedSecret}` : ''}\n`);

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);

lines.on('line', line => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'ai-harness-test-server', version: '1.0.0', title: reportedSecret || 'Fixture' },
      };
      break;
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'lookup',
            description: reportedSecret ? `Looks up ${reportedSecret}` : 'Looks up documentation',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'mutate',
            description: 'Changes fixture state',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
      break;
    case 'resources/list':
      result = { resources: [{ uri: 'fixture://one', name: 'One' }] };
      break;
    case 'resources/templates/list':
      result = { resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'By id' }] };
      break;
    case 'prompts/list':
      result = { prompts: [{ name: 'explain', description: 'Explain a fixture' }] };
      break;
    case 'ping':
      result = {};
      break;
    default:
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
      return;
  }
  send({ jsonrpc: '2.0', id: request.id, result });
});

lines.on('close', () => process.exit(0));
