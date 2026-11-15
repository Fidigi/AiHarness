import type { ChatResponse, ChatToolDefinition } from '../providers/index.js';
import { settleSessionCacheWarmer } from '../providers/cache-warmer.js';
import type {
  ExtensionRegistry,
  ExtensionRuntimeContext,
  ExtensionToolResult,
} from '../extensions/extension-registry.js';
import type { CodemodeDetails, CodemodeProgress, Message, MessageContentBlock, TokenUsage, ToolCall } from '../types/index.js';
import type { SessionManager } from '../sessions/session-manager.js';
import { agentToolExposure, isDeclaredToolExposure } from '../tools/tool-selection.js';
import { toolSearchActivationMetadata } from '../tools/tool-search.js';
import { ToolProgressChannel, type ToolProgressSnapshot } from './tool-progress.js';
import { ProviderContextOverflowError } from '../providers/context-overflow.js';
import { ProviderRequestContextError } from './provider-request-estimate.js';
import { prepareMessageImages } from '../media/message-images.js';
import { ownToolResult } from './tool-result.js';
import { nestedToolScope } from './nested-tools.js';
import { copyAgentRunTrigger, copyExtensionResult, type AgentRunTrigger, type ExtensionCustomTrigger } from '../extensions/execution-hooks.js';

export interface ToolExecutionResult {
  call: ToolCall;
  content: string;
  blocks?: Array<Extract<MessageContentBlock, { type: 'image' }>>;
  structuredContent?: unknown;
  fullContent?: string;
  isError: boolean;
  durationMs: number;
  truncated: boolean;
  /** Branch-local declarations activated by a trusted host-owned discovery tool. */
  activatedTools?: string[];
  metadata?: Record<string, unknown>;
  usage?: TokenUsage;
  progress?: ToolProgressSnapshot;
}

export interface ToolLoopOptions {
  sessionManager: SessionManager;
  sessionId: string;
  extensionRegistry: ExtensionRegistry;
  toolContext: ExtensionRuntimeContext;
  streamTurn(messages: Message[], tools: ChatToolDefinition[], round: number, recovery?: 'overflow' | 'length'): Promise<ChatResponse>;
  tools?: ChatToolDefinition[];
  /** Recompute declarations before every model call after dynamic activation. */
  resolveTools?(): ChatToolDefinition[];
  /** Optional composite executor for tools hosted outside the static extension registry. */
  executeTool?(
    name: string,
    input: unknown,
    context: ExtensionRuntimeContext,
    signal?: AbortSignal,
  ): ExtensionToolResult | Promise<ExtensionToolResult>;
  /** Composite hosts must classify the actual selected executor, never model-supplied metadata. */
  canExecuteInParallel?(name: string): boolean;
  /** Accept activation names only from a host-owned tool/result pair. */
  getActivatedTools?(name: string, result: ExtensionToolResult): string[] | undefined;
  /** Additional metadata authenticated by a host-owned executor (for example codemode store). */
  getToolResultMetadata?(name: string, result: ExtensionToolResult): Record<string, unknown> | undefined;
  onTurnStart?(round: number): void | Promise<void>;
  onAssistantResponse?(response: ChatResponse, round: number, durationMs: number): void | Promise<void>;
  onToolCall?(call: ToolCall): void | Promise<void>;
  onToolResult?(result: ToolExecutionResult): void | Promise<void>;
  onCodemodeProgress?(progress: CodemodeProgress): void;
  onToolProgress?(progress: ToolProgressSnapshot): void | Promise<void>;
  onToolUsage?(usage: TokenUsage): void | Promise<void>;
  onTurnEnd?(response: ChatResponse, toolResults: ToolExecutionResult[], round: number): void | Promise<void>;
  /** Persist or transform queued input after tools and before the next provider turn. */
  beforeNextTurn?(response: ChatResponse, toolResults: ToolExecutionResult[], round: number): void | Promise<void>;
  onUsage?(response: ChatResponse, round: number): void | Promise<void>;
  onFinalResponse?(content: string, response: ChatResponse): void | Promise<void>;
  maxToolRounds?: number;
  maxToolResultLength?: number;
  signal?: AbortSignal;
  provider?: string;
  /** Trusted host image policy for new post-hook tool results only. */
  imageAutoResize?: boolean;
  trigger?: AgentRunTrigger;
  /** Process-local scrubber applied before extension/tool output is persisted or emitted. */
  redactText?(value: string): string;
}

function normalizeUsage(usage: ChatResponse['usage']): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
  };
}

/** Keep native order; a final-text hook replaces text, not unrelated private reasoning. */
function assistantBlocks(response: ChatResponse): MessageContentBlock[] {
  let blocks: MessageContentBlock[] = response.blocks ? [...response.blocks] : [
    ...(response.reasoning ? [{ type: 'reasoning' as const, text: response.reasoning }] : []),
    ...(response.content ? [{ type: 'text' as const, text: response.content }] : []),
  ];
  if (response.blocks && blocks.filter(block => block.type === 'text').map(block => block.text).join('') !== response.content) {
    let replaced = false;
    blocks = blocks.flatMap((block): MessageContentBlock[] => {
      if (block.type !== 'text') return [block];
      if (replaced) return [];
      replaced = true;
      return response.content ? [{ type: 'text', text: response.content }] : [];
    });
    if (!replaced && response.content) blocks.push({ type: 'text', text: response.content });
  }
  const calls = new Set(blocks.flatMap(block => block.type === 'tool_call' ? [block.id] : []));
  blocks.push(...(response.toolCalls ?? []).filter(call => !calls.has(call.id)).map(call => ({ type: 'tool_call' as const, ...call })));
  return blocks;
}

/** Stable error used by the CLI and detached Web runtime. */
export class AgentAbortError extends Error {
  constructor() {
    super("Exécution de l'agent interrompue.");
    this.name = 'AbortError';
  }
}

/**
 * Run model turns until a final assistant response is produced. Tool calls and
 * results are persisted before the next provider turn, so every interface uses
 * the same effective context and cancellation semantics.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<string> {
  const maxToolRounds = options.maxToolRounds ?? 8;
  const maxToolResultLength = options.maxToolResultLength ?? 50_000;
  const defaultTools = options.tools ?? options.extensionRegistry.getTools()
    .filter(tool => isDeclaredToolExposure(agentToolExposure(tool)))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    }));
  const effectiveMessages = (): Message[] => options.sessionManager.getEffectiveContext(options.sessionId)
    .filter(entry => entry.type === 'message')
    .map(entry => ({
      id: entry.id,
      role: entry.role,
      content: entry.content,
      timestamp: new Date(entry.timestamp),
      blocks: entry.blocks,
      toolCalls: entry.toolCalls,
      toolCallId: entry.toolCallId,
      name: entry.name,
      isError: entry.isError,
      provider: entry.provider,
      model: entry.model,
      ...(entry.api ? { api: entry.api } : {}),
      usage: entry.usage,
      durationMs: entry.durationMs,
      parentMessageId: entry.parentMessageId,
      agentId: entry.agentId,
      metadata: entry.metadata,
    }));
  let messages = effectiveMessages();
  let trigger = copyAgentRunTrigger(options.trigger);
  const hookSignal = options.signal ?? new AbortController().signal;
  const endTurn = async (round: number, toolCount: number, settle: boolean): Promise<ExtensionCustomTrigger | null | undefined> => {
    const event = { sessionId: options.sessionId, round, toolCount, trigger,
      context: options.toolContext, signal: hookSignal };
    const turn = await options.extensionRegistry.runBefore('before:turn:end', event);
    if (turn.cancelled) throw new Error('Extension turn cancelled.');
    if (!settle) return turn.data.continuation;
    const final = await options.extensionRegistry.runBefore('before:agent:settle', { ...event, continuation: turn.data.continuation });
    if (final.cancelled) throw new Error('Extension settlement cancelled.');
    return final.data.continuation;
  };
  const continueWith = async (continuation: ExtensionCustomTrigger, round: number): Promise<void> => {
    throwIfAborted();
    if (round + 1 >= maxToolRounds) throw new Error(`Limite de ${maxToolRounds} tours d'outils atteinte.`);
    await options.sessionManager.appendCustomMessage(options.sessionId, continuation.type, continuation.content,
      { display: true }, { signal: options.signal });
    throwIfAborted();
    trigger = { kind: 'custom', type: continuation.type };
    messages = effectiveMessages();
  };

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) throw new AgentAbortError();
  };

  let recoveryUsed = false;
  let recovery: 'overflow' | 'length' | undefined;
  const recover = async (reason: 'overflow' | 'length'): Promise<boolean> => {
    throwIfAborted();
    // Empty failed HTTP attempts still leave value-free durable evidence. This
    // private journal state is not model input and carries no invented usage.
    await options.sessionManager.appendCustomEntry(options.sessionId, 'run.context_recovery', { reason, exhausted: recoveryUsed });
    throwIfAborted();
    if (recoveryUsed) return false;
    recoveryUsed = true;
    const before = options.sessionManager.estimateContextTokens(options.sessionId);
    const applied = await options.sessionManager.checkAndTriggerCompaction(options.sessionId, options.signal, 'overflow');
    throwIfAborted();
    // An admitted summary remains durable/accounted even if it did not shrink.
    const after = options.sessionManager.estimateContextTokens(options.sessionId);
    const useful = applied && after < before;
    await options.sessionManager.appendCustomEntry(options.sessionId, 'run.context_recovery', { reason, applied, useful, before, after });
    throwIfAborted();
    return useful;
  };

  let succeeded = false;
  try {
  for (let round = 0; round < maxToolRounds; round++) {
    throwIfAborted();
    await options.onTurnStart?.(round);
    let tools = options.resolveTools?.() ?? defaultTools;
    const startedAt = performance.now();
    let response: ChatResponse;
    for (;;) {
      const previousMessage = options.sessionManager.get(options.sessionId)?.messages.at(-1)?.id;
      try { response = await options.streamTurn(messages, tools, round, recovery); break; }
      catch (error) {
        const overflow = error instanceof ProviderContextOverflowError
          || (error instanceof ProviderRequestContextError && error.kind === 'overflow');
        const failed = options.sessionManager.get(options.sessionId)?.messages.at(-1);
        if (!overflow || !await recover('overflow')) throw error;
        if (failed?.role === 'assistant' && failed.id !== previousMessage && failed.metadata?.outputError
          && effectiveMessages().some(message => message.id === failed.id)) {
          await options.sessionManager.appendContextEdit(options.sessionId, { targetEntryId: failed.id }, { signal: options.signal });
          throwIfAborted();
        }
        recovery = 'overflow';
        messages = effectiveMessages();
        tools = options.resolveTools?.() ?? defaultTools;
      }
    }
    const enabledToolNames = new Set(tools.map(tool => tool.name.toLowerCase()));
    throwIfAborted();
    if (response.usage) await options.onUsage?.(response, round);
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const originalContent = response.content;
    try {
      const messageHook = await options.extensionRegistry.runBefore('before:message', {
        sessionId: options.sessionId, content: response.content, signal: hookSignal,
      });
      if (messageHook.cancelled) throw new Error('Extension message cancelled.');
      response = { ...response, content: options.redactText?.(messageHook.data.content) ?? messageHook.data.content };
    } catch (error) {
      // A completed provider call is billed work even when its output hook fails
      // or is retired. Conserve authentic evidence, never execute pending calls.
      await options.sessionManager.addMessage(options.sessionId, {
        role: 'assistant', content: response.content, provider: response.provider ?? options.provider, model: response.model,
        ...(response.api ? { api: response.api } : {}), usage: normalizeUsage(response.usage), durationMs,
        metadata: { outputError: 'Extension message publication refused.' },
      }, { skipAutoCompaction: true });
      throw error;
    }
    await options.onAssistantResponse?.(response, round, durationMs);
    const toolCalls = response.toolCalls ?? [];

    if (toolCalls.length === 0) {
      if (response.content || originalContent || response.reasoning || response.blocks?.length || response.stopReason === 'length') {
        await options.sessionManager.addMessage(options.sessionId, {
          role: 'assistant',
          content: response.content,
          blocks: assistantBlocks(response),
          provider: response.provider ?? options.provider,
          model: response.model,
          ...(response.api ? { api: response.api } : {}),
          usage: normalizeUsage(response.usage),
          ...((response.stopReason === 'length' || response.selection || response.providerThinkingLevel !== undefined) ? { metadata: {
            ...(response.stopReason === 'length' ? { stopReason: 'length' } : {}),
            ...(response.providerThinkingLevel !== undefined ? { providerThinkingLevel: response.providerThinkingLevel } : {}),
            ...(response.selection ? { selection: response.selection, thinkingLevel: response.thinkingLevel } : {}),
          } } : {}),
          durationMs,
        }, { signal: options.signal, ...(response.stopReason === 'length' ? { skipAutoCompaction: true } : {}) });
      }
      const partialId = options.sessionManager.get(options.sessionId)?.messages.at(-1)?.id;
      await options.onTurnEnd?.(response, [], round);
      if (response.stopReason === 'length' && partialId && await recover('length')) {
        if (effectiveMessages().some(message => message.id === partialId)) {
          await options.sessionManager.appendContextEdit(options.sessionId, { targetEntryId: partialId }, { signal: options.signal });
        }
        throwIfAborted();
        recovery = 'length';
        messages = effectiveMessages();
        round--;
        continue;
      }
      await options.onFinalResponse?.(response.content, response);
      const continuation = await endTurn(round, 0, true);
      throwIfAborted();
      if (continuation) {
        await continueWith(continuation, round);
        continue;
      }
      succeeded = true;
      return response.content;
    }

    await options.sessionManager.addMessage(options.sessionId, {
      role: 'assistant',
      content: response.content,
      blocks: assistantBlocks(response),
      toolCalls,
      provider: response.provider ?? options.provider,
      model: response.model,
      ...(response.api ? { api: response.api } : {}),
      usage: normalizeUsage(response.usage),
      ...((response.stopReason === 'length' || response.selection || response.providerThinkingLevel !== undefined) ? { metadata: {
        ...(response.stopReason === 'length' ? { stopReason: 'length' } : {}),
        ...(response.providerThinkingLevel !== undefined ? { providerThinkingLevel: response.providerThinkingLevel } : {}),
        ...(response.selection ? { selection: response.selection, thinkingLevel: response.thinkingLevel } : {}),
      } } : {}),
      durationMs,
    }, { signal: options.signal, ...(response.stopReason === 'length' ? { skipAutoCompaction: true } : {}) });

    const toolResults: ToolExecutionResult[] = [];
    const execute = (name: string, input: unknown, context: ExtensionRuntimeContext) => Promise.resolve(options.executeTool
      ? options.executeTool(name, input, context, options.signal)
      : options.extensionRegistry.executeTool(name, input, context, options.signal));
    const executeCall = async (call: ToolCall, parallel: boolean): Promise<ToolExecutionResult> => {
      throwIfAborted();
      await options.onToolCall?.(call);
      const toolStartedAt = performance.now();
      let content: string;
      let isError = false;
      let activatedTools: string[] | undefined;
      let resultMetadata: Record<string, unknown> | undefined;
      let blocks: Array<Extract<MessageContentBlock, { type: 'image' }>> = [];
      let structuredContent: unknown;
      let nested: ReturnType<typeof nestedToolScope> | undefined;
      const progressChannel = new ToolProgressChannel(call, options.onToolProgress, options.signal, options.redactText);
      try {
        const context: ExtensionRuntimeContext = { ...options.toolContext, toolCallId: call.id,
          // The legacy raw sink/path is single-owner. Opted-in parallel tools use onProgress.
          ...(parallel ? { onProcessOutput: undefined, processOutputPath: undefined } : {}),
          onCodemodeProgress: options.onCodemodeProgress,
          onProgress: progressChannel.report,
          beforeSpecializedModel: async (type, request, signal) => {
            if (signal.aborted) throw new AgentAbortError();
            const hookContext: ExtensionRuntimeContext = { ...options.toolContext,
              notify: (message, level) => { if (!signal.aborted) options.toolContext.notify(message, level); },
              requestInteraction: options.toolContext.requestInteraction ? interaction => signal.aborted
                ? Promise.resolve({ cancelled: true })
                : options.toolContext.requestInteraction!({ ...interaction,
                  signal: interaction.signal ? AbortSignal.any([signal, interaction.signal]) : signal }) : undefined,
            };
            const hook = await options.extensionRegistry.runBefore('before:model', { type, request, context: hookContext, signal });
            if (hook.cancelled || hook.data.type !== type || signal.aborted) throw new Error('Model request cancelled.');
            return hook.data.request;
          },
        };
        const normalizedToolName = call.name.toLowerCase();
        if (!enabledToolNames.has(normalizedToolName)) {
          throw new Error(`Tool is not enabled for this run: ${call.name}`);
        }
        nested = nestedToolScope(context, call, execute, name => (options.resolveTools?.() ?? tools)
          .some(tool => tool.name.toLowerCase() === name.toLowerCase()), options.signal, options.redactText);
        const result = await execute(call.name, call.input, nested.context);
        // Extract host-authenticated metadata from the original identity only.
        resultMetadata = options.getToolResultMetadata?.(call.name, result);
        const resultHook = await options.extensionRegistry.runBefore('before:tool:result', {
          sessionId: options.sessionId, tool: call.name, result: copyExtensionResult(result), signal: hookSignal,
        });
        if (resultHook.cancelled) throw new Error('Extension tool result cancelled.');
        const owned = ownToolResult(resultHook.data.result, options.redactText);
        const images = options.toolContext.provider && !response.selection
          ? await prepareMessageImages(options.toolContext.provider, response.model, owned.content, owned.blocks, 'tool',
            { autoResize: options.imageAutoResize }, options.signal) : owned;
        content = images.content;
        blocks = (images.blocks ?? []).filter((block): block is Extract<MessageContentBlock, { type: 'image' }> => block.type === 'image');
        structuredContent = owned.structuredContent;
        isError = owned.isError;
        if (!isError) activatedTools = options.getActivatedTools?.(call.name, result);
      } catch (error) {
        isError = true;
        const message = error instanceof Error ? error.message : String(error);
        content = options.redactText?.(message) ?? message;
      } finally { await nested?.finish(); }
      if (isError && resultMetadata?.codemode) {
        const { store: _store, ...details } = resultMetadata.codemode as CodemodeDetails;
        resultMetadata = { ...resultMetadata, codemode: details };
      }
      if (nested?.records.length) resultMetadata = { ...resultMetadata, nestedTools: structuredClone(nested.records) };

      const progress = await progressChannel.finish(options.signal?.aborted ? 'cancelled' : isError ? 'failed' : 'completed');
      if (progressChannel.failure) {
        isError = true;
        content = options.redactText?.('Tool progress sink failed.') ?? 'Tool progress sink failed.';
        blocks = []; structuredContent = undefined;
        if (progress) progress.status = options.signal?.aborted ? 'cancelled' : 'failed';
      }
      // This namespace is host-owned. Progress details remain inert display data,
      // never merged into authenticated result metadata or accounted as usage.
      if (progress) resultMetadata = { ...resultMetadata, toolProgress: progress };

      // Cancellation stops execution, not the durable record of work already done.
      // In particular, authenticated code-mode metadata contains completed model usage.
      const interrupted = options.signal?.aborted === true;
      if (interrupted) {
        isError = true;
        activatedTools = undefined;
        content = options.redactText?.('Tool execution interrupted.') ?? 'Tool execution interrupted.';
        blocks = []; structuredContent = undefined;
        resultMetadata = { ...resultMetadata, interrupted: true };
        const codemode = resultMetadata.codemode as CodemodeDetails | undefined;
        if (codemode) {
          const { store: _store, ...details } = codemode;
          resultMetadata.codemode = details;
        }
      }
      const fullContent = content;
      const truncated = content.length > maxToolResultLength;
      if (truncated) content = `${content.slice(0, maxToolResultLength)}\n[Résultat tronqué — sortie complète disponible]`;
      const durationMs = Math.max(0, Math.round(performance.now() - toolStartedAt));
      const usage = (resultMetadata?.codemode as CodemodeDetails | undefined)?.usage;
      return {
        call,
        content,
        ...(blocks.length ? { blocks } : {}),
        ...(structuredContent !== undefined ? { structuredContent } : {}),
        ...(truncated ? { fullContent } : {}),
        isError,
        durationMs,
        truncated,
        ...(activatedTools?.length ? { activatedTools: [...activatedTools] } : {}),
        ...(resultMetadata ? { metadata: resultMetadata } : {}),
        ...(usage ? { usage } : {}),
        ...(progress ? { progress } : {}),
      };
    };
    const save = async (result: ToolExecutionResult): Promise<void> => {
      await options.sessionManager.addMessage(options.sessionId, {
        role: 'tool', content: result.content, toolCallId: result.call.id, name: result.call.name,
        isError: result.isError, durationMs: result.durationMs,
        blocks: [{ type: 'tool_result', toolCallId: result.call.id, name: result.call.name,
          content: result.content, isError: result.isError, truncated: result.truncated,
          ...(result.fullContent !== undefined ? { fullContent: result.fullContent } : {}),
          ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        }, ...(result.blocks ?? [])],
        ...(result.usage ? { usage: result.usage } : {}),
        ...((result.activatedTools?.length || result.metadata) ? { metadata: {
          ...toolSearchActivationMetadata(result.activatedTools ?? []), ...result.metadata,
        } } : {}),
      }, { skipAutoCompaction: true });
      if (result.usage) await options.onToolUsage?.(result.usage);
      toolResults.push(result);
      await options.onToolResult?.(result);
    };
    const readOnly = (call: ToolCall): boolean => !['codemode', 'tool_search', 'spawn_subagent'].includes(call.name.toLowerCase())
      && (options.canExecuteInParallel?.(call.name) ?? (!options.executeTool && options.extensionRegistry.getTools()
        .some(tool => tool.name.toLowerCase() === call.name.toLowerCase() && tool.readOnly === true)));
    for (let index = 0; index < toolCalls.length;) {
      throwIfAborted();
      if (response.stopReason === 'length') {
        // Even valid-looking arguments may have been salvaged from cut-off output.
        // Publish correlated failures without entering any executor or tool hook.
        const call = toolCalls[index++];
        await options.onToolCall?.(call);
        await save({ call, isError: true, durationMs: 0, truncated: false,
          content: 'Tool call was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.' });
        continue;
      }
      const batch = [toolCalls[index++]];
      if (readOnly(batch[0])) while (index < toolCalls.length && batch.length < 4 && readOnly(toolCalls[index])) batch.push(toolCalls[index++]);
      // Join every admitted invocation before saving in declared order, even on stop/failure.
      const completed = await Promise.allSettled(batch.map(call => executeCall(call, batch.length > 1)));
      let publicationFailed = false, publicationError: unknown;
      for (const item of completed) if (item.status === 'fulfilled') {
        try { await save(item.value); }
        catch (error) { if (!publicationFailed) publicationError = error; publicationFailed = true; }
      }
      if (publicationFailed) throw publicationError;
      const failed = completed.find(item => item.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      throwIfAborted();
    }
    await options.sessionManager.checkAndTriggerCompaction(options.sessionId, options.signal);
    recovery = undefined;
    await options.onTurnEnd?.(response, toolResults, round);
    const continuation = await endTurn(round, toolResults.length, false);
    throwIfAborted();
    if (continuation) await continueWith(continuation, round);
    await options.beforeNextTurn?.(response, toolResults, round);
    throwIfAborted();
    messages = effectiveMessages();
  }

  throw new Error(`Limite de ${maxToolRounds} tours d'outils atteinte.`);
  } finally { await settleSessionCacheWarmer(options.sessionManager, options.sessionId, succeeded); }
}
