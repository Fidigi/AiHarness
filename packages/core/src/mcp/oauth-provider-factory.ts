import type { McpServerTestTarget } from './config-inventory.js';
import {
  isSameMcpOAuthTarget,
  McpOAuthConfigurationError,
  type McpOAuthCredentialManager,
  type McpOAuthProviderBinding,
  mcpOAuthUrl,
} from './oauth.js';
import { MCP_TEST_COMMAND_TIMEOUT_MS, resolveMcpOAuthSettings } from './server-test.js';

export interface McpOAuthProviderFactoryOptions {
  manager: McpOAuthCredentialManager;
  resolveTarget(target: McpServerTestTarget): Promise<McpServerTestTarget>;
  commandTimeoutMs?: number;
}

function abortError(): Error {
  const error = new Error('The MCP OAuth connection was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Shared passive provider factory for persistent CLI, RPC, and Web MCP hosts. */
export function createMcpOAuthProviderFactory(
  options: McpOAuthProviderFactoryOptions,
): (target: McpServerTestTarget, signal: AbortSignal) => Promise<McpOAuthProviderBinding | undefined> {
  const commandTimeoutMs = options.commandTimeoutMs ?? MCP_TEST_COMMAND_TIMEOUT_MS;
  return async (target, signal) => {
    const url = mcpOAuthUrl(target.config);
    if (!url || !('url' in target.config)) return undefined;
    const resolveCurrentTarget = async (): Promise<McpServerTestTarget> => {
      if (signal.aborted) throw abortError();
      const current = await options.resolveTarget(target);
      if (signal.aborted) throw abortError();
      if (!isSameMcpOAuthTarget(target, current)) {
        throw new McpOAuthConfigurationError(
          'The MCP server configuration changed during OAuth refresh.',
        );
      }
      return current;
    };
    return options.manager.createProvider({
      identity: { name: target.name, url },
      mode: 'passive',
      settings: {
        clientId: target.config.oauth?.clientId,
        scopes: target.config.oauth?.scopes,
        resolveClientSecret: async () => (await resolveMcpOAuthSettings(
          await resolveCurrentTarget(),
          signal,
          commandTimeoutMs,
        )).clientSecret,
      },
      validateWrite: async () => { await resolveCurrentTarget(); },
    });
  };
}
