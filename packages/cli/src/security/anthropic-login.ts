import { beginAnthropicBrowserLogin, beginAnthropicCopyCodeLogin, type AnthropicLogin, type ProviderCredentialService, type ProviderOAuthCredential } from '@ai-harness/core';
import { completeAnthropicLoopback } from './oauth-loopback.js';

/** Explicit issuer; reserve the existing encrypted slot before callback/input/remote work. */
export async function loginAnthropic(credentials: ProviderCredentialService, label: string, method: 'browser' | 'copy-code', instructions: (url: string) => void,
  signal: AbortSignal, readCopyCode?: (signal: AbortSignal) => Promise<string | undefined>): Promise<ProviderOAuthCredential> {
  const owner = new AbortController(), lifetime = AbortSignal.any([signal, owner.signal]); let copy: AnthropicLogin | undefined;
  try {
    lifetime.throwIfAborted(); const publish = await credentials.prepareOAuthLogin(label, lifetime); lifetime.throwIfAborted();
    let credential;
    if (method === 'browser') credential = await completeAnthropicLoopback(callbackUrl => beginAnthropicBrowserLogin({ callbackUrl, signal: lifetime, redactor: credentials.redactor }), instructions, lifetime, publish);
    else {
      copy = beginAnthropicCopyCodeLogin({ signal: lifetime, redactor: credentials.redactor });
      const input = readCopyCode ? readCopyCode(lifetime) : Promise.resolve(undefined); void input.catch(() => undefined);
      instructions(copy.authorizationUrl); const value = await input; lifetime.throwIfAborted(); if (value === undefined) throw new Error('Anthropic copy code is required.');
      credential = await copy.complete(value, lifetime); lifetime.throwIfAborted(); await publish(credential); lifetime.throwIfAborted();
    }
    lifetime.throwIfAborted(); return { version: 1, type: 'oauth', ...credential };
  } finally { owner.abort(); copy?.cancel(); }
}
