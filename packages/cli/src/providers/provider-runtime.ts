import path from 'node:path';
import {
  CredentialRedactor,
  EncryptedCredentialStore,
  ProviderCredentialService,
  resolveAgentProviderNetworkSettings,
  type AgentProviderNetworkSettings,
  type AgentSettings,
  type ProviderOAuthRefreshConfig,
} from '@ai-harness/core';

export const CLI_CREDENTIAL_PROVIDERS = [
  'openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local',
] as const;

export interface CliProviderRuntime {
  credentials: ProviderCredentialService;
  values: ReadonlyMap<string, string>;
  network: AgentProviderNetworkSettings;
  redactor: CredentialRedactor;
  /** Internal reload identity; never crosses a CLI output boundary. */
  credentialStoreId: string;
}

function commandVariable(provider: string): string {
  return `AI_HARNESS_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY_COMMAND`;
}

export function oauthRefreshConfigFromEnv(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderOAuthRefreshConfig | undefined {
  const prefix = `AI_HARNESS_OAUTH_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const tokenUrl = env[`${prefix}_TOKEN_URL`];
  const clientId = env[`${prefix}_CLIENT_ID`];
  if (!tokenUrl || !clientId) return undefined;
  return {
    tokenUrl,
    clientId,
    ...(env[`${prefix}_CLIENT_SECRET`] ? { clientSecret: env[`${prefix}_CLIENT_SECRET`] } : {}),
  };
}

/** Resolve secrets once for the process; only raw values stay in this local composition root. */
export async function createCliProviderRuntime(
  agentDir: string,
  settings: AgentSettings,
  env: NodeJS.ProcessEnv = process.env,
  existingCredentials?: ProviderCredentialService,
  persistCredentials = true,
  additionalProviders: readonly string[] = [],
  runtimeRedactor?: CredentialRedactor,
): Promise<CliProviderRuntime> {
  const masterKey = env.AI_HARNESS_MASTER_KEY;
  const redactor = existingCredentials?.redactor ?? runtimeRedactor ?? new CredentialRedactor();
  redactor.addEnvironment(env);
  if (settings.httpProxy) redactor.add(settings.httpProxy);
  const store = masterKey && persistCredentials
    ? new EncryptedCredentialStore(path.join(agentDir, 'credentials.enc'), masterKey)
    : undefined;
  const credentials = existingCredentials ?? new ProviderCredentialService({ store, redactor });
  if (!existingCredentials) await credentials.load();
  const commandEnv = { ...env };
  for (const [provider, command] of Object.entries(settings.providerApiKeyCommands ?? {})) {
    commandEnv[commandVariable(provider)] = command;
  }
  const values = new Map<string, string>();
  const providers = new Set<string>([
    ...CLI_CREDENTIAL_PROVIDERS,
    ...Object.keys(settings.providerApiKeyCommands ?? {}),
    ...credentials.list().map(item => item.provider),
    ...additionalProviders,
  ]);
  for (const provider of providers) {
    const resolved = await credentials.resolve(provider, {
      env: commandEnv,
      cwd: process.cwd(),
      oauth: oauthRefreshConfigFromEnv(provider, env),
    });
    if (!resolved) continue;
    values.set(provider, resolved.credential.type === 'api-key'
      ? resolved.credential.apiKey : resolved.credential.accessToken);
  }
  return {
    credentials,
    values,
    network: resolveAgentProviderNetworkSettings(settings),
    redactor,
    credentialStoreId: `${persistCredentials ? 'persistent' : 'memory'}:${path.resolve(agentDir)}`,
  };
}
