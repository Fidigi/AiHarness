import { GITHUB_COPILOT_MODELS, type ProviderCredentialService } from '@ai-harness/core';

/** Prepare account-scoped composition; callers check their lifetime before publishing it to the proxy. */
export async function resolveGitHubCopilotSubscription(credentials: ProviderCredentialService) {
  const credentialSource = async (signal?: AbortSignal) => {
    const resolved = await credentials.resolve('github-copilot', {
      env: {}, subscriptionProvider: 'github-copilot', allowCommands: false, signal,
    });
    return resolved?.credential.type === 'oauth' ? resolved.credential : undefined;
  };
  const credential = await credentialSource();
  const model = credential && GITHUB_COPILOT_MODELS.find(model => credential.subscription?.availableModelIds.includes(model.id));
  return model ? { model: model.id, credentialSource } : undefined;
}
