import { beginOpenAICodexDeviceLogin, type ProviderCredentialService } from '@ai-harness/core';
import { terminalText } from '../tui/terminal-text.js';

/** Explicit issuer login. Reserve durable publication before any OpenAI request. */
export async function loginOpenAICodex(
  credentials: ProviderCredentialService,
  label: string,
  instructions: (uri: string, code: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const publish = await credentials.prepareOAuthLogin(label, signal);
  const flow = await beginOpenAICodexDeviceLogin({ signal, redactor: credentials.redactor });
  try {
    signal.throwIfAborted();
    if (terminalText(flow.userCode) !== flow.userCode || credentials.redactor.redact(flow.userCode) !== flow.userCode) throw new Error('Invalid OAuth code.');
    instructions(flow.verificationUri, flow.userCode);
    const credential = await flow.complete(signal);
    signal.throwIfAborted();
    await publish(credential);
    signal.throwIfAborted();
  } finally { flow.cancel(); }
}
