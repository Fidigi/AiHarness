import { beginRadiusBrowserLogin, beginRadiusDeviceLogin, getRadiusOAuthConfig,
  type ProviderCredentialService, type ProviderOAuthCredential, type RadiusOAuthCredential } from '@ai-harness/core';
import { terminalText } from '../tui/terminal-text.js';
import { completeOAuthLoopback } from './oauth-loopback.js';

/** Explicit gateway issuer; reserve durable publication before any discovery/device request. */
export async function loginRadius(credentials: ProviderCredentialService, label: string, method: 'device' | 'browser',
  instructions: (uri: string, code?: string) => void, signal: AbortSignal, gateway?: string): Promise<ProviderOAuthCredential> {
  const publish = await credentials.prepareOAuthLogin(label, signal);
  const options = { gateway, signal, redactor: credentials.redactor };
  let credential: RadiusOAuthCredential;
  if (method === 'browser') {
    const flow = await beginRadiusBrowserLogin(options);
    try { credential = await completeOAuthLoopback(flow, getRadiusOAuthConfig(gateway).redirectUri, 'Radius', instructions, signal, publish); }
    finally { flow.cancel(); }
  } else {
    const flow = await beginRadiusDeviceLogin(options);
    try {
      signal.throwIfAborted();
      if (terminalText(flow.userCode) !== flow.userCode || credentials.redactor.redact(flow.userCode) !== flow.userCode
        || credentials.redactor.redact(flow.verificationUri) !== flow.verificationUri) throw new Error('Invalid OAuth instructions.');
      instructions(flow.verificationUri, flow.userCode); credential = await flow.complete(signal);
    } finally { flow.cancel(); }
  }
  signal.throwIfAborted(); if (method === 'device') await publish(credential); signal.throwIfAborted();
  return { version: 1, type: 'oauth', ...credential };
}
