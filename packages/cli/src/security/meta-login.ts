import { beginMetaDeviceLogin, type ProviderCredentialService, type ProviderOAuthCredential } from '@ai-harness/core';
import { terminalText } from '../tui/terminal-text.js';

/** Explicit Muse issuer; identity and minted key stay in the reserved encrypted credential slot. */
export async function loginMeta(credentials: ProviderCredentialService, label: string, instructions: (uri: string, code: string) => void,
  signal: AbortSignal): Promise<ProviderOAuthCredential> {
  const publish = await credentials.prepareOAuthLogin(label, signal);
  const flow = await beginMetaDeviceLogin({ signal, redactor: credentials.redactor });
  try {
    signal.throwIfAborted(); const displayed = new URL(flow.verificationUri).href;
    if (terminalText(displayed) !== displayed || terminalText(flow.userCode) !== flow.userCode || credentials.redactor.redact(flow.userCode) !== flow.userCode
      || credentials.redactor.redact(displayed) !== displayed) throw new Error('Invalid Meta instructions.');
    instructions(displayed, flow.userCode); const credential = await flow.complete(signal); signal.throwIfAborted();
    await publish(credential); signal.throwIfAborted(); return { version: 1, type: 'oauth', ...credential };
  } finally { flow.cancel(); }
}
