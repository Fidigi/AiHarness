import path from 'node:path';
import {
  CredentialRedactor, EncryptedCredentialStore, ProviderCredentialService,
  resolvePreTrustAgentDirectory,
} from '@ai-harness/core';
import { CLI_CREDENTIAL_PROVIDERS } from '../providers/provider-runtime.js';
import { OAuthDeviceClient, oauthConfigFromEnv } from '../security/oauth-device.js';
import { terminalText } from '../tui/terminal-text.js';

export const PROVIDER_AUTH_HELP = `Usage: ai-harness auth <help|list|login|logout> [options]
  list [--json]                      Stored credential metadata only (no refresh/commands)
  login <provider> [--timeout <1..300>]
                                     Explicit operator-configured HTTPS device flow
  logout <provider>                  Delete local stored credentials; no remote revocation
  -h, --help                         Show help without startup
Login/logout require AI_HARNESS_MASTER_KEY and the independent encrypted credential store.
Device endpoints: AI_HARNESS_OAUTH_<PROVIDER>_{DEVICE_URL,TOKEN_URL,CLIENT_ID,SCOPE}.
Authorization instructions go to stderr; tokens and device codes are never printed.
Exits: 0 success/help, 2 usage, 1 operation failure, 124 deadline, 130 cancellation.
`;

/** Passive composition: never resolve credentials, run commands, or refresh tokens. */
export async function loadTopLevelCredentialService(cwd: string, redactor: CredentialRedactor): Promise<ProviderCredentialService> {
  const masterKey = process.env.AI_HARNESS_MASTER_KEY;
  const store = masterKey ? new EncryptedCredentialStore(
    path.join(resolvePreTrustAgentDirectory(cwd), 'credentials.enc'), masterKey,
  ) : undefined;
  const service = new ProviderCredentialService({ store, redactor });
  await service.load();
  return service;
}

class AuthUsageError extends Error {}

function parse(args: readonly string[]): { action: string; provider?: string; json: boolean; timeout: number; help: boolean } {
  if (args.length > 16 || args.some(arg => Buffer.byteLength(arg) > 4096 || /[\x00-\x1f\x7f-\x9f]/u.test(arg))) throw new AuthUsageError();
  const action = args[0] ?? 'help';
  if (['help', '-h', '--help'].includes(action)) {
    if (args.length > 1) throw new AuthUsageError();
    return { action, json: false, timeout: 300, help: true };
  }
  if (!['list', 'login', 'logout'].includes(action)) throw new AuthUsageError();
  let provider: string | undefined;
  let json = false, timeout = 300, help = false;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const raw = args[i]!;
    const equal = raw.indexOf('=');
    const key = equal < 0 ? raw : raw.slice(0, equal);
    if (key.startsWith('-')) {
      if (seen.has(key)) throw new AuthUsageError();
      seen.add(key);
      if (key === '-h' || key === '--help') {
        if (equal >= 0 || help) throw new AuthUsageError();
        help = true;
      } else if (key === '--json' && action === 'list') {
        if (equal >= 0) throw new AuthUsageError();
        json = true;
      } else if (key === '--timeout' && action === 'login') {
        const value = equal < 0 ? args[++i] : raw.slice(equal + 1);
        if (!value || !/^(?:[1-9]\d{0,2})$/u.test(value) || Number(value) > 300) throw new AuthUsageError();
        timeout = Number(value);
      } else throw new AuthUsageError();
    } else {
      if (action === 'list' || provider || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(raw)) throw new AuthUsageError();
      provider = raw;
    }
  }
  if (!help && action !== 'list' && !provider) throw new AuthUsageError();
  return { action, provider, json, timeout, help };
}

/** Standalone process adapter; deliberately not the all-provider runtime factory. */
export async function runProviderAuthCommand(args: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(args); }
  catch { process.stderr.write('Auth usage error. Run "ai-harness auth --help".\n'); return 2; }
  if (parsed.help) { process.stdout.write(PROVIDER_AUTH_HELP); return 0; }
  const controller = new AbortController();
  let cancelled = false, expired = false;
  const cancel = (): void => { cancelled = true; controller.abort(); };
  const expire = (): void => { expired = true; controller.abort(); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = 0;
  try {
    const redactor = new CredentialRedactor();
    redactor.addEnvironment(process.env);
    const service = await loadTopLevelCredentialService(process.cwd(), redactor);
    if (parsed.action === 'list') {
      const records = service.list().filter(item => /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(item.provider));
      const providers = [...new Set([...CLI_CREDENTIAL_PROVIDERS, ...records.map(item => item.provider)])].sort();
      const output = providers.map(provider => ({ provider,
        deviceFlowConfigured: Boolean(oauthConfigFromEnv(provider)),
        stored: records.find(item => item.provider === provider) ?? null,
      }));
      process.stdout.write(redactor.redact(parsed.json ? `${JSON.stringify(output)}\n`
        : `${output.map(item => `${item.provider}\t${item.stored ? 'stored' : 'not-stored'}\t${item.deviceFlowConfigured ? 'device-configured' : 'no-device-config'}`).join('\n')}\n`));
      return 0;
    }
    if (!service.hasPersistentStore()) {
      process.stderr.write('Auth unavailable: encrypted persistent storage is required.\n'); return 1;
    }
    if (parsed.action === 'logout') {
      await service.delete(parsed.provider!);
      process.stdout.write('Stored provider credentials removed (environment/command credentials are unchanged).\n');
      return 0;
    }
    const config = oauthConfigFromEnv(parsed.provider!);
    if (!config) { process.stderr.write('Auth unavailable: operator device flow is not configured.\n'); return 1; }
    const client = new OAuthDeviceClient(config);
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    deadline = performance.now() + parsed.timeout * 1000;
    timer = setTimeout(expire, parsed.timeout * 1000);
    // The existing bounded device client links this caller through transport and
    // response-body reads; never replace process-global fetch to cancel a command.
    const prompt = await client.requestCode(controller.signal);
    if (controller.signal.aborted) throw new Error();
    redactor.add(prompt.deviceCode);
    const displayedCode = redactor.redact(prompt.userCode);
    // Refuse codes changed by UTF-8 encoding, terminal formatting or redaction;
    // never ask the operator to enter silently altered issuer characters.
    if (Buffer.from(prompt.userCode, 'utf8').toString('utf8') !== prompt.userCode
      || terminalText(prompt.userCode) !== prompt.userCode
      || displayedCode !== prompt.userCode) throw new Error();
    const uri = new URL(prompt.verificationUri);
    // Do not publish issuer-provided query values or the complete device URL.
    process.stderr.write(`Authorize at ${redactor.redact(`${uri.origin}${uri.pathname}`)}\nUser code: ${displayedCode}\n`);
    clearTimeout(timer);
    timer = setTimeout(expire, Math.max(1, Math.min(deadline - performance.now(), prompt.expiresIn * 1000)));
    const credential = await client.pollCredential(prompt, controller.signal);
    if (controller.signal.aborted) throw new Error();
    await service.setOAuth(parsed.provider!, credential, true);
    // Never advertise a volatile login, and never activate a provider here.
    if (controller.signal.aborted) throw new Error();
    process.stdout.write('Provider credentials encrypted and saved.\n');
    return 0;
  } catch {
    process.stderr.write(cancelled ? 'Auth cancelled.\n' : expired ? 'Auth deadline exceeded.\n' : 'Auth operation failed.\n');
    return cancelled ? 130 : expired ? 124 : 1;
  } finally {
    clearTimeout(timer);
    controller.abort();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
