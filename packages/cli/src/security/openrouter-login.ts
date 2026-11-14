import { beginOpenRouterLogin, type ProviderCredentialService } from '@ai-harness/core';
import { completeOpenRouterLoopback } from './oauth-loopback.js';
/** Explicit OpenRouter issuer; the result is an ordinary permanent API key, never a refresh pair. */
export async function loginOpenRouter(credentials: ProviderCredentialService, label: string, instructions: (message: string) => void, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted(); const publish = await credentials.prepareApiKeyLogin(label, signal); signal.throwIfAborted();
  await completeOpenRouterLoopback(callback => beginOpenRouterLogin(callback, { signal, redactor: credentials.redactor }),
    instructions, signal, value => publish(value.apiKey));
  signal.throwIfAborted();
}
