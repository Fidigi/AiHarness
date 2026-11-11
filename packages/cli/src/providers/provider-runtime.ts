import path from 'node:path';
import {
  CredentialRedactor,
  GITHUB_COPILOT_MODELS,
  bedrockCredentialConfig,
  EncryptedCredentialStore,
  ProviderCredentialService,
  resolveAgentProviderNetworkSettings,
  type AgentProviderNetworkSettings,
  type AgentSettings,
  type ExtensionProvider,
  type ProviderOAuthRefreshConfig,
  type ProviderOAuthCredential,
} from '@ai-harness/core';

export const CLI_CREDENTIAL_PROVIDERS = [
  'openai', 'anthropic', 'google', 'cerebras', 'mistral-conversations', 'azure', 'vertex', 'bedrock', 'local',
] as const;

export interface CliGitHubCopilotSubscription {
  model: string;
  credentialSource: (signal?: AbortSignal) => Promise<ProviderOAuthCredential | undefined>;
}

export interface CliProviderRuntime {
  githubCopilot?: CliGitHubCopilotSubscription;
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

/** Resolve ordinary keys locally; subscription consumers retain a fresh credential resolver. */
export async function createCliProviderRuntime(
  agentDir: string,
  settings: AgentSettings,
  env: NodeJS.ProcessEnv = process.env,
  existingCredentials?: ProviderCredentialService,
  persistCredentials = true,
  extensionProviders: ReadonlyArray<{ type: string; definition: ExtensionProvider }> = [],
  runtimeRedactor?: CredentialRedactor,
  offline = false,
): Promise<CliProviderRuntime> {
  const masterKey = env.AI_HARNESS_MASTER_KEY;
  const redactor = existingCredentials?.redactor ?? runtimeRedactor ?? new CredentialRedactor();
  redactor.addEnvironment(env);
  // Explicit extension defaults are not resolved credential-store values, but can
  // still be echoed inside text or opaque continuation fields before persistence.
  for (const { definition } of extensionProviders) {
    const apiKey = definition.defaultConfig?.apiKey;
    if (typeof apiKey === 'string') redactor.add(apiKey);
  }
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
    ...extensionProviders.map(item => item.type),
  ]);
  for (const provider of providers) {
    if (provider === 'github-copilot') continue;
    const resolved = await credentials.resolve(provider, {
      env: commandEnv,
      allowCommands: !offline,
      allowRefresh: !offline,
      cwd: process.cwd(),
      oauth: oauthRefreshConfigFromEnv(provider, env),
    });
    if (!resolved) continue;
    const value = resolved.credential.type === 'api-key' ? resolved.credential.apiKey : resolved.credential.accessToken;
    if (provider === 'bedrock') {
      const config = bedrockCredentialConfig(value);
      if (config) redactor.addAll(Object.values(config));
    }
    values.set(provider, value);
  }
  const credentialSource: CliGitHubCopilotSubscription['credentialSource'] = async signal => {
    const resolved = await credentials.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot',
      allowCommands: false, allowRefresh: !offline, signal });
    return resolved?.credential.type === 'oauth' ? resolved.credential : undefined;
  };
  const subscription = await credentialSource();
  const model = subscription && GITHUB_COPILOT_MODELS.find(model => subscription.subscription?.availableModelIds.includes(model.id));
  return {
    ...(model ? { githubCopilot: { model: model.id, credentialSource } } : {}),
    credentials,
    values,
    network: resolveAgentProviderNetworkSettings(settings),
    redactor,
    credentialStoreId: `${persistCredentials ? 'persistent' : 'memory'}:${path.resolve(agentDir)}`,
  };
}
