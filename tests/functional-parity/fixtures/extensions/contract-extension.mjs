import { appendFileSync } from 'node:fs';

function record(payload) {
  const destination = process.env.AI_HARNESS_PARITY_CAPTURE;
  if (destination) appendFileSync(destination, `${JSON.stringify(payload)}\n`, 'utf8');
}

export default api => {
  if (api.version !== 1) throw new Error(`Unsupported AiHarness extension API: ${api.version}`);

  api.registerCommand('contract_echo', {
    description: 'Record an extension command for the public-contract harness.',
    handler: args => {
      record({ event: 'command', args, apiVersion: api.version });
    },
  });

  api.registerCommand('contract_confirm', {
    description: 'Request one declarative confirmation.',
    handler: async (_args, context) => {
      const response = await context.requestInteraction?.({
        kind: 'confirm',
        title: 'Contract confirmation',
        message: 'Continue?',
        timeoutMs: 5_000,
      });
      record({ event: 'confirm', cancelled: response?.cancelled, value: response?.value, apiVersion: api.version });
    },
  });

  api.before('before:agent', data => {
    record({ event: 'before:agent', input: data.input, apiVersion: api.version });
  });
};
