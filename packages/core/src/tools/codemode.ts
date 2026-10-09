import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { SpecializedModels, type ClassificationRequest, type ImageGenerationRequest, type SpecializedModelType } from '../providers/specialized-models.js';
import type { CodemodeCall, CodemodeDetails, TokenUsage } from '../types/index.js';
export type { CodemodeDetails } from '../types/index.js';
import { createRequire } from 'node:module';
import type { ExtensionRuntimeContext, ExtensionTool, ExtensionToolResult } from '../extensions/extension-registry.js';
import { CODEMODE_WORKER_SOURCE } from './codemode-worker.js';
import { Bm25ToolRanker, createToolSearchDocument } from './tool-search.js';
import { agentToolExposure, type RegisteredAgentTool } from './tool-selection.js';

export const CODEMODE_TOOL_NAME = 'codemode';
export const CODEMODE_EXTENSION_ID = 'builtin:codemode';
export const CODEMODE_LIMITS = Object.freeze({
  timeoutMs: 10_000, memoryBytes: 32 * 1024 * 1024, stackBytes: 256 * 1024,
  interrupts: 10_000, calls: 64, concurrency: 4, inputBytes: 64 * 1024,
  outputBytes: 64 * 1024, resultBytes: 256 * 1024, sourceBytes: 64 * 1024,
});
export type CodemodeLimits = { [Key in keyof typeof CODEMODE_LIMITS]: number };
export interface CodemodeSettings {
  enabled?: boolean;
  activation?: 'automatic' | 'on';
  mode?: 'on' | 'only';
  inlineBudget?: number;
}
export type HostedCodemodeTool = ExtensionTool & {
  extensionId: typeof CODEMODE_EXTENSION_ID;
  exposure: 'model-only';
};
export const CODEMODE_REGISTRATION: RegisteredAgentTool = {
  name: CODEMODE_TOOL_NAME,
  extensionId: CODEMODE_EXTENSION_ID,
  exposure: 'model-only',
  description: 'Run an async JavaScript body in bounded QuickJS. Use await tools.<name>({...}), Promise.allSettled(), text(), console.log(), return, exit(), store()/load(), searchTools(), describeTool() and describeNamespace(). No Node, filesystem, network or timers. Calls are real, unattended and not rolled back. Model-only control tools and recursive codemode are unavailable. models.getModelsOfType("classifier"|"image"), models.classify({model,input,labels}) and models.generateImages({model,prompt,count?,size?}) use the current credential-private provider; availability is rechecked on each call. Binary image results share the nested JSON budget. Limits: 10 seconds, 32 MiB VM, 64 calls, 4 concurrent calls, 64 KiB output. Input is {code: "JavaScript"}.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: { code: { type: 'string', maxLength: CODEMODE_LIMITS.sourceBytes } }, required: ['code'],
  },
};
const CONTROL_TOOLS = new Set(['codemode', 'tool_search', 'spawn_subagent']);
const MAX_ACTIVE_SANDBOXES = 8;
let activeSandboxes = 0;

/** Exposure is a presentation rule, never authorization. The caller must supply policy-filtered tools. */
export function isNestedCallable(tool: RegisteredAgentTool): boolean {
  return !CONTROL_TOOLS.has(tool.name.toLowerCase())
    && !['model-only', 'hidden'].includes(agentToolExposure(tool));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function boundedCodemodeStore(value: unknown): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length > 128) throw new Error('Invalid codemode store.');
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Codemode store limit exceeded.');
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 128 || Buffer.byteLength(JSON.stringify(item)) > 64 * 1024) {
      throw new Error('Codemode store value limit exceeded.');
    }
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Restore the latest successful state on the active branch, including across compaction. */
export function collectCodemodeStore(entries: readonly unknown[], activeLeafId?: string): Record<string, unknown> {
  if (entries.length > 100_000) return {};
  const byId = new Map(entries.filter(record).map(entry => [entry.id, entry]));
  const visited = new Set<string>();
  let cursor = activeLeafId;
  let index = entries.length - 1;
  while (cursor || (!activeLeafId && index >= 0)) {
    if (cursor && visited.has(cursor)) return {};
    if (cursor) visited.add(cursor);
    const entry = cursor ? byId.get(cursor) : entries[index--];
    if (!record(entry)) return {};
    if (record(entry.metadata) && record(entry.metadata.codemode) && entry.metadata.codemode.store) {
      try { return boundedCodemodeStore(entry.metadata.codemode.store); } catch { return {}; }
    }
    cursor = typeof entry.parentMessageId === 'string' ? entry.parentMessageId
      : typeof entry.parentEntryId === 'string' ? entry.parentEntryId : undefined;
    if (activeLeafId && !cursor) return {};
  }
  return {};
}

export interface RunCodemodeOptions {
  code: string;
  tools(): readonly RegisteredAgentTool[];
  execute(name: string, input: unknown, context: ExtensionRuntimeContext, signal: AbortSignal): Promise<ExtensionToolResult>;
  context: ExtensionRuntimeContext;
  signal?: AbortSignal;
  store?: Record<string, unknown>;
  redact?: (value: string) => string;
  /** Hosts may reduce but never expand the fixed production budgets. */
  limits?: Partial<CodemodeLimits>;
}

/** One disposable worker/VM per script. The hard host deadline also covers an uncooperative tool. */
export async function runCodemode(options: RunCodemodeOptions): Promise<ExtensionToolResult<CodemodeDetails>> {
  const limits = Object.fromEntries(Object.entries(CODEMODE_LIMITS).map(([name, maximum]) => {
    const requested = options.limits?.[name as keyof typeof CODEMODE_LIMITS];
    return [name, Number.isSafeInteger(requested) && requested! > 0 ? Math.min(requested!, maximum) : maximum];
  })) as CodemodeLimits;
  if (typeof options.code !== 'string' || Buffer.byteLength(options.code) > limits.sourceBytes) {
    throw new Error('Codemode source limit exceeded.');
  }
  if (options.signal?.aborted) throw Object.assign(new Error('Codemode was aborted.'), { name: 'AbortError' });
  const redact = options.redact ?? (value => value);
  const selected = () => options.tools().filter(isNestedCallable).slice(0, 2_000);
  const toolMetadata = (tool: RegisteredAgentTool) => ({
    name: tool.name, description: tool.description.slice(0, 500), namespace: tool.namespace,
  });
  const initialTools = selected();
  const initialStore = boundedCodemodeStore(options.store ?? {});
  if (activeSandboxes >= MAX_ACTIVE_SANDBOXES) throw new Error('Codemode sandbox capacity exceeded.');
  const controller = new AbortController();
  const started = performance.now();
  const nestedCalls: CodemodeDetails['nestedCalls'] = [];
  const parentId = options.context.toolCallId ?? randomUUID();
  const models = options.context.provider ? new SpecializedModels(options.context.provider, redact, options.context.beforeSpecializedModel) : undefined;
  const progress = (call: CodemodeCall) => {
    if (settled) return;
    try { options.context.onCodemodeProgress?.({ parentId, call: structuredClone(call) }); } catch { /* Presentation cannot grant authority. */ }
  };
  const accounting = (): { usage?: TokenUsage; costComplete: boolean } => {
    const modelCalls = nestedCalls.filter(call => call.kind !== 'tool');
    const measured = nestedCalls.filter(call => call.usage);
    const costComplete = modelCalls.every(call => call.usage?.costUsd !== undefined);
    const usage: TokenUsage = {};
    for (const call of measured) for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd'] as const) {
      const amount = call.usage?.[key];
      if (amount !== undefined) usage[key] = Math.min(Number.MAX_SAFE_INTEGER, (usage[key] ?? 0) + amount);
    }
    return { ...(measured.length ? { usage } : {}), costComplete };
  };
  let active = 0;
  let totalCalls = 0;
  let outputBytes = 0;
  let resultBytes = 0;
  const output: string[] = [];
  const queue: Array<() => void> = [];
  const worker = new Worker(CODEMODE_WORKER_SOURCE, {
    eval: true,
    workerData: {
      quickjsModule: createRequire(import.meta.url).resolve('quickjs-emscripten'),
      code: options.code, limits, tools: initialTools.map(toolMetadata),
      store: initialStore,
    },
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    // No environment is exposed to QuickJS; do not inherit credential channels even into the worker.
    env: {},
  });
  activeSandboxes++;
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  let stop!: (error?: string, store?: unknown) => void;
  const abort = () => stop('Codemode was aborted.');
  const done = new Promise<ExtensionToolResult<CodemodeDetails>>(resolve => {
    stop = (error, store) => {
      if (settled) return;
      for (const call of nestedCalls) if (call.state === 'running') {
        call.state = 'cancelled'; call.isError = true; progress(call);
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      controller.abort('codemode-ended');
      queue.length = 0;
      void worker.terminate();
      let safeOutput = redact(output.join('\n'));
      const bytes = Buffer.from(safeOutput);
      if (bytes.length > limits.outputBytes) {
        error = 'Script output limit exceeded.';
        let end = limits.outputBytes;
        while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
        safeOutput = bytes.subarray(0, end).toString('utf8');
      }
      let safeStore: Record<string, unknown> | undefined;
      if (!error) {
        try { safeStore = boundedCodemodeStore(JSON.parse(redact(JSON.stringify(store)))); }
        catch { error = 'Invalid codemode store.'; }
      }
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      resolve({
        content: `Script ${error ? 'failed' : 'completed'} (${durationMs} ms)\n${safeOutput}${error ? `\nScript error: ${redact(error).slice(0, 2_000)}` : ''}`,
        isError: Boolean(error),
        details: { engine: 'QuickJS', parentId, durationMs, nestedCalls, ...accounting(), ...(safeStore ? { store: safeStore } : {}) },
      });
    };
    timer = setTimeout(() => stop('Codemode deadline exceeded.'), limits.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.on('error', () => stop('QuickJS sandbox failed.'));
    worker.on('exit', () => { if (!settled) stop('QuickJS sandbox exited.'); });
    worker.on('message', (message: unknown) => {
      if (settled || !record(message)) return;
      if (message.type === 'output' && typeof message.value === 'string') {
        outputBytes += Buffer.byteLength(message.value) + (output.length > 0 ? 1 : 0);
        if (outputBytes > limits.outputBytes || output.length >= 1_000) { stop('Script output limit exceeded.'); return; }
        output.push(message.value);
      } else if (message.type === 'failed') {
        stop(typeof message.error === 'string' ? message.error.slice(0, 2_000) : 'Script failed.');
      } else if (message.type === 'done') {
        try { stop(undefined, JSON.parse(String(message.store))); }
        catch { stop('Invalid codemode store.'); }
      } else if (message.type === 'call') {
        if (++totalCalls > limits.calls || typeof message.input !== 'string'
          || Buffer.byteLength(message.input) > limits.inputBytes || !Number.isSafeInteger(message.id)) {
          stop('Nested call/input limit exceeded.'); return;
        }
        const kind = message.operation === 'tool' ? 'tool' : message.operation === 'classify' ? 'classifier' : message.operation === 'images' ? 'image' : undefined;
        const activity: CodemodeCall | undefined = kind ? {
          id: `${parentId}:${message.id}`, parentId, kind,
          name: kind === 'tool' ? redact(String(message.name)).slice(0, 256) : kind,
          state: 'running', isError: false,
        } : undefined;
        if (activity) { nestedCalls.push(activity); progress(activity); }
        const task = async () => {
          if (settled) return;
          active++;
          const callStarted = performance.now();
          let value: unknown;
          let error: string | undefined;
          try {
            const input: unknown = JSON.parse(String(message.input));
            const tools = selected(); // Reapply live policy for every nested call, including queued calls.
            if (message.operation === 'tool') {
              const tool = tools.find(tool => tool.name === message.name);
              if (!tool) throw new Error('Nested tool is not enabled.');
              if (!record(input)) throw new Error('Nested tool input must be a JSON object.');
              const result = await options.execute(tool.name, input, { ...options.context,
                onProcessOutput: undefined, processOutputPath: undefined,
                requestInteraction: undefined, toolCallId: undefined, onCodemodeProgress: undefined, beforeSpecializedModel: undefined,
                notify: (value, level) => { if (!controller.signal.aborted) options.context.notify(value, level); },
              }, controller.signal);
              if (settled) return;
              if (result.isError) throw new Error(result.content);
              value = result.content;
            } else if (message.operation === 'search') {
              if (!record(input) || typeof input.query !== 'string' || Buffer.byteLength(input.query) > 4_096
                || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 50))) {
                throw new Error('Invalid script search.');
              }
              const candidates = tools.filter(tool => input.namespace === undefined || tool.namespace?.name === input.namespace);
              const matches = new Bm25ToolRanker().rank(input.query,
                candidates.map(tool => createToolSearchDocument(tool, tool.namespace)), Number(input.limit ?? 8));
              value = matches.map(match => toolMetadata(candidates.find(tool => tool.name === match.name)!));
            } else if (message.operation === 'describe') {
              const tool = tools.find(tool => tool.name === message.name);
              value = tool ? { ...toolMetadata(tool), parameters: tool.parameters } : null;
            } else if (message.operation === 'namespace') {
              const members = tools.filter(tool => tool.namespace?.name === message.name);
              value = members.length ? { ...members[0]!.namespace, tools: members.map(toolMetadata) } : null;
            } else if (message.operation === 'models' || message.operation === 'availableModels') {
              if (!['classifier', 'image'].includes(String(message.name))) throw new Error('Invalid specialized model type.');
              value = models ? message.operation === 'models'
                ? models.getModelsOfType(message.name as SpecializedModelType)
                : models.getAvailableOfType(message.name as SpecializedModelType) : [];
            } else if (message.operation === 'classify' || message.operation === 'images') {
              if (!models) throw new Error('No model provider is available.');
              value = message.operation === 'classify'
                ? await models.classify(input as ClassificationRequest, { signal: controller.signal })
                : await models.generateImages(input as ImageGenerationRequest, { signal: controller.signal });
              if (settled) return;
              if (activity) activity.usage = (value as { usage?: TokenUsage }).usage;
            } else throw new Error('Unknown sandbox operation.');
            const serialized = redact(JSON.stringify(value ?? null));
            resultBytes += Buffer.byteLength(serialized);
            if (resultBytes > limits.resultBytes) throw new Error('Nested result limit exceeded.');
            if (!settled) {
              if (activity) { activity.state = 'completed'; activity.durationMs = Math.max(0, Math.round(performance.now() - callStarted)); progress(activity); }
              worker.postMessage({ type: 'response', id: message.id, value: serialized });
            }
          } catch (failure) {
            error = redact(failure instanceof Error ? failure.message : 'Nested call failed.').slice(0, 2_000);
            if (!settled) {
              if (activity) { activity.state = 'failed'; activity.isError = true; activity.durationMs = Math.max(0, Math.round(performance.now() - callStarted)); progress(activity); }
              worker.postMessage({ type: 'response', id: message.id, error });
            }
          } finally {
            active--;
            if (!settled) queue.shift()?.();
          }
        };
        const start = () => { void task(); };
        if (active < limits.concurrency) start(); else queue.push(start);
      }
    });
  });
  if (options.signal?.aborted) abort();
  try { return await done; }
  finally { await worker.terminate(); activeSandboxes--; }
}

export interface CodemodeSelfTest { state: 'passed' | 'failed'; engine: 'QuickJS'; limits: typeof CODEMODE_LIMITS }
/** Explicit startup health check; inventory readers only consume this cached result. */
export async function testCodemodeSandbox(): Promise<CodemodeSelfTest> {
  let passed = false;
  try {
    const result = await runCodemode({
      code: 'if (typeof process !== "undefined" || typeof require !== "undefined" || typeof fetch !== "undefined" || typeof setTimeout !== "undefined") throw new Error("ambient capability"); return 6 * 7;',
      tools: () => [], execute: async () => { throw new Error('No self-test tools.'); },
      context: {} as ExtensionRuntimeContext,
    });
    passed = !result.isError && result.content.endsWith('\n42');
  } catch { /* Fail closed without publishing worker/installation diagnostics. */ }
  return { state: passed ? 'passed' : 'failed', engine: 'QuickJS', limits: CODEMODE_LIMITS };
}
