import { beginKimiCodingDeviceLogin, type ProviderCredentialService, type ProviderOAuthCredential } from '@ai-harness/core';
import { terminalText } from '../tui/terminal-text.js';

/** Explicit native issuer; reserve the existing encrypted slot before remote work. */
export async function loginKimiCoding(credentials: ProviderCredentialService, label: string, instructions: (uri: string, code: string) => void,
  signal: AbortSignal, oauthHost?: string): Promise<ProviderOAuthCredential> {
  const publish = await credentials.prepareOAuthLogin(label, signal);
  const flow = await beginKimiCodingDeviceLogin({ oauthHost, signal, redactor: credentials.redactor });
  try {
    signal.throwIfAborted(); const uri = new URL(flow.verificationUri), displayed = `${uri.origin}${uri.pathname}`;
    if (terminalText(flow.userCode) !== flow.userCode || credentials.redactor.redact(flow.userCode) !== flow.userCode
      || credentials.redactor.redact(displayed) !== displayed) throw new Error('Invalid OAuth instructions.');
    instructions(displayed, flow.userCode); const credential = await flow.complete(signal); signal.throwIfAborted();
    await publish(credential); signal.throwIfAborted(); return { version: 1, type: 'oauth', ...credential };
  } finally { flow.cancel(); }
}
