import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ExtensionRuntimeContext, ExtensionTool, ExtensionToolResult } from '../extensions/extension-registry.js';
import type { ProjectTrustManager } from '../security/project-trust.js';
import type { Session } from '../types/index.js';
import {
  inspectMcpConfig,
  readMcpServerTestTarget,
  type McpConfigInventory,
  type McpExposure,
  type McpServerInventoryEntry,
  type McpServerRuntimeStatus,
  type McpServerTestTarget,
  type McpStdioRuntimeConfig,
} from './config-inventory.js';
import {
  MCP_TEST_CLOSE_WAIT_MS,
  MCP_TEST_COMMAND_TIMEOUT_MS,
  MCP_TEST_DEADLINE_MS,
  MCP_TEST_MAX_TOOLS,
  MCP_TEST_REQUEST_TIMEOUT_MS,
  appendBoundedTail,
  boundedMcpFetch,
  closeClient,
  collectPages,
  createRedactor,
  isNeedsAuth,
  mcpTestRunsCommand,
  resolveRuntimeConfig,
  safeEnvironment,
  safeText,
} from './server-test.js';

export const MCP_EXTENSION_ID = 'builtin:mcp';
export const MCP_RUNTIME_STARTUP_WAIT_MS = MCP_TEST_DEADLINE_MS;
export const MCP_RUNTIME_IDLE_MS = 10 * 60 * 1_000;
export const MCP_RUNTIME_MAX_INPUT_BYTES = 1024 * 1024;
export const MCP_RUNTIME_MAX_OUTPUT_CHARS = 64 * 1024;
export const MCP_RUNTIME_MAX_SERVERS = 32;
export const MCP_RUNTIME_MAX_TOOLS = 1_000;

const MCP_RUNTIME_BINDING_HISTORY_MAX = MCP_RUNTIME_MAX_TOOLS * 8;
const MCP_RUNTIME_STDERR_BYTES = 64 * 1024;
const MCP_RUNTIME_DESCRIPTION_CHARS = 8 * 1024;
const MCP_RUNTIME_SCHEMA_BYTES = 64 * 1024;
const MCP_RUNTIME_STATUS_LIMIT = 500;
const MCP_TOOL_NAME_MAX = 64;

export type HostedMcpTool = ExtensionTool & {
  extensionId: typeof MCP_EXTENSION_ID;
  exposure: McpExposure;
  readOnly: boolean;
  mcp: { scope: 'global' | 'project'; server: string; tool: string };
};

interface RemoteTool {
  /** Redacted display identity used outside the transport boundary. */
  name: string;
  /** Exact protocol identity retained only for calls to the connected server. */
  remoteName: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
}

interface ConnectionCallbacks {
  onToolsChanged(tools: RemoteTool[]): void;
  onClose(): void;
  onError(error: unknown): void;
}

export interface McpHostConnection {
  tools: RemoteTool[];
  callTool(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
  redact(value: string): string;
}

export interface McpHostConnectOptions {
  requestTimeoutMs: number;
  closeWaitMs: number;
  commandTimeoutMs: number;
  callbacks: ConnectionCallbacks;
}

export type McpHostConnect = (
  target: McpServerTestTarget,
  signal: AbortSignal,
  options: McpHostConnectOptions,
) => Promise<McpHostConnection>;

export interface McpSessionHostOptions {
  agentDir: string;
  trustManager?: ProjectTrustManager;
  resolveWorkingDirectory?: (configured: string, base: string) => Promise<string>;
  startupWaitMs?: number;
  idleMs?: number;
  deadlineMs?: number;
  requestTimeoutMs?: number;
  closeWaitMs?: number;
  commandTimeoutMs?: number;
  statusLimit?: number;
  now?: () => number;
  connect?: McpHostConnect;
}

export interface PrepareMcpSessionOptions {
  sessionId: string;
  cwd: string;
  preset?: Session['toolPreset'];
  signal?: AbortSignal;
}

export interface PreparedMcpTools {
  /** Connected direct tools available without discovery. */
  tools: HostedMcpTool[];
  /** Connected codemode/deferred tools whose schemas remain undeclared. */
  discoverableTools?: HostedMcpTool[];
  /** True while an eligible indirect server is connected or still resolving. */
  hasPotentialDiscoverableTools?: boolean;
  /** Fresh connected indirect metadata after tool-list notifications. */
  currentDiscoverableTools?(): HostedMcpTool[];
  /** Wait abortably for indirect connection attempts only after explicit discovery. */
  waitForDiscoverableTools?(signal?: AbortSignal): Promise<HostedMcpTool[]>;
  has(name: string): boolean;
  execute(
    name: string,
    input: unknown,
    context: ExtensionRuntimeContext,
    signal?: AbortSignal,
  ): Promise<ExtensionToolResult>;
}

interface ConnectionRecord {
  key: string;
  sessionId: string;
  target: McpServerTestTarget;
  exposure: McpExposure;
  state: McpServerRuntimeStatus['state'];
  updatedAt: string;
  tools: RemoteTool[];
  controller: AbortController;
  connection?: McpHostConnection;
  ready: Promise<void>;
  error?: string;
}

interface HostedSession {
  cwd: string;
  records: Map<string, ConnectionRecord>;
  tail: Promise<void>;
  released: boolean;
  idleTimer?: NodeJS.Timeout;
}

interface BoundTool {
  record: ConnectionRecord;
  remote: RemoteTool;
  requireReadOnly: boolean;
}

interface PreparedToolSnapshot {
  tools: HostedMcpTool[];
  discoverableTools: HostedMcpTool[];
  bindings: Map<string, BoundTool>;
}

function boundedInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function abortError(message = 'The MCP operation was aborted.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exposure(target: McpServerTestTarget): McpExposure {
  return target.config.exposure === 'codemode' || target.config.exposure === 'deferred'
    ? target.config.exposure
    : 'direct';
}

function targetIdentity(target: McpServerTestTarget): string {
  return `${target.scope}\0${target.name}\0${target.configKey}\0${target.cwd}`;
}

function statusIdentity(target: Pick<McpServerTestTarget, 'scope' | 'name' | 'configKey'>): string {
  return `${target.scope}\0${target.name}\0${target.configKey}`;
}

function sanitizeToolPart(value: string): string {
  const normalized = value.normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^[_-]+|[_-]+$/gu, '');
  return normalized || 'tool';
}

function toolHash(scope: string, server: string, tool: string): string {
  return createHash('sha256').update(`${scope}\0${server}\0${tool}`).digest('hex').slice(0, 10);
}

function toolBaseName(server: string, tool: string): string {
  return `mcp__${sanitizeToolPart(server)}__${sanitizeToolPart(tool)}`;
}

function safeSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'object', properties: {} };
  }
  try {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, 'utf8') > MCP_RUNTIME_SCHEMA_BYTES) {
      return { type: 'object', properties: {} };
    }
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { type: 'object', properties: {} };
  }
}

function normalizeTools(tools: Tool[], redact: (value: string) => string): RemoteTool[] {
  const seen = new Set<string>();
  const normalized: RemoteTool[] = [];
  for (const tool of tools) {
    if (normalized.length >= MCP_TEST_MAX_TOOLS) break;
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name || name.length > 500 || seen.has(name)) continue;
    seen.add(name);
    const safeName = safeText(name, redact, 500).trim() || 'tool';
    normalized.push({
      name: safeName,
      remoteName: name,
      description: typeof tool.description === 'string'
        ? safeText(tool.description, redact, MCP_RUNTIME_DESCRIPTION_CHARS)
        : `MCP tool ${safeName}`,
      parameters: safeSchema(tool.inputSchema),
      readOnly: tool.annotations?.readOnlyHint === true,
    });
  }
  return normalized;
}

function normalizedInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MCP tool input must be a JSON object.');
  }
  let text: string;
  try { text = JSON.stringify(input); }
  catch { throw new Error('MCP tool input must be JSON-serializable.'); }
  if (Buffer.byteLength(text, 'utf8') > MCP_RUNTIME_MAX_INPUT_BYTES) {
    throw new Error('MCP tool input exceeded its size limit.');
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); }
  catch { return '[unserializable MCP value]'; }
}

function formatToolResult(result: CallToolResult, redact: (value: string) => string): ExtensionToolResult {
  const output: string[] = [];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (item.type === 'text') {
      output.push(item.text);
    } else if (item.type === 'image' || item.type === 'audio') {
      output.push(`[${item.type} ${item.mimeType}; binary payload omitted]`);
    } else if (item.type === 'resource') {
      const resource = item.resource;
      if ('text' in resource && typeof resource.text === 'string') output.push(resource.text);
      else output.push(`[resource ${resource.uri}; binary payload omitted]`);
    } else if (item.type === 'resource_link') {
      output.push(`[resource ${item.name}: ${item.uri}]`);
    } else {
      output.push(safeJson(item));
    }
  }
  if (result.structuredContent !== undefined) {
    output.push(safeJson(result.structuredContent));
  }
  const text = safeText(output.join('\n') || '(MCP tool returned no content)', redact, MCP_RUNTIME_MAX_OUTPUT_CHARS);
  return {
    content: text,
    isError: result.isError === true,
    details: { mcp: true, contentItems: Array.isArray(result.content) ? result.content.length : 0 },
  };
}

async function listRemoteTools(
  client: Client,
  requestTimeoutMs: number,
  redact: (value: string) => string,
  signal?: AbortSignal,
): Promise<RemoteTool[]> {
  const listed = await collectPages<Tool>(async cursor => {
    const page = await client.listTools(
      cursor ? { cursor } : undefined,
      {
        timeout: requestTimeoutMs,
        maxTotalTimeout: requestTimeoutMs,
        resetTimeoutOnProgress: true,
        ...(signal ? { signal } : {}),
      },
    );
    return { items: page.tools, nextCursor: page.nextCursor };
  });
  return normalizeTools(listed.items, redact);
}

async function connectMcpSession(
  target: McpServerTestTarget,
  signal: AbortSignal,
  options: McpHostConnectOptions,
): Promise<McpHostConnection> {
  let stderr: Buffer = Buffer.alloc(0);
  const { config, resolvedSecrets } = await resolveRuntimeConfig(target, signal, options.commandTimeoutMs);
  const redact = createRedactor(target.config, config, resolvedSecrets);
  const client = new Client({ name: 'ai-harness-session', version: '1.0.0' }, { capabilities: {} });
  let transport: Transport;
  let stdio: StdioClientTransport | undefined;

  if ('command' in config) {
    const stdioConfig = config as McpStdioRuntimeConfig;
    stdio = new StdioClientTransport({
      command: stdioConfig.command,
      args: stdioConfig.args ?? [],
      cwd: target.cwd,
      env: safeEnvironment(stdioConfig.env ?? {}),
      stderr: 'pipe',
    });
    transport = stdio;
    stdio.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendBoundedTail(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), MCP_RUNTIME_STDERR_BYTES);
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers ?? {}, redirect: 'manual' },
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

  client.onerror = error => options.callbacks.onError(error);
  client.onclose = () => options.callbacks.onClose();
  try {
    await client.connect(transport, {
      signal,
      timeout: options.requestTimeoutMs,
      maxTotalTimeout: options.requestTimeoutMs,
      resetTimeoutOnProgress: true,
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        options.callbacks.onToolsChanged(await listRemoteTools(client, options.requestTimeoutMs, redact));
      } catch (error) {
        options.callbacks.onError(error);
      }
    });
    const tools = await listRemoteTools(client, options.requestTimeoutMs, redact, signal);
    return {
      tools,
      redact,
      async callTool(name, input, callSignal) {
        return client.callTool(
          { name, arguments: input },
          undefined,
          {
            timeout: options.requestTimeoutMs,
            maxTotalTimeout: options.requestTimeoutMs,
            resetTimeoutOnProgress: true,
            ...(callSignal ? { signal: callSignal } : {}),
          },
        ) as Promise<CallToolResult>;
      },
      close: () => closeClient(client, transport, options.closeWaitMs, stdio),
    };
  } catch (error) {
    await closeClient(client, transport, options.closeWaitMs, stdio).catch(() => undefined);
    const stderrText = stderr.length ? safeText(stderr.toString('utf8'), redact, 2_000) : '';
    if (stderrText && error instanceof Error) error.message = `${error.message}\n${stderrText}`;
    throw error;
  }
}

/**
 * Persistent, session-scoped MCP host shared by CLI, RPC and Web runtimes.
 * Configuration and trust are re-read before every prompt; direct exposure only
 * publishes tools that are connected within a short, abortable startup window.
 */
export class McpSessionHost {
  private readonly agentDir: string;
  private readonly trustManager?: ProjectTrustManager;
  private readonly resolveWorkingDirectory?: (configured: string, base: string) => Promise<string>;
  private readonly startupWaitMs: number;
  private readonly idleMs: number;
  private readonly deadlineMs: number;
  private readonly requestTimeoutMs: number;
  private readonly closeWaitMs: number;
  private readonly commandTimeoutMs: number;
  private readonly statusLimit: number;
  private readonly now: () => number;
  private readonly connect: McpHostConnect;
  private readonly sessions = new Map<string, HostedSession>();
  private readonly statuses = new Map<string, McpServerRuntimeStatus>();
  private commandTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: McpSessionHostOptions) {
    this.agentDir = options.agentDir;
    this.trustManager = options.trustManager;
    this.resolveWorkingDirectory = options.resolveWorkingDirectory;
    this.startupWaitMs = boundedInteger(options.startupWaitMs, MCP_RUNTIME_STARTUP_WAIT_MS);
    this.idleMs = boundedInteger(options.idleMs, MCP_RUNTIME_IDLE_MS);
    this.deadlineMs = boundedInteger(options.deadlineMs, MCP_TEST_DEADLINE_MS);
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, MCP_TEST_REQUEST_TIMEOUT_MS);
    this.closeWaitMs = boundedInteger(options.closeWaitMs, MCP_TEST_CLOSE_WAIT_MS);
    this.commandTimeoutMs = boundedInteger(options.commandTimeoutMs, MCP_TEST_COMMAND_TIMEOUT_MS);
    this.statusLimit = boundedInteger(options.statusLimit, MCP_RUNTIME_STATUS_LIMIT);
    this.now = options.now ?? Date.now;
    this.connect = options.connect ?? connectMcpSession;
  }

  async prepareForPrompt(options: PrepareMcpSessionOptions): Promise<PreparedMcpTools> {
    if (this.closed) throw new Error('The MCP session host is closed.');
    throwIfAborted(options.signal);
    let session = this.sessions.get(options.sessionId);
    if (!session || session.released) {
      session = { cwd: options.cwd, records: new Map(), tail: Promise.resolve(), released: false };
      this.sessions.set(options.sessionId, session);
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    const run = session.tail.then(() => this.syncSession(options.sessionId, session!, options));
    session.tail = run.then(() => undefined, () => undefined);
    return options.signal ? Promise.race([run, waitForAbort(options.signal)]) : run;
  }

  getPreparedTools(sessionId: string, preset?: Session['toolPreset']): PreparedMcpTools {
    const session = this.sessions.get(sessionId);
    return this.buildPreparedTools(session, preset);
  }

  decorateInventory(inventory: McpConfigInventory): McpConfigInventory {
    const current = new Set(inventory.servers.map(server => `${server.scope}\0${server.name}\0${server.configKey}`));
    for (const key of this.statuses.keys()) {
      if (!current.has(key)) this.statuses.delete(key);
    }
    return {
      ...inventory,
      servers: inventory.servers.map(server => {
        const runtimeStatus = this.statuses.get(`${server.scope}\0${server.name}\0${server.configKey}`);
        return runtimeStatus ? { ...server, runtimeStatus: structuredClone(runtimeStatus) } : server;
      }),
    };
  }

  /** Mark prompt work complete and begin the idle-retention window. */
  finishPrompt(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.released || this.closed) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => { void this.releaseSession(sessionId); }, this.idleMs);
    session.idleTimer.unref?.();
  }

  async reconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.released) return;
    await this.closeRecords(session.records.values());
    session.records.clear();
  }

  async releaseSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.released = true;
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    await this.closeRecords(session.records.values());
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      session.released = true;
      if (session.idleTimer) clearTimeout(session.idleTimer);
    }
    await Promise.allSettled(sessions.map(session => this.closeRecords(session.records.values())));
  }

  private assertSessionActive(session: HostedSession, signal?: AbortSignal): void {
    throwIfAborted(signal);
    if (this.closed || session.released) throw abortError('The MCP session was released.');
  }

  private async syncSession(
    sessionId: string,
    session: HostedSession,
    options: PrepareMcpSessionOptions,
  ): Promise<PreparedMcpTools> {
    this.assertSessionActive(session, options.signal);
    if (session.cwd !== options.cwd) {
      await this.closeRecords(session.records.values());
      this.assertSessionActive(session, options.signal);
      session.records.clear();
      session.cwd = options.cwd;
    }

    const inventory = await inspectMcpConfig({
      agentDir: this.agentDir,
      cwd: options.cwd,
      trustManager: this.trustManager,
    });
    this.assertSessionActive(session, options.signal);
    const desired = new Set<string>();
    const directReady: Promise<void>[] = [];
    const effectiveEntries = inventory.servers.filter(server => (
      server.valid && server.enabled && !(server.scope === 'global' && server.shadowedByProject)
    ));
    const entries = effectiveEntries.slice(0, MCP_RUNTIME_MAX_SERVERS);
    for (const entry of effectiveEntries.slice(MCP_RUNTIME_MAX_SERVERS)) {
      this.rememberStatus(entry, {
        state: 'failed', sessionId, updatedAt: new Date(this.now()).toISOString(),
        error: `The MCP session server limit (${MCP_RUNTIME_MAX_SERVERS}) was reached.`,
      });
    }

    for (const entry of entries) {
      this.assertSessionActive(session, options.signal);
      let target: McpServerTestTarget;
      try {
        target = await readMcpServerTestTarget({
          agentDir: this.agentDir,
          scope: entry.scope,
          name: entry.name,
          ...(entry.scope === 'project' ? { cwd: options.cwd } : {}),
          defaultCwd: options.cwd,
          trustManager: this.trustManager,
          resolveWorkingDirectory: this.resolveWorkingDirectory,
        });
        this.assertSessionActive(session, options.signal);
      } catch (error) {
        this.assertSessionActive(session, options.signal);
        this.rememberStatus(entry, {
          state: 'failed', sessionId, updatedAt: new Date(this.now()).toISOString(),
          error: safeText(errorMessage(error), value => value, 500),
        });
        continue;
      }
      if (target.configKey !== entry.configKey) {
        this.rememberStatus(entry, {
          state: 'failed', sessionId, updatedAt: new Date(this.now()).toISOString(),
          error: 'The MCP server configuration changed; retry the prompt.',
        });
        continue;
      }
      const key = targetIdentity(target);
      desired.add(key);
      const replacements = [...session.records.entries()]
        .filter(([existingKey, existing]) => existingKey !== key && existing.target.name === target.name);
      for (const [existingKey] of replacements) session.records.delete(existingKey);
      if (replacements.length) {
        await this.closeRecords(replacements.map(([, existing]) => existing));
        this.assertSessionActive(session, options.signal);
      }
      let record = session.records.get(key);
      if (record && record.state !== 'connected' && record.state !== 'connecting') {
        session.records.delete(key);
        await this.closeRecords([record]);
        this.assertSessionActive(session, options.signal);
        record = undefined;
      }
      if (!record) {
        record = this.startConnection(sessionId, target);
        session.records.set(key, record);
      }
      if (record.exposure === 'direct') directReady.push(record.ready);
    }

    const stale: ConnectionRecord[] = [];
    for (const [key, record] of session.records) {
      if (desired.has(key)) continue;
      session.records.delete(key);
      stale.push(record);
    }
    if (stale.length) {
      await this.closeRecords(stale);
      this.assertSessionActive(session, options.signal);
    }
    if (directReady.length) await this.waitForStartup(directReady, options.signal);
    this.assertSessionActive(session, options.signal);

    return this.buildPreparedTools(session, options.preset);
  }

  private startConnection(sessionId: string, target: McpServerTestTarget): ConnectionRecord {
    const controller = new AbortController();
    const record: ConnectionRecord = {
      key: targetIdentity(target),
      sessionId,
      target,
      exposure: exposure(target),
      state: 'connecting',
      updatedAt: new Date(this.now()).toISOString(),
      tools: [],
      controller,
      ready: Promise.resolve(),
    };
    this.updateStatus(sessionId, record);
    const deadline = setTimeout(() => controller.abort('mcp-connect-deadline'), this.deadlineMs);
    deadline.unref?.();
    record.ready = this.connectBounded(target, controller.signal, {
      requestTimeoutMs: this.requestTimeoutMs,
      closeWaitMs: this.closeWaitMs,
      commandTimeoutMs: this.commandTimeoutMs,
      callbacks: {
        onToolsChanged: tools => {
          if (record.state !== 'connected') return;
          record.tools = tools;
          this.updateStatus(sessionId, record);
        },
        onClose: () => {
          if (record.state === 'failed' || record.state === 'needs-auth') return;
          record.state = controller.signal.aborted ? 'closed' : 'disconnected';
          record.error = controller.signal.aborted ? undefined : 'The MCP server disconnected.';
          record.updatedAt = new Date(this.now()).toISOString();
          this.updateStatus(sessionId, record);
        },
        onError: error => {
          if (record.state !== 'connected') return;
          record.error = safeText(errorMessage(error), record.connection?.redact ?? (value => value), 500);
          this.updateStatus(sessionId, record);
        },
      },
    }).then(connection => {
      clearTimeout(deadline);
      if (controller.signal.aborted) {
        void connection.close();
        return;
      }
      record.connection = connection;
      record.tools = connection.tools;
      record.state = 'connected';
      record.error = undefined;
      record.updatedAt = new Date(this.now()).toISOString();
      this.updateStatus(sessionId, record);
    }).catch(error => {
      clearTimeout(deadline);
      if (controller.signal.aborted) {
        if (controller.signal.reason === 'mcp-connect-deadline') {
          record.state = 'failed';
          record.error = 'The MCP connection timed out.';
        } else {
          record.state = 'closed';
          record.error = undefined;
        }
      } else {
        record.state = isNeedsAuth(error) ? 'needs-auth' : 'failed';
        const redact = record.connection?.redact ?? createRedactor(target.config, target.config, []);
        record.error = safeText(errorMessage(error), redact, 500);
      }
      record.updatedAt = new Date(this.now()).toISOString();
      this.updateStatus(sessionId, record);
    });
    return record;
  }

  private buildToolSnapshot(session: HostedSession | undefined, preset?: Session['toolPreset']): PreparedToolSnapshot {
    const candidates: Array<{
      record: ConnectionRecord;
      connection: McpHostConnection;
      remote: RemoteTool;
      base: string;
    }> = [];
    if (preset !== 'chat-only') {
      outer: for (const record of session?.records.values() ?? []) {
        if (record.state !== 'connected' || !record.connection) continue;
        for (const remote of record.tools) {
          if (preset === 'read-only' && !remote.readOnly) continue;
          candidates.push({
            record,
            connection: record.connection,
            remote,
            base: toolBaseName(record.target.name, remote.name),
          });
          if (candidates.length >= MCP_RUNTIME_MAX_TOOLS) break outer;
        }
      }
    }
    const counts = new Map<string, number>();
    for (const candidate of candidates) counts.set(candidate.base, (counts.get(candidate.base) ?? 0) + 1);
    const bindings = new Map<string, BoundTool>();
    const tools: HostedMcpTool[] = [];
    const discoverableTools: HostedMcpTool[] = [];
    for (const candidate of candidates) {
      const needsHash = (counts.get(candidate.base) ?? 0) > 1 || candidate.base.length > MCP_TOOL_NAME_MAX;
      const suffix = `__${toolHash(candidate.record.target.scope, candidate.record.target.name, candidate.remote.remoteName)}`;
      const name = needsHash
        ? `${candidate.base.slice(0, MCP_TOOL_NAME_MAX - suffix.length)}${suffix}`
        : candidate.base;
      if (bindings.has(name)) continue;
      bindings.set(name, {
        record: candidate.record,
        remote: candidate.remote,
        requireReadOnly: preset === 'read-only',
      });
      const tool: HostedMcpTool = {
        name,
        description: `[MCP ${candidate.record.target.name}] ${candidate.remote.description}`,
        parameters: candidate.remote.parameters,
        extensionId: MCP_EXTENSION_ID,
        exposure: candidate.record.exposure,
        namespace: {
          name: `mcp__${sanitizeToolPart(candidate.record.target.name)}`,
          description: candidate.record.target.config.description
            ? safeText(
                candidate.record.target.config.description,
                candidate.connection.redact,
                MCP_RUNTIME_DESCRIPTION_CHARS,
              )
            : `MCP server ${candidate.record.target.name}`,
        },
        readOnly: candidate.remote.readOnly,
        mcp: {
          scope: candidate.record.target.scope,
          server: candidate.record.target.name,
          tool: candidate.remote.name,
        },
        execute: (input, context, signal) => this.executeBinding(name, bindings, input, context, signal),
      };
      if (candidate.record.exposure === 'direct') tools.push(tool);
      else discoverableTools.push(tool);
    }
    return { tools, discoverableTools, bindings };
  }

  private buildPreparedTools(session: HostedSession | undefined, preset?: Session['toolPreset']): PreparedMcpTools {
    const initial = this.buildToolSnapshot(session, preset);
    const hasPotentialDiscoverableTools = preset !== 'chat-only' && [...(session?.records.values() ?? [])]
      .some(record => record.exposure !== 'direct'
        && (record.state === 'connecting' || record.state === 'connected'));
    const knownBindings = new Map(initial.bindings);
    const current = (): PreparedToolSnapshot => {
      const snapshot = this.buildToolSnapshot(session, preset);
      for (const [name, binding] of snapshot.bindings) {
        if (knownBindings.has(name)) continue;
        if (knownBindings.size < MCP_RUNTIME_BINDING_HISTORY_MAX) knownBindings.set(name, binding);
        else snapshot.bindings.delete(name);
      }
      return {
        ...snapshot,
        tools: snapshot.tools.filter(tool => snapshot.bindings.has(tool.name)),
        discoverableTools: snapshot.discoverableTools.filter(tool => snapshot.bindings.has(tool.name)),
      };
    };
    return {
      tools: initial.tools,
      discoverableTools: initial.discoverableTools,
      hasPotentialDiscoverableTools,
      currentDiscoverableTools: () => current().discoverableTools,
      waitForDiscoverableTools: async signal => {
        if (!session || session.released || preset === 'chat-only') return [];
        const pending = [...session.records.values()]
          .filter(record => record.exposure !== 'direct')
          .map(record => record.ready);
        if (pending.length > 0) {
          const settled = Promise.allSettled(pending).then(() => undefined);
          await (signal ? Promise.race([settled, waitForAbort(signal)]) : settled);
        }
        this.assertSessionActive(session, signal);
        return current().discoverableTools;
      },
      has: name => {
        current();
        return knownBindings.has(name.toLowerCase());
      },
      execute: (name, input, context, signal) => {
        current();
        return this.executeBinding(name.toLowerCase(), knownBindings, input, context, signal);
      },
    };
  }

  private async executeBinding(
    name: string,
    bindings: Map<string, BoundTool>,
    input: unknown,
    _context: ExtensionRuntimeContext,
    signal?: AbortSignal,
  ): Promise<ExtensionToolResult> {
    throwIfAborted(signal);
    const binding = bindings.get(name);
    if (!binding) throw new Error(`Unknown or disabled MCP tool: ${name}`);
    const { record, remote } = binding;
    if (record.state !== 'connected' || !record.connection) {
      throw new Error(`MCP server ${record.target.name} is not connected.`);
    }
    const currentTool = record.tools.find(tool => tool.remoteName === remote.remoteName);
    if (!currentTool) {
      throw new Error(`MCP tool ${record.target.name}/${remote.name} is no longer available.`);
    }
    if (binding.requireReadOnly && !currentTool.readOnly) {
      throw new Error(`MCP tool ${record.target.name}/${remote.name} is not allowed in a read-only session.`);
    }
    let result: CallToolResult;
    try {
      result = await record.connection.callTool(remote.remoteName, normalizedInput(input), signal);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      record.state = 'disconnected';
      record.error = safeText(errorMessage(error), record.connection.redact, 500);
      record.updatedAt = new Date(this.now()).toISOString();
      this.updateStatus(record.sessionId, record);
      await record.connection.close().catch(() => undefined);
      throw new Error(`MCP tool ${record.target.name}/${remote.name} failed: ${record.error}`);
    }
    const formatted = formatToolResult(result, record.connection.redact);
    return {
      ...formatted,
      details: {
        ...formatted.details as Record<string, unknown>,
        server: record.target.name,
        tool: remote.name,
        scope: record.target.scope,
        readOnly: remote.readOnly,
      },
    };
  }

  private async waitForStartup(promises: Promise<void>[], signal?: AbortSignal): Promise<void> {
    const settle = Promise.allSettled(promises).then(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, this.startupWaitMs);
      timer.unref?.();
    });
    try {
      await (signal
        ? Promise.race([settle, timeout, waitForAbort(signal)])
        : Promise.race([settle, timeout]));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private rememberStatus(
    target: Pick<McpServerInventoryEntry, 'scope' | 'name' | 'configKey'>,
    status: McpServerRuntimeStatus,
  ): void {
    const key = `${target.scope}\0${target.name}\0${target.configKey}`;
    this.statuses.delete(key);
    this.statuses.set(key, structuredClone(status));
    while (this.statuses.size > this.statusLimit) {
      const oldest = this.statuses.keys().next().value as string | undefined;
      if (!oldest) break;
      this.statuses.delete(oldest);
    }
  }

  private updateStatus(sessionId: string, record: ConnectionRecord): void {
    const status: McpServerRuntimeStatus = {
      state: record.state,
      sessionId,
      updatedAt: record.updatedAt,
      ...(record.state === 'connected' ? { toolCount: record.tools.length } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
    this.statuses.delete(statusIdentity(record.target));
    this.statuses.set(statusIdentity(record.target), status);
    while (this.statuses.size > this.statusLimit) {
      const oldest = this.statuses.keys().next().value as string | undefined;
      if (!oldest) break;
      this.statuses.delete(oldest);
    }
  }

  private async connectBounded(
    target: McpServerTestTarget,
    signal: AbortSignal,
    options: McpHostConnectOptions,
  ): Promise<McpHostConnection> {
    if (!mcpTestRunsCommand(target.config)) return this.connect(target, signal, options);
    const ahead = this.commandTail;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    this.commandTail = ahead.then(() => held);
    try {
      await Promise.race([ahead, waitForAbort(signal)]);
      throwIfAborted(signal);
      return await this.connect(target, signal, options);
    } finally {
      release();
    }
  }

  private async closeRecords(records: Iterable<ConnectionRecord>): Promise<void> {
    const closing = [...records].map(async record => {
      record.controller.abort('mcp-session-close');
      record.state = 'closed';
      record.error = undefined;
      record.updatedAt = new Date(this.now()).toISOString();
      this.updateStatus(record.sessionId, record);
      if (record.connection) await record.connection.close().catch(() => undefined);
    });
    await Promise.allSettled(closing);
  }
}
