import { OAuthMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpHttpRuntimeConfig } from './config-inventory.js';
import { safeOAuthUrl } from './oauth-config.js';
import { boundedMcpOAuthFetch } from './oauth-fetch.js';

/** Called only after an auth challenge; never during inventory, preview or Test. */
export async function loadMcpOAuthDiscovery(
  config: McpHttpRuntimeConfig,
  signal: AbortSignal,
  timeoutMs: number,
  validate: () => Promise<unknown>,
): Promise<OAuthDiscoveryState | undefined> {
  const url = config.oauth?.authServerMetadataUrl;
  if (!url) return undefined;
  if (!safeOAuthUrl(url)) throw new Error('The OAuth metadata URL is invalid.');
  await validate();
  const response = await boundedMcpOAuthFetch(signal, timeoutMs)(url, { redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error('OAuth metadata is unavailable.'); }
  const body: unknown = await response.json().catch(() => {
    // JSON parser diagnostics may contain fragments of the remote response body.
    throw new Error('OAuth metadata is invalid.');
  });
  const parsed = OAuthMetadataSchema.safeParse(body);
  if (!parsed.success || !safeOAuthUrl(parsed.data.issuer)
    || !safeOAuthUrl(parsed.data.authorization_endpoint)
    || (parsed.data.token_endpoint && !safeOAuthUrl(parsed.data.token_endpoint))
    || (parsed.data.registration_endpoint && !safeOAuthUrl(parsed.data.registration_endpoint))) {
    throw new Error('OAuth metadata is invalid.');
  }
  await validate();
  return { authorizationServerUrl: parsed.data.issuer, authorizationServerMetadata: parsed.data };
}
