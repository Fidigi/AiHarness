import path from 'node:path';
import type { EncryptedCredentialStore } from '../security/credential-store.js';
import {
  executeShellCommand,
  isSensitiveEnvironmentEntry,
  ProcessAbortedError,
} from '../tools/process-execution.js';

const MAX_PROVIDER_ID_BYTES = 128;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const MAX_CREDENTIAL_OPERATION_TIMEOUT_MS = 60_000;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_REDACTION_SECRETS = 2_048;
const MAX_REDACTION_VARIANT_CHARS = 16 * 1024 * 1024;
const MAX_REDACTION_TEXT_CHARS = 1024 * 1024;
const MAX_REDACTION_MATCHES = 100_000;
const MAX_REDACTION_REGEX_SOURCE_CHARS = 64 * 1024;
const MAX_REDACTION_STREAM_NODES = 1_000_000;
const MAX_REDACTION_JSON_DEPTH = 32;
const MAX_REDACTION_JSON_NODES = 50_000;
const REDACTION_MARKER = '[REDACTED]';
const REDACTION_LIMIT_MARKER = '[REDACTED: value exceeded safe redaction limit]';
const REDACTION_CYCLE_MARKER = '[REDACTED: circular value]';
const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|PRIVATE_?KEY|MASTER_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH(?:ORIZATION)?|COOKIE)(?:$|_)/i;
const PROXY_ENVIRONMENT_NAME = /(?:^|_)(?:HTTP|HTTPS|ALL)_PROXY$/i;

export type ProviderCredentialSource = 'environment' | 'command' | 'encrypted-store' | 'memory';

export interface ProviderApiKeyCredential {
  version: 1;
  type: 'api-key';
  apiKey: string;
}

export interface ProviderOAuthCredential {
  version: 1;
  type: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
}

export type ProviderCredential = ProviderApiKeyCredential | ProviderOAuthCredential;

export interface ProviderCredentialDescriptor {
  provider: string;
  type: ProviderCredential['type'];
  source: ProviderCredentialSource;
  expiresAt?: number;
  refreshable: boolean;
}

export interface ResolvedProviderCredential {
  descriptor: ProviderCredentialDescriptor;
  /** Internal runtime value. Never serialize this object across a process boundary. */
  credential: ProviderCredential;
}

export interface ProviderOAuthRefreshConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
}

export interface ResolveProviderCredentialOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  commandTimeoutMs?: number;
  refreshTimeoutMs?: number;
  oauth?: ProviderOAuthRefreshConfig;
  fetcher?: typeof fetch;
  now?: number;
}

export interface ProviderCredentialServiceOptions {
  store?: EncryptedCredentialStore;
  /** Prefix retained for migrations; defaults to the shared provider namespace. */
  namespace?: string;
  /** Process-local sink used to scrub every CLI/HTTP/log boundary. */
  redactor?: CredentialRedactor;
}

export class ProviderCredentialError extends Error {
  constructor(
    public readonly code:
      | 'invalid-provider'
      | 'invalid-credential'
      | 'command-failed'
      | 'command-timeout'
      | 'refresh-failed'
      | 'refresh-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderCredentialError';
  }
}

const ENVIRONMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  vertex: ['GOOGLE_VERTEX_ACCESS_TOKEN', 'GOOGLE_CLOUD_API_KEY'],
  bedrock: ['AWS_BEARER_TOKEN_BEDROCK'],
  local: ['LOCAL_API_KEY', 'LLAMA_API_KEY'],
};

function providerId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(normalized) || Buffer.byteLength(normalized) > MAX_PROVIDER_ID_BYTES) {
    throw new ProviderCredentialError('invalid-provider', 'The provider identifier is invalid.');
  }
  return normalized;
}

function secret(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
    throw new ProviderCredentialError('invalid-credential', 'The provider credential is invalid.');
  }
  return value;
}

function validateCredential(value: unknown): ProviderCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderCredentialError('invalid-credential', 'The provider credential is invalid.');
  }
  const record = value as Partial<ProviderCredential>;
  if (record.version !== 1) throw new ProviderCredentialError('invalid-credential', 'The provider credential is invalid.');
  if (record.type === 'api-key') {
    return { version: 1, type: 'api-key', apiKey: secret(record.apiKey) };
  }
  if (record.type !== 'oauth') throw new ProviderCredentialError('invalid-credential', 'The provider credential is invalid.');
  const credential: ProviderOAuthCredential = {
    version: 1,
    type: 'oauth',
    accessToken: secret(record.accessToken),
  };
  if (record.refreshToken !== undefined) credential.refreshToken = secret(record.refreshToken);
  if (record.expiresAt !== undefined) {
    if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0) {
      throw new ProviderCredentialError('invalid-credential', 'The provider credential is invalid.');
    }
    credential.expiresAt = record.expiresAt;
  }
  if (record.tokenType !== undefined) {
    if (typeof record.tokenType !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(record.tokenType)) {
      throw new ProviderCredentialError('invalid-credential', 'The provider credential is invalid.');
    }
    credential.tokenType = record.tokenType;
  }
  return credential;
}

function parseStoredCredential(value: string): ProviderCredential {
  try { return validateCredential(JSON.parse(value)); }
  catch (error) {
    if (error instanceof ProviderCredentialError) throw error;
    throw new ProviderCredentialError('invalid-credential', 'The provider credential is invalid.');
  }
}

function commandVariable(provider: string): string {
  return `AI_HARNESS_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY_COMMAND`;
}

function descriptor(
  provider: string,
  credential: ProviderCredential,
  source: ProviderCredentialSource,
): ProviderCredentialDescriptor {
  return {
    provider,
    type: credential.type,
    source,
    ...(credential.type === 'oauth' && credential.expiresAt !== undefined
      ? { expiresAt: credential.expiresAt } : {}),
    refreshable: credential.type === 'oauth' && Boolean(credential.refreshToken),
  };
}

async function abortable<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort?.();
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      onAbort?.();
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(
      value => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(contentLength)
    || Number(contentLength) > MAX_OAUTH_RESPONSE_BYTES)) {
    void response.body?.cancel('oauth-response-limit').catch(() => undefined);
    throw new ProviderCredentialError('refresh-failed', 'The provider credential could not be refreshed.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderCredentialError('refresh-failed', 'The provider credential could not be refreshed.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal, () => { void reader.cancel().catch(() => undefined); });
      if (result.done) { completed = true; break; }
      bytes += result.value.byteLength;
      if (bytes > MAX_OAUTH_RESPONSE_BYTES) {
        void reader.cancel('oauth-response-limit').catch(() => undefined);
        throw new ProviderCredentialError('refresh-failed', 'The provider credential could not be refreshed.');
      }
      chunks.push(result.value);
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProviderCredentialError) throw error;
    throw new ProviderCredentialError('refresh-failed', 'The provider credential could not be refreshed.');
  } finally {
    if (!completed) void reader.cancel('oauth-response-abandoned').catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A cancelled pending read still owns the lock briefly. */ }
  }
}

function safeOAuthConfig(config: ProviderOAuthRefreshConfig): ProviderOAuthRefreshConfig {
  const invalid = (): never => {
    throw new ProviderCredentialError('refresh-unavailable', 'OAuth refresh is not configured safely.');
  };
  if (!config || typeof config !== 'object') invalid();
  const own = (key: keyof ProviderOAuthRefreshConfig): unknown => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch { return invalid(); }
  };
  const tokenUrl = own('tokenUrl');
  const clientId = own('clientId');
  const clientSecret = own('clientSecret');
  if (typeof tokenUrl !== 'string' || !tokenUrl || Buffer.byteLength(tokenUrl) > 4_096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(tokenUrl)) invalid();
  const safeTokenUrl = tokenUrl as string;
  let endpoint: URL;
  try { endpoint = new URL(safeTokenUrl); }
  catch { return invalid(); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) invalid();
  if (typeof clientId !== 'string' || !clientId || Buffer.byteLength(clientId) > 4_096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(clientId)) invalid();
  const safeClientId = clientId as string;
  let safeClientSecret: string | undefined;
  if (clientSecret !== undefined) {
    if (typeof clientSecret !== 'string') invalid();
    safeClientSecret = clientSecret as string;
    secret(safeClientSecret);
  }
  return {
    tokenUrl: endpoint.toString(),
    clientId: safeClientId,
    ...(safeClientSecret === undefined ? {} : { clientSecret: safeClientSecret }),
  };
}

export interface CredentialRedactionStream {
  /** True after this stream has replaced a credential or failed closed at a safety limit. */
  readonly redacted: boolean;
  /** Returns only the prefix that can no longer form a credential with a later chunk. */
  push(chunk: string): string;
  /** Redacts and returns the final buffered suffix. */
  flush(): string;
}

type RedactionInterval = { start: number; end: number };

type StreamMatcherNode = {
  readonly next: Map<string, number>;
  fail: number;
  readonly depth: number;
};

type StreamMatcher = {
  readonly limited: boolean;
  suffixLength(value: string): number;
};

function buildStreamMatcher(variants: readonly string[]): StreamMatcher {
  const nodes: StreamMatcherNode[] = [{ next: new Map(), fail: 0, depth: 0 }];
  for (const variant of variants) {
    let state = 0;
    for (let index = 0; index < variant.length; index++) {
      const unit = variant[index]!;
      let next = nodes[state]!.next.get(unit);
      if (next === undefined) {
        if (nodes.length >= MAX_REDACTION_STREAM_NODES) {
          return { limited: true, suffixLength: () => 0 };
        }
        next = nodes.length;
        nodes[state]!.next.set(unit, next);
        nodes.push({ next: new Map(), fail: 0, depth: nodes[state]!.depth + 1 });
      }
      state = next;
    }
  }

  const queue: number[] = [];
  for (const child of nodes[0]!.next.values()) queue.push(child);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const state = queue[cursor]!;
    for (const [unit, child] of nodes[state]!.next) {
      let fallback = nodes[state]!.fail;
      while (fallback !== 0 && !nodes[fallback]!.next.has(unit)) fallback = nodes[fallback]!.fail;
      nodes[child]!.fail = nodes[fallback]!.next.get(unit) ?? 0;
      queue.push(child);
    }
  }

  return {
    limited: false,
    suffixLength(value: string): number {
      let state = 0;
      for (let index = 0; index < value.length; index++) {
        const unit = value[index]!;
        while (state !== 0 && !nodes[state]!.next.has(unit)) state = nodes[state]!.fail;
        state = nodes[state]!.next.get(unit) ?? 0;
      }
      return nodes[state]!.depth;
    },
  };
}

function credentialVariants(value: string): string[] {
  const variants = new Set<string>([
    value,
    Buffer.from(value).toString('base64'),
    Buffer.from(value).toString('base64url'),
    Buffer.from(value).toString('hex'),
  ]);
  try { variants.add(encodeURIComponent(value)); } catch { /* Raw and byte encodings remain covered. */ }
  try { variants.add(encodeURI(value)); } catch { /* Raw and byte encodings remain covered. */ }
  try { variants.add(JSON.stringify(value).slice(1, -1)); } catch { /* Strings are normally serializable. */ }
  return [...variants].filter(Boolean);
}

/**
 * Process-local credential redactor shared by CLI, JSON/RPC, Server and log boundaries.
 * It deliberately exposes no secret enumeration API and applies hard work/shape limits.
 */
export class CredentialRedactor {
  private readonly secrets = new Set<string>();
  private readonly variants = new Set<string>();
  private sortedVariants: readonly string[] = [];
  private compiledVariantGroups: readonly RegExp[] = [];
  private variantsDirty = false;
  private compilationFailed = false;
  private variantChars = 0;
  private maxVariantLength = 1;
  private variantVersion = 0;
  private streamMatcherVersion = -1;
  private streamMatcherCache?: StreamMatcher;

  constructor(values: Iterable<string | undefined> = []) {
    // Secret-bearing implementation state must not appear in JSON, object spreads, or normal inspection.
    for (const name of [
      'secrets', 'variants', 'sortedVariants', 'compiledVariantGroups', 'variantsDirty', 'compilationFailed',
      'variantChars', 'maxVariantLength', 'variantVersion', 'streamMatcherVersion', 'streamMatcherCache',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(this, name);
      if (descriptor) Object.defineProperty(this, name, { ...descriptor, enumerable: false });
    }
    this.addAll(values);
  }

  toJSON(): Record<string, never> {
    return {};
  }

  add(value: string | undefined): void {
    if (!value || value.includes('\0') || Buffer.byteLength(value) > MAX_SECRET_BYTES) return;
    if (this.secrets.has(value)) return;
    if (this.secrets.size >= MAX_REDACTION_SECRETS) {
      throw new ProviderCredentialError('invalid-credential', 'Too many provider credentials are active.');
    }
    const additions = credentialVariants(value).filter(item => !this.variants.has(item));
    const addedChars = additions.reduce((total, item) => total + item.length, 0);
    if (this.variantChars + addedChars > MAX_REDACTION_VARIANT_CHARS) {
      throw new ProviderCredentialError('invalid-credential', 'Provider credentials exceed the redaction safety limit.');
    }
    this.secrets.add(value);
    for (const item of additions) {
      this.variants.add(item);
      this.variantChars += item.length;
      this.maxVariantLength = Math.max(this.maxVariantLength, item.length);
    }
    this.variantsDirty = additions.length > 0;
    if (additions.length > 0) this.variantVersion++;
  }

  addAll(values: Iterable<string | undefined>): void {
    for (const value of values) this.add(value);
  }

  /** Remember credential-like process variables without retaining unrelated configuration. */
  addEnvironment(environment: NodeJS.ProcessEnv): void {
    for (const [name, value] of Object.entries(environment)) {
      if (!value) continue;
      if (!SENSITIVE_ENVIRONMENT_NAME.test(name)
        && !PROXY_ENVIRONMENT_NAME.test(name)
        && !isSensitiveEnvironmentEntry(name, value)) continue;
      this.add(value);
      try {
        const credentialUrl = new URL(value);
        this.add(credentialUrl.username ? decodeURIComponent(credentialUrl.username) : undefined);
        this.add(credentialUrl.password ? decodeURIComponent(credentialUrl.password) : undefined);
        this.addAll(credentialUrl.searchParams.values());
      } catch { /* Non-URL credential values were already registered above. */ }
    }
  }

  redact(value: string): string {
    if (value.length > MAX_REDACTION_TEXT_CHARS) return REDACTION_LIMIT_MARKER;
    return this.redactPrefix(value, value.length).output;
  }

  /** Create an independent redactor that safely joins credentials split across chunks. */
  createStream(): CredentialRedactionStream {
    let pending = '';
    let limited = false;
    let didRedact = false;
    let matcherVersion = -1;
    let matcher: StreamMatcher | undefined;
    const currentMatcher = (): StreamMatcher => {
      if (!matcher || matcherVersion !== this.variantVersion) {
        matcher = this.streamingMatcher();
        matcherVersion = this.variantVersion;
      }
      return matcher;
    };
    return {
      get redacted() { return didRedact; },
      push: chunk => {
        if (limited || !chunk) return '';
        if (chunk.length > MAX_REDACTION_TEXT_CHARS
          || pending.length + chunk.length > MAX_REDACTION_TEXT_CHARS + this.maxVariantLength) {
          pending = '';
          limited = true;
          didRedact = true;
          return REDACTION_LIMIT_MARKER;
        }
        pending += chunk;
        const activeMatcher = currentMatcher();
        if (activeMatcher.limited) {
          pending = '';
          limited = true;
          didRedact = true;
          return REDACTION_LIMIT_MARKER;
        }
        const safeCut = pending.length - activeMatcher.suffixLength(pending);
        if (safeCut <= 0) return '';
        const result = this.redactPrefix(pending, safeCut);
        pending = pending.slice(result.consumed);
        if (result.redacted) didRedact = true;
        if (result.limited) {
          pending = '';
          limited = true;
        }
        return result.output;
      },
      flush: () => {
        if (limited || !pending) return '';
        if (pending.length > MAX_REDACTION_TEXT_CHARS) {
          pending = '';
          limited = true;
          didRedact = true;
          return REDACTION_LIMIT_MARKER;
        }
        const result = this.redactPrefix(pending, pending.length);
        pending = '';
        if (result.redacted) didRedact = true;
        if (result.limited) limited = true;
        return result.output;
      },
    };
  }

  /** Clone JSON-like data while bounding depth, nodes, getters, cycles and string work. */
  redactJson<T>(value: T): T {
    const ancestors = new WeakSet<object>();
    let nodes = 0;
    const visit = (input: unknown, depth: number): unknown => {
      if (++nodes > MAX_REDACTION_JSON_NODES || depth > MAX_REDACTION_JSON_DEPTH) {
        return REDACTION_LIMIT_MARKER;
      }
      if (typeof input === 'string') return this.redact(input);
      if (!input || typeof input !== 'object') return input;
      try {
        if (input instanceof Date) return new Date(input);
        // Preserve operational opaque values unless their serialized representation
        // would itself disclose a known credential at a JSON boundary.
        if (input instanceof AbortSignal) return input;
        if (input instanceof URL) {
          const serialized = input.toString();
          const safe = this.redact(serialized);
          if (safe === serialized) return input;
          try { return new URL(safe); }
          catch { return safe; }
        }
        if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
          try {
            const bytes = input instanceof ArrayBuffer
              ? Buffer.from(input)
              : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
            const encodings = [bytes.toString('utf8'), bytes.toString('base64'), bytes.toString('hex')];
            return encodings.some(serialized => this.redact(serialized) !== serialized) ? REDACTION_MARKER : input;
          } catch { return REDACTION_LIMIT_MARKER; }
        }
      } catch {
        return REDACTION_LIMIT_MARKER;
      }
      if (ancestors.has(input)) return REDACTION_CYCLE_MARKER;
      ancestors.add(input);
      try {
        let arrayInput = false;
        try { arrayInput = Array.isArray(input); }
        catch { return REDACTION_LIMIT_MARKER; }
        if (arrayInput) {
          const result: unknown[] = [];
          const values = input as unknown[];
          let length: number;
          try { length = values.length; }
          catch { return [REDACTION_LIMIT_MARKER]; }
          for (let index = 0; index < length; index++) {
            if (nodes >= MAX_REDACTION_JSON_NODES) {
              result.push(REDACTION_LIMIT_MARKER);
              break;
            }
            try {
              const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
              result.push(descriptor && 'value' in descriptor
                ? visit(descriptor.value, depth + 1)
                : descriptor ? REDACTION_LIMIT_MARKER : undefined);
            } catch { result.push(REDACTION_LIMIT_MARKER); }
          }
          return result;
        }
        const result: Record<string, unknown> = {};
        let names: string[];
        try { names = Object.keys(input); }
        catch { return REDACTION_LIMIT_MARKER; }
        for (const name of names) {
          if (nodes >= MAX_REDACTION_JSON_NODES) {
            Object.defineProperty(result, REDACTION_LIMIT_MARKER, {
              value: REDACTION_LIMIT_MARKER, enumerable: true, configurable: true, writable: true,
            });
            break;
          }
          const safeName = this.redact(name);
          let safeValue: unknown = REDACTION_LIMIT_MARKER;
          try {
            const descriptor = Object.getOwnPropertyDescriptor(input, name);
            if (descriptor && 'value' in descriptor) safeValue = visit(descriptor.value, depth + 1);
          } catch { /* Accessors and hostile descriptors fail closed without invocation. */ }
          Object.defineProperty(result, safeName, {
            value: safeValue, enumerable: true, configurable: true, writable: true,
          });
        }
        return result;
      } finally {
        ancestors.delete(input);
      }
    };
    return visit(value, 0) as T;
  }

  private streamingMatcher(): StreamMatcher {
    // Refresh the sorted variant snapshot before sharing one immutable automaton across channels.
    this.compiledGroups();
    if (!this.streamMatcherCache || this.streamMatcherVersion !== this.variantVersion) {
      this.streamMatcherCache = buildStreamMatcher(this.sortedVariants);
      this.streamMatcherVersion = this.variantVersion;
    }
    return this.streamMatcherCache;
  }

  private compiledGroups(): readonly RegExp[] {
    if (this.variantsDirty) {
      this.sortedVariants = [...this.variants].sort((left, right) => right.length - left.length);
      const groups: RegExp[] = [];
      let alternatives: string[] = [];
      let sourceChars = 0;
      const compile = (): void => {
        if (!alternatives.length) return;
        try { groups.push(new RegExp(`(?=(${alternatives.join('|')}))`, 'gu')); }
        catch { this.compilationFailed = true; }
        alternatives = [];
        sourceChars = 0;
      };
      this.compilationFailed = false;
      for (const variant of this.sortedVariants) {
        const escaped = variant.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
        if (alternatives.length && sourceChars + escaped.length + 1 > MAX_REDACTION_REGEX_SOURCE_CHARS) compile();
        alternatives.push(escaped);
        sourceChars += escaped.length + 1;
      }
      compile();
      this.compiledVariantGroups = groups;
      this.variantsDirty = false;
    }
    return this.compiledVariantGroups;
  }

  private redactPrefix(
    value: string,
    safeCut: number,
  ): { output: string; consumed: number; limited: boolean; redacted: boolean } {
    if (!this.variants.size) {
      return { output: value.slice(0, safeCut), consumed: safeCut, limited: false, redacted: false };
    }
    const intervals: RedactionInterval[] = [];
    const groups = this.compiledGroups();
    if (this.compilationFailed) {
      return { output: REDACTION_LIMIT_MARKER, consumed: value.length, limited: true, redacted: true };
    }
    for (const group of groups) {
      group.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = group.exec(value)) !== null) {
        const matched = match[1];
        const start = match.index;
        if (!matched || start >= safeCut) break;
        intervals.push({ start, end: start + matched.length });
        if (intervals.length > MAX_REDACTION_MATCHES) {
          return { output: REDACTION_LIMIT_MARKER, consumed: value.length, limited: true, redacted: true };
        }
        // The lookahead is zero-width; advance one code unit to include overlapping credentials.
        group.lastIndex = start + 1;
      }
    }
    if (!intervals.length) {
      return { output: value.slice(0, safeCut), consumed: safeCut, limited: false, redacted: false };
    }
    intervals.sort((left, right) => left.start - right.start || right.end - left.end);
    const merged: RedactionInterval[] = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
      else merged.push({ ...interval });
    }
    let output = '';
    let cursor = 0;
    for (const interval of merged) {
      if (interval.start >= safeCut) break;
      if (interval.end <= cursor) continue;
      if (interval.start > cursor) output += value.slice(cursor, interval.start);
      output += REDACTION_MARKER;
      cursor = Math.max(cursor, interval.end);
    }
    if (cursor < safeCut) output += value.slice(cursor, safeCut);
    return { output, consumed: Math.max(cursor, safeCut), limited: false, redacted: true };
  }
}

/**
 * Provider credential lifecycle shared by CLI and Server adapters.
 * Public descriptors never contain a secret; resolved records stay process-local.
 */
export class ProviderCredentialService {
  private readonly volatile = new Map<string, ProviderCredential>();
  private readonly commandCache = new Map<string, string>();
  private readonly namespace: string;
  readonly redactor: CredentialRedactor;

  constructor(private readonly options: ProviderCredentialServiceOptions = {}) {
    this.namespace = options.namespace ?? 'provider';
    this.redactor = options.redactor ?? new CredentialRedactor();
    if (!PROVIDER_PATTERN.test(this.namespace)) {
      throw new ProviderCredentialError('invalid-provider', 'The credential namespace is invalid.');
    }
  }

  hasPersistentStore(): boolean {
    return this.options.store !== undefined;
  }

  async load(): Promise<void> {
    await this.options.store?.load();
    for (const name of this.options.store?.list() ?? []) {
      if (!name.startsWith(`${this.namespace}:`)) continue;
      const value = this.options.store?.get(name);
      if (!value) continue;
      try { this.rememberCredential(parseStoredCredential(value)); } catch { /* Invalid entries remain unavailable. */ }
    }
  }

  async setApiKey(provider: string, apiKey: string, persist = true): Promise<ProviderCredentialDescriptor> {
    const id = providerId(provider);
    const credential: ProviderApiKeyCredential = { version: 1, type: 'api-key', apiKey: secret(apiKey) };
    await this.save(id, credential, persist);
    return descriptor(id, credential, persist && this.options.store ? 'encrypted-store' : 'memory');
  }

  async setOAuth(provider: string, value: Omit<ProviderOAuthCredential, 'version' | 'type'>, persist = true): Promise<ProviderCredentialDescriptor> {
    const id = providerId(provider);
    const credential = validateCredential({ version: 1, type: 'oauth', ...value });
    await this.save(id, credential, persist);
    return descriptor(id, credential, persist && this.options.store ? 'encrypted-store' : 'memory');
  }

  async delete(provider: string): Promise<boolean> {
    const id = providerId(provider);
    const hadMemory = this.volatile.has(id);
    // Publish the process-local deletion only after the durable store accepted it.
    const persisted = await this.options.store?.delete(this.storageName(id)) ?? false;
    this.volatile.delete(id);
    this.commandCache.delete(id);
    return hadMemory || persisted;
  }

  /** Refresh one process-local descriptor after an atomic external store transaction. */
  synchronizeFromStore(provider: string): void {
    const id = providerId(provider);
    this.volatile.delete(id);
    this.commandCache.delete(id);
    const persisted = this.options.store?.get(this.storageName(id));
    if (!persisted) return;
    this.rememberCredential(parseStoredCredential(persisted));
  }

  list(): ProviderCredentialDescriptor[] {
    const result = new Map<string, ProviderCredentialDescriptor>();
    for (const [provider, credential] of this.volatile) {
      result.set(provider, descriptor(provider, credential, 'memory'));
    }
    for (const name of this.options.store?.list() ?? []) {
      const prefix = `${this.namespace}:`;
      if (!name.startsWith(prefix)) continue;
      const provider = name.slice(prefix.length);
      try {
        const value = this.options.store?.get(name);
        if (!value) continue;
        const credential = parseStoredCredential(value);
        result.set(provider, descriptor(provider, credential, 'encrypted-store'));
      } catch {
        // Corrupt individual records are unavailable and never echoed in metadata.
      }
    }
    return [...result.values()].sort((left, right) => left.provider.localeCompare(right.provider));
  }

  async resolve(provider: string, options: ResolveProviderCredentialOptions = {}): Promise<ResolvedProviderCredential | undefined> {
    const id = providerId(provider);
    const env = options.env ?? process.env;
    this.redactor.addEnvironment(env);
    for (const name of providerCredentialEnvironmentKeys(id)) {
      const value = env[name];
      if (value) {
        const credential: ProviderApiKeyCredential = { version: 1, type: 'api-key', apiKey: secret(value) };
        this.rememberCredential(credential);
        return { credential, descriptor: descriptor(id, credential, 'environment') };
      }
    }

    const configuredCommand = env[commandVariable(id)];
    if (configuredCommand) {
      let apiKey = this.commandCache.get(id);
      if (!apiKey) {
        const requestedTimeout = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
        const timeoutMs = Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
          ? Math.min(requestedTimeout, MAX_CREDENTIAL_OPERATION_TIMEOUT_MS)
          : DEFAULT_COMMAND_TIMEOUT_MS;
        try {
          const result = await executeShellCommand({
            command: configuredCommand,
            cwd: path.resolve(options.cwd ?? process.cwd()),
            signal: options.signal,
            timeoutMs,
            maxCaptureBytes: MAX_SECRET_BYTES,
          });
          if (result.timedOut) throw new ProviderCredentialError('command-timeout', 'The provider credential command timed out.');
          if (result.exitCode !== 0 || result.captureTruncated) {
            throw new ProviderCredentialError('command-failed', 'The provider credential command failed.');
          }
          apiKey = secret(result.output.trim());
          this.commandCache.set(id, apiKey);
          this.redactor.add(apiKey);
        } catch (error) {
          if (error instanceof ProviderCredentialError || error instanceof ProcessAbortedError) throw error;
          throw new ProviderCredentialError('command-failed', 'The provider credential command failed.');
        }
      }
      const credential: ProviderApiKeyCredential = { version: 1, type: 'api-key', apiKey };
      return { credential, descriptor: descriptor(id, credential, 'command') };
    }

    const memory = this.volatile.get(id);
    if (memory) return this.resolveStored(id, memory, 'memory', options);
    const persisted = this.options.store?.get(this.storageName(id));
    if (!persisted) return undefined;
    return this.resolveStored(id, parseStoredCredential(persisted), 'encrypted-store', options);
  }

  /** Return one secret only for an explicit local print operation. */
  async reveal(provider: string, options: ResolveProviderCredentialOptions = {}): Promise<string | undefined> {
    const resolved = await this.resolve(provider, options);
    if (!resolved) return undefined;
    return resolved.credential.type === 'api-key'
      ? resolved.credential.apiKey
      : resolved.credential.accessToken;
  }

  private storageName(provider: string): string {
    return `${this.namespace}:${provider}`;
  }

  private async save(provider: string, credential: ProviderCredential, persist: boolean): Promise<void> {
    this.rememberCredential(credential);
    if (persist && this.options.store) {
      await this.options.store.set(this.storageName(provider), JSON.stringify(credential));
      this.volatile.delete(provider);
    } else {
      this.volatile.set(provider, structuredClone(credential));
    }
  }

  private rememberCredential(credential: ProviderCredential): void {
    if (credential.type === 'api-key') {
      this.redactor.add(credential.apiKey);
      return;
    }
    this.redactor.add(credential.accessToken);
    this.redactor.add(credential.refreshToken);
  }

  private async resolveStored(
    provider: string,
    credential: ProviderCredential,
    source: 'memory' | 'encrypted-store',
    options: ResolveProviderCredentialOptions,
  ): Promise<ResolvedProviderCredential> {
    const now = options.now ?? Date.now();
    if (credential.type !== 'oauth' || credential.expiresAt === undefined || credential.expiresAt > now + 60_000) {
      return { credential: structuredClone(credential), descriptor: descriptor(provider, credential, source) };
    }
    if (!credential.refreshToken || !options.oauth) {
      throw new ProviderCredentialError('refresh-unavailable', 'The provider credential has expired and cannot be refreshed.');
    }
    const refreshed = await this.refresh(credential, options.oauth, options);
    await this.save(provider, refreshed, source === 'encrypted-store');
    return { credential: refreshed, descriptor: descriptor(provider, refreshed, source) };
  }

  private async refresh(
    current: ProviderOAuthCredential,
    rawConfig: ProviderOAuthRefreshConfig,
    options: ResolveProviderCredentialOptions,
  ): Promise<ProviderOAuthCredential> {
    const config = safeOAuthConfig(rawConfig);
    this.redactor.add(config.clientSecret);
    const requestedTimeout = options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    const timeoutMs = Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, MAX_CREDENTIAL_OPERATION_TIMEOUT_MS)
      : DEFAULT_REFRESH_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await abortable((options.fetcher ?? fetch)(config.tokenUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken!,
          client_id: config.clientId,
          ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
        }),
        signal,
      }), signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ProviderCredentialError('refresh-failed', 'The provider credential could not be refreshed.');
    }
    let body: Record<string, unknown>;
    try {
      body = await boundedJson(response, signal);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (error instanceof ProviderCredentialError) throw error;
      throw new ProviderCredentialError('refresh-failed', 'The provider credential could not be refreshed.');
    }
    if (!response.ok || typeof body.access_token !== 'string' || !body.access_token) {
      throw new ProviderCredentialError('refresh-failed', 'The provider credential could not be refreshed.');
    }
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
      ? Math.max(0, Math.min(body.expires_in, 365 * 24 * 60 * 60)) : undefined;
    const refreshed = validateCredential({
      version: 1,
      type: 'oauth',
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token : current.refreshToken,
      ...(expiresIn === undefined ? {} : { expiresAt: (options.now ?? Date.now()) + Math.floor(expiresIn * 1_000) }),
      ...(typeof body.token_type === 'string' ? { tokenType: body.token_type } : current.tokenType ? { tokenType: current.tokenType } : {}),
    });
    if (refreshed.type !== 'oauth') {
      throw new ProviderCredentialError('refresh-failed', 'The provider credential could not be refreshed.');
    }
    return refreshed;
  }
}

/** Replace every known literal, including short and encoded variants, in untrusted text. */
export function redactCredentialText(value: string, secrets: Iterable<string>): string {
  return new CredentialRedactor(secrets).redact(value);
}

export function providerCredentialEnvironmentKeys(provider: string): readonly string[] {
  const id = providerId(provider);
  const conventional = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return [...(ENVIRONMENT_KEYS[id] ?? [`AI_HARNESS_${conventional}_API_KEY`, `${conventional}_API_KEY`])];
}
