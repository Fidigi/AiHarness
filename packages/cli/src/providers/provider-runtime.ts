import path from 'node:path';
import {
  CredentialRedactor,
  GITHUB_COPILOT_MODELS,
  OPENAI_CODEX_MODELS,
  bedrockCredentialConfig,
  EncryptedCredentialStore,
  ProviderCredentialService,
  providerCredentialEnvironmentKeys,
  resolveAgentProviderNetworkSettings,
  type AgentProviderNetworkSettings,
  type AgentSettings,
  type ExtensionProvider,
  type ProviderOAuthRefreshConfig,
  type ProviderOAuthCredential,
  type RadiusOAuthCredentialSource,
} from '@ai-harness/core';

export const CLI_CREDENTIAL_PROVIDERS = [
  'openai', 'openai-native', 'anthropic', 'google', 'cerebras', 'mistral-conversations', 'deepseek', 'groq', 'zai', 'nvidia',
  'minimax', 'minimax-cn', 'kimi-coding', 'moonshotai', 'moonshotai-cn', 'ant-ling', 'baseten', 'together',
  'huggingface', 'xiaomi', 'meta', 'xai', 'fireworks', 'opencode', 'opencode-go', 'openrouter',
  'cloudflare-workers-ai', 'cloudflare-ai-gateway', 'vercel-ai-gateway', 'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual',
  'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai-coding-cn', 'typesafe', 'radius', 'azure', 'vertex', 'bedrock', 'local',
] as const;

export interface CliSubscription {
  model: string;
  credentialSource: (signal?: AbortSignal) => Promise<ProviderOAuthCredential | undefined>;
}

export type CliGitHubCopilotSubscription = CliSubscription;
export interface CliRadiusOAuth {
  credential: ProviderOAuthCredential;
  credentialSource: RadiusOAuthCredentialSource;
}

export interface CliProviderRuntime {
  githubCopilot?: CliGitHubCopilotSubscription;
  openaiCodex?: CliSubscription;
  kimiCodingAuthMode?: 'api-key' | 'oauth';
  radiusCatalogueDirectory?: string;
  radiusOAuth?: CliRadiusOAuth;
  credentials: ProviderCredentialService;
  values: ReadonlyMap<string, string>;
  network: AgentProviderNetworkSettings;
  redactor: CredentialRedactor;
  /** Internal reload identity; never crosses a CLI output boundary. */
  credentialStoreId: string;
  signal: AbortSignal;
  close(): void;
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

/** A subscription resolver borrows the host and each caller, never environment/key sources. */
export function cliGitHubCopilotCredentialSource(credentials: ProviderCredentialService, lifetime?: AbortSignal, allowRefresh = true) {
  return cliSubscriptionCredentialSource(credentials, 'github-copilot', lifetime, allowRefresh);
}

export function cliSubscriptionCredentialSource(
  credentials: ProviderCredentialService,
  issuer: 'github-copilot' | 'openai-codex' | 'radius',
  lifetime?: AbortSignal,
  allowRefresh = true,
  radiusGateway?: string,
) {
  return async (signal?: AbortSignal, requestAllowRefresh = true) => {
    const requestSignal = lifetime && signal ? AbortSignal.any([lifetime, signal]) : lifetime ?? signal;
    requestSignal?.throwIfAborted();
    const resolved = await credentials.resolve(issuer, { env: {}, subscriptionProvider: issuer,
      allowCommands: false, allowRefresh: allowRefresh && requestAllowRefresh, signal: requestSignal,
      ...(issuer === 'radius' ? { radiusGateway } : {}) });
    requestSignal?.throwIfAborted();
    return resolved?.credential.type === 'oauth' ? resolved.credential : undefined;
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
  parentSignal?: AbortSignal,
): Promise<CliProviderRuntime> {
  const controller = new AbortController();
  const lifetime = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  lifetime.throwIfAborted();
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
  await credentials.load();
  const commandEnv = { ...env };
  for (const [provider, command] of Object.entries(settings.providerApiKeyCommands ?? {})) {
    commandEnv[commandVariable(provider)] = command;
  }
  const values = new Map<string, string>();
  let kimiCodingAuthMode: CliProviderRuntime['kimiCodingAuthMode'];
  const present = new Set(credentials.list().map(item => item.provider));
  const providers = new Set<string>([
    ...CLI_CREDENTIAL_PROVIDERS,
    ...Object.keys(settings.providerApiKeyCommands ?? {}),
    ...present,
    ...extensionProviders.map(item => item.type),
  ]);
  for (const provider of providers) {
    if (provider === 'github-copilot' || provider === 'openai-codex') continue;
    // Fresh inventory only skips absent sources. Selected stored credentials still
    // revalidate through resolve(), including external withdrawal/replacement.
    if (!present.has(provider) && !providerCredentialEnvironmentKeys(provider).some(name => commandEnv[name])
      && !commandEnv[commandVariable(provider)]) continue;
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
    if (provider === 'kimi-coding') kimiCodingAuthMode = resolved.credential.type;
  }
  const credentialSource = cliGitHubCopilotCredentialSource(credentials, lifetime, !offline);
  const subscription = await credentialSource();
  const model = subscription && GITHUB_COPILOT_MODELS.find(model => subscription.subscription?.provider === 'github-copilot' && subscription.subscription.availableModelIds.includes(model.id));
  const codexSource = cliSubscriptionCredentialSource(credentials, 'openai-codex', lifetime, !offline);
  const codex = await codexSource();
  const radiusSource = cliSubscriptionCredentialSource(credentials, 'radius', lifetime, !offline, env.RADIUS_GATEWAY);
  const radius = present.has('radius') && !values.has('radius') && !commandEnv[commandVariable('radius')] ? await radiusSource() : undefined;
  return {
    ...(model ? { githubCopilot: { model: model.id, credentialSource } } : {}),
    ...(codex ? { openaiCodex: { model: OPENAI_CODEX_MODELS[0]!.id, credentialSource: codexSource } } : {}),
    ...(radius ? { radiusOAuth: { credential: radius, credentialSource: radiusSource } } : {}),
    credentials,
    values,
    ...(kimiCodingAuthMode ? { kimiCodingAuthMode } : {}),
    network: resolveAgentProviderNetworkSettings(settings),
    redactor,
    ...(persistCredentials ? { radiusCatalogueDirectory: path.join(agentDir, 'radius-models') } : {}),
    credentialStoreId: `${persistCredentials ? 'persistent' : 'memory'}:${path.resolve(agentDir)}`,
    signal: lifetime,
    close: () => controller.abort(),
  };
}
