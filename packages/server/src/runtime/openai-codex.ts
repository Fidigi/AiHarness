import { OPENAI_CODEX_MODELS, type ProviderCredentialService } from '@ai-harness/core';

/** Account credentials borrow host/caller lifetimes; never resolve ordinary keys. */
export function openAICodexCredentialSource(credentials: ProviderCredentialService, lifetime: AbortSignal) {
  return async (signal?: AbortSignal) => {
    const requestSignal = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
    requestSignal.throwIfAborted();
    const resolved = await credentials.resolve('openai-codex', {
      env: {}, subscriptionProvider: 'openai-codex', allowCommands: false, signal: requestSignal,
    });
    requestSignal.throwIfAborted();
    return resolved?.credential.type === 'oauth' ? resolved.credential : undefined;
  };
}

export async function resolveOpenAICodexSubscription(credentials: ProviderCredentialService, lifetime: AbortSignal) {
  const credentialSource = openAICodexCredentialSource(credentials, lifetime);
  const credential = await credentialSource();
  // Construction seed only; availability still requires authenticated discovery.
  return credential ? { model: OPENAI_CODEX_MODELS[0]!.id, credentialSource } : undefined;
}
