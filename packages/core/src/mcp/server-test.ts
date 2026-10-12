import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { executeShellCommand, filteredProcessEnvironment, ProcessAbortedError } from '../tools/process-execution.js';
import { mcpToolExposure } from './config-inventory.js';
import type {
  McpConfigInventory,
  McpHttpRuntimeConfig,
  McpServerRuntimeConfig,
  McpServerTestResult,
  McpServerTestTarget,
  McpServerTestTool,
  McpStdioRuntimeConfig,
} from './config-inventory.js';

export const MCP_TEST_REQUEST_TIMEOUT_MS = 15_000;
export const MCP_TEST_DEADLINE_MS = 20_000;
export const MCP_TEST_CLOSE_WAIT_MS = 2_000;
export const MCP_TEST_COMMAND_TIMEOUT_MS = 10_000;
export const MCP_TEST_MAX_TOOLS = 500;
export const MCP_TEST_MAX_PAGED_ITEMS = 1_000;
export const MCP_TEST_MAX_PAGES = 20;
export const MCP_TEST_STATUS_LIMIT = 500;

const STDERR_MAX_BYTES = 64 * 1024;
const RESULT_TEXT_MAX_CHARS = 2_000;
const DESCRIPTION_MAX_CHARS = 300;
const MCP_TEST_MAX_TRANSPORT_BYTES = 8 * 1024 * 1024;
const MCP_TEST_MAX_TRANSPORT_CHUNK_BYTES = 1024 * 1024;
const RESERVED_VARIABLES = new Set([
  'AI_HARNESS_AUTH_TOKEN',
  'AI_HARNESS_ADMIN_TOKEN',
  'AI_HARNESS_MASTER_KEY',
]);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const AUTH_SCHEME = /^(?:bearer|basic|token)$/iu;

export interface ResolvedRuntimeConfig {
  config: McpServerRuntimeConfig;
  resolvedSecrets: string[];
}

type TestRun = Omit<McpServerTestResult, 'testedAt'>;

export interface McpServerTestConnectOptions {
  requestTimeoutMs: number;
  closeWaitMs: number;
}

export type McpServerTestConnect = (
  target: McpServerTestTarget,
  signal: AbortSignal,
  options: McpServerTestConnectOptions,
) => Promise<TestRun>;

export type McpServerTestValidate = () => Promise<void>;

export interface McpServerTesterOptions {
  deadlineMs?: number;
  requestTimeoutMs?: number;
  closeWaitMs?: number;
  commandTimeoutMs?: number;
  statusLimit?: number;
  now?: () => number;
  connect?: McpServerTestConnect;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>(resolve => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function clip(text: string, maximum: number): string {
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

export function appendBoundedTail(current: Buffer, chunk: Buffer, maximum: number): Buffer {
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= maximum) return combined;
  let start = combined.length - maximum;
  while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
  return combined.subarray(start);
}

function runtimeValues(config: McpServerRuntimeConfig): Array<{ field: string; value: string }> {
  return 'command' in config
    ? Object.entries(config.env ?? {}).map(([name, value]) => ({ field: `env.${name}`, value }))
    : Object.entries(config.headers ?? {}).map(([name, value]) => ({ field: `headers.${name}`, value }));
}

/** Tests with command-backed values are serialized before any such value runs. */
export function mcpTestRunsCommand(config: McpServerRuntimeConfig): boolean {
  return runtimeValues(config).some(({ value }) => value.startsWith('!'));
}

/** Persistent OAuth may resolve its client secret after a challenge; serialize that command too. */
export function mcpSessionRunsCommand(config: McpServerRuntimeConfig): boolean {
  return mcpTestRunsCommand(config)
    || ('url' in config && config.oauth?.clientSecret?.startsWith('!') === true);
}

function interpolateEnvironment(
  value: string,
  environment: NodeJS.ProcessEnv,
  resolvedSecrets: string[],
): string {
  let output = '';
  for (let index = 0; index < value.length;) {
    const character = value[index]!;
    if (character !== '$') {
      output += character;
      index++;
      continue;
    }
    const next = value[index + 1];
    if (next === '$' || next === '!') {
      output += next;
      index += 2;
      continue;
    }
    let name: string | undefined;
    let end = index + 1;
    if (next === '{') {
      const closing = value.indexOf('}', index + 2);
      if (closing >= 0) {
        const candidate = value.slice(index + 2, closing);
        if (VARIABLE_NAME.test(candidate)) {
          name = candidate;
          end = closing + 1;
        }
      }
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(value.slice(index + 1));
      if (match) {
        name = match[0];
        end = index + 1 + name.length;
      }
    }
    if (!name) {
      output += '$';
      index++;
      continue;
    }
    if (RESERVED_VARIABLES.has(name.toUpperCase())) {
      throw new Error(`The reserved host variable ${name} cannot be passed to an MCP server.`);
    }
    const resolved = environment[name];
    if (resolved === undefined) throw new Error(`The host variable ${name} is unavailable.`);
    resolvedSecrets.push(resolved);
    output += resolved;
    index = end;
  }
  return output;
}

async function resolveValue(
  field: string,
  value: string,
  target: McpServerTestTarget,
  signal: AbortSignal,
  commandTimeoutMs: number,
  resolvedSecrets: string[],
): Promise<string> {
  if (!value.startsWith('!')) return interpolateEnvironment(value, process.env, resolvedSecrets);
  const command = value.slice(1).trim();
  if (!command) throw new Error(`The command-backed MCP field ${field} is empty.`);
  let result;
  try {
    result = await executeShellCommand({
      command,
      cwd: target.cwd,
      signal,
      timeoutMs: commandTimeoutMs,
      maxCaptureBytes: 64 * 1024,
    });
  } catch (error) {
    if (error instanceof ProcessAbortedError) throw error;
    throw new Error(`The command-backed MCP field ${field} could not be resolved.`);
  }
  if (result.timedOut) throw new Error(`The command-backed MCP field ${field} timed out.`);
  if (result.exitCode !== 0) throw new Error(`The command-backed MCP field ${field} failed.`);
  const resolved = result.output.trim();
  if (!resolved) throw new Error(`The command-backed MCP field ${field} returned no value.`);
  return resolved;
}

export interface ResolvedMcpOAuthSettings {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  resolvedSecrets: string[];
}

/** Resolve the optional OAuth client secret only after an OAuth challenge or explicit login. */
export async function resolveMcpOAuthSettings(
  target: McpServerTestTarget,
  signal: AbortSignal,
  commandTimeoutMs: number,
): Promise<ResolvedMcpOAuthSettings> {
  if (!('url' in target.config) || !target.config.oauth) return { resolvedSecrets: [] };
  const { clientId, clientSecret, scopes } = target.config.oauth;
  const resolvedSecrets: string[] = [];
  let resolvedClientSecret: string | undefined;
  if (clientSecret !== undefined) {
    resolvedClientSecret = await resolveValue(
      'oauth.clientSecret', clientSecret, target, signal, commandTimeoutMs, resolvedSecrets,
    );
    resolvedSecrets.push(resolvedClientSecret);
  }
  return {
    ...(clientId ? { clientId } : {}),
    ...(resolvedClientSecret ? { clientSecret: resolvedClientSecret } : {}),
    ...(scopes ? { scopes: [...scopes] } : {}),
    resolvedSecrets,
  };
}

export async function resolveRuntimeConfig(
  target: McpServerTestTarget,
  signal: AbortSignal,
  commandTimeoutMs: number,
): Promise<ResolvedRuntimeConfig> {
  const config = structuredClone(target.config);
  const resolvedSecrets: string[] = [];
  if ('command' in config) {
    const env = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(config.env ?? {})) {
      const resolved = await resolveValue(
        `env.${name}`, value, target, signal, commandTimeoutMs, resolvedSecrets,
      );
      env[name] = resolved;
      resolvedSecrets.push(resolved);
    }
    config.env = env;
  } else {
    const headers = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      const resolved = await resolveValue(
        `headers.${name}`, value, target, signal, commandTimeoutMs, resolvedSecrets,
      );
      headers[name] = resolved;
      resolvedSecrets.push(resolved);
    }
    config.headers = headers;
  }
  return { config, resolvedSecrets };
}

export const boundedMcpFetch: FetchLike = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: 'manual' });
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(contentLength)
    || Number(contentLength) > MCP_TEST_MAX_TRANSPORT_BYTES)) {
    void response.body?.cancel('mcp-response-limit').catch(() => undefined);
    throw new Error('The MCP test response exceeded its size limit.');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let transported = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let item: Awaited<ReturnType<typeof reader.read>>;
      try { item = await reader.read(); }
      catch {
        void reader.cancel('mcp-response-read-failed').catch(() => undefined);
        try { reader.releaseLock(); } catch { /* The source may still be settling. */ }
        controller.error(new Error('The MCP test response could not be read.'));
        return;
      }
      if (item.done) {
        try { reader.releaseLock(); } catch { /* The source may already have released it. */ }
        controller.close();
        return;
      }
      transported += item.value.byteLength;
      if (item.value.byteLength > MCP_TEST_MAX_TRANSPORT_CHUNK_BYTES
        || transported > MCP_TEST_MAX_TRANSPORT_BYTES) {
        void reader.cancel('mcp-response-limit').catch(() => undefined);
        try { reader.releaseLock(); } catch { /* Cancellation may still be settling. */ }
        controller.error(new Error('The MCP test response exceeded its size limit.'));
        return;
      }
      controller.enqueue(item.value);
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
      try { reader.releaseLock(); } catch { /* Cancellation may still be settling. */ }
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  try {
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
    });
  } catch { /* URL metadata is advisory; status and Location remain authoritative. */ }
  return wrapped;
};

export function safeEnvironment(configured: Record<string, string>): Record<string, string> {
  const environment = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(filteredProcessEnvironment())) {
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(configured)) {
    if (RESERVED_VARIABLES.has(name.toUpperCase())) {
      throw new Error(`The reserved environment name ${name} cannot be passed to an MCP server.`);
    }
    environment[name] = value;
  }
  environment.AI_HARNESS_MCP = '1';
  return environment;
}

function addSecret(set: Set<string>, value: string | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  set.add(trimmed);
  for (const word of trimmed.split(/\s+/u)) {
    if (word && !AUTH_SCHEME.test(word)) set.add(word);
  }
  try {
    const decoded = decodeURIComponent(trimmed);
    if (decoded) set.add(decoded);
  } catch {
    // A non-encoded literal needs no second representation.
  }
}

export function createRedactor(
  raw: McpServerRuntimeConfig,
  resolved: McpServerRuntimeConfig,
  resolvedSecrets: readonly string[],
): (text: string) => string {
  const secrets = new Set<string>();
  for (const { value } of runtimeValues(raw)) {
    if (value.startsWith('!')) addSecret(secrets, value.slice(1));
    else if (!value.includes('$')) addSecret(secrets, value);
  }
  if ('url' in raw) addSecret(secrets, raw.oauth?.clientSecret);
  for (const value of resolvedSecrets) addSecret(secrets, value);
  if ('url' in raw) {
    addSecret(secrets, raw.url);
    try {
      const url = new URL(raw.url);
      addSecret(secrets, url.username);
      addSecret(secrets, url.password);
      for (const value of url.searchParams.values()) addSecret(secrets, value);
      for (const part of url.pathname.split('/')) addSecret(secrets, part);
      addSecret(secrets, url.hash.slice(1));
    } catch {
      // The schema rejects this before runtime; retaining the full literal is safer here.
    }
  } else {
    if (raw.command.includes('/') || raw.command.includes('\\')) addSecret(secrets, raw.command);
    for (const argument of raw.args ?? []) {
      if (!/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(argument)) addSecret(secrets, argument);
    }
  }
  for (const { value } of runtimeValues(resolved)) addSecret(secrets, value);
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  return text => ordered.reduce((current, secret) => current.split(secret).join('•••'), text);
}

export function safeText(text: string, redact: (value: string) => string, maximum: number): string {
  // Redact before truncating so a credential crossing the output boundary cannot leak a prefix.
  return clip(redact(text).slice(0, 64 * 1024), maximum);
}

export function isNeedsAuth(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true;
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown } | undefined;
  return value?.code === 401 || value?.status === 401 || value?.statusCode === 401
    || value?.name === 'UnauthorizedError';
}

export interface PagedResult<T> {
  items: T[];
  count: number;
  truncated: boolean;
}

export async function collectPages<T>(
  request: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<PagedResult<T>> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let count = 0;
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MCP_TEST_MAX_PAGES; page++) {
    const result = await request(cursor);
    count += result.items.length;
    if (items.length < MCP_TEST_MAX_PAGED_ITEMS) {
      items.push(...result.items.slice(0, MCP_TEST_MAX_PAGED_ITEMS - items.length));
    }
    if (count > MCP_TEST_MAX_PAGED_ITEMS) truncated = true;
    if (!result.nextCursor) return {
      items,
      count: Math.min(count, MCP_TEST_MAX_PAGED_ITEMS),
      truncated,
    };
    if (cursors.has(result.nextCursor)) return {
      items,
      count: Math.min(count, MCP_TEST_MAX_PAGED_ITEMS),
      truncated: true,
    };
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return { items, count: Math.min(count, MCP_TEST_MAX_PAGED_ITEMS), truncated: true };
}

function describeTool(
  tool: {
    name: string;
    description?: string;
    title?: string;
    annotations?: { title?: string; readOnlyHint?: boolean };
  },
  config: McpServerRuntimeConfig,
  redact: (value: string) => string,
): McpServerTestTool {
  const description = [tool.description, tool.title, tool.annotations?.title]
    .find(value => typeof value === 'string' && value.trim())
    ?.split(/\r?\n/u).map(line => line.trim()).find(Boolean);
  return {
    name: safeText(tool.name, redact, DESCRIPTION_MAX_CHARS),
    ...(description ? { description: safeText(description, redact, DESCRIPTION_MAX_CHARS) } : {}),
    readOnly: tool.annotations?.readOnlyHint === true,
    exposure: mcpToolExposure(config, tool.name),
  };
}

export async function closeClient(
  client: Client,
  transport: Transport,
  waitMs: number,
  stdio: StdioClientTransport | undefined,
): Promise<void> {
  const closing = client.close().catch(() => undefined);
  const wait = delay(waitMs);
  const completed = await Promise.race([
    closing.then(() => true),
    wait.promise.then(() => false),
  ]);
  wait.cancel();
  if (completed) return;
  const pid = stdio?.pid;
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* The child already exited. */ }
    const force = setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* The child already exited. */ }
    }, 500);
    force.unref();
  }
  void transport.close().catch(() => undefined);
}

/**
 * Connect once, list bounded capabilities, redact all server-controlled text,
 * and close independently of the caller. OAuth is deliberately not initiated;
 * an HTTP challenge is reported as `needs-auth` for the separate sign-in flow.
 */
export async function connectMcpServerForTest(
  target: McpServerTestTarget,
  signal: AbortSignal,
  options: McpServerTestConnectOptions & { commandTimeoutMs?: number },
): Promise<TestRun> {
  const started = Date.now();
  let client: Client | undefined;
  let transport: Transport | undefined;
  let stdio: StdioClientTransport | undefined;
  let stderr: Buffer = Buffer.alloc(0);
  const rawConfig = target.config;
  let resolvedConfig = target.config;
  let resolvedSecrets: string[] = [];
  try {
    const resolved = await resolveRuntimeConfig(
      target,
      signal,
      options.commandTimeoutMs ?? MCP_TEST_COMMAND_TIMEOUT_MS,
    );
    resolvedConfig = resolved.config;
    resolvedSecrets = resolved.resolvedSecrets;
    if ('command' in resolvedConfig) {
      const config = resolvedConfig as McpStdioRuntimeConfig;
      stdio = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: target.cwd,
        env: safeEnvironment(config.env ?? {}),
        stderr: 'pipe',
      });
      stdio.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = appendBoundedTail(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), STDERR_MAX_BYTES);
      });
      transport = stdio;
    } else {
      const config = resolvedConfig as McpHttpRuntimeConfig;
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers, redirect: 'manual' },
        redirectPolicy: 'same-origin',
        fetch: boundedMcpFetch,
        reconnectionOptions: {
          maxReconnectionDelay: 500,
          initialReconnectionDelay: 100,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 0,
        },
      });
    }

    client = new Client({ name: 'ai-harness-mcp-test', version: '1.0.0' }, { capabilities: {} });
    const requestOptions = {
      signal,
      timeout: options.requestTimeoutMs,
      maxTotalTimeout: options.requestTimeoutMs,
    };
    await client.connect(transport, requestOptions);
    const capabilities = client.getServerCapabilities();
    const tools = capabilities?.tools
      ? await collectPages(async cursor => {
        const page = await client!.listTools(cursor ? { cursor } : {}, requestOptions);
        return { items: page.tools, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      })
      : { items: [], count: 0, truncated: false };
    const resources = capabilities?.resources
      ? await collectPages(async cursor => {
        const page = await client!.listResources(cursor ? { cursor } : {}, requestOptions);
        return { items: page.resources, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      })
      : { items: [], count: 0, truncated: false };
    const resourceTemplates = capabilities?.resources
      ? await collectPages(async cursor => {
        const page = await client!.listResourceTemplates(cursor ? { cursor } : {}, requestOptions);
        return { items: page.resourceTemplates, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      })
      : { items: [], count: 0, truncated: false };
    const prompts = capabilities?.prompts
      ? await collectPages(async cursor => {
        const page = await client!.listPrompts(cursor ? { cursor } : {}, requestOptions);
        return { items: page.prompts, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      })
      : { items: [], count: 0, truncated: false };
    const redact = createRedactor(rawConfig, resolvedConfig, resolvedSecrets);
    const info = client.getServerVersion();
    const stderrText = stderr.toString('utf8').trim();
    return {
      state: 'connected',
      durationMs: Date.now() - started,
      tools: tools.items.slice(0, MCP_TEST_MAX_TOOLS)
        .map(tool => describeTool(tool, resolvedConfig, redact)),
      toolCount: tools.count,
      resources: resources.count,
      resourceTemplates: resourceTemplates.count,
      prompts: prompts.count,
      ...(tools.truncated || resources.truncated || resourceTemplates.truncated || prompts.truncated
        ? { truncated: true as const }
        : {}),
      ...('command' in resolvedConfig ? { cwd: target.cwd } : {}),
      ...(stderrText ? { stderr: safeText(stderrText, redact, RESULT_TEXT_MAX_CHARS) } : {}),
      ...(info ? {
        serverInfo: {
          name: safeText(info.name, redact, DESCRIPTION_MAX_CHARS),
          version: safeText(info.version, redact, DESCRIPTION_MAX_CHARS),
          ...(typeof info.title === 'string' && info.title
            ? { title: safeText(info.title, redact, DESCRIPTION_MAX_CHARS) }
            : {}),
        },
      } : {}),
    };
  } catch (error) {
    const redact = createRedactor(rawConfig, resolvedConfig, resolvedSecrets);
    const stderrText = stderr.toString('utf8').trim();
    const timedOut = signal.aborted;
    return {
      state: isNeedsAuth(error) ? 'needs-auth' : 'failed',
      durationMs: Date.now() - started,
      tools: [],
      toolCount: 0,
      resources: 0,
      resourceTemplates: 0,
      prompts: 0,
      ...(timedOut ? { timedOut: true as const } : {}),
      ...('command' in rawConfig ? { cwd: target.cwd } : {}),
      ...(stderrText ? { stderr: safeText(stderrText, redact, RESULT_TEXT_MAX_CHARS) } : {}),
      ...(!isNeedsAuth(error) && !timedOut
        ? { error: safeText(errorMessage(error), redact, RESULT_TEXT_MAX_CHARS) }
        : {}),
    };
  } finally {
    if (client && transport) await closeClient(client, transport, options.closeWaitMs, stdio);
    else if (transport) await transport.close().catch(() => undefined);
  }
}

interface TestFlight {
  controller: AbortController;
  promise: Promise<McpServerTestResult>;
  subscribers: number;
  keepAlive: boolean;
  settled: boolean;
}

function statusIdentity(target: Pick<McpServerTestTarget, 'scope' | 'sourcePath' | 'name'>): string {
  return `${target.scope}\0${target.sourcePath}\0${target.name}`;
}

function statusKey(target: Pick<McpServerTestTarget, 'scope' | 'sourcePath' | 'name' | 'configKey'>): string {
  return `${statusIdentity(target)}\0${target.configKey}`;
}

/** Shared Core owner for bounded tests, command-value serialization, joins and fresh status. */
export class McpServerTester {
  private readonly deadlineMs: number;
  private readonly requestTimeoutMs: number;
  private readonly closeWaitMs: number;
  private readonly commandTimeoutMs: number;
  private readonly statusLimit: number;
  private readonly now: () => number;
  private readonly connect: McpServerTestConnect;
  private readonly flights = new Map<string, TestFlight>();
  private readonly statuses = new Map<string, McpServerTestResult>();
  private commandTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: McpServerTesterOptions = {}) {
    this.deadlineMs = boundedInteger(options.deadlineMs, MCP_TEST_DEADLINE_MS);
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, MCP_TEST_REQUEST_TIMEOUT_MS);
    this.closeWaitMs = boundedInteger(options.closeWaitMs, MCP_TEST_CLOSE_WAIT_MS);
    this.commandTimeoutMs = boundedInteger(options.commandTimeoutMs, MCP_TEST_COMMAND_TIMEOUT_MS);
    this.statusLimit = boundedInteger(options.statusLimit, MCP_TEST_STATUS_LIMIT);
    this.now = options.now ?? Date.now;
    this.connect = options.connect ?? ((target, signal, connectOptions) => connectMcpServerForTest(
      target,
      signal,
      { ...connectOptions, commandTimeoutMs: this.commandTimeoutMs },
    ));
  }

  test(
    target: McpServerTestTarget,
    signal?: AbortSignal,
    validate?: McpServerTestValidate,
  ): Promise<McpServerTestResult> {
    if (this.closed) return Promise.reject(new Error('The MCP tester is closed.'));
    if (signal?.aborted) return Promise.reject(this.abortError());
    const key = `${statusKey(target)}\0${target.cwd}`;
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      flight = {
        controller,
        promise: this.run(target, controller.signal, validate),
        subscribers: 0,
        keepAlive: !signal,
        settled: false,
      };
      this.flights.set(key, flight);
      void flight.promise.finally(() => {
        flight!.settled = true;
        if (this.flights.get(key) === flight) this.flights.delete(key);
      }).catch(() => undefined);
    } else if (!signal) {
      flight.keepAlive = true;
    }
    return signal ? this.subscribe(flight, signal) : flight.promise;
  }

  decorateInventory(inventory: McpConfigInventory): McpConfigInventory {
    const identities = new Map<string, string>();
    for (const server of inventory.servers) identities.set(statusIdentity(server), server.configKey);
    for (const key of this.statuses.keys()) {
      const separator = key.lastIndexOf('\0');
      const identity = key.slice(0, separator);
      const configKey = key.slice(separator + 1);
      const current = identities.get(identity);
      if (current !== undefined && current !== configKey) this.statuses.delete(key);
    }
    return {
      ...inventory,
      servers: inventory.servers.map(server => {
        const testStatus = this.statuses.get(statusKey(server));
        return testStatus ? { ...server, testStatus: structuredClone(testStatus) } : server;
      }),
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const flights = [...this.flights.values()];
    for (const flight of flights) flight.controller.abort('shutdown');
    const wait = delay(this.closeWaitMs + 1_000);
    await Promise.race([Promise.allSettled(flights.map(flight => flight.promise)), wait.promise]);
    wait.cancel();
  }

  private abortError(): Error {
    const error = new Error('The MCP test request was aborted.');
    error.name = 'AbortError';
    return error;
  }

  private subscribe(flight: TestFlight, signal: AbortSignal): Promise<McpServerTestResult> {
    flight.subscribers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const onAbort = (): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        flight.subscribers--;
        if (flight.subscribers === 0 && !flight.keepAlive && !flight.settled) {
          flight.controller.abort('client-aborted');
        }
        reject(this.abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      void flight.promise.then(result => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        flight.subscribers--;
        resolve(result);
      }, error => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        flight.subscribers--;
        reject(error);
      });
    });
  }

  private async takeCommandSlot(signal: AbortSignal): Promise<{ turn: boolean; release: () => void }> {
    const ahead = this.commandTail;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    this.commandTail = ahead.then(() => held);
    const wait = delay(this.deadlineMs);
    const outcome = await Promise.race([
      ahead.then(() => 'turn' as const),
      wait.promise.then(() => 'timeout' as const),
      abortPromise(signal).then(() => 'aborted' as const),
    ]);
    wait.cancel();
    if (outcome !== 'turn') release();
    return { turn: outcome === 'turn', release };
  }

  private remember(target: McpServerTestTarget, result: McpServerTestResult): void {
    const key = statusKey(target);
    this.statuses.delete(key);
    this.statuses.set(key, structuredClone(result));
    while (this.statuses.size > this.statusLimit) {
      const oldest = this.statuses.keys().next().value as string | undefined;
      if (!oldest) break;
      this.statuses.delete(oldest);
    }
  }

  private async run(
    target: McpServerTestTarget,
    signal: AbortSignal,
    validate: McpServerTestValidate | undefined,
  ): Promise<McpServerTestResult> {
    const queuedAt = this.now();
    const slot = mcpTestRunsCommand(target.config) ? await this.takeCommandSlot(signal) : undefined;
    const queuedMs = slot ? Math.max(0, this.now() - queuedAt) : 0;
    if (slot && !slot.turn) {
      const result: McpServerTestResult = {
        state: 'failed',
        testedAt: new Date(this.now()).toISOString(),
        durationMs: 0,
        tools: [],
        toolCount: 0,
        resources: 0,
        resourceTemplates: 0,
        prompts: 0,
        queueTimedOut: true,
        ...(queuedMs > 0 ? { queuedMs } : {}),
      };
      if (!signal.aborted) this.remember(target, result);
      return result;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const deadline = setTimeout(() => controller.abort('deadline'), this.deadlineMs);
    deadline.unref?.();
    try {
      await validate?.();
      const started = this.now();
      const fallback = abortPromise(controller.signal)
        .then(async () => {
          const grace = delay(this.closeWaitMs + 500);
          await grace.promise;
          return {
            state: 'failed' as const,
            durationMs: Math.max(0, this.now() - started),
            tools: [],
            toolCount: 0,
            resources: 0,
            resourceTemplates: 0,
            prompts: 0,
            timedOut: true as const,
          };
        });
      const completed = await Promise.race([
        this.connect(target, controller.signal, {
          requestTimeoutMs: this.requestTimeoutMs,
          closeWaitMs: this.closeWaitMs,
        }),
        fallback,
      ]);
      const run: TestRun = controller.signal.aborted && !completed.timedOut
        ? {
          state: 'failed',
          durationMs: Math.max(0, this.now() - started),
          tools: [],
          toolCount: 0,
          resources: 0,
          resourceTemplates: 0,
          prompts: 0,
          timedOut: true,
        }
        : completed;
      const result: McpServerTestResult = {
        ...run,
        testedAt: new Date(this.now()).toISOString(),
        ...(queuedMs > 0 ? { queuedMs } : {}),
      };
      if (!signal.aborted) this.remember(target, result);
      return result;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      slot?.release();
    }
  }
}
