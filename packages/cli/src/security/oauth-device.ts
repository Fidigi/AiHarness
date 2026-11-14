import type { OAuthDeviceConfig } from '@ai-harness/core';
export { OAuthDeviceClient } from '@ai-harness/core';
export type { OAuthDeviceConfig, OAuthDevicePrompt, OAuthDeviceCredential } from '@ai-harness/core';

export function oauthConfigFromEnv(provider: string): OAuthDeviceConfig | undefined {
  const prefix = `AI_HARNESS_OAUTH_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const deviceAuthorizationUrl = process.env[`${prefix}_DEVICE_URL`];
  const tokenUrl = process.env[`${prefix}_TOKEN_URL`];
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  if (!deviceAuthorizationUrl || !tokenUrl || !clientId) return undefined;
  return { deviceAuthorizationUrl, tokenUrl, clientId, scope: process.env[`${prefix}_SCOPE`] };
}
