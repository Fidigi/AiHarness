import { GITHUB_COPILOT_MODELS, type ProviderCredentialService } from '@ai-harness/core';

/** Every turn borrows both caller and host lifetimes, including passive refresh. */
export function gitHubCopilotCredentialSource(credentials: ProviderCredentialService, lifetime: AbortSignal) {
  return async (signal?: AbortSignal) => {
    const resolved = await credentials.resolve('github-copilot', {
      env: {}, subscriptionProvider: 'github-copilot', allowCommands: false,
      signal: signal ? AbortSignal.any([signal, lifetime]) : lifetime,
    });
    return resolved?.credential.type === 'oauth' ? resolved.credential : undefined;
  };
}

/** Prepare account-scoped composition; callers check their lifetime before publishing it to the proxy. */
export async function resolveGitHubCopilotSubscription(credentials: ProviderCredentialService, lifetime: AbortSignal) {
  const credentialSource = gitHubCopilotCredentialSource(credentials, lifetime);
  const credential = await credentialSource();
  const model = credential && GITHUB_COPILOT_MODELS.find(model => credential.subscription?.provider === 'github-copilot' && credential.subscription.availableModelIds.includes(model.id));
  return model ? { model: model.id, credentialSource } : undefined;
}
