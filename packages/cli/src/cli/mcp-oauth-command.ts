import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  EncryptedCredentialStore, McpOAuthCredentialManager, McpOAuthFlowService,
  mcpOAuthUrl, openExternalTarget,
  type CredentialRedactor, type McpServerTestTarget,
} from '@ai-harness/core';

export interface CliMcpOAuthOptions {
  agentDir: string;
  agentDirTrusted: boolean;
  readTarget(): Promise<McpServerTestTarget>;
  redactor: CredentialRedactor;
  write(value: string): void;
  writeError(value: string): void;
  json: boolean;
  signal?: AbortSignal;
}

/** CLI presentation only; Core owns discovery, PKCE, callback/paste validation and durable CAS. */
export async function runMcpOAuthCommand(
  command: 'login' | 'logout', args: string[], options: CliMcpOAuthOptions,
): Promise<number> {
  let noOpen = false;
  let timeoutSeconds = 300;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--no-open' && command === 'login') noOpen = true;
    else if (arg === '--timeout' && command === 'login') {
      const value = args[++index];
      if (!value || !/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 300) {
        throw new Error('--timeout must be an integer from 1 to 300 seconds.');
      }
      timeoutSeconds = Number(value);
    } else throw new Error(`Usage: ai-harness mcp ${command} <name>${command === 'login' ? ' [--no-open] [--timeout <1..300>]' : ''} [--scope <scope>] [--json]`);
  }
  if (!options.agentDirTrusted || !process.env.AI_HARNESS_MASTER_KEY) {
    throw new Error('MCP OAuth requires a trusted independent agent directory and AI_HARNESS_MASTER_KEY-backed durable storage.');
  }
  const target = await options.readTarget();
  const url = mcpOAuthUrl(target.config);
  if (!url) throw new Error('The MCP server is not eligible for OAuth.');
  const manager = new McpOAuthCredentialManager(
    new EncryptedCredentialStore(path.join(options.agentDir, 'credentials.enc'), process.env.AI_HARNESS_MASTER_KEY),
    options.redactor,
  );
  const flows = new McpOAuthFlowService(manager, { ttlMs: timeoutSeconds * 1_000 });
  let input: ReturnType<typeof createInterface> | undefined;
  let inputBytes = 0;
  let flowId: string | undefined;
  const controller = new AbortController();
  const abort = () => { controller.abort(); if (flowId) flows.cancel(flowId); input?.close(); };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  options.signal?.addEventListener('abort', abort, { once: true });
  const boundInput = (chunk: Buffer | string) => {
    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes > 64 * 1024) abort();
  };
  try {
    if (command === 'logout') {
      const removed = await flows.signOut({ name: target.name, url });
      options.write(options.json ? `${JSON.stringify({ name: target.name, scope: target.scope, removed })}\n`
        : `Signed out of MCP server ${target.name}. Issuer-side tokens are not revoked.\n`);
      return 0;
    }
    if (target.config.enabled === false) throw new Error('The MCP server is disabled.');
    const started = flows.start({ target, validate: options.readTarget });
    flowId = started.flow.flowId;
    if (options.signal?.aborted) abort();
    let published: string | undefined;
    while (!controller.signal.aborted) {
      const flow = flows.read(flowId);
      if (!flow) throw new Error('MCP OAuth flow is unavailable.');
      if (flow.phase === 'authorize' && flow.authorizationUrl !== published) {
        published = flow.authorizationUrl;
        options.writeError(`Authorize: ${flow.authorizationUrl}\nCallback: ${flow.redirectUrl}\n`);
        if (!noOpen && flow.authorizationUrl) {
          await openExternalTarget(flow.authorizationUrl, 'url').catch(() => options.writeError('Browser opening failed; open the authorization address manually.\n'));
        }
        if (process.stdin.isTTY && !input) {
          options.writeError('Paste the full redirected address if needed, or press Ctrl+C to cancel.\n');
          process.stdin.on('data', boundInput);
          input = createInterface({ input: process.stdin, terminal: false });
          input.on('line', line => {
            const result = flows.pasteRedirect(flowId!, line);
            if (!result?.ok) options.writeError('The redirect was refused; retry the full address.\n');
          });
        }
      }
      if (['connected', 'failed', 'cancelled', 'expired'].includes(flow.phase)) {
        options.write(options.json ? `${JSON.stringify(flow)}\n`
          : `MCP ${target.name}: ${flow.phase}${flow.failure ? ` (${flow.failure})` : ''}.\n`);
        return flow.phase === 'connected' ? 0 : 1;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return 130;
  } finally {
    input?.close();
    process.stdin.removeListener('data', boundInput);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    options.signal?.removeEventListener('abort', abort);
    await flows.shutdown();
  }
}
